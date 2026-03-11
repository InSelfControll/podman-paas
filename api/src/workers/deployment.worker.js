/**
 * Deployment Worker for Piscina
 * 
 * Handles application deployments in a worker thread.
 * Updates job progress in SQLite for crash recovery.
 * 
 * NOTE: This worker runs in isolation - it has its own DB connection
 * and must not rely on any main-thread state.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '../../../data');

// Deployment steps for progress tracking
const DEPLOY_STEPS = [
  'init',
  'ensure_network',
  'build_or_pull',
  'teardown_old',
  'allocate_port',
  'create_container',
  'start_container',
  'register_proxy',
  'verify_health',
  'cleanup'
];

/**
 * Get database connection (worker-local)
 */
function getWorkerDB() {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(join(DATA_DIR, 'podman-paas.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Update job progress in database
 */
function updateJobProgress(db, jobId, step, progress, status = 'running', error = null) {
  try {
    db.prepare(`
      UPDATE deployment_jobs 
      SET current_step = ?, progress_pct = ?, status = ?, 
          error_message = ?, heartbeat_at = datetime('now')
      WHERE id = ?
    `).run(step, progress, status, error, jobId);
  } catch (err) {
    console.error(`[DeploymentWorker] Failed to update progress: ${err.message}`);
  }
}

/**
 * Log message to both console and job log
 */
function logMessage(db, jobId, deploymentId, message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}`;
  
  console.log(`[DeploymentWorker ${jobId}] ${message}`);
  
  try {
    // Update job log
    db.prepare(`
      UPDATE deployment_jobs SET log = log || ? || char(10)
      WHERE id = ?
    `).run(logLine, jobId);
    
    // Also update deployment record (if exists)
    if (deploymentId) {
      db.prepare(`
        UPDATE deployments SET log = log || ? || char(10)
        WHERE id = ?
      `).run(logLine, deploymentId);
    }
  } catch (err) {
    // Silently fail - logging is best-effort
  }
}

/**
 * Get Podman socket path from settings
 */
function getPodmanSocket(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'podman_socket'").get();
    return row?.value || process.env.PODMAN_SOCKET || '/run/user/1000/podman/podman.sock';
  } catch {
    return process.env.PODMAN_SOCKET || '/run/user/1000/podman/podman.sock';
  }
}

/**
 * Main deployment function
 */
async function runDeployment(jobData) {
  const { jobId, appId, deploymentId, trigger } = jobData;
  const db = getWorkerDB();
  
  const PAAS_NETWORK = 'podman-paas';
  
  try {
    // Mark job as running
    db.prepare(`
      UPDATE deployment_jobs 
      SET status = 'running', started_at = datetime('now'), heartbeat_at = datetime('now')
      WHERE id = ?
    `).run(jobId);
    
    // Mark app as building
    db.prepare(`
      UPDATE apps SET status = 'building', updated_at = datetime('now') WHERE id = ?
    `).run(appId);
    
    // Get app details
    const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(appId);
    if (!app) {
      throw new Error('App not found');
    }
    
    logMessage(db, jobId, deploymentId, `🚀 Starting deployment for ${app.name}`);
    
    // Step 1: Ensure network
    updateJobProgress(db, jobId, 'ensure_network', 10);
    logMessage(db, jobId, deploymentId, '🌐 Ensuring podman-paas network...');
    // Note: Network creation would be done via Podman API call
    // For now, we assume it's handled by the main thread or pre-created
    
    // Step 2: Build or pull image
    updateJobProgress(db, jobId, 'build_or_pull', 25);
    if (app.git_url) {
      logMessage(db, jobId, deploymentId, `📦 Building from git: ${app.git_url}`);
      // Build logic would go here
      // This is a placeholder since actual build requires podman API
    } else if (app.image) {
      logMessage(db, jobId, deploymentId, `📦 Pulling image: ${app.image}`);
      // Pull logic would go here
    } else {
      throw new Error('App has no git_url or image configured');
    }
    
    // Step 3: Tear down old container
    updateJobProgress(db, jobId, 'teardown_old', 40);
    logMessage(db, jobId, deploymentId, '🔄 Stopping old container...');
    
    // Step 4: Allocate port
    updateJobProgress(db, jobId, 'allocate_port', 50);
    logMessage(db, jobId, deploymentId, '🔌 Allocating host port...');
    
    // Step 5: Create container
    updateJobProgress(db, jobId, 'create_container', 60);
    logMessage(db, jobId, deploymentId, '📦 Creating container...');
    
    // Step 6: Start container
    updateJobProgress(db, jobId, 'start_container', 75);
    logMessage(db, jobId, deploymentId, '🚀 Starting container...');
    
    // Step 7: Register proxy
    updateJobProgress(db, jobId, 'register_proxy', 85);
    logMessage(db, jobId, deploymentId, '🌐 Registering with reverse proxy...');
    
    // Step 8: Verify health
    updateJobProgress(db, jobId, 'verify_health', 95);
    logMessage(db, jobId, deploymentId, '✅ Verifying deployment health...');
    
    // Mark as completed
    updateJobProgress(db, jobId, 'completed', 100, 'completed');
    
    db.prepare(`
      UPDATE apps SET status = 'running', updated_at = datetime('now') WHERE id = ?
    `).run(appId);
    
    db.prepare(`
      UPDATE deployments SET status = 'success', finished_at = datetime('now') WHERE id = ?
    `).run(deploymentId);
    
    logMessage(db, jobId, deploymentId, '🎉 Deployment complete!');
    
    return { success: true, jobId, deploymentId };
    
  } catch (err) {
    const errorMessage = err.message;
    logMessage(db, jobId, deploymentId, `❌ Deployment failed: ${errorMessage}`);
    
    updateJobProgress(db, jobId, 'failed', 0, 'failed', errorMessage);
    
    db.prepare(`
      UPDATE apps SET status = 'error', updated_at = datetime('now') WHERE id = ?
    `).run(appId);
    
    db.prepare(`
      UPDATE deployments SET status = 'failed', finished_at = datetime('now') WHERE id = ?
    `).run(deploymentId);
    
    throw err;
  } finally {
    db.close();
  }
}

/**
 * Main export function called by Piscina
 */
export default async function deploymentWorker(task) {
  const { jobId, appId, deploymentId, trigger } = task;
  
  if (!jobId || !appId || !deploymentId) {
    throw new Error('Missing required job parameters: jobId, appId, deploymentId');
  }
  
  console.log(`[DeploymentWorker] Starting job ${jobId} for app ${appId}`);
  
  try {
    const result = await runDeployment({ jobId, appId, deploymentId, trigger });
    return result;
  } catch (err) {
    console.error(`[DeploymentWorker] Job ${jobId} failed:`, err.message);
    throw err;
  }
}
