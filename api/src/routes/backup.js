import { getDB } from '../db/database.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, createWriteStream, mkdirSync, existsSync, unlinkSync, readdirSync, writeFileSync, readFileSync } from 'fs';
import { pipeline } from 'stream/promises';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '../../../data');
const BACKUP_DIR = join(DATA_DIR, 'backups');

export default async function backupRoutes(app) {
  // Export: stream a backup ZIP
  app.get('/export', { onRequest: [app.authenticate] }, async (req, reply) => {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDbPath = join(BACKUP_DIR, `backup-${timestamp}.db`);
    const zipPath = join(BACKUP_DIR, `podpaas-backup-${timestamp}.zip`);

    try {
      // Use SQLite backup API for consistent snapshot
      const db = getDB();
      db.backup(backupDbPath);

      // Gather stack compose files
      const stacks = db.prepare('SELECT name, compose_content FROM stacks').all();
      const stacksDir = join(BACKUP_DIR, `stacks-${timestamp}`);
      mkdirSync(stacksDir, { recursive: true });
      for (const s of stacks) {
        writeFileSync(join(stacksDir, `${s.name}.yml`), s.compose_content);
      }

      // Create ZIP
      execSync(`cd "${BACKUP_DIR}" && zip -j "${zipPath}" "${backupDbPath}" && cd "${stacksDir}" && zip -r "${zipPath}" .`, {
        timeout: 30000,
      });

      // Stream the zip
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename="podpaas-backup-${timestamp}.zip"`);
      const stream = createReadStream(zipPath);
      await reply.send(stream);

      // Cleanup temp files (async)
      setTimeout(() => {
        try {
          unlinkSync(backupDbPath);
          unlinkSync(zipPath);
          execSync(`rm -rf "${stacksDir}"`);
        } catch {}
      }, 5000);

    } catch (err) {
      req.log.error({ err }, 'Backup export failed');
      // Cleanup on error
      try { unlinkSync(backupDbPath); } catch {}
      try { unlinkSync(zipPath); } catch {}
      return reply.code(500).send({ error: `Backup failed: ${err.message}` });
    }
  });

  // Import: accept a backup ZIP
  app.post('/import', { onRequest: [app.authenticate] }, async (req, reply) => {
    mkdirSync(BACKUP_DIR, { recursive: true });

    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'No file uploaded' });

    const uploadPath = join(BACKUP_DIR, `import-${Date.now()}.zip`);
    const extractDir = join(BACKUP_DIR, `import-${Date.now()}`);

    try {
      // Save uploaded file
      await pipeline(data.file, createWriteStream(uploadPath));

      // Extract
      mkdirSync(extractDir, { recursive: true });
      execSync(`unzip -o "${uploadPath}" -d "${extractDir}"`, { timeout: 30000 });

      // Find the .db file
      const files = readdirSync(extractDir);
      const dbFile = files.find(f => f.endsWith('.db'));
      if (!dbFile) return reply.code(400).send({ error: 'No database file found in ZIP' });

      // Replace current database
      const dbPath = join(DATA_DIR, 'podman-paas.db');
      const importedDbPath = join(extractDir, dbFile);

      // Close and replace
      const currentDb = getDB();
      const importedDb = (await import('better-sqlite3')).default(importedDbPath);

      // Validate it's a valid PodPaaS database
      try {
        importedDb.prepare('SELECT COUNT(*) FROM apps').get();
        importedDb.prepare('SELECT COUNT(*) FROM users').get();
      } catch {
        importedDb.close();
        return reply.code(400).send({ error: 'Invalid PodPaaS database file' });
      }
      importedDb.close();

      // Use SQLite backup API to restore
      currentDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const backup = (await import('better-sqlite3')).default(importedDbPath);
      backup.backup(dbPath).then(() => {
        backup.close();
        req.log.info('Database restored from backup');
      });

      return { message: 'Backup imported successfully. Restart the server for full effect.' };

    } catch (err) {
      req.log.error({ err }, 'Backup import failed');
      return reply.code(500).send({ error: `Import failed: ${err.message}` });
    } finally {
      // Cleanup
      setTimeout(() => {
        try { unlinkSync(uploadPath); } catch {}
        try { execSync(`rm -rf "${extractDir}"`); } catch {}
      }, 5000);
    }
  });
}
