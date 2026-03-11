import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../db/database.js';
import {
  parsePortainerTemplates,
  fetchDokployTemplates,
  fetchDokployTemplateFiles,
  importFromUrl,
  saveTemplatesToDB,
  searchTemplates,
  getTemplateById,
  getTemplateSources,
  deleteTemplatesBySource,
  fetchText,
} from '../services/templates.js';

// Portainer Community Templates (the official repo has been discontinued/unreliable)
const PORTAINER_COMMUNITY_URL =
  'https://raw.githubusercontent.com/Lissy93/portainer-templates/main/templates.json';

export default async function templatesRoutes(app) {

  // ── Browse / search templates ─────────────────────────────────────────────
  app.get('/', { onRequest: [app.authenticate] }, async (req) => {
    const { q, source, type, category, limit = 50, offset = 0 } = req.query;
    return searchTemplates({
      q, source, type, category,
      limit:  Math.min(parseInt(limit, 10), 200),
      offset: parseInt(offset, 10),
    });
  });

  // ── List available sources + counts ──────────────────────────────────────
  app.get('/sources', { onRequest: [app.authenticate] }, async () => {
    return getTemplateSources();
  });

  // ── Get single template detail ────────────────────────────────────────────
  app.get('/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const t = getTemplateById(req.params.id);
    if (!t) return reply.code(404).send({ error: 'Template not found' });

    // For Dokploy templates, fetch compose on demand if not cached
    if (t.source === 'dokploy' && !t.data?.compose) {
      try {
        const files = await fetchDokployTemplateFiles(t.source_id);
        // Cache in DB
        const db = getDB();
        const updated = { ...t.data, compose: files.compose_content, env: files.env_vars };
        db.prepare('UPDATE template_catalog SET data = ? WHERE id = ?')
          .run(JSON.stringify(updated), t.id);
        return { ...t, data: updated };
      } catch (err) {
        return { ...t, _fetch_error: err.message };
      }
    }

    return t;
  });

  // ── Sync: pull from a built-in source ────────────────────────────────────
  app.post('/sync', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['source'],
        properties: {
          source: { type: 'string', enum: ['portainer-community', 'dokploy'] },
          clear: { type: 'boolean', default: false },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { source, clear } = req.body;
    let templates = [];
    let label = source;
    let deletedCount = 0;

    try {
      // Clear existing templates if requested
      if (clear) {
        deletedCount = deleteTemplatesBySource(label);
      }

      if (source === 'portainer-community') {
        const json = await fetch(PORTAINER_COMMUNITY_URL, { signal: AbortSignal.timeout(15000) })
          .then(r => r.json());
        templates = parsePortainerTemplates(json);
        
        // Log stats for debugging
        const stacks = templates.filter(t => t.type === 'stack').length;
        const apps = templates.filter(t => t.type === 'app').length;
        req.log.info({ total: templates.length, stacks, apps }, 'Parsed Portainer Community templates');
        
        // Distinguish from official
        templates = templates.map(t => ({ ...t, source: 'portainer-community' }));
        label = 'portainer-community';

      } else if (source === 'dokploy') {
        templates = await fetchDokployTemplates();
        label = 'dokploy';
      }

      // Replace existing entries for this source
      deleteTemplatesBySource(label);
      const count = saveTemplatesToDB(templates, label);
      req.log.info({ source: label, count, deleted: deletedCount }, 'Template sync complete');

      return { 
        source: label, 
        imported: count, 
        deleted: deletedCount,
        message: `${clear ? `Cleared ${deletedCount}, ` : ''}Synced ${count} templates from ${label}` 
      };

    } catch (err) {
      req.log.error({ err, source }, 'Template sync failed');
      return reply.code(502).send({ error: `Sync failed: ${err.message}` });
    }
  });

  // ── Import: from a custom URL ─────────────────────────────────────────────
  app.post('/import', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url:   { type: 'string', format: 'uri', maxLength: 2048 },
          label: { type: 'string', maxLength: 64 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { url, label } = req.body;
    const sourceLabel = label || new URL(url).hostname;

    try {
      const { format, templates } = await importFromUrl(url);
      const labeled = templates.map(t => ({ ...t, source: sourceLabel }));
      const count = saveTemplatesToDB(labeled, sourceLabel);
      req.log.info({ url, format, count }, 'Templates imported');
      return { source: sourceLabel, format, imported: count };
    } catch (err) {
      return reply.code(422).send({ error: err.message });
    }
  });

  // ── Delete all templates from a source ───────────────────────────────────
  app.delete('/source/:source', { onRequest: [app.authenticate] }, async (req) => {
    const deleted = deleteTemplatesBySource(req.params.source);
    return { deleted, source: req.params.source };
  });

  // ── Deploy a template as an App (type=app, Portainer container) ───────────
  app.post('/:id/deploy/app', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          name:    { type: 'string', minLength: 1, maxLength: 63, pattern: '^[a-z0-9][a-z0-9-]*$' },
          env:     { type: 'object', additionalProperties: { type: 'string' } },
          port:    { type: 'integer', minimum: 1, maximum: 65535 },
          domain:  { type: 'string', maxLength: 253 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const t = getTemplateById(req.params.id);
    if (!t) return reply.code(404).send({ error: 'Template not found' });
    if (t.type !== 'app' || !t.data?.image) {
      return reply.code(400).send({ error: 'This template is not a container app — use /deploy/stack instead' });
    }

    const db = getDB();
    const d = t.data;
    const name = req.body.name || slugify(d.title);
    const userEnv = req.body.env || {};

    // Detect container port from template (first mapped port)
    const firstPort = d.ports?.[0];
    const containerPort = firstPort?.container || req.body.port || 80;

    // Check name uniqueness
    if (db.prepare('SELECT id FROM apps WHERE name = ?').get(name)) {
      return reply.code(409).send({ error: `App name "${name}" already exists` });
    }

    // Build env vars: merge template defaults with user overrides
    const envVars = d.env?.map(e => ({
      key:       e.name,
      value:     userEnv[e.name] ?? e.default ?? '',
      is_secret: e.name.toLowerCase().includes('password') || e.name.toLowerCase().includes('secret'),
    })) || [];

    // Merge any extra user env vars not in template
    for (const [key, value] of Object.entries(userEnv)) {
      if (!envVars.find(e => e.key === key)) {
        envVars.push({ key, value, is_secret: false });
      }
    }

    const appId = uuidv4();
    db.prepare(`
      INSERT INTO apps (id, name, description, image, port, domain, build_method, status)
      VALUES (?, ?, ?, ?, ?, ?, 'dockerfile', 'stopped')
    `).run(appId, name, d.description || '', d.image, containerPort, req.body.domain || null);

    // Insert env vars
    const insertEnv = db.prepare(
      'INSERT INTO env_vars (id, app_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?)'
    );
    db.transaction(() => {
      for (const ev of envVars.filter(e => e.key)) {
        insertEnv.run(uuidv4(), appId, ev.key, ev.value, ev.is_secret ? 1 : 0);
      }
    })();

    // Trigger deploy
    const { deployApp } = await import('../services/deploy.js');
    const { deploymentId } = await deployApp(appId);

    req.log.info({ template: t.title, appId, deploymentId }, 'App deployed from template');
    return reply.code(201).send({ appId, deploymentId, message: 'Deployment started' });
  });

  // ── Deploy a template as a Stack (type=stack, compose) ───────────────────
  app.post('/:id/deploy/stack', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 63, pattern: '^[a-z0-9][a-z0-9-]*$' },
          env:  { type: 'object', additionalProperties: { type: 'string' } },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    let t = getTemplateById(req.params.id);
    if (!t) return reply.code(404).send({ error: 'Template not found' });

    // Verify this is a stack-type template
    if (t.type !== 'stack') {
      return reply.code(400).send({ error: `This template is type '${t.type}' — use /deploy/app for container apps` });
    }

    req.log.info({ template: t.title, source: t.source, type: t.type, hasCompose: !!t.data?.compose, hasRepo: !!t.data?.repository }, 'Deploying template as stack');

    // Fetch compose content if not yet cached (Dokploy)
    let composeContent = t.data?.compose || t.data?.repository?.compose;
    
    if (!composeContent && t.source === 'dokploy') {
      const files = await fetchDokployTemplateFiles(t.source_id).catch((err) => {
        req.log.warn({ err }, 'Failed to fetch Dokploy template files');
        return { compose_content: null };
      });
      composeContent = files.compose_content;

      // Fallback: try the stored _compose_url if direct fetch failed
      if (!composeContent && t.data?._compose_url) {
        composeContent = await fetchText(t.data._compose_url).catch(() => null);
      }

      if (!composeContent) return reply.code(502).send({ error: 'Could not fetch compose file for this template' });

      // Cache it
      const db = getDB();
      db.prepare('UPDATE template_catalog SET data = ? WHERE id = ?')
        .run(JSON.stringify({ ...t.data, compose: composeContent }), t.id);
    }

    // For Portainer stack-type with a repository URL, fetch from GitHub
    if (!composeContent && t.data?.repository?.url) {
      const { url, stackfile = 'docker-compose.yml' } = t.data.repository;
      
      req.log.info({ url, stackfile }, 'Fetching Portainer compose from repository');
      
      // Handle different URL formats
      let rawUrl;
      if (url.includes('github.com')) {
        // Convert GitHub URL to raw content URL
        // Handle: https://github.com/user/repo/tree/branch/path or https://github.com/user/repo
        const githubRegex = /https:\/\/github\.com\/([^\/]+)\/([^\/]+)(?:\/tree\/([^\/]+)(?:\/(.*))?)?/;
        const match = url.match(githubRegex);
        
        if (match) {
          const [, user, repo, branch = 'master', path = ''] = match;
          rawUrl = `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${path ? path + '/' : ''}${stackfile}`;
        } else {
          // Fallback simple replacement
          rawUrl = url
            .replace('https://github.com/', 'https://raw.githubusercontent.com/')
            .replace('/tree/', '/') + `/${stackfile}`;
        }
      } else {
        // For non-GitHub URLs, try to fetch directly
        rawUrl = `${url}/${stackfile}`;
      }
      
      req.log.info({ rawUrl }, 'Fetching compose file');
      
      try {
        composeContent = await fetchText(rawUrl);
        req.log.info({ length: composeContent?.length }, 'Fetched compose content');
      } catch (err) {
        req.log.warn({ rawUrl, err: err.message }, 'Failed to fetch compose file');
        
        // Try alternative filenames
        const alternatives = ['docker-compose.yaml', 'compose.yml', 'compose.yaml'];
        for (const alt of alternatives) {
          if (composeContent) break;
          try {
            const altUrl = rawUrl.replace(/[^/]+$/, alt);
            req.log.info({ altUrl }, 'Trying alternative compose filename');
            composeContent = await fetchText(altUrl);
          } catch {}
        }
      }
    }

    if (!composeContent) {
      req.log.error({ templateId: req.params.id, dataKeys: Object.keys(t.data || {}), hasRepo: !!t.data?.repository, repoUrl: t.data?.repository?.url }, 'No compose content available');
      
      // If it's a container-type template with an image, generate a simple compose file
      if (t.type === 'app' && t.data?.image) {
        req.log.info('Generating compose file from container template');
        
        // Generate a compose file from the container template data
        const ports = (t.data.ports || []).map(p => {
          if (typeof p === 'string') {
            // Parse "host:container/tcp" format
            const match = p.match(/^(?:(\d+):)?(\d+)(?:\/(tcp|udp))?$/);
            if (match) {
              const [, host, container] = match;
              return host ? `"${host}:${container}"` : `"${container}:${container}"`;
            }
          }
          return null;
        }).filter(Boolean);
        
        const env = (t.data.env || []).map(e => `      - ${e.name}=${e.default || ''}`).join('\n');
        const volumes = (t.data.volumes || []).map(v => {
          const container = v.container || v;
          const bind = v.bind || null;
          return bind ? `      - ${bind}:${container}${v.readonly ? ':ro' : ''}` : `      - ${container}`;
        }).join('\n');
        
        composeContent = `version: '3.8'
services:
  app:
    image: ${t.data.image}
    container_name: ${req.body.name || slugify(t.title)}
${ports.length > 0 ? `    ports:\n${ports.map(p => `      - ${p}`).join('\n')}` : ''}
${env ? `    environment:\n${env}` : ''}
${volumes ? `    volumes:\n${volumes}` : ''}
    restart: ${t.data.restart_policy || 'unless-stopped'}
${t.data.privileged ? '    privileged: true' : ''}
`;
        req.log.info({ composePreview: composeContent.substring(0, 200) }, 'Generated compose file');
      } else {
        return reply.code(400).send({ 
          error: 'No compose content available for this template. The template repository may be inaccessible or the compose file is missing.' 
        });
      }
    }

    // Substitute user-provided env vars into compose content
    const userEnv = req.body.env || {};
    let finalCompose = composeContent;
    for (const [key, val] of Object.entries(userEnv)) {
      // Replace ${KEY} and $KEY patterns
      finalCompose = finalCompose
        .replace(new RegExp(`\\$\\{${key}\\}`, 'g'), val)
        .replace(new RegExp(`\\$${key}(?=[^A-Z0-9_]|$)`, 'g'), val);
    }

    const db = getDB();
    const name = req.body.name || slugify(t.title);

    if (db.prepare('SELECT id FROM stacks WHERE name = ?').get(name)) {
      return reply.code(409).send({ error: `Stack name "${name}" already exists` });
    }

    const stackId = uuidv4();
    db.prepare('INSERT INTO stacks (id, name, description, compose_content) VALUES (?, ?, ?, ?)')
      .run(stackId, name, t.description || '', finalCompose);

    // Trigger deploy via stacks service
    const { deployStack } = await import('../services/stacks.js');
    await deployStack(stackId).catch(() => {}); // fire and forget

    req.log.info({ template: t.title, stackId }, 'Stack deployed from template');
    return reply.code(201).send({ stackId, message: 'Stack deployment started' });
  });
}

function slugify(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 63) || 'app';
}
