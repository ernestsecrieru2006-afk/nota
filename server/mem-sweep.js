/**
 * mem-sweep.js — shared eviction helpers for the in-memory Maps scattered across auth.js,
 * members.js, staff.js, telegram.js, mia.js, and server.js.
 *
 * None of these Maps are the source of truth (Postgres always is — payments in particular have
 * a full DB-based reconciliation fallback, see reconcilePendingPayments in server.js), so evicting
 * a stale entry here is always safe: worst case, the next read just re-derives state from the DB
 * or re-creates the entry fresh. These helpers only ever delete based on age or a hard size cap —
 * never based on business logic — so they can't interfere with in-flight lockouts, payments, etc.
 */

// Generic: evict entries older than maxAgeMs (per getTimestamp), then if still over maxSize,
// evict the oldest remaining entries until at cap (LRU-style backstop against pathological
// growth — e.g. an attacker cycling through thousands of distinct emails/IPs faster than the
// periodic sweep interval).
export function sweepByAge(map, getTimestamp, { maxAgeMs, maxSize, now = Date.now() } = {}) {
  let evicted = 0;
  for (const [key, value] of map) {
    const ts = getTimestamp(value, key);
    if (!ts || now - ts > maxAgeMs) {
      map.delete(key);
      evicted++;
    }
  }
  if (maxSize && map.size > maxSize) {
    const entries = [...map.entries()].sort((a, b) => (getTimestamp(a[1], a[0]) || 0) - (getTimestamp(b[1], b[0]) || 0));
    const overBy = map.size - maxSize;
    for (let i = 0; i < overBy; i++) {
      map.delete(entries[i][0]);
      evicted++;
    }
  }
  return { evicted, size: map.size };
}

// Attempt/lockout maps (auth.js, members.js, staff.js) all share the exact same
// { failures, lockedUntil, updatedAt } shape — one sweep implementation for all three.
export function sweepAttemptMap(map, { maxAgeMs = 24 * 60 * 60 * 1000, maxSize = 5000 } = {}) {
  return sweepByAge(map, entry => entry?.updatedAt, { maxAgeMs, maxSize });
}
