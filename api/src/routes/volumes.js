/**
 * Volume Management Routes
 */

import { getDB } from '../db/database.js';
import {
  createVolume,
  listVolumes,
  getVolume,
  attachVolume,
  detachVolume,
  deleteVolume,
  pruneVolumes
} from '../services/volumes.js';

export default async function volumeRoutes(app) {
  
  // ── List all volumes ─────────────────────────────────────────────────────
  app.get('/', { onRequest: [app.authenticate] }, async () => {
    return listVolumes();
  });
  
  // ── Get single volume ────────────────────────────────────────────────────
  app.get('/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    try {
      return await getVolume(req.params.id);
    } catch (err) {
      return reply.code(404).send({ error: err.message });
    }
  });
  
  // ── Create volume ────────────────────────────────────────────────────────
  app.post('/', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { 
            type: 'string', 
            minLength: 2, 
            maxLength: 64,
            pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$'
          },
          driver: { 
            type: 'string', 
            default: 'local',
            enum: ['local', 'nfs', 'tmpfs']
          },
          driver_opts: { 
            type: 'object',
            additionalProperties: { type: 'string' }
          },
          size_mb: { 
            type: 'integer', 
            minimum: 1,
            maximum: 1000000 
          },
          labels: { 
            type: 'object',
            additionalProperties: { type: 'string' }
          }
        },
        additionalProperties: false
      }
    }
  }, async (req, reply) => {
    try {
      const volume = await createVolume(req.body);
      req.log.info({ volumeId: volume.id, name: volume.name }, 'Volume created');
      return reply.code(201).send(volume);
    } catch (err) {
      if (err.message.includes('already exists')) {
        return reply.code(409).send({ error: err.message });
      }
      return reply.code(500).send({ error: err.message });
    }
  });
  
  // ── Delete volume ────────────────────────────────────────────────────────
  app.delete('/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    try {
      await deleteVolume(req.params.id);
      req.log.info({ volumeId: req.params.id }, 'Volume deleted');
      return { success: true };
    } catch (err) {
      if (err.message === 'Volume not found') {
        return reply.code(404).send({ error: err.message });
      }
      if (err.message.includes('in use')) {
        return reply.code(409).send({ error: err.message });
      }
      return reply.code(500).send({ error: err.message });
    }
  });
  
  // ── Attach volume to app/stack ───────────────────────────────────────────
  app.post('/:id/attach', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['container_path'],
        properties: {
          app_id: { type: 'string' },
          stack_id: { type: 'string' },
          container_path: { 
            type: 'string', 
            minLength: 1,
            pattern: '^/[^\x00]+$' // Must be absolute path
          },
          read_only: { type: 'boolean', default: false }
        },
        oneOf: [
          { required: ['app_id'] },
          { required: ['stack_id'] }
        ],
        additionalProperties: false
      }
    }
  }, async (req, reply) => {
    try {
      const { app_id, stack_id, container_path, read_only } = req.body;
      
      // Validate that the app/stack exists
      const db = getDB();
      if (app_id) {
        const app = db.prepare('SELECT id FROM apps WHERE id = ?').get(app_id);
        if (!app) return reply.code(404).send({ error: 'App not found' });
      }
      if (stack_id) {
        const stack = db.prepare('SELECT id FROM stacks WHERE id = ?').get(stack_id);
        if (!stack) return reply.code(404).send({ error: 'Stack not found' });
      }
      
      const result = await attachVolume(req.params.id, {
        app_id,
        stack_id,
        container_path,
        read_only
      });
      
      req.log.info({ 
        volumeId: req.params.id, 
        appId: app_id, 
        stackId: stack_id,
        path: container_path 
      }, 'Volume attached');
      
      return reply.code(201).send(result);
    } catch (err) {
      if (err.message === 'Volume not found') {
        return reply.code(404).send({ error: err.message });
      }
      if (err.message.includes('already mounted')) {
        return reply.code(409).send({ error: err.message });
      }
      return reply.code(400).send({ error: err.message });
    }
  });
  
  // ── Detach volume ────────────────────────────────────────────────────────
  app.delete('/mounts/:mountId', { onRequest: [app.authenticate] }, async (req, reply) => {
    try {
      await detachVolume(req.params.mountId);
      return { success: true };
    } catch (err) {
      return reply.code(404).send({ error: err.message });
    }
  });
  
  // ── Prune unused volumes ─────────────────────────────────────────────────
  app.post('/prune', { onRequest: [app.authenticate] }, async (req, reply) => {
    const result = await pruneVolumes();
    req.log.info({ pruned: result.pruned }, 'Volumes pruned');
    return result;
  });
  
  // ── Get volume drivers ───────────────────────────────────────────────────
  app.get('/drivers', { onRequest: [app.authenticate] }, async () => {
    return [
      { name: 'local', description: 'Local filesystem volume', default: true },
      { name: 'nfs', description: 'NFS network volume' },
      { name: 'tmpfs', description: 'Temporary in-memory volume' }
    ];
  });
}
