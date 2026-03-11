import { getDB } from '../db/database.js';

export default async function deploymentsRoutes(app) {
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

  app.get('/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    const d = db.prepare(
      'SELECT d.*, a.name as app_name FROM deployments d JOIN apps a ON d.app_id = a.id WHERE d.id = ?'
    ).get(req.params.id);
    if (!d) return reply.code(404).send({ error: 'Not found' });
    return d;
  });
}
