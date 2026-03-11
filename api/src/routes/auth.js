import bcrypt from 'bcryptjs';
import { getDB } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';

export default async function authRoutes(app) {
  // Login
  app.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 1, maxLength: 64 },
          password: { type: 'string', minLength: 1, maxLength: 256 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { username, password } = req.body;
    const db = getDB();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    // Constant-time check (avoid timing attacks)
    const dummyHash = '$2a$10$abcdefghijklmnopqrstuvuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu';
    const hashToCheck = user ? user.password_hash : dummyHash;
    const valid = bcrypt.compareSync(password, hashToCheck);

    if (!user || !valid) {
      // Consistent delay to prevent timing-based user enumeration
      await new Promise(r => setTimeout(r, 300));
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const token = app.jwt.sign({ id: user.id, username: user.username });
    req.log.info({ username: user.username }, 'User logged in');
    return { token, username: user.username };
  });

  // Get current user
  app.get('/me', { onRequest: [app.authenticate] }, async (req) => {
    return { id: req.user.id, username: req.user.username };
  });

  // Change password
  app.post('/change-password', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['current_password', 'new_password'],
        properties: {
          current_password: { type: 'string', minLength: 1 },
          new_password: { type: 'string', minLength: 8, maxLength: 256 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { current_password, new_password } = req.body;
    const db = getDB();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    if (!bcrypt.compareSync(current_password, user.password_hash)) {
      return reply.code(401).send({ error: 'Current password incorrect' });
    }

    const hash = bcrypt.hashSync(new_password, 12); // bcrypt cost 12 for production
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
    req.log.info({ userId: req.user.id }, 'Password changed');
    return { success: true };
  });

  // List users
  app.get('/users', { onRequest: [app.authenticate] }, async () => {
    const db = getDB();
    return db.prepare('SELECT id, username, created_at FROM users ORDER BY created_at').all();
  });

  // Delete user
  app.delete('/users/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const db = getDB();
    if (req.params.id === req.user.id) {
      return reply.code(400).send({ error: 'Cannot delete your own account' });
    }
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) return reply.code(404).send({ error: 'User not found' });
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    return { success: true };
  });

  // Create user (admin only - in future can add role checks)
  app.post('/users', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 3, maxLength: 64, pattern: '^[a-zA-Z0-9_-]+$' },
          password: { type: 'string', minLength: 8, maxLength: 256 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { username, password } = req.body;
    const db = getDB();

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return reply.code(409).send({ error: 'Username already exists' });

    const hash = bcrypt.hashSync(password, 12);
    const id = uuidv4();
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, username, hash);
    req.log.info({ username }, 'User created');
    return reply.code(201).send({ id, username });
  });
}
