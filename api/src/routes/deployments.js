import { getDB } from '../db/database.js';
import { getQueueStatus, getJob } from '../services/job-queue.js';

export default async function deploymentsRoutes(app) {
  // List deployments
  app.get('/', { onRequest: [app.authenticate] }, async (req) => {
    const db = getDB();
    const { app_id } = req.query;
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 200);
    let query = `SELECT d.*, a.name as app_name FROM deployments d JOIN apps a ON d.app_id = a.id`;
    const params = [];
    if (app_id) { query += ' WHERE d.app_id = ?'; params.push(app_id); }
    query += ` ORDER BY d.started_at DESC LIMIT ?`;
    params.push(limit);
    return db.prepare(query).all(...params);
  });

  // Get single deployment
  app.get('/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    const d = db.prepare(
      'SELECT d.*, a.name as app_name FROM deployments d JOIN apps a ON d.app_id = a.id WHERE d.id = ?'
    ).get(req.params.id);
    if (!d) return reply.code(404).send({ error: 'Not found' });
    return d;
  });
  
  // Get job details for a deployment
  app.get('/:id/job', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    
    // First verify deployment exists
    const deployment = db.prepare('SELECT * FROM deployments WHERE id = ?').get(req.params.id);
    if (!deployment) return reply.code(404).send({ error: 'Deployment not found' });
    
    // Get associated job
    const job = db.prepare(`
      SELECT * FROM deployment_jobs 
      WHERE deployment_id = ? 
      ORDER BY started_at DESC 
      LIMIT 1
    `).get(req.params.id);
    
    if (!job) {
      return reply.code(404).send({ error: 'No job found for this deployment' });
    }
    
    return job;
  });
  
  // Get queue status
  app.get('/queue/status', { onRequest: [app.authenticate] }, async () => {
    return getQueueStatus();
  });
  
  // List all jobs (optionally filter by app)
  app.get('/queue/jobs', { onRequest: [app.authenticate] }, async (req) => {
    const db = getDB();
    const { app_id, status, limit = '50' } = req.query;
    
    let query = `SELECT j.*, a.name as app_name FROM deployment_jobs j JOIN apps a ON j.app_id = a.id`;
    const params = [];
    const conditions = [];
    
    if (app_id) {
      conditions.push('j.app_id = ?');
      params.push(app_id);
    }
    if (status) {
      conditions.push('j.status = ?');
      params.push(status);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ` ORDER BY j.started_at DESC LIMIT ?`;
    params.push(Math.min(parseInt(limit, 10), 200));
    
    return db.prepare(query).all(...params);
  });
  
  // Get specific job
  app.get('/queue/jobs/:jobId', { onRequest: [app.authenticate] }, async (req, reply) => {
    const job = getJob(req.params.jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    return job;
  });
}
