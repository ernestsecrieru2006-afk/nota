/**
 * staff.js — Floor-staff authentication for nota.
 *
 * Deliberately separate from both restaurant auth (auth.js) and member auth (members.js):
 *   - Different signing secret (JWT_SECRET + ':staff') so a staff token can never authenticate
 *     as a restaurant or a member, and vice versa.
 *   - No staff identity at all — there is no per-staff-member registration, just one shared
 *     link + PIN per restaurant, generated/revoked by the owner from the dashboard.
 *   - Read-only + acknowledge-actions only. Nothing in this file ever exposes revenue,
 *     analytics, settings, offers, or exports — those routes simply never accept a staff token.
 *
 * Revocation model: a JWT can't be un-signed before its exp, so revocation is NOT enforced by
 * expiry. It's enforced by requireStaffAuth doing a DB lookup on staff_access_links.active on
 * every request. The JWT's long expiry (365 days) only bounds the absolute worst case (DB row
 * deleted outright rather than deactivated); the real revocation path is the `active` flag.
 *
 * Endpoints (registered in server.js):
 *   POST /api/staff/redeem   { linkToken, pin }   → { token, restaurantName }
 */

import crypto from 'crypto';
import { pool } from './db.js';
import { sweepAttemptMap } from './mem-sweep.js';

const BASE_SECRET  = process.env.JWT_SECRET || 'nota-dev-secret-change-in-production';
const STAFF_SECRET = BASE_SECRET + ':staff'; // distinct from restaurant AND member JWTs

// ─── simple JWT (same pattern as auth.js / members.js) ────────────────────────

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signStaffJWT(payload) {
  const hdr = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const bdy = base64url(Buffer.from(JSON.stringify({ ...payload, aud: 'staff' })));
  const sig = base64url(crypto.createHmac('sha256', STAFF_SECRET).update(`${hdr}.${bdy}`).digest());
  return `${hdr}.${bdy}.${sig}`;
}

export function verifyStaffJWT(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const [hdr, bdy, sig] = token.split('.');
    if (!hdr || !bdy || !sig) return null;
    const expected = base64url(crypto.createHmac('sha256', STAFF_SECRET).update(`${hdr}.${bdy}`).digest());
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(bdy, 'base64').toString());
    if (payload.aud !== 'staff') return null;
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload; // { restaurantId, linkId, aud }
  } catch {
    return null;
  }
}

// ─── PIN hashing (PBKDF2 — same as password hashing in auth.js/members.js) ───

function pbkdf2(pin, salt) {
  return new Promise((resolve, reject) =>
    crypto.pbkdf2(pin, salt, 100_000, 32, 'sha256',
      (err, key) => err ? reject(err) : resolve(key.toString('hex'))
    )
  );
}

export async function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await pbkdf2(pin, salt);
  return `${salt}:${hash}`;
}

async function checkPin(pin, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = await pbkdf2(pin, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
}

// ─── brute-force protection ───────────────────────────────────────────────────
// Keyed by BOTH the link token and the IP: locking only the link would let one attacker on one
// IP lock every legitimate staff device out of onboarding for 10 minutes; locking only the IP
// would let an attacker rotate IPs to guess unbounded. Both together close both gaps, same as
// the existing email+IP pattern in auth.js/members.js.

const staffAttempts = new Map();

function getLockoutMs(f) {
  if (f < 2) return 0;
  if (f < 3) return 30_000;
  if (f < 4) return 120_000;
  if (f < 5) return 300_000;
  return 10 * 60_000;
}

function checkLockout(key) {
  const s = staffAttempts.get(key);
  if (!s) return false;
  if (s.lockedUntil && Date.now() < s.lockedUntil) return true;
  if (s.lockedUntil && Date.now() >= s.lockedUntil) staffAttempts.delete(key);
  return false;
}

function recordFailure(key) {
  const s = staffAttempts.get(key) || { failures: 0, lockedUntil: null };
  s.failures++;
  const ms = getLockoutMs(s.failures);
  s.lockedUntil = ms > 0 ? Date.now() + ms : null;
  s.updatedAt = Date.now();
  staffAttempts.set(key, s);
}

// Called from server.js's periodic sweep — see mem-sweep.js.
export function sweepStaffAttempts() {
  return sweepAttemptMap(staffAttempts);
}

// Read-only size for the internal metrics endpoint — no entries, no keys, just a count.
export function staffAttemptsSize() { return staffAttempts.size; }

function clearAttempts(key) { staffAttempts.delete(key); }

// ─── middleware ───────────────────────────────────────────────────────────────

// Verifies the JWT AND checks the DB that its linkId is still active — this DB check is the
// actual revocation mechanism (see file header). Fails CLOSED on a DB error (503), deliberately
// unlike the guest app's fail-open table-token lookup: a DB hiccup must never let a revoked
// staff session keep working, since instant revocation is the one hard security requirement here.
export async function requireStaffAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const payload = verifyStaffJWT(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  try {
    const { rows: [link] } = await pool.query(
      'SELECT active FROM staff_access_links WHERE id=$1 AND restaurant_id=$2',
      [payload.linkId, payload.restaurantId]
    );
    if (!link || !link.active) return res.status(401).json({ error: 'Acces revocat' });
  } catch (err) {
    console.error('[staff] requireStaffAuth DB check failed:', err.message);
    return res.status(503).json({ error: 'Temporar indisponibil' });
  }
  req.staff = payload; // { restaurantId, linkId, aud }
  next();
}

// ─── route handler ─────────────────────────────────────────────────────────────

export async function redeemStaffLink(req, res) {
  const { linkToken, pin } = req.body || {};
  if (!linkToken || !pin || typeof linkToken !== 'string' || typeof pin !== 'string') {
    return res.status(400).json({ error: 'linkToken și pin necesare' });
  }

  const ip       = req.ip || req.socket?.remoteAddress || 'unknown';
  const linkKey  = `link:${linkToken}`;
  const ipKey    = `ip:${ip}`;

  if (checkLockout(linkKey) || checkLockout(ipKey)) {
    return res.status(429).json({ error: 'Prea multe încercări — încearcă mai târziu' });
  }

  try {
    const { rows: [row] } = await pool.query(
      `SELECT sal.id, sal.restaurant_id, sal.pin_hash, r.name AS restaurant_name
       FROM staff_access_links sal JOIN restaurants r ON r.id = sal.restaurant_id
       WHERE sal.link_token = $1 AND sal.active`,
      [linkToken]
    );
    if (!row) {
      recordFailure(linkKey); recordFailure(ipKey);
      return res.status(401).json({ error: 'Link invalid sau revocat' });
    }

    const valid = await checkPin(pin, row.pin_hash);
    if (!valid) {
      recordFailure(linkKey); recordFailure(ipKey);
      return res.status(401).json({ error: 'PIN incorect' });
    }

    clearAttempts(linkKey); clearAttempts(ipKey);

    const token = signStaffJWT({
      restaurantId: row.restaurant_id,
      linkId:       row.id,
      exp:          Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60, // 365 days
    });
    res.json({ token, restaurantName: row.restaurant_name });
  } catch (err) {
    console.error('[staff] redeem error:', err.message);
    res.status(500).json({ error: 'Eroare internă' });
  }
}
