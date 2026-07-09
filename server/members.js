/**
 * members.js — Club Eats member authentication for nota.
 *
 * Deliberately separate from restaurant auth (auth.js):
 *   - Different signing secret (JWT_SECRET + ':member') so a member token
 *     can never authenticate as a restaurant and vice versa.
 *   - Separate brute-force attempt tracking.
 *   - No restaurantId claim — payload is { memberId, email, plan, aud:'member' }.
 *
 * Endpoints registered in server.js:
 *   POST /api/members/register  { email, password }
 *   POST /api/members/login     { email, password }
 *   GET  /api/members/me        Bearer token required
 */

import crypto from 'crypto';
import { pool } from './db.js';

const BASE_SECRET   = process.env.JWT_SECRET || 'nota-dev-secret-change-in-production';
const MEMBER_SECRET = BASE_SECRET + ':member'; // distinct from restaurant JWT

// ─── simple JWT (same pattern as auth.js) ─────────────────────────────────────

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function signMemberJWT(payload) {
  const hdr = base64url(Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })));
  const bdy = base64url(Buffer.from(JSON.stringify({ ...payload, aud:'member' })));
  const sig = base64url(crypto.createHmac('sha256', MEMBER_SECRET).update(`${hdr}.${bdy}`).digest());
  return `${hdr}.${bdy}.${sig}`;
}

export function verifyMemberJWT(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const [hdr, bdy, sig] = token.split('.');
    if (!hdr || !bdy || !sig) return null;
    const expected = base64url(crypto.createHmac('sha256', MEMBER_SECRET).update(`${hdr}.${bdy}`).digest());
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(bdy, 'base64').toString());
    if (payload.aud !== 'member') return null;
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload; // { memberId, email, plan, aud }
  } catch {
    return null;
  }
}

// ─── password hashing ─────────────────────────────────────────────────────────

function pbkdf2(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.pbkdf2(password, salt, 100_000, 32, 'sha256',
      (err, key) => err ? reject(err) : resolve(key.toString('hex'))
    )
  );
}

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

// ─── brute-force protection ───────────────────────────────────────────────────

const memberAttempts = new Map();

function getLockoutMs(f) {
  if (f < 2) return 0;
  if (f < 3) return 30_000;
  if (f < 4) return 120_000;
  if (f < 5) return 300_000;
  return 10 * 60_000;
}

function checkLockout(key) {
  const s = memberAttempts.get(key);
  if (!s) return false;
  if (s.lockedUntil && Date.now() < s.lockedUntil) return true;
  if (s.lockedUntil && Date.now() >= s.lockedUntil) memberAttempts.delete(key);
  return false;
}

function recordFailure(key) {
  const s = memberAttempts.get(key) || { failures: 0, lockedUntil: null };
  s.failures++;
  const ms = getLockoutMs(s.failures);
  s.lockedUntil = ms > 0 ? Date.now() + ms : null;
  memberAttempts.set(key, s);
}

function clearAttempts(key) { memberAttempts.delete(key); }

// ─── middleware ───────────────────────────────────────────────────────────────

export function requireMemberAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const payload = verifyMemberJWT(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired member token' });
  req.member = payload;
  next();
}

// ─── referral code generator ──────────────────────────────────────────────────

const REFERRAL_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genReferralCode() {
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes).map(b => REFERRAL_CHARS[b % REFERRAL_CHARS.length]).join('');
}

// ─── exported helpers for payment flow ────────────────────────────────────────

export async function getActiveMemberBonus(memberId) {
  if (!memberId) return null;
  const { rows: [m] } = await pool.query(
    `SELECT bonus_pct, bonus_expires FROM members
     WHERE id=$1 AND bonus_pct > 0 AND bonus_expires > NOW()`,
    [memberId]
  );
  return m || null;
}

// ─── route handlers ───────────────────────────────────────────────────────────

export async function memberRegister(req, res) {
  const { email, password, refCode } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return res.status(400).json({ error: 'Email invalid' });
  if (typeof password !== 'string' || password.length < 8)
    return res.status(400).json({ error: 'Parola trebuie să aibă cel puțin 8 caractere' });

  try {
    const { rows: existing } = await pool.query(
      'SELECT id FROM members WHERE email=$1', [email.toLowerCase()]
    );
    if (existing.length) return res.status(409).json({ error: 'Email deja înregistrat' });

    // Resolve referrer if a code was provided
    let referrerId = null;
    if (refCode && typeof refCode === 'string' && /^[A-Z2-9]{6}$/.test(refCode.toUpperCase())) {
      const { rows: [ref] } = await pool.query(
        'SELECT id FROM members WHERE referral_code=$1',
        [refCode.toUpperCase()]
      );
      if (ref) referrerId = ref.id;
    }

    // Generate a unique referral code for the new member
    let newCode = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = genReferralCode();
      const { rows: clash } = await pool.query(
        'SELECT id FROM members WHERE referral_code=$1', [candidate]
      );
      if (!clash.length) { newCode = candidate; break; }
    }

    const hash = await hashPassword(password);
    const { rows: [m] } = await pool.query(
      `INSERT INTO members (email, password_hash, referral_code, referred_by)
       VALUES ($1, $2, $3, $4) RETURNING id, email, plan`,
      [email.toLowerCase(), hash, newCode, referrerId]
    );

    // Create referral row if applicable (self-referral is impossible: different IDs)
    if (referrerId && referrerId !== m.id) {
      try {
        await pool.query(
          `INSERT INTO referrals (referrer_id, referred_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [referrerId, m.id]
        );
      } catch { /* duplicate or constraint — ignore */ }
    }

    const token = signMemberJWT({
      memberId: m.id, email: m.email, plan: m.plan,
      exp: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60, // 90 days
    });
    res.status(201).json({ token, member: { id: m.id, email: m.email, plan: m.plan, referral_code: newCode } });
  } catch (err) {
    console.error('[members] register:', err);
    res.status(500).json({ error: 'Înregistrare eșuată' });
  }
}

export async function memberLogin(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const ip       = req.ip || req.socket?.remoteAddress || 'unknown';
  const emailKey = `member:email:${email.toLowerCase()}`;
  const ipKey    = `member:ip:${ip}`;

  if (checkLockout(emailKey) || checkLockout(ipKey))
    return res.status(429).json({ error: 'Prea multe încercări — încearcă mai târziu' });

  try {
    const { rows } = await pool.query(
      'SELECT id, email, password_hash, plan FROM members WHERE email=$1',
      [email.toLowerCase()]
    );
    if (!rows.length) {
      recordFailure(emailKey); recordFailure(ipKey);
      return res.status(401).json({ error: 'Email sau parolă incorectă' });
    }
    const m     = rows[0];
    const valid = await checkPassword(password, m.password_hash);
    if (!valid) {
      recordFailure(emailKey); recordFailure(ipKey);
      return res.status(401).json({ error: 'Email sau parolă incorectă' });
    }
    clearAttempts(emailKey); clearAttempts(ipKey);
    const token = signMemberJWT({
      memberId: m.id, email: m.email, plan: m.plan,
      exp: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
    });
    res.json({ token, member: { id: m.id, email: m.email, plan: m.plan } });
  } catch (err) {
    console.error('[members] login:', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
}

export async function memberMe(req, res) {
  try {
    const { rows: [m] } = await pool.query(
      `SELECT id, email, plan, referral_code, bonus_pct, bonus_expires, created_at
       FROM members WHERE id=$1`,
      [req.member.memberId]
    );
    if (!m) return res.status(404).json({ error: 'Member not found' });
    res.json(m);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function memberReferral(req, res) {
  const memberId = req.member.memberId;
  try {
    const [{ rows: [m] }, { rows: stats }] = await Promise.all([
      pool.query(
        `SELECT referral_code, bonus_pct, bonus_expires
         FROM members WHERE id=$1`, [memberId]
      ),
      pool.query(
        `SELECT
           COUNT(*)::int                                          AS total_invited,
           COUNT(*) FILTER (WHERE r.converted)::int              AS total_converted
         FROM referrals r WHERE r.referrer_id=$1`,
        [memberId]
      ),
    ]);
    if (!m) return res.status(404).json({ error: 'Member not found' });
    const bonusActive = m.bonus_pct > 0 && m.bonus_expires && new Date(m.bonus_expires) > new Date();
    res.json({
      referral_code: m.referral_code,
      total_invited:   stats[0]?.total_invited   || 0,
      total_converted: stats[0]?.total_converted || 0,
      bonus_pct:     bonusActive ? m.bonus_pct : 0,
      bonus_expires: bonusActive ? m.bonus_expires : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
