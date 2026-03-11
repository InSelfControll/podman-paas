/**
 * Volume Management Service
 * 
 * Manages persistent volumes for applications and stacks.
 * Integrates with Podman volumes API.
 */

import { getDB } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';
import {
  createVolume as createPodmanVolume,
  listVolumes as listPodmanVolumes,
  removeVolume as removePodmanVolume,
  inspectVolume as inspectPodmanVolume,
} from './podman.js';

/**
 * Sanitize volume name for Docker/Podman compatibility
 */
function sanitizeVolumeName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
    .replace(/^[^a-z0-9]/, 'a')
    .substring(0, 64); // Docker volume names can be longer than container names
}

/**
 * Create a new volume
 */
export async function createVolume(data) {
  const db = getDB();
  const id = uuidv4();
  const sanitizedName = sanitizeVolumeName(data.name);
  
  // Check for name collision
  const existing = db.prepare('SELECT id FROM volumes WHERE name = ?').get(sanitizedName);
  if (existing) {
    throw new Error(`Volume "${sanitizedName}" already exists`);
  }
  
  // Create in Podman first
  const driver = data.driver || 'local';
  const driverOpts = data.driver_opts || {};
  const labels = {
    'paas.managed': 'true',
    'paas.volume_id': id,
    ...data.labels
  };
  
  try {
    const podmanVolume = await createPodmanVolume(sanitizedName, {
      driver,
      driver_opts: driverOpts,
      labels,
    });
    
    // Persist to DB
    db.prepare(`
      INSERT INTO volumes (id, name, driver, mount_point, size_mb, labels)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sanitizedName,
      driver,
      podmanVolume.Mountpoint || null,
      data.size_mb || null,
      JSON.stringify(labels)
    );
    
    return {
      id,
      name: sanitizedName,
      driver,
      mount_point: podmanVolume.Mountpoint,
      labels
    };
  } catch (err) {
    throw new Error(`Failed to create volume: ${err.message}`);
  }
}

/**
 * List all volumes with Podman state sync
 */
export async function listVolumes() {
  const db = getDB();
  
  // Get all volumes from DB
  const dbVolumes = db.prepare(`
    SELECT v.*, 
      (SELECT COUNT(*) FROM volume_mounts vm WHERE vm.volume_id = v.id) as mount_count
    FROM volumes v
    ORDER BY v.created_at DESC
  `).all();
  
  // Get current Podman volumes for sync
  let podmanVolumes;
  try {
    podmanVolumes = await listPodmanVolumes();
  } catch (err) {
    console.warn('[Volumes] Failed to list Podman volumes:', err.message);
    podmanVolumes = [];
  }
  
  const podmanMap = new Map(podmanVolumes.map(v => [v.Name, v]));
  
  return dbVolumes.map(v => {
    const podmanVol = podmanMap.get(v.name);
    return {
      id: v.id,
      name: v.name,
      driver: v.driver,
      mount_point: v.mount_point,
      size_mb: v.size_mb,
      labels: JSON.parse(v.labels || '{}'),
      created_at: v.created_at,
      mount_count: v.mount_count,
      podman_state: podmanVol ? {
        name: podmanVol.Name,
        driver: podmanVol.Driver,
        mountpoint: podmanVol.Mountpoint,
        created_at: podmanVol.CreatedAt,
        labels: podmanVol.Labels
      } : null,
      orphaned: !podmanVol // Volume exists in DB but not in Podman
    };
  });
}

/**
 * Get a single volume by ID
 */
export async function getVolume(volumeId) {
  const db = getDB();
  
  const volume = db.prepare('SELECT * FROM volumes WHERE id = ?').get(volumeId);
  if (!volume) {
    throw new Error('Volume not found');
  }
  
  // Get mount information
  const mounts = db.prepare(`
    SELECT vm.*, a.name as app_name, s.name as stack_name
    FROM volume_mounts vm
    LEFT JOIN apps a ON vm.app_id = a.id
    LEFT JOIN stacks s ON vm.stack_id = s.id
    WHERE vm.volume_id = ?
  `).all(volumeId);
  
  // Get Podman state
  let podmanState = null;
  try {
    podmanState = await inspectPodmanVolume(volume.name);
  } catch (err) {
    console.warn(`[Volumes] Volume ${volume.name} not found in Podman`);
  }
  
  return {
    id: volume.id,
    name: volume.name,
    driver: volume.driver,
    mount_point: volume.mount_point,
    size_mb: volume.size_mb,
    labels: JSON.parse(volume.labels || '{}'),
    created_at: volume.created_at,
    mounts: mounts.map(m => ({
      id: m.id,
      container_path: m.container_path,
      read_only: m.read_only === 1,
      app: m.app_id ? { id: m.app_id, name: m.app_name } : null,
      stack: m.stack_id ? { id: m.stack_id, name: m.stack_name } : null
    })),
    podman_state: podmanState
  };
}

/**
 * Attach a volume to an app or stack
 */
export async function attachVolume(volumeId, target) {
  const db = getDB();
  
  // Verify volume exists
  const volume = db.prepare('SELECT id, name FROM volumes WHERE id = ?').get(volumeId);
  if (!volume) {
    throw new Error('Volume not found');
  }
  
  // Validate target
  if (!target.app_id && !target.stack_id) {
    throw new Error('Either app_id or stack_id is required');
  }
  if (!target.container_path) {
    throw new Error('container_path is required');
  }
  
  // Check for duplicate mount
  const existing = db.prepare(`
    SELECT id FROM volume_mounts 
    WHERE volume_id = ? AND (
      (app_id = ? AND ? IS NOT NULL) OR 
      (stack_id = ? AND ? IS NOT NULL)
    )
  `).get(volumeId, target.app_id || null, target.app_id || null, target.stack_id || null, target.stack_id || null);
  
  if (existing) {
    throw new Error('Volume is already mounted to this app/stack');
  }
  
  // Create mount record
  const mountId = uuidv4();
  db.prepare(`
    INSERT INTO volume_mounts (id, volume_id, app_id, stack_id, container_path, read_only)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    mountId,
    volumeId,
    target.app_id || null,
    target.stack_id || null,
    target.container_path,
    target.read_only ? 1 : 0
  );
  
  return { mountId };
}

/**
 * Detach a volume from an app or stack
 */
export async function detachVolume(mountId) {
  const db = getDB();
  
  const mount = db.prepare('SELECT * FROM volume_mounts WHERE id = ?').get(mountId);
  if (!mount) {
    throw new Error('Mount not found');
  }
  
  db.prepare('DELETE FROM volume_mounts WHERE id = ?').run(mountId);
  
  return { success: true };
}

/**
 * Delete a volume (only if not in use)
 */
export async function deleteVolume(volumeId) {
  const db = getDB();
  
  const volume = db.prepare('SELECT name FROM volumes WHERE id = ?').get(volumeId);
  if (!volume) {
    throw new Error('Volume not found');
  }
  
  // Check if in use
  const mounts = db.prepare('SELECT COUNT(*) as c FROM volume_mounts WHERE volume_id = ?').get(volumeId);
  if (mounts.c > 0) {
    throw new Error(`Volume is in use by ${mounts.c} app(s)/stack(s). Detach before deleting.`);
  }
  
  // Remove from Podman (ignore errors if already gone)
  try {
    await removePodmanVolume(volume.name, false);
  } catch (err) {
    console.warn(`[Volumes] Podman volume removal warning: ${err.message}`);
    // Continue to remove from DB even if Podman removal fails
  }
  
  // Remove from DB
  db.prepare('DELETE FROM volumes WHERE id = ?').run(volumeId);
  
  return { success: true };
}

/**
 * Prune unused volumes
 */
export async function pruneVolumes() {
  const db = getDB();
  
  // Find volumes with no mounts
  const unusedVolumes = db.prepare(`
    SELECT v.id, v.name 
    FROM volumes v
    LEFT JOIN volume_mounts vm ON v.id = vm.volume_id
    WHERE vm.id IS NULL
  `).all();
  
  const results = [];
  
  for (const vol of unusedVolumes) {
    try {
      await deleteVolume(vol.id);
      results.push({ id: vol.id, name: vol.name, deleted: true });
    } catch (err) {
      results.push({ id: vol.id, name: vol.name, deleted: false, error: err.message });
    }
  }
  
  return { pruned: results.length, volumes: results };
}
