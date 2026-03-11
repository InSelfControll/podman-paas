/**
 * Reverse Proxy Factory
 * 
 * Provides a unified interface for different reverse proxy implementations.
 * Supports: caddy, nginx, traefik, custom (external), none
 * 
 * Modes:
 * - container: Proxy runs as a container in the podman-paas network
 * - remote: Proxy is on a remote server with VPN/P2P access to container network
 * - host: Proxy installed directly on the host machine
 */

import { getDB } from '../../db/database.js';
import { getContainer, listContainers } from '../podman.js';

// Registry of proxy implementations
const implementations = new Map();

/**
 * Register a proxy implementation
 */
export function registerProxy(type, implementation) {
  implementations.set(type, implementation);
}

/**
 * Get the configured proxy type from settings
 */
export function getProxyType() {
  const db = getDB();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'proxy_type'").get();
  return row?.value || 'caddy';
}

/**
 * Get proxy configuration from settings
 */
export function getProxyConfig() {
  const db = getDB();
  const settings = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'proxy_%' OR key IN ('domain_suffix', 'auto_ssl')").all();
  
  const config = {
    type: getProxyType(),
    mode: 'container', // container, remote, host
    domainSuffix: '.localhost',
    autoSsl: false,
  };
  
  for (const row of settings) {
    switch (row.key) {
      case 'proxy_type':
        config.type = row.value;
        break;
      case 'proxy_mode':
        config.mode = row.value;
        break;
      case 'domain_suffix':
        config.domainSuffix = row.value;
        break;
      case 'auto_ssl':
        config.autoSsl = row.value === 'true';
        break;
      case 'proxy_admin_url':
        config.adminUrl = row.value;
        break;
      case 'proxy_config_path':
        config.configPath = row.value;
        break;
      case 'proxy_custom_template':
        config.customTemplate = row.value;
        break;
      case 'proxy_network_name':
        config.networkName = row.value;
        break;
      case 'proxy_container_name':
        config.containerName = row.value;
        break;
      case 'proxy_remote_host':
        config.remoteHost = row.value;
        break;
      case 'proxy_podman_network':
        config.podmanNetwork = row.value;
        break;
    }
  }
  
  return config;
}

/**
 * Get the active proxy implementation
 */
export function getProxy() {
  const type = getProxyType();
  const impl = implementations.get(type);
  
  if (!impl) {
    // Return a no-op implementation for unknown types
    return createNoOpProxy();
  }
  
  return impl;
}

/**
 * Get the upstream address for a container based on proxy mode
 * 
 * Mode: container - returns container's IP in the podman network
 * Mode: remote    - returns host IP + port (accessible via VPN/P2P)
 * Mode: host      - returns localhost:port
 */
export async function getUpstreamAddress(containerNameOrId, hostPort) {
  const config = getProxyConfig();
  
  switch (config.mode) {
    case 'container': {
      // Get the container's IP address in the shared network
      try {
        const container = await getContainer(containerNameOrId);
        const networkName = config.podmanNetwork || 'podman-paas';
        const network = container.NetworkSettings?.Networks?.[networkName];
        
        if (network?.IPAddress) {
          return `${network.IPAddress}:${hostPort}`;
        }
        
        // Fallback: use container name as hostname (DNS resolution within network)
        return `${containerNameOrId}:${hostPort}`;
      } catch (err) {
        console.warn(`[Proxy] Could not get container IP for ${containerNameOrId}, using localhost fallback`);
        return `localhost:${hostPort}`;
      }
    }
    
    case 'remote': {
      // Return host IP + port - assumes VPN/P2P connectivity
      // Users can configure the host IP in settings
      const hostIp = config.remoteHost || 'host.docker.internal';
      return `${hostIp}:${hostPort}`;
    }
    
    case 'host':
    default:
      // Proxy is installed on host, use localhost
      return `localhost:${hostPort}`;
  }
}

/**
 * Check if proxy is available/reachable
 */
export async function isProxyAvailable() {
  const proxy = getProxy();
  if (proxy.isAvailable) {
    return proxy.isAvailable();
  }
  return true;
}

/**
 * Register an app route with the configured proxy
 */
export async function registerAppRoute(appName, domain, hostPort, options = {}) {
  const proxy = getProxy();
  const config = getProxyConfig();
  
  if (!proxy.registerRoute) {
    console.warn(`[Proxy] No registerRoute method for proxy type: ${config.type}`);
    return { host: domain || `${appName}${config.domainSuffix}`, managed: false };
  }
  
  try {
    // Determine the upstream address based on proxy mode
    const containerName = options.containerName || `paas-${appName}`;
    const upstream = await getUpstreamAddress(containerName, hostPort);
    
    const result = await proxy.registerRoute(appName, domain, hostPort, {
      ...options,
      domainSuffix: config.domainSuffix,
      autoSsl: config.autoSsl,
      upstream,
      mode: config.mode,
    });
    return { ...result, managed: true, upstream };
  } catch (err) {
    console.error(`[Proxy] Failed to register route for ${appName}:`, err.message);
    // Return the domain but mark as not managed
    return { 
      host: domain || `${appName}${config.domainSuffix}`, 
      managed: false,
      error: err.message 
    };
  }
}

/**
 * Remove an app route from the configured proxy
 */
export async function removeAppRoute(appName) {
  const proxy = getProxy();
  
  if (!proxy.removeRoute) {
    return false;
  }
  
  try {
    return await proxy.removeRoute(appName);
  } catch (err) {
    console.error(`[Proxy] Failed to remove route for ${appName}:`, err.message);
    return false;
  }
}

/**
 * List all routes from the configured proxy
 */
export async function listProxyRoutes() {
  const proxy = getProxy();
  
  if (!proxy.listRoutes) {
    return [];
  }
  
  try {
    return await proxy.listRoutes();
  } catch (err) {
    console.error('[Proxy] Failed to list routes:', err.message);
    return [];
  }
}

/**
 * Get proxy status and health information
 */
export async function getProxyStatus() {
  const type = getProxyType();
  const config = getProxyConfig();
  const proxy = getProxy();
  
  const status = {
    type,
    config,
    available: false,
    details: {},
  };
  
  if (proxy.getStatus) {
    try {
      const implStatus = await proxy.getStatus();
      status.available = implStatus.available;
      status.details = implStatus.details || {};
    } catch (err) {
      status.error = err.message;
    }
  } else if (type === 'none') {
    status.available = true;
    status.details = { message: 'Reverse proxy disabled' };
  } else if (type === 'custom') {
    status.available = true;
    status.details = { message: 'Using external proxy - manual configuration required' };
  }
  
  return status;
}

/**
 * Update proxy configuration
 */
export function updateProxyConfig(updates) {
  const db = getDB();
  
  if (updates.type) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run('proxy_type', updates.type);
  }
  
  if (updates.mode) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run('proxy_mode', updates.mode);
  }
  
  if (updates.adminUrl !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run('proxy_admin_url', updates.adminUrl);
  }
  
  if (updates.configPath !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run('proxy_config_path', updates.configPath);
  }
  
  if (updates.customTemplate !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run('proxy_custom_template', updates.customTemplate);
  }
  
  if (updates.networkName !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run('proxy_network_name', updates.networkName);
  }
  
  if (updates.containerName !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run('proxy_container_name', updates.containerName);
  }
  
  if (updates.remoteHost !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run('proxy_remote_host', updates.remoteHost);
  }
  
  if (updates.podmanNetwork !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run('proxy_podman_network', updates.podmanNetwork);
  }
  
  if (updates.domainSuffix) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run('domain_suffix', updates.domainSuffix);
  }
  
  if (updates.autoSsl !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run('auto_ssl', updates.autoSsl ? 'true' : 'false');
  }
  
  return getProxyConfig();
}

/**
 * Create a no-op proxy implementation
 */
function createNoOpProxy() {
  return {
    async registerRoute(appName, domain, hostPort) {
      return { host: domain };
    },
    async removeRoute(appName) {
      return true;
    },
    async listRoutes() {
      return [];
    },
    async getStatus() {
      return { available: false, details: { message: 'No proxy implementation available' } };
    },
  };
}

/**
 * Get available proxy types and their metadata
 */
export function getAvailableProxyTypes() {
  return [
    {
      type: 'caddy',
      name: 'Caddy',
      description: 'Automatic HTTPS, easy configuration via REST API',
      features: ['auto_ssl', 'api_config', 'dynamic_routes', 'container_mode'],
      defaultAdminUrl: 'http://caddy:2019',
      defaultContainerName: 'caddy',
    },
    {
      type: 'nginx',
      name: 'Nginx',
      description: 'High-performance web server and reverse proxy',
      features: ['file_config', 'custom_templates', 'container_mode'],
      defaultContainerName: 'nginx',
    },
    {
      type: 'traefik',
      name: 'Traefik',
      description: 'Cloud-native edge router with Docker/Podman integration',
      features: ['auto_ssl', 'api_config', 'container_labels', 'docker_integration', 'container_mode'],
      defaultAdminUrl: 'http://traefik:8080',
      defaultContainerName: 'traefik',
    },
    {
      type: 'custom',
      name: 'Custom / External',
      description: 'Use your own reverse proxy (manual configuration required)',
      features: ['manual_config', 'container_mode', 'remote_mode'],
    },
    {
      type: 'none',
      name: 'Disabled',
      description: 'No reverse proxy - apps accessible via ports only',
      features: [],
    },
  ];
}

/**
 * Get available proxy deployment modes
 */
export function getProxyModes() {
  return [
    {
      mode: 'container',
      name: 'Container (Recommended)',
      description: 'Proxy runs as a container in the podman-paas network',
      details: 'Best for isolated, reproducible deployments. Proxy container can reach apps via container IPs.',
    },
    {
      mode: 'remote',
      name: 'Remote Server',
      description: 'Proxy runs on a different server with network access to containers',
      details: 'Requires VPN, P2P (Tailscale, ZeroTier), or direct network connectivity between proxy and host.',
    },
    {
      mode: 'host',
      name: 'Host Installation',
      description: 'Proxy installed directly on the host machine',
      details: 'Traditional setup. Proxy accesses containers via localhost:port.',
    },
  ];
}

/**
 * Initialize the proxy system
 */
export async function initProxySystem() {
  // Import and register all implementations
  const [{ initCaddy }, { initNginx }, { initTraefik }] = await Promise.all([
    import('./caddy-impl.js'),
    import('./nginx-impl.js'),
    import('./traefik-impl.js'),
  ]);
  
  registerProxy('caddy', initCaddy());
  registerProxy('nginx', initNginx());
  registerProxy('traefik', initTraefik());
  
  console.log('[Proxy] System initialized with types:', Array.from(implementations.keys()));
}
