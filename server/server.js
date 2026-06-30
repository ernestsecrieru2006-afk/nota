import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import pool from './db.js';
import {
  seedDemoData,
  getOpenOrder,
  addItem,
  claimItems,
  payClaimedItems,
  releaseItems,
} from './mock-iiko.js';
import { requestPayment } from './mock-mia.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer);
const PORT       = process.env.PORT || 3000;

app.use(express.json());
// extensions: ['html'] lets /dashboard resolve to dashboard.html
app.use(express.static('public', { extensions: ['html'] }));

// ---------------------------------------------------------------------------
// REST — table data (guest app)
// ---------------------------------------------------------------------------

app.get('/api/table/:number', async (req, res) => {
  const tableNumber = parseInt(req.params.number);
  const order = await getOpenOrder(tableNumber);
  if (!order) return res.status(404).json({ error: `No open order for table ${tableNumber}` });
  res.json(order);
});

app.post('/api/table/:number/item', async (req, res) => {
  const tableNumber = parseInt(req.params.number);
  const { name, price } = req.body;
  if (!name || !price) {
    return res.status(400).json({ error: 'Request body must include "name" and "price"' });
  }
  const item = await addItem(tableNumber, name, price);
  // Notify guests who might be on the empty-table screen.
  const order = await getOpenOrder(tableNumber);
  io.to(`table:${tableNumber}`).emit('order-update', order);
  res.status(201).json(item);
});

// ---------------------------------------------------------------------------
// REST — health check (used by Railway / uptime monitors)
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// REST — MIA payment initiation
// When the real bank API is connected, this returns a deep-link URL that the
// client uses to redirect the customer into their banking app.
// ---------------------------------------------------------------------------

app.post('/api/payment/initiate', async (req, res) => {
  try {
    const { amountLei, socketId } = req.body;
    if (!amountLei || !socketId) {
      return res.status(400).json({ error: 'amountLei and socketId required' });
    }
    const result = await requestPayment({
      amountLei,
      reference:          socketId,
      merchantFiscalCode: process.env.FISCAL_CODE ?? '1234567890123',
      callbackUrl:        `${req.protocol}://${req.get('host')}/api/payment/webhook`,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Placeholder webhook — real MIA will POST here after customer confirms.
// See server/mock-mia.js for full instructions.
app.post('/api/payment/webhook', (_req, res) => {
  // TODO: verify signature, look up socketId by paymentId, emit pay-confirmed
  res.json({ received: true });
});

// ---------------------------------------------------------------------------
// REST — printable QR codes for all tables
// ---------------------------------------------------------------------------

app.get('/qrcodes', async (req, res) => {
  const base   = `${req.protocol}://${req.get('host')}`;
  const tables = Array.from({ length: 8 }, (_, i) => i + 1);

  const svgs = await Promise.all(
    tables.map(t =>
      QRCode.toString(`${base}/?t=${t}`, {
        type:   'svg',
        width:  180,
        margin: 2,
        color:  { dark: '#6B1A2D', light: '#F4EDE1' },
      })
    )
  );

  const cards = tables.map((t, i) => `
    <div class="qr-card">
      ${svgs[i]}
      <p class="table-name">Masa ${t}</p>
      <p class="table-url">${base}/?t=${t}</p>
    </div>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="UTF-8">
  <title>QR Codes — Carmelo · nota.</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Manrope:wght@500;700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Manrope', sans-serif; background: #F4EDE1; padding: 32px; color: #1C1008; }
    h1 { font-family: 'Fraunces', serif; font-size: 1.8rem; color: #6B1A2D; margin-bottom: 6px; }
    .subtitle { color: #9A8778; font-size: .85rem; margin-bottom: 28px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; }
    .qr-card { background: #fff; border-radius: 14px; padding: 18px; display: flex; flex-direction: column; align-items: center; gap: 10px; box-shadow: 0 2px 8px rgba(107,26,45,.1); page-break-inside: avoid; }
    .qr-card svg { width: 100%; height: auto; border-radius: 6px; }
    .table-name { font-family: 'Fraunces', serif; font-size: 1.1rem; font-weight: 700; color: #6B1A2D; }
    .table-url  { font-size: .62rem; color: #9A8778; word-break: break-all; text-align: center; }
    @media print {
      body { background: #fff; padding: 16px; }
      .grid { grid-template-columns: repeat(4, 1fr); gap: 12px; }
      .no-print { display: none; }
    }
    @media (max-width: 600px) { .grid { grid-template-columns: repeat(2, 1fr); } }
  </style>
</head>
<body>
  <h1>nota. — Carmelo · Ristorante</h1>
  <p class="subtitle">Coduri QR pentru toate mesele · <a href="#" onclick="window.print()" class="no-print" style="color:#B8893A">Imprimă →</a></p>
  <div class="grid">${cards}</div>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// REST — dashboard analytics
// ---------------------------------------------------------------------------

// "Today" is defined as the last 24 hours so timezone differences don't bite.
const WINDOW = `paid_at >= NOW() - INTERVAL '24 hours'`;

app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(SUM(amount_lei + tip_lei), 0)::float AS incasat,
        COUNT(*)::int                                  AS nr_plati,
        COALESCE(SUM(tip_lei), 0)::float               AS bacsisuri,
        COUNT(DISTINCT table_number)::int              AS mese
      FROM payments
      WHERE ${WINDOW}
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/top-dishes', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        name,
        COUNT(*)::int         AS cnt,
        SUM(price_lei)::float AS total_lei
      FROM order_items
      WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '24 hours'
      GROUP BY name
      ORDER BY cnt DESC, total_lei DESC
      LIMIT 5
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/hourly', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        EXTRACT(HOUR FROM paid_at AT TIME ZONE 'Europe/Chisinau')::int AS ora,
        COALESCE(SUM(amount_lei + tip_lei), 0)::float                  AS total
      FROM payments
      WHERE ${WINDOW}
      GROUP BY ora
      ORDER BY ora
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/recent', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, table_number, amount_lei::float, tip_lei::float, paid_at
      FROM payments
      ORDER BY paid_at DESC
      LIMIT 30
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dev-only: seed fake payments so the dashboard has data to show immediately.
app.post('/api/dev/seed-payments', async (req, res) => {
  try {
    const { rows: orders } = await pool.query(`SELECT id FROM orders LIMIT 1`);
    if (!orders.length) {
      return res.status(404).json({ error: 'No orders in database yet. Start the server first.' });
    }

    const orderId = orders[0].id;
    const now     = Date.now();

    const seeds = [
      { table: 3, amount: 265,  tip: 26.5, minsAgo: 420 },
      { table: 5, amount: 455,  tip: 0,    minsAgo: 340 },
      { table: 2, amount: 195,  tip: 20,   minsAgo: 260 },
      { table: 7, amount: 340,  tip: 34,   minsAgo: 180 },
      { table: 4, amount: 90,   tip: 0,    minsAgo: 110 },
      { table: 1, amount: 530,  tip: 53,   minsAgo: 55  },
      { table: 6, amount: 185,  tip: 18.5, minsAgo: 15  },
    ];

    for (const s of seeds) {
      // Use NOW() on the DB side so the timestamp is correct regardless of
      // differences between the app server clock and DB server timezone.
      await pool.query(
        `INSERT INTO payments (order_id, table_number, amount_lei, tip_lei, paid_at)
         VALUES ($1, $2, $3, $4, NOW() - ($5 || ' minutes')::interval)`,
        [orderId, s.table, s.amount, s.tip, s.minsAgo]
      );
    }

    // Reset all items in the demo order, then mark some as paid with recent
    // timestamps so "Top preparate" has data immediately.
    await pool.query(
      `UPDATE order_items
       SET status = 'available', paid_by = NULL, paid_at = NULL,
           claimed_by = NULL, claimed_at = NULL
       WHERE order_id = $1`,
      [orderId]
    );

    const dishSeeds = [
      ['Spaghetti alle vongole', 200],
      ['Burrata',                100],
      ['Branzino',               150],
      ['Vino rosso',              50],
    ];
    for (const [name, minsAgo] of dishSeeds) {
      await pool.query(
        `UPDATE order_items
         SET status = 'paid', paid_by = 'seed',
             paid_at = NOW() - ($3 || ' minutes')::interval
         WHERE id = (
           SELECT id FROM order_items
           WHERE order_id = $1 AND name = $2
           LIMIT 1
         )`,
        [orderId, name, minsAgo]
      );
    }

    res.json({ seeded: seeds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// SOCKET.IO — all mutations go through here
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  console.log(`+ ${socket.id}`);

  // Guest opens /?t=7 → joins the room for that table.
  socket.on('join-table', (tableNumber) => {
    socket.join(`table:${tableNumber}`);
    socket.data.tableNumber = tableNumber;
    console.log(`  ${socket.id} → table:${tableNumber}`);
  });

  // Dashboard owner → joins the dashboard broadcast room.
  socket.on('join-dashboard', () => {
    socket.join('dashboard');
    socket.data.isDashboard = true;
    console.log(`  ${socket.id} → dashboard`);
  });

  // Guest taps "Continuă" — attempt atomic claim on each selected item.
  socket.on('claim-items', async (itemIds, ack) => {
    const { tableNumber } = socket.data;
    if (!tableNumber || !Array.isArray(itemIds)) {
      return ack({ claimed: [], contested: itemIds ?? [], order: null });
    }

    const result = await claimItems(socket.id, itemIds);
    const order  = await getOpenOrder(tableNumber);

    io.to(`table:${tableNumber}`).emit('order-update', order);
    ack({ ...result, order });
  });

  // Guest confirmed MIA payment — mark their claimed items as paid.
  socket.on('pay-claimed', async ({ tipLei = 0 } = {}, ack) => {
    const { tableNumber } = socket.data;
    if (!tableNumber) return ack({ success: false });

    const { payment } = await payClaimedItems(socket.id, tipLei);
    const order = await getOpenOrder(tableNumber);

    io.to(`table:${tableNumber}`).emit('order-update', order);

    // Notify the dashboard about this payment in real-time.
    if (payment) {
      io.to('dashboard').emit('payment-made', {
        id:          payment.id,
        table_number: payment.tableNumber,
        amount_lei:  parseFloat(payment.amount_lei),
        tip_lei:     parseFloat(payment.tip_lei),
        paid_at:     payment.paid_at,
      });
    }

    ack({ success: true });
  });

  // Guest went back from payment screen — release their claims.
  socket.on('release-claims', async () => {
    const { tableNumber } = socket.data;
    await releaseItems(socket.id);
    if (tableNumber) {
      const order = await getOpenOrder(tableNumber);
      io.to(`table:${tableNumber}`).emit('order-update', order);
    }
  });

  // Browser closed or connection dropped — release claims automatically.
  socket.on('disconnect', async () => {
    const { tableNumber } = socket.data;
    if (!tableNumber) return;

    await releaseItems(socket.id);
    const order = await getOpenOrder(tableNumber);
    io.to(`table:${tableNumber}`).emit('order-update', order);
    console.log(`- ${socket.id} (table:${tableNumber}, claims released)`);
  });
});

// ---------------------------------------------------------------------------
// CLAIM EXPIRY — scan every 30 s, release anything older than 2 minutes
// ---------------------------------------------------------------------------

setInterval(async () => {
  try {
    const { rows } = await pool.query(`
      UPDATE order_items
      SET status = 'available', claimed_by = NULL, claimed_at = NULL
      WHERE status = 'claimed' AND claimed_at < NOW() - INTERVAL '2 minutes'
      RETURNING order_id
    `);

    if (!rows.length) return;

    const orderIds = [...new Set(rows.map(r => r.order_id))];
    for (const oid of orderIds) {
      const { rows: tbl } = await pool.query(`
        SELECT t.table_number FROM orders o
        JOIN tables t ON t.id = o.table_id WHERE o.id = $1
      `, [oid]);

      if (tbl.length) {
        const n     = tbl[0].table_number;
        const order = await getOpenOrder(n);
        io.to(`table:${n}`).emit('order-update', order);
        console.log(`Expired claims released on table ${n}`);
      }
    }
  } catch (err) {
    console.error('Claim expiry error:', err.message);
  }
}, 30_000);

// ---------------------------------------------------------------------------
// STARTUP
// ---------------------------------------------------------------------------

httpServer.listen(PORT, async () => {
  console.log(`nota. is running at http://localhost:${PORT}`);
  await seedDemoData();
});
