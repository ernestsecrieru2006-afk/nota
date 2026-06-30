/**
 * iiko.js — Real iiko Cloud API integration for nota.
 *
 * Set in .env to go live:
 *   IIKO_API_LOGIN=your-api-login          (from iiko back-office → Settings → API)
 *   IIKO_BASE_URL=https://api-ru.iiko.services   (or your regional endpoint)
 *   IIKO_ORG_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  (your organization UUID)
 *
 * Without those vars the module falls back to the local Postgres mock automatically.
 */

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── iiko token cache (tokens live ~60 min) ───────────────────────────────────
let _token = null;
let _tokenExpiresAt = 0;

const IIKO_BASE = (process.env.IIKO_BASE_URL || 'https://api-ru.iiko.services').replace(/\/$/, '');
const IIKO_ORG  = process.env.IIKO_ORG_ID   || null;
const LIVE      = !!(process.env.IIKO_API_LOGIN && IIKO_ORG);

async function getToken() {
  if (!LIVE) return null;
  if (_token && Date.now() < _tokenExpiresAt) return _token;

  const res = await fetch(`${IIKO_BASE}/api/1/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiLogin: process.env.IIKO_API_LOGIN }),
  });
  if (!res.ok) throw new Error(`iiko auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  _token = data.token;
  _tokenExpiresAt = Date.now() + 55 * 60 * 1000; // refresh 5 min early
  return _token;
}

async function iikoPost(path, body) {
  const token = await getToken();
  const res = await fetch(`${IIKO_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`iiko ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Map an iiko order to our internal format so the rest of the server
 * doesn't need to know whether data came from iiko or Postgres.
 */
function normalizeIikoOrder(iikoOrder, tableNumber) {
  const items = (iikoOrder.items || []).map(it => ({
    id:     it.positionId || it.id,
    name:   it.product?.name || it.name || 'Dish',
    price:  it.price || 0,
    status: it.status === 'Added' ? 'available'
          : it.status === 'Deleted' ? 'cancelled'
          : 'available',
    claimed_by: null,
  }));
  return {
    id:           iikoOrder.id,
    table_number: tableNumber,
    status:       'open',
    items,
    _source:      'iiko',
  };
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * getOpenOrder(tableNumber)
 * Returns the current open order for a table.
 * Falls back to Postgres mock if iiko is not configured.
 */
export async function getOpenOrder(tableNumber) {
  if (LIVE) {
    // 1. Fetch tables for the org to find the iiko tableId for this tableNumber
    const tablesData = await iikoPost('/api/1/reserve/available_restaurant_sections', {
      organizationIds: [IIKO_ORG],
    });

    // Find matching table by number — iiko tables have a `number` field
    let iikoTableId = null;
    for (const section of (tablesData.restaurantSections || [])) {
      for (const table of (section.tables || [])) {
        if (String(table.number) === String(tableNumber)) {
          iikoTableId = table.id;
          break;
        }
      }
      if (iikoTableId) break;
    }

    if (!iikoTableId) {
      console.warn(`[iiko] No table found for number ${tableNumber}, falling back to mock`);
      return getOpenOrderMock(tableNumber);
    }

    // 2. Get open orders for that table
    const ordersData = await iikoPost('/api/1/table_orders/by_table', {
      organizationId: IIKO_ORG,
      tableIds:       [iikoTableId],
      statuses:       ['New', 'Bill', 'Closed'],
    });

    const openOrder = (ordersData.tableOrders || []).find(o =>
      o.status === 'New' || o.status === 'Bill'
    );

    if (!openOrder) {
      // No open order in iiko — return an empty order shell
      return { id: null, table_number: tableNumber, status: 'open', items: [] };
    }

    return normalizeIikoOrder(openOrder, tableNumber);
  }

  return getOpenOrderMock(tableNumber);
}

/**
 * addItem(tableNumber, name, price)
 * Adds a dish to the open order (used by the demo seed endpoint).
 * In production iiko, the waiter adds items via iikoFront — we just read them.
 */
export async function addItem(tableNumber, name, price) {
  if (LIVE) {
    // In a real deployment the waiter adds items from iikoFront.
    // This function is only called by /api/dev/seed which is dev-only.
    // If you need to add items via API call iikoPost('/api/1/order/add_items', {...})
    console.info('[iiko] addItem called — in production items are added via iikoFront');
    return;
  }
  return addItemMock(tableNumber, name, price);
}

/**
 * payClaimedItems(socketId, tipLei, restaurantId)
 * Marks claimed items as paid in our DB and (if live) records payment in iiko.
 *
 * NOTE: Fiscal receipt creation requires an iikoFront terminal plugin.
 * Without a plugin we record the payment in our DB only and pass an
 * "external payment" marker to iiko so the cashier can reconcile later.
 * When you get the plugin or confirm fiscal via Cloud API, swap in:
 *   POST /api/1/table_orders/{id}/close  with paymentItems[]
 */
export async function payClaimedItems(socketId, tipLei, restaurantId) {
  // Always record in our Postgres first (source of truth for nota. dashboard)
  const result = await payClaimedItemsMock(socketId, tipLei, restaurantId);

  if (LIVE && result) {
    try {
      // Notify iiko that an external payment was made so the order can be reconciled
      // Requires: IIKO_EXTERNAL_PAYMENT_TYPE_ID set in .env (get from iiko back-office)
      if (process.env.IIKO_EXTERNAL_PAYMENT_TYPE_ID) {
        const order = await getOpenOrder(result.table_number);
        if (order.id && order._source === 'iiko') {
          await iikoPost('/api/1/table_orders/change_payments', {
            organizationId: IIKO_ORG,
            tableOrderId:   order.id,
            payments: [{
              paymentTypeKind:   'External',
              paymentTypeId:     process.env.IIKO_EXTERNAL_PAYMENT_TYPE_ID,
              sum:               result.amount_lei + (tipLei || 0),
              isProcessedExternally: true,
            }],
          });
        }
      }
    } catch (err) {
      // Don't fail the payment just because iiko sync failed — log and continue
      console.error('[iiko] Failed to sync payment to iiko:', err.message);
    }
  }

  return result;
}

// ─── iiko webhook handler ─────────────────────────────────────────────────────

/**
 * handleIikoWebhook(payload)
 * Called by POST /api/iiko/webhook.
 * iiko sends order-update events here when a waiter adds/removes items.
 * We refresh our local order cache and emit a socket update.
 *
 * Register your webhook URL in iiko back-office:
 *   Settings → Notifications → Webhook → URL: https://your-app.up.railway.app/api/iiko/webhook
 */
export async function parseIikoWebhook(payload) {
  // iiko sends { eventType, organizationId, correlationId, tableOrders: [...] }
  const orders = payload.tableOrders || payload.orders || [];
  return orders.map(o => ({
    iikoOrderId:  o.id,
    tableNumber:  o.table?.number,
    status:       o.status,
    items:        (o.items || []).map(it => ({
      id:    it.positionId || it.id,
      name:  it.product?.name || it.name,
      price: it.price || 0,
      status: 'available',
    })),
  }));
}

// ─── Postgres mock (used when IIKO_API_LOGIN / IIKO_ORG_ID not set) ───────────

async function getOpenOrderMock(tableNumber) {
  const { rows: orders } = await pool.query(
    `SELECT o.id, o.table_number, o.status
     FROM orders o
     JOIN tables t ON t.id = o.table_id
     WHERE t.number = $1 AND o.status = 'open'
     ORDER BY o.created_at DESC LIMIT 1`,
    [tableNumber]
  );
  if (!orders.length) return { id: null, table_number: tableNumber, status: 'open', items: [] };

  const order = orders[0];
  const { rows: items } = await pool.query(
    `SELECT id, name, price, status, claimed_by
     FROM order_items WHERE order_id = $1 ORDER BY id`,
    [order.id]
  );
  return { ...order, items };
}

async function addItemMock(tableNumber, name, price) {
  const { rows: tableRows } = await pool.query(
    `SELECT t.id, o.id AS order_id
     FROM tables t
     LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'open'
     WHERE t.number = $1
     ORDER BY o.created_at DESC LIMIT 1`,
    [tableNumber]
  );
  if (!tableRows.length) throw new Error(`Table ${tableNumber} not found`);

  let { id: tableId, order_id } = tableRows[0];
  if (!order_id) {
    const { rows } = await pool.query(
      `INSERT INTO orders (table_id, status) VALUES ($1, 'open') RETURNING id`,
      [tableId]
    );
    order_id = rows[0].id;
  }
  await pool.query(
    `INSERT INTO order_items (order_id, name, price, status) VALUES ($1, $2, $3, 'available')`,
    [order_id, name, price]
  );
}

async function payClaimedItemsMock(socketId, tipLei, restaurantId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: claimed } = await client.query(
      `SELECT oi.id, oi.order_id, oi.price, o.table_number
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.claimed_by = $1 AND oi.status = 'claimed'
       FOR UPDATE`,
      [socketId]
    );
    if (!claimed.length) { await client.query('ROLLBACK'); return null; }

    const orderId      = claimed[0].order_id;
    const tableNumber  = claimed[0].table_number;
    const amountLei    = claimed.reduce((s, r) => s + Number(r.price), 0);
    const itemIds      = claimed.map(r => r.id);

    await client.query(
      `UPDATE order_items SET status = 'paid', claimed_by = NULL
       WHERE id = ANY($1)`,
      [itemIds]
    );

    const { rows: [payment] } = await client.query(
      `INSERT INTO payments (order_id, amount_lei, tip_lei, paid_at)
       VALUES ($1, $2, $3, NOW()) RETURNING *`,
      [orderId, amountLei, tipLei || 0]
    );

    await client.query('COMMIT');
    return { ...payment, table_number: tableNumber };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
