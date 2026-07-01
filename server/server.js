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
 *   APP_URL               Public URL e.g. https://nota.up.railway.app
 *   PORT                  Default 3000
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
import QRCode           from 'qrcode';

import { pool } from './db.js';
import { getOpenOrder, addItem, parseIikoWebhook } from './iiko.js';
import { requestPayment, getPaymentStatus, verifyWebhookSignature, parseWebhookPayload, setMockFailNext } from './mia.js';
import { register, login, me, requireAuth } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app       = express();
const httpServer= createServer(app);
const io        = new Server(httpServer, { cors: { origin: '*' }, perMessageDeflate: true });
const PORT      = process.env.PORT || 3000;
const APP_URL   = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ─── middleware ───────────────────────────────────────────────────────────────

app.use(compression());
app.use('/api/payment/webhook', express.raw({ type: '*/*' }));
app.use('/api/iiko/webhook',    express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.static(join(__dirname, '../public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      // Revalidate HTML on every request so deploys go live immediately
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ─── auth routes ─────────────────────────────────────────────────────────────

app.post('/api/auth/register', register);
app.post('/api/auth/login',    login);
app.get( '/api/auth/me',       requireAuth, me);

// ─── table / order routes ─────────────────────────────────────────────────────

app.get('/api/table/by-token/:token', async (req, res) => {
  try {
    const { rows: [tbl] } = await pool.query(
      'SELECT number, restaurant_id FROM tables WHERE token = $1',
      [req.params.token]
    );
    if (!tbl) return res.status(404).json({ error: 'Masă invalidă' });
    const order = await getOpenOrder(tbl.number);
    res.json({ ...order, table_number: tbl.number });
  } catch (err) {
    console.error('[GET /api/table/by-token]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/table/:n', async (req, res) => {
  try {
    const order = await getOpenOrder(Number(req.params.n));
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dev/table-token/:n', async (req, res) => {
  try {
    const { rows: [tbl] } = await pool.query(
      'SELECT number, token FROM tables WHERE number = $1 LIMIT 1',
      [Number(req.params.n)]
    );
    if (!tbl) return res.status(404).json({ error: 'Table not found' });
    res.json({ number: tbl.number, token: tbl.token, url: `${APP_URL}/?t=${tbl.token}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/table/:n/item', async (req, res) => {
  try {
    const { name, price } = req.body;
    await addItem(Number(req.params.n), name, price);
    const order = await getOpenOrder(Number(req.params.n));
    io.to(`table-${req.params.n}`).emit('order-update', order);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── payment webhook ──────────────────────────────────────────────────────────

app.post('/api/payment/webhook', async (req, res) => {
  try {
    const sig   = req.headers['x-mia-signature'] || req.headers['x-signature'] || '';
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
    res.status(500).json({ error: err.message });
  }
});

// ─── iiko webhook ─────────────────────────────────────────────────────────────

app.post('/api/iiko/webhook', async (req, res) => {
  try {
    const body   = JSON.parse(req.body.toString());
    const orders = await parseIikoWebhook(body);
    for (const o of orders) {
      if (o.tableNumber) {
        const fresh = await getOpenOrder(o.tableNumber);
        io.to(`table-${o.tableNumber}`).emit('order-update', fresh);
        io.to('dashboard').emit('order-update', { tableNumber: o.tableNumber, order: fresh });
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[iiko webhook]', err);
    res.status(500).json({ error: err.message });
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── dev / demo routes ────────────────────────────────────────────────────────

app.post('/api/dev/seed-table', async (req, res) => {
  try {
    const tableNumber  = req.body.tableNumber  ?? 1;
    const restaurantId = req.body.restaurantId ?? 1;

    const { rows: [tbl] } = await pool.query(
      'SELECT id FROM tables WHERE restaurant_id = $1 AND number = $2',
      [restaurantId, tableNumber]
    );
    if (!tbl) return res.status(404).json({ error: `Table ${tableNumber} not found` });

    let { rows: [order] } = await pool.query(
      `SELECT id FROM orders WHERE table_id = $1 AND status = 'open' LIMIT 1`,
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

    const fresh = await getOpenOrder(tableNumber);
    io.to(`table-${tableNumber}`).emit('order-update', fresh);
    res.json({ ok: true, orderId: order.id, items: DEMO_DISHES.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dev/seed-payments', async (req, res) => {
  const rId = req.body.restaurantId || 1;
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
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Trigger mock payment failure for the NEXT payment initiated
app.post('/api/dev/mock-fail-next', (req, res) => {
  setMockFailNext();
  res.json({ ok: true, message: 'Next mock payment will be declined' });
});

// ─── QR codes ─────────────────────────────────────────────────────────────────

app.get('/qrcodes', async (req, res) => {
  const restaurantId = req.query.r || 1;
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
  iiko: !!(process.env.IIKO_API_LOGIN && process.env.IIKO_ORG_ID),
  mia:  !!(process.env.MIA_MERCHANT_ID && process.env.MIA_SECRET),
  db:   !!process.env.DATABASE_URL,
}));

// ═══════════════════════════════════════════════════════════════════════════════
// Payment state — in-memory meta for in-flight payments (lost on restart;
// reconciliation picks up pending rows from DB on next tick).
// ═══════════════════════════════════════════════════════════════════════════════

// paymentId (MIA id) → { dbPaymentId, socketId, tableNumber, orderId, amountLei, tipLei, mode, timer }
const paymentMeta = new Map();

// socketId → miaPaymentId — to know if this socket has an in-flight payment
const socketInflight = new Map();

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', socket => {
  let currentTable = null;

  socket.on('join-table', async ({ token, tableNumber, restaurantId } = {}) => {
    try {
      let resolvedNumber = tableNumber;
      if (token) {
        const { rows: [tbl] } = await pool.query(
          'SELECT number FROM tables WHERE token = $1', [token]
        );
        if (!tbl) return socket.emit('error', { message: 'Masă invalidă' });
        resolvedNumber = tbl.number;
      }
      if (!resolvedNumber) return socket.emit('error', { message: 'Masă invalidă' });
      currentTable = resolvedNumber;
      socket.join(`table-${resolvedNumber}`);
      const order = await getOpenOrder(resolvedNumber);
      socket.emit('order-update', order);
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('join-dashboard', () => { socket.join('dashboard'); });

  socket.on('claim-items', async (itemIds, ack) => {
    try {
      const { rows: claimed } = await pool.query(`
        UPDATE order_items
        SET status = 'claimed', claimed_by = $1
        WHERE id = ANY($2) AND status = 'available'
        RETURNING id
      `, [socket.id, itemIds]);

      const contestedIds = itemIds.filter(id => !claimed.find(r => r.id === id));
      if (claimed.length > 0) {
        io.to(`table-${currentTable}`).emit('items-patch',
          claimed.map(r => ({ id: r.id, status: 'claimed', claimed_by: socket.id }))
        );
      }
      ack?.({ claimed: claimed.map(r => r.id), contested: contestedIds });
    } catch (err) {
      ack?.({ error: err.message });
    }
  });

  socket.on('release-claims', async () => {
    try {
      // Never release while payment is in-flight — that's the server's job
      if (socketInflight.has(socket.id)) return;
      const { rows: released } = await pool.query(`
        UPDATE order_items SET status = 'available', claimed_by = NULL
        WHERE claimed_by = $1 AND status = 'claimed'
        RETURNING id
      `, [socket.id]);
      if (currentTable && released.length > 0) {
        io.to(`table-${currentTable}`).emit('items-patch',
          released.map(r => ({ id: r.id, status: 'available', claimed_by: null }))
        );
      }
    } catch (err) {
      console.error('[release-claims]', err);
    }
  });

  // ── pay-claimed: item-level payment (splitMode = 'mine') ──────────────────
  socket.on('pay-claimed', async ({ tipLei, tableNumber, orderId }, ack) => {
    try {
      const tbl   = tableNumber || currentTable;
      const order = await getOpenOrder(tbl);
      const mine  = order.items.filter(it => it.claimed_by === socket.id && it.status === 'claimed');
      if (!mine.length) return ack?.({ error: 'No claimed items' });

      const amountLei = mine.reduce((s, it) => s + Number(it.price), 0);
      const dbPmtId   = await createPendingPayment({ orderId: order.id, amountLei, tipLei: tipLei || 0, socketId: socket.id, mode: 'claimed' });

      let payment;
      try {
        payment = await requestPayment({ amountLei, tipLei, orderId: order.id, tableNumber: tbl });
      } catch (err) {
        await pool.query(`UPDATE payments SET status='failed' WHERE id=$1`, [dbPmtId]);
        return ack?.({ error: err.message });
      }

      await pool.query(`UPDATE payments SET mia_payment_id=$1 WHERE id=$2`, [payment.paymentId, dbPmtId]);

      const meta = { dbPaymentId: dbPmtId, socketId: socket.id, tableNumber: tbl, orderId: order.id, amountLei, tipLei: tipLei || 0, mode: 'claimed', itemIds: mine.map(i => i.id) };
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
      ack?.({ error: err.message });
    }
  });

  // ── pay-flat: flat-amount payment (splitMode = 'equal' or 'rest') ─────────
  socket.on('pay-flat', async ({ amountLei, tipLei = 0, mode, tableNumber, orderId }, ack) => {
    try {
      const tbl   = tableNumber || currentTable;
      const order = await getOpenOrder(tbl);
      if (!order.id) return ack?.({ error: 'Nicio comandă deschisă' });

      // Server is authoritative for 'rest' mode
      let chargeAmount = Number(amountLei);
      if (mode === 'rest') {
        chargeAmount = order.items
          .filter(it => it.status !== 'paid')
          .reduce((s, it) => s + Number(it.price), 0);
      }
      if (chargeAmount <= 0) return ack?.({ error: 'Nimic de plătit' });

      const dbPmtId = await createPendingPayment({ orderId: order.id, amountLei: chargeAmount, tipLei, socketId: socket.id, mode: 'flat' });

      let payment;
      try {
        payment = await requestPayment({ amountLei: chargeAmount, tipLei, orderId: order.id, tableNumber: tbl });
      } catch (err) {
        await pool.query(`UPDATE payments SET status='failed' WHERE id=$1`, [dbPmtId]);
        return ack?.({ error: err.message });
      }

      await pool.query(`UPDATE payments SET mia_payment_id=$1 WHERE id=$2`, [payment.paymentId, dbPmtId]);

      const meta = { dbPaymentId: dbPmtId, socketId: socket.id, tableNumber: tbl, orderId: order.id, amountLei: chargeAmount, tipLei, mode: 'flat' };
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
      ack?.({ error: err.message });
    }
  });

  socket.on('disconnect', async () => {
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
        io.to(`table-${currentTable}`).emit('items-patch',
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
      `SELECT p.id, p.socket_id, p.mode, p.amount_lei, p.tip_lei, p.order_id, o.table_number
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.mia_payment_id = $1 AND p.status = 'pending'`,
      [miaPaymentId]
    );
    if (pmt) await settleFromDB(pmt, confirmedMiaId);
    return;
  }

  const { dbPaymentId, socketId, tableNumber, orderId, amountLei, tipLei, mode, itemIds, timer } = meta;
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

    const order = await getOpenOrder(tableNumber);
    io.to(`table-${tableNumber}`).emit('order-update', order);
    io.to('dashboard').emit('payment-made', {
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
      `SELECT p.id, p.socket_id, p.mode, p.order_id, o.table_number
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.mia_payment_id = $1 AND p.status = 'pending'`,
      [miaPaymentId]
    );
    if (pmt) await releaseFromDB(pmt, reason);
    return;
  }

  const { dbPaymentId, socketId, tableNumber, mode, timer } = meta;
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

    const order = await getOpenOrder(tableNumber);
    io.to(`table-${tableNumber}`).emit('order-update', order);

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

    const order = await getOpenOrder(pmt.table_number);
    io.to(`table-${pmt.table_number}`).emit('order-update', order);
    io.to('dashboard').emit('payment-made', {
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

    const order = await getOpenOrder(pmt.table_number);
    io.to(`table-${pmt.table_number}`).emit('order-update', order);
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
             o.table_number, p.created_at
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

// ─── start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, async () => {
  console.log(`\n🍽  nota. server running on port ${PORT}`);
  console.log(`   App URL:  ${APP_URL}`);
  console.log(`   iiko:     ${process.env.IIKO_API_LOGIN ? '✅ LIVE' : '⚠️  mock'}`);
  console.log(`   MIA:      ${process.env.MIA_MERCHANT_ID ? '✅ LIVE' : '⚠️  mock'}`);
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
