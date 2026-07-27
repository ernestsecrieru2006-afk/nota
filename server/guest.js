/**
 * guest.js — short-lived, stateless guest session binding for table-token access.
 *
 * Table tokens are permanent (printed on physical table tents) and, by themselves, grant
 * anyone who ever scanned one indefinite, timeless access to whatever bill is currently open
 * at that table — including a table that has long since turned over to new guests. This module
 * closes that gap without weakening the token itself or adding friction for real diners:
 *
 *   - A table with no open order, or an open order with zero items, is NEVER shown as a bill —
 *     session or not. This alone closes the far more common "long after service" exposure.
 *   - When there IS an open order with items, a guest session is a small signed token (same
 *     pattern as auth.js/members.js/staff.js — its own secret + `aud` claim so it can never be
 *     confused with an owner/member/staff token) binding a specific browser to that specific
 *     ORDER, not just the table. If a presented session's order no longer matches the table's
 *     current open order, the table has turned over since — show the neutral state rather than
 *     silently handing over the new sitting's bill.
 *
 * Deliberately NOT a hard access-expiry check: once a session's orderId matches the table's
 * live order, it keeps working for as long as that same order stays open, even past its own
 * `exp` — expiry only means the next request can't shortcut trust on the token alone (there is
 * no shortcut here anyway; resolveGuestOrder always re-reads the live order from the DB), so in
 * practice `exp` is hygiene/rotation, not an access cliff. This is what keeps "mid-meal refresh /
 * reconnect" completely frictionless while still guaranteeing a stale session can never see a
 * *different* order than the one it was issued for.
 */

import crypto from 'crypto';
import { getOpenOrder } from './iiko.js';

const BASE_SECRET  = process.env.JWT_SECRET || 'nota-dev-secret-change-in-production';
const GUEST_SECRET = BASE_SECRET + ':guest';
const GUEST_SESSION_TTL_SEC = 3 * 60 * 60; // 3h — see file header for why this isn't a hard cutoff

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signGuestJWT(payload) {
  const hdr = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const bdy = base64url(Buffer.from(JSON.stringify({
    ...payload, aud: 'guest', exp: Math.floor(Date.now() / 1000) + GUEST_SESSION_TTL_SEC,
  })));
  const sig = base64url(crypto.createHmac('sha256', GUEST_SECRET).update(`${hdr}.${bdy}`).digest());
  return `${hdr}.${bdy}.${sig}`;
}

// Deliberately does not reject on expired `exp` — see file header. Still verifies signature and
// `aud` so a member/owner/staff token (or garbage) can never be mistaken for a guest session.
function verifyGuestJWT(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const [hdr, bdy, sig] = token.split('.');
    if (!hdr || !bdy || !sig) return null;
    const expected = base64url(crypto.createHmac('sha256', GUEST_SECRET).update(`${hdr}.${bdy}`).digest());
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(bdy, 'base64').toString());
    if (payload.aud !== 'guest') return null;
    return payload; // { tableToken, orderId, restaurantId, tableNumber, aud, exp }
  } catch {
    return null;
  }
}

/**
 * resolveGuestOrder(tableToken, tableNumber, restaurantId, presentedSession)
 * The single choke point both the HTTP by-token route and the join-table socket handler call
 * to decide what a guest is allowed to see. `tableToken` may be null for the (unused by any
 * current client, but still-supported) direct tableNumber/restaurantId join path — session
 * binding is simply skipped in that case since there's no permanent URL to protect there.
 *
 * Returns either:
 *   { neutral: true }
 *     No open order with items right now (or a presented session proves this browser was
 *     tracking a specific order that's no longer the table's open one). Callers must show the
 *     neutral "no active order" state, never bill contents.
 *   { neutral: false, order, session }
 *     An open order with items exists and this browser is cleared to see it. `session` is a
 *     freshly-signed token the caller must hand back to the client to store and resend.
 */
export async function resolveGuestOrder(tableToken, tableNumber, restaurantId, presentedSession) {
  const order = await getOpenOrder(tableNumber, restaurantId);
  const hasContent = !!(order?.id && (order.items || []).length > 0);
  if (!hasContent) return { neutral: true };

  if (tableToken) {
    const presented = verifyGuestJWT(presentedSession);
    if (presented && presented.tableToken === tableToken && presented.orderId !== order.id) {
      // This browser was tracking a specific order that is no longer the table's open one —
      // the table turned over since. Never silently hand over the new sitting's bill.
      return { neutral: true };
    }
  }

  const session = tableToken
    ? signGuestJWT({ tableToken, orderId: order.id, restaurantId, tableNumber })
    : null;
  return { neutral: false, order, session };
}
