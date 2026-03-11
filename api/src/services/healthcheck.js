import { getDB } from '../db/database.js';
import { listContainers, getContainer } from './podman.js';

let healthCheckInterval = null;
let logPruneInterval = null;

// Default retention: 30 days for deployment logs
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '30', 10);
// Max log size per deployment: 500KB
const MAX_LOG_SIZE = 500_000;
// Prune interval: every 6 hours
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Start the background health checker
 * Periodically checks if apps/stacks are actually running and updates status
 */
export function startHealthChecker(logger) {
  if (healthCheckInterval) return; // Already running
  
  const CHECK_INTERVAL_MS = 30000; // Check every 30 seconds
  
  healthCheckInterval = setInterval(async () => {
    try {
      await checkAppsHealth();
      await checkStacksHealth();
    } catch (err) {
      logger?.error({ err }, 'Health check failed');
    }
  }, CHECK_INTERVAL_MS);
  
  logger?.info('Health checker started (interval: 30s)');
}

/**
 * Stop the health checker
 */
export function stopHealthChecker() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

/**
 * Check health of all apps and update status if needed
 */
async function checkAppsHealth() {
  const db = getDB();
  const apps = db.prepare("SELECT id, name, container_id, status FROM apps WHERE status IN ('running', 'starting')").all();
  
  if (apps.length === 0) return;
  
  for (const app of apps) {
    try {
      if (!app.container_id) continue;
      
      const container = await getContainer(app.container_id);
      const actualState = container?.State?.Status || 'unknown';
      
      // Map container state to app status
      let expectedStatus = app.status;
      if (actualState === 'running') expectedStatus = 'running';
      else if (actualState === 'exited' || actualState === 'dead') expectedStatus = 'error';
      else if (actualState === 'paused') expectedStatus = 'stopped';
      
      // Update if status changed
      if (expectedStatus !== app.status) {
        db.prepare("UPDATE apps SET status = ?, updated_at = datetime('now') WHERE id = ?")
          .run(expectedStatus, app.id);
        console.log(`[HealthCheck] App ${app.name}: ${app.status} → ${expectedStatus}`);
      }
    } catch (err) {
      // Container not found or other error
      if (app.status !== 'error') {
        db.prepare("UPDATE apps SET status = 'error', updated_at = datetime('now') WHERE id = ?")
          .run(app.id);
        console.log(`[HealthCheck] App ${app.name}: ${app.status} → error (container check failed)`);
      }
    }
  }
}

/**
 * Check health of all stacks and update status if needed
 */
async function checkStacksHealth() {
  const db = getDB();
  const stacks = db.prepare("SELECT id, name, status, container_ids FROM stacks WHERE status IN ('running', 'starting', 'restarting')").all();
  
  if (stacks.length === 0) return;
  
  // Get all containers once for efficiency
  let allContainers;
  try {
    allContainers = await listContainers(true);
  } catch (err) {
    console.warn('[HealthCheck] Failed to list containers:', err.message);
    return;
  }
  
  for (const stack of stacks) {
    try {
      // Try multiple strategies to find stack containers
      let stackContainers = findStackContainers(stack, allContainers);
      
      // If no containers found and we have stored IDs, try to find by those
      if (stackContainers.length === 0 && stack.container_ids) {
        try {
          const storedIds = JSON.parse(stack.container_ids || '[]');
          stackContainers = allContainers.filter(c => {
            const id = c.Id || c.id;
            return storedIds.includes(id) || storedIds.includes(id?.substring(0, 12));
          });
        } catch {}
      }
      
      if (stackContainers.length === 0) {
        // No containers found - stack is not actually running
        if (stack.status !== 'stopped') {
          db.prepare("UPDATE stacks SET status = 'stopped', updated_at = datetime('now') WHERE id = ?")
            .run(stack.id);
          console.log(`[HealthCheck] Stack ${stack.name}: ${stack.status} → stopped (no containers)`);
        }
        continue;
      }
      
      // Count running containers
      const runningCount = stackContainers.filter(c => 
        (c.State?.Status || c.state) === 'running'
      ).length;
      
      // Update container IDs
      const containerIds = stackContainers.map(c => c.Id || c.id);
      db.prepare('UPDATE stacks SET container_ids = ? WHERE id = ?')
        .run(JSON.stringify(containerIds), stack.id);
      
      // Determine health status
      const totalCount = stackContainers.length;
      let newStatus = stack.status;
      
      if (runningCount === 0) {
        newStatus = 'error';
      } else if (runningCount < totalCount) {
        // Partial degradation - still running but not all containers
        newStatus = 'running'; // Keep as running but log warning
        console.log(`[HealthCheck] Stack ${stack.name}: ${runningCount}/${totalCount} containers running`);
      } else {
        newStatus = 'running';
      }
      
      if (newStatus !== stack.status) {
        db.prepare("UPDATE stacks SET status = ?, updated_at = datetime('now') WHERE id = ?")
          .run(newStatus, stack.id);
        console.log(`[HealthCheck] Stack ${stack.name}: ${stack.status} → ${newStatus}`);
      }
    } catch (err) {
      console.warn(`[HealthCheck] Stack ${stack.name} check failed:`, err.message);
    }
  }
}

/**
 * Find containers belonging to a stack using multiple strategies
 */
function findStackContainers(stack, allContainers) {
  const stackName = stack.name;
  
  return allContainers.filter(c => {
    const name = (c.Names?.[0] || '').replace(/^\//, '');
    const labels = c.Labels || c.labels || {};
    
    // Strategy 1: Check compose labels (most reliable)
    const composeProject = labels['com.docker.compose.project'] || labels['io.podman.compose.project'];
    if (composeProject) {
      // Project name might match stack name or contain it
      if (composeProject === stackName || composeProject.includes(stackName)) {
        return true;
      }
    }
    
    // Strategy 2: Check for podman-paas-stacks prefix (our default dir)
    // Pattern: podman-paas-stacks_{stackname}_{service}_{index} or podman-paas-stacks_{servicename}_{index}
    if (name.includes(`stacks_${stackName}_`) || name.includes(`stacks-${stackName}-`)) {
      return true;
    }
    
    // Strategy 2b: The project name is "podman-paas-stacks" and service might contain stack name
    // Pattern: podman-paas-stacks_{servicename}_1 where servicename might relate to stack
    if (name.startsWith('podman-paas-stacks_')) {
      // Check if stack name appears anywhere in the container name after the prefix
      const afterPrefix = name.substring('podman-paas-stacks_'.length);
      if (afterPrefix.toLowerCase().includes(stackName.toLowerCase())) {
        return true;
      }
      // Also check if this might be a single-service stack with matching name
      // e.g., stack name "daemon" and container "podman-paas-stacks_daemon_1"
      const serviceName = afterPrefix.split('_')[0];
      if (serviceName && (serviceName === stackName || serviceName.toLowerCase() === stackName.toLowerCase())) {
        return true;
      }
    }
    
    // Strategy 3: Name starts with stack name variations
    if (name.startsWith(`${stackName}_`) || name.startsWith(`${stackName}-`)) {
      return true;
    }
    
    // Strategy 4: Name contains stack name with underscore (compose pattern)
    if (name.includes(`_${stackName}_`) || name.includes(`-${stackName}-`)) {
      return true;
    }
    
    // Strategy 5: Check if stack name is in the name anywhere (broader match)
    if (name.toLowerCase().includes(stackName.toLowerCase())) {
      // Be more careful here - require some delimiter
      const pattern = new RegExp(`[_-]${stackName}[_-]|^${stackName}[_-]|[_-]${stackName}$`, 'i');
      if (pattern.test(name)) {
        return true;
      }
    }
    
    return false;
  });
}

/**
 * Manual health check for a specific app
 */
export async function checkAppHealth(appId) {
  const db = getDB();
  const app = db.prepare('SELECT container_id, status FROM apps WHERE id = ?').get(appId);
  if (!app) return { healthy: false, error: 'App not found' };
  
  if (!app.container_id) {
    return { healthy: false, status: app.status, error: 'No container assigned' };
  }
  
  try {
    const container = await getContainer(app.container_id);
    const state = container?.State?.Status;
    const healthy = state === 'running';
    
    return {
      healthy,
      status: state,
      containerId: app.container_id,
      health: container?.State?.Health?.Status || 'unknown',
    };
  } catch (err) {
    return { healthy: false, status: 'error', error: err.message };
  }
}

/**
 * Manual health check for a specific stack
 */
export async function checkStackHealth(stackId) {
  const db = getDB();
  const stack = db.prepare('SELECT name, status FROM stacks WHERE id = ?').get(stackId);
  if (!stack) return { healthy: false, error: 'Stack not found' };
  
  try {
    const containers = await listContainers(true);
    const stackContainers = findStackContainers(stack, containers);
    
    const runningCount = stackContainers.filter(c => 
      (c.State?.Status || c.state) === 'running'
    ).length;
    
    return {
      healthy: runningCount > 0,
      status: stack.status,
      containers: {
        total: stackContainers.length,
        running: runningCount,
      },
    };
  } catch (err) {
    return { healthy: false, status: 'error', error: err.message };
  }
}

// ── Log Pruning ─────────────────────────────────────────────────────────────

/**
 * Start background log pruning task
 * Prevents SQLite database bloat by cleaning old deployment logs
 */
export function startLogPruning(logger) {
  if (logPruneInterval) return; // Already running
  
  // Run immediately on startup
  pruneOldLogs(logger);
  
  // Schedule periodic pruning
  logPruneInterval = setInterval(() => {
    pruneOldLogs(logger);
  }, PRUNE_INTERVAL_MS);
  
  logger?.info(`[LogPrune] Started log pruning (retention: ${LOG_RETENTION_DAYS} days, interval: 6h)`);
}

/**
 * Stop the log pruning task
 */
export function stopLogPruning() {
  if (logPruneInterval) {
    clearInterval(logPruneInterval);
    logPruneInterval = null;
  }
}

/**
 * Prune old deployment logs and truncate oversized logs
 */
async function pruneOldLogs(logger) {
  const db = getDB();
  
  try {
    // 1. Delete old completed/failed deployments
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - LOG_RETENTION_DAYS);
    const cutoffIso = cutoffDate.toISOString();
    
    const oldDeployments = db.prepare(`
      SELECT id, app_id, started_at FROM deployments
      WHERE status IN ('success', 'failed')
      AND finished_at < ?
    `).all(cutoffIso);
    
    if (oldDeployments.length > 0) {
      // Delete in batches to avoid locking the DB for too long
      const batchSize = 100;
      let deletedCount = 0;
      
      for (let i = 0; i < oldDeployments.length; i += batchSize) {
        const batch = oldDeployments.slice(i, i + batchSize);
        const ids = batch.map(d => d.id);
        const placeholders = ids.map(() => '?').join(',');
        
        const result = db.prepare(`
          DELETE FROM deployments WHERE id IN (${placeholders})
        `).run(...ids);
        
        deletedCount += result.changes;
      }
      
      logger?.info(`[LogPrune] Deleted ${deletedCount} old deployments (older than ${LOG_RETENTION_DAYS} days)`);
    }
    
    // 2. Truncate oversized logs for active deployments
    const oversizedLogs = db.prepare(`
      SELECT id, LENGTH(log) as log_size FROM deployments
      WHERE LENGTH(log) > ?
    `).all(MAX_LOG_SIZE);
    
    for (const deployment of oversizedLogs) {
      // Keep first 100KB and last 400KB of the log
      const keepStart = 100_000;
      const keepEnd = 400_000;
      
      db.prepare(`
        UPDATE deployments
        SET log = (
          SELECT SUBSTR(log, 1, ?) || 
                 '\n\n... [LOG TRUNCATED - too large] ...\n\n' || 
                 SUBSTR(log, -?)
        )
        WHERE id = ?
      `).run(keepStart, keepEnd, deployment.id);
    }
    
    if (oversizedLogs.length > 0) {
      logger?.info(`[LogPrune] Truncated ${oversizedLogs.length} oversized logs`);
    }
    
    // 3. Also clean up old job logs
    const oldJobs = db.prepare(`
      SELECT id FROM deployment_jobs
      WHERE status IN ('completed', 'failed', 'cancelled')
      AND finished_at < datetime('now', '-${LOG_RETENTION_DAYS} days')
    `).all();
    
    if (oldJobs.length > 0) {
      const ids = oldJobs.map(j => j.id);
      const placeholders = ids.map(() => '?').join(',');
      
      db.prepare(`
        DELETE FROM deployment_jobs WHERE id IN (${placeholders})
      `).run(...ids);
      
      logger?.info(`[LogPrune] Deleted ${oldJobs.length} old job records`);
    }
    
    // 4. Run VACUUM to reclaim space (only if significant deletions occurred)
    const totalDeleted = oldDeployments.length + oldJobs.length;
    if (totalDeleted > 50) {
      logger?.info('[LogPrune] Running VACUUM to reclaim disk space...');
      db.exec('VACUUM');
      logger?.info('[LogPrune] VACUUM complete');
    }
    
  } catch (err) {
    logger?.error({ err }, '[LogPrune] Error during log pruning');
  }
}
