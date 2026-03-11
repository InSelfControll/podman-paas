/**
 * Crypto Worker Thread
 * 
 * Offloads CPU-intensive bcrypt operations from the main event loop.
 * This prevents blocking during authentication operations.
 */

import { parentPort } from 'worker_threads';
import bcrypt from 'bcryptjs';

parentPort.once('message', ({ type, password, hash, rounds }) => {
  try {
    if (type === 'hash') {
      const result = bcrypt.hashSync(password, rounds);
      parentPort.postMessage({ success: true, hash: result });
    } else if (type === 'compare') {
      const result = bcrypt.compareSync(password, hash);
      parentPort.postMessage({ success: true, valid: result });
    } else {
      parentPort.postMessage({ success: false, error: 'Unknown operation type' });
    }
  } catch (err) {
    parentPort.postMessage({ success: false, error: err.message });
  }
});
