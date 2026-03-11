/**
 * Exec Utilities
 * 
 * Promise-based wrappers for child_process
 */

import { exec } from 'child_process';
import { promisify } from 'util';

export const execAsync = promisify(exec);
