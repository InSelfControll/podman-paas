import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { getDB } from '../db/database.js';
import { listContainers, ensureNetwork, stopContainer, removeContainer, removeImage } from './podman.js';
import { sanitizeComposeForPodman, checkDockerDependencies } from './compose-sanitizer.js';

const STACKS_DIR = process.env.STACKS_DIR || '/tmp/podman-paas-stacks';
mkdirSync(STACKS_DIR, { recursive: true });

const PAAS_NETWORK = 'podman-paas';

/**
 * Run podman-compose command with proper error handling and output capture
 */
export function runCompose(filePath, content, args, options = {}) {
  return new Promise((resolve, reject) => {
    // Ensure directory exists
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    
    // Write compose file
    writeFileSync(filePath, content);
    
    // Detect if we should use podman-compose or docker-compose
    const composeCmd = process.env.COMPOSE_CMD || 'podman-compose';
    
    // Build args with project name if provided
    const projectName = options.projectName || options.project;
    const composeArgs = ['-f', filePath];
    if (projectName) {
      composeArgs.push('-p', projectName);
    }
    composeArgs.push(...args);
    
    console.log(`[Stacks] Running: ${composeCmd} ${composeArgs.join(' ')} in ${dir}`);
    
    const proc = spawn(composeCmd, composeArgs, {
      stdio: 'pipe',
      timeout: options.timeout || 5 * 60 * 1000,
      cwd: dir,
      env: {
        ...process.env,
        // Ensure podman socket is available for compose
        DOCKER_HOST: process.env.PODMAN_SOCKET 
          ? `unix://${process.env.PODMAN_SOCKET}`
          : process.env.DOCKER_HOST,
      }
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', d => { 
      const str = d.toString();
      stdout += str;
      if (options.onOutput) options.onOutput(str);
    });
    
    proc.stderr.on('data', d => { 
      const str = d.toString();
      stderr += str;
      if (options.onOutput) options.onOutput(str);
    });
    
    proc.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`Compose exited with code ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`);
        error.code = code;
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
      }
    });
    
    proc.on('error', err => {
      err.message = `Failed to run ${composeCmd}: ${err.message}. Is podman-compose installed?`;
      reject(err);
    });
  });
}

/**
 * Get containers associated with a stack by labels or names
 */
async function getStackContainers(stackName) {
  try {
    const containers = await listContainers(true);
    // Look for containers with compose project label matching stack name
    return containers.filter(c => {
      const labels = c.Labels || {};
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      
      // Check compose project label (most reliable)
      const project = labels['com.docker.compose.project'] || labels['io.podman.compose.project'];
      if (project === stackName || 
          (typeof project === 'string' && project.toLowerCase() === stackName.toLowerCase())) {
        return true;
      }
      
      // Check container name patterns
      // Pattern: {stackname}_{service}_{index}
      if (name.startsWith(`${stackName}_`) || name.startsWith(`${stackName}-`)) {
        return true;
      }
      
      // Pattern: podman-paas-stacks_{stackname}_{service}_{index} (legacy)
      if (name.includes(`stacks_${stackName}_`) || name.includes(`stacks-${stackName}-`)) {
        return true;
      }
      
      // Name contains stack name as a word/segment
      if (name.toLowerCase().includes(stackName.toLowerCase())) {
        const pattern = new RegExp(`[_-]${stackName}[_-]|^${stackName}[_-]|[_-]${stackName}$`, 'i');
        if (pattern.test(name)) {
          return true;
        }
      }
      
      return false;
    });
  } catch (err) {
    console.warn(`[Stacks] Failed to list containers for stack ${stackName}:`, err.message);
    return [];
  }
}

/**
 * Deploy a stack - run compose up and track resulting containers
 */
export async function deployStack(stackId) {
  const db = getDB();
  const s = db.prepare('SELECT * FROM stacks WHERE id = ?').get(stackId);
  if (!s) throw new Error('Stack not found');

  // Update status to starting
  db.prepare(`UPDATE stacks SET status = 'starting', updated_at = datetime('now') WHERE id = ?`).run(s.id);
  
  const composeFile = join(STACKS_DIR, `${s.name}.yml`);
  const logLines = [];
  
  // Check for Docker dependencies and warn user
  const deps = checkDockerDependencies(s.compose_content);
  for (const dep of deps) {
    if (dep.type === 'error') {
      console.error(`[Stacks] ERROR: ${dep.message}`);
      logLines.push(`ERROR: ${dep.message}`);
    } else {
      console.warn(`[Stacks] WARNING: ${dep.message}`);
      logLines.push(`WARNING: ${dep.message}`);
    }
  }
  
  // Sanitize compose content for Podman compatibility
  const sanitizedCompose = sanitizeComposeForPodman(s.compose_content);
  
  const onOutput = (line) => {
    logLines.push(line);
    console.log(`[Stack ${s.name}]`, line.trim());
  };

  try {
    // Ensure shared network exists
    await ensureNetwork(PAAS_NETWORK);
    
    // Run compose up with project name set to stack name
    await runCompose(composeFile, sanitizedCompose, ['up', '-d', '--remove-orphans'], {
      onOutput,
      timeout: 10 * 60 * 1000, // 10 min timeout for large stacks
      projectName: s.name, // This ensures containers are named {stackname}_{service}_1
    });
    
    // Wait a moment for containers to start
    await new Promise(r => setTimeout(r, 2000));
    
    // Get the actual containers created
    const containers = await getStackContainers(s.name);
    const containerIds = containers.map(c => c.Id || c.id).filter(Boolean);
    
    console.log(`[Stacks] Stack ${s.name} deployed with ${containerIds.length} containers:`, containerIds);
    
    // Update stack with container IDs and status
    db.prepare(`
      UPDATE stacks SET 
        status = 'running', 
        container_ids = ?,
        updated_at = datetime('now') 
      WHERE id = ?
    `).run(JSON.stringify(containerIds), s.id);
    
    return { success: true, containerCount: containerIds.length };
    
  } catch (err) {
    console.error(`[Stacks] Deploy failed for ${s.name}:`, err.message);
    
    db.prepare(`
      UPDATE stacks SET 
        status = 'error', 
        error_message = ?,
        updated_at = datetime('now') 
      WHERE id = ?
    `).run(err.message.slice(0, 500), s.id);
    
    throw err;
  }
}

/**
 * Stop a stack - run compose down and manually remove containers
 */
export async function stopStack(stackId, removeImages = false) {
  const db = getDB();
  const s = db.prepare('SELECT * FROM stacks WHERE id = ?').get(stackId);
  if (!s) throw new Error('Stack not found');
  
  const composeFile = join(STACKS_DIR, `${s.name}.yml`);
  
  // First, get all containers associated with this stack
  const containers = await getStackContainers(s.name);
  console.log(`[Stacks] Stopping stack ${s.name}, found ${containers.length} containers`);
  
  // Sanitize compose content
  const sanitizedCompose = sanitizeComposeForPodman(s.compose_content);
  
  // Try compose down first
  try {
    const args = removeImages ? ['down', '--rmi', 'all'] : ['down'];
    await runCompose(composeFile, sanitizedCompose, args, { 
      timeout: 120000,
      projectName: s.name,
    });
    console.log(`[Stacks] Compose down completed for ${s.name}`);
  } catch (err) {
    console.warn(`[Stacks] Compose down warning for ${s.name}:`, err.message);
    // Continue to manual cleanup
  }
  
  // Manually stop and remove containers to ensure they're really gone
  for (const container of containers) {
    const containerId = container.Id || container.id;
    const containerName = (container.Names?.[0] || containerId || 'unknown').replace(/^\//, '');
    
    try {
      console.log(`[Stacks] Stopping container ${containerName}`);
      await stopContainer(containerId, 10).catch(() => {});
      
      console.log(`[Stacks] Removing container ${containerName}`);
      await removeContainer(containerId, true);
      
      // Get image info before removal
      const imageName = container.Image || container.ImageID;
      
      // Remove image if requested and it's not a base image
      if (removeImages && imageName) {
        try {
          // Skip if it's a common base image
          const baseImages = ['alpine', 'ubuntu', 'debian', 'nginx', 'postgres', 'mysql', 'redis', 'node'];
          const isBaseImage = baseImages.some(base => imageName.includes(base));
          
          if (!isBaseImage) {
            console.log(`[Stacks] Removing image ${imageName}`);
            await removeImage(imageName, false);
          } else {
            console.log(`[Stacks] Skipping base image ${imageName}`);
          }
        } catch (imgErr) {
          console.warn(`[Stacks] Failed to remove image ${imageName}:`, imgErr.message);
        }
      }
    } catch (err) {
      console.warn(`[Stacks] Failed to remove container ${containerName}:`, err.message);
    }
  }
  
  db.prepare(`
    UPDATE stacks SET 
      status = 'stopped', 
      updated_at = datetime('now') 
    WHERE id = ?
  `).run(s.id);
}

/**
 * Restart a stack
 */
export async function restartStack(stackId) {
  const db = getDB();
  const s = db.prepare('SELECT * FROM stacks WHERE id = ?').get(stackId);
  if (!s) throw new Error('Stack not found');
  
  const composeFile = join(STACKS_DIR, `${s.name}.yml`);
  const sanitizedCompose = sanitizeComposeForPodman(s.compose_content);
  
  db.prepare(`UPDATE stacks SET status = 'restarting', updated_at = datetime('now') WHERE id = ?`).run(s.id);
  
  try {
    await runCompose(composeFile, sanitizedCompose, ['restart'], { 
      timeout: 60000,
      projectName: s.name,
    });
    
    // Update container IDs after restart
    const containers = await getStackContainers(s.name);
    const containerIds = containers.map(c => c.Id || c.id).filter(Boolean);
    
    db.prepare(`
      UPDATE stacks SET 
        status = 'running', 
        container_ids = ?,
        updated_at = datetime('now') 
      WHERE id = ?
    `).run(JSON.stringify(containerIds), s.id);
    
    return { success: true };
  } catch (err) {
    db.prepare(`
      UPDATE stacks SET 
        status = 'error', 
        error_message = ?,
        updated_at = datetime('now') 
      WHERE id = ?
    `).run(err.message.slice(0, 500), s.id);
    throw err;
  }
}

/**
 * Get stack status with live container info
 */
export async function getStackStatus(stackId) {
  const db = getDB();
  const s = db.prepare('SELECT * FROM stacks WHERE id = ?').get(stackId);
  if (!s) return null;
  
  const containers = await getStackContainers(s.name);
  const runningCount = containers.filter(c => 
    (c.State?.Status || c.state) === 'running'
  ).length;
  
  return {
    ...s,
    live_containers: containers,
    running_count: runningCount,
    total_count: containers.length,
    healthy: runningCount > 0 && runningCount === containers.length,
  };
}

/**
 * Get logs from all containers in a stack
 */
export async function getStackLogs(stackId, tail = 100) {
  const db = getDB();
  const s = db.prepare('SELECT * FROM stacks WHERE id = ?').get(stackId);
  if (!s) throw new Error('Stack not found');
  
  const composeFile = join(STACKS_DIR, `${s.name}.yml`);
  
  return new Promise((resolve, reject) => {
    const proc = spawn('podman-compose', ['-f', composeFile, '-p', s.name, 'logs', '--tail', String(tail)], {
      stdio: 'pipe',
      timeout: 30000,
    });
    
    let output = '';
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => output += d.toString());
    
    proc.on('close', code => {
      resolve(output || '[No logs available]');
    });
    
    proc.on('error', err => {
      reject(new Error(`Failed to get logs: ${err.message}`));
    });
  });
}
