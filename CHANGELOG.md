# PodPaaS Changelog

## v2.1.0 — Security Hardening & Volume Management

### 🔒 Security Fixes (Critical)

#### 1. Container Name Sanitization
**Problem:** Malicious app names could lead to command injection in container operations.

**Solution:**
- Added `sanitizeContainerName()` function enforcing Docker naming rules
- Forces lowercase, removes invalid characters, truncates to 63 chars
- Applied to all container creation operations

**Files Changed:**
- `api/src/services/podman.js` — Added sanitization function
- `api/src/services/deploy.js` — Applied sanitization to container names

#### 2. Path Traversal Protection
**Problem:** Dockerfile path validation could be bypassed using symlinks.

**Solution:**
- Updated `buildWithDockerfile()` to use `realpath()` for symlink resolution
- Validates resolved path is within repository before build

**Files Changed:**
- `api/src/services/build.js` — Hardened path validation

#### 3. WebSocket Ticket Authentication
**Problem:** JWT tokens in URL query parameters leak to server logs, browser history, and referrer headers.

**Solution:**
- Implemented short-lived (30 sec), single-use tickets
- HMAC-SHA256 signed with server secret
- Tickets are resource-specific (app/deployment ID)

**API Changes:**
- New endpoint: `POST /api/logs/ticket` — Get WebSocket connection ticket
- WebSocket URLs now use `?ticket=xxx` instead of `?token=xxx`

**Files Changed:**
- `api/src/services/ws-tickets.js` — New ticket service
- `api/src/routes/logs.js` — Updated to ticket-based auth

#### 4. Async bcrypt with Worker Threads
**Problem:** Synchronous bcrypt operations blocked the Node.js event loop during authentication.

**Solution:**
- Offloaded bcrypt to worker threads for non-blocking operations
- Worker pool (max 4) for efficient reuse
- Async `hashPassword()` and `comparePassword()` functions

**Files Changed:**
- `api/src/services/crypto-worker.js` — Worker thread implementation
- `api/src/services/crypto-service.js` — Async crypto API with pooling
- `api/src/routes/auth.js` — Updated to async bcrypt
- `api/src/db/database.js` — Async initialization

### 🚀 New Features

#### Volume Management
Full CRUD support for persistent volumes with Podman integration.

**API Endpoints:**
```
GET    /api/volumes              — List all volumes
GET    /api/volumes/:id          — Get volume details
POST   /api/volumes              — Create volume
DELETE /api/volumes/:id          — Delete volume (if not in use)
POST   /api/volumes/:id/attach   — Attach to app/stack
DELETE /api/volumes/mounts/:id  — Detach volume
POST   /api/volumes/prune        — Remove unused volumes
GET    /api/volumes/drivers      — List available drivers
```

**Features:**
- Multiple driver support (local, nfs, tmpfs)
- Read-only mount option
- Usage tracking (mount count, orphaned detection)
- Podman state sync

**Database Schema:**
```sql
CREATE TABLE volumes (id, name, driver, mount_point, size_mb, labels, created_at);
CREATE TABLE volume_mounts (id, volume_id, app_id, stack_id, container_path, read_only);
```

**Files Changed:**
- `api/src/services/volumes.js` — Volume business logic
- `api/src/routes/volumes.js` — Volume API endpoints
- `api/src/services/podman.js` — Volume CRUD functions
- `api/src/db/database.js` — Migration 4 for volume tables
- `api/src/index.js` — Registered volume routes

### 🐛 Bug Fixes

#### Deployment Stream Memory Leak
**Problem:** `deployStreams` Map could grow unbounded with dead callbacks.

**Solution:**
- Auto-cleanup dead callbacks during `emitLog()`
- Immediate cleanup when deployment completes
- Removed duplicate cleanup timers

**Files Changed:**
- `api/src/services/deploy.js`

### 📁 New Files

| File | Purpose |
|------|---------|
| `api/src/services/crypto-worker.js` | Worker thread for bcrypt operations |
| `api/src/services/crypto-service.js` | Async crypto API with worker pool |
| `api/src/services/ws-tickets.js` | Secure ticket generation/verification |
| `api/src/services/volumes.js` | Volume management business logic |
| `api/src/routes/volumes.js` | Volume REST API endpoints |

### 🔄 Migration Notes

**Database:** Migration 4 runs automatically on startup, creating `volumes` and `volume_mounts` tables.

**Frontend:** Update WebSocket connections to use tickets:
```javascript
// Get ticket first
const { ticket } = await api.post('/logs/ticket', { 
  resource_type: 'app', 
  resource_id: appId 
});

// Then connect WebSocket
const ws = new WebSocket(`wss://host/api/logs/app/${appId}/stream?ticket=${ticket}`);
```

**Breaking Change:** WebSocket endpoints no longer accept `?token=` parameter. Use tickets instead.

---

## v2.0.0 — Multi-Proxy Support & Container Management

### 🚀 Major Features

#### 1. Multi-Proxy Support ✅
**Added support for multiple reverse proxy options:**
- **Caddy** — Automatic HTTPS, easy REST API configuration
- **Nginx Proxy Manager** — Web UI for managing proxies
- **Traefik** — Cloud-native edge router with auto-discovery
- **Custom/External** — Use your own existing proxy
- **Disabled** — Port-only access

**Deployment Modes:**
- **Container** (Recommended) — Proxy runs as a container in podman-paas network
- **Remote** — Proxy on different server with VPN/P2P connectivity
- **Host** — Proxy installed directly on the host

**Files Changed:**
- `api/src/services/proxy/proxy-factory.js` — New proxy abstraction layer
- `api/src/services/proxy/caddy-impl.js` — Caddy implementation
- `api/src/services/proxy/nginx-impl.js` — Nginx Proxy Manager implementation
- `api/src/services/proxy/traefik-impl.js` — Traefik implementation
- `api/src/services/proxy/container-manager.js` — Container deployment management
- `api/src/routes/proxy.js` — Proxy management API endpoints
- `frontend/src/pages/OtherPages.jsx` — Proxy settings UI with deployment controls

#### 2. Docker-to-Podman Compose Sanitization ✅
**Problem:** Stacks with Docker dependencies failed (nginx proxy, Watchtower, etc.)

**Solution:**
- Automatic Docker socket path replacement (`/var/run/docker.sock` → Podman socket)
- Docker command conversion (`docker` → `podman`, `docker-compose` → `podman-compose`)
- Swarm mode detection and rejection
- Environment variable sanitization (`DOCKER_HOST` fixes)
- Real-time compose validation with warnings

**Files Changed:**
- `api/src/services/compose-sanitizer.js` — New sanitization module
- `api/src/routes/stacks.js` — Validation endpoint
- `frontend/src/pages/OtherPages.jsx` — Validation warnings UI

#### 3. Terminal Access ✅
**Added WebSocket terminal for container access**
- Interactive bash/sh/zsh/ash shells
- Automatic shell detection
- Authentication via query token
- Full PTY support

**Files Changed:**
- `api/src/routes/terminal.js` — WebSocket terminal endpoint
- `frontend/src/components/ui.jsx` — Terminal component
- `frontend/src/pages/OtherPages.jsx` — Terminal button in containers list

#### 4. External Container Management ✅
**View and manage unmanaged containers**
- List external containers not managed by PodPaaS
- Delete capability for cleanup
- Terminal access for running containers

**Files Changed:**
- `api/src/routes/metrics.js` — External containers endpoint
- `frontend/src/pages/OtherPages.jsx` — Containers page with management

### 🔧 Bug Fixes & Improvements

#### UI/UX Fixes
- **Container date display** — Fixed "Invalid date" issue with proper timestamp handling
- **Removed ugly green focus marks** — Active page now shows subtle gray instead of bright green
- **Button focus states** — Removed browser default outlines

#### Port Configuration (Rootless Mode)
- **Caddy**: HTTP=8080, HTTPS=8443, Admin=2019
- **Nginx Proxy Manager**: HTTP=8090, HTTPS=8453, Admin=8091
- **Traefik**: HTTP=8081, HTTPS=8444, Admin=8080

#### Database Updates
- Added proxy settings: `proxy_type`, `proxy_mode`, `proxy_container_name`, etc.
- Migration from legacy `caddy_admin_url` to new proxy settings

---

# PodPaaS Changelog — Production Ready Release

## Summary of Changes

This release makes PodPaaS production-ready with fixes for WebSocket issues, stack deployment problems, and comprehensive production hardening.

---

## 🔧 Fixed Issues

### 1. WebSocket Connection Issues ✅
**Problem:** Installing apps failed due to WebSocket connection problems. Logs weren't streaming properly.

**Solution:**
- Added robust WebSocket reconnection logic with exponential backoff
- Added message buffering for better performance
- Improved error handling and connection state management
- Added authentication retry logic

**Files Changed:**
- `frontend/src/lib/api.js` — Complete rewrite of `createLogStream()` function

### 2. Stack Deployment Not Working ✅
**Problem:** Stacks that got installed couldn't be accessed and didn't appear in `podman ps` or `podman pod ps`.

**Solution:**
- Rewrote stack deployment service to properly use `podman-compose`
- Added container tracking by storing container IDs in database
- Added proper error handling and logging for compose operations
- Added stack health monitoring to detect actual container status
- Added `getStackContainers()` to find containers by compose project labels

**Files Changed:**
- `api/src/services/stacks.js` — Complete rewrite
- `api/src/routes/stacks.js` — Added new endpoints for status and logs
- `api/src/db/database.js` — Added `container_ids` and `error_message` columns

### 3. Removed Unreliable Portainer Official Repo ✅
**Problem:** Portainer Official repo was unreliable/outdated.

**Solution:**
- Removed Portainer Official from template sources
- Only Portainer Community (Lissy93) and Dokploy remain
- Updated both backend and frontend template sync options

**Files Changed:**
- `api/src/routes/templates.js` — Removed `portainer` enum option
- `frontend/src/pages/Templates.jsx` — Updated source list

---

## 🚀 Production Hardening

### Security Improvements
1. **Enhanced CORS handling** — Better origin validation, localhost allowed in dev
2. **Stricter rate limiting** — 5 req/min for auth in production
3. **Improved error handling** — Internal errors hidden in production
4. **Security headers** — Added via Fastify hooks and nginx
5. **JWT validation** — Stronger secret requirements

### Health Monitoring
1. **Background health checker** — Checks all apps/stacks every 30 seconds
2. **Live status sync** — Database status syncs with actual container state
3. **Health endpoints** — `/health` and `/ready` for load balancers
4. **Stack container tracking** — Monitors individual containers in stacks

### Deployment & Operations
1. **Improved compose.yml** — Dynamic socket path, health checks, resource limits
2. **Enhanced setup.sh** — Better dependency checking, podman-compose detection
3. **Systemd service** — Auto-start on boot
4. **Production guide** — Comprehensive PRODUCTION.md documentation
5. **Log rotation** — Built into compose and nginx configs

---

## 📁 New Files

| File | Purpose |
|------|---------|
| `PRODUCTION.md` | Complete production deployment guide |
| `frontend/nginx.conf` | Optimized nginx config for production |
| `deploy/podman-paas.service` | Systemd service for auto-start |
| `CHANGELOG.md` | This changelog |

---

## 📝 Modified Files

### API Changes
- `api/src/index.js` — Enhanced security, rate limiting, health endpoints
- `api/src/services/stacks.js` — Complete rewrite for proper podman-compose
- `api/src/services/healthcheck.js` — Added background monitoring
- `api/src/routes/stacks.js` — New endpoints: status, logs, restart
- `api/src/routes/templates.js` — Removed portainer official source
- `api/src/db/database.js` — Migrations for stack columns
- `api/.env.example` — Better documentation

### Frontend Changes
- `frontend/src/lib/api.js` — WebSocket reconnection, new API methods
- `frontend/src/pages/OtherPages.jsx` — Stack container counts, logs modal
- `frontend/src/pages/Templates.jsx` — Removed portainer official

### Configuration Changes
- `compose.yml` — Dynamic socket path, health checks, proper networking
- `caddy/Caddyfile` — Production-ready configuration
- `scripts/setup.sh` — Comprehensive dependency checking
- `README.md` — Updated with new information

---

## 🔄 Migration Guide

### For Existing Installations

1. **Backup your data:**
   ```bash
   cp -r data data.backup.$(date +%Y%m%d)
   ```

2. **Update database schema:**
   ```bash
   cd api
   node -e "require('./src/db/database.js').initDB()"
   ```

3. **Update environment:**
   ```bash
   # Add to api/.env if not present
   COMPOSE_CMD=podman-compose
   ```

4. **Restart services:**
   ```bash
   podman-compose down
   podman-compose up -d
   ```

---

## 🐛 Known Issues & Workarounds

### podman-compose not installed
**Error:** `Failed to run podman-compose: Is podman-compose installed?`

**Fix:**
```bash
pip3 install podman-compose
```

### Permission denied on socket
**Error:** `Cannot connect to Podman socket`

**Fix:**
```bash
systemctl --user enable --now podman.socket
export PODMAN_SOCKET=/run/user/$(id -u)/podman/podman.sock
```

### Rootless networking issues
**Error:** `could not find slirp4netns`

**Fix:**
```bash
# Install required networking tools
sudo dnf install slirp4netns fuse-overlayfs  # Fedora
sudo apt install slirp4netns fuse-overlayfs  # Ubuntu
```

---

## 🎯 Quick Start (New Install)

```bash
# 1. Clone and enter directory
cd podman-paas

# 2. Run setup
bash scripts/setup.sh

# 3. Start with podman-compose
export PODMAN_SOCKET=/run/user/$(id -u)/podman/podman.sock
podman-compose up -d

# 4. Access UI at http://localhost:5173
# Login: admin / admin (change immediately!)
```

---

## 📊 Architecture Improvements

```
Before:                    After:
┌─────────────┐           ┌─────────────────────┐
│  API        │           │  API + Health Check │
│  - basic    │    →      │  - auto-reconnect   │
│  - no track │           │  - container track  │
└─────────────┘           └─────────────────────┘

┌─────────────┐           ┌─────────────────────┐
│  Stacks     │           │  Stacks             │
│  - untracked│    →      │  - podman-compose   │
│  - no logs  │           │  - health monitor   │
└─────────────┘           └─────────────────────┘

┌─────────────┐           ┌─────────────────────┐
│  WebSocket  │           │  WebSocket          │
│  - no retry │    →      │  - reconnection     │
│  - drops    │           │  - message buffer   │
└─────────────┘           └─────────────────────┘
```

---

## 📈 Performance Improvements

1. **WebSocket buffering** — Messages batched and flushed every 100ms
2. **Health check batching** — Single container list call for all checks
3. **Database indexes** — Optimized queries for common operations
4. **Static asset caching** — 1-year cache for frontend assets
5. **Gzip compression** — Enabled in nginx

---

## 🔒 Security Checklist

- [x] JWT secrets generated securely
- [x] CORS properly configured
- [x] Rate limiting implemented
- [x] Input validation on all endpoints
- [x] SQL injection prevention (parameterized queries)
- [x] XSS protection headers
- [x] Clickjacking protection (X-Frame-Options)
- [x] Secure password hashing (bcrypt)
- [x] No sensitive data in logs
- [x] Production error message sanitization

---

## 🙏 Credits

- Stack improvements inspired by community feedback
- Template sources: [Lissy93/portainer-templates](https://github.com/Lissy93/portainer-templates), [Dokploy/templates](https://github.com/Dokploy/templates)
- Built with Fastify, React, Podman, and Caddy
