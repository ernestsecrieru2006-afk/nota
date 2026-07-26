/**
 * telegram.js — optional per-restaurant Telegram bot notifications.
 *
 * Fire-and-forget by design: notifyTelegram() must NEVER throw or reject into its caller.
 * Payments and waiter-call handling must be able to call it and move on regardless of whether
 * Telegram is configured, reachable, or erroring — failures are logged here and nowhere else.
 *
 * Feature is simply off when a restaurant has no bot token + chat ID configured (no-op, no error).
 */

import { pool } from './db.js';
import { decryptSecret } from './secrets.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';

// Ephemeral, in-memory — same lifetime philosophy as the throttle Maps in server.js.
const dedupeCache = new Map(); // dedupeKey → last-sent timestamp (ms)
const rateWindows = new Map(); // restaurantId → { count, resetAt }

const DEDUPE_WINDOW_MS     = 15_000; // defense-in-depth against a double-fire bug, not a real spam vector
const RATE_LIMIT_MAX       = 20;     // generous ceiling above realistic peak organic volume
const RATE_LIMIT_WINDOW_MS = 60_000;

async function getTelegramConfig(restaurantId) {
  const { rows: [r] } = await pool.query(
    'SELECT telegram_bot_token_enc, telegram_chat_id FROM restaurants WHERE id=$1',
    [restaurantId]
  );
  if (!r?.telegram_bot_token_enc || !r?.telegram_chat_id) return null; // feature off
  const token = decryptSecret(r.telegram_bot_token_enc);
  return token ? { token, chatId: r.telegram_chat_id } : null;
}

function shouldSend(restaurantId, dedupeKey) {
  const now = Date.now();
  const last = dedupeCache.get(dedupeKey);
  if (last && now - last < DEDUPE_WINDOW_MS) return false;

  let w = rateWindows.get(restaurantId);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateWindows.set(restaurantId, w);
  }
  if (w.count >= RATE_LIMIT_MAX) return false;

  w.count++;
  dedupeCache.set(dedupeKey, now);
  return true;
}

// Fire-and-forget: caller does not (and must not) await this.
export function notifyTelegram(restaurantId, text, { dedupeKey } = {}) {
  (async () => {
    try {
      if (!restaurantId || !text) return;
      if (!shouldSend(restaurantId, dedupeKey || `${restaurantId}:${text}`)) return;
      const cfg = await getTelegramConfig(restaurantId);
      if (!cfg) return;
      const res = await fetch(`${TELEGRAM_API}${cfg.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error('[telegram] send failed', res.status, body.slice(0, 200));
      }
    } catch (err) {
      console.error('[telegram] send error', err.message); // log-only — must never affect callers
    }
  })();
}

// The one awaited, result-surfacing call site — used by the dashboard's "Trimite mesaj de test".
export async function sendTelegramTest(restaurantId) {
  const cfg = await getTelegramConfig(restaurantId);
  if (!cfg) return { ok: false, error: 'Telegram nu este configurat' };
  try {
    const res = await fetch(`${TELEGRAM_API}${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text: '✅ Test nota. — configurare Telegram reușită.' }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => '');
    return { ok: false, error: `Telegram a răspuns cu eroare (${res.status}): ${body.slice(0, 150)}` };
  } catch (err) {
    return { ok: false, error: 'Nu s-a putut contacta Telegram: ' + err.message };
  }
}
