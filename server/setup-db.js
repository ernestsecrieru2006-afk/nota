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
        token         VARCHAR(20) UNIQUE,            -- unguessable URL slug for guest QR
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
        id             SERIAL PRIMARY KEY,
        order_id       INT          NOT NULL REFERENCES orders(id),
        restaurant_id  INT          REFERENCES restaurants(id),
        amount_lei     NUMERIC(8,2) NOT NULL,
        tip_lei        NUMERIC(8,2) NOT NULL DEFAULT 0,
        status         VARCHAR(20)  NOT NULL DEFAULT 'paid',
        mode           VARCHAR(20)  NOT NULL DEFAULT 'claimed',
        socket_id      TEXT,
        mia_payment_id TEXT,
        paid_at        TIMESTAMPTZ
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

    // ── add token column if upgrading from schema without it ─────────────────
    try {
      await client.query(`ALTER TABLE tables ADD COLUMN IF NOT EXISTS token VARCHAR(20) UNIQUE`);
    } catch { /* already exists */ }

    // ── upgrade payments table for provider-confirmed settlement ─────────────
    // status: pending → paid/failed/expired/cancelled/duplicate
    // mode: claimed (item-level) | flat (split/rest)
    // socket_id: who initiated the payment (for routing confirmation events)
    // paid_at: NULL until MIA confirms; set at settlement time
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'paid'`);
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS mode VARCHAR(20) NOT NULL DEFAULT 'claimed'`);
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS socket_id TEXT`);
    // Make paid_at nullable — pending records have NULL until settlement
    try { await client.query(`ALTER TABLE payments ALTER COLUMN paid_at DROP NOT NULL`); } catch {}
    try { await client.query(`ALTER TABLE payments ALTER COLUMN paid_at DROP DEFAULT`);  } catch {}

    // ── add restaurant_id / table_number to existing tables if upgrading ─────
    // (safe no-ops if columns already exist)
    try {
      await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS restaurant_id INT REFERENCES restaurants(id)`);
      await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_number INT`);
      await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS restaurant_id INT REFERENCES restaurants(id)`);
      await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS mia_payment_id TEXT`);
      // mia_pay_id: maib's real payId (only exists once a QR is paid) — needed for refunds,
      // separate from mia_payment_id which holds our correlation key (the qrId).
      await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS mia_pay_id TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS iiko_url TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS iiko_api_key TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS iiko_org_id TEXT`);
    } catch {
      // columns may already exist — fine
    }

    // ── Club Eats v1: offers + payment attribution ────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS offers (
        id             SERIAL       PRIMARY KEY,
        restaurant_id  INT          NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
        name           TEXT         NOT NULL,
        discount_pct   SMALLINT     NOT NULL CHECK (discount_pct BETWEEN 1 AND 50),
        days_of_week   SMALLINT[]   NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
        start_time     TIME         NOT NULL,
        end_time       TIME         NOT NULL,
        active         BOOLEAN      NOT NULL DEFAULT true,
        public_visible BOOLEAN      NOT NULL DEFAULT true,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    try {
      await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS offer_id     INT REFERENCES offers(id)`);
      await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS gross_lei    NUMERIC(8,2)`);
      await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS discount_lei NUMERIC(8,2) NOT NULL DEFAULT 0`);
      await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS device_id    TEXT`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_restaurant ON offers(restaurant_id, active)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_device   ON payments(restaurant_id, device_id) WHERE device_id IS NOT NULL`);
    } catch { /* columns/indexes may already exist */ }

    // ── Club Eats v2: members + member-gated offers ───────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS members (
        id            SERIAL       PRIMARY KEY,
        email         TEXT         NOT NULL UNIQUE,
        password_hash TEXT         NOT NULL,
        plan          TEXT         NOT NULL DEFAULT 'free',
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    try {
      await client.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS member_only    BOOLEAN NOT NULL DEFAULT true`);
      await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS member_id    INT REFERENCES members(id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_member ON payments(restaurant_id, member_id) WHERE member_id IS NOT NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_members_email   ON members(email)`);
    } catch { /* already exist */ }

    // ── Growth: referral loop ─────────────────────────────────────────────────
    try {
      await client.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS referral_code VARCHAR(8) UNIQUE`);
      await client.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS referred_by   INT REFERENCES members(id)`);
      await client.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS bonus_pct     SMALLINT NOT NULL DEFAULT 0`);
      await client.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS bonus_expires TIMESTAMPTZ`);
    } catch { /* already exist */ }

    await client.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id           SERIAL       PRIMARY KEY,
        referrer_id  INT          NOT NULL REFERENCES members(id),
        referred_id  INT          NOT NULL REFERENCES members(id) UNIQUE,
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        converted    BOOLEAN      NOT NULL DEFAULT false,
        converted_at TIMESTAMPTZ
      )
    `);

    // ── Growth: AI promo-kit generator ────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS promo_kit_cache (
        offer_id      INT          PRIMARY KEY REFERENCES offers(id) ON DELETE CASCADE,
        restaurant_id INT          NOT NULL REFERENCES restaurants(id),
        ro_caption    TEXT         NOT NULL,
        ru_caption    TEXT         NOT NULL,
        ro_short      TEXT         NOT NULL,
        ru_short      TEXT         NOT NULL,
        ai_used       BOOLEAN      NOT NULL DEFAULT false,
        generated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS promo_kit_log (
        id            SERIAL       PRIMARY KEY,
        restaurant_id INT          NOT NULL REFERENCES restaurants(id),
        offer_id      INT          REFERENCES offers(id),
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    try {
      await client.query(`CREATE INDEX IF NOT EXISTS idx_promo_kit_log_rest_date ON promo_kit_log(restaurant_id, created_at)`);
    } catch {}

    // ── Post-payment intelligence: feedback + Google-review nudge ─────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS feedback (
        id            SERIAL       PRIMARY KEY,
        restaurant_id INT          NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
        order_id      INT          REFERENCES orders(id),
        payment_id    INT          REFERENCES payments(id),
        rating        SMALLINT     NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment       TEXT,
        nudge_shown   BOOLEAN      NOT NULL DEFAULT false,
        nudge_tapped  BOOLEAN      NOT NULL DEFAULT false,
        member_id     INT          REFERENCES members(id),
        device_id     TEXT,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    try {
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS google_review_url TEXT`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_feedback_restaurant ON feedback(restaurant_id, created_at)`);
    } catch { /* already exist */ }

    // ── Service recovery: optional guest email on low ratings + one-tap owner reply ──────────
    try {
      await client.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS guest_email TEXT`);
      await client.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ`);
    } catch { /* already exist */ }

    // ── Menu: in-QR restaurant menu (choice screen + browsing) ───────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS menu_categories (
        id            SERIAL       PRIMARY KEY,
        restaurant_id INT          NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
        name_ro       TEXT         NOT NULL,
        name_ru       TEXT,
        sort_order    INT          NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS menu_items (
        id             SERIAL       PRIMARY KEY,
        category_id    INT          NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
        restaurant_id  INT          NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
        name_ro        TEXT         NOT NULL,
        name_ru        TEXT,
        description_ro TEXT,
        description_ru TEXT,
        price          NUMERIC(8,2) NOT NULL,
        available      BOOLEAN      NOT NULL DEFAULT true,
        photo_url      TEXT,
        sort_order     INT          NOT NULL DEFAULT 0,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    try {
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS menu_published BOOLEAN NOT NULL DEFAULT false`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_menu_categories_restaurant ON menu_categories(restaurant_id, sort_order)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_menu_items_category   ON menu_items(category_id, sort_order)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant ON menu_items(restaurant_id)`);
    } catch { /* already exist */ }

    // ── Self-serve onboarding wizard ──────────────────────────────────────────
    // onboarding_step: which step to resume at (1-6). onboarding_complete: whether
    // they've reached "Gata" — drives whether the dashboard shows the setup banner.
    // menu_skipped / qr_downloaded: explicit user choices, distinct from "hasn't gotten there yet".
    try {
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS address TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS city TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS phone TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Europe/Chisinau'`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS logo_url TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS opening_hours JSONB`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS onboarding_step INT NOT NULL DEFAULT 1`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN NOT NULL DEFAULT false`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS menu_skipped BOOLEAN NOT NULL DEFAULT false`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS qr_downloaded BOOLEAN NOT NULL DEFAULT false`);
    } catch { /* already exist */ }

    // ── Per-restaurant maib MIA credentials (encrypted at rest, tenant-scoped) ──
    // maib_status: not_started | in_progress | active — explicitly tracked, never inferred,
    // so a restaurant is only ever taken out of demo mode by a deliberate status change.
    try {
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS maib_client_id TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS maib_client_secret_enc TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS maib_signature_key_enc TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS maib_env TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS maib_status TEXT NOT NULL DEFAULT 'not_started'`);
    } catch { /* already exist */ }

    // ── Premium menu: images, dietary tags, featured items, presentation style ──
    // menu_images holds either DB-stored bytes (full_data/thumb_data) or, when an S3-compatible
    // backend is configured, just the public URLs (full_url/thumb_url) — see server/storage.js.
    // Exactly one of the two pairs is populated per row, decided at upload time by IMAGE_STORAGE.
    await client.query(`
      CREATE TABLE IF NOT EXISTS menu_images (
        id            SERIAL       PRIMARY KEY,
        restaurant_id INT          NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
        mime_type     TEXT         NOT NULL,
        full_data     BYTEA,
        thumb_data    BYTEA,
        full_url      TEXT,
        thumb_url     TEXT,
        width         INT,
        height        INT,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    try {
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS menu_style TEXT NOT NULL DEFAULT 'elegant'`); // 'elegant' | 'vizual'
      await client.query(`ALTER TABLE menu_categories ADD COLUMN IF NOT EXISTS hero_image_id INT REFERENCES menu_images(id) ON DELETE SET NULL`);
      await client.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS photo_id INT REFERENCES menu_images(id) ON DELETE SET NULL`);
      await client.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS dietary_tags TEXT[] NOT NULL DEFAULT '{}'`); // vegetarian|vegan|gluten_free|spicy
      await client.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT false`); // "recomandarea casei"
      await client.query(`CREATE INDEX IF NOT EXISTS idx_menu_images_restaurant ON menu_images(restaurant_id)`);
    } catch { /* already exist */ }

    // ── Club Eats PWA: restaurant cover photo for the photo-first partner feed ──
    try {
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS cover_image_id INT REFERENCES menu_images(id) ON DELETE SET NULL`);
    } catch { /* already exists */ }

    // ── Staff access (floor-staff notification domain — separate auth from owner/member) ──
    // One active link per restaurant at a time (partial unique index below). Regenerate/revoke
    // always deactivate the current row rather than updating it in place, so a JWT's embedded
    // linkId can never point at a row that silently got new credentials underneath it.
    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_access_links (
        id            SERIAL       PRIMARY KEY,
        restaurant_id INT          NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
        link_token    VARCHAR(64)  NOT NULL UNIQUE,
        pin_hash      TEXT         NOT NULL,
        active        BOOLEAN      NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        revoked_at    TIMESTAMPTZ
      )
    `);
    try {
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_links_active_restaurant ON staff_access_links(restaurant_id) WHERE active`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_staff_links_token ON staff_access_links(link_token) WHERE active`);
    } catch { /* already exist */ }

    // ── Telegram notifications (optional per-restaurant channel; bot token encrypted at rest) ──
    try {
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS telegram_bot_token_enc TEXT`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT`);
    } catch { /* already exist */ }

    // ── Card-free repeat-visit loyalty (one simple rule per restaurant) ──────────────────────
    // loyalty_mode: 'every_nth' (every Nth visit gets X% off) | 'visits_30d' (X% off once N
    // visits have happened in a rolling 30 days, standing until the count drops back below N).
    // Applied automatically at payment via the same member_id/device_id identity payments
    // already carry — no cards, no codes, no extra guest steps.
    try {
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS loyalty_enabled BOOLEAN NOT NULL DEFAULT false`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS loyalty_mode TEXT NOT NULL DEFAULT 'every_nth'`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS loyalty_n SMALLINT NOT NULL DEFAULT 5`);
      await client.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS loyalty_pct SMALLINT NOT NULL DEFAULT 10`);
    } catch { /* already exist */ }

    // ── Hot-path index audit (see EXPLAIN findings in the accompanying report) ──────────────
    try {
      // tables.token is the single hottest lookup in the product (every QR scan, socket join,
      // menu load, bill render) — it already gets a unique index for free via the column's
      // UNIQUE constraint above, but that constraint has gone through try/catch'd ALTERs across
      // schema versions; if one of those ever silently failed to apply on some environment, this
      // is the one lookup that must never be left to a sequential scan. Guard explicitly instead
      // of trusting the constraint history — this is a no-op (not a duplicate index) wherever the
      // constraint's index already exists.
      const { rows: tokenIdx } = await client.query(
        `SELECT 1 FROM pg_indexes WHERE tablename='tables' AND indexdef ILIKE '%(token)%' LIMIT 1`
      );
      if (!tokenIdx.length) {
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_token ON tables(token)`);
      }

      // getOpenOrder's real query filters orders by (table_id, status) — already covered by
      // idx_orders_table_status — then does ORDER BY created_at DESC LIMIT 1. Extending the index
      // to include created_at lets Postgres satisfy the sort from the index itself instead of a
      // separate Sort step once a table accumulates enough historical (closed) orders to matter.
      await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_table_status_created ON orders(table_id, status, created_at DESC)`);

      // payments.status='pending' is scanned by the reconciliation sweep every 30 seconds,
      // forever, against the entire (never-pruned) payments table — confirmed via EXPLAIN to be
      // a full sequential scan with no backing index at all. A partial index keyed on the status
      // stays tiny permanently since pending rows are always a sliver of lifetime payment volume.
      await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_status_pending ON payments(status) WHERE status = 'pending'`);

      // payments.mia_payment_id is looked up on every MIA webhook callback and on socket
      // reconnect/payment-recovery — confirmed via EXPLAIN to be a full sequential scan with no
      // backing index. Partial (non-null only) keeps it small since most historical rows never
      // carry a provider id once settled long enough ago to be irrelevant to lookups.
      await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_mia_payment_id ON payments(mia_payment_id) WHERE mia_payment_id IS NOT NULL`);

      // referrals.referrer_id had no index at all (only referred_id, via its own UNIQUE) —
      // every Club Eats member's Profil/referral view counts rows WHERE referrer_id=$1.
      await client.query(`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id)`);
    } catch (err) {
      console.error('[setup-db] hot-path index audit failed (non-fatal):', err.message);
    }

    await client.query('COMMIT');
    console.log('✅ Database schema ready.');

    // ── backfill tokens for any tables that don't have one yet ───────────────
    const crypto = await import('crypto');
    const { rows: noToken } = await client.query('SELECT id FROM tables WHERE token IS NULL');
    for (const tbl of noToken) {
      const token = crypto.randomBytes(8).toString('hex'); // 16 URL-safe hex chars
      await client.query('UPDATE tables SET token = $1 WHERE id = $2', [token, tbl.id]);
    }
    if (noToken.length) console.log(`✅ Generated tokens for ${noToken.length} table(s).`);

    // ── backfill referral_codes for members that don't have one yet ──────────
    const REFERRAL_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    function genRefCode() {
      const bytes = crypto.randomBytes(6);
      return Array.from(bytes).map(b => REFERRAL_CHARS[b % REFERRAL_CHARS.length]).join('');
    }
    const { rows: noCode } = await client.query('SELECT id FROM members WHERE referral_code IS NULL');
    for (const m of noCode) {
      let code, attempt = 0;
      do { code = genRefCode(); attempt++; } while (attempt < 10);
      try {
        await client.query('UPDATE members SET referral_code=$1 WHERE id=$2', [code, m.id]);
      } catch { /* collision — will retry on next run */ }
    }
    if (noCode.length) console.log(`✅ Generated referral codes for ${noCode.length} member(s).`);

    // ── seed a demo restaurant if none exist ─────────────────────────────────
    const { rows } = await client.query('SELECT COUNT(*) AS n FROM restaurants');
    if (Number(rows[0].n) === 0) {
      console.log('Seeding demo restaurant (Carmelo)...');
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
        const tblToken = crypto.randomBytes(8).toString('hex');
        const { rows: [t] } = await client.query(
          'INSERT INTO tables (restaurant_id, number, token) VALUES ($1, $2, $3) RETURNING id',
          [r.id, i, tblToken]
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
