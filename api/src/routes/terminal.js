import { spawn } from 'child_process';
import { getDB } from '../db/database.js';

// Active terminal sessions
const sessions = new Map();

export default async function terminalRoutes(app) {

  // ── WS: Interactive terminal for container ─────────────────────────────────
  app.get('/container/:containerId', { websocket: true }, async (connection, req) => {
    const socket = connection;
    const containerId = req.params.containerId;
    
    // Authenticate via query param token
    try {
      const token = req.query.token;
      if (!token) throw new Error('Missing token');
      app.jwt.verify(token);
    } catch {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        socket.close();
      }
      return;
    }

    // Detect available shell in container
    const shells = ['/bin/bash', '/bin/sh', '/bin/zsh', '/bin/ash'];
    let shell = '/bin/sh'; // default fallback
    
    try {
      // Try to find which shell exists in the container
      for (const s of shells) {
        try {
          const check = spawn('podman', ['exec', containerId, 'test', '-x', s], {
            timeout: 5000,
          });
          const result = await new Promise((resolve) => {
            check.on('close', code => resolve(code === 0));
          });
          if (result) {
            shell = s;
            break;
          }
        } catch {}
      }
    } catch {}

    console.log(`[Terminal] Starting session for ${containerId} with shell ${shell}`);

    // Spawn podman exec for interactive shell
    const proc = spawn('podman', [
      'exec', '-it', containerId, shell
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const sessionId = `${containerId}-${Date.now()}`;
    sessions.set(sessionId, { proc, containerId });

    // Send initial message
    socket.send(JSON.stringify({ 
      type: 'connected', 
      message: `Connected to ${containerId} (${shell})\r\n`,
      shell 
    }));

    // Handle output from container
    proc.stdout.on('data', (data) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ 
          type: 'data', 
          data: data.toString('base64') 
        }));
      }
    });

    proc.stderr.on('data', (data) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ 
          type: 'data', 
          data: data.toString('base64') 
        }));
      }
    });

    // Handle input from client
    socket.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        if (msg.type === 'input' && proc.stdin.writable) {
          const buffer = Buffer.from(msg.data, 'base64');
          proc.stdin.write(buffer);
        } else if (msg.type === 'resize') {
          // Handle terminal resize if needed
          // Note: podman exec doesn't support resize directly
        }
      } catch (err) {
        console.error('[Terminal] Error handling message:', err);
      }
    });

    // Cleanup on close
    proc.on('exit', (code) => {
      console.log(`[Terminal] Session ${sessionId} exited with code ${code}`);
      sessions.delete(sessionId);
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'exit', code }));
        socket.close();
      }
    });

    proc.on('error', (err) => {
      console.error(`[Terminal] Session ${sessionId} error:`, err);
      sessions.delete(sessionId);
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'error', message: err.message }));
        socket.close();
      }
    });

    socket.on('close', () => {
      console.log(`[Terminal] Socket closed for ${sessionId}`);
      sessions.delete(sessionId);
      try {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
      } catch {}
    });

    socket.on('error', (err) => {
      console.error(`[Terminal] Socket error for ${sessionId}:`, err);
      sessions.delete(sessionId);
      try {
        proc.kill('SIGKILL');
      } catch {}
    });
  });

  // ── Get available shells for a container ───────────────────────────────────
  app.get('/shells/:containerId', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { containerId } = req.params;
    const shells = ['/bin/bash', '/bin/zsh', '/bin/sh', '/bin/ash'];
    const available = [];

    for (const shell of shells) {
      try {
        const check = spawn('podman', ['exec', containerId, 'test', '-x', shell], {
          timeout: 5000,
        });
        const result = await new Promise((resolve) => {
          check.on('close', code => resolve(code === 0));
        });
        if (result) {
          available.push(shell);
        }
      } catch {}
    }

    if (available.length === 0) {
      // Fallback to sh which should exist in most containers
      available.push('/bin/sh');
    }

    return { available, default: available[0] };
  });
}
