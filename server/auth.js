/**
 * auth.js — Restaurant authentication for nota.
 *
 * Restaurants register with email + password.
 * On login they get a JWT that gates the dashboard.
 *
 * Set in .env:
 *   JWT_SECRET=some-long-random-string   (required — generate with: openssl rand -hex 32)
 *
 * Endpoints (registered in server.js):
 *   POST /api/auth/register   { name, email, password, tableCount? }
 *   POST /api/auth/login      { email, password }
 *   GET  /api/auth/me         (requires Authorization: Bearer <token>)
 */

import crypto   from 'crypto';
import pg       from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'nota-dev-secret-change-in-production';

// ─── simple JWT (no external library needed) ──────────────────────────────────

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signJWT(payload) {
  const header  = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body    = base64url(Buffer.from(JSON.stringify(payload)));
  const sig     = base64url(
    crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${sig}`;
}

function verifyJWT(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = base64url(
      crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest()
    );
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64').toString());
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── password hashing (PBKDF2 — no external deps) ────────────────────────────

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await pbkdf2(password, salt);
  return `${salt}:${hash}`;
}

async function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = await pbkdf2(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
}

function pbkdf2(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.pbkdf2(password, salt, 100_000, 32, 'sha256', (err, key) =>
      err ? reject(err) : resolve(key.toString('hex'))
    )
  );
}

// ─── middleware ───────────────────────────────────────────────────────────────

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const payload = verifyJWT(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

  req.restaurant = payload;   // { restaurantId, name, email }
  next();
}

// ─── route handlers ───────────────────────────────────────────────────────────

export async function register(req, res) {
  const { name, email, password, tableCount = 8 } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check duplicate
    const { rows: existing } = await client.query(
      'SELECT id FROM restaurants WHERE email = $1', [email.toLowerCase()]
    );
    if (existing.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await hashPassword(password);

    // Create restaurant
    const { rows: [restaurant] } = await client.query(
      `INSERT INTO restaurants (name, email, password_hash, table_count)
       VALUES ($1, $2, $3, $4) RETURNING id, name, email, table_count`,
      [name, email.toLowerCase(), passwordHash, tableCount]
    );

    // Create tables
    for (let i = 1; i <= tableCount; i++) {
      await client.query(
        'INSERT INTO tables (restaurant_id, number) VALUES ($1, $2)',
        [restaurant.id, i]
      );
    }

    await client.query('COMMIT');

    const token = signJWT({
      restaurantId: restaurant.id,
      name:         restaurant.name,
      email:        restaurant.email,
      exp:          Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
    });

    res.status(201).json({ token, restaurant });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[auth] register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
}

export async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const { rows } = await pool.query(
    'SELECT id, name, email, password_hash FROM restaurants WHERE email = $1',
    [email.toLowerCase()]
  );
  if (!rows.length) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const restaurant = rows[0];
  const valid = await checkPassword(password, restaurant.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signJWT({
    restaurantId: restaurant.id,
    name:         restaurant.name,
    email:        restaurant.email,
    exp:          Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  });

  res.json({ token, restaurant: { id: restaurant.id, name: restaurant.name, email: restaurant.email } });
}

export async function me(req, res) {
  const { rows } = await pool.query(
    'SELECT id, name, email, table_count, created_at FROM restaurants WHERE id = $1',
    [req.restaurant.restaurantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
}
