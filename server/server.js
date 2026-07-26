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
 *   MAIB_MIA_ENV (sandbox|production) + MAIB_CLIENT_ID / MAIB_CLIENT_SECRET / MAIB_SIGNATURE_KEY
 *                         → enables real MIA payments (see server/mia.js). Omit to stay in mock mode.
 */

import 'dotenv/config';
import crypto            from 'crypto';
import { readFileSync }  from 'fs';
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
import { requestPayment, getPaymentStatus, parseCallbackFields, verifyAndParseCallback, cancelPayment,
         refundPayment, simulatePayment, setMockFailNext, MIA_DEFAULT_MODE } from './mia.js';
import { register, login, me, requireAuth, verifyJWT } from './auth.js';
import { memberRegister, memberLogin, memberMe, memberReferral, memberStats, getActiveMemberBonus,
         requireMemberAuth, verifyMemberJWT } from './members.js';
import { encryptSecret, decryptSecret } from './secrets.js';
import multer from 'multer';
import { processAndStore } from './storage.js';

// Per-restaurant maib credentials, decrypted — or null to force mock (see mia.js doc comment).
// A restaurant is only ever taken out of demo mode by its own maib_status='active' + stored
// credentials; there is no server-wide fallback that could put a restaurant live by accident.
async function getRestaurantMiaCreds(restaurantId) {
  if (!restaurantId) return null;
  const { rows: [rest] } = await pool.query(
    `SELECT maib_status, maib_env, maib_client_id, maib_client_secret_enc, maib_signature_key_enc
     FROM restaurants WHERE id=$1`,
    [restaurantId]
  );
  if (!rest || rest.maib_status !== 'active' || !rest.maib_client_id || !rest.maib_client_secret_enc) return null;
  return {
    clientId:     rest.maib_client_id,
    clientSecret: decryptSecret(rest.maib_client_secret_enc),
    signatureKey: decryptSecret(rest.maib_signature_key_enc),
    env:          rest.maib_env,
  };
}

async function getRestaurantForQrId(qrId) {
  const { rows: [row] } = await pool.query(`SELECT restaurant_id FROM payments WHERE mia_payment_id=$1`, [qrId]);
  return row?.restaurant_id ?? null;
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;

const __dirname = dirname(fileURLToPath(import.meta.url));
const app       = express();
const httpServer= createServer(app);
const PORT      = process.env.PORT || 3000;
const APP_URL   = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const DEV_API_KEY = process.env.DEV_API_KEY || null;
const IIKO_LIVE   = !!(process.env.IIKO_API_LOGIN && process.env.IIKO_ORG_ID);

// Build fingerprint — makes "is prod running the latest code?" a 5-second /health check instead
// of guesswork. Railway sets RAILWAY_GIT_COMMIT_SHA at build time; anywhere that doesn't (local
// dev, other hosts) falls back to package.json's version + the process start time, so this is
// never blank.
const BUILD = process.env.RAILWAY_GIT_COMMIT_SHA
  ? process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7)
  : (() => {
      try {
        const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
        return `${pkg.version}-${Date.now()}`;
      } catch {
        return `unknown-${Date.now()}`;
      }
    })();

// Serves a static HTML file with a <meta name="build"> tag injected right before </head>, so
// view-source on any of these pages also shows what build is live — not just /health. Read fresh
// per request (these files are small; matches the existing /qrcodes route's pattern of building
// HTML per-request rather than caching) so it always reflects the file actually on disk.
function sendHtmlWithBuild(res, filePath) {
  try {
    const html = readFileSync(filePath, 'utf8');
    const injected = html.includes('</head>')
      ? html.replace('</head>', `  <meta name="build" content="${BUILD}">\n</head>`)
      : html;
    res.type('html').send(injected);
  } catch (err) {
    console.error('[sendHtmlWithBuild]', err.message);
    res.sendFile(filePath); // fail safe — the page still loads even if injection breaks
  }
}

// Menu photo upload: memory storage (we process with sharp before persisting — no need to touch
// disk), 8MB input cap, image MIME types only. Multer's own errors (too large / wrong type) are
// caught by the wrapper below rather than crashing the request.
const menuImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('invalid-type'));
    cb(null, true);
  },
});
function uploadMenuImage(req, res, next) {
  menuImageUpload.single('photo')(req, res, err => {
    if (!err) return next();
    if (err.message === 'invalid-type') return res.status(400).json({ error: 'Fișierul trebuie să fie o imagine (JPEG, PNG sau WebP).' });
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Imaginea este prea mare (max 8MB).' });
    res.status(400).json({ error: 'Fișier invalid.' });
  });
}

const roundLei = v => Math.round(Number(v) * 100) / 100;

// The dashboard's table grid only ever refreshed on 'payment-made' or 'waiter-called' — both
// only fire on a *settled* payment, so claims, deselects, and in-flight/failed/expired payments
// were invisible until something finally settled. This is the single signal the dashboard grid
// reacts to for everything else; it's cheap (dashboard just re-fetches /api/dashboard/tables).
function notifyDashboardActivity(restaurantId, tableNumber) {
  if (!restaurantId || !tableNumber) return;
  io.to(`dashboard-${restaurantId}`).emit('table-activity', { tableNumber });
}

// /club is public and cross-tenant, so this only ever carries a nudge to refetch the already-
// sanitized /api/public/offers endpoint — never restaurant internals, ids, or tokens.
function notifyOfferChange() {
  io.to('public-offers').emit('offer-change', {});
}

// Real MIA payments (sandbox/production) need the guest to open/scan a maib deep link — the
// guest is already on their own phone, so we render it as an inline QR (no client-side QR lib
// needed) AND as a tap-to-open link. Mock payments never had this (nothing to open), so we only
// build it when there's a real deepLinkUrl to point at.
async function buildMiaQrSvg(payment) {
  if (!payment?.deepLinkUrl || payment._mock) return null;
  try {
    return await QRCode.toString(payment.deepLinkUrl, { type: 'svg', width: 220, margin: 1 });
  } catch (err) {
    console.error('[mia qr svg]', err.message);
    return null;
  }
}

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
    if (req.path === '/health') return next(); // healthcheck must not redirect
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
    useDefaults: false,
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      scriptSrcAttr: ["'none'"],
      styleSrc:      ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc:       ["'self'", "fonts.gstatic.com"],
      connectSrc:    ["'self'", "ws:", "wss:"],
      imgSrc:        ["'self'", "data:"],
      objectSrc:     ["'none'"],
      baseUri:       ["'self'"],
      formAction:    ["'self'"],
    },
  },
}));
app.use('/api/payment/webhook', express.raw({ type: '*/*' }));
app.use('/api/iiko/webhook',    express.raw({ type: '*/*' }));
app.use(express.json({ limit: '100kb' }));

// Resolves a table token to { number, menu_published } | null (bad/missing token) |
// 'error' (DB hiccup — callers fail toward the guest app, never strand a real diner).
// The client-side validation (GET /api/table/by-token/:token) is untouched and still runs
// exactly as before whenever index.html is served — this only decides which shell to send.
async function resolveTableByToken(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{16}$/.test(token)) return null;
  try {
    const { rows: [tbl] } = await pool.query(
      `SELECT t.number, r.menu_published FROM tables t
       JOIN restaurants r ON r.id = t.restaurant_id
       WHERE t.token = $1`,
      [token]
    );
    return tbl || null;
  } catch (err) {
    console.error('[resolveTableByToken] lookup failed — defaulting to guest app', err.message);
    return 'error';
  }
}

// Bare-domain root: valid token + published menu → one-tap choice screen; valid token, no menu
// → guest bill exactly as before (zero regression); no/invalid token → company landing page
// instead of the guest app's own dead-end "Masă invalidă" screen.
app.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache'); // same as static HTML — deploys go live immediately
  const tbl = await resolveTableByToken(req.query.t);
  if (tbl === 'error') return sendHtmlWithBuild(res, join(__dirname, '../public/index.html'));
  if (tbl) {
    if (tbl.menu_published) return res.sendFile(join(__dirname, '../public/choice.html'));
    return sendHtmlWithBuild(res, join(__dirname, '../public/index.html'));
  }
  sendHtmlWithBuild(res, join(__dirname, '../public/home.html'));
});

// Always the bill, regardless of menu — reached from the choice screen's pay button and from
// the menu page's persistent pay bar. Same token, same guest app, same everything.
app.get('/bill', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  const tbl = await resolveTableByToken(req.query.t);
  if (tbl === 'error' || tbl) return sendHtmlWithBuild(res, join(__dirname, '../public/index.html'));
  sendHtmlWithBuild(res, join(__dirname, '../public/home.html'));
});

// The menu — only reachable when a menu is actually published; falls back to the bill if a
// stale /menu link is visited right after the restaurant unpublishes.
app.get('/menu', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  // Dashboard editor's live phone preview — no table token involved at all, menu.html itself
  // authenticates the actual data request with the owner's own JWT (see /api/dashboard/menu/preview).
  // Bypassing the token/published check here is safe because it grants nothing by itself — it
  // only serves the same static shell every guest menu page already is.
  if (req.query.preview === '1') return res.sendFile(join(__dirname, '../public/menu.html'));
  const tbl = await resolveTableByToken(req.query.t);
  if (tbl === 'error') return sendHtmlWithBuild(res, join(__dirname, '../public/index.html'));
  if (tbl) {
    if (tbl.menu_published) return res.sendFile(join(__dirname, '../public/menu.html'));
    return sendHtmlWithBuild(res, join(__dirname, '../public/index.html'));
  }
  sendHtmlWithBuild(res, join(__dirname, '../public/home.html'));
});

// /dashboard has no client-side token/auth logic to resolve server-side — it's always the same
// file, gated by the JWT the page itself asks for after load. Registered before express.static
// so the build meta gets injected; previously this path only worked via static's extensions
// fallback (dashboard → dashboard.html), which is preserved as a side effect of matching here.
app.get(['/dashboard', '/dashboard.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  sendHtmlWithBuild(res, join(__dirname, '../public/dashboard.html'));
});

app.use(express.static(join(__dirname, '../public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      // Revalidate HTML on every request so deploys go live immediately
      res.setHeader('Cache-Control', 'no-cache');
    }
    // sw.js and the manifest gate the PWA's own update cycle — browsers already refuse to
    // cache sw.js past 24h, but no-cache makes a fresh deploy visible on the very next visit
    // instead of waiting out that window, so "stale shell forever" can't happen.
    if (filePath.endsWith('/sw.js') || filePath.endsWith('manifest.webmanifest')) {
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

// ─── Club Eats member routes ──────────────────────────────────────────────────

app.post('/api/members/register',  limiterAuth,       memberRegister);
app.post('/api/members/login',     limiterAuth,       memberLogin);
app.get( '/api/members/me',        requireMemberAuth, memberMe);
app.get( '/api/members/referral',  requireMemberAuth, memberReferral);
app.get( '/api/members/stats',     requireMemberAuth, memberStats);

// ─── /club — Club Eats member web app ────────────────────────────────────────

app.get('/club', (_req, res) => res.sendFile(join(__dirname, '../public/club.html')));
// Legacy /oferte → /club
app.get('/oferte', (_req, res) => res.redirect(301, '/club'));

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

// Read-only, side-effect-free lookup used by the Club Eats in-app scanner to confirm which
// restaurant a scanned table token belongs to before routing the guest into the payment flow.
// Reveals nothing beyond what /?t=TOKEN already would once opened.
app.get('/api/table/restaurant-by-token/:token', async (req, res) => {
  try {
    const { rows: [tbl] } = await pool.query(
      'SELECT restaurant_id FROM tables WHERE token = $1',
      [req.params.token]
    );
    if (!tbl) return res.status(404).json({ error: 'Cod invalid' });
    const { rows: [r] } = await pool.query('SELECT name FROM restaurants WHERE id=$1', [tbl.restaurant_id]);
    res.json({ restaurant_id: tbl.restaurant_id, restaurant_name: r?.name || null });
  } catch (err) {
    console.error('[GET /api/table/restaurant-by-token]', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
});

// ─── payment webhook ──────────────────────────────────────────────────────────

app.post('/api/payment/webhook', limiterPaymentHttp, async (req, res) => {
  try {
    // maib embeds the signature inside the JSON body itself (result + signature), not a header.
    // Credentials are per-restaurant now, so we must find which restaurant this qrId belongs to
    // BEFORE we know which signature key to verify with — that's a metadata lookup, not a trust
    // decision; the actual trust decision is still the signature check below. A restaurant that
    // isn't maib_status='active' has no signature key to resolve, so this fails closed for it
    // exactly like it did for the whole server before credentials were per-restaurant.
    const parsed = parseCallbackFields(req.body);
    if (!parsed) return res.status(401).send('Bad payload');

    const restaurantId = parsed.result?.qrId ? await getRestaurantForQrId(parsed.result.qrId) : null;
    const creds = restaurantId ? await getRestaurantMiaCreds(restaurantId) : null;
    if (!creds) return res.status(401).send('Bad signature');

    const payload = verifyAndParseCallback(parsed, creds.signatureKey);
    if (!payload) return res.status(401).send('Bad signature');

    // We only ever act on an explicit "paid" signal. Any other terminal state (expired/cancelled)
    // is resolved by the reconciliation poll — the docs don't specify a callback shape for those,
    // so treating anything ambiguous as a no-op (rather than guessing) keeps this fail-closed.
    if (payload.status === 'PAID') {
      await settlePayment(payload.qrId, payload.qrId, payload.payId);
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
      SELECT p.id, o.table_number, p.amount_lei, p.tip_lei, p.paid_at,
             (p.mia_pay_id IS NOT NULL) AS refundable
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

// Refund a settled payment — authenticated, tenant-scoped, idempotent.
app.post('/api/dashboard/payments/:id/refund', requireAuth, async (req, res) => {
  const rId = req.restaurant.restaurantId;
  const paymentId = Number(req.params.id);
  if (!Number.isInteger(paymentId)) return res.status(400).json({ error: 'Invalid payment id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [pmt] } = await client.query(
      `SELECT id, status, mia_pay_id, amount_lei, tip_lei
       FROM payments WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
      [paymentId, rId]
    );
    if (!pmt) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Payment not found' }); }

    // Idempotent: already refunded → report success without calling maib again.
    if (pmt.status === 'refunded') {
      await client.query('ROLLBACK');
      return res.json({ ok: true, alreadyRefunded: true });
    }
    if (pmt.status !== 'paid') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot refund a payment with status '${pmt.status}'` });
    }
    if (!pmt.mia_pay_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Rambursarea nu e disponibilă pentru plăți demo (mock)' });
    }

    let refund;
    try {
      const miaCreds = await getRestaurantMiaCreds(rId);
      refund = await refundPayment({
        payId:  pmt.mia_pay_id,
        reason: (req.body && req.body.reason) || 'Refund solicitat de restaurant',
      }, miaCreds);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[refund]', err.message);
      return res.status(502).json({ error: 'Rambursarea a eșuat la maib', detail: err.message });
    }

    await client.query(`UPDATE payments SET status='refunded' WHERE id=$1`, [paymentId]);
    await client.query('COMMIT');

    io.to(`dashboard-${rId}`).emit('payment-refunded', { id: paymentId });
    res.json({ ok: true, refundId: refund.refundId, status: refund.status });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[refund]', err);
    res.status(500).json({ error: 'Eroare internă' });
  } finally {
    client.release();
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
             COALESCE(SUM(oi.price) FILTER (WHERE oi.status IN ('available','claimed')), 0) AS unpaid_lei,
             EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'pending') AS payment_pending
      FROM tables t
      LEFT JOIN orders o  ON o.table_id = t.id AND o.status = 'open'
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE t.restaurant_id = $1
      GROUP BY t.number, o.id ORDER BY t.number
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
      SELECT p.paid_at, o.table_number, p.gross_lei, p.discount_lei, p.amount_lei, p.tip_lei,
             (p.amount_lei + p.tip_lei) AS total_lei, p.mia_payment_id, of.name AS offer_name,
             p.member_id, fb.rating
      FROM payments p
      JOIN orders o ON o.id = p.order_id
      LEFT JOIN offers of ON of.id = p.offer_id
      LEFT JOIN LATERAL (
        SELECT rating FROM feedback WHERE payment_id = p.id ORDER BY created_at LIMIT 1
      ) fb ON true
      WHERE p.restaurant_id = $1 AND p.status = 'paid'
        ${validDate ? 'AND p.paid_at::date = $2::date' : 'AND p.paid_at >= CURRENT_DATE'}
      ORDER BY p.paid_at
    `, validDate ? [rId, validDate] : [rId]);

    const csvDate = validDate || new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nota-${csvDate}.csv"`);

    const lines = [
      'Ora,Masa,Brut (lei),Reducere (lei),Net (lei),Bacsis (lei),Total (lei),Oferta,Membru Club,Rating,MIA ID',
      ...rows.map(r => {
        const time = new Date(r.paid_at).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
        const gross = r.gross_lei ?? r.amount_lei;
        return [time, r.table_number, gross, r.discount_lei || 0, r.amount_lei, r.tip_lei,
                r.total_lei, r.offer_name || '', r.member_id ? 'da' : 'nu',
                r.rating || '', r.mia_payment_id || ''].join(',');
      }),
    ];
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('[export]', err);
    res.status(500).json({ error: 'Eroare la export' });
  }
});

// ─── Club Eats: offer CRUD (authenticated, tenant-scoped) ────────────────────

app.get('/api/dashboard/offers', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM offers WHERE restaurant_id=$1 ORDER BY created_at DESC`,
      [req.restaurant.restaurantId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dashboard/offers', requireAuth, async (req, res) => {
  const { name, discount_pct, days_of_week, start_time, end_time, active = true,
          public_visible = true, member_only = true } = req.body;
  if (!name || typeof name !== 'string' || name.length > 120) return res.status(400).json({ error: 'Invalid name' });
  const pct = Number(discount_pct);
  if (!Number.isInteger(pct) || pct < 1 || pct > 50) return res.status(400).json({ error: 'discount_pct must be 1–50' });
  const days = Array.isArray(days_of_week) ? days_of_week : [0,1,2,3,4,5,6];
  if (!days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) return res.status(400).json({ error: 'Invalid days_of_week' });
  if (!start_time || !end_time) return res.status(400).json({ error: 'start_time and end_time required' });
  try {
    const { rows: [row] } = await pool.query(
      `INSERT INTO offers (restaurant_id, name, discount_pct, days_of_week, start_time, end_time, active, public_visible, member_only)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.restaurant.restaurantId, name.trim(), pct, days, start_time, end_time, !!active, !!public_visible, !!member_only]
    );
    notifyOfferChange();
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/dashboard/offers/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const { name, discount_pct, days_of_week, start_time, end_time, active, public_visible, member_only = true } = req.body;
  if (!name || typeof name !== 'string' || name.length > 120) return res.status(400).json({ error: 'Invalid name' });
  const pct = Number(discount_pct);
  if (!Number.isInteger(pct) || pct < 1 || pct > 50) return res.status(400).json({ error: 'discount_pct must be 1–50' });
  const days = Array.isArray(days_of_week) ? days_of_week : [0,1,2,3,4,5,6];
  try {
    const { rows: [row] } = await pool.query(
      `UPDATE offers SET name=$1,discount_pct=$2,days_of_week=$3,start_time=$4,end_time=$5,active=$6,public_visible=$7,member_only=$8
       WHERE id=$9 AND restaurant_id=$10 RETURNING *`,
      [name.trim(), pct, days, start_time, end_time, !!active, !!public_visible, !!member_only, id, req.restaurant.restaurantId]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    notifyOfferChange();
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/dashboard/offers/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    await pool.query(`DELETE FROM offers WHERE id=$1 AND restaurant_id=$2`, [id, req.restaurant.restaurantId]);
    notifyOfferChange();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Menu images (upload tenant-scoped; serving is public — guests need to see them) ──────────

app.post('/api/dashboard/menu/images', requireAuth, uploadMenuImage, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nicio imagine primită.' });
  try {
    const rId = req.restaurant.restaurantId;
    const processed = await processAndStore({ buffer: req.file.buffer, restaurantId: rId });
    const { rows: [row] } = await pool.query(
      `INSERT INTO menu_images (restaurant_id, mime_type, full_data, thumb_data, full_url, thumb_url, width, height)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [rId, processed.mime_type, processed.full_data, processed.thumb_data, processed.full_url, processed.thumb_url, processed.width, processed.height]
    );
    res.json({ id: row.id, url: `/api/images/${row.id}`, thumbUrl: `/api/images/${row.id}/thumb` });
  } catch (err) {
    console.error('[menu image upload]', err.message);
    res.status(400).json({ error: 'Imaginea nu a putut fi procesată. Încearcă alt fișier.' });
  }
});

async function serveMenuImage(req, res, variant) {
  const id = parseInt(req.params.id);
  if (!id) return res.status(404).end();
  try {
    const column = variant === 'thumb' ? 'thumb' : 'full'; // fixed internal values only, never user input
    const { rows: [row] } = await pool.query(
      `SELECT mime_type, ${column}_data AS data, ${column}_url AS url FROM menu_images WHERE id=$1`, [id]
    );
    if (!row) return res.status(404).end();
    if (row.url) return res.redirect(302, row.url);
    if (!row.data) return res.status(404).end();
    res.set('Content-Type', row.mime_type);
    res.set('Cache-Control', 'public, max-age=31536000, immutable'); // uploads are never mutated in place
    res.send(row.data);
  } catch (err) {
    console.error('[serveMenuImage]', err.message);
    res.status(500).end();
  }
}
app.get('/api/images/:id', (req, res) => serveMenuImage(req, res, 'full'));
app.get('/api/images/:id/thumb', (req, res) => serveMenuImage(req, res, 'thumb'));

// ─── Club Eats cover photo (restaurant profile photo for the partner feed) ─────────────────────

app.post('/api/dashboard/profile/cover-image', requireAuth, uploadMenuImage, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nicio imagine primită.' });
  try {
    const rId = req.restaurant.restaurantId;
    const processed = await processAndStore({ buffer: req.file.buffer, restaurantId: rId });
    const { rows: [row] } = await pool.query(
      `INSERT INTO menu_images (restaurant_id, mime_type, full_data, thumb_data, full_url, thumb_url, width, height)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [rId, processed.mime_type, processed.full_data, processed.thumb_data, processed.full_url, processed.thumb_url, processed.width, processed.height]
    );
    await pool.query('UPDATE restaurants SET cover_image_id=$1 WHERE id=$2', [row.id, rId]);
    res.json({ id: row.id, url: `/api/images/${row.id}`, thumbUrl: `/api/images/${row.id}/thumb` });
  } catch (err) {
    console.error('[cover image upload]', err.message);
    res.status(400).json({ error: 'Imaginea nu a putut fi procesată. Încearcă alt fișier.' });
  }
});

app.get('/api/dashboard/profile/cover-image', requireAuth, async (req, res) => {
  try {
    const { rows: [r] } = await pool.query('SELECT cover_image_id FROM restaurants WHERE id=$1', [req.restaurant.restaurantId]);
    res.json({ photo: imageUrls(r?.cover_image_id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Menu (dashboard CRUD, tenant-scoped) ──────────────────────────────────────

const DIETARY_TAGS = ['vegetarian', 'vegan', 'gluten_free', 'spicy'];
const MENU_STYLES = ['elegant', 'vizual'];

function imageUrls(imageId) {
  return imageId ? { imageId, url: `/api/images/${imageId}`, thumbUrl: `/api/images/${imageId}/thumb` } : null;
}

function cleanDietaryTags(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter(t => DIETARY_TAGS.includes(t)))];
}

app.get('/api/dashboard/menu', requireAuth, async (req, res) => {
  try {
    const rId = req.restaurant.restaurantId;
    const [{ rows: rest }, { rows: categories }, { rows: items }] = await Promise.all([
      pool.query(`SELECT menu_published, menu_style FROM restaurants WHERE id=$1`, [rId]),
      pool.query(`SELECT * FROM menu_categories WHERE restaurant_id=$1 ORDER BY sort_order, id`, [rId]),
      pool.query(`SELECT * FROM menu_items WHERE restaurant_id=$1 ORDER BY sort_order, id`, [rId]),
    ]);
    const byCategory = new Map(categories.map(c => [c.id, {
      ...c, heroImage: imageUrls(c.hero_image_id), items: [],
    }]));
    for (const it of items) {
      byCategory.get(it.category_id)?.items.push({ ...it, photo: imageUrls(it.photo_id) });
    }
    res.json({
      published: !!rest[0]?.menu_published,
      style: rest[0]?.menu_style || 'elegant',
      categories: [...byCategory.values()],
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dashboard/menu/publish', requireAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE restaurants SET menu_published=$1 WHERE id=$2`,
      [!!req.body.published, req.restaurant.restaurantId]);
    res.json({ ok: true, published: !!req.body.published });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dashboard/menu/style', requireAuth, async (req, res) => {
  const { style } = req.body || {};
  if (!MENU_STYLES.includes(style)) return res.status(400).json({ error: 'Invalid style' });
  try {
    await pool.query(`UPDATE restaurants SET menu_style=$1 WHERE id=$2`, [style, req.restaurant.restaurantId]);
    res.json({ ok: true, style });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tenant check reused by category/item saves: an image can only be attached if it was uploaded
// by this same restaurant — prevents referencing another tenant's already-uploaded photo id.
async function ownsImage(restaurantId, imageId) {
  if (!imageId) return true;
  const { rows } = await pool.query(`SELECT 1 FROM menu_images WHERE id=$1 AND restaurant_id=$2`, [imageId, restaurantId]);
  return rows.length > 0;
}

app.post('/api/dashboard/menu/categories', requireAuth, async (req, res) => {
  const { name_ro, name_ru, hero_image_id } = req.body;
  if (!name_ro || typeof name_ro !== 'string' || name_ro.length > 120) return res.status(400).json({ error: 'Invalid name_ro' });
  try {
    const rId = req.restaurant.restaurantId;
    if (!(await ownsImage(rId, hero_image_id))) return res.status(404).json({ error: 'Image not found' });
    const { rows: [row] } = await pool.query(
      `INSERT INTO menu_categories (restaurant_id, name_ro, name_ru, hero_image_id, sort_order)
       SELECT $1, $2, $3, $4, COALESCE(MAX(sort_order), 0) + 1 FROM menu_categories WHERE restaurant_id=$1
       RETURNING *`,
      [rId, name_ro.trim(), (name_ru || '').trim() || null, hero_image_id || null]
    );
    res.json({ ...row, heroImage: imageUrls(row.hero_image_id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/dashboard/menu/categories/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const { name_ro, name_ru, sort_order, hero_image_id } = req.body;
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  if (!name_ro || typeof name_ro !== 'string' || name_ro.length > 120) return res.status(400).json({ error: 'Invalid name_ro' });
  try {
    const rId = req.restaurant.restaurantId;
    if (hero_image_id !== undefined && !(await ownsImage(rId, hero_image_id))) return res.status(404).json({ error: 'Image not found' });
    const { rows: [row] } = await pool.query(
      `UPDATE menu_categories SET name_ro=$1, name_ru=$2, sort_order=COALESCE($3, sort_order),
              hero_image_id=$4
       WHERE id=$5 AND restaurant_id=$6 RETURNING *`,
      [name_ro.trim(), (name_ru || '').trim() || null, Number.isInteger(sort_order) ? sort_order : null,
       hero_image_id !== undefined ? (hero_image_id || null) : null, id, rId]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ...row, heroImage: imageUrls(row.hero_image_id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/dashboard/menu/categories/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    await pool.query(`DELETE FROM menu_categories WHERE id=$1 AND restaurant_id=$2`, [id, req.restaurant.restaurantId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function validateItemBody(body) {
  const { category_id, name_ro, price, photo_url } = body;
  if (!parseInt(category_id)) return 'Invalid category_id';
  if (!name_ro || typeof name_ro !== 'string' || name_ro.length > 160) return 'Invalid name_ro';
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum <= 0 || priceNum > 100000) return 'Invalid price';
  if (photo_url && (typeof photo_url !== 'string' || photo_url.length > 1000)) return 'Invalid photo_url';
  return null;
}

app.post('/api/dashboard/menu/items', requireAuth, async (req, res) => {
  const err0 = validateItemBody(req.body);
  if (err0) return res.status(400).json({ error: err0 });
  const { category_id, name_ro, name_ru, description_ro, description_ru, price, available = true,
          photo_url, photo_id, dietary_tags, is_featured = false } = req.body;
  const catId = parseInt(category_id);
  try {
    const rId = req.restaurant.restaurantId;
    // Tenant check: the category must belong to this restaurant before we attach an item to it.
    const { rows: [cat] } = await pool.query(`SELECT id FROM menu_categories WHERE id=$1 AND restaurant_id=$2`, [catId, rId]);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    if (!(await ownsImage(rId, photo_id))) return res.status(404).json({ error: 'Image not found' });
    const { rows: [row] } = await pool.query(
      `INSERT INTO menu_items (category_id, restaurant_id, name_ro, name_ru, description_ro, description_ru,
                                price, available, photo_url, photo_id, dietary_tags, is_featured, sort_order)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE(MAX(sort_order), 0) + 1
       FROM menu_items WHERE category_id=$1
       RETURNING *`,
      [catId, rId, name_ro.trim(), (name_ru || '').trim() || null,
       (description_ro || '').trim() || null, (description_ru || '').trim() || null,
       Number(price), !!available, (photo_url || '').trim() || null, photo_id || null,
       cleanDietaryTags(dietary_tags), !!is_featured]
    );
    res.json({ ...row, photo: imageUrls(row.photo_id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/dashboard/menu/items/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const err0 = validateItemBody(req.body);
  if (err0) return res.status(400).json({ error: err0 });
  const { name_ro, name_ru, description_ro, description_ru, price, available, photo_url, photo_id,
          dietary_tags, is_featured, sort_order } = req.body;
  try {
    const rId = req.restaurant.restaurantId;
    if (!(await ownsImage(rId, photo_id))) return res.status(404).json({ error: 'Image not found' });
    const { rows: [row] } = await pool.query(
      `UPDATE menu_items SET name_ro=$1, name_ru=$2, description_ro=$3, description_ru=$4,
              price=$5, available=$6, photo_url=$7, photo_id=$8, dietary_tags=$9, is_featured=$10,
              sort_order=COALESCE($11, sort_order)
       WHERE id=$12 AND restaurant_id=$13 RETURNING *`,
      [name_ro.trim(), (name_ru || '').trim() || null,
       (description_ro || '').trim() || null, (description_ru || '').trim() || null,
       Number(price), !!available, (photo_url || '').trim() || null, photo_id || null,
       cleanDietaryTags(dietary_tags), !!is_featured,
       Number.isInteger(sort_order) ? sort_order : null, id, rId]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ...row, photo: imageUrls(row.photo_id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dashboard/menu/items/:id/duplicate', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const rId = req.restaurant.restaurantId;
    const { rows: [row] } = await pool.query(
      `INSERT INTO menu_items (category_id, restaurant_id, name_ro, name_ru, description_ro, description_ru,
                                price, available, photo_url, photo_id, dietary_tags, is_featured, sort_order)
       SELECT category_id, restaurant_id, name_ro || ' (copie)', name_ru, description_ro, description_ru,
              price, available, photo_url, photo_id, dietary_tags, is_featured,
              (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM menu_items WHERE category_id = src.category_id)
       FROM menu_items src WHERE id=$1 AND restaurant_id=$2
       RETURNING *`,
      [id, rId]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ...row, photo: imageUrls(row.photo_id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/dashboard/menu/items/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    await pool.query(`DELETE FROM menu_items WHERE id=$1 AND restaurant_id=$2`, [id, req.restaurant.restaurantId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Menu (public, guest-facing, scoped by table token) ────────────────────────
// No auth — but the only thing a token unlocks is that one table's own restaurant's published
// menu, exactly like /api/table/by-token/:token already does for the bill. No restaurant_id is
// ever accepted directly from the client, only resolved from the token server-side.
// Returns ALL items including unavailable ones (sold-out is shown, not hidden, per the guest UI).

async function buildGuestMenuPayload(restaurantId) {
  const { rows: [rest] } = await pool.query(`SELECT name, menu_style FROM restaurants WHERE id=$1`, [restaurantId]);
  const [{ rows: categories }, { rows: items }] = await Promise.all([
    pool.query(`SELECT id, name_ro, name_ru, hero_image_id FROM menu_categories WHERE restaurant_id=$1 ORDER BY sort_order, id`, [restaurantId]),
    pool.query(
      `SELECT category_id, name_ro, name_ru, description_ro, description_ru, price, photo_url, photo_id,
              dietary_tags, is_featured, available
       FROM menu_items WHERE restaurant_id=$1 ORDER BY sort_order, id`,
      [restaurantId]
    ),
  ]);
  const byCategory = new Map(categories.map(c => [c.id, {
    name_ro: c.name_ro, name_ru: c.name_ru, heroImage: imageUrls(c.hero_image_id), items: [],
  }]));
  for (const it of items) {
    byCategory.get(it.category_id)?.items.push({
      name_ro: it.name_ro, name_ru: it.name_ru,
      description_ro: it.description_ro, description_ru: it.description_ru,
      price: it.price, photo_url: it.photo_url, photo: imageUrls(it.photo_id),
      dietary_tags: it.dietary_tags || [], is_featured: it.is_featured, available: it.available,
    });
  }
  const nonEmptyCategories = [...byCategory.values()].filter(c => c.items.length > 0);
  return { restaurantName: rest?.name || 'nota.', style: rest?.menu_style || 'elegant', categories: nonEmptyCategories };
}

// Owner-only preview: same shape as the public payload, but always current DB state regardless
// of publish status — powers the live phone-frame preview in the dashboard editor.
app.get('/api/dashboard/menu/preview', requireAuth, async (req, res) => {
  try {
    res.json(await buildGuestMenuPayload(req.restaurant.restaurantId));
  } catch (err) {
    console.error('[GET /api/dashboard/menu/preview]', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
});

app.get('/api/menu/by-token/:token', async (req, res) => {
  const token = req.params.token;
  if (typeof token !== 'string' || !/^[0-9a-f]{16}$/.test(token)) return res.status(404).json({ error: 'Masă invalidă' });
  try {
    const { rows: [tbl] } = await pool.query('SELECT restaurant_id FROM tables WHERE token=$1', [token]);
    if (!tbl) return res.status(404).json({ error: 'Masă invalidă' });
    const { rows: [rest] } = await pool.query(`SELECT menu_published FROM restaurants WHERE id=$1`, [tbl.restaurant_id]);
    if (!rest?.menu_published) return res.status(404).json({ error: 'Meniul nu este disponibil' });

    res.json(await buildGuestMenuPayload(tbl.restaurant_id));
  } catch (err) {
    console.error('[GET /api/menu/by-token]', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
});

// ─── AI Promo-Kit Generator ───────────────────────────────────────────────────

function escSVG(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .slice(0, 60);
}

function generatePromoSVG(restaurantName, offer, variant) {
  const isStory = variant === 'story';
  const W = isStory ? 608 : 1080;
  const H = 1080;
  const rName  = escSVG(restaurantName);
  const oName  = escSVG(offer.name);
  const pct    = Number(offer.discount_pct);
  const start  = String(offer.start_time || '').slice(0,5);
  const end    = String(offer.end_time   || '').slice(0,5);
  const timeW  = `${start} – ${end}`;
  const bigY   = isStory ? 430 : 490;
  const subY   = bigY + (isStory ? 110 : 120);
  const nameY  = subY + (isStory ? 80 : 80);
  const timeY  = nameY + (isStory ? 56 : 56);
  const logoY  = H - (isStory ? 90 : 90);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&amp;family=Manrope:wght@400;700&amp;display=swap');
    </style>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#0A0A0F"/>
      <stop offset="100%" stop-color="#141420"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#C9A84C" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#C9A84C" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="clip"><rect width="${W}" height="${H}"/></clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <ellipse cx="${W/2}" cy="${H*0.38}" rx="${W*0.65}" ry="${H*0.28}" fill="url(#glow)"/>

  <!-- Border frame -->
  <rect x="24" y="24" width="${W-48}" height="${H-48}" rx="28" fill="none" stroke="#C9A84C" stroke-width="1.5" stroke-opacity="0.35"/>

  <!-- Club Eats badge -->
  <rect x="${W/2 - 80}" y="68" width="160" height="34" rx="17" fill="#C9A84C" fill-opacity="0.12" stroke="#C9A84C" stroke-width="1" stroke-opacity="0.5"/>
  <text x="${W/2}" y="90" font-family="Manrope,Arial,sans-serif" font-size="13" font-weight="700" fill="#C9A84C" text-anchor="middle" letter-spacing="2">CLUB EATS</text>

  <!-- Big discount -->
  <text x="${W/2}" y="${bigY}" font-family="'Playfair Display',Georgia,serif" font-size="${isStory ? 160 : 200}" font-weight="700" fill="#C9A84C" text-anchor="middle" dominant-baseline="auto">−${pct}%</text>

  <!-- Offer name -->
  <text x="${W/2}" y="${subY}" font-family="Manrope,Arial,sans-serif" font-size="${isStory ? 28 : 32}" font-weight="700" fill="#F0F0F0" text-anchor="middle" opacity="0.9">${oName}</text>

  <!-- Restaurant name -->
  <text x="${W/2}" y="${nameY}" font-family="Manrope,Arial,sans-serif" font-size="${isStory ? 22 : 26}" fill="#B0B0C8" text-anchor="middle" opacity="0.75">${rName}</text>

  <!-- Time window -->
  <text x="${W/2}" y="${timeY}" font-family="Manrope,Arial,sans-serif" font-size="${isStory ? 20 : 22}" fill="#C9A84C" text-anchor="middle" opacity="0.85">${timeW}</text>

  <!-- nota. brand -->
  <text x="${W/2}" y="${logoY}" font-family="'Playfair Display',Georgia,serif" font-size="${isStory ? 30 : 36}" fill="#C9A84C" text-anchor="middle" opacity="0.6">nota.</text>

  <!-- Decorative line -->
  <line x1="${W/2 - 60}" y1="${subY - 36}" x2="${W/2 + 60}" y2="${subY - 36}" stroke="#C9A84C" stroke-width="1" stroke-opacity="0.3"/>
</svg>`;
}

async function callAnthropicForKit(restaurantName, offer) {
  const start = String(offer.start_time || '').slice(0,5);
  const end   = String(offer.end_time   || '').slice(0,5);
  const prompt = `You are a social media copywriter for Club Eats, a restaurant loyalty program in Moldova. Generate promotional copy for a quiet-hours discount offer.

Restaurant: ${restaurantName}
Offer: ${offer.name}
Discount: −${offer.discount_pct}%
Hours: ${start} – ${end}

Output ONLY valid JSON (no markdown, no explanation, no code fences):
{"ro_caption":"Romanian Instagram caption ~500 chars, warm local tone, mentions Club Eats and nota., 3-5 hashtags","ru_caption":"Russian Instagram caption ~500 chars same style","ro_short":"Romanian Telegram one-liner max 120 chars punchy","ru_short":"Russian Telegram one-liner max 120 chars punchy"}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}`);
  const data = await resp.json();
  const text = data.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  return JSON.parse(match[0]);
}

function templateKit(restaurantName, offer) {
  const start = String(offer.start_time || '').slice(0,5);
  const end   = String(offer.end_time   || '').slice(0,5);
  const timeW = `${start}–${end}`;
  const slug  = restaurantName.replace(/\s+/g, '');
  return {
    ro_caption: `🍽 Ore liniștite la ${restaurantName}! Azi ${timeW} bucură-te de −${offer.discount_pct}% reducere la toate preparatele, prin Club Eats. Plătește cu nota. și economisești instant — zero pași în plus. 🌟 Nu rata oferta! #ClubEats #${slug} #Reduceri #nota #Moldova`,
    ru_caption: `🍽 Тихие часы в ${restaurantName}! Сегодня ${timeW} скидка −${offer.discount_pct}% на всё меню через Club Eats. Оплачивай через nota. и экономь мгновенно — никаких лишних шагов. 🌟 #ClubEats #${slug} #Скидки #nota #Молдова`,
    ro_short:   `−${offer.discount_pct}% la ${restaurantName} azi ${timeW} 🍽 Club Eats prin nota.`,
    ru_short:   `−${offer.discount_pct}% в ${restaurantName} сегодня ${timeW} 🍽 Club Eats через nota.`,
  };
}

app.post('/api/dashboard/offers/:id/promo-kit', requireAuth, async (req, res) => {
  const offerId      = parseInt(req.params.id);
  const restaurantId = req.restaurant.restaurantId;
  const regenerate   = req.body?.regenerate === true;
  if (!offerId) return res.status(400).json({ error: 'Invalid id' });

  try {
    // 1. Tenant-scoped offer lookup
    const { rows: [offer] } = await pool.query(
      `SELECT id, name, discount_pct, start_time::text, end_time::text
       FROM offers WHERE id=$1 AND restaurant_id=$2`,
      [offerId, restaurantId]
    );
    if (!offer) return res.status(404).json({ error: 'Oferta nu a fost găsită' });

    const { rows: [rest] } = await pool.query(
      'SELECT name FROM restaurants WHERE id=$1', [restaurantId]
    );
    const restaurantName = rest?.name || 'Restaurant';

    // 2. Always generate fresh SVGs (deterministic, no AI cost)
    const svg_square = generatePromoSVG(restaurantName, offer, 'square');
    const svg_story  = generatePromoSVG(restaurantName, offer, 'story');

    // 3. Check caption cache (skip if regenerate=true)
    if (!regenerate) {
      const { rows: [cached] } = await pool.query(
        `SELECT ro_caption, ru_caption, ro_short, ru_short, ai_used FROM promo_kit_cache WHERE offer_id=$1`,
        [offerId]
      );
      if (cached) {
        return res.json({ ...cached, svg_square, svg_story, cached: true, rate_limit_remaining: null });
      }
    }

    // 4. Rate limit: 10 AI generations per restaurant per day
    const { rows: [rl] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM promo_kit_log
       WHERE restaurant_id=$1 AND created_at >= CURRENT_DATE`,
      [restaurantId]
    );
    const usedToday = rl.count;
    if (usedToday >= 10) {
      return res.status(429).json({
        error: 'Limita de 10 generări/zi atinsă. Reîncearcă mâine.',
        rate_limit_remaining: 0,
        ai_unavailable: true,
      });
    }

    // 5. AI generation or template fallback
    let captions = null;
    let ai_used  = false;
    if (ANTHROPIC_API_KEY) {
      try {
        const json = await callAnthropicForKit(restaurantName, offer);
        if (json.ro_caption && json.ru_caption && json.ro_short && json.ru_short) {
          captions = json;
          ai_used  = true;
        }
      } catch (err) {
        console.warn('[promo-kit] AI error, falling back to template:', err.message);
      }
    }
    if (!captions) captions = templateKit(restaurantName, offer);

    const { ro_caption, ru_caption, ro_short, ru_short } = captions;

    // 6. Cache captions
    await pool.query(
      `INSERT INTO promo_kit_cache (offer_id, restaurant_id, ro_caption, ru_caption, ro_short, ru_short, ai_used, generated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (offer_id) DO UPDATE
         SET ro_caption=$3, ru_caption=$4, ro_short=$5, ru_short=$6, ai_used=$7, generated_at=NOW()`,
      [offerId, restaurantId, ro_caption, ru_caption, ro_short, ru_short, ai_used]
    );

    // 7. Log the generation
    await pool.query(
      'INSERT INTO promo_kit_log (restaurant_id, offer_id) VALUES ($1,$2)',
      [restaurantId, offerId]
    );

    res.json({
      ro_caption, ru_caption, ro_short, ru_short,
      svg_square, svg_story,
      ai_used, cached: false,
      rate_limit_remaining: 10 - usedToday - 1,
    });
  } catch (err) {
    console.error('[promo-kit]', err);
    res.status(500).json({ error: 'Eroare la generarea kit-ului promo' });
  }
});

// ─── Club Eats: attribution stats ─────────────────────────────────────────────

app.get('/api/dashboard/club-eats', requireAuth, async (req, res) => {
  const periodMap = { today: `NOW()::date`, '7d': `NOW() - INTERVAL '7 days'`, '30d': `NOW() - INTERVAL '30 days'` };
  const since = periodMap[req.query.period] || periodMap['7d'];
  const rId = req.restaurant.restaurantId;
  try {
    const [{ rows: byOffer }, { rows: [totals] }, { rows: [members] }, { rows: [referralStats] }] = await Promise.all([
      pool.query(`
        SELECT o.id, o.name AS offer_name, o.discount_pct,
               COUNT(p.id)::int                                                          AS payment_count,
               COALESCE(SUM(p.gross_lei), 0)::numeric(10,2)                             AS gross_total,
               COALESCE(SUM(p.discount_lei), 0)::numeric(10,2)                          AS discount_total,
               COALESCE(SUM(p.amount_lei), 0)::numeric(10,2)                            AS net_total,
               COUNT(DISTINCT p.device_id) FILTER (WHERE p.device_id IS NOT NULL)::int  AS unique_devices,
               COUNT(DISTINCT p.member_id) FILTER (WHERE p.member_id IS NOT NULL)::int  AS unique_members
        FROM offers o
        LEFT JOIN payments p ON p.offer_id = o.id AND p.status = 'paid' AND p.paid_at >= ${since}
        WHERE o.restaurant_id = $1
        GROUP BY o.id, o.name, o.discount_pct
        ORDER BY discount_total DESC NULLS LAST
      `, [rId]),
      pool.query(`
        SELECT
          COALESCE(SUM(p.gross_lei), 0)::numeric(10,2)    AS total_gross,
          COALESCE(SUM(p.discount_lei), 0)::numeric(10,2) AS total_discount,
          COALESCE(SUM(p.amount_lei), 0)::numeric(10,2)   AS total_net,
          COUNT(p.id)::int                                 AS total_payments,
          COUNT(DISTINCT p.device_id) FILTER (WHERE p.device_id IS NOT NULL)::int AS total_devices,
          COUNT(DISTINCT p.member_id) FILTER (WHERE p.member_id IS NOT NULL)::int AS total_members
        FROM payments p
        JOIN orders ord ON ord.id = p.order_id
        WHERE ord.restaurant_id = $1 AND p.status = 'paid' AND p.paid_at >= ${since} AND p.offer_id IS NOT NULL
      `, [rId]),
      pool.query(`
        SELECT
          COUNT(DISTINCT p.member_id) FILTER (WHERE p.member_id IS NOT NULL)::int AS total_members,
          COUNT(DISTINCT p.member_id) FILTER (
            WHERE p.member_id IS NOT NULL
            AND p.member_id NOT IN (
              SELECT DISTINCT member_id FROM payments
              WHERE restaurant_id = $1 AND status = 'paid' AND paid_at < ${since} AND member_id IS NOT NULL
            )
          )::int AS new_members
        FROM payments p
        WHERE p.restaurant_id = $1 AND p.status = 'paid' AND p.paid_at >= ${since}
      `, [rId]),
      pool.query(`
        SELECT
          COUNT(DISTINCT m.id)::int                                        AS via_referral,
          COUNT(DISTINCT r.id) FILTER (WHERE r.converted)::int            AS referral_converted
        FROM payments p
        JOIN members m ON m.id = p.member_id
        LEFT JOIN referrals r ON r.referred_id = m.id
        WHERE p.restaurant_id = $1 AND p.status = 'paid' AND p.paid_at >= ${since}
          AND m.referred_by IS NOT NULL
      `, [rId]),
    ]);
    const returningMembers = (members.total_members || 0) - (members.new_members || 0);
    res.json({
      period: req.query.period || '7d',
      offers: byOffer,
      totals,
      memberStats: {
        new_members: members.new_members || 0,
        returning_members: Math.max(0, returningMembers),
        total_members: members.total_members || 0,
      },
      referralStats: {
        via_referral:       referralStats?.via_referral       || 0,
        referral_converted: referralStats?.referral_converted || 0,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Club Eats: public offers JSON ────────────────────────────────────────────

app.get('/api/public/offers', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.id AS restaurant_id, r.name AS restaurant_name, r.cover_image_id,
             o.name, o.discount_pct, o.days_of_week, o.start_time, o.end_time, o.active, o.member_only
      FROM offers o JOIN restaurants r ON r.id = o.restaurant_id
      WHERE o.public_visible = true
      ORDER BY o.discount_pct DESC, r.name
    `);
    res.json(rows.map(r => ({ ...r, cover_image_id: undefined, cover_photo: imageUrls(r.cover_image_id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Club Eats: quiet-hours suggestion ────────────────────────────────────────
// Returns up to 3 two-hour windows where revenue is lowest, for offer prefill.

app.get('/api/dashboard/quiet-hours', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        EXTRACT(HOUR FROM p.paid_at AT TIME ZONE 'Europe/Chisinau')::int AS hour,
        COALESCE(SUM(p.amount_lei), 0)::numeric(10,2)                    AS revenue
      FROM payments p
      WHERE p.restaurant_id = $1
        AND p.status = 'paid'
        AND p.paid_at >= NOW() - INTERVAL '30 days'
        AND EXTRACT(HOUR FROM p.paid_at AT TIME ZONE 'Europe/Chisinau') BETWEEN 10 AND 23
      GROUP BY hour
      ORDER BY revenue ASC
    `, [req.restaurant.restaurantId]);

    // Build 2-hour windows from 10:00 to 23:00
    const revenueByHour = {};
    for (let h = 10; h <= 23; h++) revenueByHour[h] = 0;
    for (const r of rows) revenueByHour[r.hour] = Number(r.revenue);

    const windows = [];
    for (let h = 10; h <= 22; h++) {
      windows.push({
        start_time: `${String(h).padStart(2,'0')}:00`,
        end_time:   `${String(h+2).padStart(2,'0')}:00`,
        revenue:    revenueByHour[h] + revenueByHour[h+1],
      });
    }
    windows.sort((a, b) => a.revenue - b.revenue);
    res.json(windows.slice(0, 3));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Dashboard settings (Google review URL, etc.) ────────────────────────────

app.get('/api/dashboard/settings', requireAuth, async (req, res) => {
  try {
    const { rows: [r] } = await pool.query(
      'SELECT google_review_url FROM restaurants WHERE id=$1',
      [req.restaurant.restaurantId]
    );
    res.json({ google_review_url: r?.google_review_url || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/dashboard/settings', requireAuth, async (req, res) => {
  const { google_review_url } = req.body;
  const url = typeof google_review_url === 'string' ? google_review_url.trim() : null;
  if (url && url.length > 500) return res.status(400).json({ error: 'URL too long' });
  if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL must start with http(s)' });
  try {
    await pool.query('UPDATE restaurants SET google_review_url=$1 WHERE id=$2',
      [url || null, req.restaurant.restaurantId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Onboarding wizard ──────────────────────────────────────────────────────
// Progress lives on the restaurant record itself (onboarding_step / onboarding_complete), so
// leaving and coming back just re-fetches this — no separate session/draft state to lose.

const MAIB_STATUSES = ['not_started', 'in_progress', 'active'];

app.get('/api/dashboard/onboarding', requireAuth, async (req, res) => {
  try {
    const rId = req.restaurant.restaurantId;
    const [{ rows: [rest] }, { rows: tables }, { rows: [menuCount] }] = await Promise.all([
      pool.query(
        `SELECT name, email, address, city, phone, timezone, logo_url, google_review_url,
                opening_hours, table_count, onboarding_step, onboarding_complete, menu_skipped,
                menu_published, qr_downloaded, maib_status, maib_env, maib_client_id,
                (maib_client_secret_enc IS NOT NULL) AS maib_has_credentials
         FROM restaurants WHERE id=$1`,
        [rId]
      ),
      pool.query('SELECT id, number, label, token FROM tables WHERE restaurant_id=$1 ORDER BY number', [rId]),
      pool.query('SELECT COUNT(*)::int AS n FROM menu_categories WHERE restaurant_id=$1', [rId]),
    ]);
    if (!rest) return res.status(404).json({ error: 'Not found' });
    res.json({ ...rest, tables, menuCategoryCount: menuCount.n });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/dashboard/onboarding/profile', requireAuth, async (req, res) => {
  const { name, address, city, phone, timezone, logo_url, google_review_url, opening_hours } = req.body || {};
  // Light validation only — nothing here should block a restaurant from moving on.
  if (name != null && (typeof name !== 'string' || !name.trim() || name.length > 200)) {
    return res.status(400).json({ error: 'Nume invalid' });
  }
  if (logo_url && (typeof logo_url !== 'string' || logo_url.length > 1000)) {
    return res.status(400).json({ error: 'Logo URL invalid' });
  }
  if (google_review_url && (typeof google_review_url !== 'string' || google_review_url.length > 500)) {
    return res.status(400).json({ error: 'Google review URL invalid' });
  }
  try {
    await pool.query(
      `UPDATE restaurants SET
         name = COALESCE($1, name), address = $2, city = $3, phone = $4,
         timezone = COALESCE($5, timezone), logo_url = $6, google_review_url = $7,
         opening_hours = $8
       WHERE id = $9`,
      [
        name?.trim() || null, (address || '').trim() || null, (city || '').trim() || null,
        (phone || '').trim() || null, timezone || null, (logo_url || '').trim() || null,
        (google_review_url || '').trim() || null,
        opening_hours ? JSON.stringify(opening_hours) : null,
        req.restaurant.restaurantId,
      ]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/dashboard/onboarding/step', requireAuth, async (req, res) => {
  const step = Number(req.body?.step);
  const complete = !!req.body?.complete;
  if (!Number.isInteger(step) || step < 1 || step > 6) return res.status(400).json({ error: 'Invalid step' });
  try {
    await pool.query(
      `UPDATE restaurants SET onboarding_step = GREATEST(onboarding_step, $1), onboarding_complete = onboarding_complete OR $2 WHERE id=$3`,
      [step, complete, req.restaurant.restaurantId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dashboard/onboarding/menu-skip', requireAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE restaurants SET menu_skipped=true WHERE id=$1`, [req.restaurant.restaurantId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dashboard/onboarding/qr-downloaded', requireAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE restaurants SET qr_downloaded=true WHERE id=$1`, [req.restaurant.restaurantId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Grows the table count to exactly `count`, creating any missing tables with fresh unguessable
// tokens using the same generation as registration. Never shrinks — reducing here could orphan
// an open order or a QR tent already printed and placed on a physical table.
app.put('/api/dashboard/tables/count', requireAuth, async (req, res) => {
  const count = Number(req.body?.count);
  if (!Number.isInteger(count) || count < 1 || count > 200) return res.status(400).json({ error: 'Invalid count' });
  const rId = req.restaurant.restaurantId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT number FROM tables WHERE restaurant_id=$1', [rId]);
    const existingNumbers = new Set(existing.map(r => r.number));
    const toCreate = [];
    for (let n = 1; n <= count; n++) if (!existingNumbers.has(n)) toCreate.push(n);

    if (toCreate.length) {
      const params = [rId];
      const placeholders = toCreate.map(n => {
        const tok = crypto.randomBytes(8).toString('hex');
        params.push(n, tok);
        return `($1, $${params.length - 1}, $${params.length})`;
      }).join(', ');
      await client.query(`INSERT INTO tables (restaurant_id, number, token) VALUES ${placeholders}`, params);
    }
    const finalCount = Math.max(count, existingNumbers.size ? Math.max(...existingNumbers) : 0);
    await client.query('UPDATE restaurants SET table_count=$1 WHERE id=$2', [finalCount, rId]);
    await client.query('COMMIT');
    res.json({ ok: true, created: toCreate.length, table_count: finalCount });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/dashboard/tables/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 60) || null : undefined;
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { rows: [row] } = await pool.query(
      `UPDATE tables SET label = COALESCE($1, label) WHERE id=$2 AND restaurant_id=$3 RETURNING id, number, label`,
      [label, id, req.restaurant.restaurantId]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// maib credentials — tenant-scoped, encrypted at rest, never echoed back (not even encrypted
// form). clientSecret/signatureKey omitted on an update keep whatever's already stored, so a
// restaurant can change just its status (e.g. confirm activation) without re-pasting secrets.
app.post('/api/dashboard/maib-credentials', requireAuth, async (req, res) => {
  const { clientId, clientSecret, signatureKey, env, status } = req.body || {};
  if (env && !['sandbox', 'production'].includes(env)) return res.status(400).json({ error: 'Invalid env' });
  if (status && !MAIB_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (clientId && (typeof clientId !== 'string' || clientId.length > 200)) return res.status(400).json({ error: 'Invalid clientId' });
  try {
    const rId = req.restaurant.restaurantId;
    const sets = [];
    const params = [];
    const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (clientId !== undefined) push('maib_client_id', clientId || null);
    if (clientSecret) push('maib_client_secret_enc', encryptSecret(clientSecret));
    if (signatureKey) push('maib_signature_key_enc', encryptSecret(signatureKey));
    if (env) push('maib_env', env);
    if (status) {
      push('maib_status', status);
    } else if (clientId && clientSecret) {
      // Submitting real credentials for the first time is itself evidence of progress.
      push(`maib_status`, 'in_progress');
    }
    if (!sets.length) return res.status(400).json({ error: 'Nimic de salvat' });

    params.push(rId);
    await pool.query(`UPDATE restaurants SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
    res.json({ ok: true });
  } catch (err) {
    console.error('[maib-credentials]', err.message); // never log clientSecret/signatureKey themselves
    res.status(500).json({ error: 'Eroare internă' });
  }
});

// ─── Admin (internal — DEV_API_KEY only, no JWT fallback) ────────────────────
// Deliberately NOT built on requireDevAuth: that falls back to any restaurant's own JWT, which
// would let one restaurant list every other restaurant. This must only ever accept the dev key.
function requireAdminAuth(req, res, next) {
  if (DEV_API_KEY && req.headers['x-dev-key'] === DEV_API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/admin/restaurants', requireAdminAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, email, table_count, onboarding_step, onboarding_complete,
             menu_published, menu_skipped, qr_downloaded, maib_status, maib_env, created_at
      FROM restaurants ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Feedback: submit (public, rate-limited) ──────────────────────────────────

app.post('/api/feedback', limiterAuth, async (req, res) => {
  const { restaurantId, paymentId, rating, comment, deviceId,
          nudgeShown = false, nudgeTapped = false, memberToken } = req.body;
  const rId = parseInt(restaurantId);
  const pId = parseInt(paymentId);
  const r   = parseInt(rating);
  if (!rId || !r || r < 1 || r > 5) return res.status(400).json({ error: 'Invalid params' });

  const membPayload = memberToken ? (await import('./members.js').then(m => m.verifyMemberJWT(memberToken))) : null;
  const memberId    = membPayload?.memberId ?? null;
  const dId         = (typeof deviceId === 'string' && deviceId.length < 128) ? deviceId : null;
  const cmt         = (typeof comment === 'string' && comment.trim()) ? comment.trim().slice(0, 1000) : null;

  try {
    // Verify restaurantId exists (also get order_id from payment if provided)
    const { rows: [rest] } = await pool.query(
      'SELECT id, google_review_url FROM restaurants WHERE id=$1', [rId]
    );
    if (!rest) return res.status(404).json({ error: 'Restaurant not found' });

    let orderId = null;
    if (pId) {
      const { rows: [p] } = await pool.query(
        'SELECT order_id FROM payments WHERE id=$1 AND restaurant_id=$2', [pId, rId]
      );
      orderId = p?.order_id ?? null;
    }

    const { rows: [fb] } = await pool.query(
      `INSERT INTO feedback (restaurant_id, order_id, payment_id, rating, comment,
                             nudge_shown, nudge_tapped, member_id, device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
      [rId, orderId, pId || null, r, cmt, !!nudgeShown, !!nudgeTapped, memberId, dId]
    );

    // Push live to dashboard
    io.to(`dashboard-${rId}`).emit('feedback-received', {
      id: fb.id, rating: r, comment: cmt, created_at: fb.created_at,
      nudge_shown: !!nudgeShown, nudge_tapped: !!nudgeTapped,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[feedback]', err);
    res.status(500).json({ error: 'Eroare internă' });
  }
});

// ─── Feedback: retroactively link payment to a new member ────────────────────

app.put('/api/feedback/link-payment', requireMemberAuth, async (req, res) => {
  const { paymentId, deviceId } = req.body;
  const pId = parseInt(paymentId);
  if (!pId) return res.status(400).json({ error: 'Invalid paymentId' });
  try {
    await pool.query(
      `UPDATE payments SET member_id=$1
       WHERE id=$2 AND member_id IS NULL AND status='paid'`,
      [req.member.memberId, pId]
    );
    // Also link any feedback from this session
    if (deviceId) {
      await pool.query(
        `UPDATE feedback SET member_id=$1
         WHERE device_id=$2 AND member_id IS NULL AND created_at > NOW() - INTERVAL '1 hour'`,
        [req.member.memberId, deviceId]
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Feedback: dashboard stats ────────────────────────────────────────────────

app.get('/api/dashboard/feedback', requireAuth, async (req, res) => {
  const periodMap = { today: `NOW()::date`, '7d': `NOW() - INTERVAL '7 days'`, '30d': `NOW() - INTERVAL '30 days'` };
  const since = periodMap[req.query.period] || periodMap['7d'];
  const rId = req.restaurant.restaurantId;
  try {
    const [{ rows: [totals] }, { rows: dist }, { rows: recent }, { rows: [nudge] }] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int                                               AS total_count,
          ROUND(AVG(rating)::numeric, 1)::float                      AS avg_rating,
          COUNT(*) FILTER (WHERE rating >= 4)::int                   AS positive_count,
          COUNT(*) FILTER (WHERE rating <= 3)::int                   AS critical_count,
          COUNT(*) FILTER (WHERE member_id IS NOT NULL)::int         AS member_count
        FROM feedback
        WHERE restaurant_id = $1 AND created_at >= ${since}
      `, [rId]),
      pool.query(`
        SELECT rating, COUNT(*)::int AS count
        FROM feedback
        WHERE restaurant_id = $1 AND created_at >= ${since}
        GROUP BY rating ORDER BY rating DESC
      `, [rId]),
      pool.query(`
        SELECT rating, comment, created_at
        FROM feedback
        WHERE restaurant_id = $1 AND rating <= 3 AND comment IS NOT NULL
          AND created_at >= ${since}
        ORDER BY created_at DESC LIMIT 20
      `, [rId]),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE nudge_shown)::int  AS shown,
          COUNT(*) FILTER (WHERE nudge_tapped)::int AS tapped
        FROM feedback
        WHERE restaurant_id = $1 AND created_at >= ${since}
      `, [rId]),
    ]);
    res.json({ period: req.query.period || '7d', totals, distribution: dist, recentCritical: recent, nudge });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── /oferte public discovery page ───────────────────────────────────────────

app.get('/oferte', async (_req, res) => {
  const DAY_RO = ['Dum','Lun','Mar','Mie','Joi','Vin','Sâm'];
  const DAY_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  try {
    const now = new Date();
    const dow = now.getDay();
    const pad = n => String(n).padStart(2,'0');
    const nowTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:00`;
    const { rows } = await pool.query(`
      SELECT r.name AS restaurant_name, o.id, o.name, o.discount_pct,
             o.days_of_week, o.start_time::text, o.end_time::text, o.active
      FROM offers o JOIN restaurants r ON r.id = o.restaurant_id
      WHERE o.public_visible = true ORDER BY o.discount_pct DESC, r.name
    `);
    const isActive = o =>
      o.active && o.days_of_week.includes(dow) &&
      o.start_time <= nowTime && o.end_time > nowTime;
    const fmt = t => t?.slice(0,5) ?? '';
    const cards = rows.map(o => {
      const live = isActive(o);
      const days = o.days_of_week.map(d => DAY_RO[d]).join(',');
      return `
      <div class="offer-card${live ? ' live' : ''}">
        ${live ? '<div class="badge-live">ACTIV ACUM</div>' : ''}
        <div class="oc-pct">−${o.discount_pct}%</div>
        <div class="oc-name">${esc(o.name)}</div>
        <div class="oc-rest">${esc(o.restaurant_name)}</div>
        <div class="oc-time">${fmt(o.start_time)} – ${fmt(o.end_time)}</div>
        <div class="oc-days">${days}</div>
      </div>`;
    }).join('');
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="ro">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>nota. — Oferte ore liniștite</title>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&family=Playfair+Display:wght@700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Manrope',sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
.hdr{padding:28px 20px 20px;text-align:center;border-bottom:1px solid rgba(197,160,89,.15)}
.brand{font-family:'Playfair Display',serif;font-size:28px;color:#C5A059;letter-spacing:.08em}
.hdr-sub{font-size:13px;color:#8b949e;margin-top:6px}
.container{max-width:720px;margin:0 auto;padding:28px 16px 60px}
.section-title{font-size:15px;font-weight:700;color:#8b949e;letter-spacing:.1em;text-transform:uppercase;margin-bottom:18px}
.offer-card{background:#161b22;border:1px solid #30363d;border-radius:14px;padding:20px 18px;margin-bottom:14px;position:relative;transition:border-color .15s}
.offer-card.live{border-color:#C5A059;background:linear-gradient(135deg,#161b22 60%,rgba(197,160,89,.06))}
.badge-live{position:absolute;top:14px;right:14px;background:#C5A059;color:#0d1117;font-size:10px;font-weight:700;letter-spacing:.12em;padding:3px 8px;border-radius:20px}
.oc-pct{font-family:'Playfair Display',serif;font-size:32px;color:#C5A059;font-weight:700;line-height:1;margin-bottom:6px}
.oc-name{font-size:16px;font-weight:700;margin-bottom:4px}
.oc-rest{font-size:13px;color:#8b949e;margin-bottom:8px}
.oc-time{font-size:12px;font-weight:600;color:#e6edf3;opacity:.7;margin-bottom:2px}
.oc-days{font-size:11px;color:#8b949e}
.empty{text-align:center;padding:60px 0;color:#8b949e}
.footer{text-align:center;padding:32px 16px;font-size:11px;color:#8b949e;border-top:1px solid #21262d;margin-top:40px}
.footer a{color:#C5A059;text-decoration:none}
</style>
</head>
<body>
<div class="hdr">
  <div class="brand">nota.</div>
  <div class="hdr-sub">Oferte ore liniștite — descoperă discounturile active</div>
</div>
<div class="container">
  <div class="section-title">Oferte disponibile</div>
  ${cards || '<div class="empty">Nicio ofertă activă momentan.</div>'}
</div>
<div class="footer">
  Un serviciu <a href="${APP_URL}">nota.</a> — plată instant la restaurant, fără coadă.
</div>
</body></html>`);
  } catch (err) {
    res.status(500).send('Eroare internă');
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

    // Enforce exactly one open order per table — close any older stale open orders
    await pool.query(
      `UPDATE orders SET status='closed' WHERE table_id=$1 AND status='open' AND id != $2`,
      [tbl.id, order.id]
    );

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
    notifyDashboardActivity(restaurantId, tableNumber);
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
         VALUES ($1, $2, $3, 'closed') RETURNING id`,
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

// Sandbox-only: trigger maib's test-pay endpoint to complete a live sandbox QR, so the full
// webhook → settlement loop can be exercised end-to-end before real credentials exist. Uses the
// calling restaurant's own sandbox credentials (JWT auth), or an explicit restaurantId in the
// body (dev-key auth), or falls back to env-configured credentials for bare module testing.
app.post('/api/dev/simulate-mia-payment', requireDevAuth, async (req, res) => {
  try {
    const { qrId, amountLei, iban, payerName, restaurantId: bodyRid } = req.body || {};
    if (!qrId || !amountLei || !iban || !payerName) {
      return res.status(400).json({ error: 'qrId, amountLei, iban, payerName required' });
    }
    const rId = req.restaurant.restaurantId ?? bodyRid ?? null;
    const creds = rId ? await getRestaurantMiaCreds(rId) : undefined;
    const result = await simulatePayment({ qrId, amountLei, iban, payerName }, creds);
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[simulate-mia-payment]', err.message);
    res.status(502).json({ error: 'Simulation failed', detail: err.message });
  }
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
    tables.map(async t => {
      const url = `${APP_URL}/?t=${t.token}`;
      const svg = await QRCode.toString(url, { type: 'svg', width: 280, margin: 1 });
      return { n: t.number, url, svg };
    })
  );

  res.send(`<!DOCTYPE html>
<html lang="ro">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR Mese — nota.</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Georgia, 'Times New Roman', serif; background: #f0ede8; padding: 28px; }

.top-bar {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 28px; flex-wrap: wrap; gap: 12px;
}
.top-bar h1 { font-size: 22px; font-weight: 700; color: #1a1a1a; font-family: Georgia, serif; }
.print-btn {
  background: #00333c; color: #fff; border: none;
  padding: 10px 22px; border-radius: 8px; font-size: 14px;
  font-weight: 600; cursor: pointer; font-family: inherit;
  letter-spacing: .02em; transition: background .15s;
}
.print-btn:hover { background: #004d59; }

.tents-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 298px);
  gap: 24px;
  justify-content: center;
}

/* The tent card — screen preview */
.tent {
  width: 298px;
  background: #fff;
  border-radius: 12px;
  border: 1px solid #d9d0c2;
  display: flex; flex-direction: column; align-items: center;
  overflow: hidden;
  box-shadow: 0 2px 12px rgba(0,0,0,.10);
}

.tent-top {
  width: 100%; background: #00333c;
  padding: 14px 20px 12px;
  display: flex; align-items: center; justify-content: space-between;
}
.tent-brand { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 700; color: #fff; letter-spacing: -0.5px; }
.tent-brand span { color: #fed488; }
.tent-tagline { font-size: 9px; color: rgba(255,255,255,.55); text-transform: uppercase; letter-spacing: .14em; margin-top: 2px; }
.tent-num-badge {
  background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.2);
  border-radius: 8px; padding: 6px 10px; text-align: center;
}
.tent-num-label { font-size: 8px; color: rgba(255,255,255,.6); text-transform: uppercase; letter-spacing: .1em; }
.tent-num-val { font-size: 22px; font-weight: 700; color: #fff; line-height: 1.1; }

.tent-qr {
  padding: 20px 24px 8px;
  display: flex; align-items: center; justify-content: center;
}
.tent-qr svg { width: 200px; height: 200px; }

.tent-scan-ro { font-size: 14px; font-weight: 600; color: #00333c; text-align: center; padding: 0 16px; }
.tent-scan-ru { font-size: 12.5px; color: #6b5c3e; text-align: center; padding: 4px 16px 0; }

.tent-divider {
  width: calc(100% - 40px); height: 1px;
  background: linear-gradient(to right, transparent, #d9d0c2, transparent);
  margin: 12px 0 10px;
}

.tent-footer { font-size: 9.5px; color: #9b8e7a; text-align: center; padding: 0 16px 16px; letter-spacing: .05em; }
.tent-url { font-size: 8px; color: #b5a894; padding: 0 16px 12px; text-align: center; word-break: break-all; }

/* ── Print styles ──────────────────────────────────────── */
@media print {
  @page { size: A6 portrait; margin: 6mm; }
  body { background: white; padding: 0; }
  .top-bar { display: none !important; }
  .tents-grid { display: block; }

  .tent {
    width: 100%; height: calc(148mm - 12mm); /* A6 height minus margins */
    border: none; border-radius: 0; box-shadow: none;
    page-break-after: always;
    break-after: page;
    display: flex; flex-direction: column; align-items: center;
    justify-content: space-between;
  }
  .tent:last-child { page-break-after: avoid; break-after: avoid; }

  .tent-top { padding: 12px 16px 10px; }
  .tent-brand { font-size: 20px; }
  .tent-qr { padding: 12px 16px 4px; }
  .tent-qr svg { width: 185px; height: 185px; }
  .tent-scan-ro { font-size: 13px; }
  .tent-scan-ru { font-size: 12px; }
  .tent-url { display: none; }
}
</style>
</head>
<body>

<div class="top-bar no-print">
  <h1>📋 QR Mese — nota.</h1>
  <button class="print-btn" onclick="window.print()">🖨 Printează</button>
</div>

<div class="tents-grid">
${qrs.map(({ n, url, svg }) => `
  <div class="tent">
    <div class="tent-top">
      <div>
        <div class="tent-brand">nota<span>.</span></div>
        <div class="tent-tagline">QR Table Payment</div>
      </div>
      <div class="tent-num-badge">
        <div class="tent-num-label">Masa</div>
        <div class="tent-num-val">${n}</div>
      </div>
    </div>
    <div class="tent-qr">${svg}</div>
    <div class="tent-scan-ro">Scanează pentru a plăti</div>
    <div class="tent-scan-ru">Отсканируйте, чтобы оплатить</div>
    <div class="tent-divider"></div>
    <div class="tent-footer">powered by nota. · paynota.com</div>
    <div class="tent-url">${url}</div>
  </div>`).join('')}
</div>

</body></html>`);
});

// ─── health ───────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({
  ok:    true,
  iiko:  IIKO_LIVE,
  mia:   MIA_DEFAULT_MODE, // 'off' | 'mock' | 'sandbox' | 'production' — no secrets, just the env-fallback mode
  db:    !!process.env.DATABASE_URL,
  build: BUILD,
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

// Per-table waiter-call throttle: max 1 call per 60 s
const waiterCallThrottle = new Map(); // `${restaurantId}-${tableNumber}` → timestamp

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
  let currentMemberId     = null;

  socket.on('join-table', async ({ token, tableNumber, restaurantId, paymentId, memberToken } = {}) => {
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
      // Validate member token if provided — strictly separate from restaurant auth
      const memberPayload = verifyMemberJWT(memberToken);
      currentMemberId = memberPayload?.memberId ?? null;
      socket.join(`table-${resolvedRestaurantId}-${resolvedNumber}`);
      const [order, activeOffer, memberBonus] = await Promise.all([
        getOpenOrder(resolvedNumber, currentRestaurantId),
        getActiveOffer(resolvedRestaurantId, { memberId: currentMemberId }),
        getActiveMemberBonus(currentMemberId),
      ]);
      socket.emit('order-update', { ...order, activeOffer: activeOffer || null, memberBonus: memberBonus || null });

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

  // Public, unauthenticated: /club broadcasts to every visitor across all restaurants — the
  // public offers listing is already cross-tenant (GET /api/public/offers), so one shared room
  // is the right shape, not a per-restaurant one. No tenant data is exposed by joining it.
  socket.on('join-public-offers', () => {
    socket.join('public-offers');
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
        notifyDashboardActivity(currentRestaurantId, currentTable);
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
        notifyDashboardActivity(currentRestaurantId, currentTable);
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
        notifyDashboardActivity(currentRestaurantId, currentTable);
      }
      ack?.({ released: rows.map(r => r.id) });
    } catch (err) {
      console.error('[release-item]', err);
      ack?.({ error: 'Eroare internă' });
    }
  });

  // ── pay-claimed: item-level payment (splitMode = 'mine') ──────────────────
  socket.on('pay-claimed', async ({ tipLei, deviceId }, ack) => {
    if (checkThrottle(socket)) return ack?.({ error: 'Rate limit' });
    if (!currentTable) return ack?.({ error: 'Not joined to a table' });
    const tip = Number(tipLei) || 0;
    if (!Number.isFinite(tip) || tip < 0) return ack?.({ error: 'Invalid tip' });
    const dId = (typeof deviceId === 'string' && deviceId.length < 128) ? deviceId : null;
    try {
      const tbl   = currentTable;
      const [order, offer, memberBonus] = await Promise.all([
        getOpenOrder(tbl, currentRestaurantId),
        getActiveOffer(currentRestaurantId, { memberId: currentMemberId }),
        getActiveMemberBonus(currentMemberId),
      ]);
      const mine  = order.items.filter(it => it.claimed_by === socket.id && it.status === 'claimed');
      if (!mine.length) return ack?.({ error: 'No claimed items' });

      const gross       = mine.reduce((s, it) => s + Number(it.price), 0);
      const effectivePct = Math.min((offer?.discount_pct || 0) + (memberBonus?.bonus_pct || 0), 50);
      const discountLei  = effectivePct > 0 ? roundLei(gross * effectivePct / 100) : 0;
      const netAmount    = roundLei(gross - discountLei);
      const dbPmtId      = await createPendingPayment({
        orderId: order.id, amountLei: netAmount, tipLei: tip,
        socketId: socket.id, mode: 'claimed',
        offerId: offer?.id ?? null, discountLei, grossLei: gross, deviceId: dId,
        memberId: currentMemberId,
      });

      let payment;
      try {
        const miaCreds = await getRestaurantMiaCreds(currentRestaurantId);
        payment = await requestPayment({ amountLei: netAmount, tipLei: tip, orderId: order.id, tableNumber: tbl }, miaCreds);
      } catch (err) {
        await pool.query(`UPDATE payments SET status='failed' WHERE id=$1`, [dbPmtId]);
        // Initiation itself failed (before any provider payment exists) — no settlement can ever
        // arrive for this attempt, so release the claimed items now rather than leaving them
        // stuck until the socket disconnects.
        await pool.query(
          `UPDATE order_items SET status='available', claimed_by=NULL WHERE claimed_by=$1 AND status='claimed'`,
          [socket.id]
        );
        const fresh = await getOpenOrder(tbl, currentRestaurantId);
        io.to(`table-${currentRestaurantId}-${tbl}`).emit('order-update', { ...fresh, activeOffer: offer || null, memberBonus: memberBonus || null });
        notifyDashboardActivity(currentRestaurantId, tbl);
        return ack?.({ error: 'Plata nu a putut fi inițiată' });
      }

      await pool.query(`UPDATE payments SET mia_payment_id=$1 WHERE id=$2`, [payment.paymentId, dbPmtId]);

      const meta = {
        dbPaymentId: dbPmtId, socketId: socket.id, tableNumber: tbl,
        restaurantId: currentRestaurantId, orderId: order.id,
        amountLei: netAmount, tipLei: tip, grossLei: gross, discountLei,
        mode: 'claimed', itemIds: mine.map(i => i.id), memberId: currentMemberId,
        bonusApplied: !!(memberBonus && memberBonus.bonus_pct > 0),
        bonusPct: memberBonus?.bonus_pct || 0,
        bonusExpires: memberBonus?.bonus_expires || null,
      };
      paymentMeta.set(payment.paymentId, meta);
      socketInflight.set(socket.id, payment.paymentId);
      notifyDashboardActivity(currentRestaurantId, tbl);

      const miaQrSvg = await buildMiaQrSvg(payment);
      ack?.({ success: true, ...payment, miaQrSvg });

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
  socket.on('pay-flat', async ({ amountLei, tipLei = 0, mode, deviceId }, ack) => {
    if (checkThrottle(socket)) return ack?.({ error: 'Rate limit' });
    if (!currentTable) return ack?.({ error: 'Not joined to a table' });
    if (!['equal', 'rest'].includes(mode)) return ack?.({ error: 'Invalid mode' });
    const tip = Number(tipLei) || 0;
    if (!Number.isFinite(tip) || tip < 0) return ack?.({ error: 'Invalid tip' });
    if (mode === 'equal') {
      const amt = Number(amountLei);
      if (!Number.isFinite(amt) || amt <= 0) return ack?.({ error: 'Invalid amount' });
    }
    const dId = (typeof deviceId === 'string' && deviceId.length < 128) ? deviceId : null;
    try {
      const tbl   = currentTable;
      const [order, offer, memberBonus] = await Promise.all([
        getOpenOrder(tbl, currentRestaurantId),
        getActiveOffer(currentRestaurantId, { memberId: currentMemberId }),
        getActiveMemberBonus(currentMemberId),
      ]);
      if (!order.id) return ack?.({ error: 'Nicio comandă deschisă' });

      const remaining = order.items
        .filter(it => it.status !== 'paid')
        .reduce((s, it) => s + Number(it.price), 0);

      // Server is authoritative: 'rest' uses full remaining; 'equal' caps at remaining
      let grossAmount;
      if (mode === 'rest') {
        grossAmount = remaining;
      } else {
        grossAmount = Math.min(Number(amountLei), remaining);
      }
      if (grossAmount <= 0) return ack?.({ error: 'Nimic de plătit' });

      const effectivePct = Math.min((offer?.discount_pct || 0) + (memberBonus?.bonus_pct || 0), 50);
      const discountLei  = effectivePct > 0 ? roundLei(grossAmount * effectivePct / 100) : 0;
      const netAmount    = roundLei(grossAmount - discountLei);

      const dbPmtId = await createPendingPayment({
        orderId: order.id, amountLei: netAmount, tipLei: tip,
        socketId: socket.id, mode: 'flat',
        offerId: offer?.id ?? null, discountLei, grossLei: grossAmount, deviceId: dId,
        memberId: currentMemberId,
      });

      let payment;
      try {
        const miaCreds = await getRestaurantMiaCreds(currentRestaurantId);
        payment = await requestPayment({ amountLei: netAmount, tipLei: tip, orderId: order.id, tableNumber: tbl }, miaCreds);
      } catch (err) {
        await pool.query(`UPDATE payments SET status='failed' WHERE id=$1`, [dbPmtId]);
        return ack?.({ error: 'Plata nu a putut fi inițiată' });
      }

      await pool.query(`UPDATE payments SET mia_payment_id=$1 WHERE id=$2`, [payment.paymentId, dbPmtId]);

      const meta = {
        dbPaymentId: dbPmtId, socketId: socket.id, tableNumber: tbl,
        restaurantId: currentRestaurantId, orderId: order.id,
        amountLei: netAmount, tipLei: tip, grossLei: grossAmount, discountLei,
        mode: 'flat', memberId: currentMemberId,
        bonusApplied: !!(memberBonus && memberBonus.bonus_pct > 0),
        bonusPct: memberBonus?.bonus_pct || 0,
        bonusExpires: memberBonus?.bonus_expires || null,
      };
      paymentMeta.set(payment.paymentId, meta);
      socketInflight.set(socket.id, payment.paymentId);
      notifyDashboardActivity(currentRestaurantId, tbl);

      const miaQrSvg = await buildMiaQrSvg(payment);
      ack?.({ success: true, chargeAmount: netAmount, ...payment, miaQrSvg });

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

  socket.on('waiter-call', (_, ack) => {
    if (checkThrottle(socket)) return ack?.({ error: 'Rate limit' });
    if (!currentTable || !currentRestaurantId) return ack?.({ error: 'Not at a table' });
    const key = `${currentRestaurantId}-${currentTable}`;
    const now = Date.now();
    const last = waiterCallThrottle.get(key);
    if (last && now - last < 60_000) return ack?.({ error: 'Cooldown' });
    waiterCallThrottle.set(key, now);
    io.to(`dashboard-${currentRestaurantId}`).emit('waiter-called', { tableNumber: currentTable });
    ack?.({ ok: true });
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

async function getActiveOffer(restaurantId, { memberId = null, atTime = new Date() } = {}) {
  if (!restaurantId) return null;
  const dow = atTime.getDay();
  const pad = n => String(n).padStart(2, '0');
  const t   = `${pad(atTime.getHours())}:${pad(atTime.getMinutes())}:00`;
  const { rows } = await pool.query(`
    SELECT id, name, discount_pct, member_only
    FROM   offers
    WHERE  restaurant_id = $1
      AND  active = true
      AND  $2 = ANY(days_of_week)
      AND  start_time <= $3::time
      AND  end_time   >  $3::time
      AND  (member_only = false OR $4 = true)
    ORDER BY discount_pct DESC LIMIT 1
  `, [restaurantId, dow, t, !!memberId]);
  return rows[0] || null;
}

async function createPendingPayment({ orderId, amountLei, tipLei, socketId, mode,
  offerId = null, discountLei = 0, grossLei = null, deviceId = null, memberId = null }) {
  const { rows: [pmt] } = await pool.query(
    `INSERT INTO payments (order_id, restaurant_id, amount_lei, tip_lei, status, socket_id, mode,
                           offer_id, discount_lei, gross_lei, device_id, member_id)
     SELECT $1, o.restaurant_id, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10
     FROM orders o WHERE o.id = $1
     RETURNING id`,
    [orderId, amountLei, tipLei, socketId, mode, offerId, discountLei,
     grossLei ?? amountLei, deviceId, memberId]
  );
  return pmt.id;
}

async function checkReferralConversion(memberId) {
  if (!memberId) return;
  try {
    // Is this the member's first ever confirmed payment?
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM payments WHERE member_id=$1 AND status='paid'`,
      [memberId]
    );
    if (Number(count) !== 1) return;

    // Does this member have an unconverted referral?
    const { rows: [ref] } = await pool.query(
      `SELECT id, referrer_id FROM referrals WHERE referred_id=$1 AND converted=false`,
      [memberId]
    );
    if (!ref) return;

    await pool.query(`UPDATE referrals SET converted=true, converted_at=NOW() WHERE id=$1`, [ref.id]);
    // Grant +5% bonus to referred member (only if they don't have one yet)
    await pool.query(
      `UPDATE members SET bonus_pct=5, bonus_expires=NOW() + INTERVAL '60 days'
       WHERE id=$1 AND bonus_pct=0`,
      [memberId]
    );
    // Grant +5% bonus to referrer (only if they don't have one yet)
    await pool.query(
      `UPDATE members SET bonus_pct=5, bonus_expires=NOW() + INTERVAL '60 days'
       WHERE id=$1 AND bonus_pct=0`,
      [ref.referrer_id]
    );
    console.log(`[referral] Converted: member ${memberId} referred by ${ref.referrer_id} — bonuses granted`);
  } catch (err) {
    console.error('[referral conversion]', err);
  }
}

async function settlePayment(miaPaymentId, confirmedMiaId = null, payId = null) {
  const meta = paymentMeta.get(miaPaymentId);
  if (!meta) {
    // Server restart: recover from DB
    const { rows: [pmt] } = await pool.query(
      `SELECT p.id, p.socket_id, p.mode, p.amount_lei, p.tip_lei, p.order_id,
              p.gross_lei, p.discount_lei, p.member_id, o.table_number, o.restaurant_id
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.mia_payment_id = $1 AND p.status = 'pending'`,
      [miaPaymentId]
    );
    if (pmt) await settleFromDB(pmt, confirmedMiaId);
    return;
  }

  const { dbPaymentId, socketId, tableNumber, restaurantId, orderId, amountLei, tipLei,
          grossLei, discountLei = 0, mode, itemIds, timer, memberId = null,
          bonusApplied = false, bonusPct = 0, bonusExpires = null } = meta;
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
      `UPDATE payments SET status='paid', paid_at=NOW(), mia_payment_id=$2, mia_pay_id=COALESCE($3, mia_pay_id) WHERE id=$1`,
      [dbPaymentId, confirmedMiaId || miaPaymentId, payId]
    );

    // Consume referral bonus atomically with the payment settlement
    if (memberId && bonusApplied && bonusPct > 0) {
      await client.query(
        `UPDATE members SET bonus_pct=0, bonus_expires=NULL WHERE id=$1 AND bonus_pct > 0`,
        [memberId]
      );
    }

    await client.query('COMMIT');

    // After commit: check if this was the member's first payment → trigger referral conversion
    if (memberId) await checkReferralConversion(memberId);

    // Emit confirmed to the guest's socket
    const s = io.sockets.sockets.get(socketId);
    if (s) {
      const { rows: [rest] } = await pool.query(
        'SELECT google_review_url FROM restaurants WHERE id=$1', [restaurantId]
      );
      s.emit('payment-confirmed', {
        amountLei, tipLei, total: Number(amountLei) + Number(tipLei),
        mode, itemIds: itemIds || [],
        grossLei: grossLei ?? amountLei,
        discountLei,
        savingLei: discountLei,
        bonusUsed: bonusApplied ? bonusPct : 0,
        memberId,
        dbPaymentId,
        orderId,
        restaurantId,
        googleReviewUrl: rest?.google_review_url || null,
      });
    }

    const [order, activeOffer] = await Promise.all([
      getOpenOrder(tableNumber, restaurantId),
      getActiveOffer(restaurantId),
    ]);
    io.to(`table-${restaurantId}-${tableNumber}`).emit('order-update', { ...order, activeOffer: activeOffer || null, memberBonus: null });
    io.to(`table-${restaurantId}-${tableNumber}`).emit('table-payment', {
      amountLei, total: Number(amountLei) + Number(tipLei),
    });
    io.to(`dashboard-${restaurantId}`).emit('payment-made', {
      id: dbPaymentId, table_number: tableNumber, amount_lei: amountLei, tip_lei: tipLei,
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
      `SELECT p.id, p.socket_id, p.mode, p.order_id, p.member_id, p.mia_payment_id, o.table_number, o.restaurant_id
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.mia_payment_id = $1 AND p.status = 'pending'`,
      [miaPaymentId]
    );
    if (pmt) await releaseFromDB(pmt, reason);
    return;
  }

  const { dbPaymentId, socketId, tableNumber, restaurantId, mode, timer,
          memberId = null, bonusApplied = false, bonusPct = 0, bonusExpires = null } = meta;
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

    // Restore referral bonus: the payment failed, so the bonus was never consumed
    // (bonus is only consumed in settlePayment's COMMIT, which never ran)
    // No restore needed — bonus is consumed at settle time, not at initiation

    await client.query('COMMIT');

    // Best-effort: tell maib this QR is dead so it can't be paid after we've released the items.
    getRestaurantMiaCreds(restaurantId).then(creds => cancelPayment(miaPaymentId, reason, creds));

    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit('payment-failed', { reason });

    const [order, activeOffer] = await Promise.all([
      getOpenOrder(tableNumber, restaurantId),
      getActiveOffer(restaurantId),
    ]);
    io.to(`table-${restaurantId}-${tableNumber}`).emit('order-update', { ...order, activeOffer: activeOffer || null });
    notifyDashboardActivity(restaurantId, tableNumber);

    cleanupMeta(miaPaymentId, socketId);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[releasePayment]', err);
  } finally {
    client.release();
  }
}

// DB-only settlement/release for payments where in-memory meta is gone (server restart)
async function settleFromDB(pmt, confirmedMiaId = null, payId = null) {
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
      `UPDATE payments SET status='paid', paid_at=NOW(), mia_payment_id=COALESCE($2, mia_payment_id),
              mia_pay_id=COALESCE($3, mia_pay_id) WHERE id=$1`,
      [pmt.id, confirmedMiaId, payId]
    );
    await client.query('COMMIT');

    // After commit: referral conversion check (bonus in-memory state lost on restart — V1 accepted)
    if (pmt.member_id) await checkReferralConversion(pmt.member_id);

    const discLei = Number(pmt.discount_lei || 0);
    const s = io.sockets.sockets.get(pmt.socket_id);
    if (s) {
      const { rows: [rest] } = await pool.query(
        'SELECT google_review_url FROM restaurants WHERE id=$1', [pmt.restaurant_id]
      );
      s.emit('payment-confirmed', {
        amountLei: pmt.amount_lei, tipLei: pmt.tip_lei,
        total: Number(pmt.amount_lei) + Number(pmt.tip_lei),
        mode: pmt.mode, itemIds: [],
        grossLei: pmt.gross_lei ?? pmt.amount_lei,
        discountLei: discLei,
        savingLei: discLei,
        bonusUsed: 0,
        memberId: pmt.member_id ?? null,
        dbPaymentId: pmt.id,
        orderId: pmt.order_id,
        restaurantId: pmt.restaurant_id,
        googleReviewUrl: rest?.google_review_url || null,
      });
    }

    const [order, activeOffer] = await Promise.all([
      getOpenOrder(pmt.table_number, pmt.restaurant_id),
      getActiveOffer(pmt.restaurant_id),
    ]);
    io.to(`table-${pmt.restaurant_id}-${pmt.table_number}`).emit('order-update', { ...order, activeOffer: activeOffer || null });
    io.to(`table-${pmt.restaurant_id}-${pmt.table_number}`).emit('table-payment', {
      amountLei: pmt.amount_lei, total: Number(pmt.amount_lei) + Number(pmt.tip_lei),
    });
    io.to(`dashboard-${pmt.restaurant_id}`).emit('payment-made', {
      id: pmt.id, table_number: pmt.table_number, amount_lei: pmt.amount_lei, tip_lei: pmt.tip_lei,
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

    if (pmt.mia_payment_id) getRestaurantMiaCreds(pmt.restaurant_id).then(creds => cancelPayment(pmt.mia_payment_id, reason, creds));

    const [order, activeOffer] = await Promise.all([
      getOpenOrder(pmt.table_number, pmt.restaurant_id),
      getActiveOffer(pmt.restaurant_id),
    ]);
    io.to(`table-${pmt.restaurant_id}-${pmt.table_number}`).emit('order-update', { ...order, activeOffer: activeOffer || null });
    notifyDashboardActivity(pmt.restaurant_id, pmt.table_number);
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
             p.gross_lei, p.discount_lei, p.member_id, o.table_number, o.restaurant_id, o.created_at
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

      // 30s–3min and this restaurant has an active maib merchant → poll for status
      const miaCreds = miaId ? await getRestaurantMiaCreds(pmt.restaurant_id) : null;
      if (ageMs > 30_000 && miaId && miaCreds) {
        try {
          const { status, payId } = await getPaymentStatus(miaId, miaCreds);
          if (status === 'PAID') {
            if (paymentMeta.has(miaId)) await settlePayment(miaId, miaId, payId);
            else await settleFromDB(pmt, miaId, payId);
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

// ─── startup helpers ──────────────────────────────────────────────────────────

async function cleanupStaleOpenOrders() {
  try {
    // Step 1: close open orders whose items are all paid (or have no items) and
    // have no pending payments — these are fully-settled orders left open by old seeds.
    const { rowCount: r1 } = await pool.query(`
      UPDATE orders SET status='closed'
      WHERE status='open'
        AND id NOT IN (SELECT DISTINCT order_id FROM payments WHERE status='pending')
        AND NOT EXISTS (
          SELECT 1 FROM order_items WHERE order_id=orders.id AND status IN ('available','claimed')
        )
    `);

    // Step 2: for tables that still have multiple open orders, keep only the newest
    // and close the rest (those with no pending payments).
    const { rowCount: r2 } = await pool.query(`
      UPDATE orders SET status='closed'
      WHERE status='open'
        AND id NOT IN (
          SELECT DISTINCT ON (table_id) id FROM orders WHERE status='open'
          ORDER BY table_id, created_at DESC
        )
        AND id NOT IN (SELECT DISTINCT order_id FROM payments WHERE status='pending')
    `);

    if (r1 + r2 > 0) {
      console.log(`   [startup] closed ${r1} all-paid/empty + ${r2} duplicate open orders`);
    }
  } catch (err) {
    console.error('[startup] cleanupStaleOpenOrders:', err.message);
  }
}

// Demo dishes per table — varied so the demo doesn't look copy-pasted
const _SEED_TABLE_DISHES = {
  1: [['Spaghetti Carbonara', 185], ['Risotto ai Funghi', 210], ['Branzino al Forno', 290], ['Tiramisù', 95], ['Vino Rosso (pahar)', 75]],
  2: [['Risotto ai Funghi', 210], ['Branzino al Forno', 290], ['Pizza Margherita', 165], ['Bruschetta', 85], ['Tiramisù', 95]],
  3: [['Branzino al Forno', 290], ['Spaghetti Carbonara', 185], ['Vino Rosso (pahar)', 75], ['Panna Cotta', 90], ['Acqua Minerale', 35]],
};

async function autoSeedDemoTables() {
  try {
    for (const [tn, dishes] of Object.entries(_SEED_TABLE_DISHES)) {
      const tNum = Number(tn);
      const { rows: [tbl] } = await pool.query(
        'SELECT id, token FROM tables WHERE restaurant_id=1 AND number=$1', [tNum]
      );
      if (!tbl) continue;

      // Skip if a live open order with available items already exists
      const { rows: [live] } = await pool.query(`
        SELECT o.id FROM orders o
        WHERE o.table_id=$1 AND o.status='open'
          AND EXISTS (SELECT 1 FROM order_items WHERE order_id=o.id AND status='available')
        LIMIT 1
      `, [tbl.id]);
      if (live) {
        console.log(`   [startup] Table ${tNum}: live order exists — skipping auto-seed`);
        console.log(`   [startup] Table ${tNum} URL: ${APP_URL}/?t=${tbl.token}`);
        continue;
      }

      // Find or create the single open order for this table
      let { rows: [order] } = await pool.query(
        `SELECT id FROM orders WHERE table_id=$1 AND status='open' ORDER BY created_at DESC LIMIT 1`,
        [tbl.id]
      );
      if (!order) {
        const { rows: [o] } = await pool.query(
          `INSERT INTO orders (table_id, table_number, restaurant_id, status)
           VALUES ($1, $2, 1, 'open') RETURNING id`,
          [tbl.id, tNum]
        );
        order = o;
      }

      // Close any other open orders for this table (safety net)
      await pool.query(
        `UPDATE orders SET status='closed' WHERE table_id=$1 AND status='open' AND id!=$2`,
        [tbl.id, order.id]
      );

      await pool.query(`UPDATE payments SET status='cancelled' WHERE order_id=$1 AND status='pending'`, [order.id]);
      await pool.query(`DELETE FROM order_items WHERE order_id=$1`, [order.id]);

      const params = [order.id];
      const placeholders = dishes.map(([name, price]) => {
        params.push(name, price);
        const n = params.length;
        return `($1, $${n - 1}, $${n}, 'available')`;
      }).join(', ');
      await pool.query(
        `INSERT INTO order_items (order_id, name, price, status) VALUES ${placeholders}`,
        params
      );

      const total = dishes.reduce((s, [, p]) => s + p, 0);
      console.log(`   [startup] Table ${tNum} seeded: ${dishes.length} items, ${total} MDL`);
      console.log(`   [startup] Table ${tNum} URL: ${APP_URL}/?t=${tbl.token}`);
    }
  } catch (err) {
    console.error('[startup] autoSeedDemoTables:', err.message);
  }
}

// ─── start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, async () => {
  console.log(`\n🍽  nota. server running on port ${PORT}`);
  console.log(`   Build:    ${BUILD}`);
  console.log(`   App URL:  ${APP_URL}`);
  console.log(`   iiko:     ${IIKO_LIVE ? '✅ LIVE' : '⚠️  mock'}`);
  console.log(`   MIA:      ${MIA_DEFAULT_MODE === 'production' ? '✅ LIVE (production)' : MIA_DEFAULT_MODE === 'sandbox' ? '🧪 sandbox' : MIA_DEFAULT_MODE === 'mock' ? '⚠️  mock (misconfigured env)' : '◯ off'}`);
  console.log(`   DB:       ${process.env.DATABASE_URL ? '✅ connected' : '❌ DATABASE_URL missing'}`);

  // Release any items that were left claimed by a socket from the previous process
  try {
    await reconcilePendingPayments();
    const { rows: stuck } = await pool.query(
      `SELECT DISTINCT claimed_by, order_id FROM order_items WHERE status='claimed' AND claimed_by IS NOT NULL`
    );
    if (stuck.length) console.log(`   [startup] ${stuck.length} socket(s) have claimed items — reconciliation will resolve pending payments`);
  } catch {}

  // Clean up stale open orders left by old seeds, then ensure demo tables are ready
  await cleanupStaleOpenOrders();
  await autoSeedDemoTables();

  console.log(`   Dashboard: ${APP_URL}/dashboard`);
  console.log(`   QR codes:  ${APP_URL}/qrcodes\n`);
});
