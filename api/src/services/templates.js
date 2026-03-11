/**
 * Templates Service
 *
 * Supports importing and browsing templates from:
 *  - Portainer v2/v3 JSON format
 *  - Dokploy GitHub repo format (meta.json + docker-compose.yml + template.toml)
 *  - Raw docker-compose.yml URLs
 *
 * All formats are normalized into a common internal schema before storage.
 */

import { getDB } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';

// Timeout for fetching remote template files
const FETCH_TIMEOUT_MS = 10_000;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  return res.json();
}

export async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  return res.text();
}

// ── Portainer Parser ──────────────────────────────────────────────────────────

/**
 * Parse a Portainer template JSON (v2 or v3).
 * Returns array of normalized template objects.
 */
export function parsePortainerTemplates(json) {
  // Accept { version, templates: [...] } or bare array
  const raw = Array.isArray(json) ? json : (json.templates || []);
  const results = [];

  for (const t of raw) {
    try {
      const type = t.type; // 1=container, 2=swarm stack, 3=compose stack

      // Skip swarm stacks (type 2) — Podman doesn't support Docker Swarm
      if (type === 2) continue;

      const normalized = {
        source:      'portainer',
        source_id:   String(t.id || uuidv4()),
        type:        type === 3 ? 'stack' : 'app',
        title:       t.title || 'Untitled',
        description: t.description || '',
        note:        t.note || '',
        logo:        t.logo || '',
        categories:  t.categories || [],
        platform:    t.platform || 'linux',

        // Container-specific
        image:       t.image || null,
        registry:    t.registry || '',
        command:     t.command || '',
        ports:       (t.ports || []).map(normalizePortainerPort),
        volumes:     (t.volumes || []).map(normalizePortainerVolume),
        env:         (t.env || []).map(normalizePortainerEnv),
        labels:      (t.labels || []),
        privileged:  t.privileged || false,
        restart_policy: t.restart_policy || 'unless-stopped',
        network:     t.network || '',

        // Stack-specific (type 3)
        repository:  t.repository || null,  // { url, stackfile }
        compose:     t.compose || null, // Some templates include compose directly

        raw: t,
      };

      results.push(normalized);
    } catch (err) {
      console.warn(`Skipping malformed Portainer template: ${err.message}`);
    }
  }

  return results;
}

function normalizePortainerPort(p) {
  // Portainer ports: "80/tcp" or "8080:80/tcp"
  if (typeof p === 'string') {
    const [mapping, proto = 'tcp'] = p.split('/');
    const [host, container] = mapping.includes(':')
      ? mapping.split(':')
      : [null, mapping];
    return { host: host ? parseInt(host) : null, container: parseInt(container), proto };
  }
  return p;
}

function normalizePortainerVolume(v) {
  return {
    container: v.container || v,
    bind:      v.bind || null,
    readonly:  v.readonly || false,
  };
}

function normalizePortainerEnv(e) {
  return {
    name:        e.name || '',
    label:       e.label || e.name || '',
    description: e.description || '',
    default:     e.default || '',
    preset:      e.preset || false,
    select:      e.select || null, // array of { text, value, default } options
  };
}

// ── Dokploy Parser ────────────────────────────────────────────────────────────

const DOKPLOY_TEMPLATES_META_URL =
  'https://raw.githubusercontent.com/Dokploy/templates/main/meta.json';

const DOKPLOY_RAW_BASE =
  'https://raw.githubusercontent.com/Dokploy/templates/main/blueprints';

/**
 * Fetch and parse the Dokploy official template catalog.
 * Each entry gets its compose content fetched lazily on deploy.
 */
export async function fetchDokployTemplates() {
  const meta = await fetchJson(DOKPLOY_TEMPLATES_META_URL);
  const templates = Array.isArray(meta) ? meta : [];

  return templates.map(t => ({
    source:      'dokploy',
    source_id:   t.id || uuidv4(),
    type:        'stack',
    title:       t.name || t.id || 'Untitled',
    description: t.description || '',
    note:        '',
    logo:        t.logo
      ? `${DOKPLOY_RAW_BASE}/${t.id}/${t.logo}`
      : '',
    categories:  t.tags || [],
    platform:    'linux',
    links:       t.links || {},
    version:     t.version || '',

    // Compose fetched on demand
    image:    null,
    compose:  null,
    env:      [],
    ports:    [],
    volumes:  [],

    // Store the fetch path for on-demand loading
    _compose_url: `${DOKPLOY_RAW_BASE}/${t.id}/docker-compose.yml`,
    _config_url:  `${DOKPLOY_RAW_BASE}/${t.id}/template.toml`,

    raw: t,
  }));
}

/**
 * Fetch compose + config.toml for a single Dokploy template.
 * Returns { compose_content, env_vars, domains }
 */
export async function fetchDokployTemplateFiles(templateSourceId) {
  const composeUrl = `${DOKPLOY_RAW_BASE}/${templateSourceId}/docker-compose.yml`;
  const configUrl  = `${DOKPLOY_RAW_BASE}/${templateSourceId}/template.toml`;

  const [compose, config] = await Promise.all([
    fetchText(composeUrl).catch(() => null),
    fetchText(configUrl).catch(() => null),
  ]);

  const env_vars = config ? parseDokployConfigToml(config) : [];

  return { compose_content: compose, env_vars, raw_config: config };
}

/**
 * Minimal TOML parser for Dokploy config.toml [variables] section.
 * Extracts variable name → default value pairs.
 */
function parseDokployConfigToml(toml) {
  const vars = [];
  let inVariables = false;

  for (const line of toml.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '[variables]') { inVariables = true; continue; }
    if (trimmed.startsWith('[') && trimmed !== '[variables]') { inVariables = false; }

    if (inVariables && trimmed && !trimmed.startsWith('#')) {
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"]*)"?/);
      if (match) {
        const [, name, defaultVal] = match;
        // Skip internal/auto-generated vars
        if (['domain', 'APP_NAME'].includes(name)) {
          vars.push({ name, label: name, description: 'Auto-assigned', default: '', preset: true });
        } else {
          vars.push({ name, label: name, description: '', default: defaultVal.trim(), preset: false });
        }
      }
    }
  }
  return vars;
}

// ── Custom URL import ─────────────────────────────────────────────────────────

/**
 * Import templates from a URL.
 * Auto-detects Portainer JSON or raw compose.
 */
export async function importFromUrl(url) {
  const text = await fetchText(url);

  // Try JSON first (Portainer format)
  try {
    const json = JSON.parse(text);
    if (json.templates || Array.isArray(json)) {
      return { format: 'portainer', templates: parsePortainerTemplates(json) };
    }
  } catch {}

  // Try as a raw docker-compose.yml
  if (text.includes('services:') || text.includes('version:')) {
    return {
      format: 'compose',
      templates: [{
        source:      'custom',
        source_id:   uuidv4(),
        type:        'stack',
        title:       url.split('/').pop().replace('.yml', '') || 'Custom Stack',
        description: `Imported from ${url}`,
        logo:        '',
        categories:  [],
        env:         [],
        compose:     text,
        image:       null,
        ports:       [],
        volumes:     [],
        raw:         {},
      }],
    };
  }

  throw new Error('Unrecognized format: expected Portainer JSON or docker-compose.yml');
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export function saveTemplatesToDB(templates, sourceLabel) {
  const db = getDB();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO template_catalog
      (id, source, source_id, type, title, description, logo, categories, data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertMany = db.transaction((rows) => {
    for (const t of rows) {
      insert.run(
        uuidv4(),
        t.source,
        t.source_id,
        t.type,
        t.title,
        t.description,
        t.logo || '',
        JSON.stringify(t.categories || []),
        JSON.stringify(t),
      );
    }
  });

  insertMany(templates);
  return templates.length;
}

export function searchTemplates({ q, source, type, category, limit = 50, offset = 0 }) {
  const db = getDB();
  const conditions = [];
  const params = [];

  if (q) {
    conditions.push(`(title LIKE ? OR description LIKE ? OR categories LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (source) { conditions.push('source = ?'); params.push(source); }
  if (type)   { conditions.push('type = ?');   params.push(type); }
  if (category) {
    conditions.push(`categories LIKE ?`);
    params.push(`%"${category}"%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT id, source, source_id, type, title, description, logo, categories, updated_at
     FROM template_catalog ${where}
     ORDER BY title ASC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM template_catalog ${where}`
  ).get(...params);

  return {
    templates: rows.map(r => ({ ...r, categories: JSON.parse(r.categories || '[]') })),
    total: total.c,
    limit,
    offset,
  };
}

export function getTemplateById(id) {
  const db = getDB();
  const row = db.prepare('SELECT * FROM template_catalog WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data || '{}'), categories: JSON.parse(row.categories || '[]') };
}

export function getTemplateSources() {
  const db = getDB();
  return db.prepare(`
    SELECT source, COUNT(*) as count, MAX(updated_at) as last_updated
    FROM template_catalog GROUP BY source ORDER BY source
  `).all();
}

export function deleteTemplatesBySource(source) {
  const db = getDB();
  const result = db.prepare('DELETE FROM template_catalog WHERE source = ?').run(source);
  return result.changes;
}
