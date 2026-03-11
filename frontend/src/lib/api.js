const BASE = import.meta.env.VITE_API_URL || '';

function getToken() { return localStorage.getItem('paas_token'); }

async function request(method, path, body) {
  const token = getToken();
  const headers = {};
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers, body: body != null ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { localStorage.removeItem('paas_token'); window.location.href = '/login'; return; }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  // Auth
  login:          (username, password) => request('POST', '/auth/login', { username, password }),
  me:             ()                   => request('GET',  '/auth/me'),
  changePassword: (body)               => request('POST', '/auth/change-password', body),
  // Apps
  getApps:     ()          => request('GET',    '/apps'),
  getApp:      (id)        => request('GET',    `/apps/${id}`),
  createApp:   (body)      => request('POST',   '/apps', body),
  updateApp:   (id, body)  => request('PATCH',  `/apps/${id}`, body),
  deleteApp:   (id)        => request('DELETE', `/apps/${id}`),
  deployApp:   (id)        => request('POST',   `/apps/${id}/deploy`),
  stopApp:     (id)        => request('POST',   `/apps/${id}/stop`),
  restartApp:  (id)        => request('POST',   `/apps/${id}/restart`),
  getAppStats: (id)        => request('GET',    `/apps/${id}/stats`),
  getEnvVars:  (id)        => request('GET',    `/apps/${id}/env`),
  setEnvVars:  (id, vars)  => request('PUT',    `/apps/${id}/env`, { env_vars: vars }),
  // Deployments
  getDeployments: (params = {}) => { const qs = new URLSearchParams(params).toString(); return request('GET', `/deployments${qs ? `?${qs}` : ''}`); },
  getDeployment: (id) => request('GET', `/deployments/${id}`),
  // Logs
  getAppLogs: (id, tail = 200) => request('GET', `/logs/app/${id}?tail=${tail}`),
  // Metrics
  getOverview:   () => request('GET', '/metrics/overview'),
  getContainers: () => request('GET', '/metrics/containers'),
  getExternalContainers: () => request('GET', '/metrics/external-containers'),
  deleteContainer: (id) => request('DELETE', `/metrics/containers/${id}`),
  // Stacks
  getStacks:     ()         => request('GET',    '/stacks'),
  getStack:      (id)       => request('GET',    `/stacks/${id}`),
  createStack:   (body)     => request('POST',   '/stacks', body),
  updateStack:   (id, body) => request('PATCH',  `/stacks/${id}`, body),
  deleteStack:   (id)       => request('DELETE', `/stacks/${id}`),
  deployStack:   (id)       => request('POST',   `/stacks/${id}/deploy`),
  stopStack:     (id)       => request('POST',   `/stacks/${id}/stop`),
  restartStack:  (id)       => request('POST',   `/stacks/${id}/restart`),
  getStackLogs:  (id, tail) => request('GET',    `/stacks/${id}/logs?tail=${tail || 200}`),
  getStackStatus:(id)       => request('GET',    `/stacks/${id}/status`),
  validateStack: (content)  => request('POST',   '/stacks/validate', { compose_content: content }),
  
  // Proxy
  getProxyConfig:  ()         => request('GET',    '/proxy/config'),
  getProxyTypes:   ()         => request('GET',    '/proxy/types'),
  getProxyModes:   ()         => request('GET',    '/proxy/modes'),
  getProxyStatus:  ()         => request('GET',    '/proxy/status'),
  updateProxy:     (body)     => request('PATCH',  '/proxy/config', body),
  testProxy:       ()         => request('POST',   '/proxy/test'),
  getProxyRoutes:  ()         => request('GET',    '/proxy/routes'),
  getProxyGuide:   (type)     => request('GET',    `/proxy/guide/${type}`),
  validateTemplate:(template) => request('POST',   '/proxy/validate-template', { template }),
  // Proxy Container Management
  getProxyContainerStatus: () => request('GET',    '/proxy/container/status'),
  deployProxyContainer: (opts = {}) => request('POST', '/proxy/container/deploy', opts),
  removeProxyContainer: ()   => request('DELETE', '/proxy/container'),
  restartProxyContainer: ()  => request('POST',   '/proxy/container/restart'),
  startProxyContainer:   ()  => request('POST',   '/proxy/container/start'),
  stopProxyContainer:    ()  => request('POST',   '/proxy/container/stop'),
  getProxyContainers:  ()    => request('GET',    '/proxy/containers'),
  getProxyCompose:     ()    => request('GET',    '/proxy/compose'),
  // Proxy Configuration File Management
  getProxySetupStatus: ()    => request('GET',    '/proxy/setup-status'),
  setupProxy:          (body) => request('POST',   '/proxy/setup', body),
  getProxyConfigFiles: ()    => request('GET',    '/proxy/config/files'),
  getProxyConfigFile:  (name) => request('GET',    `/proxy/config/files/${name}`),
  saveProxyConfigFile: (name, content) => request('PUT', `/proxy/config/files/${name}`, { content }),
  deleteProxyConfigFile:(name) => request('DELETE', `/proxy/config/files/${name}`),
  getProxyMainConfig:  ()    => request('GET',    '/proxy/config/main'),
  saveProxyMainConfig: (content) => request('PUT', '/proxy/config/main', { content }),
  getProxyConfigTemplates: () => request('GET',    '/proxy/config/templates'),
  validateProxyConfig: (content) => request('POST', '/proxy/config/validate', { content }),
  
  // Templates
  getTemplates:        (p = {}) => { const qs = new URLSearchParams(p).toString(); return request('GET', `/templates${qs ? `?${qs}` : ''}`); },
  getTemplate:         (id)     => request('GET',    `/templates/${id}`),
  getTemplateSources:  ()       => request('GET',    '/templates/sources'),
  syncTemplates:       (source, clear = false) => request('POST', '/templates/sync', { source, clear }),
  importTemplates:     (url, label) => request('POST', '/templates/import', { url, label }),
  deleteTemplateSource:(source) => request('DELETE', `/templates/source/${source}`),
  deployTemplateAsApp: (id, body) => request('POST', `/templates/${id}/deploy/app`,   body),
  deployTemplateAsStack:(id,body) => request('POST', `/templates/${id}/deploy/stack`, body),
  // Settings
  getSettings:    ()     => request('GET', '/settings'),
  updateSettings: (body) => request('PUT', '/settings', body),
  // Users
  getUsers:       ()     => request('GET',    '/auth/users'),
  createUser:     (body) => request('POST',   '/auth/users', body),
  deleteUser:     (id)   => request('DELETE', `/auth/users/${id}`),
  // Webhooks
  generateWebhookSecret: (appId) => request('POST', `/webhooks/generate-secret/${appId}`),
  // Terminal
  getAvailableShells: (containerId) => request('GET', `/terminal/shells/${containerId}`),
  createTerminal: (containerId, onMessage, onClose) => {
    const token = getToken();
    const wsBase = (BASE || `http://${window.location.host}`).replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsBase}/api/terminal/container/${containerId}?token=${token}`);
    
    ws.onopen = () => console.log('[Terminal] Connected');
    
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'data') {
          onMessage?.(msg.data); // base64 encoded
        } else if (msg.type === 'connected') {
          onMessage?.(btoa(msg.message));
        } else if (msg.type === 'exit' || msg.type === 'error') {
          onClose?.(msg);
        }
      } catch {}
    };
    
    ws.onclose = () => onClose?.({ type: 'close' });
    ws.onerror = (err) => onClose?.({ type: 'error', error: err });
    
    return {
      send: (data) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      },
      resize: (cols, rows) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      },
      close: () => ws.close(),
    };
  },
  
  // Backup
  exportBackup: () => {
    const token = getToken();
    return fetch(`${BASE}/api/backup/export`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }).then(res => {
      if (!res.ok) throw new Error('Backup export failed');
      return res.blob();
    });
  },
  importBackup: (file) => {
    const token = getToken();
    const formData = new FormData();
    formData.append('file', file);
    return fetch(`${BASE}/api/backup/import`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    }).then(async res => {
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Import failed');
      return data;
    });
  },
};

/**
 * Create a WebSocket connection for log streaming with auto-reconnection
 */
export function createLogStream(path, onMessage, onDone, options = {}) {
  const token = getToken();
  if (!token) {
    onMessage?.('[Error: Not authenticated]');
    onDone?.('error');
    return null;
  }

  const wsBase = (BASE || `http://${window.location.host}`).replace(/^http/, 'ws');
  const url = `${wsBase}/api/logs${path}?token=${token}`;
  
  let ws = null;
  let reconnectAttempts = 0;
  let maxReconnects = options.maxReconnects || 3;
  let reconnectDelay = options.reconnectDelay || 2000;
  let closed = false;
  let messageBuffer = [];
  let flushInterval = null;

  // Buffer messages and flush periodically for better performance
  const flushMessages = () => {
    if (messageBuffer.length > 0 && onMessage) {
      messageBuffer.forEach(msg => {
        try { onMessage(msg); } catch (e) { console.error('[LogStream] Message handler error:', e); }
      });
      messageBuffer = [];
    }
  };

  const connect = () => {
    if (closed) return;
    
    try {
      ws = new WebSocket(url);
      
      ws.onopen = () => {
        console.log('[LogStream] Connected');
        reconnectAttempts = 0;
        // Start flush interval
        flushInterval = setInterval(flushMessages, 100);
      };
      
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'log') {
            messageBuffer.push(msg.data);
          } else if (msg.type === 'done') {
            flushMessages();
            onDone?.(msg.status);
            close();
          } else if (msg.type === 'error') {
            flushMessages();
            onMessage?.(`[Error] ${msg.message}`);
            onDone?.('error');
            close();
          }
        } catch {
          messageBuffer.push(e.data);
        }
      };
      
      ws.onerror = (err) => {
        console.error('[LogStream] WebSocket error:', err);
        // Don't immediately report error - try to reconnect first
      };
      
      ws.onclose = (event) => {
        clearInterval(flushInterval);
        flushMessages();
        
        if (closed) return; // Intentionally closed
        
        // Don't reconnect if it was a clean close or auth error
        if (event.code === 1000 || event.code === 1001 || event.code === 4001) {
          onDone?.('closed');
          return;
        }
        
        // Attempt reconnection
        if (reconnectAttempts < maxReconnects) {
          reconnectAttempts++;
          console.log(`[LogStream] Reconnecting... (${reconnectAttempts}/${maxReconnects})`);
          onMessage?.(`[Reconnecting... ${reconnectAttempts}/${maxReconnects}]`);
          setTimeout(connect, reconnectDelay * reconnectAttempts);
        } else {
          onMessage?.('[Connection lost. Please refresh to reconnect.]');
          onDone?.('disconnected');
        }
      };
    } catch (err) {
      console.error('[LogStream] Failed to create WebSocket:', err);
      onMessage?.(`[Error: ${err.message}]`);
      onDone?.('error');
    }
  };

  const close = () => {
    closed = true;
    clearInterval(flushInterval);
    flushMessages();
    if (ws) {
      try {
        ws.close(1000, 'Client closed connection');
      } catch {}
    }
  };

  // Start connection
  connect();

  return { close, ws: () => ws };
}
