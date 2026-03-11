import { getDB } from '../db/database.js';
import { getContainerLogs, podmanStream } from '../services/podman.js';
import { subscribeToDeployment } from '../services/deploy.js';
import { verifyWSTicket, generateWSTicketHandler, markTicketUsed, isTicketUsed, getTicketStats } from '../services/ws-tickets.js';

// How long a WebSocket may stay connected to a log stream (ms)
const MAX_LOG_STREAM_MS = 30 * 60 * 1000; // 30 min

export default async function logsRoutes(app) {

  // ── REST: Create WebSocket ticket ─────────────────────────────────────────
  app.post('/ticket', { onRequest: [app.authenticate] }, generateWSTicketHandler);

  // ── REST: recent container logs ─────────────────────────────────────────
  app.get('/app/:appId', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    const a = db.prepare('SELECT container_id FROM apps WHERE id = ?').get(req.params.appId);
    if (!a) return reply.code(404).send({ error: 'App not found' });
    if (!a.container_id) return reply.code(404).send({ error: 'No running container' });

    const tail = Math.min(parseInt(req.query.tail || '200', 10), 2000);
    const logs = await getContainerLogs(a.container_id, tail);
    return { logs };
  });

  // ── WS: live container log stream ────────────────────────────────────────
  app.get('/app/:appId/stream', { websocket: true }, async (connection, req) => {
    // In @fastify/websocket v10, 'connection' IS the WebSocket instance
    const socket = connection;
    
    // Authenticate via ticket (NOT JWT in query params for security)
    const ticket = req.query.ticket;
    
    // Check for replay attack
    if (isTicketUsed(ticket)) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'error', message: 'Ticket already used' }));
        socket.close(4001, 'Unauthorized');
      }
      return;
    }
    
    const ticketData = verifyWSTicket(ticket, 'app', req.params.appId);
    
    if (!ticketData) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid or expired ticket' }));
        socket.close(4001, 'Unauthorized');
      }
      return;
    }
    
    // Mark ticket as used (one-time use)
    markTicketUsed(ticket);

    const db = getDB();
    const a = db.prepare('SELECT container_id FROM apps WHERE id = ?').get(req.params.appId);

    if (!a?.container_id) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'error', message: 'No running container' }));
        socket.close();
      }
      return;
    }

    const send = (data) => {
      if (socket.readyState === 1) {
        try {
          socket.send(JSON.stringify({ type: 'log', data }));
        } catch (err) {
          console.error('[WS] Failed to send:', err.message);
        }
      }
    };

    const streamReq = podmanStream(
      `/containers/${encodeURIComponent(a.container_id)}/logs?stdout=true&stderr=true&follow=true&tail=200`,
      send,
      () => socket.readyState === 1 && send('[Stream ended]'),
      (err) => socket.readyState === 1 && send(`[Stream error: ${err.message}]`)
    );

    // Safety valve: close stream after max duration
    const maxTimer = setTimeout(() => {
      send('[Log stream timeout — reconnect to continue]');
      try { streamReq.destroy(); } catch {}
      if (socket.readyState === 1) socket.close();
    }, MAX_LOG_STREAM_MS);

    socket.on('close', () => {
      clearTimeout(maxTimer);
      try { streamReq.destroy(); } catch {}
    });
    
    socket.on('error', (err) => {
      console.error('[WS] Socket error:', err.message);
      clearTimeout(maxTimer);
      try { streamReq.destroy(); } catch {}
    });
  });

  // ── WS: live deployment build log stream ────────────────────────────────
  app.get('/deployment/:deploymentId/stream', { websocket: true }, async (connection, req) => {
    // In @fastify/websocket v10, 'connection' IS the WebSocket instance
    const socket = connection;
    
    // Authenticate via ticket (NOT JWT in query params for security)
    const ticket = req.query.ticket;
    
    // Check for replay attack
    if (isTicketUsed(ticket)) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'error', message: 'Ticket already used' }));
        socket.close(4001, 'Unauthorized');
      }
      return;
    }
    
    const ticketData = verifyWSTicket(ticket, 'deployment', req.params.deploymentId);
    
    if (!ticketData) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid or expired ticket' }));
        socket.close(4001, 'Unauthorized');
      }
      return;
    }
    
    // Mark ticket as used (one-time use)
    markTicketUsed(ticket);

    const db = getDB();
    const deployment = db.prepare('SELECT * FROM deployments WHERE id = ?').get(req.params.deploymentId);
    if (!deployment) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'error', message: 'Deployment not found' }));
        socket.close();
      }
      return;
    }

    const send = (data) => {
      if (socket.readyState === 1) {
        try {
          socket.send(JSON.stringify({ type: 'log', data }));
        } catch (err) {
          console.error('[WS] Failed to send:', err.message);
        }
      }
    };
    
    const done = (status) => {
      if (socket.readyState === 1) {
        try {
          socket.send(JSON.stringify({ type: 'done', status }));
        } catch (err) {
          console.error('[WS] Failed to send done:', err.message);
        }
      }
    };

    // Replay existing log lines first
    if (deployment.log) {
      for (const line of deployment.log.split('\n').filter(Boolean)) {
        send(line);
      }
    }

    if (deployment.status !== 'running') {
      done(deployment.status);
      return;
    }

    // Subscribe to live stream
    const unsubscribe = subscribeToDeployment(req.params.deploymentId, send);

    // Poll DB for completion (streaming runs server-side, WS just relays)
    const pollInterval = setInterval(() => {
      try {
        const updated = db.prepare('SELECT status FROM deployments WHERE id = ?')
          .get(req.params.deploymentId);
        if (updated?.status !== 'running') {
          clearInterval(pollInterval);
          unsubscribe();
          done(updated?.status);
        }
      } catch {
        clearInterval(pollInterval);
        unsubscribe();
      }
    }, 1000);

    const maxTimer = setTimeout(() => {
      clearInterval(pollInterval);
      unsubscribe();
      send('[Log stream timeout]');
      if (socket.readyState === 1) socket.close();
    }, MAX_LOG_STREAM_MS);

    socket.on('close', () => {
      clearInterval(pollInterval);
      clearTimeout(maxTimer);
      unsubscribe();
    });
    
    socket.on('error', (err) => {
      console.error('[WS] Socket error:', err.message);
      clearInterval(pollInterval);
      clearTimeout(maxTimer);
      unsubscribe();
    });
  });

  // ── REST: get deployment record + full log ───────────────────────────────
  app.get('/deployment/:deploymentId', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    const d = db.prepare('SELECT * FROM deployments WHERE id = ?').get(req.params.deploymentId);
    if (!d) return reply.code(404).send({ error: 'Deployment not found' });
    return d;
  });

  // ── REST: get WebSocket ticket statistics ────────────────────────────────
  app.get('/ticket-stats', { onRequest: [app.authenticate] }, async () => {
    return getTicketStats();
  });
}
