/**
 * Crypto Worker for Piscina
 * 
 * Handles CPU-intensive bcrypt operations off the main thread.
 * This worker is managed by the Piscina pool.
 */

import bcrypt from 'bcryptjs';

/**
 * Main export function called by Piscina
 * @param {Object} task - The task to execute
 * @returns {Promise<string|boolean>} - Hash string or compare result
 */
export default async function cryptoWorker(task) {
  const { type, password, hash, rounds } = task;
  
  try {
    if (type === 'hash') {
      // CPU-intensive bcrypt hash
      const result = bcrypt.hashSync(password, rounds);
      return result;
    } 
    
    if (type === 'compare') {
      // CPU-intensive bcrypt compare
      const result = bcrypt.compareSync(password, hash);
      return result;
    }
    
    throw new Error(`Unknown crypto task type: ${type}`);
  } catch (err) {
    // Re-throw with more context
    throw new Error(`Crypto worker error (${type}): ${err.message}`);
  }
}
