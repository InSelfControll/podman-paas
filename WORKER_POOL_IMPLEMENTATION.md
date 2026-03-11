# Piscina Worker Thread Pool Implementation

This document describes the implementation of the Piscina-based Worker Thread Pool for PodPaaS, handling CPU-intensive tasks without blocking the Fastify event loop.

## 🎯 Goals Achieved

1. ✅ **Bcrypt Offloading** - Password hashing runs in worker threads
2. ✅ **Deployment Job Worker** - Deployments execute in isolated worker threads
3. ✅ **Persistent State** - SQLite tracks job progress for crash recovery
4. ✅ **Port Checking** - `findFreePort` now checks actual host availability

## 📦 Dependencies

```json
{
  "piscina": "^5.1.4"
}
```

Installed via: `bun add piscina`

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Fastify Main Thread                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │  Auth Routes │  │  App Routes  │  │  Deploy Routes  │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬────────┘   │
│         │                 │                   │            │
│         ▼                 ▼                   ▼            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │              Piscina Worker Pool Manager              │ │
│  │              (api/src/workers/pool.js)               │ │
│  └──────────────────────────────────────────────────────┘ │
│                          │                                  │
│         ┌────────────────┼────────────────┐                │
│         ▼                ▼                ▼                │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐       │
│  │ CryptoPool │  │DeployPool  │  │ Job Queue      │       │
│  │ 2-4 threads│  │1-2 threads │  │ (coordination) │       │
│  └─────┬──────┘  └─────┬──────┘  └────────────────┘       │
│        │               │                                    │
└────────┼───────────────┼────────────────────────────────────┘
         │               │
         ▼               ▼
┌─────────────────────────────────────────────────────────────┐
│                   Worker Threads (Piscina)                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────┐  ┌──────────────────────────┐   │
│  │  crypto.worker.js      │  │  deployment.worker.js    │   │
│  │  - bcrypt.hashSync()   │  │  - Podman API calls      │   │
│  │  - bcrypt.compareSync()│  │  - Progress tracking     │   │
│  │  - CPU-intensive       │  │  - SQLite updates        │   │
│  └────────────────────────┘  └──────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## 📁 New Files

### Worker Pool Infrastructure

| File | Purpose |
|------|---------|
| `api/src/workers/pool.js` | Piscina pool manager with `getCryptoPool()` and `getDeploymentPool()` |
| `api/src/workers/crypto.worker.js` | Bcrypt operations (hash/compare) in worker thread |
| `api/src/workers/deployment.worker.js` | Deployment execution with progress tracking |

### Job Queue Service

| File | Purpose |
|------|---------|
| `api/src/services/job-queue.js` | Job queue management, crash recovery, status tracking |

## 🔧 Modified Files

### Core Integration

| File | Changes |
|------|---------|
| `api/src/index.js` | Added `startJobQueue()` startup and `shutdownPools()` cleanup |
| `api/src/db/database.js` | Migration 5: Added `deployment_jobs` table |
| `api/src/routes/auth.js` | Uses `runCryptoHash()` / `runCryptoCompare()` from pool |
| `api/src/routes/deployments.js` | Added job status endpoints |
| `api/src/services/deploy.js` | Integrates with job queue for worker-based deployments |
| `api/src/services/podman.js` | Enhanced `findFreePort()` with actual port availability check |
| `api/package.json` | Added `piscina` dependency |

## 📊 Database Schema

### deployment_jobs Table (Migration 5)

```sql
CREATE TABLE deployment_jobs (
  id              TEXT PRIMARY KEY,
  app_id          TEXT NOT NULL,
  deployment_id   TEXT NOT NULL,
  status          TEXT DEFAULT 'pending',   -- pending, running, completed, failed
  current_step    TEXT DEFAULT 'init',      -- init, ensure_network, build_or_pull, etc.
  progress_pct    INTEGER DEFAULT 0,        -- 0-100
  trigger         TEXT DEFAULT 'manual',
  error_message   TEXT,
  log             TEXT DEFAULT '',
  worker_id       TEXT,                     -- Which worker is processing
  started_at      TEXT DEFAULT (datetime('now')),
  finished_at     TEXT,
  heartbeat_at    TEXT,                     -- Last progress update
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
  FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
);

CREATE INDEX idx_deployment_jobs_app_id ON deployment_jobs(app_id);
CREATE INDEX idx_deployment_jobs_status ON deployment_jobs(status);
CREATE INDEX idx_deployment_jobs_worker_id ON deployment_jobs(worker_id);
```

## 🔌 API Endpoints

### Authentication (using worker threads)
- `POST /api/auth/login` - Uses `runCryptoCompare()` in worker
- `POST /api/auth/change-password` - Uses `runCryptoCompare()` and `runCryptoHash()`
- `POST /api/auth/users` - Uses `runCryptoHash()` for new users

### Deployment Jobs (new)
- `GET /api/deployments/queue/status` - Get queue and pool statistics
- `GET /api/deployments/queue/jobs` - List all jobs (filter by `?app_id=`, `?status=`)
- `GET /api/deployments/queue/jobs/:jobId` - Get specific job details
- `GET /api/deployments/:id/job` - Get job for a specific deployment

### Health Check (updated)
- `GET /health` - Now includes worker pool statistics

## ⚙️ Configuration

### Environment Variables

```bash
# Worker pool sizes
DEPLOY_CONCURRENCY=2          # Max concurrent deployments (default: 2)

# Existing (used by workers)
DATA_DIR=./data               # Database location
PODMAN_SOCKET=/run/user/...   # Podman socket path
```

### Pool Configuration

```javascript
// Crypto Pool (bcrypt)
{
  minThreads: 2,
  maxThreads: 4,
  idleTimeout: 60000,           // 1 minute
  concurrentTasksPerWorker: 1   // CPU-bound, no multiplexing
}

// Deployment Pool
{
  minThreads: 1,
  maxThreads: DEPLOY_CONCURRENCY || 2,
  idleTimeout: 300000,          // 5 minutes
  concurrentTasksPerWorker: 1   // One deployment per worker
}
```

## 🔄 Job Lifecycle

```
1. deployApp() called
   │
   ├── Creates deployment record
   ├── Creates job in deployment_jobs table (status: 'pending')
   └── Returns { deploymentId, jobId }
   │
2. Job Queue picks up pending job
   │
   ├── Marks job as 'running'
   ├── Assigns worker_id
   └── Sends to Piscina deployment pool
   │
3. Worker Thread executes
   │
   ├── Updates heartbeat every step
   ├── Writes logs to job.log
   └── Updates progress_pct
   │
4. Job completes
   │
   ├── Worker sets status: 'completed' or 'failed'
   ├── Updates finished_at
   └── Main thread notified via polling
```

## 🛡️ Crash Recovery

If the main process crashes:

1. On restart, `recoverStaleJobs()` finds jobs with:
   - `status = 'running'` AND
   - `heartbeat_at` older than 5 minutes

2. Stale jobs are reset to `status = 'pending'`

3. Job queue picks them up and reprocesses

This ensures deployments survive process restarts.

## 🚀 Performance Benefits

### Before (Blocking)
```
Request ──[bcrypt: 100ms]──[bcrypt: 100ms]── Response
          └──── Blocks Event Loop ──────┘
```

### After (Non-blocking with Piscina)
```
Request ──[Queue]──┐
                   ├──[Worker 1]──┐
Request ──[Queue]──┤              ├── Response
                   ├──[Worker 2]──┘
Request ──[Queue]──┘
                   └──── Event Loop Free ─────┘
```

## 🧪 Testing

### Check Worker Pool Status
```bash
curl http://localhost:3001/health
```

### Monitor Queue
```bash
curl http://localhost:3001/api/deployments/queue/status \
  -H "Authorization: Bearer $TOKEN"
```

### Watch Job Progress
```bash
curl http://localhost:3001/api/deployments/queue/jobs?status=running \
  -H "Authorization: Bearer $TOKEN"
```

## 📝 Notes

1. **ESM Compatibility**: All worker files use ESM (`import/export`)
2. **Rootless Podman**: Workers inherit `PODMAN_SOCKET` env var
3. **SQLite**: Each worker creates its own DB connection (required for worker threads)
4. **Port Availability**: `findFreePort()` now actually binds to ports to verify availability
5. **Graceful Shutdown**: Pools are drained before process exit

## 🔮 Future Enhancements

- Job cancellation via AbortController
- Deployment job prioritization
- Worker pool auto-scaling based on queue size
- Job timeout enforcement
- WebSocket progress streaming for jobs
