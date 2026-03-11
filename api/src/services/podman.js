import http from 'http';
import net from 'net';
import { getDB } from '../db/database.js';

function getSocketPath() {
  try {
    const db = getDB();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'podman_socket'").get();
    return row?.value || process.env.PODMAN_SOCKET || '/run/user/1000/podman/podman.sock';
  } catch {
    return process.env.PODMAN_SOCKET || '/run/user/1000/podman/podman.sock';
  }
}

const API_TIMEOUT_MS = parseInt(process.env.PODMAN_TIMEOUT_MS || '15000', 10);

/**
 * Make a request to the Podman REST API via Unix socket.
 */
export async function podmanRequest(method, path, body = null, options = {}) {
  const socketPath = getSocketPath();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy(new Error(`Podman API timeout after ${API_TIMEOUT_MS}ms: ${method} ${path}`));
    }, options.timeout ?? API_TIMEOUT_MS);

    const reqOptions = {
      socketPath,
      path: `/v4.0.0/libpod${path}`,
      method,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    };

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString();
        if (options.raw) return resolve({ status: res.statusCode, body: raw, headers: res.headers });
        if (!raw.trim()) return resolve({ status: res.statusCode, body: null });
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
      res.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Stream data from Podman API (logs, build output etc.)
 */
export function podmanStream(path, onData, onEnd, onError) {
  const socketPath = getSocketPath();

  const req = http.request(
    { socketPath, path: `/v4.0.0/libpod${path}`, method: 'GET' },
    (res) => {
      res.on('data', chunk => onData(chunk.toString()));
      res.on('end', () => onEnd?.());
      res.on('error', err => onError?.(err));
    }
  );

  req.on('error', err => onError?.(err));
  req.end();
  return req;
}

// ── Containers ──────────────────────────────────────────────────────────────

export async function listContainers(all = true) {
  const res = await podmanRequest('GET', `/containers/json?all=${all}`);
  return Array.isArray(res.body) ? res.body : [];
}

export async function getContainer(nameOrId) {
  const res = await podmanRequest('GET', `/containers/${encodeURIComponent(nameOrId)}/json`);
  return res.status === 200 ? res.body : null;
}

export async function createContainer(config) {
  const res = await podmanRequest('POST', '/containers/create', config);
  if (res.status !== 201) {
    throw new Error(res.body?.cause || res.body?.message || `Failed to create container (HTTP ${res.status})`);
  }
  return res.body;
}

export async function startContainer(nameOrId) {
  const res = await podmanRequest('POST', `/containers/${encodeURIComponent(nameOrId)}/start`);
  if (res.status !== 204 && res.status !== 304) {
    throw new Error(res.body?.cause || res.body?.message || `Failed to start container (HTTP ${res.status})`);
  }
  return true;
}

export async function stopContainer(nameOrId, timeout = 10) {
  const res = await podmanRequest('POST', `/containers/${encodeURIComponent(nameOrId)}/stop?t=${timeout}`);
  return res.status === 204 || res.status === 304;
}

export async function removeContainer(nameOrId, force = true) {
  const res = await podmanRequest('DELETE', `/containers/${encodeURIComponent(nameOrId)}?force=${force}`);
  return res.status === 204 || res.status === 200;
}

export async function restartContainer(nameOrId) {
  const res = await podmanRequest('POST', `/containers/${encodeURIComponent(nameOrId)}/restart`);
  return res.status === 204;
}

export async function getContainerStats(nameOrId) {
  const res = await podmanRequest('GET', `/containers/${encodeURIComponent(nameOrId)}/stats?stream=false`);
  return res.status === 200 ? res.body : null;
}

export async function getContainerLogs(nameOrId, tail = 100) {
  const res = await podmanRequest(
    'GET',
    `/containers/${encodeURIComponent(nameOrId)}/logs?stdout=true&stderr=true&tail=${tail}`,
    null, { raw: true }
  );
  return res.body || '';
}

// ── Images ──────────────────────────────────────────────────────────────────

export async function listImages() {
  const res = await podmanRequest('GET', '/images/json');
  return Array.isArray(res.body) ? res.body : [];
}

export async function pullImage(reference) {
  const res = await podmanRequest(
    'POST',
    `/images/pull?reference=${encodeURIComponent(reference)}&quiet=false`,
    null, { timeout: 300000 } // 5 min for large images
  );
  return res.body;
}

export async function removeImage(nameOrId, force = false) {
  const res = await podmanRequest('DELETE', `/images/${encodeURIComponent(nameOrId)}?force=${force}`);
  return res.status === 200;
}

// ── Networks ────────────────────────────────────────────────────────────────

export async function listNetworks() {
  const res = await podmanRequest('GET', '/networks/json');
  return Array.isArray(res.body) ? res.body : [];
}

export async function createNetwork(name, options = {}) {
  const res = await podmanRequest('POST', '/networks/create', { name, ...options });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Failed to create network "${name}" (HTTP ${res.status})`);
  }
  return res.body;
}

export async function ensureNetwork(name) {
  const networks = await listNetworks();
  const existing = networks.find(n => n.Name === name || n.name === name);
  if (existing) return existing;
  return createNetwork(name);
}

// ── Volumes ─────────────────────────────────────────────────────────────────

export async function listVolumes() {
  const res = await podmanRequest('GET', '/volumes/json');
  return Array.isArray(res.body) ? res.body : [];
}

export async function createVolume(name, options = {}) {
  const body = {
    Name: name,
    Driver: options.driver || 'local',
    DriverOpts: options.driver_opts || {},
    Labels: options.labels || {}
  };
  const res = await podmanRequest('POST', '/volumes/create', body);
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(res.body?.message || `Failed to create volume: ${res.status}`);
  }
  return res.body;
}

export async function inspectVolume(name) {
  const res = await podmanRequest('GET', `/volumes/${encodeURIComponent(name)}`);
  if (res.status !== 200) {
    throw new Error(res.body?.message || `Volume not found: ${res.status}`);
  }
  return res.body;
}

export async function removeVolume(name, force = false) {
  const res = await podmanRequest('DELETE', `/volumes/${encodeURIComponent(name)}?force=${force}`);
  return res.status === 204 || res.status === 200;
}

// ── System ───────────────────────────────────────────────────────────────────

export async function systemInfo() {
  const res = await podmanRequest('GET', '/info', null, { timeout: 5000 });
  return res.status === 200 ? res.body : null;
}

export async function ping() {
  try {
    const res = await podmanRequest('GET', '/_ping', null, { timeout: 3000 });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ── Port management ──────────────────────────────────────────────────────────

/**
 * Sanitize a name for use as a container name
 * Docker/Podman rules: [a-zA-Z0-9][a-zA-Z0-9_.-]*, max 63 chars
 */
export function sanitizeContainerName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
    .replace(/^[^a-z0-9]/, 'a')
    .substring(0, 63);
}

/**
 * Check if a port is actually available on the host
 * @param {number} port - Port to check
 * @returns {Promise<boolean>} - True if port is available
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false); // Port is in use
      } else {
        resolve(false); // Other error, treat as unavailable
      }
    });
    
    server.once('listening', () => {
      server.close(() => {
        resolve(true); // Port is available
      });
    });
    
    server.listen(port, '0.0.0.0');
  });
}

export async function findFreePort(start = 10000, end = 60000) {
  // First, get ports from containers and DB as candidates to skip
  const containers = await listContainers();
  const usedPorts = new Set();
  for (const c of containers) {
    for (const p of (c.Ports || [])) {
      if (p.host_port) usedPorts.add(p.host_port);
    }
  }
  // Also check what the DB thinks is in use
  try {
    const db = getDB();
    const rows = db.prepare('SELECT host_port FROM apps WHERE host_port IS NOT NULL').all();
    for (const r of rows) usedPorts.add(r.host_port);
  } catch {}

  // Try ports, checking actual availability with net.Server
  for (let port = start; port <= end; port++) {
    // Skip if we already know it's used
    if (usedPorts.has(port)) continue;
    
    // Actually check if port is available on host
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
  }
  
  throw new Error('No free port available in range');
}
