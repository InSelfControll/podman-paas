# PodPaaS Lifecycle Management & Resource Reliability

This document describes the lifecycle management and resource reliability features implemented for PodPaaS.

## 🎯 Features Implemented

### 1. Startup Recovery (Orphaned Build Recovery)

**Location:** `api/src/services/job-queue.js` - `recoverOrphanedBuilds()`

**Purpose:** On startup, detects and recovers apps that were left in 'building' state due to a process crash.

**How it works:**
1. Queries for apps with `status = 'building'` but no associated running/pending job
2. For each orphaned app:
   - If a running deployment exists: Creates a recovery job and queues it
   - If no deployment found: Resets app to 'stopped' state
3. Logs are preserved with recovery markers

**Integration:** Called in `api/src/index.js` after `startJobQueue()`:
```javascript
await recoverOrphanedBuilds();
```

### 2. Network Resilience (Port Availability Check)

**Location:** `api/src/services/podman.js` - `findFreePort()` & `isPortAvailable()`

**Purpose:** Ensures assigned ports are actually available on the host before allocation.

**How it works:**
1. First checks Podman containers and DB for used ports (fast path)
2. For candidate ports, performs actual `net.Server` bind test:
   ```javascript
   server.listen(port, '0.0.0.0');
   // If EADDRINUSE → port is actually in use
   ```
3. Only returns ports that successfully bind

**Benefits:**
- Prevents port conflicts with non-Podman services
- Handles edge cases where DB and actual state differ
- Rootless Podman compatible

### 3. Log Rotation & Pruning

**Location:** `api/src/services/healthcheck.js` - `startLogPruning()` & `pruneOldLogs()`

**Purpose:** Prevents SQLite database bloat from accumulated deployment logs.

**Features:**
- **Automatic deletion** of old deployments (default: 30 days)
- **Log truncation** for oversized logs (keeps head + tail)
- **Batch deletion** to avoid DB locks
- **VACUUM** operation to reclaim disk space
- **Job log cleanup** for completed/failed jobs

**Configuration:**
```bash
LOG_RETENTION_DAYS=30    # How long to keep deployment logs
```

**Schedule:** Runs every 6 hours + on startup

**Integration:** Called in `api/src/index.js`:
```javascript
startLogPruning(app.log);
```

### 4. One-Time Ticket Pruning (WebSocket Security)

**Location:** `api/src/services/ws-tickets.js` - `startTicketCleanup()` & related functions

**Purpose:**
- Prevents replay attacks on WebSocket tickets
- Manages in-memory ticket tracking
- Automatically cleans expired ticket entries

**Features:**
- **Replay protection:** Tickets can only be used once
- **In-memory tracking:** Uses Map with LRU eviction (max 10,000 entries)
- **Automatic cleanup:** Removes expired entries every 5 minutes
- **Statistics:** Track used/unused/expired tickets

**How it works:**
1. When ticket is created: Optional tracking entry added
2. When ticket is used: Marked as used in tracker
3. Subsequent uses: Rejected with "Ticket already used"
4. Cleanup: Expired entries removed periodically

**API Endpoint:**
```
GET /api/logs/ticket-stats
```

**Integration:** Called in `api/src/index.js`:
```javascript
startTicketCleanup();
```

## 📊 Database Schema Updates

No new migrations required - features use existing tables.

### Used Tables:
- `apps` - For orphaned build detection
- `deployments` - For log pruning
- `deployment_jobs` - For job recovery
- `settings` - For ticket secret storage

## 🔌 API Endpoints

### New Endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/logs/ticket-stats` | GET | Get WebSocket ticket statistics |

### Enhanced Health Check:

```json
GET /health
{
  "status": "ok",
  "services": {
    "podman": "connected",
    "database": "connected",
    "workers": { ... }
  }
}
```

## ⚙️ Configuration

### Environment Variables:

```bash
# Log retention (default: 30 days)
LOG_RETENTION_DAYS=30

# Deployment concurrency (affects worker pool size)
DEPLOY_CONCURRENCY=2

# Max tracked tickets for replay protection (default: 10000)
# (Hardcoded in ws-tickets.js)
```

## 🔄 Startup Sequence

The new startup sequence in `api/src/index.js`:

```
1. Initialize Fastify
2. Register middleware (CORS, auth, rate limiting)
3. Initialize database (migrations run)
4. Register routes
5. Start HTTP server
6. Start health checker
7. Initialize proxy system
8. Start job queue (Piscina pools)
9. RECOVER ORPHANED BUILDS ← NEW
10. START LOG PRUNING ← NEW
11. START TICKET CLEANUP ← NEW
```

## 🛡️ Security Improvements

1. **Ticket Replay Protection:**
   - One-time use tickets
   - In-memory tracking with automatic cleanup
   - Prevents WebSocket connection hijacking

2. **Port Conflicts:**
   - Actual network bind testing
   - Prevents service conflicts

3. **Data Retention:**
   - Automatic old log deletion
   - Prevents disk space exhaustion
   - GDPR-compliant data lifecycle

## 📈 Monitoring

### Log Output Examples:

**Startup Recovery:**
```
[JobQueue] Checking for orphaned builds...
[JobQueue] Found 2 orphaned builds to recover
[JobQueue] Created recovery job xxx for deployment yyy
```

**Log Pruning:**
```
[LogPrune] Deleted 150 old deployments (older than 30 days)
[LogPrune] Truncated 3 oversized logs
[LogPrune] Running VACUUM to reclaim disk space...
```

**Ticket Cleanup:**
```
[WS Tickets] Cleaned up 245 expired ticket entries (8755 remaining)
```

## 🧪 Testing

### Manual Test Commands:

```bash
# Check ticket stats
curl http://localhost:3001/api/logs/ticket-stats \
  -H "Authorization: Bearer $TOKEN"

# Trigger a deployment and kill the server mid-build
# Then restart - should recover automatically

# Check health endpoint for worker stats
curl http://localhost:3001/health
```

## 🔮 Future Enhancements

1. **Persistent Ticket Store:** Move ticket tracking to Redis for distributed setups
2. **Log Archiving:** Export old logs to S3 before deletion
3. **Metrics Export:** Prometheus metrics for pruning operations
4. **Configurable Retention:** Per-app log retention policies

---

*All features are ESM-compatible and tested with Fastify 4.x and Rootless Podman.*
