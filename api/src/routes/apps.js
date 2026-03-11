import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../db/database.js';
import { deployApp, stopApp, restartApp, deleteApp } from '../services/deploy.js';
import { getContainerStats, getContainer } from '../services/podman.js';

// Shared JSON schemas
const appNameSchema = { type: 'string', minLength: 1, maxLength: 63, pattern: '^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$' };
const envVarSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['key', 'value'],
    properties: {
      key:       { type: 'string', minLength: 1, maxLength: 256, pattern: '^[A-Z_][A-Z0-9_]*$' },
      value:     { type: 'string', maxLength: 65536 },
      is_secret: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

export default async function appsRoutes(app) {
  // ── List apps ────────────────────────────────────────────────────────────
  app.get('/', { onRequest: [app.authenticate] }, async () => {
    const db = getDB();
    const apps = db.prepare('SELECT * FROM apps ORDER BY created_at DESC').all();

    // Enrich with live container status from Podman
    const enriched = await Promise.all(apps.map(async (a) => {
      if (!a.container_id) return { ...a, live_status: a.status };
      try {
        const c = await getContainer(a.container_id);
        return { ...a, live_status: c?.State?.Status || a.status };
      } catch {
        return { ...a, live_status: a.status };
      }
    }));

    return enriched;
  });

  // ── Get app ──────────────────────────────────────────────────────────────
  app.get('/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    const a = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id);
    if (!a) return reply.code(404).send({ error: 'App not found' });

    const envVars = db.prepare(
      'SELECT id, key, value, is_secret FROM env_vars WHERE app_id = ? ORDER BY key'
    ).all(a.id);
    const deployments = db.prepare(
      'SELECT * FROM deployments WHERE app_id = ? ORDER BY started_at DESC LIMIT 20'
    ).all(a.id);

    return { ...a, env_vars: envVars, deployments };
  });

  // ── Create app ───────────────────────────────────────────────────────────
  app.post('/', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name:            appNameSchema,
          description:     { type: 'string', maxLength: 512 },
          git_url:         { type: 'string', maxLength: 1024, format: 'uri' },
          branch:          { type: 'string', maxLength: 255, default: 'main' },
          dockerfile_path: { type: 'string', maxLength: 512, default: 'Dockerfile' },
          build_method:    { type: 'string', enum: ['dockerfile', 'nixpacks'], default: 'dockerfile' },
          port:            { type: 'integer', minimum: 1, maximum: 65535, default: 3000 },
          domain:          { type: 'string', maxLength: 253 },
          image:           { type: 'string', maxLength: 512 },
          memory_limit:    { type: 'integer', minimum: 0 },
          cpu_limit:       { type: 'number', minimum: 0 },
          env_vars:        envVarSchema,
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const db = getDB();
    const { name, description, git_url, branch, dockerfile_path, build_method, port, domain, image, env_vars, memory_limit, cpu_limit } = req.body;

    if (!git_url && !image) {
      return reply.code(400).send({ error: 'Either git_url or image is required' });
    }

    const id = uuidv4();
    try {
      db.prepare(`
        INSERT INTO apps (id, name, description, git_url, branch, dockerfile_path, build_method, port, domain, image, memory_limit, cpu_limit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, description || null, git_url || null, branch || 'main',
             dockerfile_path || 'Dockerfile', build_method || 'dockerfile',
             port || 3000, domain || null, image || null,
             memory_limit || 0, cpu_limit || 0);

      if (Array.isArray(env_vars)) {
        const insertEnv = db.prepare(
          'INSERT INTO env_vars (id, app_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?)'
        );
        const insertMany = db.transaction((vars) => {
          for (const ev of vars) {
            insertEnv.run(uuidv4(), id, ev.key, ev.value, ev.is_secret ? 1 : 0);
          }
        });
        insertMany(env_vars);
      }

      req.log.info({ appName: name, id }, 'App created');
      return reply.code(201).send(db.prepare('SELECT * FROM apps WHERE id = ?').get(id));
    } catch (err) {
      if (err.message?.includes('UNIQUE')) {
        return reply.code(409).send({ error: `App name "${name}" already exists` });
      }
      throw err;
    }
  });

  // ── Update app ───────────────────────────────────────────────────────────
  app.patch('/:id', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          description:     { type: 'string', maxLength: 512 },
          git_url:         { type: ['string', 'null'], maxLength: 1024 },
          branch:          { type: 'string', maxLength: 255 },
          dockerfile_path: { type: 'string', maxLength: 512 },
          build_method:    { type: 'string', enum: ['dockerfile', 'nixpacks'] },
          port:            { type: 'integer', minimum: 1, maximum: 65535 },
          domain:          { type: ['string', 'null'], maxLength: 253 },
          image:           { type: ['string', 'null'], maxLength: 512 },
          memory_limit:    { type: 'integer', minimum: 0 },
          cpu_limit:       { type: 'number', minimum: 0 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const db = getDB();
    const a = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id);
    if (!a) return reply.code(404).send({ error: 'App not found' });

    const { description, git_url, branch, dockerfile_path, build_method, port, domain, image, memory_limit, cpu_limit } = req.body;

    db.prepare(`
      UPDATE apps SET
        description     = COALESCE(?, description),
        git_url         = COALESCE(?, git_url),
        branch          = COALESCE(?, branch),
        dockerfile_path = COALESCE(?, dockerfile_path),
        build_method    = COALESCE(?, build_method),
        port            = COALESCE(?, port),
        domain          = COALESCE(?, domain),
        image           = COALESCE(?, image),
        memory_limit    = COALESCE(?, memory_limit),
        cpu_limit       = COALESCE(?, cpu_limit),
        updated_at      = datetime('now')
      WHERE id = ?
    `).run(description, git_url, branch, dockerfile_path, build_method, port, domain, image,
           memory_limit !== undefined ? memory_limit : null,
           cpu_limit !== undefined ? cpu_limit : null,
           req.params.id);

    return db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id);
  });

  // ── Delete app ───────────────────────────────────────────────────────────
  app.delete('/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    if (!db.prepare('SELECT id FROM apps WHERE id = ?').get(req.params.id)) {
      return reply.code(404).send({ error: 'App not found' });
    }
    await deleteApp(req.params.id);
    req.log.info({ appId: req.params.id }, 'App deleted');
    return { success: true };
  });

  // ── Deploy ───────────────────────────────────────────────────────────────
  app.post('/:id/deploy', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    const a = db.prepare('SELECT id, status FROM apps WHERE id = ?').get(req.params.id);
    if (!a) return reply.code(404).send({ error: 'App not found' });

    // Prevent concurrent deployments
    if (a.status === 'building') {
      return reply.code(409).send({ error: 'A deployment is already in progress' });
    }

    const { deploymentId } = await deployApp(req.params.id);
    req.log.info({ appId: req.params.id, deploymentId }, 'Deployment started');
    return { deploymentId, message: 'Deployment started' };
  });

  // ── Stop ─────────────────────────────────────────────────────────────────
  app.post('/:id/stop', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    if (!db.prepare('SELECT id FROM apps WHERE id = ?').get(req.params.id)) {
      return reply.code(404).send({ error: 'App not found' });
    }
    await stopApp(req.params.id);
    return { success: true };
  });

  // ── Restart ──────────────────────────────────────────────────────────────
  app.post('/:id/restart', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    if (!db.prepare('SELECT id FROM apps WHERE id = ?').get(req.params.id)) {
      return reply.code(404).send({ error: 'App not found' });
    }
    await restartApp(req.params.id);
    return { success: true };
  });

  // ── Stats ────────────────────────────────────────────────────────────────
  app.get('/:id/stats', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    const a = db.prepare('SELECT container_id FROM apps WHERE id = ?').get(req.params.id);
    if (!a) return reply.code(404).send({ error: 'App not found' });
    if (!a.container_id) return reply.code(404).send({ error: 'No container running' });

    const stats = await getContainerStats(a.container_id);
    return stats || reply.code(503).send({ error: 'Stats unavailable' });
  });

  // ── Env vars ─────────────────────────────────────────────────────────────
  app.get('/:id/env', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    if (!db.prepare('SELECT id FROM apps WHERE id = ?').get(req.params.id)) {
      return reply.code(404).send({ error: 'App not found' });
    }
    return db.prepare(
      'SELECT id, key, value, is_secret FROM env_vars WHERE app_id = ? ORDER BY key'
    ).all(req.params.id);
  });

  app.put('/:id/env', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['env_vars'],
        properties: { env_vars: envVarSchema },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const db = getDB();
    if (!db.prepare('SELECT id FROM apps WHERE id = ?').get(req.params.id)) {
      return reply.code(404).send({ error: 'App not found' });
    }

    const { env_vars } = req.body;
    // Atomic replace inside a transaction
    const replace = db.transaction((appId, vars) => {
      db.prepare('DELETE FROM env_vars WHERE app_id = ?').run(appId);
      const insert = db.prepare(
        'INSERT INTO env_vars (id, app_id, key, value, is_secret) VALUES (?, ?, ?, ?, ?)'
      );
      for (const ev of vars) {
        insert.run(uuidv4(), appId, ev.key, ev.value, ev.is_secret ? 1 : 0);
      }
    });
    replace(req.params.id, env_vars);

    return db.prepare(
      'SELECT id, key, value, is_secret FROM env_vars WHERE app_id = ? ORDER BY key'
    ).all(req.params.id);
  });
}
