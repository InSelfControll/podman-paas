/**
 * Nginx Reverse Proxy Implementation
 * 
 * Manages Nginx configuration files for reverse proxy routes.
 * Requires write access to Nginx configuration directory.
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getDB } from '../../db/database.js';
import { execAsync } from '../../utils/exec.js';

function getConfigPath() {
  const db = getDB();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'proxy_config_path'").get();
  return row?.value || '/etc/nginx/conf.d';
}

function getDomainSuffix() {
  const db = getDB();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'domain_suffix'").get();
  return row?.value || '.localhost';
}

function getCustomTemplate() {
  const db = getDB();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'proxy_custom_template'").get();
  return row?.value || null;
}

function getConfigFilePath(appName) {
  return join(getConfigPath(), `podpaas-${appName}.conf`);
}

/**
 * Default Nginx server block template
 */
const DEFAULT_TEMPLATE = `server {
    listen 80;
    listen [::]:80;
    server_name {{DOMAIN}};

    location / {
        proxy_pass http://{{UPSTREAM}};
        proxy_http_version 1.1;
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}`;

/**
 * SSL-enabled Nginx server block template
 */
const SSL_TEMPLATE = `server {
    listen 80;
    listen [::]:80;
    server_name {{DOMAIN}};
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name {{DOMAIN}};

    ssl_certificate {{SSL_CERT}};
    ssl_certificate_key {{SSL_KEY}};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass http://{{UPSTREAM}};
        proxy_http_version 1.1;
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}`;

function generateConfig(appName, domain, upstream, useSsl = false, sslCert = null, sslKey = null) {
  const template = getCustomTemplate() || (useSsl ? SSL_TEMPLATE : DEFAULT_TEMPLATE);
  
  let config = template
    .replace(/\{\{DOMAIN\}\}/g, domain)
    .replace(/\{\{UPSTREAM\}\}/g, upstream)
    .replace(/\{\{PORT\}\}/g, upstream.split(':')[1] || '80')
    .replace(/\{\{APP_NAME\}\}/g, appName);
  
  if (useSsl && sslCert && sslKey) {
    config = config
      .replace(/\{\{SSL_CERT\}\}/g, sslCert)
      .replace(/\{\{SSL_KEY\}\}/g, sslKey);
  }
  
  return config;
}

async function testAndReload() {
  try {
    // Test nginx configuration
    await execAsync('nginx -t');
    // Reload nginx
    await execAsync('nginx -s reload');
    return true;
  } catch (err) {
    throw new Error(`Nginx reload failed: ${err.message}`);
  }
}

export function initNginx() {
  return {
    /**
     * Check if Nginx is available and configuration directory is writable
     */
    async isAvailable() {
      try {
        await execAsync('nginx -v');
        const configPath = getConfigPath();
        // Check if directory exists and is writable
        if (!existsSync(configPath)) {
          return false;
        }
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Get Nginx status
     */
    async getStatus() {
      try {
        const versionRes = await execAsync('nginx -v').catch(() => ({ stdout: 'unknown' }));
        const version = versionRes.stdout?.match(/nginx\/([\d.]+)/)?.[1] || 'unknown';
        
        const configPath = getConfigPath();
        let routeCount = 0;
        
        if (existsSync(configPath)) {
          routeCount = readdirSync(configPath)
            .filter(f => f.startsWith('podpaas-') && f.endsWith('.conf'))
            .length;
        }
        
        return {
          available: true,
          details: {
            version,
            routeCount,
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
      const config = generateConfig(
        appName, 
        host, 
        upstream, 
        options.autoSsl,
        options.sslCert,
        options.sslKey
      );
      
      writeFileSync(configFile, config);
      
      // Test and reload nginx
      try {
        await testAndReload();
      } catch (err) {
        // Remove the config file if reload fails
        try { unlinkSync(configFile); } catch {}
        throw err;
      }
      
      return { host, configFile, upstream };
    },

    /**
     * Remove an app route
     */
    async removeRoute(appName) {
      const configFile = getConfigFilePath(appName);
      
      if (!existsSync(configFile)) {
        return true; // Already removed
      }
      
      try {
        unlinkSync(configFile);
        await testAndReload();
        return true;
      } catch (err) {
        console.error(`[Nginx] Failed to remove route for ${appName}:`, err.message);
        return false;
      }
    },

    /**
     * List all managed routes
     */
    async listRoutes() {
      const configPath = getConfigPath();
      
      if (!existsSync(configPath)) {
        return [];
      }
      
      try {
        const files = readdirSync(configPath)
          .filter(f => f.startsWith('podpaas-') && f.endsWith('.conf'));
        
        return files.map(file => {
          const appName = file.replace('podpaas-', '').replace('.conf', '');
          const content = readFileSync(join(configPath, file), 'utf8');
          
          // Extract domain and port from config
          const domainMatch = content.match(/server_name\s+([^;]+)/);
          const portMatch = content.match(/proxy_pass\s+http:\/\/localhost:(\d+)/);
          
          return {
            id: `app-${appName}`,
            appName,
            domain: domainMatch?.[1]?.trim(),
            port: portMatch?.[1] ? parseInt(portMatch[1]) : null,
            configFile: join(configPath, file),
          };
        });
      } catch (err) {
        console.error('[Nginx] Failed to list routes:', err.message);
        return [];
      }
    },

    /**
     * Reload configuration
     */
    async reload() {
      try {
        await testAndReload();
        return true;
      } catch (err) {
        return false;
      }
    },

    /**
     * Validate a custom Nginx template
     */
    async validateTemplate(template) {
      if (!template.includes('{{DOMAIN}}') || !template.includes('{{PORT}}')) {
        return {
          valid: false,
          error: 'Template must contain {{DOMAIN}} and {{PORT}} placeholders'
        };
      }
      
      // Write to temp file and test
      const tempFile = `/tmp/nginx-test-${Date.now()}.conf`;
      try {
        writeFileSync(tempFile, template);
        await execAsync(`nginx -t -c ${tempFile}`);
        return { valid: true };
      } catch (err) {
        return { valid: false, error: err.message };
      } finally {
        try { unlinkSync(tempFile); } catch {}
      }
    },
  };
}
