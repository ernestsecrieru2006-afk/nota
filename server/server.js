/**
 * server.js — nota. Express + Socket.io server
 *
 * Payment settlement is strictly provider-confirmed:
 *   1. Guest confirms → pending DB record created, items stay claimed
 *   2. Only after MIA webhook/poll returns PAID → items marked paid, balance reduced
 *   3. On FAILED/EXPIRED/CANCELLED or 3-min timeout → items released, balance unchanged
 *
 * ENV vars:
 *   DATABASE_URL          Postgres connection string (required)
 *   JWT_SECRET            Random secret for auth tokens (required in prod)
 *   APP_URL               Public URL e.g. https://paynota.com
 *   PORT                  Default 3000
 *   DEV_API_KEY           Optional secret header for /api/dev/* endpoints
 *   IIKO_API_LOGIN / IIKO_BASE_URL / IIKO_ORG_ID  → enables live POS sync
 *   MIA_BASE_URL / MIA_MERCHANT_ID / MIA_SECRET / MIA_WEBHOOK_SECRET  → enables real payments
 */

import 'dotenv/config';
import express          from 'express';
import { createServer } from 'http';
import { Server }       from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import compression      from 'compression';
import helmet          from 'helmet';
import rateLimit       from 'express-rate-limit';
import QRCode           from 'qrcode';

import { pool } from './db.js';
import { getOpenOrder, parseIikoWebhook } from './iiko.js';
import { requestPayment, getPaymentStatus, verifyWebhookSignature, parseWebhookPayload, setMockFailNext } from './mia.js';
import { register, login, me, requireAuth, verifyJWT } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app       = express();
const httpServer= createServer(app);
const PORT      = process.env.PORT || 3000;
const APP_URL   = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const DEV_API_KEY = process.env.DEV_API_KEY || null;
const MIA_LIVE    = !!(process.env.MIA_MERCHANT_ID && process.env.MIA_SECRET);
const IIKO_LIVE   = !!(process.env.IIKO_API_LOGIN && process.env.IIKO_ORG_ID);

// Canonical hostname — used for the production 301 redirect.
// Derived from APP_URL so no second variable needs to be set.
let _canonicalHost = null;
try { _canonicalHost = new URL(APP_URL).hostname; } catch {}
const CANONICAL_HOST      = _canonicalHost;
const ENFORCE_CANONICAL   = APP_URL.startsWith('https://') &&
                            !!CANONICAL_HOST &&
                            !CANONICAL_HOST.includes('localhost') &&
                            !CANONICAL_HOST.includes('127.0.0.1');

// Socket.io: tighten CORS to APP_URL in production
const io = new Server(httpServer, {
  cors: { origin: ENFORCE_CANONICAL ? APP_URL : '*' },
  perMessageDeflate: true,
});

// ─── middleware ───────────────────────────────────────────────────────────────

app.set('trust proxy', 1);

// 301-redirect any non-canonical host to the canonical URL.
// Only active in production (when APP_URL is https:// non-localhost).
// Use req.headers.host (raw header) rather than req.hostname because Railway's Hikari proxy
// normalises X-Forwarded-Host to the custom domain for all requests.
if (ENFORCE_CANONICAL) {
  app.use((req, res, next) => {
    const rawHost = (req.headers.host || '').split(':')[0].toLowerCase();
    if (rawHost && rawHost !== CANONICAL_HOST) {
      return res.redirect(301, `https://${CANONICAL_HOST}${req.url}`);
    }
    next();
  });
}

app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      styleSrc:   ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc:    ["'self'", "fonts.gstatic.com"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc:     ["'self'", "data:"],
      objectSrc:  ["'none'"],
    },
  },
}));
app.use('/api/payment/webhook', express.raw({ type: '*/*' }));
app.use('/api/iiko/webhook',    express.raw({ type: '*/*' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(join(__dirname, '../public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      // Revalidate HTML on every request so deploys go live immediately
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ─── rate limiting ────────────────────────────────────────────────────────────

const limiterGlobal = rateLimit({
  windowMs: 60_000, max: 200,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests' },
});
const limiterAuth = rateLimit({
  windowMs: 15 * 60_000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many auth attempts' },
});
const limiterPaymentHttp = rateLimit({
  windowMs: 60_000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many payment requests' },
});

app.use(limiterGlobal);

// ─── auth middleware helpers ──────────────────────────────────────────────────

// DEV_API_KEY or JWT: gates /api/dev/* routes.
// Key-auth: req.restaurant.restaurantId is null → body restaurantId honored.
// JWT-auth: req.restaurant.restaurantId from token → body restaurantId ignored.
function requireDevAuth(req, res, next) {
  if (DEV_API_KEY && req.headers['x-dev-key'] === DEV_API_KEY) {
    req.restaurant = { restaurantId: null };
    return next();
  }
  requireAuth(req, res, next);
}

// JWT from ?token= query param OR Authorization: Bearer header.
// Used for browser-navigated pages (e.g. /qrcodes opened in a new tab).
function requireAuthOrQuery(req, res, next) {
  const queryToken = req.query.token;
  if (queryToken) {
    const payload = verifyJWT(queryToken);
    if (payload) { req.restaurant = payload; return next(); }
    return res.status(401).send('<p>Token invalid. <a href="/dashboard">Înapoi la dashboard</a></p>');
  }
  requireAuth(req, res, next);
}

// ─── auth routes ─────────────────────────────────────────────────────────────

app.post('/api/auth/register', limiterAuth, register);
app.post('/api/auth/login',    limiterAuth, login);
app.get( '/api/auth/me',       requireAuth, me);

// ─── table / order routes ─────────────────────────────────────────────────────
// NOTE: Legacy numeric routes (GET /api/table/:n, POST /api/table/:n/item) removed —
// they bypassed token security. Use GET /api/table/by-token/:token instead.

app.get('/api/table/by-token/:token', async (req, res) => {
  try {
    const { rows: [tbl] } = await pool.query(
      'SELECT number, restaurant_id FROM tables WHERE token = $1',
      [req.params.token]
    );
    if (!tbl) return res.status(404).json({ error: 'Masă invalidă' });
    const order = await getOpenOrder(tbl.number, tbl.restaurant_id);
    res.json({ ...order, table_number: tbl.number });
  } catch (err) {
    console.error('[GET /api/table/by-token]', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
});

// ─── payment webhook ──────────────────────────────────────────────────────────

app.post('/api/payment/webhook', limiterPaymentHttp, async (req, res) => {
  // Mock mode: settlements happen via internal timers only — reject external webhooks.
  if (!MIA_LIVE) return res.status(403).json({ error: 'Webhook indisponibil în modul demo' });
  try {
    const sig = req.headers['x-mia-signature'] || req.headers['x-signature'] || '';
    if (!verifyWebhookSignature(req.body, sig)) return res.status(401).send('Bad signature');

    const body    = JSON.parse(req.body.toString());
    const payload = parseWebhookPayload(body);
    const miaId   = payload.paymentId;

    if (payload.status === 'PAID') {
      await settlePayment(miaId, miaId);
    } else if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(payload.status)) {
      await releasePayment(miaId, `Plata ${payload.status.toLowerCase()}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[webhook]', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
});

// ─── iiko webhook ─────────────────────────────────────────────────────────────

app.post('/api/iiko/webhook', limiterPaymentHttp, async (req, res) => {
  if (!IIKO_LIVE) return res.status(403).json({ error: 'iiko not configured' });
  try {
    if (!req.body || req.body.length === 0) return res.status(400).json({ error: 'Empty payload' });
    const body   = JSON.parse(req.body.toString());
    const orders = await parseIikoWebhook(body);
    for (const o of orders) {
      if (o.tableNumber) {
        // Resolve restaurant from table number (single-org iiko setup)
        const { rows: [tbl] } = await pool.query(
          'SELECT restaurant_id FROM tables WHERE number = $1 LIMIT 1', [o.tableNumber]
        );
        const rid   = tbl?.restaurant_id;
        const fresh = await getOpenOrder(o.tableNumber, rid);
        if (rid) {
          io.to(`table-${rid}-${o.tableNumber}`).emit('order-update', fresh);
          io.to(`dashboard-${rid}`).emit('order-update', { tableNumber: o.tableNumber, order: fresh });
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[iiko webhook]', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
});

// ─── dashboard API (require auth) ─────────────────────────────────────────────

app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const rId = req.restaurant.restaurantId;
    const { rows } = await pool.query(`
      SELECT
        COALESCE(SUM(amount_lei + tip_lei), 0) AS total_lei,
        COUNT(*)                                AS payment_count,
        COALESCE(SUM(tip_lei), 0)               AS total_tips
      FROM payments
      WHERE restaurant_id = $1 AND status = 'paid' AND paid_at >= CURRENT_DATE
    `, [rId]);
    res.json(rows[0]);
  } catch (err) {
    console.error('[stats]', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
});

app.get('/api/dashboard/top-dishes', requireAuth, async (req, res) => {
  try {
    const rId = req.restaurant.restaurantId;
    const { rows } = await pool.query(`
      SELECT oi.name, COUNT(*) AS times_ordered, SUM(oi.price) AS revenue_lei
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.restaurant_id = $1 AND oi.status = 'paid'
        AND o.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY oi.name
      ORDER BY times_ordered DESC LIMIT 10
    `, [rId]);
    res.json(rows);
  } catch (err) {
    console.error('[top-dishes]', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
});

app.get('/api/dashboard/hourly', requireAuth, async (req, res) => {
  try {
    const rId = req.restaurant.restaurantId;
    const { rows } = await pool.query(`
      SELECT EXTRACT(HOUR FROM paid_at)::int AS hour,
             SUM(amount_lei + tip_lei)       AS total_lei,
             COUNT(*)                        AS count
      FROM payments
      WHERE restaurant_id = $1 AND status = 'paid' AND paid_at >= CURRENT_DATE
      GROUP BY hour ORDER BY hour
    `, [rId]);
    res.json(rows);
  } catch (err) {
    console.error('[hourly]', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
});

app.get('/api/dashboard/recent', requireAuth, async (req, res) => {
  try {
    const rId = req.restaurant.restaurantId;
    const { rows } = await pool.query(`
      SELECT p.id, o.table_number, p.amount_lei, p.tip_lei, p.paid_at
      FROM payments p
      JOIN orders o ON o.id = p.order_id
      WHERE p.restaurant_id = $1 AND p.status = 'paid'
      ORDER BY p.paid_at DESC LIMIT 30
    `, [rId]);
    res.json(rows);
  } catch (err) {
    console.error('[recent]', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
});

app.get('/api/dashboard/tables', requireAuth, async (req, res) => {
  try {
    const rId = req.restaurant.restaurantId;
    const { rows } = await pool.query(`
      SELECT t.number,
             COUNT(oi.id) FILTER (WHERE oi.status = 'available') AS available,
             COUNT(oi.id) FILTER (WHERE oi.status = 'claimed')   AS claimed,
             COUNT(oi.id) FILTER (WHERE oi.status = 'paid')      AS paid,
             COALESCE(SUM(oi.price) FILTER (WHERE oi.status IN ('available','claimed')), 0) AS unpaid_lei
      FROM tables t
      LEFT JOIN orders o  ON o.table_id = t.id AND o.status = 'open'
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE t.restaurant_id = $1
      GROUP BY t.number ORDER BY t.number
    `, [rId]);
    res.json(rows);
  } catch (err) {
    console.error('[tables]', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
});

// ─── CSV export ───────────────────────────────────────────────────────────────

app.get('/api/dashboard/export', requireAuth, async (req, res) => {
  try {
    const rId       = req.restaurant.restaurantId;
    const date      = req.query.date;
    const validDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;

    const { rows } = await pool.query(`
      SELECT p.paid_at, o.table_number, p.amount_lei, p.tip_lei,
             (p.amount_lei + p.tip_lei) AS total_lei, p.mia_payment_id
      FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.restaurant_id = $1 AND p.status = 'paid'
        ${validDate ? 'AND p.paid_at::date = $2::date' : 'AND p.paid_at >= CURRENT_DATE'}
      ORDER BY p.paid_at
    `, validDate ? [rId, validDate] : [rId]);

    const csvDate = validDate || new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nota-${csvDate}.csv"`);

    const lines = [
      'Ora,Masa,Suma (lei),Bacsis (lei),Total (lei),MIA ID',
      ...rows.map(r => {
        const time = new Date(r.paid_at).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
        return [time, r.table_number, r.amount_lei, r.tip_lei, r.total_lei, r.mia_payment_id || ''].join(',');
      }),
    ];
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('[export]', err);
    res.status(500).json({ error: 'Eroare la export' });
  }
});

// ─── dev / demo routes (require DEV_API_KEY header or JWT) ────────────────────

app.post('/api/dev/seed-table', requireDevAuth, async (req, res) => {
  try {
    const tableNumber  = req.body.tableNumber  ?? 1;
    // JWT auth: restaurantId from token; key auth: from body
    const restaurantId = req.restaurant.restaurantId ?? req.body.restaurantId ?? 1;

    const { rows: [tbl] } = await pool.query(
      'SELECT id FROM tables WHERE restaurant_id = $1 AND number = $2',
      [restaurantId, tableNumber]
    );
    if (!tbl) return res.status(404).json({ error: `Table ${tableNumber} not found` });

    let { rows: [order] } = await pool.query(
      `SELECT id FROM orders WHERE table_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
      [tbl.id]
    );
    if (!order) {
      const { rows: [o] } = await pool.query(
        `INSERT INTO orders (table_id, table_number, restaurant_id, status)
         VALUES ($1, $2, $3, 'open') RETURNING id`,
        [tbl.id, tableNumber, restaurantId]
      );
      order = o;
    }

    // Also cancel any pending payments for this order so the state is clean
    await pool.query(
      `UPDATE payments SET status='cancelled' WHERE order_id=$1 AND status='pending'`,
      [order.id]
    );
    await pool.query(`DELETE FROM order_items WHERE order_id = $1`, [order.id]);

    const DEMO_DISHES = [
      ['Spaghetti Carbonara', 185],
      ['Risotto ai Funghi',   210],
      ['Branzino al Forno',   290],
      ['Tiramisù',             95],
      ['Vino Rosso (pahar)',   75],
    ];
    // Single multi-row INSERT instead of 5 sequential round-trips
    const dParams = [order.id];
    const dPlaceholders = DEMO_DISHES.map(([name, price]) => {
      dParams.push(name, price);
      const n = dParams.length;
      return `($1, $${n - 1}, $${n}, 'available')`;
    }).join(', ');
    await pool.query(
      `INSERT INTO order_items (order_id, name, price, status) VALUES ${dPlaceholders}`,
      dParams
    );

    const fresh = await getOpenOrder(tableNumber, restaurantId);
    io.to(`table-${restaurantId}-${tableNumber}`).emit('order-update', fresh);
    res.json({ ok: true, orderId: order.id, items: DEMO_DISHES.length });
  } catch (err) {
    console.error('[seed-table]', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
});

app.post('/api/dev/seed-payments', requireDevAuth, async (req, res) => {
  const rId = req.restaurant.restaurantId ?? req.body.restaurantId ?? 1;
  const DISHES = [
    ['Spaghetti Carbonara', 185], ['Risotto ai Funghi', 210], ['Branzino al Forno', 290],
    ['Tiramisù', 95], ['Vino Rosso (pahar)', 75], ['Acqua Minerale', 35],
    ['Pizza Margherita', 165], ['Bruschetta', 85], ['Panna Cotta', 90],
  ];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < 20; i++) {
      const tableNum = (i % 8) + 1;
      const { rows: [t] } = await client.query(
        'SELECT id FROM tables WHERE restaurant_id = $1 AND number = $2', [rId, tableNum]
      );
      if (!t) continue;
      const { rows: [o] } = await client.query(
        `INSERT INTO orders (table_id, table_number, restaurant_id, status)
         VALUES ($1, $2, $3, 'open') RETURNING id`,
        [t.id, tableNum, rId]
      );
      const dish = DISHES[i % DISHES.length];
      await client.query(
        `INSERT INTO order_items (order_id, name, price, status) VALUES ($1, $2, $3, 'paid')`,
        [o.id, dish[0], dish[1]]
      );
      const hoursAgo = Math.floor(Math.random() * 8);
      await client.query(
        `INSERT INTO payments (order_id, restaurant_id, amount_lei, tip_lei, status, paid_at)
         VALUES ($1, $2, $3, $4, 'paid', NOW() - INTERVAL '${hoursAgo} hours')`,
        [o.id, rId, dish[1], Math.round(dish[1] * 0.1)]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, seeded: 20 });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed-payments]', err);
    res.status(500).json({ error: 'Eroare internă' });
  } finally {
    client.release();
  }
});

// Trigger mock payment failure for the NEXT payment initiated
app.post('/api/dev/mock-fail-next', requireDevAuth, (req, res) => {
  setMockFailNext();
  res.json({ ok: true, message: 'Next mock payment will be declined' });
});

app.get('/api/dev/table-token/:n', requireDevAuth, async (req, res) => {
  try {
    const rId    = req.restaurant.restaurantId ?? (req.query.restaurantId ? Number(req.query.restaurantId) : null);
    const filter = rId ? ' AND restaurant_id = $2' : '';
    const params = rId ? [Number(req.params.n), rId] : [Number(req.params.n)];
    const { rows: [tbl] } = await pool.query(
      `SELECT number, token FROM tables WHERE number = $1${filter} LIMIT 1`,
      params
    );
    if (!tbl) return res.status(404).json({ error: 'Table not found' });
    res.json({ number: tbl.number, token: tbl.token, url: `${APP_URL}/?t=${tbl.token}` });
  } catch (err) {
    console.error('[dev/table-token]', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
});

// ─── QR codes (require dashboard auth, scoped to calling restaurant) ──────────

app.get('/qrcodes', requireAuthOrQuery, async (req, res) => {
  const restaurantId = req.restaurant.restaurantId;
  const { rows: tables } = await pool.query(
    'SELECT number, token FROM tables WHERE restaurant_id = $1 ORDER BY number',
    [restaurantId]
  );
  if (!tables.length) return res.status(404).send('<p>No tables found. Run setup-db.js first.</p>');
  const missing = tables.filter(t => !t.token);
  if (missing.length) {
    return res.status(500).send(`<p>Tables ${missing.map(t=>t.number).join(', ')} missing tokens. Re-run setup-db.js.</p>`);
  }
  const qrs = await Promise.all(
    tables.map(async t => ({
      n: t.number, token: t.token,
      url: `${APP_URL}/?t=${t.token}`,
      svg: await QRCode.toString(`${APP_URL}/?t=${t.token}`, { type: 'svg', width: 200 }),
    }))
  );
  res.send(`<!DOCTYPE html>
<html lang="ro"><head><meta charset="UTF-8"><title>QR — nota.</title>
<style>*{box-sizing:border-box}body{font-family:sans-serif;background:#fafafa;padding:2rem}h1{margin-bottom:1.5rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,220px);gap:2rem}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:1.25rem;display:flex;flex-direction:column;align-items:center;gap:.5rem}
.card h2{margin:0;font-size:1rem;color:#374151}.card svg{width:160px;height:160px}
.card small{font-size:10px;color:#6b7280;word-break:break-all;text-align:center}
@media print{body{padding:0}h1{display:none}}</style>
</head><body>
<h1>QR Coduri Masă — nota.</h1>
<div class="grid">
${qrs.map(({n,url,svg})=>`<div class="card"><h2>Masa ${n}</h2>${svg}<small>${url}</small></div>`).join('')}
</div></body></html>`);
});

// ─── health ───────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({
  ok:   true,
  iiko: IIKO_LIVE,
  mia:  MIA_LIVE,
  db:   !!process.env.DATABASE_URL,
}));

// ═══════════════════════════════════════════════════════════════════════════════
// Payment state — in-memory meta for in-flight payments (lost on restart;
// reconciliation picks up pending rows from DB on next tick).
// ═══════════════════════════════════════════════════════════════════════════════

// paymentId (MIA id) → { dbPaymentId, socketId, tableNumber, restaurantId, orderId, amountLei, tipLei, mode, itemIds, timer }
const paymentMeta = new Map();

// socketId → miaPaymentId — to know if this socket has an in-flight payment
const socketInflight = new Map();

// Per-socket event rate limit: 30 events per 10s window
const socketThrottle = new Map();

function checkThrottle(socket) {
  const now = Date.now();
  let s = socketThrottle.get(socket.id);
  if (!s || now >= s.resetAt) {
    socketThrottle.set(socket.id, { count: 1, resetAt: now + 10_000 });
    return false;
  }
  s.count++;
  if (s.count > 30) {
    socket.disconnect(true);
    return true;
  }
  return false;
}

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', socket => {
  let currentTable = null;
  let currentRestaurantId = null;

  socket.on('join-table', async ({ token, tableNumber, restaurantId, paymentId } = {}) => {
    if (checkThrottle(socket)) return;
    try {
      let resolvedNumber = tableNumber;
      let resolvedRestaurantId = restaurantId || null;
      if (token) {
        if (typeof token !== 'string' || !/^[0-9a-f]{16}$/.test(token)) {
          return socket.emit('error', { message: 'Masă invalidă' });
        }
        const { rows: [tbl] } = await pool.query(
          'SELECT number, restaurant_id FROM tables WHERE token = $1', [token]
        );
        if (!tbl) return socket.emit('error', { message: 'Masă invalidă' });
        resolvedNumber = tbl.number;
        resolvedRestaurantId = tbl.restaurant_id;
      }
      if (!resolvedNumber) return socket.emit('error', { message: 'Masă invalidă' });
      currentTable = resolvedNumber;
      currentRestaurantId = resolvedRestaurantId;
      socket.join(`table-${resolvedRestaurantId}-${resolvedNumber}`);
      const order = await getOpenOrder(resolvedNumber, currentRestaurantId);
      socket.emit('order-update', order);

      // Payment recovery on reconnect: re-emit confirmed/failed based on DB state
      if (paymentId && typeof paymentId === 'string' && paymentId.length < 128) {
        try {
          const { rows: [pmt] } = await pool.query(
            `SELECT p.status, p.amount_lei, p.tip_lei, p.mode
             FROM payments p JOIN orders o ON o.id = p.order_id
             WHERE p.mia_payment_id = $1 AND o.restaurant_id = $2`,
            [paymentId, resolvedRestaurantId]
          );
          if (pmt) {
            if (pmt.status === 'paid') {
              socket.emit('payment-confirmed', {
                amountLei: pmt.amount_lei, tipLei: pmt.tip_lei,
                total: Number(pmt.amount_lei) + Number(pmt.tip_lei),
                mode: pmt.mode, itemIds: [],
              });
            } else if (['failed', 'expired', 'cancelled', 'duplicate'].includes(pmt.status)) {
              socket.emit('payment-failed', { reason: 'Plata nu a putut fi confirmată' });
            }
          }
        } catch (recErr) {
          console.error('[join-table recovery]', recErr);
        }
      }
    } catch (err) {
      console.error('[join-table]', err);
      socket.emit('error', { message: 'Eroare internă' });
    }
  });

  // Authenticated: requires valid JWT in the event payload
  socket.on('join-dashboard', ({ token: dashToken } = {}) => {
    const payload = verifyJWT(dashToken);
    if (!payload) return socket.emit('error', { message: 'Unauthorized' });
    socket.join(`dashboard-${payload.restaurantId}`);
  });

  socket.on('claim-items', async (itemIds, ack) => {
    if (checkThrottle(socket)) return ack?.({ error: 'Rate limit' });
    if (!currentTable) return ack?.({ error: 'Not joined to a table' });
    if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > 50) {
      return ack?.({ error: 'Invalid itemIds' });
    }
    if (itemIds.some(id => !Number.isInteger(id) || id <= 0)) {
      return ack?.({ error: 'Invalid itemIds' });
    }
    try {
      const { rows: claimed } = await pool.query(`
        UPDATE order_items oi
        SET status = 'claimed', claimed_by = $1
        FROM orders o
        JOIN tables t ON t.id = o.table_id
        WHERE oi.id = ANY($2) AND oi.status = 'available'
          AND oi.order_id = o.id AND o.status = 'open' AND t.number = $3
        RETURNING oi.id
      `, [socket.id, itemIds, currentTable]);

      const contestedIds = itemIds.filter(id => !claimed.find(r => r.id === id));
      if (claimed.length > 0) {
        io.to(`table-${currentRestaurantId}-${currentTable}`).emit('items-patch',
          claimed.map(r => ({ id: r.id, status: 'claimed', claimed_by: socket.id }))
        );
      }
      ack?.({ claimed: claimed.map(r => r.id), contested: contestedIds });
    } catch (err) {
      console.error('[claim-items]', err);
      ack?.({ error: 'Eroare internă' });
    }
  });

  socket.on('release-claims', async () => {
    if (!currentTable) return;
    try {
      // Never release while payment is in-flight — that's the server's job
      if (socketInflight.has(socket.id)) return;
      const { rows: released } = await pool.query(`
        UPDATE order_items oi SET status = 'available', claimed_by = NULL
        FROM orders o JOIN tables t ON t.id = o.table_id
        WHERE oi.claimed_by = $1 AND oi.status = 'claimed'
          AND oi.order_id = o.id AND o.status = 'open' AND t.number = $2
        RETURNING oi.id
      `, [socket.id, currentTable]);
      if (released.length > 0) {
        io.to(`table-${currentRestaurantId}-${currentTable}`).emit('items-patch',
          released.map(r => ({ id: r.id, status: 'available', claimed_by: null }))
        );
      }
    } catch (err) {
      console.error('[release-claims]', err);
    }
  });

  // Single-item deselect — only releases the one tapped item, never others.
  // This fixes the "deselect clears everything" bug caused by release-all + re-claim-rest.
  socket.on('release-item', async (itemId, ack) => {
    if (!currentTable) return ack?.({ released: [] });
    if (!Number.isInteger(itemId) || itemId <= 0) return ack?.({ error: 'Invalid itemId' });
    try {
      if (socketInflight.has(socket.id)) return ack?.({ released: [] });
      const { rows } = await pool.query(`
        UPDATE order_items oi SET status = 'available', claimed_by = NULL
        FROM orders o JOIN tables t ON t.id = o.table_id
        WHERE oi.id = $1 AND oi.claimed_by = $2 AND oi.status = 'claimed'
          AND oi.order_id = o.id AND o.status = 'open' AND t.number = $3
        RETURNING oi.id
      `, [itemId, socket.id, currentTable]);
      if (rows.length > 0) {
        io.to(`table-${currentRestaurantId}-${currentTable}`).emit('items-patch',
          [{ id: rows[0].id, status: 'available', claimed_by: null }]
        );
      }
      ack?.({ released: rows.map(r => r.id) });
    } catch (err) {
      console.error('[release-item]', err);
      ack?.({ error: 'Eroare internă' });
    }
  });

  // ── pay-claimed: item-level payment (splitMode = 'mine') ──────────────────
  socket.on('pay-claimed', async ({ tipLei }, ack) => {
    if (checkThrottle(socket)) return ack?.({ error: 'Rate limit' });
    if (!currentTable) return ack?.({ error: 'Not joined to a table' });
    const tip = Number(tipLei) || 0;
    if (!Number.isFinite(tip) || tip < 0) return ack?.({ error: 'Invalid tip' });
    try {
      const tbl   = currentTable;
      const order = await getOpenOrder(tbl, currentRestaurantId);
      const mine  = order.items.filter(it => it.claimed_by === socket.id && it.status === 'claimed');
      if (!mine.length) return ack?.({ error: 'No claimed items' });

      const amountLei = mine.reduce((s, it) => s + Number(it.price), 0);
      const dbPmtId   = await createPendingPayment({ orderId: order.id, amountLei, tipLei: tip, socketId: socket.id, mode: 'claimed' });

      let payment;
      try {
        payment = await requestPayment({ amountLei, tipLei: tip, orderId: order.id, tableNumber: tbl });
      } catch (err) {
        await pool.query(`UPDATE payments SET status='failed' WHERE id=$1`, [dbPmtId]);
        return ack?.({ error: 'Plata nu a putut fi inițiată' });
      }

      await pool.query(`UPDATE payments SET mia_payment_id=$1 WHERE id=$2`, [payment.paymentId, dbPmtId]);

      const meta = { dbPaymentId: dbPmtId, socketId: socket.id, tableNumber: tbl, restaurantId: currentRestaurantId, orderId: order.id, amountLei, tipLei: tip, mode: 'claimed', itemIds: mine.map(i => i.id) };
      paymentMeta.set(payment.paymentId, meta);
      socketInflight.set(socket.id, payment.paymentId);

      ack?.({ success: true, ...payment });

      if (payment._mock) {
        const timer = setTimeout(() => {
          payment._shouldFail
            ? releasePayment(payment.paymentId, 'Plata a fost refuzată')
            : settlePayment(payment.paymentId);
        }, 2000);
        meta.timer = timer;
      }
    } catch (err) {
      console.error('[pay-claimed]', err);
      ack?.({ error: 'Eroare internă' });
    }
  });

  // ── pay-flat: flat-amount payment (splitMode = 'equal' or 'rest') ─────────
  socket.on('pay-flat', async ({ amountLei, tipLei = 0, mode }, ack) => {
    if (checkThrottle(socket)) return ack?.({ error: 'Rate limit' });
    if (!currentTable) return ack?.({ error: 'Not joined to a table' });
    if (!['equal', 'rest'].includes(mode)) return ack?.({ error: 'Invalid mode' });
    const tip = Number(tipLei) || 0;
    if (!Number.isFinite(tip) || tip < 0) return ack?.({ error: 'Invalid tip' });
    if (mode === 'equal') {
      const amt = Number(amountLei);
      if (!Number.isFinite(amt) || amt <= 0) return ack?.({ error: 'Invalid amount' });
    }
    try {
      const tbl   = currentTable;
      const order = await getOpenOrder(tbl, currentRestaurantId);
      if (!order.id) return ack?.({ error: 'Nicio comandă deschisă' });

      const remaining = order.items
        .filter(it => it.status !== 'paid')
        .reduce((s, it) => s + Number(it.price), 0);

      // Server is authoritative: 'rest' uses full remaining; 'equal' caps at remaining
      let chargeAmount;
      if (mode === 'rest') {
        chargeAmount = remaining;
      } else {
        chargeAmount = Math.min(Number(amountLei), remaining);
      }
      if (chargeAmount <= 0) return ack?.({ error: 'Nimic de plătit' });

      const dbPmtId = await createPendingPayment({ orderId: order.id, amountLei: chargeAmount, tipLei: tip, socketId: socket.id, mode: 'flat' });

      let payment;
      try {
        payment = await requestPayment({ amountLei: chargeAmount, tipLei: tip, orderId: order.id, tableNumber: tbl });
      } catch (err) {
        await pool.query(`UPDATE payments SET status='failed' WHERE id=$1`, [dbPmtId]);
        return ack?.({ error: 'Plata nu a putut fi inițiată' });
      }

      await pool.query(`UPDATE payments SET mia_payment_id=$1 WHERE id=$2`, [payment.paymentId, dbPmtId]);

      const meta = { dbPaymentId: dbPmtId, socketId: socket.id, tableNumber: tbl, restaurantId: currentRestaurantId, orderId: order.id, amountLei: chargeAmount, tipLei: tip, mode: 'flat' };
      paymentMeta.set(payment.paymentId, meta);
      socketInflight.set(socket.id, payment.paymentId);

      ack?.({ success: true, chargeAmount, ...payment });

      if (payment._mock) {
        const timer = setTimeout(() => {
          payment._shouldFail
            ? releasePayment(payment.paymentId, 'Plata a fost refuzată')
            : settlePayment(payment.paymentId);
        }, 2000);
        meta.timer = timer;
      }
    } catch (err) {
      console.error('[pay-flat]', err);
      ack?.({ error: 'Eroare internă' });
    }
  });

  socket.on('disconnect', async () => {
    socketThrottle.delete(socket.id);
    try {
      // If a payment is in-flight, keep items claimed — settlement/timeout handles them
      if (socketInflight.has(socket.id)) {
        console.log(`[disconnect] socket ${socket.id} has in-flight payment — keeping items claimed`);
        return;
      }
      const { rows: released } = await pool.query(`
        UPDATE order_items SET status = 'available', claimed_by = NULL
        WHERE claimed_by = $1 AND status = 'claimed'
        RETURNING id
      `, [socket.id]);
      if (currentTable && released.length > 0) {
        io.to(`table-${currentRestaurantId}-${currentTable}`).emit('items-patch',
          released.map(r => ({ id: r.id, status: 'available', claimed_by: null }))
        );
      }
    } catch (err) {
      console.error('[disconnect cleanup]', err);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Payment settlement helpers (idempotent — safe to call multiple times)
// ═══════════════════════════════════════════════════════════════════════════════

async function createPendingPayment({ orderId, amountLei, tipLei, socketId, mode }) {
  const { rows: [pmt] } = await pool.query(
    `INSERT INTO payments (order_id, restaurant_id, amount_lei, tip_lei, status, socket_id, mode)
     SELECT $1, o.restaurant_id, $2, $3, 'pending', $4, $5
     FROM orders o WHERE o.id = $1
     RETURNING id`,
    [orderId, amountLei, tipLei, socketId, mode]
  );
  return pmt.id;
}

async function settlePayment(miaPaymentId, confirmedMiaId = null) {
  const meta = paymentMeta.get(miaPaymentId);
  if (!meta) {
    // Server restart: recover from DB
    const { rows: [pmt] } = await pool.query(
      `SELECT p.id, p.socket_id, p.mode, p.amount_lei, p.tip_lei, p.order_id, o.table_number, o.restaurant_id
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.mia_payment_id = $1 AND p.status = 'pending'`,
      [miaPaymentId]
    );
    if (pmt) await settleFromDB(pmt, confirmedMiaId);
    return;
  }

  const { dbPaymentId, socketId, tableNumber, restaurantId, orderId, amountLei, tipLei, mode, itemIds, timer } = meta;
  if (timer) clearTimeout(timer);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotency: lock row and check status
    const { rows: [pmt] } = await client.query(
      'SELECT status FROM payments WHERE id=$1 FOR UPDATE', [dbPaymentId]
    );
    if (!pmt || pmt.status !== 'pending') {
      await client.query('ROLLBACK');
      cleanupMeta(miaPaymentId, socketId);
      return;
    }

    let itemsSettled = 0;
    if (mode === 'claimed') {
      const { rowCount } = await client.query(
        `UPDATE order_items SET status='paid', claimed_by=NULL
         WHERE claimed_by=$1 AND status='claimed'`,
        [socketId]
      );
      itemsSettled = rowCount;
    } else {
      // flat: settle all remaining items
      const { rowCount } = await client.query(
        `UPDATE order_items SET status='paid', claimed_by=NULL
         WHERE order_id=$1 AND status IN ('available','claimed')`,
        [orderId]
      );
      itemsSettled = rowCount;
    }

    if (mode === 'claimed' && itemsSettled === 0) {
      // Items were released + paid by someone else — this is a duplicate charge
      await client.query(
        `UPDATE payments SET status='duplicate', mia_payment_id=$2 WHERE id=$1`,
        [dbPaymentId, confirmedMiaId || miaPaymentId]
      );
      await client.query('COMMIT');
      const s = io.sockets.sockets.get(socketId);
      if (s) s.emit('payment-failed', { reason: 'Preparatele au fost deja achitate de altcineva.' });
      cleanupMeta(miaPaymentId, socketId);
      return;
    }

    await client.query(
      `UPDATE payments SET status='paid', paid_at=NOW(), mia_payment_id=$2 WHERE id=$1`,
      [dbPaymentId, confirmedMiaId || miaPaymentId]
    );
    await client.query('COMMIT');

    // Emit confirmed to the guest's socket
    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit('payment-confirmed', { amountLei, tipLei, total: Number(amountLei) + Number(tipLei), mode, itemIds: itemIds || [] });

    const order = await getOpenOrder(tableNumber, restaurantId);
    io.to(`table-${restaurantId}-${tableNumber}`).emit('order-update', order);
    io.to(`dashboard-${restaurantId}`).emit('payment-made', {
      table_number: tableNumber, amount_lei: amountLei, tip_lei: tipLei,
      paid_at: new Date().toISOString(),
    });

    cleanupMeta(miaPaymentId, socketId);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[settlePayment]', err);
  } finally {
    client.release();
  }
}

async function releasePayment(miaPaymentId, reason = 'Plata a eșuat') {
  const meta = paymentMeta.get(miaPaymentId);
  if (!meta) {
    const { rows: [pmt] } = await pool.query(
      `SELECT p.id, p.socket_id, p.mode, p.order_id, o.table_number, o.restaurant_id
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.mia_payment_id = $1 AND p.status = 'pending'`,
      [miaPaymentId]
    );
    if (pmt) await releaseFromDB(pmt, reason);
    return;
  }

  const { dbPaymentId, socketId, tableNumber, restaurantId, mode, timer } = meta;
  if (timer) clearTimeout(timer);

  const newStatus = reason.toLowerCase().includes('expir') ? 'expired' : 'failed';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [pmt] } = await client.query(
      'SELECT status FROM payments WHERE id=$1 FOR UPDATE', [dbPaymentId]
    );
    if (!pmt || pmt.status !== 'pending') {
      await client.query('ROLLBACK');
      cleanupMeta(miaPaymentId, socketId);
      return;
    }

    await client.query(`UPDATE payments SET status=$2 WHERE id=$1`, [dbPaymentId, newStatus]);

    if (mode === 'claimed') {
      await client.query(
        `UPDATE order_items SET status='available', claimed_by=NULL
         WHERE claimed_by=$1 AND status='claimed'`,
        [socketId]
      );
    }
    // flat mode: no items were claimed, nothing to release

    await client.query('COMMIT');

    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit('payment-failed', { reason });

    const order = await getOpenOrder(tableNumber, restaurantId);
    io.to(`table-${restaurantId}-${tableNumber}`).emit('order-update', order);

    cleanupMeta(miaPaymentId, socketId);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[releasePayment]', err);
  } finally {
    client.release();
  }
}

// DB-only settlement/release for payments where in-memory meta is gone (server restart)
async function settleFromDB(pmt, confirmedMiaId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      'SELECT status FROM payments WHERE id=$1 FOR UPDATE', [pmt.id]
    );
    if (!row || row.status !== 'pending') { await client.query('ROLLBACK'); return; }

    let itemsSettled = 0;
    if (pmt.mode === 'claimed') {
      const { rowCount } = await client.query(
        `UPDATE order_items SET status='paid', claimed_by=NULL WHERE claimed_by=$1 AND status='claimed'`,
        [pmt.socket_id]
      );
      itemsSettled = rowCount;
    } else {
      const { rowCount } = await client.query(
        `UPDATE order_items SET status='paid', claimed_by=NULL WHERE order_id=$1 AND status IN ('available','claimed')`,
        [pmt.order_id]
      );
      itemsSettled = rowCount;
    }

    if (pmt.mode === 'claimed' && itemsSettled === 0) {
      await client.query(`UPDATE payments SET status='duplicate' WHERE id=$1`, [pmt.id]);
      await client.query('COMMIT');
      return;
    }

    await client.query(
      `UPDATE payments SET status='paid', paid_at=NOW(), mia_payment_id=COALESCE($2, mia_payment_id) WHERE id=$1`,
      [pmt.id, confirmedMiaId]
    );
    await client.query('COMMIT');

    const order = await getOpenOrder(pmt.table_number, pmt.restaurant_id);
    io.to(`table-${pmt.restaurant_id}-${pmt.table_number}`).emit('order-update', order);
    io.to(`dashboard-${pmt.restaurant_id}`).emit('payment-made', {
      table_number: pmt.table_number, amount_lei: pmt.amount_lei, tip_lei: pmt.tip_lei,
      paid_at: new Date().toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[settleFromDB]', err);
  } finally {
    client.release();
  }
}

async function releaseFromDB(pmt, reason = '') {
  const newStatus = reason.toLowerCase().includes('expir') ? 'expired' : 'failed';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE payments SET status=$2 WHERE id=$1 AND status='pending'`,
      [pmt.id, newStatus]
    );
    if (rowCount === 0) { await client.query('ROLLBACK'); return; }

    if (pmt.mode === 'claimed') {
      await client.query(
        `UPDATE order_items SET status='available', claimed_by=NULL WHERE claimed_by=$1 AND status='claimed'`,
        [pmt.socket_id]
      );
    }
    await client.query('COMMIT');

    const order = await getOpenOrder(pmt.table_number, pmt.restaurant_id);
    io.to(`table-${pmt.restaurant_id}-${pmt.table_number}`).emit('order-update', order);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[releaseFromDB]', err);
  } finally {
    client.release();
  }
}

function cleanupMeta(miaPaymentId, socketId) {
  paymentMeta.delete(miaPaymentId);
  if (socketId) socketInflight.delete(socketId);
}

// ─── Reconciliation — runs every 30 s ────────────────────────────────────────
// Catches: dropped webhooks, server restarts with pending payments, MIA timeouts.

async function reconcilePendingPayments() {
  try {
    const { rows: pending } = await pool.query(`
      SELECT p.id, p.mia_payment_id, p.socket_id, p.mode, p.amount_lei, p.tip_lei, p.order_id,
             o.table_number, o.restaurant_id, p.created_at
      FROM payments p
      JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'pending'
    `);

    const now = Date.now();
    for (const pmt of pending) {
      const ageMs = now - new Date(pmt.created_at).getTime();
      const miaId = pmt.mia_payment_id;

      if (ageMs > 3 * 60 * 1000) {
        // Expired — release regardless
        if (miaId && paymentMeta.has(miaId)) {
          await releasePayment(miaId, 'Plata a expirat (timeout)');
        } else {
          await releaseFromDB(pmt, 'expired');
        }
        continue;
      }

      // 30s–3min and live MIA → poll for status
      if (ageMs > 30_000 && miaId && process.env.MIA_MERCHANT_ID) {
        try {
          const { status } = await getPaymentStatus(miaId);
          if (status === 'PAID') {
            if (paymentMeta.has(miaId)) await settlePayment(miaId, miaId);
            else await settleFromDB(pmt, miaId);
          } else if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(status)) {
            if (paymentMeta.has(miaId)) await releasePayment(miaId, `Plata ${status}`);
            else await releaseFromDB(pmt, status.toLowerCase());
          }
        } catch (err) {
          console.error('[reconcile poll]', err.message);
        }
      }
    }
  } catch (err) {
    console.error('[reconcile]', err);
  }
}

setInterval(reconcilePendingPayments, 30_000);

// ─── global error handler ─────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err.status) {
    return res.status(err.status).json({ error: err.message || 'Request error' });
  }
  console.error('[express error]', err);
  res.status(500).json({ error: 'Eroare internă' });
});

process.on('uncaughtException',  err  => console.error('[uncaughtException]',  err));
process.on('unhandledRejection', err  => console.error('[unhandledRejection]', err));

// ─── start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, async () => {
  console.log(`\n🍽  nota. server running on port ${PORT}`);
  console.log(`   App URL:  ${APP_URL}`);
  console.log(`   iiko:     ${IIKO_LIVE ? '✅ LIVE' : '⚠️  mock'}`);
  console.log(`   MIA:      ${MIA_LIVE  ? '✅ LIVE' : '⚠️  mock'}`);
  console.log(`   DB:       ${process.env.DATABASE_URL ? '✅ connected' : '❌ DATABASE_URL missing'}`);

  // Release any items that were left claimed by a socket from the previous process
  try {
    await reconcilePendingPayments();
    const { rows: stuck } = await pool.query(
      `SELECT DISTINCT claimed_by, order_id FROM order_items WHERE status='claimed' AND claimed_by IS NOT NULL`
    );
    if (stuck.length) console.log(`   [startup] ${stuck.length} socket(s) have claimed items — reconciliation will resolve pending payments`);
  } catch {}

  try {
    const { rows: [t1] } = await pool.query(
      "SELECT token FROM tables WHERE number = 1 ORDER BY restaurant_id LIMIT 1"
    );
    const guestUrl = t1?.token ? `${APP_URL}/?t=${t1.token}` : `${APP_URL}/?t=<run-setup-db>`;
    console.log(`\n   Guest:     ${guestUrl}`);
  } catch {
    console.log(`\n   Guest:     ${APP_URL}/?t=<token>`);
  }
  console.log(`   Dashboard: ${APP_URL}/dashboard`);
  console.log(`   QR codes:  ${APP_URL}/qrcodes\n`);
});
