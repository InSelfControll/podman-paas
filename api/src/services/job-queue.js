/**
 * Deployment Job Queue Service
 * 
 * Manages deployment jobs using Piscina worker threads.
 * Provides persistent state tracking and crash recovery.
 */

import { getDB } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';
import { runDeploymentJob, getPoolStats } from '../workers/pool.js';
import { EventEmitter } from 'events';

const jobEmitter = new EventEmitter();

// Track in-progress jobs
const activeJobs = new Map(); // jobId -> { abortController, promise }

// Worker ID for this process
const WORKER_ID = `${process.pid}-${Date.now()}`;

/**
 * Create a new deployment job
 */
export async function createDeploymentJob(appId, deploymentId, trigger = 'manual') {
  const db = getDB();
  const jobId = uuidv4();
  
  db.prepare(`
    INSERT INTO deployment_jobs (id, app_id, deployment_id, status, trigger, current_step, progress_pct)
    VALUES (?, ?, ?, 'pending', ?, 'init', 0)
  `).run(jobId, appId, deploymentId, trigger);
  
  // Emit event to trigger processing
  jobEmitter.emit('newJob', jobId);
  
  return { jobId };
}

/**
 * Get job by ID
 */
export function getJob(jobId) {
  const db = getDB();
  return db.prepare('SELECT * FROM deployment_jobs WHERE id = ?').get(jobId);
}

/**
 * Get jobs for an app
 */
export function getAppJobs(appId, limit = 10) {
  const db = getDB();
  return db.prepare(`
    SELECT * FROM deployment_jobs 
    WHERE app_id = ? 
    ORDER BY started_at DESC 
    LIMIT ?
  `).all(appId, limit);
}

/**
 * Recover stale jobs (crashed workers)
 */
export async function recoverStaleJobs() {
  const db = getDB();
  
  // Find jobs that haven't updated heartbeat in 5 minutes
  const staleJobs = db.prepare(`
    SELECT * FROM deployment_jobs 
    WHERE status = 'running' 
    AND (
      heartbeat_at IS NULL 
      OR datetime(heartbeat_at) < datetime('now', '-5 minutes')
    )
  `).all();
  
  console.log(`[JobQueue] Found ${staleJobs.length} stale jobs to recover`);
  
  for (const job of staleJobs) {
    console.log(`[JobQueue] Recovering stale job ${job.id} for app ${job.app_id}`);
    
    // Mark as pending for re-processing
    db.prepare(`
      UPDATE deployment_jobs 
      SET status = 'pending', worker_id = NULL, current_step = 'init', progress_pct = 0
      WHERE id = ?
    `).run(job.id);
    
    // Also update the app status back from 'building'
    db.prepare(`
      UPDATE apps SET status = 'stopped' WHERE id = ? AND status = 'building'
    `).run(job.app_id);
    
    // Trigger reprocessing
    jobEmitter.emit('newJob', job.id);
  }
  
  return staleJobs.length;
}

/**
 * Process pending jobs
 */
export async function processPendingJobs() {
  const db = getDB();
  
  // Get pool stats to check capacity
  const stats = getPoolStats();
  const deploymentPool = stats.deployment;
  
  if (!deploymentPool) {
    console.warn('[JobQueue] Deployment pool not available');
    return;
  }
  
  // Calculate available slots
  const maxConcurrency = parseInt(process.env.DEPLOY_CONCURRENCY || '2', 10);
  const runningInPool = deploymentPool.threads; // Active workers
  const availableSlots = maxConcurrency - runningInPool;
  
  if (availableSlots <= 0) {
    console.log('[JobQueue] At max concurrency, waiting...');
    return;
  }
  
  // Get pending jobs
  const pendingJobs = db.prepare(`
    SELECT j.*, a.name as app_name, a.git_url, a.image, a.port, a.domain, a.memory_limit, a.cpu_limit
    FROM deployment_jobs j
    JOIN apps a ON j.app_id = a.id
    WHERE j.status = 'pending'
    ORDER BY j.started_at ASC
    LIMIT ?
  `).all(availableSlots);
  
  for (const job of pendingJobs) {
    processJob(job);
  }
}

/**
 * Process a single job
 */
async function processJob(job) {
  const db = getDB();
  const jobId = job.id;
  
  // Check if already being processed
  if (activeJobs.has(jobId)) {
    return;
  }
  
  console.log(`[JobQueue] Starting job ${jobId} for app ${job.app_name}`);
  
  // Mark as running and assign to this worker
  db.prepare(`
    UPDATE deployment_jobs 
    SET status = 'running', worker_id = ?, heartbeat_at = datetime('now')
    WHERE id = ?
  `).run(WORKER_ID, jobId);
  
  // Mark app as building
  db.prepare(`
    UPDATE apps SET status = 'building', updated_at = datetime('now') WHERE id = ?
  `).run(job.app_id);
  
  try {
    // Run in worker thread via Piscina
    const result = await runDeploymentJob({
      jobId,
      appId: job.app_id,
      deploymentId: job.deployment_id,
      trigger: job.trigger,
    });
    
    console.log(`[JobQueue] Job ${jobId} completed successfully`);
    
    // Mark as completed
    db.prepare(`
      UPDATE deployment_jobs 
      SET status = 'completed', finished_at = datetime('now'), progress_pct = 100
      WHERE id = ?
    `).run(jobId);
    
  } catch (err) {
    console.error(`[JobQueue] Job ${jobId} failed:`, err.message);
    
    // Mark as failed
    db.prepare(`
      UPDATE deployment_jobs 
      SET status = 'failed', finished_at = datetime('now'), error_message = ?
      WHERE id = ?
    `).run(err.message.slice(0, 500), jobId);
    
    // Update app status
    db.prepare(`
      UPDATE apps SET status = 'error', updated_at = datetime('now') WHERE id = ?
    `).run(job.app_id);
  } finally {
    activeJobs.delete(jobId);
  }
}

/**
 * Cancel a running job
 */
export async function cancelJob(jobId) {
  const activeJob = activeJobs.get(jobId);
  if (activeJob && activeJob.abortController) {
    activeJob.abortController.abort();
    return true;
  }
  
  // Mark as cancelled in DB
  const db = getDB();
  db.prepare(`
    UPDATE deployment_jobs 
    SET status = 'cancelled', finished_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(jobId);
  
  return false;
}

/**
 * Get queue status
 */
export function getQueueStatus() {
  const db = getDB();
  
  const status = db.prepare(`
    SELECT 
      status,
      COUNT(*) as count
    FROM deployment_jobs
    GROUP BY status
  `).all();
  
  const poolStats = getPoolStats();
  
  return {
    jobs: status.reduce((acc, row) => {
      acc[row.status] = row.count;
      return acc;
    }, {}),
    pool: poolStats,
    workerId: WORKER_ID,
  };
}

/**
 * Recover orphaned builds on startup
 * 
 * This handles the case where the main process crashed while apps were in 'building' state
 * but no corresponding job exists (e.g., before job was created or job was lost).
 */
export async function recoverOrphanedBuilds() {
  const db = getDB();
  
  console.log('[JobQueue] Checking for orphaned builds...');
  
  // Find apps in 'building' state with no associated running/pending job
  const orphanedApps = db.prepare(`
    SELECT a.* FROM apps a
    WHERE a.status = 'building'
    AND NOT EXISTS (
      SELECT 1 FROM deployment_jobs dj
      WHERE dj.app_id = a.id
      AND dj.status IN ('pending', 'running')
    )
  `).all();
  
  if (orphanedApps.length === 0) {
    console.log('[JobQueue] No orphaned builds found');
    return 0;
  }
  
  console.log(`[JobQueue] Found ${orphanedApps.length} orphaned builds to recover`);
  
  for (const app of orphanedApps) {
    console.log(`[JobQueue] Recovering orphaned build for app: ${app.name} (${app.id})`);
    
    // Find the most recent deployment for this app
    const lastDeployment = db.prepare(`
      SELECT * FROM deployments
      WHERE app_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(app.id);
    
    if (lastDeployment && lastDeployment.status === 'running') {
      // Create a job to resume this deployment
      const jobId = uuidv4();
      db.prepare(`
        INSERT INTO deployment_jobs (id, app_id, deployment_id, status, trigger, current_step, progress_pct, log)
        VALUES (?, ?, ?, 'pending', ?, 'init', 0, ?)
      `).run(
        jobId, 
        app.id, 
        lastDeployment.id, 
        lastDeployment.trigger || 'recovery',
        `[${new Date().toISOString()}] 🔧 Recovered from orphaned build state\n`
      );
      
      console.log(`[JobQueue] Created recovery job ${jobId} for deployment ${lastDeployment.id}`);
      
      // Emit event to trigger processing
      jobEmitter.emit('newJob', jobId);
    } else {
      // No running deployment found, reset app to stopped state
      console.log(`[JobQueue] No running deployment found, resetting app ${app.name} to stopped`);
      db.prepare(`
        UPDATE apps SET status = 'stopped', updated_at = datetime('now') WHERE id = ?
      `).run(app.id);
      
      // If there was a deployment, mark it as failed
      if (lastDeployment) {
        db.prepare(`
          UPDATE deployments 
          SET status = 'failed', finished_at = datetime('now'), log = log || ?
          WHERE id = ?
        `).run(`\n[${new Date().toISOString()}] ❌ Failed due to process crash during build`, lastDeployment.id);
      }
    }
  }
  
  return orphanedApps.length;
}

/**
 * Start the job queue processor
 */
export function startJobQueue() {
  console.log('[JobQueue] Starting deployment job queue...');
  
  // Recover stale jobs from previous crashes
  recoverStaleJobs();
  
  // Listen for new jobs
  jobEmitter.on('newJob', () => {
    processPendingJobs();
  });
  
  // Periodic cleanup and recovery
  setInterval(() => {
    recoverStaleJobs();
    processPendingJobs();
  }, 30000); // Check every 30 seconds
  
  // Process any pending jobs immediately
  processPendingJobs();
  
  console.log('[JobQueue] Job queue processor started');
}

/**
 * Stop the job queue
 */
export async function stopJobQueue() {
  console.log('[JobQueue] Stopping job queue...');
  
  // Cancel all active jobs
  for (const [jobId, job] of activeJobs) {
    if (job.abortController) {
      job.abortController.abort();
    }
  }
  
  jobEmitter.removeAllListeners();
}
