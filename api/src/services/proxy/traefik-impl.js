/**
 * Traefik Reverse Proxy Implementation
 * 
 * Uses Traefik's API for dynamic configuration.
 * Also supports file-based dynamic configuration.
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getDB } from '../../db/database.js';

function getAdminUrl() {
  const db = getDB();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'proxy_admin_url'").get();
  return row?.value || 'http://localhost:8080';
}

function getConfigPath() {
  const db = getDB();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'proxy_config_path'").get();
  return row?.value || '/etc/traefik/dynamic';
}

function getDomainSuffix() {
  const db = getDB();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'domain_suffix'").get();
  return row?.value || '.localhost';
}

function getConfigFilePath(appName) {
  return join(getConfigPath(), `podpaas-${appName}.yml`);
}

/**
 * Generate Traefik dynamic configuration
 */
function generateConfig(appName, domain, upstream, options = {}) {
  const host = domain || `${appName}${getDomainSuffix()}`;
  const routerName = `podpaas-${appName}`;
  const serviceName = `podpaas-${appName}-service`;
  
  const config = {
    http: {
      routers: {
        [routerName]: {
          rule: `Host(\`${host}\`)`,
          service: serviceName,
          entryPoints: ['web'],
          ...(options.autoSsl ? {
            tls: {
              certResolver: 'default'
            },
            entryPoints: ['websecure']
          } : {})
        }
      },
      services: {
        [serviceName]: {
          loadBalancer: {
            servers: [
              { url: `http://${upstream}` }
            ],
            healthCheck: {
              path: options.healthCheckPath || '/',
              interval: '10s',
              timeout: '5s'
            }
          }
        }
      }
    }
  };
  
  return config;
}

async function reloadTraefik() {
  // Try API reload first
  try {
    const res = await fetch(`${getAdminUrl()}/api/providers/file/reload`, {
      method: 'POST'
    });
    if (res.ok) return true;
  } catch {}
  
  // Fall back to SIGHUP
  try {
    const { execAsync } = await import('../../utils/exec.js');
    await execAsync('pkill -HUP traefik');
    return true;
  } catch {
    return false;
  }
}

export function initTraefik() {
  return {
    /**
     * Check if Traefik is available
     */
    async isAvailable() {
      try {
        const res = await fetch(`${getAdminUrl()}/api/version`, { 
          signal: AbortSignal.timeout(2000) 
        });
        return res.ok;
      } catch {
        // Also check if config directory is accessible (file-based mode)
        try {
          const configPath = getConfigPath();
          return existsSync(configPath);
        } catch {
          return false;
        }
      }
    },

    /**
     * Get Traefik status
     */
    async getStatus() {
      try {
        // Try to get version from API
        let version = 'unknown';
        let providerCount = 0;
        
        try {
          const versionRes = await fetch(`${getAdminUrl()}/api/version`, { 
            signal: AbortSignal.timeout(2000) 
          });
          if (versionRes.ok) {
            const data = await versionRes.json();
            version = data.version;
          }
          
          const providersRes = await fetch(`${getAdminUrl()}/api/providers`, { 
            signal: AbortSignal.timeout(2000) 
          });
          if (providersRes.ok) {
            const providers = await providersRes.json();
            providerCount = Object.keys(providers).length;
          }
        } catch {}
        
        // Count file-based routes
        const configPath = getConfigPath();
        let fileRouteCount = 0;
        if (existsSync(configPath)) {
          fileRouteCount = readdirSync(configPath)
            .filter(f => f.startsWith('podpaas-') && f.endsWith('.yml'))
            .length;
        }
        
        return {
          available: true,
          details: {
            version,
            providerCount,
            fileRouteCount,
            adminUrl: getAdminUrl(),
            configPath,
          }
        };
      } catch (err) {
        return { available: false, details: { error: err.message } };
      }
    },

    /**
     * Register a new app route
     */
    async registerRoute(appName, domain, hostPort, options = {}) {
      const host = domain || `${appName}${getDomainSuffix()}`;
      const configPath = getConfigPath();
      const configFile = getConfigFilePath(appName);
      
      // Use provided upstream or default to localhost
      const upstream = options.upstream || `localhost:${hostPort}`;
      
      // Ensure config directory exists
      if (!existsSync(configPath)) {
        try {
          mkdirSync(configPath, { recursive: true });
        } catch (err) {
          throw new Error(`Cannot create config directory: ${err.message}`);
        }
      }
      
      // Generate and write configuration
      const config = generateConfig(appName, host, upstream, options);
      writeFileSync(configFile, JSON.stringify(config, null, 2));
      
      // Try to reload Traefik
      try {
        await reloadTraefik();
      } catch (err) {
        console.warn(`[Traefik] Could not reload: ${err.message}`);
      }
      
      return { host, configFile };
    },

    /**
     * Remove an app route
     */
    async removeRoute(appName) {
      const configFile = getConfigFilePath(appName);
      
      if (!existsSync(configFile)) {
        return true;
      }
      
      try {
        unlinkSync(configFile);
        await reloadTraefik();
        return true;
      } catch (err) {
        console.error(`[Traefik] Failed to remove route for ${appName}:`, err.message);
        return false;
      }
    },

    /**
     * List all managed routes
     */
    async listRoutes() {
      const routes = [];
      
      // Try API first
      try {
        const res = await fetch(`${getAdminUrl()}/api/http/routers`, { 
          signal: AbortSignal.timeout(2000) 
        });
        if (res.ok) {
          const routers = await res.json();
          for (const router of routers) {
            if (router.name.startsWith('podpaas-')) {
              const appName = router.name.replace('podpaas-', '');
              const rule = router.rule;
              const domainMatch = rule.match(/Host\(`([^`]+)`\)/);
              
              routes.push({
                id: router.name,
                appName,
                domain: domainMatch?.[1] || rule,
                provider: router.provider,
              });
            }
          }
        }
      } catch {}
      
      // Also check file-based configs
      const configPath = getConfigPath();
      if (existsSync(configPath)) {
        const files = readdirSync(configPath)
          .filter(f => f.startsWith('podpaas-') && f.endsWith('.yml'));
        
        for (const file of files) {
          const appName = file.replace('podpaas-', '').replace('.yml', '');
          
          // Skip if already found via API
          if (routes.some(r => r.appName === appName)) continue;
          
          try {
            const content = readFileSync(join(configPath, file), 'utf8');
            const config = JSON.parse(content);
            const routerName = `podpaas-${appName}`;
            const router = config?.http?.routers?.[routerName];
            
            if (router) {
              const domainMatch = router.rule?.match(/Host\(`([^`]+)`\)/);
              routes.push({
                id: routerName,
                appName,
                domain: domainMatch?.[1],
                configFile: join(configPath, file),
                provider: 'file',
              });
            }
          } catch {}
        }
      }
      
      return routes;
    },

    /**
     * Reload configuration
     */
    async reload() {
      return reloadTraefik();
    },

    /**
     * Get Traefik provider configuration for container labels
     * This is useful for direct container label-based configuration
     */
    getContainerLabels(appName, domain, port, options = {}) {
      const host = domain || `${appName}${getDomainSuffix()}`;
      
      const labels = {
        'traefik.enable': 'true',
        [`traefik.http.routers.${appName}.rule`]: `Host(\`${host}\`)`,
        [`traefik.http.services.${appName}.loadbalancer.server.port`]: port.toString(),
      };
      
      if (options.autoSsl) {
        labels[`traefik.http.routers.${appName}.tls`] = 'true';
        labels[`traefik.http.routers.${appName}.tls.certresolver`] = 'default';
        labels[`traefik.http.routers.${appName}.entrypoints`] = 'websecure';
      } else {
        labels[`traefik.http.routers.${appName}.entrypoints`] = 'web';
      }
      
      return labels;
    },
  };
}
