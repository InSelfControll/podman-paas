/**
 * Crypto Service
 * 
 * Provides async bcrypt operations using worker threads.
 * This keeps the main event loop free during CPU-intensive hashing.
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'crypto-worker.js');

// Worker pool for efficiency (optional optimization)
const workerPool = [];
const MAX_WORKERS = 4;

function getWorker() {
  // Simple pool: return existing idle worker or create new
  const idleWorker = workerPool.find(w => !w.busy);
  if (idleWorker) {
    idleWorker.busy = true;
    return idleWorker.worker;
  }
  
  // Create new worker if under limit
  if (workerPool.length < MAX_WORKERS) {
    const worker = new Worker(WORKER_PATH);
    const workerWrapper = { worker, busy: true };
    
    worker.on('exit', () => {
      const idx = workerPool.indexOf(workerWrapper);
      if (idx > -1) workerPool.splice(idx, 1);
    });
    
    workerPool.push(workerWrapper);
    return worker;
  }
  
  // Wait for a worker to become available
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      const idle = workerPool.find(w => !w.busy);
      if (idle) {
        clearInterval(checkInterval);
        idle.busy = true;
        resolve(idle.worker);
      }
    }, 10);
  });
}

function releaseWorker(worker) {
  const wrapper = workerPool.find(w => w.worker === worker);
  if (wrapper) wrapper.busy = false;
}

function runCryptoWorker(type, data, timeoutMs = 30000) {
  return new Promise(async (resolve, reject) => {
    const startTime = Date.now();
    
    try {
      const worker = await getWorker();
      
      const timeoutId = setTimeout(() => {
        worker.terminate().catch(() => {});
        releaseWorker(worker);
        reject(new Error('Crypto operation timed out'));
      }, timeoutMs);
      
      const messageHandler = (result) => {
        clearTimeout(timeoutId);
        worker.off('message', messageHandler);
        worker.off('error', errorHandler);
        releaseWorker(worker);
        
        if (result.success) {
          resolve(result);
        } else {
          reject(new Error(result.error));
        }
      };
      
      const errorHandler = (err) => {
        clearTimeout(timeoutId);
        worker.off('message', messageHandler);
        worker.off('error', errorHandler);
        releaseWorker(worker);
        reject(err);
      };
      
      worker.on('message', messageHandler);
      worker.on('error', errorHandler);
      
      // Terminate any existing listeners to prevent leaks
      worker.removeAllListeners('message');
      worker.removeAllListeners('error');
      
      // Re-attach our handlers
      worker.on('message', messageHandler);
      worker.on('error', errorHandler);
      
      worker.postMessage({ type, ...data });
      
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Hash a password using bcrypt (async, non-blocking)
 * @param {string} password - Plain text password
 * @param {number} rounds - Bcrypt cost factor (default: 12)
 * @returns {Promise<string>} - Bcrypt hash
 */
export async function hashPassword(password, rounds = 12) {
  const result = await runCryptoWorker('hash', { password, rounds });
  return result.hash;
}

/**
 * Compare a password against a hash (async, non-blocking)
 * @param {string} password - Plain text password
 * @param {string} hash - Bcrypt hash to compare against
 * @returns {Promise<boolean>} - True if password matches
 */
export async function comparePassword(password, hash) {
  const result = await runCryptoWorker('compare', { password, hash });
  return result.valid;
}

/**
 * Clean up all workers (call on shutdown)
 */
export async function cleanupWorkers() {
  await Promise.all(workerPool.map(w => w.worker.terminate().catch(() => {})));
  workerPool.length = 0;
}
