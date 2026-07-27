/**
 * poster.js — Poster POS integration for nota. waiter attribution.
 *
 * Poster (joinposter.com) has per-employee PIN login, so every closed transaction carries the
 * waiter who closed it directly on the object (`user_id`). Unlike iiko.js, credentials here are
 * per-restaurant (one API token pasted in the dashboard, see server.js's getPosterCreds), not a
 * server-wide env var — closer to how maib credentials work. A restaurant with no token
 * configured (poster_status !== 'active') never calls this module at all; the attribution chain
 * simply falls through to shift assignment.
 *
 * Field names below were verified against the live API docs (dev.joinposter.com), not guessed:
 *   - access.getEmployees   → { user_id, name, role_name, user_type } — user_type 0 = waiter
 *   - dash.getTransactions  → { user_id, name, payed_sum, date_close, status, ... } per order,
 *     where user_id IS the waiter who closed the order and payed_sum/date_close are in
 *     bani (cents) / unix milliseconds respectively.
 *
 * findWaiterForPayment() has one known, documented limitation: nota. doesn't yet store a mapping
 * from its own table numbers to Poster's internal table_id, so there's no live account to test
 * an exact table match against. It correlates by amount + a tight time window instead — this is
 * the first thing to tighten once a real Poster account is connected.
 */

const POSTER_BASE = 'https://joinposter.com/api';

async function posterGet(method, token, params = {}) {
  const qs = new URLSearchParams({ token, ...params });
  const res = await fetch(`${POSTER_BASE}/${method}?${qs}`);
  if (!res.ok) throw new Error(`poster ${method} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(`poster ${method} error: ${JSON.stringify(data.error)}`);
  return data.response || [];
}

/**
 * getEmployees(token) → [{ posterUserId, name, roleName, isWaiter }]
 * Powers the dashboard mapping screen.
 */
export async function getEmployees(token) {
  const rows = await posterGet('access.getEmployees', token);
  return rows.map(e => ({
    posterUserId: String(e.user_id),
    name:         e.name,
    roleName:     e.role_name || null,
    isWaiter:     Number(e.user_type) === 0,
  }));
}

function toPosterDate(d) {
  // dash.getTransactions' dateFrom/dateTo are day-granularity (Ymd) — we narrow to the exact
  // window ourselves afterwards using each transaction's date_close.
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/**
 * findWaiterForPayment(token, { paidAt, amountBani })
 * Best-effort correlation of a settled nota. payment to the Poster transaction that produced it,
 * returning that transaction's user_id (Poster's waiter id) or null if nothing matches closely
 * enough. Never throws for "no match" — only for actual API/network failures, which the caller
 * (attributeWaiterToPayment in server.js) already treats as best-effort and swallows.
 */
export async function findWaiterForPayment(token, { paidAt, amountBani, windowMs = 15 * 60_000 }) {
  const from = new Date(paidAt.getTime() - windowMs);
  const to   = new Date(paidAt.getTime() + 2 * 60_000);
  const rows = await posterGet('dash.getTransactions', token, {
    dateFrom: toPosterDate(from),
    dateTo:   toPosterDate(to),
    status:   '2', // closed only
  });

  let best = null;
  let bestDiffMs = Infinity;
  for (const tr of rows) {
    const payedSum = Number(tr.payed_sum || 0);
    if (Math.abs(payedSum - amountBani) > 5) continue; // a few bani of rounding tolerance
    const closeMs = Number(tr.date_close || 0);
    if (!closeMs) continue;
    const diff = Math.abs(closeMs - paidAt.getTime());
    if (diff > windowMs) continue;
    if (diff < bestDiffMs) { bestDiffMs = diff; best = tr; }
  }
  return best ? String(best.user_id) : null;
}
