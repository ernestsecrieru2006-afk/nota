import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

// Single shared pool — used by server.js, auth.js, and iiko.js.
// Neon/Railway free tiers allow ~100 connections; max:10 leaves headroom by default, but real
// traffic volume varies a lot per deployment, so it's env-configurable rather than baked in.
const POOL_MAX = Number(process.env.DB_POOL_MAX) > 0 ? Number(process.env.DB_POOL_MAX) : 10;

export const pool = new Pool({
  connectionString:    process.env.DATABASE_URL,
  max:                 POOL_MAX,
  idleTimeoutMillis:   30_000,
  connectionTimeoutMillis: 5_000,
});

// Saturation watch: waitingCount > 0 means every pooled connection is busy and at least one
// query is queued behind it — the clearest possible signal to raise DB_POOL_MAX before it shows
// up as slow requests to guests. Logged at most once per window so a genuine saturation episode
// doesn't spam the log once per query.
let lastSaturationWarnAt = 0;
const SATURATION_WARN_INTERVAL_MS = 30_000;
setInterval(() => {
  if (pool.waitingCount > 0 && Date.now() - lastSaturationWarnAt > SATURATION_WARN_INTERVAL_MS) {
    lastSaturationWarnAt = Date.now();
    console.warn(`[db] pool saturated — waiting=${pool.waitingCount} total=${pool.totalCount} idle=${pool.idleCount} max=${POOL_MAX} — consider raising DB_POOL_MAX`);
  }
}, 5_000);

export function poolStats() {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: POOL_MAX };
}
