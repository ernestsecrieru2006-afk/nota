/**
 * server.js — nota. Express + Socket.io server
 *
 * Integrations:
 *   iiko  → server/iiko.js  (mock if IIKO_API_LOGIN not set)
 *   MIA   → server/mia.js   (mock if MIA_MERCHANT_ID not set)
 *   Auth  → server/auth.js  (always active)
 *
 * ENV vars:
 *   DATABASE_URL          Postgres connection string (required)
 *   JWT_SECRET            Random secret for auth tokens (required in prod)
 *   APP_URL               Public URL e.g. https://nota.up.railway.app (for webhooks/QR)
 *   PORT                  Default 3000
 *   -- iiko (optional, enables live POS sync) --
 *   IIKO_API_LOGIN        iiko Cloud API login
 *   IIKO_BASE_URL         https://api-ru.iiko.services
 *   IIKO_ORG_ID           Organization UUID from iiko
 *   IIKO_EXTERNAL_PAYMENT_TYPE_ID   Payment type UUID for external payments
 *   -- MIA (optional, enables real payments) --
 *   MIA_BASE_URL          MIA API base URL
 *   MIA_MERCHANT_ID       Merchant ID
 *   MIA_SECRET            API secret
 *   MIA_WEBHOOK_SECRET    HMAC secret for webhook verification
 */

import 'dotenv/config';
import express       from 'express';
import { createServer } from 'http';
import { Server }    from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg            from 'pg';
import QRCode        from 'qrcode';

import { getOpenOrder, addItem, payClaimedItems, parseIikoWebhook } from './iiko.js';
import { requestPayment, getPaymentStatus, verifyWebhookSignature, parseWebhookPayload } from './mia.js';
import { register, login, me, requireAuth } from './auth.js';

const { Pool } = pg;
const pool     = new Pool({ connectionString: process.env.DATABASE_URL });

const __dirname = dirname(fileURLToPath(import.meta.url));
const app       = express();
const httpServer= createServer(app);
const io        = new Server(httpServer, { cors: { origin: '*' } });
const PORT      = process.env.PORT || 3000;
const APP_URL   = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ─── middleware ───────────────────────────────────────────────────────────────

// Raw body for webhook signature verification (must come before json())
app.use('/api/payment/webhook', express.raw({ type: '*/*' }));
app.use('/api/iiko/webhook',    express.raw({ type: '*/*' }));

app.use(express.json());
app.use(express.static(join(__dirname, '../public'), { extensions: ['html'] }));

// ─── auth routes ─────────────────────────────────────────────────────────────

app.post('/api/auth/register', register);
app.post('/api/auth/login',    login);
app.get( '/api/auth/me',       requireAuth, me);

// ─── table / order routes ─────────────────────────────────────────────────────

// Get open order for a table (public — guests use this)
app.get('/api/table/:n', async (req, res) => {
  try {
    const order = await getOpenOrder(Number(req.params.n));
    res.json(order);
  } catch (err) {
    console.error('[GET /api/table]', err);
    res.status(500).json({ error: err.message });
  }
});

// Add a dish (dev/demo only — in production waiter uses iikoFront)
app.post('/api/table/:n/item', async (req, res) => {
  try {
    const { name, price } = req.body;
    await addItem(Number(req.params.n), name, price);
    const order = await getOpenOrder(Number(req.params.n));
    io.to(`table-${req.params.n}`).emit('order-update', order);
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/table/item]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── payment routes ───────────────────────────────────────────────────────────

// Guest taps "Plătește cu MIA" — initiate payment
app.post('/api/payment/initiate', async (req, res) => {
  try {
    const { amountLei, tipLei = 0, socketId, tableNumber, orderId } = req.body;
    const result = await requestPayment({ amountLei, tipLei, orderId, tableNumber,
      description: `Masă ${tableNumber} — nota.` });
    res.json(result);

    // If mock (no MIA keys), auto-complete payment after 2s for demo flow
    if (result._mock) {
      setTimeout(async () => {
        try {
          await completePay(socketId, tipLei, tableNumber);
        } catch (e) {
          console.error('[mock pay auto-complete]', e);
        }
      }, 2000);
    } else {
      // Start polling as fallback if webhook is slow
      pollPaymentStatus(result.paymentId, socketId, tipLei, tableNumber);
    }
  } catch (err) {
    console.error('[POST /api/payment/initiate]', err);
    res.status(500).json({ error: err.message });
  }
});

// MIA webhook — bank confirms payment
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const sig  = req.headers['x-mia-signature'] || req.headers['x-signature'] || '';
    const valid = verifyWebhookSignature(req.body, sig);
    if (!valid) return res.status(401).send('Bad signature');

    const body    = JSON.parse(req.body.toString());
    const payload = parseWebhookPayload(body);

    if (payload.status === 'PAID' && payload.referenceId) {
      // referenceId format: nota-{orderId}-{timestamp}
      const parts    = payload.referenceId.split('-');
      const socketId = pendingPayments.get(payload.paymentId);
      if (socketId) {
        const table = pendingTables.get(payload.paymentId);
        const tip   = pendingTips.get(payload.paymentId) || 0;
        await completePay(socketId, tip, table, payload.paymentId);
        pendingPayments.delete(payload.paymentId);
        pendingTables.delete(payload.paymentId);
        pendingTips.delete(payload.paymentId);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[POST /api/payment/webhook]', err);
    res.status(500).json({ error: err.message });
  }
});

// iiko webhook — waiter added/removed items
app.post('/api/iiko/webhook', async (req, res) => {
  try {
    const body   = JSON.parse(req.body.toString());
    const orders = await parseIikoWebhook(body);
    for (const o of orders) {
      if (o.tableNumber) {
        // Refresh the order from iiko and push to guests
        const fresh = await getOpenOrder(o.tableNumber);
        io.to(`table-${o.tableNumber}`).emit('order-update', fresh);
        io.to('dashboard').emit('order-update', { tableNumber: o.tableNumber, order: fresh });
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[POST /api/iiko/webhook]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── dashboard API routes (require auth) ─────────────────────────────────────

app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const rId = req.restaurant.restaurantId;
    const { rows } = await pool.query(`
      SELECT
        COALESCE(SUM(amount_lei + tip_lei), 0) AS total_lei,
        COUNT(*)                                AS payment_count,
        COALESCE(SUM(tip_lei), 0)               AS total_tips
      FROM payments
      WHERE restaurant_id = $1 AND paid_at >= CURRENT_DATE
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
      WHERE restaurant_id = $1 AND paid_at >= CURRENT_DATE
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
      WHERE p.restaurant_id = $1
      ORDER BY p.paid_at DESC LIMIT 30
    `, [rId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// All tables status (live view for dashboard)
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

// ─── public dashboard (no auth needed — served by path) ──────────────────────
// Dashboard page itself is public but API calls require token (stored in localStorage)

// ─── dev / demo routes ────────────────────────────────────────────────────────

// Seed 5 demo dishes into an open order for the given table (default: table 1).
// POST /api/dev/seed-table   { tableNumber: 1, restaurantId: 1 }
app.post('/api/dev/seed-table', async (req, res) => {
  try {
    const tableNumber  = req.body.tableNumber  ?? 1;
    const restaurantId = req.body.restaurantId ?? 1;

    const { rows: [tbl] } = await pool.query(
      'SELECT id FROM tables WHERE restaurant_id = $1 AND number = $2',
      [restaurantId, tableNumber]
    );
    if (!tbl) return res.status(404).json({ error: `Table ${tableNumber} not found` });

    // Get or create an open order for this table
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

    // Reset existing items so we can re-seed cleanly
    await pool.query(`DELETE FROM order_items WHERE order_id = $1`, [order.id]);

    const DEMO_DISHES = [
      ['Spaghetti Carbonara', 185],
      ['Risotto ai Funghi',   210],
      ['Branzino al Forno',   290],
      ['Tiramisù',             95],
      ['Vino Rosso (pahar)',   75],
    ];

    for (const [name, price] of DEMO_DISHES) {
      await pool.query(
        `INSERT INTO order_items (order_id, name, price, status) VALUES ($1, $2, $3, 'available')`,
        [order.id, name, price]
      );
    }

    res.json({ ok: true, orderId: order.id, items: DEMO_DISHES.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dev/seed-payments', async (req, res) => {
  try {
    const rId = req.body.restaurantId || 1;
    const DISHES = [
      ['Spaghetti Carbonara', 185], ['Risotto ai Funghi', 210], ['Branzino al Forno', 290],
      ['Tiramisù', 95], ['Vino Rosso (pahar)', 75], ['Acqua Minerale', 35],
      ['Pizza Margherita', 165], ['Bruschetta', 85], ['Panna Cotta', 90],
    ];

    // Seed 20 fake payments spread over today
    for (let i = 0; i < 20; i++) {
      const tableNum = (i % 8) + 1;
      const { rows: [t] } = await pool.query(
        'SELECT id FROM tables WHERE restaurant_id = $1 AND number = $2', [rId, tableNum]
      );
      if (!t) continue;

      const { rows: [o] } = await pool.query(
        `INSERT INTO orders (table_id, table_number, restaurant_id, status)
         VALUES ($1, $2, $3, 'open') RETURNING id`,
        [t.id, tableNum, rId]
      );

      const dish = DISHES[i % DISHES.length];
      const { rows: [item] } = await pool.query(
        `INSERT INTO order_items (order_id, name, price, status)
         VALUES ($1, $2, $3, 'paid') RETURNING id`,
        [o.id, dish[0], dish[1]]
      );

      const hoursAgo = Math.floor(Math.random() * 8);
      await pool.query(
        `INSERT INTO payments (order_id, restaurant_id, amount_lei, tip_lei, paid_at)
         VALUES ($1, $2, $3, $4, NOW() - INTERVAL '${hoursAgo} hours')`,
        [o.id, rId, dish[1], Math.round(dish[1] * 0.1)]
      );
    }
    res.json({ ok: true, seeded: 20 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── QR code generator ────────────────────────────────────────────────────────

app.get('/qrcodes', async (req, res) => {
  const restaurantId = req.query.r || 1;
  const { rows: tables } = await pool.query(
    'SELECT number FROM tables WHERE restaurant_id = $1 ORDER BY number',
    [restaurantId]
  );
  const tableCount = tables.length || 8;
  const numbers    = tables.length ? tables.map(t => t.number) : Array.from({ length: tableCount }, (_, i) => i + 1);

  const qrs = await Promise.all(
    numbers.map(async n => ({
      n,
      svg: await QRCode.toString(`${APP_URL}/?t=${n}&r=${restaurantId}`, { type: 'svg', width: 200 }),
    }))
  );

  res.send(`<!DOCTYPE html>
<html lang="ro">
<head>
<meta charset="UTF-8">
<title>QR Coduri — nota.</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: sans-serif; background: #fafafa; padding: 2rem; }
  h1 { margin-bottom: 1.5rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, 200px); gap: 2rem; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1.25rem;
          display: flex; flex-direction: column; align-items: center; gap: .5rem; }
  .card h2 { margin: 0; font-size: 1rem; color: #374151; }
  .card svg { width: 160px; height: 160px; }
  @media print { body { padding: 0; } h1 { display: none; } }
</style>
</head>
<body>
<h1>QR Coduri Masă</h1>
<div class="grid">
${qrs.map(({ n, svg }) => `
  <div class="card">
    <h2>Masa ${n}</h2>
    ${svg}
    <small>${APP_URL}/?t=${n}&r=${restaurantId}</small>
  </div>`).join('')}
</div>
</body>
</html>`);
});

// ─── health ───────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({
  ok:     true,
  iiko:   !!(process.env.IIKO_API_LOGIN && process.env.IIKO_ORG_ID),
  mia:    !!(process.env.MIA_MERCHANT_ID && process.env.MIA_SECRET),
  db:     !!process.env.DATABASE_URL,
}));

// ─── Socket.io ────────────────────────────────────────────────────────────────

// In-memory maps for pending MIA payments
const pendingPayments = new Map(); // paymentId → socketId
const pendingTables   = new Map(); // paymentId → tableNumber
const pendingTips     = new Map(); // paymentId → tipLei

io.on('connection', socket => {
  let currentTable = null;

  socket.on('join-table', async ({ tableNumber, restaurantId }) => {
    currentTable = tableNumber;
    socket.join(`table-${tableNumber}`);
    try {
      const order = await getOpenOrder(tableNumber);
      socket.emit('order-update', order);
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('join-dashboard', ({ restaurantId } = {}) => {
    socket.join('dashboard');
  });

  // Guest claims items for payment
  socket.on('claim-items', async (itemIds, ack) => {
    try {
      // Atomic claim — only unclaimed items can be claimed
      const { rows: claimed } = await pool.query(`
        UPDATE order_items
        SET status = 'claimed', claimed_by = $1
        WHERE id = ANY($2) AND status = 'available'
        RETURNING id
      `, [socket.id, itemIds]);

      const contestedIds = itemIds.filter(id => !claimed.find(r => r.id === id));

      const order = await getOpenOrder(currentTable);
      io.to(`table-${currentTable}`).emit('order-update', order);

      ack?.({ claimed: claimed.map(r => r.id), contested: contestedIds, order });
    } catch (err) {
      ack?.({ error: err.message });
    }
  });

  // Guest releases their claims (navigated away / cancelled)
  socket.on('release-claims', async () => {
    try {
      await pool.query(`
        UPDATE order_items SET status = 'available', claimed_by = NULL
        WHERE claimed_by = $1 AND status = 'claimed'
      `, [socket.id]);
      if (currentTable) {
        const order = await getOpenOrder(currentTable);
        io.to(`table-${currentTable}`).emit('order-update', order);
      }
    } catch (err) {
      console.error('[release-claims]', err);
    }
  });

  // Guest taps pay via socket (alternative to REST /api/payment/initiate)
  socket.on('pay-claimed', async ({ tipLei, tableNumber, orderId, restaurantId }, ack) => {
    try {
      const order = await getOpenOrder(tableNumber || currentTable);
      const claimed = order.items.filter(it => it.claimed_by === socket.id && it.status === 'claimed');
      if (!claimed.length) return ack?.({ error: 'No claimed items' });

      const amountLei = claimed.reduce((s, it) => s + Number(it.price), 0);
      const payment   = await requestPayment({
        amountLei, tipLei, orderId: order.id,
        tableNumber: tableNumber || currentTable,
      });

      // Track for webhook matching
      pendingPayments.set(payment.paymentId, socket.id);
      pendingTables.set(payment.paymentId, tableNumber || currentTable);
      pendingTips.set(payment.paymentId, tipLei || 0);

      ack?.({ success: true, ...payment });

      // Mock: auto-complete after 2s
      if (payment._mock) {
        setTimeout(() => completePay(socket.id, tipLei || 0, tableNumber || currentTable), 2000);
      }
    } catch (err) {
      console.error('[pay-claimed]', err);
      ack?.({ error: err.message });
    }
  });

  // Release claims on disconnect
  socket.on('disconnect', async () => {
    try {
      await pool.query(`
        UPDATE order_items SET status = 'available', claimed_by = NULL
        WHERE claimed_by = $1 AND status = 'claimed'
      `, [socket.id]);
      if (currentTable) {
        const order = await getOpenOrder(currentTable);
        io.to(`table-${currentTable}`).emit('order-update', order);
      }
    } catch (err) {
      console.error('[disconnect cleanup]', err);
    }
  });
});

// ─── completePay helper ───────────────────────────────────────────────────────

async function completePay(socketId, tipLei, tableNumber, miaPaymentId = null) {
  const result = await payClaimedItems(socketId, tipLei);
  if (!result) return;

  // Attach mia_payment_id if we have it
  if (miaPaymentId) {
    await pool.query(
      'UPDATE payments SET mia_payment_id = $1 WHERE id = $2',
      [miaPaymentId, result.id]
    );
  }

  const order = await getOpenOrder(tableNumber);
  io.to(`table-${tableNumber}`).emit('order-update', order);
  io.to('dashboard').emit('payment-made', {
    id:           result.id,
    table_number: tableNumber,
    amount_lei:   result.amount_lei,
    tip_lei:      result.tip_lei,
    paid_at:      result.paid_at,
  });
}

// ─── poll payment status (fallback if webhook is slow) ───────────────────────

async function pollPaymentStatus(paymentId, socketId, tipLei, tableNumber, attempts = 0) {
  if (attempts > 20) return; // give up after ~60s
  setTimeout(async () => {
    try {
      const { status } = await getPaymentStatus(paymentId);
      if (status === 'PAID') {
        await completePay(socketId, tipLei, tableNumber, paymentId);
        pendingPayments.delete(paymentId);
        pendingTables.delete(paymentId);
        pendingTips.delete(paymentId);
      } else if (status === 'PENDING') {
        pollPaymentStatus(paymentId, socketId, tipLei, tableNumber, attempts + 1);
      }
      // EXPIRED / FAILED → stop polling, guest will see timeout
    } catch (err) {
      console.error('[poll]', err.message);
    }
  }, 3000);
}

// ─── start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n🍽  nota. server running on port ${PORT}`);
  console.log(`   App URL:  ${APP_URL}`);
  console.log(`   iiko:     ${process.env.IIKO_API_LOGIN ? '✅ LIVE' : '⚠️  mock'}`);
  console.log(`   MIA:      ${process.env.MIA_MERCHANT_ID ? '✅ LIVE' : '⚠️  mock'}`);
  console.log(`   DB:       ${process.env.DATABASE_URL ? '✅ connected' : '❌ DATABASE_URL missing'}`);
  console.log(`\n   Guest:     ${APP_URL}/?t=1`);
  console.log(`   Dashboard: ${APP_URL}/dashboard`);
  console.log(`   QR codes:  ${APP_URL}/qrcodes\n`);
});
