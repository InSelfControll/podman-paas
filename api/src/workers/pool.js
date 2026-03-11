/**
 * Piscina Worker Pool Manager
 * 
 * Manages CPU-intensive tasks using worker threads via Piscina.
 * Provides pools for bcrypt operations and deployment jobs.
 */

import { Piscina } from 'piscina';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Track created pools for cleanup
const pools = new Map();

/**
 * Get or create the bcrypt worker pool
 */
export function getCryptoPool() {
  if (!pools.has('crypto')) {
    const pool = new Piscina({
      filename: join(__dirname, 'crypto.worker.js'),
      minThreads: 2,
      maxThreads: 4,
      idleTimeout: 60000, // Keep threads alive for 1 min
      concurrentTasksPerWorker: 1, // bcrypt is CPU-bound, don't multiplex
    });
    
    pool.on('error', (err) => {
      console.error('[CryptoPool] Worker error:', err);
    });
    
    pools.set('crypto', pool);
  }
  
  return pools.get('crypto');
}

/**
 * Get or create the deployment worker pool
 * 
 * Note: Each deployment runs in its own worker, but we limit
 * concurrent deployments via the pool size.
 */
export function getDeploymentPool() {
  if (!pools.has('deployment')) {
    const pool = new Piscina({
      filename: join(__dirname, 'deployment.worker.js'),
      minThreads: 1,
      maxThreads: parseInt(process.env.DEPLOY_CONCURRENCY || '2', 10),
      idleTimeout: 300000, // 5 minutes - deployments can be slow
      concurrentTasksPerWorker: 1, // One deployment per worker
    });
    
    pool.on('error', (err) => {
      console.error('[DeploymentPool] Worker error:', err);
    });
    
    pools.set('deployment', pool);
  }
  
  return pools.get('deployment');
}

/**
 * Run a bcrypt hash operation in a worker
 * @param {string} password - Password to hash
 * @param {number} rounds - Bcrypt cost factor
 * @returns {Promise<string>} - Bcrypt hash
 */
export async function runCryptoHash(password, rounds = 12) {
  const pool = getCryptoPool();
  return pool.run({ type: 'hash', password, rounds });
}

/**
 * Run a bcrypt compare operation in a worker
 * @param {string} password - Plain text password
 * @param {string} hash - Bcrypt hash to compare
 * @returns {Promise<boolean>} - True if match
 */
export async function runCryptoCompare(password, hash) {
  const pool = getCryptoPool();
  return pool.run({ type: 'compare', password, hash });
}

/**
 * Run a deployment job in a worker
 * @param {Object} jobData - Deployment job data
 * @returns {Promise<Object>} - Deployment result
 */
export async function runDeploymentJob(jobData) {
  const pool = getDeploymentPool();
  return pool.run(jobData);
}

/**
 * Get pool statistics
 */
export function getPoolStats() {
  const stats = {};
  
  for (const [name, pool] of pools) {
    stats[name] = {
      threads: pool.threads.length,
      queueSize: pool.queueSize,
      completed: pool.completed,
      duration: pool.duration,
      utilization: pool.utilization,
    };
  }
  
  return stats;
}

/**
 * Gracefully shutdown all pools
 */
export async function shutdownPools() {
  console.log('[WorkerPool] Shutting down worker pools...');
  
  const shutdownPromises = [];
  
  for (const [name, pool] of pools) {
    shutdownPromises.push(
      pool.destroy().then(() => {
        console.log(`[WorkerPool] ${name} pool shut down`);
      }).catch(err => {
        console.error(`[WorkerPool] Error shutting down ${name} pool:`, err);
      })
    );
  }
  
  await Promise.all(shutdownPromises);
  pools.clear();
}
