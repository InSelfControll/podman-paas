/**
 * Caddy Reverse Proxy Implementation
 * 
 * Uses Caddy's admin API for dynamic configuration.
 */

import { getDB } from '../../db/database.js';

function getAdminUrl() {
  const db = getDB();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'proxy_admin_url'").get();
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
async function getConfig() {
  const res = await fetch(`${getAdminUrl()}/config/`);
  if (!res.ok) throw new Error(`Caddy unreachable: ${res.status}`);
  return res.json();
}

/**
 * Initialize Caddy with a base HTTP server config if not already set up
 */
async function initConfig() {
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
    const current = await getConfig();
    if (current?.apps?.http?.servers?.srv0) return; // Already configured
  } catch {}

  const res = await fetch(`${getAdminUrl()}/config/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseConfig)
  });

  if (!res.ok) throw new Error(`Failed to initialize Caddy: ${res.status}`);
}

async function ensureReady() {
  try {
    await initConfig();
  } catch {
    // Caddy may not be running — silently continue
  }
}

export function initCaddy() {
  return {
    /**
     * Check if Caddy is reachable
     */
    async isAvailable() {
      try {
        const res = await fetch(`${getAdminUrl()}/config/`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
      } catch {
        return false;
      }
    },

    /**
     * Get Caddy status and info
     */
    async getStatus() {
      try {
        const res = await fetch(`${getAdminUrl()}/config/`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const config = await res.json();
          const routes = config?.apps?.http?.servers?.srv0?.routes || [];
          return {
            available: true,
            details: {
              version: '2.x',
              routeCount: routes.length,
              adminUrl: getAdminUrl(),
            }
          };
        }
        return { available: false, details: { error: `HTTP ${res.status}` } };
      } catch (err) {
        return { available: false, details: { error: err.message } };
      }
    },

    /**
     * Register a new app route
     */
    async registerRoute(appName, domain, hostPort, options = {}) {
      await ensureReady();

      const host = domain || `${appName}${getDomainSuffix()}`;
      const routeId = `app-${appName}`;
      
      // Use provided upstream or default to localhost
      const upstream = options.upstream || `localhost:${hostPort}`;

      const route = {
        '@id': routeId,
        match: [{ host: [host] }],
        handle: [
          {
            handler: 'reverse_proxy',
            upstreams: [{ dial: upstream }],
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
        const updateRes = await fetch(`${getAdminUrl()}/id/${routeId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(route)
        });
        if (updateRes.ok) return { host };
      } catch {}

      // Add as new route
      const addRes = await fetch(`${getAdminUrl()}/config/apps/http/servers/srv0/routes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(route)
      });

      if (!addRes.ok) {
        const text = await addRes.text();
        throw new Error(`Failed to register route: ${text}`);
      }

      return { host };
    },

    /**
     * Remove an app route
     */
    async removeRoute(appName) {
      const routeId = `app-${appName}`;

      try {
        const res = await fetch(`${getAdminUrl()}/id/${routeId}`, {
          method: 'DELETE'
        });
        return res.ok;
      } catch {
        return false;
      }
    },

    /**
     * List all routes
     */
    async listRoutes() {
      try {
        const res = await fetch(`${getAdminUrl()}/config/apps/http/servers/srv0/routes`);
        if (!res.ok) return [];
        return res.json();
      } catch {
        return [];
      }
    },

    /**
     * Reload configuration
     */
    async reload() {
      // Caddy applies changes immediately via API
      return true;
    },
  };
}
