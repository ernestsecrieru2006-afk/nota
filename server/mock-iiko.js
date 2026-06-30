// MOCK — replace with real iiko integration later.
// Keep these function signatures the same so the swap is easy:
//   getOpenOrder(tableNumber)          → returns order + items, or null
//   addItem(tableNumber, name, price)  → adds a dish and returns it
//   markItemPaid(itemId, paidBy)       → marks one dish as paid
//   closeOrder(tableNumber)            → marks the whole order as closed

import pool from './db.js';

// ---------------------------------------------------------------------------
// SEED — called once on startup to make sure demo data exists.
// It won't create duplicates if you restart the server.
// ---------------------------------------------------------------------------

export async function seedDemoData() {
  // 1. Create restaurant if it doesn't exist yet.
  const { rows: existing } = await pool.query(
    `SELECT id FROM restaurants WHERE name = 'Carmelo' LIMIT 1`
  );

  let restaurantId;

  if (existing.length === 0) {
    const { rows } = await pool.query(
      `INSERT INTO restaurants (name, fiscal_code) VALUES ('Carmelo', '1234567890123') RETURNING id`
    );
    restaurantId = rows[0].id;
    console.log(`✓ Mock restaurant "Carmelo" created (id: ${restaurantId})`);

    // 2. Create 8 tables for Carmelo.
    for (let t = 1; t <= 8; t++) {
      await pool.query(
        `INSERT INTO tables (restaurant_id, table_number) VALUES ($1, $2)`,
        [restaurantId, t]
      );
    }
    console.log('✓ 8 tables created for Carmelo');
  } else {
    restaurantId = existing[0].id;
  }

  // 3. Put a sample open order on table 7 if none exists.
  const { rows: tableRows } = await pool.query(
    `SELECT id FROM tables WHERE restaurant_id = $1 AND table_number = 7`,
    [restaurantId]
  );
  const tableId = tableRows[0].id;

  const { rows: openOrders } = await pool.query(
    `SELECT id FROM orders WHERE table_id = $1 AND status = 'open' LIMIT 1`,
    [tableId]
  );

  if (openOrders.length === 0) {
    const { rows: orderRows } = await pool.query(
      `INSERT INTO orders (table_id, status) VALUES ($1, 'open') RETURNING id`,
      [tableId]
    );
    const orderId = orderRows[0].id;

    // Sample Italian dishes (name, price in MDL lei)
    const dishes = [
      ['Spaghetti alle vongole', 265],
      ['Burrata',                195],
      ['Branzino',               340],
      ['Vino rosso',              95],
    ];

    for (const [name, price] of dishes) {
      await pool.query(
        `INSERT INTO order_items (order_id, name, price_lei) VALUES ($1, $2, $3)`,
        [orderId, name, price]
      );
    }

    console.log('✓ Sample order seeded on table 7 (Spaghetti, Burrata, Branzino, Vino rosso)');
  }
}

// ---------------------------------------------------------------------------
// FUNCTIONS — these mirror what a real iiko integration would expose.
// ---------------------------------------------------------------------------

// Returns the open order for a table (with all its items), or null if none.
export async function getOpenOrder(tableNumber) {
  // Find the table row for the given number at any restaurant.
  // (For now there's only one restaurant, Carmelo.)
  const { rows: tableRows } = await pool.query(
    `SELECT t.id
     FROM tables t
     JOIN restaurants r ON r.id = t.restaurant_id
     WHERE t.table_number = $1
     LIMIT 1`,
    [tableNumber]
  );

  if (tableRows.length === 0) return null;

  const tableId = tableRows[0].id;

  // Find the open order for this table.
  const { rows: orderRows } = await pool.query(
    `SELECT * FROM orders WHERE table_id = $1 AND status = 'open' LIMIT 1`,
    [tableId]
  );

  if (orderRows.length === 0) return null;

  const order = orderRows[0];

  // Attach all items to the order object.
  const { rows: items } = await pool.query(
    `SELECT * FROM order_items WHERE order_id = $1 ORDER BY id`,
    [order.id]
  );

  return { ...order, items };
}

// Adds a new dish to table's open order. Creates an order if none is open.
export async function addItem(tableNumber, name, price) {
  let order = await getOpenOrder(tableNumber);

  // If no open order exists, create one.
  if (!order) {
    const { rows: tableRows } = await pool.query(
      `SELECT id FROM tables WHERE table_number = $1 LIMIT 1`,
      [tableNumber]
    );
    if (tableRows.length === 0) throw new Error(`Table ${tableNumber} not found`);

    const { rows: orderRows } = await pool.query(
      `INSERT INTO orders (table_id, status) VALUES ($1, 'open') RETURNING *`,
      [tableRows[0].id]
    );
    order = orderRows[0];
  }

  // Insert the item and return it.
  const { rows } = await pool.query(
    `INSERT INTO order_items (order_id, name, price_lei) VALUES ($1, $2, $3) RETURNING *`,
    [order.id, name, price]
  );

  return rows[0];
}

// Marks a single item as paid. paidBy is a string identifying the guest.
export async function markItemPaid(itemId, paidBy) {
  const { rows } = await pool.query(
    `UPDATE order_items
     SET status = 'paid', paid_by = $1
     WHERE id = $2
     RETURNING *`,
    [paidBy, itemId]
  );
  return rows[0] ?? null;
}

// Closes the order for a table (marks it as 'closed').
export async function closeOrder(tableNumber) {
  const order = await getOpenOrder(tableNumber);
  if (!order) return null;

  const { rows } = await pool.query(
    `UPDATE orders SET status = 'closed' WHERE id = $1 RETURNING *`,
    [order.id]
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// REAL-TIME CLAIM / PAY / RELEASE
// ---------------------------------------------------------------------------

// Atomically claims items for a socket session.
// If ANY item is already claimed/paid, rolls back all claims and returns
// the contested IDs so the caller knows exactly what failed.
export async function claimItems(socketId, itemIds) {
  const claimed   = [];
  const contested = [];

  for (const id of itemIds) {
    const { rowCount } = await pool.query(
      `UPDATE order_items
       SET status = 'claimed', claimed_by = $1, claimed_at = NOW()
       WHERE id = $2 AND status = 'available'`,
      [socketId, id]
    );
    if (rowCount > 0) claimed.push(id);
    else contested.push(id);
  }

  // Partial claim = no claim — roll back everything we just claimed.
  if (contested.length > 0 && claimed.length > 0) {
    await pool.query(
      `UPDATE order_items
       SET status = 'available', claimed_by = NULL, claimed_at = NULL
       WHERE id = ANY($1::int[]) AND claimed_by = $2`,
      [claimed, socketId]
    );
    return { claimed: [], contested };
  }

  return { claimed, contested };
}

// Marks all items claimed by this socket as paid and records the payment
// in the payments table for dashboard analytics.
export async function payClaimedItems(socketId, tipLei = 0) {
  const { rows: items } = await pool.query(
    `UPDATE order_items
     SET status = 'paid', paid_by = $1, paid_at = NOW()
     WHERE claimed_by = $1 AND status = 'claimed'
     RETURNING *`,
    [socketId]
  );

  if (items.length === 0) return { items, payment: null };

  const orderId = items[0].order_id;
  const total   = items.reduce((s, i) => s + parseFloat(i.price_lei), 0);

  const { rows: tbl } = await pool.query(
    `SELECT t.table_number FROM orders o
     JOIN tables t ON t.id = o.table_id WHERE o.id = $1`,
    [orderId]
  );

  let payment = null;
  if (tbl.length) {
    const { rows: pmt } = await pool.query(
      `INSERT INTO payments (order_id, table_number, amount_lei, tip_lei)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [orderId, tbl[0].table_number, total, tipLei]
    );
    payment = { ...pmt[0], tableNumber: tbl[0].table_number };
  }

  return { items, payment };
}

// Releases all claimed (but unpaid) items back to available.
export async function releaseItems(socketId) {
  await pool.query(
    `UPDATE order_items
     SET status = 'available', claimed_by = NULL, claimed_at = NULL
     WHERE claimed_by = $1 AND status = 'claimed'`,
    [socketId]
  );
}
