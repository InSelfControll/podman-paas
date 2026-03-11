import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import 'dotenv/config';

import { initDB } from './db/database.js';
import appsRoutes from './routes/apps.js';
import deploymentsRoutes from './routes/deployments.js';
import logsRoutes from './routes/logs.js';
import metricsRoutes from './routes/metrics.js';
import stacksRoutes from './routes/stacks.js';
import authRoutes from './routes/auth.js';
import settingsRoutes from './routes/settings.js';
import templatesRoutes from './routes/templates.js';
import webhooksRoutes from './routes/webhooks.js';
import backupRoutes from './routes/backup.js';
import terminalRoutes from './routes/terminal.js';
import proxyRoutes from './routes/proxy.js';
import volumeRoutes from './routes/volumes.js';
import { ping as podmanPing } from './services/podman.js';
import { startHealthChecker } from './services/healthcheck.js';
import { initProxySystem } from './services/proxy/proxy-factory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Validate env in production ─────────────────────────────────────────────
if (IS_PROD) {
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET || JWT_SECRET.includes('CHANGE_THIS')) {
    console.error('FATAL: Set a strong JWT_SECRET in .env before running in production');
    process.exit(1);
  }
}

const app = Fastify({
  logger: {
    transport: IS_PROD ? undefined : {
      target: 'pino-pretty',
      options: { colorize: true, ignore: 'pid,hostname' }
    },
    level: process.env.LOG_LEVEL || 'info',
    serializers: {
      req(req) { return { method: req.method, url: req.url }; }
    }
  },
  trustProxy: IS_PROD,
  bodyLimit: 2 * 1024 * 1024,
});

// ── Security headers (inline) ──────────────────────────────────────────────
app.addHook('onSend', async (request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-XSS-Protection', '0');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.removeHeader('X-Powered-By');
  if (IS_PROD) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});

// ── CORS ───────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',').map(s => s.trim());

await app.register(cors, {
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return cb(null, true);
    // Check against allowed origins
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // In development, allow localhost origins
    if (!IS_PROD && origin.match(/^https?:\/\/localhost(:\d+)?$/)) return cb(null, true);
    
    app.log.warn({ origin }, 'CORS blocked request from origin');
    cb(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

// ── Rate limiting ──────────────────────────────────────────────────────────
await app.register(rateLimit, {
  global: true,
  max: IS_PROD ? 200 : 500,
  timeWindow: '1 minute',
  errorResponseBuilder: (req, context) => ({ 
    error: 'Too many requests', 
    retryAfter: Math.round(context.ttl / 1000) || 60 
  }),
  onExceeded: async (req, key) => {
    app.log.warn({ key, ip: req.ip }, 'Rate limit exceeded');
  },
});

// ── Plugins ────────────────────────────────────────────────────────────────
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
await app.register(jwt, {
  secret: process.env.JWT_SECRET || 'podman-paas-dev-secret-not-for-production',
  sign: { expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
});

// ── Auth decorator ─────────────────────────────────────────────────────────
app.decorate('authenticate', async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
});

// ── Error handler ──────────────────────────────────────────────────────────
app.setErrorHandler((error, request, reply) => {
  const statusCode = error.statusCode || 500;
  
  // Log error details
  app.log.error({ 
    err: error, 
    url: request.url,
    method: request.method,
    ip: request.ip,
    code: statusCode,
  });
  
  // In production, don't expose internal errors
  if (statusCode >= 500 && IS_PROD) {
    return reply.code(500).send({ 
      error: 'Internal Server Error',
      requestId: request.id 
    });
  }
  
  reply.code(statusCode).send({
    error: error.message || 'Internal Server Error',
    ...(error.validation && { validation: error.validation }),
    ...(request.id && { requestId: request.id }),
  });
});

app.setNotFoundHandler((request, reply) => {
  reply.code(404).send({ error: `${request.method} ${request.url} not found` });
});

// ── Database ───────────────────────────────────────────────────────────────
await initDB();

// ── Routes: auth with stricter rate limit ──────────────────────────────────
app.register(async (instance) => {
  await instance.register(rateLimit, {
    max: IS_PROD ? 5 : 10,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ 
      error: 'Too many login attempts. Try again later.',
      retryAfter: 60 
    }),
  });
  instance.register(authRoutes, { prefix: '/api/auth' });
});

app.register(appsRoutes,        { prefix: '/api/apps' });
app.register(deploymentsRoutes, { prefix: '/api/deployments' });
app.register(logsRoutes,        { prefix: '/api/logs' });
app.register(metricsRoutes,     { prefix: '/api/metrics' });
app.register(stacksRoutes,      { prefix: '/api/stacks' });
app.register(settingsRoutes,    { prefix: '/api/settings' });
app.register(templatesRoutes,   { prefix: '/api/templates' });
app.register(webhooksRoutes,    { prefix: '/api/webhooks' });
app.register(backupRoutes,      { prefix: '/api/backup' });
app.register(terminalRoutes,    { prefix: '/api/terminal' });
app.register(proxyRoutes,       { prefix: '/api/proxy' });
app.register(volumeRoutes,      { prefix: '/api/volumes' });

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', async (req, reply) => {
  const podmanOk = await podmanPing().catch(() => false);
  const db = getDB();
  const dbOk = db && db.open;
  
  const status = podmanOk && dbOk ? 'ok' : 'degraded';
  const code = status === 'ok' ? 200 : 503;
  
  return reply.code(code).send({
    status,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    services: {
      podman: podmanOk ? 'connected' : 'disconnected',
      database: dbOk ? 'connected' : 'disconnected',
    },
    version: process.env.npm_package_version || '1.0.0',
  });
});

// Readiness probe for Kubernetes/Docker
app.get('/ready', async (req, reply) => {
  const podmanOk = await podmanPing().catch(() => false);
  return reply.code(podmanOk ? 200 : 503).send({
    ready: podmanOk,
    timestamp: new Date().toISOString(),
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`🚀 PodPaaS API on http://${HOST}:${PORT} [${IS_PROD ? 'prod' : 'dev'}]`);

  // Start background health checker
  startHealthChecker(app.log);
  
  // Initialize proxy system
  await initProxySystem();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
async function shutdown(signal) {
  app.log.info(`${signal} — shutting down`);
  await app.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (r) => app.log.error({ reason: r }, 'Unhandled rejection'));
process.on('uncaughtException',  (e) => { app.log.fatal({ err: e }, 'Uncaught exception'); process.exit(1); });
