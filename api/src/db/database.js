import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

import { v4 as uuidv4 } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '../../../data');

let db;

export async function initDB() {
  mkdirSync(DATA_DIR, { recursive: true });

  db = new Database(join(DATA_DIR, 'podman-paas.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');  // WAL + NORMAL is safe and faster than FULL
  db.pragma('cache_size = -16000');   // 16MB page cache
  db.pragma('temp_store = memory');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      username     TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS apps (
      id              TEXT PRIMARY KEY,
      name            TEXT UNIQUE NOT NULL,
      description     TEXT,
      git_url         TEXT,
      branch          TEXT DEFAULT 'main',
      dockerfile_path TEXT DEFAULT 'Dockerfile',
      build_method    TEXT DEFAULT 'dockerfile',
      port            INTEGER DEFAULT 3000,
      domain          TEXT,
      status          TEXT DEFAULT 'stopped',
      image           TEXT,
      container_id    TEXT,
      host_port       INTEGER,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS env_vars (
      id         TEXT PRIMARY KEY,
      app_id     TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      is_secret  INTEGER DEFAULT 0,
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
      UNIQUE(app_id, key)
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id             TEXT PRIMARY KEY,
      app_id         TEXT NOT NULL,
      status         TEXT DEFAULT 'pending',
      commit_sha     TEXT,
      commit_message TEXT,
      trigger        TEXT DEFAULT 'manual',
      log            TEXT DEFAULT '',
      started_at     TEXT DEFAULT (datetime('now')),
      finished_at    TEXT,
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stacks (
      id              TEXT PRIMARY KEY,
      name            TEXT UNIQUE NOT NULL,
      description     TEXT,
      compose_content TEXT NOT NULL,
      status          TEXT DEFAULT 'stopped',
      container_ids   TEXT DEFAULT '[]',  -- JSON array of container IDs
      error_message   TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS template_catalog (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'app',
      title       TEXT NOT NULL,
      description TEXT,
      logo        TEXT,
      categories  TEXT DEFAULT '[]',
      data        TEXT DEFAULT '{}',
      updated_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(source, source_id)
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_deployments_app_id    ON deployments(app_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_started   ON deployments(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_env_vars_app_id       ON env_vars(app_id);
    CREATE INDEX IF NOT EXISTS idx_apps_status           ON apps(status);
    CREATE INDEX IF NOT EXISTS idx_templates_source      ON template_catalog(source);
    CREATE INDEX IF NOT EXISTS idx_templates_type        ON template_catalog(type);
    CREATE INDEX IF NOT EXISTS idx_templates_title       ON template_catalog(title);

    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('domain_suffix',    '.localhost'),
      ('proxy_type',       'caddy'),
      ('proxy_mode',       'container'),
      ('proxy_admin_url',  'http://caddy:2019'),
      ('proxy_config_path', '/etc/nginx/conf.d'),
      ('proxy_container_name', 'caddy'),
      ('proxy_podman_network', 'podman-paas'),
      ('podman_socket',    '/run/user/1000/podman/podman.sock'),
      ('registry_url',     ''),
      ('auto_ssl',         'false'),
      ('rootless',         'true');
    
    -- Migrate old caddy_admin_url setting to new proxy_admin_url if exists
    INSERT OR REPLACE INTO settings (key, value) 
    SELECT 'proxy_admin_url', value FROM settings WHERE key = 'caddy_admin_url';
    
    -- Set proxy_type to caddy if legacy caddy_admin_url exists
    INSERT OR REPLACE INTO settings (key, value) 
    SELECT 'proxy_type', 'caddy' FROM settings WHERE key = 'caddy_admin_url';
    
    -- Set default proxy_mode to host if migrating from old config
    INSERT OR REPLACE INTO settings (key, value) 
    SELECT 'proxy_mode', 'host' FROM settings WHERE key = 'caddy_admin_url' AND value LIKE 'http://localhost%';
  `);

  // Run any pending migrations
  runMigrations();

  // Seed default admin user
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (userCount.c === 0) {
    const hash = await hashPassword('admin', 12);
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(uuidv4(), 'admin', hash);
    console.log('✅ Default admin user created (username: admin, password: admin) — change this immediately!');
  }

  // Override socket path from env if set (takes precedence over DB setting)
  if (process.env.PODMAN_SOCKET) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('podman_socket', process.env.PODMAN_SOCKET);
  }

  console.log('✅ Database initialized');
  return db;
}

export function getDB() {
  if (!db) throw new Error('Database not initialized — call initDB() first');
  return db;
}

// ── Migrations ────────────────────────────────────────────────────────────────
function runMigrations() {
  // Simple version-tracking migration system
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
  );

  const migrations = [
    { version: 1, sql: 'ALTER TABLE apps ADD COLUMN webhook_secret TEXT' },
    { version: 2, sql: 'ALTER TABLE apps ADD COLUMN memory_limit INTEGER DEFAULT 0' },
    { version: 3, sql: 'ALTER TABLE apps ADD COLUMN cpu_limit REAL DEFAULT 0' },
    // Note: container_ids and error_message are now in base schema (stacks table)
    // No need for migrations since new DBs get them via CREATE TABLE
  ];
  
  // Ensure ws_ticket_secret setting exists (auto-generated on first use)
  // No explicit migration needed - handled by ws-tickets.js service
  
  // Migration 4: Create volumes and volume_mounts tables
  if (!applied.has(4)) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS volumes (
          id              TEXT PRIMARY KEY,
          name            TEXT UNIQUE NOT NULL,
          driver          TEXT DEFAULT 'local',
          mount_point     TEXT,
          size_mb         INTEGER,
          labels          TEXT DEFAULT '{}',
          created_at      TEXT DEFAULT (datetime('now'))
        );
        
        CREATE TABLE IF NOT EXISTS volume_mounts (
          id              TEXT PRIMARY KEY,
          volume_id       TEXT NOT NULL,
          app_id          TEXT,
          stack_id        TEXT,
          container_path  TEXT NOT NULL,
          read_only       INTEGER DEFAULT 0,
          FOREIGN KEY (volume_id) REFERENCES volumes(id) ON DELETE CASCADE,
          FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
          FOREIGN KEY (stack_id) REFERENCES stacks(id) ON DELETE CASCADE
        );
        
        CREATE INDEX IF NOT EXISTS idx_volume_mounts_volume_id ON volume_mounts(volume_id);
        CREATE INDEX IF NOT EXISTS idx_volume_mounts_app_id ON volume_mounts(app_id);
        CREATE INDEX IF NOT EXISTS idx_volume_mounts_stack_id ON volume_mounts(stack_id);
      `);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (4)').run(4);
      console.log('✅ Migration 4 applied: volumes and volume_mounts tables');
    } catch (err) {
      console.warn(`⚠️ Migration 4 skipped: ${err.message}`);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (4)').run(4);
    }
  }

  for (const m of migrations) {
    if (!applied.has(m.version)) {
      try {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
        console.log(`✅ Migration ${m.version} applied`);
      } catch (err) {
        // If migration fails (e.g., column already exists), log and mark as applied
        console.warn(`⚠️ Migration ${m.version} skipped: ${err.message}`);
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(m.version);
      }
    }
  }
}
