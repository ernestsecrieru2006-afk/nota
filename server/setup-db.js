/**
 * setup-db.js — Create / migrate the nota. database schema.
 *
 * Run once:  node server/setup-db.js
 * Safe to re-run — uses CREATE TABLE IF NOT EXISTS.
 *
 * Schema overview:
 *   restaurants   → one row per business (Carmelo, Cricova, etc.)
 *   tables        → physical tables (1–N per restaurant)
 *   orders        → one open session per table at a time
 *   order_items   → dishes: available → claimed → paid
 *   payments      → one row per payment tap
 */

import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function setup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── restaurants ──────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS restaurants (
        id            SERIAL PRIMARY KEY,
        name          TEXT        NOT NULL,
        email         TEXT        NOT NULL UNIQUE,
        password_hash TEXT        NOT NULL,
        table_count   INT         NOT NULL DEFAULT 8,
        iiko_url      TEXT,
        iiko_api_key  TEXT,
        iiko_org_id   TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── tables ───────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tables (
        id            SERIAL PRIMARY KEY,
        restaurant_id INT         NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
        number        INT         NOT NULL,
        label         TEXT,                          -- e.g. "Terasă 3"
        UNIQUE (restaurant_id, number)
      )
    `);

    // ── orders ───────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id            SERIAL PRIMARY KEY,
        table_id      INT         NOT NULL REFERENCES tables(id),
        table_number  INT         NOT NULL,
        restaurant_id INT         NOT NULL REFERENCES restaurants(id),
        status        TEXT        NOT NULL DEFAULT 'open',   -- open | closed
        iiko_order_id TEXT,                                  -- set when LIVE
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── order_items ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id         SERIAL PRIMARY KEY,
        order_id   INT          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        name       TEXT         NOT NULL,
        price      NUMERIC(8,2) NOT NULL,
        status     TEXT         NOT NULL DEFAULT 'available', -- available | claimed | paid
        claimed_by TEXT,                                      -- socket.id
        iiko_item_id TEXT                                     -- positionId from iiko
      )
    `);

    // ── payments ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id            SERIAL PRIMARY KEY,
        order_id      INT          NOT NULL REFERENCES orders(id),
        restaurant_id INT          REFERENCES restaurants(id),
        amount_lei    NUMERIC(8,2) NOT NULL,
        tip_lei       NUMERIC(8,2) NOT NULL DEFAULT 0,
        mia_payment_id TEXT,                                  -- set when MIA LIVE
        paid_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    // ── useful indexes ────────────────────────────────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_table_status
        ON orders(table_id, status);

      CREATE INDEX IF NOT EXISTS idx_order_items_order
        ON order_items(order_id);

      CREATE INDEX IF NOT EXISTS idx_order_items_claimed_by
        ON order_items(claimed_by) WHERE claimed_by IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_payments_restaurant
        ON payments(restaurant_id, paid_at);
    `);

    // ── add restaurant_id / table_number to existing tables if upgrading ─────
    // (safe no-ops if columns already exist)
    try {
      await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS restaurant_id INT REFERENCES restaurants(id)`);
      await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_number INT`);
      await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS restaurant_id INT REFERENCES restaurants(id)`);
      await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS mia_payment_id TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS iiko_url TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS iiko_api_key TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS iiko_org_id TEXT`);
    } catch {
      // columns may already exist — fine
    }

    await client.query('COMMIT');
    console.log('✅ Database schema ready.');

    // ── seed a demo restaurant if none exist ─────────────────────────────────
    const { rows } = await client.query('SELECT COUNT(*) AS n FROM restaurants');
    if (Number(rows[0].n) === 0) {
      console.log('Seeding demo restaurant (Carmelo)...');
      const crypto = await import('crypto');
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await new Promise((res, rej) =>
        crypto.pbkdf2('demo1234', salt, 100_000, 32, 'sha256',
          (e, k) => e ? rej(e) : res(`${salt}:${k.toString('hex')}`)
        )
      );
      const { rows: [r] } = await client.query(
        `INSERT INTO restaurants (name, email, password_hash, table_count)
         VALUES ('Carmelo Ristorante', 'demo@carmelo.md', $1, 8) RETURNING id`,
        [hash]
      );
      for (let i = 1; i <= 8; i++) {
        const { rows: [t] } = await client.query(
          'INSERT INTO tables (restaurant_id, number) VALUES ($1, $2) RETURNING id',
          [r.id, i]
        );
        await client.query(
          `INSERT INTO orders (table_id, table_number, restaurant_id, status)
           VALUES ($1, $2, $3, 'open') RETURNING id`,
          [t.id, i, r.id]
        );
      }
      console.log('✅ Demo restaurant created. Login: demo@carmelo.md / demo1234');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Setup failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

setup();
