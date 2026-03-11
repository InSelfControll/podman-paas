import { getDB } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'js-yaml';
import { deployStack, stopStack, restartStack, getStackStatus, getStackLogs } from '../services/stacks.js';
import { checkDockerDependencies } from '../services/compose-sanitizer.js';

export default async function stacksRoutes(app) {
  
  // ── List stacks ────────────────────────────────────────────────────────────
  app.get('/', { onRequest: [app.authenticate] }, async () => {
    const db = getDB();
    const stacks = db.prepare('SELECT * FROM stacks ORDER BY created_at DESC').all();
    
    // Enrich with live status
    const enriched = await Promise.all(stacks.map(async (s) => {
      try {
        const status = await getStackStatus(s.id);
        return { 
          ...s, 
          container_count: status?.total_count || 0,
          running_count: status?.running_count || 0,
          healthy: status?.healthy || false,
        };
      } catch {
        return { ...s, container_count: 0, running_count: 0, healthy: false };
      }
    }));
    
    return enriched;
  });

  // ── Get single stack ───────────────────────────────────────────────────────
  app.get('/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const s = getDB().prepare('SELECT * FROM stacks WHERE id = ?').get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'Not found' });
    
    // Get live status
    try {
      const status = await getStackStatus(s.id);
      return { ...s, ...status };
    } catch {
      return s;
    }
  });

  // ── Validate compose file ─────────────────────────────────────────────────
  app.post('/validate', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['compose_content'],
        properties: {
          compose_content: { type: 'string', minLength: 1, maxLength: 65536 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { compose_content } = req.body;
    
    // Validate YAML
    let parsed;
    try { parsed = yaml.load(compose_content); }
    catch (e) { return reply.code(400).send({ valid: false, error: `Invalid YAML: ${e.message}` }); }
    
    // Check for Docker dependencies
    const deps = checkDockerDependencies(compose_content);
    const errors = deps.filter(d => d.type === 'error');
    const warnings = deps.filter(d => d.type === 'warning');
    
    return {
      valid: errors.length === 0,
      yaml_valid: true,
      services: Object.keys(parsed?.services || {}),
      errors: errors.map(e => e.message),
      warnings: warnings.map(w => w.message),
    };
  });

  // ── Create stack ───────────────────────────────────────────────────────────
  app.post('/', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'compose_content'],
        properties: {
          name:            { type: 'string', minLength: 1, maxLength: 63, pattern: '^[a-z0-9][a-z0-9-]*$' },
          description:     { type: 'string', maxLength: 512 },
          compose_content: { type: 'string', minLength: 1, maxLength: 65536 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const db = getDB();
    const { name, description, compose_content } = req.body;

    // Validate YAML
    try { yaml.load(compose_content); }
    catch (e) { return reply.code(400).send({ error: `Invalid YAML: ${e.message}` }); }
    
    // Check for Docker dependencies
    const deps = checkDockerDependencies(compose_content);
    const errors = deps.filter(d => d.type === 'error');
    if (errors.length > 0) {
      return reply.code(400).send({ 
        error: 'Stack uses unsupported Docker features', 
        details: errors 
      });
    }

    const id = uuidv4();
    try {
      db.prepare('INSERT INTO stacks (id, name, description, compose_content) VALUES (?, ?, ?, ?)')
        .run(id, name, description || null, compose_content);
      return reply.code(201).send(db.prepare('SELECT * FROM stacks WHERE id = ?').get(id));
    } catch (err) {
      if (err.message?.includes('UNIQUE')) return reply.code(409).send({ error: 'Stack name already exists' });
      throw err;
    }
  });

  // ── Update stack ───────────────────────────────────────────────────────────
  app.patch('/:id', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          description:     { type: 'string', maxLength: 512 },
          compose_content: { type: 'string', minLength: 1, maxLength: 65536 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const db = getDB();
    if (!db.prepare('SELECT id FROM stacks WHERE id = ?').get(req.params.id)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    const { compose_content, description } = req.body;
    if (compose_content) {
      try { yaml.load(compose_content); }
      catch (e) { return reply.code(400).send({ error: `Invalid YAML: ${e.message}` }); }
      
      // Check for Docker dependencies
      const deps = checkDockerDependencies(compose_content);
      const errors = deps.filter(d => d.type === 'error');
      if (errors.length > 0) {
        return reply.code(400).send({ 
          error: 'Stack uses unsupported Docker features', 
          details: errors 
        });
      }
    }
    db.prepare(`
      UPDATE stacks SET
        compose_content = COALESCE(?, compose_content),
        description     = COALESCE(?, description),
        updated_at      = datetime('now')
      WHERE id = ?
    `).run(compose_content || null, description || null, req.params.id);
    return db.prepare('SELECT * FROM stacks WHERE id = ?').get(req.params.id);
  });

  // ── Delete stack ───────────────────────────────────────────────────────────
  app.delete('/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    const s = db.prepare('SELECT * FROM stacks WHERE id = ?').get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'Not found' });
    
    req.log.info({ stackId: s.id, name: s.name }, 'Deleting stack');
    
    // Stop with image removal when permanently deleting
    try {
      await stopStack(s.id, true);
      req.log.info({ stackId: s.id, name: s.name }, 'Stack stopped and containers removed');
    } catch (err) {
      req.log.warn({ stackId: s.id, err: err.message }, 'Error stopping stack, continuing with deletion');
    }
    
    db.prepare('DELETE FROM stacks WHERE id = ?').run(s.id);
    return { success: true, message: `Stack ${s.name} deleted` };
  });

  // ── Deploy stack ───────────────────────────────────────────────────────────
  app.post('/:id/deploy', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    const s = db.prepare('SELECT * FROM stacks WHERE id = ?').get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'Not found' });
    if (s.status === 'starting') return reply.code(409).send({ error: 'Already deploying' });
    
    // Deploy async
    deployStack(s.id).catch(err => {
      console.error(`[Stacks] Background deploy failed for ${s.id}:`, err.message);
    });
    
    return { message: 'Stack deployment started', stackId: s.id };
  });

  // ── Stop stack ─────────────────────────────────────────────────────────────
  app.post('/:id/stop', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    const s = db.prepare('SELECT * FROM stacks WHERE id = ?').get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'Not found' });
    await stopStack(s.id);
    return { success: true };
  });

  // ── Restart stack ──────────────────────────────────────────────────────────
  app.post('/:id/restart', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    const s = db.prepare('SELECT * FROM stacks WHERE id = ?').get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'Not found' });
    
    await restartStack(s.id);
    return { success: true };
  });

  // ── Get stack logs ─────────────────────────────────────────────────────────
  app.get('/:id/logs', { onRequest: [app.authenticate] }, async (req, reply) => {
    const tail = Math.min(parseInt(req.query.tail || '200', 10), 2000);
    try {
      const logs = await getStackLogs(req.params.id, tail);
      return { logs };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── Get live stack status ──────────────────────────────────────────────────
  app.get('/:id/status', { onRequest: [app.authenticate] }, async (req, reply) => {
    try {
      const status = await getStackStatus(req.params.id);
      if (!status) return reply.code(404).send({ error: 'Stack not found' });
      return status;
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
}
