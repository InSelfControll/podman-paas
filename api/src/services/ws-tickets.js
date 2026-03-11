/**
 * WebSocket Ticket Service
 * 
 * Provides secure, short-lived tickets for WebSocket authentication.
 * This avoids exposing JWT tokens in URL query parameters.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { getDB } from '../db/database.js';

const TICKET_TTL_MS = 30000; // 30 seconds - tickets are single-use and short-lived

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
