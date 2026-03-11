import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../db/database.js';
import {
  createContainer, startContainer, stopContainer,
  removeContainer, findFreePort, ensureNetwork, getContainer,
  pullImage, restartContainer, sanitizeContainerName,
} from './podman.js';
import { registerAppRoute, removeAppRoute } from './proxy/proxy-factory.js';
import { runBuildPipeline } from './build.js';
import { createDeploymentJob, getJob } from './job-queue.js';

const PAAS_NETWORK = 'podman-paas';

// In-memory pub/sub for live deployment log streaming
const deployStreams = new Map(); // deploymentId → Set<callback>

export function subscribeToDeployment(deploymentId, callback) {
  if (!deployStreams.has(deploymentId)) deployStreams.set(deploymentId, new Set());
  deployStreams.get(deploymentId).add(callback);
  return () => deployStreams.get(deploymentId)?.delete(callback);
}

function emitLog(deploymentId, message) {
  const callbacks = deployStreams.get(deploymentId);
  if (!callbacks) return;
  
  // Clean up dead callbacks and track if any succeeded
  const deadCallbacks = new Set();
  for (const fn of callbacks) {
    try { 
      fn(message); 
    } catch (e) { 
      deadCallbacks.add(fn);
    }
  }
  
  // Remove dead callbacks
  for (const fn of deadCallbacks) {
    callbacks.delete(fn);
  }
  
  // If no more callbacks and deployment is complete, clean up immediately
  if (callbacks.size === 0) {
    const db = getDB();
    const deployment = db.prepare('SELECT status FROM deployments WHERE id = ?').get(deploymentId);
    if (deployment?.status !== 'running') {
      deployStreams.delete(deploymentId);
    }
  }
}

// ── Deploy ───────────────────────────────────────────────────────────────────

export async function deployApp(appId, trigger = 'manual') {
  const db = getDB();
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(appId);
  if (!app) throw new Error('App not found');

  // Optimistic locking: only proceed if not already building
  const updated = db.prepare(
    `UPDATE apps SET status = 'building', updated_at = datetime('now') WHERE id = ? AND status != 'building'`
  ).run(appId);
  if (updated.changes === 0) throw new Error('A deployment is already in progress');

  const deploymentId = uuidv4();
  db.prepare(`INSERT INTO deployments (id, app_id, status, trigger) VALUES (?, ?, 'running', ?)`)
    .run(deploymentId, appId, trigger);

  // Create a job for the worker pool
  const { jobId } = await createDeploymentJob(appId, deploymentId, trigger);
  
  // Start deployment in background (non-blocking)
  // Note: The actual work is done in the worker thread via job-queue.js
  runDeployBackground(app, deploymentId, jobId).catch((err) => {
    console.error(`[Deploy] Background deployment error: ${err.message}`);
  });

  return { deploymentId, jobId };
}

/**
 * Background deployment that coordinates with the worker thread
 */
async function runDeployBackground(app, deploymentId, jobId) {
  const db = getDB();
  const appId = app.id;
  
  const log = (msg) => {
    emitLog(deploymentId, msg);
    // Append to persistent log (truncate at 500KB to avoid DB bloat)
    try {
      const existing = db.prepare('SELECT log FROM deployments WHERE id = ?').get(deploymentId);
      const current = existing?.log || '';
      if (current.length < 500_000) {
        db.prepare('UPDATE deployments SET log = log || ? WHERE id = ?').run(msg + '\n', deploymentId);
      }
    } catch {}
  };

  try {
    log(`🚀 Deploying ${app.name} [${new Date().toISOString()}]`);
    log(`📋 Job ID: ${jobId}`);

    // Poll for job completion
    const maxWaitTime = 15 * 60 * 1000; // 15 minutes
    const startTime = Date.now();
    const pollInterval = 1000; // Check every second
    
    while (Date.now() - startTime < maxWaitTime) {
      const job = getJob(jobId);
      
      if (!job) {
        throw new Error('Job not found');
      }
      
      // Log progress updates
      if (job.current_step && job.progress_pct > 0) {
        log(`⏳ ${job.current_step}: ${job.progress_pct}%`);
      }
      
      // Check if completed
      if (job.status === 'completed') {
        log(`\n🎉 Deployment complete!`);
        
        // Update deployment status
        db.prepare(`
          UPDATE deployments SET status = 'success', finished_at = datetime('now') WHERE id = ?
        `).run(deploymentId);
        
        // Update app status
        db.prepare(`
          UPDATE apps SET status = 'running', updated_at = datetime('now') WHERE id = ?
        `).run(appId);
        
        return;
      }
      
      // Check if failed
      if (job.status === 'failed') {
        throw new Error(job.error_message || 'Deployment failed');
      }
      
      // Still running, wait and poll again
      await new Promise(r => setTimeout(r, pollInterval));
    }
    
    throw new Error('Deployment timed out after 15 minutes');

  } catch (err) {
    log(`\n❌ Deployment failed: ${err.message}`);

    db.prepare(`UPDATE apps SET status = 'error', updated_at = datetime('now') WHERE id = ?`).run(appId);
    db.prepare(`UPDATE deployments SET status = 'failed', finished_at = datetime('now') WHERE id = ?`).run(deploymentId);

  } finally {
    // Keep stream alive 2 min for late-joining subscribers, then GC
    setTimeout(() => deployStreams.delete(deploymentId), 120_000);
  }
}

// ── Legacy Direct Deploy (fallback for simple operations) ─────────────────────

export async function runDirectDeploy(app, deploymentId) {
  const db = getDB();
  const appId = app.id;

  const log = (msg) => {
    emitLog(deploymentId, msg);
    try {
      const existing = db.prepare('SELECT log FROM deployments WHERE id = ?').get(deploymentId);
      const current = existing?.log || '';
      if (current.length < 500_000) {
        db.prepare('UPDATE deployments SET log = log || ? WHERE id = ?').run(msg + '\n', deploymentId);
      }
    } catch {}
  };

  try {
    log(`🚀 Deploying ${app.name} [${new Date().toISOString()}]`);

    // Ensure shared network exists
    await ensureNetwork(PAAS_NETWORK);

    // Gather env vars
    const envRows = db.prepare('SELECT key, value FROM env_vars WHERE app_id = ?').all(appId);
    const envArr = envRows.map(r => `${r.key}=${r.value}`);

    // --- Build / pull ---
    let imageTag;
    if (app.git_url) {
      const result = await runBuildPipeline(app, deploymentId, log);
      imageTag = result.tag;
      db.prepare('UPDATE deployments SET commit_sha = ?, commit_message = ? WHERE id = ?')
        .run(result.commit.sha, result.commit.message, deploymentId);
    } else if (app.image) {
      log(`📦 Pulling image: ${app.image}`);
      await pullImage(app.image);
      imageTag = app.image;
      log(`✅ Image ready`);
    } else {
      throw new Error('App has no git_url or image configured');
    }

    // --- Tear down old container ---
    const containerName = `paas-${sanitizeContainerName(app.name)}`;
    const oldContainer = await getContainer(containerName).catch(() => null);
    if (oldContainer) {
      log(`🔄 Stopping old container...`);
      await stopContainer(containerName, 15).catch(() => {});
      await removeContainer(containerName, true).catch(() => {});
    }

    // --- Allocate host port ---
    const hostPort = await findFreePort();
    log(`🔌 Assigning host port ${hostPort}`);

    // --- Create and start container ---
    log(`📦 Creating container: ${containerName}`);

    // Resolve resource limits: app-level > defaults
    const memoryLimit = app.memory_limit || parseInt(process.env.DEFAULT_MEMORY_LIMIT || '536870912', 10); // 512MB
    const cpuLimit = app.cpu_limit || parseFloat(process.env.DEFAULT_CPU_LIMIT || '1.0');
    const resourceLimits = {};
    if (memoryLimit > 0) resourceLimits.memory = { limit: memoryLimit };
    if (cpuLimit > 0) resourceLimits.cpu = { quota: Math.round(cpuLimit * 100000), period: 100000 };

    const created = await createContainer({
      name: containerName,
      image: imageTag,
      env: envArr,
      portmappings: [{
        container_port: app.port || 3000,
        host_port: hostPort,
        protocol: 'tcp',
      }],
      networks: { [PAAS_NETWORK]: {} },
      restart_policy: 'unless-stopped',
      resource_limits: resourceLimits,
      labels: {
        'paas.app':     app.name,
        'paas.app_id':  app.id,
        'paas.managed': 'true',
        'paas.deployed_at': new Date().toISOString(),
      },
    });
    log(`✅ Container created (${created.Id?.substring(0, 12)})`);

    await startContainer(containerName);
    log(`✅ Container started`);

    // --- Register with reverse proxy ---
    const proxyResult = await registerAppRoute(app.name, app.domain || null, hostPort, {
      containerName,
    }).catch(err => {
      log(`⚠️  Reverse proxy routing skipped: ${err.message}`);
      return { host: `localhost:${hostPort}`, managed: false };
    });
    const host = proxyResult.host;
    if (proxyResult.managed) {
      log(`🌐 Accessible at: http://${host} (via ${proxyResult.managed ? 'proxy' : 'direct'})`);
      if (proxyResult.upstream) {
        log(`   ↳ Upstream: ${proxyResult.upstream}`);
      }
    } else {
      log(`🌐 Accessible at: http://${host} (proxy not managed)`);
    }

    // --- Persist success state ---
    db.prepare(`
      UPDATE apps SET
        status = 'running', image = ?, container_id = ?,
        host_port = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(imageTag, containerName, hostPort, appId);

    db.prepare(`
      UPDATE deployments SET status = 'success', finished_at = datetime('now') WHERE id = ?
    `).run(deploymentId);

    log(`\n🎉 Deployment complete!`);

  } catch (err) {
    log(`\n❌ Deployment failed: ${err.message}`);

    db.prepare(`UPDATE apps SET status = 'error', updated_at = datetime('now') WHERE id = ?`).run(appId);
    db.prepare(`UPDATE deployments SET status = 'failed', finished_at = datetime('now') WHERE id = ?`).run(deploymentId);

  } finally {
    // Keep stream alive 2 min for late-joining subscribers, then GC
    setTimeout(() => deployStreams.delete(deploymentId), 120_000);
  }
}

// ── Stop ─────────────────────────────────────────────────────────────────────

export async function stopApp(appId) {
  const db = getDB();
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(appId);
  if (!app) throw new Error('App not found');

  if (app.container_id) {
    await stopContainer(app.container_id, 15);
    await removeAppRoute(app.name).catch(() => {});
  }

  db.prepare(`UPDATE apps SET status = 'stopped', updated_at = datetime('now') WHERE id = ?`).run(appId);
}

// ── Restart ───────────────────────────────────────────────────────────────────

export async function restartApp(appId) {
  const db = getDB();
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(appId);
  if (!app) throw new Error('App not found');

  if (!app.container_id) throw new Error('No container to restart — deploy the app first');

  await restartContainer(app.container_id);
  db.prepare(`UPDATE apps SET status = 'running', updated_at = datetime('now') WHERE id = ?`).run(appId);
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteApp(appId) {
  const db = getDB();
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(appId);
  if (!app) throw new Error('App not found');

  if (app.container_id) {
    await stopContainer(app.container_id, 5).catch(() => {});
    await removeContainer(app.container_id, true).catch(() => {});
    await removeAppRoute(app.name).catch(() => {});
    
    // Clean up the image if it was built for this app
    if (app.image && app.image.startsWith('paas-')) {
      try {
        const { removeImage } = await import('./podman.js');
        await removeImage(app.image, true);
        console.log(`[Deploy] Removed image ${app.image} for app ${app.name}`);
      } catch (err) {
        console.warn(`[Deploy] Failed to remove image ${app.image}:`, err.message);
      }
    }
  }

  db.prepare('DELETE FROM apps WHERE id = ?').run(appId);
}
