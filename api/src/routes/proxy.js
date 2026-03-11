/**
 * Reverse Proxy Management Routes
 */

import { 
  getProxyConfig, 
  updateProxyConfig, 
  getProxyStatus, 
  listProxyRoutes,
  getAvailableProxyTypes,
  getProxyModes,
  isProxyAvailable,
  initProxySystem,
} from '../services/proxy/proxy-factory.js';
import {
  deployProxyContainer,
  getProxyContainerStatus,
  removeProxyContainer,
  restartProxyContainer,
  startProxyContainer,
  stopProxyContainer,
  listProxyContainers,
  generateProxyCompose,
} from '../services/proxy/container-manager.js';

export default async function proxyRoutes(app) {
  
  // ── Get current proxy configuration ─────────────────────────────────────────
  app.get('/config', { onRequest: [app.authenticate] }, async () => {
    return getProxyConfig();
  });

  // ── Get available proxy types ───────────────────────────────────────────────
  app.get('/types', { onRequest: [app.authenticate] }, async () => {
    return getAvailableProxyTypes();
  });

  // ── Get available proxy deployment modes ────────────────────────────────────
  app.get('/modes', { onRequest: [app.authenticate] }, async () => {
    return getProxyModes();
  });

  // ── Get proxy status ────────────────────────────────────────────────────────
  app.get('/status', { onRequest: [app.authenticate] }, async () => {
    return getProxyStatus();
  });

  // ── Update proxy configuration ──────────────────────────────────────────────
  app.patch('/config', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['caddy', 'nginx', 'traefik', 'custom', 'none'] },
          adminUrl: { type: 'string' },
          configPath: { type: 'string' },
          customTemplate: { type: 'string' },
          networkName: { type: 'string' },
          domainSuffix: { type: 'string' },
          autoSsl: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const updates = req.body;
    const config = updateProxyConfig(updates);
    
    // If proxy type changed, reinitialize
    if (updates.type) {
      await initProxySystem();
    }
    
    return config;
  });

  // ── Test proxy connection ───────────────────────────────────────────────────
  app.post('/test', { onRequest: [app.authenticate] }, async () => {
    const available = await isProxyAvailable();
    const status = await getProxyStatus();
    return { available, ...status };
  });

  // ── List all proxy routes ───────────────────────────────────────────────────
  app.get('/routes', { onRequest: [app.authenticate] }, async () => {
    return listProxyRoutes();
  });

  // ── Get proxy container status ──────────────────────────────────────────────
  app.get('/container/status', { onRequest: [app.authenticate] }, async () => {
    const config = getProxyConfig();
    if (config.type === 'none' || config.type === 'custom') {
      return { exists: false, message: 'Proxy type does not support containers' };
    }
    return getProxyContainerStatus(config.type);
  });

  // ── Deploy proxy container ──────────────────────────────────────────────────
  app.post('/container/deploy', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          containerName: { type: 'string' },
          force: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const config = getProxyConfig();
    console.log('[Proxy] Deploying container with config:', { type: config.type, mode: config.mode, containerName: config.containerName });
    if (config.type === 'none' || config.type === 'custom') {
      return reply.code(400).send({ error: `Cannot deploy container for proxy type: ${config.type}` });
    }
    
    // Check if already exists
    const status = await getProxyContainerStatus(config.type);
    if (status.exists && !req.body.force) {
      return reply.code(409).send({ 
        error: 'Proxy container already exists. Use force: true to recreate.',
        status 
      });
    }
    
    try {
      const result = await deployProxyContainer(config.type, {
        containerName: req.body.containerName || config.containerName,
      });
      
      // Update config with container settings
      updateProxyConfig({
        mode: 'container',
        containerName: result.name,
        adminUrl: result.adminUrl || `http://${result.name}:${config.type === 'traefik' ? '8080' : '2019'}`,
      });
      
      return { success: true, ...result };
    } catch (err) {
      console.error('[Proxy] Failed to deploy container:', err);
      return reply.code(500).send({ 
        error: err.message,
        details: err.stack 
      });
    }
  });

  // ── Remove proxy container ──────────────────────────────────────────────────
  app.delete('/container', { onRequest: [app.authenticate] }, async (req, reply) => {
    const config = getProxyConfig();
    if (config.type === 'none' || config.type === 'custom') {
      return reply.code(400).send({ error: 'Cannot remove container for this proxy type' });
    }
    
    const success = await removeProxyContainer(config.type);
    if (success) {
      return { success: true, message: 'Proxy container removed' };
    }
    return reply.code(500).send({ error: 'Failed to remove proxy container' });
  });

  // ── Restart proxy container ─────────────────────────────────────────────────
  app.post('/container/restart', { onRequest: [app.authenticate] }, async (req, reply) => {
    const config = getProxyConfig();
    if (config.type === 'none' || config.type === 'custom') {
      return reply.code(400).send({ error: 'Cannot restart container for this proxy type' });
    }
    
    const success = await restartProxyContainer(config.type);
    if (success) {
      return { success: true, message: 'Proxy container restarted' };
    }
    return reply.code(500).send({ error: 'Failed to restart proxy container' });
  });

  // ── Start proxy container ───────────────────────────────────────────────────
  app.post('/container/start', { onRequest: [app.authenticate] }, async (req, reply) => {
    const config = getProxyConfig();
    if (config.type === 'none' || config.type === 'custom') {
      return reply.code(400).send({ error: 'Cannot start container for this proxy type' });
    }
    
    try {
      const result = await startProxyContainer(config.type);
      return result;
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── Stop proxy container ────────────────────────────────────────────────────
  app.post('/container/stop', { onRequest: [app.authenticate] }, async (req, reply) => {
    const config = getProxyConfig();
    if (config.type === 'none' || config.type === 'custom') {
      return reply.code(400).send({ error: 'Cannot stop container for this proxy type' });
    }
    
    try {
      const result = await stopProxyContainer(config.type);
      return result;
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── List all managed proxy containers ───────────────────────────────────────
  app.get('/containers', { onRequest: [app.authenticate] }, async () => {
    return listProxyContainers();
  });

  // ── Generate proxy compose file ─────────────────────────────────────────────
  app.get('/compose', { onRequest: [app.authenticate] }, async (req, reply) => {
    const config = getProxyConfig();
    if (config.type === 'none' || config.type === 'custom') {
      return reply.code(400).send({ error: 'Cannot generate compose for this proxy type' });
    }
    
    const compose = generateProxyCompose(config.type, {
      containerName: config.containerName,
    });
    
    return { compose };
  });

  // ── Validate proxy template (nginx only) ────────────────────────────────────
  app.post('/validate-template', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['template'],
        properties: {
          template: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { template } = req.body;
    const proxyType = getProxyConfig().type;
    
    if (proxyType !== 'nginx') {
      return reply.code(400).send({ 
        error: 'Template validation only available for Nginx proxy' 
      });
    }
    
    // Import nginx implementation for validation
    const { initNginx } = await import('../services/proxy/nginx-impl.js');
    const nginx = initNginx();
    
    if (!nginx.validateTemplate) {
      return reply.code(400).send({ error: 'Template validation not supported' });
    }
    
    return nginx.validateTemplate(template);
  });

  // ── Get proxy quick-start guide ─────────────────────────────────────────────
  app.get('/guide/:type', { onRequest: [app.authenticate] }, async (req) => {
    const { type } = req.params;
    
    const guides = {
      caddy: {
        name: 'Caddy',
        description: 'Automatic HTTPS with zero configuration',
        install: {
          fedora: 'sudo dnf install caddy',
          ubuntu: 'sudo apt install caddy',
          binary: 'curl -1sLf \'https://caddyserver.com/install.sh\' | sudo bash',
        },
        setup: [
          'Enable and start Caddy: sudo systemctl enable --now caddy',
          'Verify admin API: curl http://localhost:2019/config/',
          'Default admin URL: http://localhost:2019',
        ],
        notes: [
          'Caddy automatically handles HTTPS certificates',
          'Configuration is done via REST API - no config files needed',
          'Podman PaaS will automatically create routes',
        ],
      },
      nginx: {
        name: 'Nginx',
        description: 'High-performance web server with file-based configuration',
        install: {
          fedora: 'sudo dnf install nginx',
          ubuntu: 'sudo apt install nginx',
          arch: 'sudo pacman -S nginx',
        },
        setup: [
          'Enable and start Nginx: sudo systemctl enable --now nginx',
          'Create config directory: sudo mkdir -p /etc/nginx/conf.d',
          'Ensure Podman PaaS can write to config directory',
          'Add to nginx.conf: include /etc/nginx/conf.d/*.conf;',
        ],
        notes: [
          'Podman PaaS writes config files to /etc/nginx/conf.d/',
          'You may need to adjust permissions: sudo chown $USER /etc/nginx/conf.d',
          'SSL certificates must be configured manually or use certbot',
        ],
      },
      traefik: {
        name: 'Traefik',
        description: 'Cloud-native edge router with automatic service discovery',
        install: {
          binary: 'Download from https://github.com/traefik/traefik/releases',
          docker: 'docker run -d -p 80:80 -p 8080:8080 traefik:v3.0',
          podman: 'podman run -d -p 80:80 -p 8080:8080 traefik:v3.0',
        },
        setup: [
          'Create config directory: sudo mkdir -p /etc/traefik/dynamic',
          'Start Traefik with API enabled: --api.insecure=true',
          'Default dashboard: http://localhost:8080/dashboard/',
        ],
        notes: [
          'Traefik can also use container labels for routing',
          'Podman PaaS writes dynamic configs to /etc/traefik/dynamic/',
          'Supports Let\'s Encrypt for automatic HTTPS',
        ],
      },
      custom: {
        name: 'Custom / External',
        description: 'Use your own reverse proxy setup',
        setup: [
          'Disable automatic proxy management in Podman PaaS',
          'Configure your proxy manually to point to app ports',
          'Apps will be accessible on assigned ports',
        ],
        notes: [
          'Podman PaaS will not manage any proxy configuration',
          'You must manually configure routes for each app',
          'Check app settings for assigned port numbers',
        ],
      },
      none: {
        name: 'Disabled',
        description: 'No reverse proxy - direct port access only',
        setup: [
          'Apps will be accessible via assigned ports only',
          'No automatic domain routing',
        ],
        notes: [
          'Useful for development or when running behind external load balancer',
          'Each app gets a random available port',
        ],
      },
    };
    
    return guides[type] || { error: 'Unknown proxy type' };
  });
}
