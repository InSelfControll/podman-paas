import crypto from 'crypto';
import { getDB } from '../db/database.js';
import { deployApp } from '../services/deploy.js';

export default async function webhooksRoutes(app) {
  // GitHub webhook receiver — no auth required (uses HMAC signature)
  app.post('/github/:appId', {
    config: { rawBody: true },
  }, async (req, reply) => {
    const db = getDB();
    const appRow = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.appId);
    if (!appRow) return reply.code(404).send({ error: 'App not found' });

    const secret = appRow.webhook_secret;
    if (!secret) return reply.code(403).send({ error: 'Webhook not configured for this app' });

    // Verify GitHub HMAC signature
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) return reply.code(401).send({ error: 'Missing X-Hub-Signature-256 header' });

    const rawBody = JSON.stringify(req.body);
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    // Only trigger on push events
    const event = req.headers['x-github-event'];
    if (event !== 'push') {
      return { message: `Ignored event: ${event}` };
    }

    // Only trigger for the configured branch
    const payload = req.body;
    const pushBranch = (payload.ref || '').replace('refs/heads/', '');
    const targetBranch = appRow.branch || 'main';

    if (pushBranch !== targetBranch) {
      return { message: `Ignored push to ${pushBranch} (watching ${targetBranch})` };
    }

    // Trigger deploy
    try {
      const { deploymentId } = await deployApp(appRow.id, 'webhook');
      req.log.info({ appId: appRow.id, deploymentId, branch: pushBranch }, 'Webhook deploy triggered');
      return { deploymentId, message: 'Deployment triggered' };
    } catch (e) {
      return reply.code(409).send({ error: e.message });
    }
  });

  // Generate/regenerate webhook secret for an app
  app.post('/generate-secret/:appId', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    const appRow = db.prepare('SELECT id FROM apps WHERE id = ?').get(req.params.appId);
    if (!appRow) return reply.code(404).send({ error: 'App not found' });

    const secret = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE apps SET webhook_secret = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(secret, req.params.appId);

    return { secret, webhook_url: `/api/webhooks/github/${req.params.appId}` };
  });
}
