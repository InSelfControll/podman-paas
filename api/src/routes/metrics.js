import { getDB } from '../db/database.js';
import { listContainers, systemInfo, ping, stopContainer, removeContainer, getContainer, removeImage } from '../services/podman.js';
import { getProxyStatus, getProxyType } from '../services/proxy/proxy-factory.js';

export default async function metricsRoutes(app) {
  app.get('/overview', { onRequest: [app.authenticate] }, async () => {
    const db = getDB();
    const apps = db.prepare('SELECT status FROM apps').all();
    const stacks = db.prepare('SELECT status FROM stacks').all();
    const deployments24h = db.prepare(
      `SELECT COUNT(*) as c FROM deployments WHERE started_at > datetime('now', '-24 hours')`
    ).get();

    const podmanOk = await ping();
    const proxyStatus = await getProxyStatus();
    const proxyOk = proxyStatus.available;
    
    // Get actual container count from Podman
    let containerStats = { total: 0, running: 0, paused: 0, stopped: 0 };
    if (podmanOk) {
      try {
        const containers = await listContainers(true);
        containerStats.total = containers.length;
        containerStats.running = containers.filter(c => (c.State?.Status || c.state) === 'running').length;
        containerStats.paused = containers.filter(c => (c.State?.Status || c.state) === 'paused').length;
        containerStats.stopped = containers.filter(c => ['exited', 'dead', 'created'].includes(c.State?.Status || c.state)).length;
      } catch (e) {
        console.warn('Failed to get container stats:', e.message);
      }
    }
    
    let sysInfo = null;
    if (podmanOk) sysInfo = await systemInfo().catch(() => null);

    return {
      apps: {
        total:   apps.length,
        running: apps.filter(a => a.status === 'running').length,
        stopped: apps.filter(a => a.status === 'stopped').length,
        error:   apps.filter(a => a.status === 'error').length,
      },
      stacks: {
        total: stacks.length,
        running: stacks.filter(s => s.status === 'running').length,
        stopped: stacks.filter(s => s.status === 'stopped').length,
        error: stacks.filter(s => s.status === 'error').length,
      },
      containers: containerStats,
      deployments_24h: deployments24h.c,
      services: {
        podman: podmanOk ? 'online' : 'offline',
        proxy:  proxyOk  ? 'online' : 'offline',
        proxy_type: getProxyType(),
      },
      system: sysInfo ? {
        os:         sysInfo.host?.os,
        kernel:     sysInfo.host?.kernel,
        containers: sysInfo.containers,
        images:     sysInfo.images,
        version:    sysInfo.version?.Version,
      } : null,
    };
  });

  app.get('/containers', { onRequest: [app.authenticate] }, async () => {
    return listContainers();
  });
  
  // Get containers that are NOT managed by PodPaaS (existing containers)
  app.get('/external-containers', { onRequest: [app.authenticate] }, async () => {
    const db = getDB();
    const appContainers = db.prepare('SELECT container_id FROM apps WHERE container_id IS NOT NULL').all().map(a => a.container_id);
    const stackData = db.prepare('SELECT container_ids FROM stacks WHERE container_ids IS NOT NULL').all();
    const stackContainers = stackData.flatMap(s => {
      try { return JSON.parse(s.container_ids || '[]'); } catch { return []; }
    });
    const managedContainerIds = new Set([...appContainers, ...stackContainers]);
    
    const allContainers = await listContainers(true);
    const externalContainers = allContainers.filter(c => {
      const id = c.Id || c.id;
      const shortId = id?.substring(0, 12);
      return !managedContainerIds.has(id) && !managedContainerIds.has(shortId);
    });
    
    return externalContainers;
  });
  
  // Delete an external container
  app.delete('/containers/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    const containerId = req.params.id;
    
    // Verify this is NOT a managed container (safety check)
    const appContainers = db.prepare('SELECT container_id FROM apps WHERE container_id IS NOT NULL').all().map(a => a.container_id);
    const stackData = db.prepare('SELECT container_ids FROM stacks WHERE container_ids IS NOT NULL').all();
    const stackContainers = stackData.flatMap(s => {
      try { return JSON.parse(s.container_ids || '[]'); } catch { return []; }
    });
    const managedContainerIds = new Set([...appContainers, ...stackContainers]);
    
    const shortId = containerId?.substring(0, 12);
    if (managedContainerIds.has(containerId) || managedContainerIds.has(shortId)) {
      return reply.code(403).send({ error: 'Cannot delete managed container. Delete the app or stack instead.' });
    }
    
    try {
      // Get container info to find its image before deleting
      let imageName = null;
      try {
        const container = await getContainer(containerId);
        imageName = container?.Config?.Image || container?.Image;
      } catch {}
      
      // Stop first, then remove
      await stopContainer(containerId, 10).catch(() => {});
      await removeContainer(containerId, true);
      
      // Try to remove the image if it's not being used by other containers
      if (imageName) {
        try {
          await removeImage(imageName, false);
          console.log(`[Metrics] Removed image ${imageName} after container deletion`);
        } catch (imgErr) {
          // Image might be in use by other containers or be a base image - that's ok
          console.log(`[Metrics] Image ${imageName} not removed (may be in use): ${imgErr.message}`);
        }
      }
      
      return { success: true, message: 'Container deleted' };
    } catch (err) {
      return reply.code(500).send({ error: `Failed to delete container: ${err.message}` });
    }
  });
}
