/**
 * Proxy Configuration File Manager
 * 
 * Manages reading and writing configuration files for various reverse proxies.
 * Supports Traefik (YAML), Nginx (conf), and Caddy (Caddyfile/JSON).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { getProxyConfig } from './proxy-factory.js';

// Base paths for proxy configurations
const PROXY_DATA_DIR = process.env.PROXY_DATA_DIR || '/tmp/podman-paas/proxy';

// Configuration file paths and formats per proxy type
const PROXY_CONFIG_FORMATS = {
  traefik: {
    dynamicDir: join(PROXY_DATA_DIR, 'traefik', 'dynamic'),
    staticFile: join(PROXY_DATA_DIR, 'traefik', 'traefik.yml'),
    format: 'yaml',
    extension: '.yml',
    commentChar: '#',
    defaultConfig: `http:
  routers:
    # Add your routers here
  
  services:
    # Add your services here
  
  middlewares:
    # Add your middlewares here
    
  # Enable plugins here
  # plugins:
  #   plugin-name:
  #     moduleName: github.com/author/plugin
  #     version: v1.0.0
`,
  },
  nginx: {
    confDir: join(PROXY_DATA_DIR, 'nginx', 'conf.d'),
    mainFile: join(PROXY_DATA_DIR, 'nginx', 'nginx.conf'),
    format: 'nginx',
    extension: '.conf',
    commentChar: '#',
    defaultConfig: `server {
    listen 80;
    server_name localhost;
    
    location / {
        proxy_pass http://upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`,
  },
  caddy: {
    configDir: join(PROXY_DATA_DIR, 'caddy'),
    mainFile: join(PROXY_DATA_DIR, 'caddy', 'Caddyfile'),
    format: 'caddyfile',
    extension: '',
    commentChar: '#',
    defaultConfig: `# Caddyfile configuration
{
    auto_https off
    admin off
}

# Global options
:80 {
    respond "Caddy is running"
}
`,
  },
};

/**
 * Ensure configuration directory exists
 */
function ensureConfigDir(proxyType) {
  const config = PROXY_CONFIG_FORMATS[proxyType];
  if (!config) throw new Error(`Unknown proxy type: ${proxyType}`);
  
  const dir = config.dynamicDir || config.confDir || config.configDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get the configuration directory path for a proxy type
 */
export function getConfigDirectory(proxyType) {
  const config = PROXY_CONFIG_FORMATS[proxyType];
  if (!config) return null;
  
  return config.dynamicDir || config.confDir || config.configDir;
}

/**
 * List all configuration files for a proxy type
 */
export function listConfigFiles(proxyType) {
  const config = PROXY_CONFIG_FORMATS[proxyType];
  if (!config) throw new Error(`Unknown proxy type: ${proxyType}`);
  
  const dir = config.dynamicDir || config.confDir || config.configDir;
  if (!existsSync(dir)) return [];
  
  const files = readdirSync(dir)
    .filter(f => !f.startsWith('.')) // Skip hidden files
    .filter(f => {
      // Only include files with the correct extension
      if (proxyType === 'caddy') return f === 'Caddyfile' || f.endsWith('.caddy');
      return f.endsWith(config.extension);
    })
    .map(filename => {
      const filepath = join(dir, filename);
      const stat = { size: 0, mtime: null };
      try {
        const fs = require('fs');
        const s = fs.statSync(filepath);
        stat.size = s.size;
        stat.mtime = s.mtime;
      } catch {}
      
      return {
        name: filename,
        path: filepath,
        size: stat.size,
        modified: stat.mtime,
        isMain: filename === 'traefik.yml' || filename === 'nginx.conf' || filename === 'Caddyfile',
      };
    });
  
  return files;
}

/**
 * Read a configuration file
 */
export function readConfigFile(proxyType, filename) {
  const config = PROXY_CONFIG_FORMATS[proxyType];
  if (!config) throw new Error(`Unknown proxy type: ${proxyType}`);
  
  // Security: prevent directory traversal
  if (filename.includes('..') || filename.includes('/')) {
    throw new Error('Invalid filename');
  }
  
  const dir = config.dynamicDir || config.confDir || config.configDir;
  const filepath = join(dir, filename);
  
  // Ensure file is within the config directory
  if (!filepath.startsWith(dir)) {
    throw new Error('Invalid file path');
  }
  
  if (!existsSync(filepath)) {
    // Return default config if it's a main config file
    if (filename === 'traefik.yml' || filename === 'nginx.conf' || filename === 'Caddyfile') {
      return { content: config.defaultConfig, exists: false, isDefault: true };
    }
    throw new Error('File not found');
  }
  
  const content = readFileSync(filepath, 'utf8');
  return { content, exists: true, isDefault: false };
}

/**
 * Write a configuration file
 */
export function writeConfigFile(proxyType, filename, content) {
  const config = PROXY_CONFIG_FORMATS[proxyType];
  if (!config) throw new Error(`Unknown proxy type: ${proxyType}`);
  
  // Security: prevent directory traversal
  if (filename.includes('..') || filename.includes('/')) {
    throw new Error('Invalid filename');
  }
  
  // Ensure directory exists
  ensureConfigDir(proxyType);
  
  const dir = config.dynamicDir || config.confDir || config.configDir;
  const filepath = join(dir, filename);
  
  // Ensure file is within the config directory
  if (!filepath.startsWith(dir)) {
    throw new Error('Invalid file path');
  }
  
  // Validate content based on proxy type
  const validation = validateConfig(proxyType, content);
  if (!validation.valid) {
    throw new Error(`Invalid configuration: ${validation.error}`);
  }
  
  writeFileSync(filepath, content, 'utf8');
  
  return {
    success: true,
    path: filepath,
    size: Buffer.byteLength(content, 'utf8'),
  };
}

/**
 * Delete a configuration file
 */
export function deleteConfigFile(proxyType, filename) {
  const config = PROXY_CONFIG_FORMATS[proxyType];
  if (!config) throw new Error(`Unknown proxy type: ${proxyType}`);
  
  // Security: prevent directory traversal
  if (filename.includes('..') || filename.includes('/')) {
    throw new Error('Invalid filename');
  }
  
  // Prevent deletion of main config files
  if (filename === 'traefik.yml' || filename === 'nginx.conf' || filename === 'Caddyfile') {
    throw new Error('Cannot delete main configuration file');
  }
  
  const dir = config.dynamicDir || config.confDir || config.configDir;
  const filepath = join(dir, filename);
  
  if (!existsSync(filepath)) {
    throw new Error('File not found');
  }
  
  unlinkSync(filepath);
  return { success: true };
}

/**
 * Validate configuration content
 */
function validateConfig(proxyType, content) {
  if (!content || content.trim().length === 0) {
    return { valid: false, error: 'Configuration cannot be empty' };
  }
  
  if (content.length > 10 * 1024 * 1024) { // 10MB limit
    return { valid: false, error: 'Configuration file too large (max 10MB)' };
  }
  
  try {
    switch (proxyType) {
      case 'traefik':
        // Basic YAML validation for Traefik
        // Check for basic YAML structure
        if (!content.includes('http:') && !content.includes('tcp:') && !content.includes('udp:')) {
          return { valid: true, warning: 'Config may be missing required sections (http/tcp/udp)' };
        }
        break;
        
      case 'nginx':
        // Basic nginx config validation
        const openBraces = (content.match(/{/g) || []).length;
        const closeBraces = (content.match(/}/g) || []).length;
        if (openBraces !== closeBraces) {
          return { valid: false, error: 'Unmatched braces in nginx configuration' };
        }
        break;
        
      case 'caddy':
        // Caddyfile validation is very permissive
        // Just check it's not malformed JSON if using JSON format
        if (content.trim().startsWith('{')) {
          JSON.parse(content);
        }
        break;
    }
    
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Get available configuration templates
 */
export function getConfigTemplates(proxyType) {
  const templates = {
    traefik: [
      {
        name: 'Basic Router',
        description: 'Simple HTTP router with load balancer',
        content: `http:
  routers:
    my-router:
      rule: Host(\`example.com\`)
      service: my-service
      entryPoints:
        - web
  
  services:
    my-service:
      loadBalancer:
        servers:
          - url: "http://localhost:8080"
`,
      },
      {
        name: 'HTTPS with Auto SSL',
        description: 'Router with automatic HTTPS certificate',
        content: `http:
  routers:
    my-router-secure:
      rule: Host(\`example.com\`)
      service: my-service
      entryPoints:
        - websecure
      tls:
        certResolver: default
  
  services:
    my-service:
      loadBalancer:
        servers:
          - url: "http://localhost:8080"
`,
      },
      {
        name: 'Rate Limit Middleware',
        description: 'Add rate limiting to your routes',
        content: `http:
  middlewares:
    rate-limit:
      rateLimit:
        average: 100
        burst: 50
  
  routers:
    my-router:
      rule: Host(\`example.com\`)
      service: my-service
      middlewares:
        - rate-limit
      entryPoints:
        - web
`,
      },
      {
        name: 'Basic Auth',
        description: 'HTTP Basic Authentication',
        content: `http:
  middlewares:
    basic-auth:
      basicAuth:
        users:
          - "admin:$apr1$H6uskkkW$IgXLP6ewTrSuBkTrqE8wj/"
  
  routers:
    my-router:
      rule: Host(\`example.com\`)
      service: my-service
      middlewares:
        - basic-auth
      entryPoints:
        - web
`,
      },
      {
        name: 'Plugin: Forward Auth',
        description: 'Forward authentication to external service',
        content: `http:
  middlewares:
    forward-auth:
      forwardAuth:
        address: "http://auth-service:8080"
        authResponseHeaders:
          - X-User
  
  routers:
    my-router:
      rule: Host(\`example.com\`)
      service: my-service
      middlewares:
        - forward-auth
`,
      },
      {
        name: 'Plugin Configuration',
        description: 'Enable Traefik Pilot plugins',
        content: `# Add to your static Traefik configuration (traefik.yml)
experimental:
  plugins:
    my-plugin:
      moduleName: github.com/traefik/plugin-provider-demo
      version: v0.1.0

# Then use in dynamic configuration
http:
  middlewares:
    my-plugin:
      plugin:
        my-plugin:
          # plugin options
`,
      },
    ],
    nginx: [
      {
        name: 'Basic Server',
        description: 'Simple reverse proxy server',
        content: `server {
    listen 80;
    server_name example.com;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
`,
      },
      {
        name: 'HTTPS Server',
        description: 'SSL/TLS enabled server',
        content: `server {
    listen 443 ssl http2;
    server_name example.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`,
      },
      {
        name: 'Rate Limiting',
        description: 'Basic rate limiting configuration',
        content: `limit_req_zone $binary_remote_addr zone=one:10m rate=10r/s;

server {
    listen 80;
    server_name example.com;
    
    location / {
        limit_req zone=one burst=20 nodelay;
        proxy_pass http://localhost:8080;
    }
}
`,
      },
    ],
    caddy: [
      {
        name: 'Basic Site',
        description: 'Simple reverse proxy',
        content: `example.com {
    reverse_proxy localhost:8080
}
`,
      },
      {
        name: 'HTTPS with Auto SSL',
        description: 'Automatic HTTPS (default in Caddy)',
        content: `example.com {
    reverse_proxy localhost:8080
    
    # TLS is automatic by default
    # You can customize:
    tls your@email.com
}
`,
      },
      {
        name: 'Basic Auth',
        description: 'HTTP Basic Authentication',
        content: `example.com {
    basicauth {
        admin $2a$14$Zkx19XLiW6VYouLHR5NmfOFU0z2GTNmpkT/5qqR7hx4IjWJPDhjvG
    }
    
    reverse_proxy localhost:8080
}
`,
      },
    ],
  };
  
  return templates[proxyType] || [];
}

/**
 * Get the main configuration file content for a proxy
 */
export function getMainConfig(proxyType) {
  const config = PROXY_CONFIG_FORMATS[proxyType];
  if (!config) throw new Error(`Unknown proxy type: ${proxyType}`);
  
  const mainFile = config.staticFile || config.mainFile;
  
  if (!existsSync(mainFile)) {
    return {
      content: config.defaultConfig,
      exists: false,
      path: mainFile,
    };
  }
  
  return {
    content: readFileSync(mainFile, 'utf8'),
    exists: true,
    path: mainFile,
  };
}

/**
 * Write the main configuration file
 */
export function writeMainConfig(proxyType, content) {
  const config = PROXY_CONFIG_FORMATS[proxyType];
  if (!config) throw new Error(`Unknown proxy type: ${proxyType}`);
  
  const mainFile = config.staticFile || config.mainFile;
  
  // Ensure directory exists
  const dir = dirname(mainFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  // Validate
  const validation = validateConfig(proxyType, content);
  if (!validation.valid) {
    throw new Error(`Invalid configuration: ${validation.error}`);
  }
  
  writeFileSync(mainFile, content, 'utf8');
  
  return {
    success: true,
    path: mainFile,
  };
}
