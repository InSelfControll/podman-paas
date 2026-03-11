import { getDB } from '../db/database.js';

function getCaddyAdminUrl() {
  const db = getDB();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'caddy_admin_url'").get();
  return row?.value || 'http://localhost:2019';
}

function getDomainSuffix() {
  const db = getDB();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'domain_suffix'").get();
  return row?.value || '.localhost';
}

/**
 * Fetch Caddy's current config
 */
export async function getCaddyConfig() {
  const res = await fetch(`${getCaddyAdminUrl()}/config/`);
  if (!res.ok) throw new Error(`Caddy unreachable: ${res.status}`);
  return res.json();
}

/**
 * Initialize Caddy with a base HTTP server config if not already set up
 */
export async function initCaddyConfig() {
  const baseConfig = {
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [':80', ':443'],
            routes: []
          }
        }
      }
    }
  };

  try {
    const current = await getCaddyConfig();
    if (current?.apps?.http?.servers?.srv0) return; // Already configured
  } catch {}

  const res = await fetch(`${getCaddyAdminUrl()}/config/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseConfig)
  });

  if (!res.ok) throw new Error(`Failed to initialize Caddy: ${res.status}`);
}

/**
 * Register a new app route in Caddy
 */
export async function registerAppRoute(appName, domain, hostPort) {
  await ensureCaddyReady();

  const host = domain || `${appName}${getDomainSuffix()}`;
  const routeId = `app-${appName}`;

  const route = {
    '@id': routeId,
    match: [{ host: [host] }],
    handle: [
      {
        handler: 'reverse_proxy',
        upstreams: [{ dial: `localhost:${hostPort}` }],
        health_checks: {
          passive: {
            fail_duration: '30s',
            max_fails: 3
          }
        }
      }
    ],
    terminal: true
  };

  try {
    // Try to update existing route
    const updateRes = await fetch(`${getCaddyAdminUrl()}/id/${routeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(route)
    });
    if (updateRes.ok) return { host };
  } catch {}

  // Add as new route
  const addRes = await fetch(`${getCaddyAdminUrl()}/config/apps/http/servers/srv0/routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(route)
  });

  if (!addRes.ok) {
    const text = await addRes.text();
    throw new Error(`Failed to register Caddy route: ${text}`);
  }

  return { host };
}

/**
 * Remove an app route from Caddy
 */
export async function removeAppRoute(appName) {
  const routeId = `app-${appName}`;

  try {
    const res = await fetch(`${getCaddyAdminUrl()}/id/${routeId}`, {
      method: 'DELETE'
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * List all current routes in Caddy
 */
export async function listRoutes() {
  try {
    const res = await fetch(`${getCaddyAdminUrl()}/config/apps/http/servers/srv0/routes`);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

async function ensureCaddyReady() {
  try {
    await initCaddyConfig();
  } catch {
    // Caddy may not be running — silently continue
  }
}

/**
 * Check if Caddy is reachable
 */
export async function isCaddyReachable() {
  try {
    const res = await fetch(`${getCaddyAdminUrl()}/config/`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
