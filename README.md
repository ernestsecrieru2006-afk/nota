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

### 2 — MIA bank (Request-to-Pay)

**File: `server/mock-mia.js`**

Three functions; each has the real `fetch()` call commented out:

| Function | When it runs |
|---|---|
| `requestPayment(opts)` | Guest taps "Plătește cu MIA" |
| `getPaymentStatus(paymentId)` | Polling / webhook fallback |
| `verifyWebhookSignature(body, sig)` | `POST /api/payment/webhook` handler |

**To go live:**
1. Get credentials from MIA: `MIA_MERCHANT_ID`, `MIA_SECRET`, `MIA_WEBHOOK_SECRET`
2. Add them to `.env`
3. Uncomment the `fetch()` blocks in `mock-mia.js`
4. Update `POST /api/payment/webhook` in `server.js` to verify signature + emit `pay-claimed`
5. In `public/app.js` `mia-btn` handler, open `result.deepLinkUrl` instead of the fake bank screen

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
| POST | `/api/payment/webhook` | Bank callback (real MIA integration) |
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
