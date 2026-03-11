/**
 * WebSocket Ticket Service
 * 
 * Provides secure, short-lived tickets for WebSocket authentication.
 * This avoids exposing JWT tokens in URL query parameters.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { getDB } from '../db/database.js';

const TICKET_TTL_MS = 30000; // 30 seconds - tickets are single-use and short-lived

// In-memory ticket tracking for rate limiting and abuse prevention
// Stores: { ticketHash: { createdAt, used, resourceType, resourceId } }
const ticketTracker = new Map();
let cleanupInterval = null;

// Max tracked tickets in memory (LRU eviction)
const MAX_TRACKED_TICKETS = 10000;
// Cleanup interval: every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Get or create the ticket signing secret
 */
function getTicketSecret() {
  const db = getDB();
  
  // Try to get existing secret
  let secret = db.prepare("SELECT value FROM settings WHERE key = 'ws_ticket_secret'").get()?.value;
  
  if (!secret) {
    // Generate new secret
    secret = randomBytes(32).toString('base64');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run('ws_ticket_secret', secret);
    console.log('[WS Tickets] Generated new ticket secret');
  }
  
  return secret;
}

/**
 * Create a one-time ticket for WebSocket authentication
 * @param {string} userId - User ID from JWT
 * @param {string} resourceType - 'app' | 'deployment' | 'stack'
 * @param {string} resourceId - ID of the resource being accessed
 * @returns {Object} - { ticket: string, expires: number }
 */
export function createWSTicket(userId, resourceType, resourceId) {
  const nonce = randomBytes(16).toString('hex');
  const timestamp = Date.now();
  
  // Data format: userId:resourceType:resourceId:timestamp:nonce
  const data = `${userId}:${resourceType}:${resourceId}:${timestamp}:${nonce}`;
  const secret = getTicketSecret();
  
  // Sign with HMAC-SHA256
  const signature = createHmac('sha256', secret).update(data).digest('base64url');
  
  // Ticket format: base64(data).signature
  const ticket = `${Buffer.from(data).toString('base64url')}.${signature}`;
  
  return {
    ticket,
    expires: timestamp + TICKET_TTL_MS
  };
}

/**
 * Verify a WebSocket ticket
 * @param {string} ticketStr - The ticket from query parameter
 * @param {string} expectedResourceType - Expected resource type
 * @param {string} expectedResourceId - Expected resource ID
 * @returns {Object|null} - { userId: string } or null if invalid
 */
export function verifyWSTicket(ticketStr, expectedResourceType, expectedResourceId) {
  try {
    if (!ticketStr || typeof ticketStr !== 'string') {
      return null;
    }
    
    // Split ticket into data and signature
    const parts = ticketStr.split('.');
    if (parts.length !== 2) {
      return null;
    }
    
    const [dataB64, signature] = parts;
    
    // Decode data
    let data;
    try {
      data = Buffer.from(dataB64, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    
    // Parse data components
    const [userId, resourceType, resourceId, timestampStr] = data.split(':');
    
    if (!userId || !resourceType || !resourceId || !timestampStr) {
      return null;
    }
    
    // Verify resource matches
    if (resourceType !== expectedResourceType || resourceId !== expectedResourceId) {
      return null;
    }
    
    // Check expiration
    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp) || Date.now() > timestamp + TICKET_TTL_MS) {
      return null;
    }
    
    // Verify signature (constant-time comparison)
    const secret = getTicketSecret();
    const expectedSig = createHmac('sha256', secret).update(data).digest('base64url');
    
    const sigBuf = Buffer.from(signature, 'base64url');
    const expectedBuf = Buffer.from(expectedSig, 'base64url');
    
    if (sigBuf.length !== expectedBuf.length) {
      return null;
    }
    
    if (!timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }
    
    return { userId };
  } catch (err) {
    console.error('[WS Tickets] Verification error:', err.message);
    return null;
  }
}

/**
 * Middleware to generate tickets for REST endpoints
 */
export async function generateWSTicketHandler(req, reply) {
  const { resource_type, resource_id } = req.body;
  
  if (!resource_type || !resource_id) {
    return reply.code(400).send({ error: 'resource_type and resource_id required' });
  }
  
  if (!['app', 'deployment', 'stack'].includes(resource_type)) {
    return reply.code(400).send({ error: 'Invalid resource_type' });
  }
  
  const ticket = createWSTicket(req.user.id, resource_type, resource_id);
  
  return ticket;
}

// ── Ticket Tracking & Cleanup ───────────────────────────────────────────────

/**
 * Track a ticket for rate limiting and abuse detection
 * This is optional - tickets work without tracking, but tracking helps prevent abuse
 */
function trackTicket(ticket, resourceType, resourceId) {
  // Simple hash of the ticket for storage
  const ticketHash = createHmac('sha256', 'ticket-tracker')
    .update(ticket)
    .digest('hex')
    .substring(0, 32);
  
  // Evict oldest if at capacity (simple LRU)
  if (ticketTracker.size >= MAX_TRACKED_TICKETS) {
    const oldestKey = ticketTracker.keys().next().value;
    ticketTracker.delete(oldestKey);
  }
  
  ticketTracker.set(ticketHash, {
    createdAt: Date.now(),
    used: false,
    resourceType,
    resourceId,
  });
}

/**
 * Mark a ticket as used (prevents replay attacks)
 */
export function markTicketUsed(ticket) {
  const ticketHash = createHmac('sha256', 'ticket-tracker')
    .update(ticket)
    .digest('hex')
    .substring(0, 32);
  
  const record = ticketTracker.get(ticketHash);
  if (record) {
    record.used = true;
    record.usedAt = Date.now();
  }
}

/**
 * Check if a ticket has been used (replay detection)
 */
export function isTicketUsed(ticket) {
  const ticketHash = createHmac('sha256', 'ticket-tracker')
    .update(ticket)
    .digest('hex')
    .substring(0, 32);
  
  const record = ticketTracker.get(ticketHash);
  return record?.used === true;
}

/**
 * Clean up expired ticket tracking entries
 */
function cleanupExpiredTickets() {
  const now = Date.now();
  const expirationTime = TICKET_TTL_MS + 60000; // Keep for 1 minute after expiration for replay detection
  let cleaned = 0;
  
  for (const [hash, data] of ticketTracker.entries()) {
    if (now - data.createdAt > expirationTime) {
      ticketTracker.delete(hash);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[WS Tickets] Cleaned up ${cleaned} expired ticket entries (${ticketTracker.size} remaining)`);
  }
}

/**
 * Start automatic ticket cleanup
 */
export function startTicketCleanup() {
  if (cleanupInterval) return; // Already running
  
  // Run initial cleanup
  cleanupExpiredTickets();
  
  // Schedule periodic cleanup
  cleanupInterval = setInterval(() => {
    cleanupExpiredTickets();
  }, CLEANUP_INTERVAL_MS);
  
  console.log(`[WS Tickets] Started ticket cleanup (interval: ${CLEANUP_INTERVAL_MS / 60000} min)`);
}

/**
 * Stop ticket cleanup
 */
export function stopTicketCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

/**
 * Get ticket tracking statistics (for monitoring)
 */
export function getTicketStats() {
  const now = Date.now();
  const total = ticketTracker.size;
  const used = Array.from(ticketTracker.values()).filter(t => t.used).length;
  const expired = Array.from(ticketTracker.values())
    .filter(t => now - t.createdAt > TICKET_TTL_MS).length;
  
  return {
    total,
    used,
    unused: total - used,
    expired,
    valid: total - expired,
  };
}
