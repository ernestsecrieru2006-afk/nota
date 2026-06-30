-- schema.sql — defines all the tables nota. uses in PostgreSQL.
-- Run this once to set up the database before starting the server.
-- "IF NOT EXISTS" means it's safe to run again — it won't wipe your data.

-- One row per restaurant using nota.
CREATE TABLE IF NOT EXISTS restaurants (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  fiscal_code TEXT NOT NULL  -- Moldova fiscal ID (IDNO)
);

-- One row per physical table in a restaurant.
CREATE TABLE IF NOT EXISTS tables (
  id            SERIAL PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  table_number  INTEGER NOT NULL
);

-- One row per dining session at a table.
-- status: 'open' means guests are still there, 'closed' means fully paid.
CREATE TABLE IF NOT EXISTS orders (
  id         SERIAL PRIMARY KEY,
  table_id   INTEGER NOT NULL REFERENCES tables(id),
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One row per dish/drink on an order.
-- status progression: 'available' → 'claimed' → 'paid'
--   available  = nobody has claimed it yet
--   claimed    = a guest said "I'll pay for this" but hasn't paid yet
--   paid       = payment confirmed
CREATE TABLE IF NOT EXISTS order_items (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  name        TEXT NOT NULL,
  price_lei   NUMERIC(10, 2) NOT NULL,  -- price in Moldovan Lei
  status      TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'claimed', 'paid')),
  claimed_by  TEXT,        -- identifier of the guest who claimed it
  claimed_at  TIMESTAMP,
  paid_by     TEXT,        -- identifier of the guest who paid
  paid_at     TIMESTAMP    -- when payment was confirmed
);

-- Run-safe migration: add paid_at if table already exists without it.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP;

-- One row per completed payment session (one per "Confirmă plata" tap).
-- Stores the base amount plus optional tip for dashboard analytics.
CREATE TABLE IF NOT EXISTS payments (
  id           SERIAL PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id),
  table_number INTEGER NOT NULL,
  amount_lei   NUMERIC(10, 2) NOT NULL,
  tip_lei      NUMERIC(10, 2) NOT NULL DEFAULT 0,
  paid_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
