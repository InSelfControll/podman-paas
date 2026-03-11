# PodPaaS Security Hardening & Feature Update

This document summarizes the critical security fixes and new features implemented.

## 🔒 Security Fixes

### 1. Container Name Sanitization (Critical)
**Problem:** App names could contain malicious characters leading to command injection.

**Solution:** Added `sanitizeContainerName()` function in `api/src/services/podman.js`:
- Forces lowercase
- Removes invalid characters
- Ensures valid Docker/Podman naming
- Truncates to 63 characters max

**Files Modified:**
- `api/src/services/podman.js` - Added sanitization function
- `api/src/services/deploy.js` - Applied sanitization to container names

### 2. Path Traversal Protection (Critical)
**Problem:** Dockerfile path validation could be bypassed using symlinks.

**Solution:** Updated `buildWithDockerfile()` to use `realpath`:
- Resolves symlinks before validation
- Ensures resolved path is within repository
- Prevents `/etc/passwd` style attacks

**Files Modified:**
- `api/src/services/build.js` - Hardened path validation

### 3. WebSocket Authentication Security (Critical)
**Problem:** JWT tokens in URL query parameters leak to logs, browser history, and referrer headers.

**Solution:** Implemented ticket-based authentication:
- Short-lived (30 second), single-use tickets
- HMAC-SHA256 signed with server secret
- Tickets are resource-specific (app/deployment ID)

**New Files:**
- `api/src/services/ws-tickets.js` - Ticket creation and verification

**Files Modified:**
- `api/src/routes/logs.js` - Updated to use ticket auth

**API Changes:**
- New endpoint: `POST /api/logs/ticket` - Get WebSocket connection ticket
- WebSocket URLs now use `?ticket=xxx` instead of `?token=xxx`

### 4. Async bcrypt with Worker Threads (High)
**Problem:** Synchronous bcrypt operations block the Node.js event loop.

**Solution:** Offloaded bcrypt to worker threads:
- Non-blocking password hashing and comparison
- Worker pool for efficiency (max 4 concurrent)
- Automatic cleanup on shutdown

**New Files:**
- `api/src/services/crypto-worker.js` - Worker thread implementation
- `api/src/services/crypto-service.js` - Async crypto API

**Files Modified:**
- `api/src/routes/auth.js` - Updated to use async crypto
- `api/src/db/database.js` - Updated to use async crypto for initial user

## 🚀 New Features

### Volume Management
Full CRUD support for persistent volumes:

**New Files:**
- `api/src/services/volumes.js` - Volume business logic
- `api/src/routes/volumes.js` - Volume API endpoints

**API Endpoints:**
```
GET    /api/volumes              - List all volumes
GET    /api/volumes/:id          - Get volume details
POST   /api/volumes              - Create volume
DELETE /api/volumes/:id          - Delete volume (if not in use)
POST   /api/volumes/:id/attach   - Attach to app/stack
DELETE /api/volumes/mounts/:id  - Detach volume
POST   /api/volumes/prune        - Remove unused volumes
GET    /api/volumes/drivers      - List available drivers
```

**Database Schema:**
```sql
CREATE TABLE volumes (
  id, name, driver, mount_point, size_mb, labels, created_at
);

CREATE TABLE volume_mounts (
  id, volume_id, app_id, stack_id, container_path, read_only
);
```

## 🐛 Bug Fixes

### Deployment Stream Memory Leak
**Problem:** `deployStreams` Map could grow unbounded with dead callbacks.

**Solution:**
- Automatic cleanup of dead callbacks during `emitLog()`
- Immediate cleanup when deployment completes
- Removed duplicate cleanup timers

**Files Modified:**
- `api/src/services/deploy.js`

## 📋 Database Migrations

New migration (version 4) automatically creates:
- `volumes` table
- `volume_mounts` table
- Indexes for performance

## ⚡ Performance Improvements

1. **Non-blocking Authentication**: Login and password changes no longer block the event loop
2. **Worker Pool**: Crypto workers are pooled for efficient reuse
3. **Stream Cleanup**: Dead WebSocket callbacks are pruned automatically

## 🔐 Security Headers & Best Practices

All existing security measures remain in place:
- Rate limiting on all endpoints
- CORS protection
- Security headers (X-Frame-Options, X-Content-Type-Options, etc.)
- Input validation with JSON Schema
- SQL injection protection via prepared statements

## 📝 Frontend Integration Notes

### WebSocket Authentication Update
Frontend needs to update WebSocket connection flow:

```javascript
// OLD:
const ws = new WebSocket(`wss://api/logs/app/${appId}/stream?token=${jwtToken}`);

// NEW:
const { ticket } = await api.post('/logs/ticket', { 
  resource_type: 'app', 
  resource_id: appId 
});
const ws = new WebSocket(`wss://api/logs/app/${appId}/stream?ticket=${ticket}`);
```

### Volume Management UI
New frontend pages can be added for:
- Volume list with usage status
- Create volume form (name, driver, size)
- Attach volume to app/stack
- Volume details with mount information

## 🧪 Testing Checklist

- [ ] Create app with special characters in name - verify sanitization
- [ ] Attempt path traversal in Dockerfile path - verify blocked
- [ ] Login with valid/invalid credentials - verify timing-safe comparison
- [ ] Connect to WebSocket logs - verify ticket auth works
- [ ] Create, attach, detach, delete volumes - verify full lifecycle
- [ ] Verify deployment logs stream correctly
- [ ] Verify memory usage stays stable during load

## 🔄 Migration Steps

1. Pull latest code
2. Restart API server - migrations run automatically
3. Update frontend WebSocket connection code (if applicable)
4. No manual database changes needed

## ⚠️ Breaking Changes

1. **WebSocket Authentication**: Frontend must use tickets instead of JWT tokens in query params
2. **Default Admin Password**: Still "admin" but now hashed via worker thread

## 📚 Files Changed Summary

**New Files (7):**
- `api/src/services/crypto-worker.js`
- `api/src/services/crypto-service.js`
- `api/src/services/ws-tickets.js`
- `api/src/services/volumes.js`
- `api/src/routes/volumes.js`

**Modified Files (6):**
- `api/src/services/podman.js` - Added sanitizeContainerName(), volume functions
- `api/src/services/build.js` - Path traversal fix
- `api/src/services/deploy.js` - Memory leak fix, use sanitizeContainerName()
- `api/src/routes/auth.js` - Async bcrypt
- `api/src/routes/logs.js` - Ticket-based auth
- `api/src/db/database.js` - Async init, volume migration
- `api/src/index.js` - Added volume routes

**Total:** 13 files changed, ~700 lines added
