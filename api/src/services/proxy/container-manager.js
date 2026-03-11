/**
 * Proxy Container Manager
 * 
 * Manages proxy containers (Caddy, Nginx, Traefik) deployment and configuration.
 * Automatically pulls images, creates containers, and configures them.
 */

import { getDB } from '../../db/database.js';
import { 
  pullImage, 
  createContainer, 
  startContainer, 
  stopContainer, 
  removeContainer,
  getContainer,
  ensureNetwork,
  listContainers,
  restartContainer,
} from '../podman.js';
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getProxyConfig } from './proxy-factory.js';

const PROXY_DATA_DIR = process.env.PROXY_DATA_DIR || '/tmp/podman-paas/proxy';

// Use high ports for rootless mode by default
const USE_HIGH_PORTS = process.env.PROXY_HIGH_PORTS === 'true' || process.getuid?.() !== 0;

// Proxy container configurations
const PROXY_IMAGES = {
  caddy: 'docker.io/caddy:2-alpine',
  nginx: 'docker.io/jc21/nginx-proxy-manager:latest',
  traefik: 'docker.io/traefik:v3.0',
};

const PROXY_DEFAULTS = {
  caddy: {
    name: 'caddy',
    adminPort: 2019,
    httpPort: 80,
    httpsPort: 443,
    configPath: '/etc/caddy',
    dataPath: '/data',
  },
  nginx: {
    name: 'nginx',
    httpPort: 80,
    httpsPort: 443,
    configPath: '/etc/nginx/conf.d',
  },
  traefik: {
    name: 'traefik',
    adminPort: 8080,
    httpPort: 80,
    httpsPort: 443,
    configPath: '/etc/traefik',
    dataPath: '/data',
  },
};

/**
 * Ensure proxy data directory exists
 */
function ensureDataDir(proxyType) {
  const dir = join(PROXY_DATA_DIR, proxyType);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Check if proxy container exists and is running
 */
export async function getProxyContainerStatus(proxyType) {
  const config = getProxyConfig();
  const containerName = config.containerName || PROXY_DEFAULTS[proxyType]?.name || proxyType;
  const httpPort = USE_HIGH_PORTS ? 8080 : 80;
  const httpsPort = USE_HIGH_PORTS ? 8443 : 443;
  
  try {
    const container = await getContainer(containerName);
    const state = container.State?.Status || container.state;
    
    // Get ports from labels if available
    const labels = container.Config?.Labels || container.Labels || {};
    const proxyTypeLabel = labels['paas.proxy_type'];
    
    return {
      exists: true,
      running: state === 'running',
      state,
      id: container.Id,
      name: containerName,
      type: proxyTypeLabel || proxyType,
      ports: {
        http: httpPort,
        https: httpsPort,
        admin: proxyType === 'traefik' ? 8080 : (proxyType === 'caddy' ? 2019 : null),
      },
    };
  } catch {
    return { 
      exists: false, 
      running: false, 
      name: containerName,
      ports: {
        http: httpPort,
        https: httpsPort,
      },
    };
  }
}

/**
 * Deploy Caddy as a container
 */
export async function deployCaddyContainer(options = {}) {
  const config = getProxyConfig();
  const containerName = options.containerName || config.containerName || 'caddy';
  const networkName = config.podmanNetwork || 'podman-paas';
  const dataDir = ensureDataDir('caddy');
  
  console.log(`[ProxyContainer] Deploying Caddy as container: ${containerName}`);
  
  // Pull image
  try {
    await pullImage(PROXY_IMAGES.caddy);
    console.log('[ProxyContainer] Caddy image pulled');
  } catch (err) {
    throw new Error(`Failed to pull Caddy image: ${err.message}`);
  }
  
  // Stop and remove existing container
  try {
    await stopContainer(containerName, 5);
    await removeContainer(containerName, true);
    console.log('[ProxyContainer] Cleaned up existing container');
  } catch (err) {
    console.log('[ProxyContainer] No existing container to clean up');
  }
  
  // Ensure network exists
  try {
    await ensureNetwork(networkName);
    console.log(`[ProxyContainer] Network ${networkName} ready`);
  } catch (err) {
    throw new Error(`Failed to ensure network: ${err.message}`);
  }
  
  // Create Caddyfile
  const caddyfile = `
{
  admin 0.0.0.0:2019
  auto_https off
}

:80 {
  respond "Caddy is running" 200
}
`;
  try {
    writeFileSync(join(dataDir, 'Caddyfile'), caddyfile);
    console.log('[ProxyContainer] Caddyfile created');
  } catch (err) {
    throw new Error(`Failed to create Caddyfile: ${err.message}`);
  }
  
  // Use unique high ports for rootless mode to avoid conflicts
  // Each proxy type gets a different port range
  const portOffset = { caddy: 0, nginx: 10, traefik: 20 }[proxyType] || 0;
  const httpPort = USE_HIGH_PORTS ? 8080 + portOffset : 80;
  const httpsPort = USE_HIGH_PORTS ? 8443 + portOffset : 443;
  const adminPort = 2019 + portOffset;
  
  console.log(`[ProxyContainer] Using host ports: HTTP=${httpPort}, HTTPS=${httpsPort}, Admin=${adminPort}`);
  
  // Create container
  let container;
  try {
    container = await createContainer({
      name: containerName,
      image: PROXY_IMAGES.caddy,
      portmappings: [
        { container_port: 80, host_port: httpPort, protocol: 'tcp' },
        { container_port: 443, host_port: httpsPort, protocol: 'tcp' },
        { container_port: 2019, host_port: adminPort, protocol: 'tcp' },
      ],
      network_mode: `bridge:${networkName}`,
      restart_policy: 'unless-stopped',
      labels: {
        'paas.proxy': 'true',
        'paas.proxy_type': 'caddy',
        'paas.managed': 'true',
      },
    });
    console.log(`[ProxyContainer] Container created: ${container.Id?.substring(0, 12)}`);
  } catch (err) {
    throw new Error(`Failed to create container: ${err.message}`);
  }
  
  // Start container
  try {
    await startContainer(containerName);
    console.log(`[ProxyContainer] Caddy container started`);
  } catch (err) {
    throw new Error(`Failed to start container: ${err.message}`);
  }
  
  // Wait for Caddy to be ready
  try {
    await waitForCaddy(containerName);
  } catch (err) {
    console.warn('[ProxyContainer] Caddy not responding yet, continuing anyway');
  }
  
  return {
    containerId: container.Id,
    name: containerName,
    adminUrl: `http://${containerName}:2019`,
    ports: {
      http: httpPort,
      https: httpsPort,
      admin: adminPort,
    },
  };
}

/**
 * Deploy Nginx as a container
 */
export async function deployNginxContainer(options = {}) {
  const config = getProxyConfig();
  const containerName = options.containerName || config.containerName || 'nginx';
  const networkName = config.podmanNetwork || 'podman-paas';
  const dataDir = ensureDataDir('nginx');
  
  console.log(`[ProxyContainer] Deploying Nginx as container: ${containerName}`);
  
  // Pull image
  try {
    await pullImage(PROXY_IMAGES.nginx);
    console.log('[ProxyContainer] Nginx image pulled');
  } catch (err) {
    throw new Error(`Failed to pull Nginx image: ${err.message}`);
  }
  
  // Stop and remove existing container
  try {
    await stopContainer(containerName, 5);
    await removeContainer(containerName, true);
  } catch {}
  
  // Ensure network exists
  await ensureNetwork(networkName);
  
  // Create config directory structure
  const confDir = join(dataDir, 'conf.d');
  if (!existsSync(confDir)) {
    mkdirSync(confDir, { recursive: true });
  }
  
  // Create default nginx config
  const nginxConf = `
server {
    listen 80;
    server_name localhost;
    location / {
        return 200 "Nginx is running\\n";
        add_header Content-Type text/plain;
    }
}
`;
  writeFileSync(join(confDir, 'default.conf'), nginxConf);
  
  // Create main nginx.conf
  const mainConf = `
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    log_format main '$remote_addr - $remote_user [$time_local] "$request" ' '$status $body_bytes_sent "$http_referer" ' '"$http_user_agent" "$http_x_forwarded_for"';
    access_log /var/log/nginx/access.log main;
    sendfile on;
    keepalive_timeout 65;
    include /etc/nginx/conf.d/*.conf;
}
`;
  writeFileSync(join(dataDir, 'nginx.conf'), mainConf);
  
  // Use high ports for rootless mode (unique ports for nginx)
  const httpPort = USE_HIGH_PORTS ? 8090 : 80;
  const httpsPort = USE_HIGH_PORTS ? 8453 : 443;
  
  console.log(`[ProxyContainer] Using host ports: HTTP=${httpPort}, HTTPS=${httpsPort}`);
  
  // Create container
  const container = await createContainer({
    name: containerName,
    image: PROXY_IMAGES.nginx,
    portmappings: [
      { container_port: 80, host_port: httpPort, protocol: 'tcp' },
      { container_port: 443, host_port: httpsPort, protocol: 'tcp' },
      { container_port: 81, host_port: USE_HIGH_PORTS ? 8091 : 81, protocol: 'tcp' }, // NPM admin
    ],
    network_mode: `bridge:${networkName}`,
    restart_policy: 'unless-stopped',
    labels: {
      'paas.proxy': 'true',
      'paas.proxy_type': 'nginx',
      'paas.managed': 'true',
    },
  });
  
  await startContainer(containerName);
  console.log(`[ProxyContainer] Nginx container started: ${container.Id?.substring(0, 12)}`);
  
  return {
    containerId: container.Id,
    name: containerName,
    configPath: confDir,
    ports: {
      http: httpPort,
      https: httpsPort,
    },
  };
}

/**
 * Deploy Traefik as a container
 */
export async function deployTraefikContainer(options = {}) {
  const config = getProxyConfig();
  const containerName = options.containerName || config.containerName || 'traefik';
  const networkName = config.podmanNetwork || 'podman-paas';
  const dataDir = ensureDataDir('traefik');
  
  console.log(`[ProxyContainer] Deploying Traefik as container: ${containerName}`);
  
  // Pull image
  try {
    await pullImage(PROXY_IMAGES.traefik);
    console.log('[ProxyContainer] Traefik image pulled');
  } catch (err) {
    throw new Error(`Failed to pull Traefik image: ${err.message}`);
  }
  
  // Stop and remove existing container
  try {
    await stopContainer(containerName, 5);
    await removeContainer(containerName, true);
  } catch {}
  
  // Ensure network exists
  await ensureNetwork(networkName);
  
  // Create dynamic config directory
  const dynamicDir = join(dataDir, 'dynamic');
  if (!existsSync(dynamicDir)) {
    mkdirSync(dynamicDir, { recursive: true });
  }
  
  // Create traefik.yml static config
  const traefikYml = `
api:
  insecure: true
  dashboard: true

entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"

providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true

log:
  level: INFO
`;
  writeFileSync(join(dataDir, 'traefik.yml'), traefikYml);
  
  // Use high ports for rootless mode (unique ports for traefik)
  // Note: Traefik uses 8080 internally for admin, so we use 8081 for HTTP to avoid confusion
  const httpPort = USE_HIGH_PORTS ? 8081 : 80;
  const httpsPort = USE_HIGH_PORTS ? 8444 : 443;
  const adminPort = USE_HIGH_PORTS ? 8080 : 8080;
  
  console.log(`[ProxyContainer] Using host ports: HTTP=${httpPort}, HTTPS=${httpsPort}, Admin=${adminPort}`);
  
  // Create container
  const container = await createContainer({
    name: containerName,
    image: PROXY_IMAGES.traefik,
    command: ['--api.insecure=true', '--providers.docker=true', '--entrypoints.web.address=:80', '--api.dashboard=true'],
    portmappings: [
      { container_port: 80, host_port: httpPort, protocol: 'tcp' },
      { container_port: 443, host_port: httpsPort, protocol: 'tcp' },
      { container_port: 8080, host_port: adminPort, protocol: 'tcp' },
    ],
    network_mode: `bridge:${networkName}`,
    restart_policy: 'unless-stopped',
    labels: {
      'paas.proxy': 'true',
      'paas.proxy_type': 'traefik',
      'paas.managed': 'true',
    },
  });
  
  await startContainer(containerName);
  console.log(`[ProxyContainer] Traefik container started: ${container.Id?.substring(0, 12)}`);
  
  return {
    containerId: container.Id,
    name: containerName,
    adminUrl: `http://${containerName}:${adminPort}`,
    configPath: dynamicDir,
    ports: {
      http: httpPort,
      https: httpsPort,
      admin: adminPort,
    },
  };
}

/**
 * Deploy proxy container based on type
 */
export async function deployProxyContainer(proxyType, options = {}) {
  switch (proxyType) {
    case 'caddy':
      return deployCaddyContainer(options);
    case 'nginx':
      return deployNginxContainer(options);
    case 'traefik':
      return deployTraefikContainer(options);
    default:
      throw new Error(`Unsupported proxy type for container deployment: ${proxyType}`);
  }
}

/**
 * Wait for Caddy to be ready
 */
async function waitForCaddy(containerName, maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`http://${containerName}:2019/config/`, { 
        signal: AbortSignal.timeout(1000) 
      });
      if (res.ok) {
        console.log('[ProxyContainer] Caddy is ready');
        return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Caddy failed to become ready within timeout');
}

/**
 * Start proxy container if not running
 */
export async function startProxyContainer(proxyType) {
  const config = getProxyConfig();
  const containerName = config.containerName || PROXY_DEFAULTS[proxyType]?.name || proxyType;
  
  try {
    const status = await getProxyContainerStatus(proxyType);
    if (status.running) {
      return { success: true, message: 'Container already running', status };
    }
    
    await startContainer(containerName);
    console.log(`[ProxyContainer] Started ${proxyType} container: ${containerName}`);
    return { success: true, message: 'Container started', status: await getProxyContainerStatus(proxyType) };
  } catch (err) {
    console.error(`[ProxyContainer] Failed to start ${proxyType} container:`, err.message);
    throw err;
  }
}

/**
 * Stop proxy container
 */
export async function stopProxyContainer(proxyType) {
  const config = getProxyConfig();
  const containerName = config.containerName || PROXY_DEFAULTS[proxyType]?.name || proxyType;
  
  try {
    await stopContainer(containerName, 10);
    console.log(`[ProxyContainer] Stopped ${proxyType} container: ${containerName}`);
    return { success: true, message: 'Container stopped', status: await getProxyContainerStatus(proxyType) };
  } catch (err) {
    console.error(`[ProxyContainer] Failed to stop ${proxyType} container:`, err.message);
    throw err;
  }
}

/**
 * Get all managed proxy containers
 */
export async function listProxyContainers() {
  const containers = await listContainers(true);
  return containers.filter(c => {
    const labels = c.Labels || {};
    return labels['paas.proxy'] === 'true';
  });
}

/**
 * Stop and remove proxy container
 */
export async function removeProxyContainer(proxyType) {
  const config = getProxyConfig();
  const containerName = config.containerName || PROXY_DEFAULTS[proxyType]?.name || proxyType;
  
  try {
    // Force stop with shorter timeout
    console.log(`[ProxyContainer] Stopping ${containerName}...`);
    await stopContainer(containerName, 2).catch(() => {});
    
    // Wait a moment for port release
    await new Promise(r => setTimeout(r, 1000));
    
    // Force remove
    console.log(`[ProxyContainer] Removing ${containerName}...`);
    await removeContainer(containerName, true);
    
    // Wait for complete cleanup
    await new Promise(r => setTimeout(r, 1000));
    
    console.log(`[ProxyContainer] Removed ${proxyType} container: ${containerName}`);
    return true;
  } catch (err) {
    console.error(`[ProxyContainer] Failed to remove ${proxyType} container:`, err.message);
    return false;
  }
}

/**
 * Restart proxy container
 */
export async function restartProxyContainer(proxyType) {
  const config = getProxyConfig();
  const containerName = config.containerName || PROXY_DEFAULTS[proxyType]?.name || proxyType;
  
  try {
    await restartContainer(containerName);
    console.log(`[ProxyContainer] Restarted ${proxyType} container: ${containerName}`);
    return true;
  } catch (err) {
    console.error(`[ProxyContainer] Failed to restart ${proxyType} container:`, err.message);
    return false;
  }
}

/**
 * Generate docker-compose for proxy container
 * Useful for users who want to manage proxy separately
 */
export function generateProxyCompose(proxyType, options = {}) {
  const config = getProxyConfig();
  const containerName = options.containerName || config.containerName || PROXY_DEFAULTS[proxyType]?.name || proxyType;
  const networkName = config.podmanNetwork || 'podman-paas';
  
  const compose = {
    version: '3.8',
    services: {
      [containerName]: {
        image: PROXY_IMAGES[proxyType],
        container_name: containerName,
        restart: 'unless-stopped',
        networks: [networkName],
        labels: {
          'paas.proxy': 'true',
          'paas.proxy_type': proxyType,
          'paas.managed': 'true',
        },
      },
    },
    networks: {
      [networkName]: {
        external: true,
      },
    },
  };
  
  // Add proxy-specific configuration
  switch (proxyType) {
    case 'caddy':
      compose.services[containerName].ports = ['80:80', '443:443', '2019:2019'];
      compose.services[containerName].volumes = [
        `./caddy/Caddyfile:/etc/caddy/Caddyfile:Z`,
        `./caddy/data:/data:Z`,
        `./caddy/config:/config:Z`,
      ];
      break;
    case 'nginx':
      compose.services[containerName].ports = ['80:80', '443:443'];
      compose.services[containerName].volumes = [
        `./nginx/nginx.conf:/etc/nginx/nginx.conf:Z`,
        `./nginx/conf.d:/etc/nginx/conf.d:Z`,
      ];
      break;
    case 'traefik':
      compose.services[containerName].ports = ['80:80', '443:443', '8080:8080'];
      compose.services[containerName].volumes = [
        `./traefik/traefik.yml:/etc/traefik/traefik.yml:Z`,
        `./traefik/dynamic:/etc/traefik/dynamic:Z`,
      ];
      compose.services[containerName].command = ['--configFile=/etc/traefik/traefik.yml'];
      break;
  }
  
  return compose;
}
