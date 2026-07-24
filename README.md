# nota.

**QR table-payment app for restaurants in Moldova.**  
Guests scan a QR code, see their table's bill, split it any way they like, and pay with MIA (Request-to-Pay). The restaurant owner watches payments come in live on the dashboard.

---

## Quick start (local development)

```bash
# 1 — install
npm install

# 2 — create .env with your Neon (or any Postgres) connection string
echo 'DATABASE_URL=postgresql://user:pass@host/db?sslmode=require' > .env

# 3 — create tables
node server/setup-db.js

# 4 — start
npm start          # production
npm run dev        # auto-restarts on file changes (Node ≥ 22)
```

Server starts at **http://localhost:3000**

| URL | What it is |
|---|---|
| `/?t=7` | Guest app for table 7 |
| `/dashboard` | Owner dashboard (live) |
| `/qrcodes` | Printable QR codes for all 8 tables |

---

## Architecture

```
Browser                     Server (Express + Socket.io)        Database (Postgres)
  │                                   │                               │
  │  GET /?t=7                        │                               │
  │ ──────────────────────────────►  │  serves public/index.html     │
  │                                   │                               │
  │  fetch /api/table/7               │                               │
  │ ──────────────────────────────►  │  getOpenOrder(7) ────────────►│
  │ ◄──────────────────────────────  │  ◄──────────────────────────  │
  │                                   │                               │
  │  socket: claim-items([1,3])       │                               │
  │ ──────────────────────────────►  │  atomic UPDATE               │
  │                                   │  broadcast order-update       │
  │ ◄──────────────────────────────  │  ack { claimed, contested }   │
  │                                   │                               │
  │  POST /api/payment/initiate       │  requestPayment() ← mock-mia │
  │ ◄──────────────────────────────  │  { paymentId }                │
  │                                   │                               │
  │  socket: pay-claimed              │  UPDATE status='paid'         │
  │ ──────────────────────────────►  │  INSERT INTO payments         │
  │                                   │  broadcast → dashboard        │
```

### Data model

| Table | Purpose |
|---|---|
| `restaurants` | One row per business |
| `tables` | Physical tables (1–N per restaurant) |
| `orders` | One open session per table |
| `order_items` | Dishes: `available → claimed → paid` |
| `payments` | One row per payment tap (amount + tip) |

---

## Where the real integrations plug in

### 1 — POS system (iiko)

**File: `server/mock-iiko.js`**

Every function has the real iiko API call commented out directly above the mock SQL:

| Function | What to replace |
|---|---|
| `getOpenOrder(tableNumber)` | `GET /resto/api/v2/orders?tableId=N` |
| `addItem(tableNumber, name, price)` | `POST /resto/api/v2/orders/{id}/items` |
| `payClaimedItems(socketId, tipLei)` | Mark items paid in iiko + keep our DB insert |

Add to `.env`: `IIKO_URL`, `IIKO_API_KEY`

### 2 — maib MIA QR API (real integration, not mocked)

**File: `server/mia.js`** — a faithful implementation against the real docs
(https://docs.maibmerchants.md/mia-qr-api), with three modes:

| Mode | When active |
|---|---|
| `mock` | Default — no credentials set. Internal-timer fake payments, as before. |
| `sandbox` | `MAIB_MIA_ENV=sandbox` + credentials set. Real calls against maib's test env, incl. the `test-pay` simulation endpoint. |
| `production` | `MAIB_MIA_ENV=production` + credentials set. Real calls against maib's live API. |

| Function | When it runs |
|---|---|
| `requestPayment(opts)` | Guest taps "Plătește cu MIA" — creates a Dynamic QR |
| `getPaymentStatus(qrId)` | Reconciliation poll fallback for missed webhooks |
| `verifyAndParseCallback(rawBody)` | `POST /api/payment/webhook` — validates the documented signature scheme |
| `cancelPayment(qrId, reason)` | Best-effort cancel on timeout/failure |
| `refundPayment({ payId, amountLei, reason })` | `POST /api/dashboard/payments/:id/refund` |
| `simulatePayment(...)` | Sandbox-only, via `POST /api/dev/simulate-mia-payment` |

**To go live:** get sandbox credentials from `ecom@maib.md`, set `MAIB_MIA_ENV=sandbox` +
`MAIB_CLIENT_ID`/`MAIB_CLIENT_SECRET`/`MAIB_SIGNATURE_KEY` in `.env` (see `.env.example`),
test the full loop with the sandbox simulate endpoint, then flip `MAIB_MIA_ENV=production`
with production credentials when maib issues them — no code changes needed.

---

## Deploying to Railway

1. Push this repo to GitHub

2. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**

3. In **Variables**, add:
   ```
   DATABASE_URL = postgresql://...  (your Neon connection string)
   ```

4. Railway builds with `npm install` and starts with `npm start` (see `railway.toml`)

5. Your live URL: `https://your-app.up.railway.app`

Then visit `/qrcodes` to generate and print QR codes pointing at your live URL.

---

## Socket events

| Who sends | Event | Payload |
|---|---|---|
| guest client | `join-table` | `tableNumber` |
| owner client | `join-dashboard` | — |
| guest client | `claim-items` | `itemIds[]` → ack `{ claimed, contested, order }` |
| guest client | `pay-claimed` | `{ tipLei }` → ack `{ success }` |
| guest client | `release-claims` | — |
| server | `order-update` | `order` (broadcast to table room) |
| server | `payment-made` | `{ id, table_number, amount_lei, tip_lei, paid_at }` (broadcast to dashboard room) |

---

## REST API

| Method | Path | Use |
|---|---|---|
| GET | `/api/table/:n` | Fetch open order |
| POST | `/api/table/:n/item` | Add dish `{ name, price }` |
| POST | `/api/payment/initiate` | Start MIA payment `{ amountLei, socketId }` |
| POST | `/api/payment/webhook` | maib callback notification (sandbox/production only) |
| POST | `/api/dashboard/payments/:id/refund` | Refund a settled payment (auth'd, tenant-scoped) |
| GET | `/api/dashboard/stats` | Today's totals |
| GET | `/api/dashboard/top-dishes` | Most-paid dishes |
| GET | `/api/dashboard/hourly` | Payments by hour |
| GET | `/api/dashboard/recent` | Last 30 payments |
| GET | `/health` | Uptime check |
| GET | `/qrcodes` | Printable QR codes |
| POST | `/api/dev/seed-payments` | **Dev only** — inject demo payments |

---

## Testing the full flow

1. Open two browser windows at `/?t=7`
2. Window A: select "Spaghetti alle vongole" → **Continuă**  
   Window B: item instantly shows "rezervat"
3. Window A: **Plătește cu MIA → Confirmă plata**  
   Dashboard: new payment appears in real time
4. Window B: item now shows "achitat", progress bar advances

Reset for another run: **Adaugă date demo** button on the dashboard.
