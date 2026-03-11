import { getDB } from '../db/database.js';

const ALLOWED_KEYS = new Set([
  'domain_suffix', 'caddy_admin_url', 'podman_socket',
  'registry_url', 'auto_ssl', 'rootless',
  // New proxy settings
  'proxy_type', 'proxy_mode', 'proxy_admin_url', 'proxy_config_path',
  'proxy_custom_template', 'proxy_network_name', 'proxy_container_name',
  'proxy_remote_host', 'proxy_podman_network',
]);

export default async function settingsRoutes(app) {
  app.get('/', { onRequest: [app.authenticate] }, async () => {
    const db = getDB();
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  });

  app.put('/', {
    onRequest: [app.authenticate],
    schema: {
      body: { type: 'object', additionalProperties: { type: 'string' } },
    },
  }, async (req, reply) => {
    const db = getDB();
    
    // Log what we're saving
    console.log('[Settings] Saving settings:', Object.keys(req.body));
    
    const unknown = Object.keys(req.body).filter(k => !ALLOWED_KEYS.has(k));
    if (unknown.length) {
      console.warn('[Settings] Unknown keys rejected:', unknown);
      return reply.code(400).send({ error: `Unknown settings keys: ${unknown.join(', ')}` });
    }
    
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    db.transaction((entries) => {
      for (const [key, value] of entries) {
        upsert.run(key, String(value));
        console.log(`[Settings] Saved: ${key} = ${value}`);
      }
    })(Object.entries(req.body));
    
    return { success: true, saved: Object.keys(req.body) };
  });
  
  // Debug endpoint to verify settings are persisted
  app.get('/debug', { onRequest: [app.authenticate] }, async () => {
    const db = getDB();
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const dbPath = db.name;
    return {
      databasePath: dbPath,
      settingsCount: rows.length,
      settings: Object.fromEntries(rows.map(r => [r.key, r.value])),
    };
  });
}
