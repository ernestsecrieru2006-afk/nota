/**
 * mia.js — maib MIA QR API integration for nota.
 *
 * Real docs: https://docs.maibmerchants.md/mia-qr-api  (fetched & followed directly, not assumed)
 *
 * Credentials are per-restaurant (from onboarding, encrypted at rest — see server/secrets.js),
 * not global. Every exported function takes an optional `creds` argument:
 *   - a { clientId, clientSecret, signatureKey, env } object → use exactly these credentials
 *   - `null` (explicit)   → force mock, regardless of env vars. This is what server.js passes
 *                           for any restaurant whose maib_status isn't 'active' — a restaurant
 *                           is only ever taken out of demo mode by its own deliberate credentials,
 *                           never by a shared server-wide config.
 *   - omitted / undefined → fall back to MAIB_MIA_ENV + MAIB_CLIENT_ID/SECRET/SIGNATURE_KEY env
 *                           vars. Only used for our own direct testing of this module — the real
 *                           guest payment flow in server.js always passes one of the two above.
 *
 * Three modes per resolved credential set:
 *   mock        — no usable credentials. Internal-timer behavior, unchanged from before.
 *   sandbox     — env: 'sandbox'. Real calls against https://sandbox.maibmerchants.md, incl.
 *                 the test-pay simulation endpoint (sandbox only).
 *   production  — env: 'production'. Real calls against https://api.maibmerchants.md.
 *
 * Flow (sandbox/production):
 *   1. requestPayment() creates a Dynamic QR (POST /v2/mia/qr) — single-use, fixed MDL amount,
 *      3-minute validity (matches our own reconciliation timeout in server.js).
 *   2. Guest is already on their own phone (they scanned the table QR to get here), so a second
 *      QR to scan is the wrong UX. We return both the raw `url` from the QR-creation response
 *      (docs call it "the HTTPS QR link") as a tap-to-open deep link, AND render it as a QR image
 *      (guest can screenshot/show staff if tapping doesn't open the MIA app on their device).
 *   3. maib calls our webhook at /api/payment/webhook when the QR reaches a final state.
 *      server.js resolves which restaurant owns the qrId first (metadata lookup, not trust),
 *      then verifies with THAT restaurant's own signature key — fail closed if it doesn't match.
 *   4. Fallback: reconciliation polls GET /v2/mia/qr/{qrId} every 30s. If Paid, we do one more
 *      call (GET /v2/mia/payments?qrId=...) to recover the real payId for refund purposes,
 *      since the QR-details endpoint doesn't return payId itself.
 */

import crypto from 'crypto';
import { sweepByAge } from './mem-sweep.js';

const PROD_BASE    = 'https://api.maibmerchants.md';
const SANDBOX_BASE = 'https://sandbox.maibmerchants.md';

const ENV_CLIENT_ID     = process.env.MAIB_CLIENT_ID     || null;
const ENV_CLIENT_SECRET = process.env.MAIB_CLIENT_SECRET || null;
const ENV_SIGNATURE_KEY = process.env.MAIB_SIGNATURE_KEY || null;
const ENV_RAW_ENV       = (process.env.MAIB_MIA_ENV || '').toLowerCase();

const round2 = v => Math.round(Number(v) * 100) / 100;

/**
 * Resolves a credentials context. See module doc for the three forms `creds` can take.
 * Returns { mode, clientId, clientSecret, signatureKey, base }.
 */
function resolveCreds(creds) {
  if (creds === null) {
    return { mode: 'mock', clientId: null, clientSecret: null, signatureKey: null, base: null };
  }
  if (creds && typeof creds === 'object') {
    const env = (creds.env || '').toLowerCase();
    if ((env === 'sandbox' || env === 'production') && creds.clientId && creds.clientSecret) {
      return {
        mode: env, clientId: creds.clientId, clientSecret: creds.clientSecret,
        signatureKey: creds.signatureKey || null,
        base: env === 'production' ? PROD_BASE : SANDBOX_BASE,
      };
    }
    return { mode: 'mock', clientId: null, clientSecret: null, signatureKey: null, base: null };
  }
  // creds === undefined: env-var fallback, for direct/manual testing of this module only.
  const hasEnvCreds = !!(ENV_CLIENT_ID && ENV_CLIENT_SECRET);
  if ((ENV_RAW_ENV === 'sandbox' || ENV_RAW_ENV === 'production') && hasEnvCreds) {
    return {
      mode: ENV_RAW_ENV, clientId: ENV_CLIENT_ID, clientSecret: ENV_CLIENT_SECRET, signatureKey: ENV_SIGNATURE_KEY,
      base: ENV_RAW_ENV === 'production' ? PROD_BASE : SANDBOX_BASE,
    };
  }
  return { mode: 'mock', clientId: null, clientSecret: null, signatureKey: null, base: null };
}

// Reported by /health and the startup banner as the *default* (env-fallback) mode only — never
// restaurant-specific, since /health has no restaurant context and must never leak per-tenant
// config. Distinguishes 'off' (no MAIB_MIA_ENV set at all — nothing configured, not even
// attempted) from 'mock' (MAIB_MIA_ENV was set to sandbox/production but credentials are missing
// or incomplete, so it fell back) — both behave identically (mock), but "off" vs "misconfigured"
// is a meaningfully different signal to read on a status page.
export const MIA_DEFAULT_MODE = (() => {
  if (ENV_RAW_ENV !== 'sandbox' && ENV_RAW_ENV !== 'production') return 'off';
  return resolveCreds(undefined).mode; // 'sandbox' | 'production' if creds are complete, else 'mock'
})();

// One-shot flag: set via /api/dev/mock-fail-next to make next mock payment fail
let _mockFailNext = false;
export function setMockFailNext() { _mockFailNext = true; }

// ─── token auth ───────────────────────────────────────────────────────────────
// Cached per credential set (clientId+mode), not a single global — different restaurants have
// different tokens.

const _tokenCache = new Map(); // key: `${mode}:${clientId}` -> { accessToken, expiresAt }

async function getAccessToken(ctx) {
  const key = `${ctx.mode}:${ctx.clientId}`;
  const cached = _tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt - 30_000) return cached.accessToken;

  const res = await fetch(`${ctx.base}/v2/auth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ clientId: ctx.clientId, clientSecret: ctx.clientSecret }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new Error(`maib auth/token failed: HTTP ${res.status} ${data?.errors ? JSON.stringify(data.errors) : ''}`);
  }
  const entry = {
    accessToken: data.result.accessToken,
    expiresAt:   Date.now() + Number(data.result.expiresIn) * 1000,
  };
  _tokenCache.set(key, entry);
  return entry.accessToken;
}

// Called from server.js's periodic sweep — see mem-sweep.js. Naturally small (one entry per
// restaurant's maib credential set), but expired tokens are still worth clearing promptly rather
// than holding stale secrets in memory until the next natural refresh touches that same key.
export function sweepMiaTokenCache() {
  return sweepByAge(_tokenCache, entry => entry.expiresAt - 30_000, { maxAgeMs: 0, maxSize: 2000 });
}

// Read-only size for the internal metrics endpoint.
export function miaTokenCacheSize() { return _tokenCache.size; }

async function authedFetch(ctx, path, { method = 'GET', body } = {}) {
  const token = await getAccessToken(ctx);
  const res = await fetch(`${ctx.base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok === false) {
    const detail = data?.errors ? JSON.stringify(data.errors) : `HTTP ${res.status}`;
    throw new Error(`maib API error on ${method} ${path}: ${detail}`);
  }
  return data.result;
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * requestPayment({ amountLei, tipLei, orderId, tableNumber, description }, creds?)
 * Creates a per-transaction Dynamic QR. Returns:
 *   { paymentId, qrId, deepLinkUrl, expiresAt, referenceId, _mock? }
 * `paymentId` === `qrId` in sandbox/production — it's the one identifier maib gives us up
 * front (before a payId exists), so it's what we use everywhere as the correlation key
 * (paymentMeta map, payments.mia_payment_id column, webhook lookups).
 */
export async function requestPayment({ amountLei, tipLei = 0, orderId, tableNumber, description }, creds) {
  const ctx = resolveCreds(creds);
  if (ctx.mode !== 'mock') {
    const totalLei  = round2(Number(amountLei) + Number(tipLei));
    const ourOrderId = `nota-${orderId}-${Date.now()}`.slice(0, 100);
    const expiresAt  = new Date(Date.now() + 180_000).toISOString(); // 3 min — matches server.js reconciliation timeout
    const callbackUrl = `${process.env.APP_URL || ''}/api/payment/webhook`;

    const result = await authedFetch(ctx, '/v2/mia/qr', {
      method: 'POST',
      body: {
        type:        'Dynamic',
        expiresAt,
        amountType:  'Fixed',
        amount:      totalLei,
        currency:    'MDL',
        description: (description || `Masă ${tableNumber} — nota.`).slice(0, 500),
        orderId:     ourOrderId,
        callbackUrl,
      },
    });

    return {
      paymentId:   result.qrId,
      qrId:        result.qrId,
      deepLinkUrl: result.url,
      expiresAt:   result.expiresAt || expiresAt,
      referenceId: result.orderId || ourOrderId,
    };
  }

  // ── Mock ──────────────────────────────────────────────────────────────────
  const shouldFail  = _mockFailNext;
  _mockFailNext     = false;   // one-shot: consume the flag
  const prefix      = shouldFail ? 'mock-fail' : 'mock-pay';
  const paymentId   = `${prefix}-${Date.now()}`;
  return {
    paymentId,
    deepLinkUrl:  `https://mock-mia.nota.md/pay/${paymentId}`,
    expiresAt:    new Date(Date.now() + 180_000).toISOString(),
    referenceId:  `nota-${orderId}-mock`,
    _mock:        true,
    _shouldFail:  shouldFail,
  };
}

/**
 * getPaymentStatus(qrId, creds?)
 * Polls maib for the current state of a QR (reconciliation fallback for missed webhooks).
 * Returns { status: 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED' | 'CANCELLED', paidAt, payId }
 * `payId` is only populated once status is PAID (needs a second call — the QR-details
 * endpoint doesn't return it) and is what's needed later for refunds.
 */
export async function getPaymentStatus(qrId, creds) {
  const ctx = resolveCreds(creds);
  if (ctx.mode !== 'mock' && !String(qrId).startsWith('mock-')) {
    const result = await authedFetch(ctx, `/v2/mia/qr/${encodeURIComponent(qrId)}`);
    const statusMap = { Paid: 'PAID', Expired: 'EXPIRED', Cancelled: 'CANCELLED', Inactive: 'FAILED', Active: 'PENDING' };
    const status = statusMap[result.status] || 'PENDING';

    let payId = null, paidAt = null;
    if (status === 'PAID') {
      try {
        const list = await authedFetch(
          ctx, `/v2/mia/payments?qrId=${encodeURIComponent(qrId)}&count=1&offset=0&sortBy=executedAt&order=desc`
        );
        const item = list?.items?.[0];
        if (item) { payId = item.payId; paidAt = item.executedAt; }
      } catch (err) {
        console.error('[mia] could not recover payId after Paid status (will retry next poll):', err.message);
      }
    }
    return { status, paidAt, payId };
  }

  // Mock: fail payments whose ID starts with 'mock-fail-'; succeed all others
  const status = qrId.startsWith('mock-fail-') ? 'FAILED' : 'PAID';
  return { status, paidAt: status === 'PAID' ? new Date().toISOString() : null, payId: null, _mock: true };
}

/**
 * cancelPayment(qrId, reason, creds?)
 * Best-effort: cancels an active QR on maib's side (expired/abandoned pendings) so it can no
 * longer be paid after we've already released the items. Never throws — our own release must
 * proceed regardless of whether maib's cancel call succeeds.
 */
export async function cancelPayment(qrId, reason = 'Anulat de restaurant', creds) {
  const ctx = resolveCreds(creds);
  if (ctx.mode === 'mock' || !qrId || String(qrId).startsWith('mock-')) return { skipped: true };
  try {
    const result = await authedFetch(ctx, `/v2/mia/qr/${encodeURIComponent(qrId)}/cancel`, {
      method: 'POST',
      body:   { reason: String(reason).slice(0, 500) },
    });
    return { status: result.status };
  } catch (err) {
    console.error('[mia] cancelPayment failed (non-fatal):', err.message);
    return { error: err.message };
  }
}

/**
 * refundPayment({ payId, amountLei, reason }, creds?)
 * amountLei omitted → full refund; provided → partial refund (both documented).
 * Returns { refundId, status }. Throws on failure — caller (dashboard route) surfaces the error.
 */
export async function refundPayment({ payId, amountLei = null, reason }, creds) {
  const ctx = resolveCreds(creds);
  if (ctx.mode === 'mock') throw new Error('Refunds require an active maib merchant (sandbox or production)');
  const body = { reason: String(reason || 'Refund solicitat de restaurant').slice(0, 500) };
  if (amountLei != null) body.amount = round2(amountLei);
  const result = await authedFetch(ctx, `/v2/payments/${encodeURIComponent(payId)}/refund`, { method: 'POST', body });
  return { refundId: result.refundId, status: result.status };
}

/**
 * simulatePayment({ qrId, amountLei, iban, payerName }, creds?)
 * Sandbox-only test-pay endpoint — completes a payment against a live sandbox QR so we can
 * exercise the full webhook → settlement loop before real maib credentials exist.
 */
export async function simulatePayment({ qrId, amountLei, iban, payerName }, creds) {
  const ctx = resolveCreds(creds);
  if (ctx.mode !== 'sandbox') throw new Error('Payment simulation is only available in sandbox mode');
  const result = await authedFetch(ctx, '/v2/mia/test-pay', {
    method: 'POST',
    body: {
      qrId,
      amount:    round2(amountLei),
      currency:  'MDL',
      iban:      String(iban).slice(0, 100),
      payerName: String(payerName).slice(0, 200),
    },
  });
  return result;
}

/**
 * parseCallbackFields(rawBody)
 * Extracts { result, signature } from a callback body WITHOUT verifying anything — used only to
 * look up which restaurant a callback belongs to (metadata, not trust) before we know whose
 * signature key to verify it with. Returns null if the body isn't even well-formed.
 */
export function parseCallbackFields(rawBody) {
  let json;
  try {
    json = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
  } catch {
    return null;
  }
  const result = json?.result;
  const signature = json?.signature;
  if (!result || typeof signature !== 'string') return null;
  return { result, signature };
}

/**
 * verifyAndParseCallback({ result, signature }, signatureKey)
 * Validates the documented signature scheme against the given restaurant's signature key and
 * returns a normalized payload, or null if invalid/unverifiable — fail closed, always.
 *
 * Algorithm (per docs + example, which we completed with the standard base64-compare step the
 * docs' own Node.js sample stopped short of — the same steps are spelled out in full in the
 * .NET/PHP samples on the same page):
 *   1. Take all non-null fields of `result`.
 *   2. Format `amount`/`commission` to 2 decimals; everything else as string.
 *   3. Sort field names case-insensitively.
 *   4. Join the *values* (in that key order) with ':'.
 *   5. Append ':' + signatureKey.
 *   6. SHA-256 hash, base64-encode, compare to `signature`.
 */
export function verifyAndParseCallback({ result, signature: providedSig }, signatureKey) {
  if (!signatureKey) return null; // no key configured for this restaurant — reject, fail closed
  if (!result || typeof providedSig !== 'string') return null;

  const fields = {};
  for (const [key, value] of Object.entries(result)) {
    if (value === null || value === undefined) continue;
    const str = (key === 'amount' || key === 'commission') ? Number(value).toFixed(2) : String(value);
    if (str.trim() !== '') fields[key] = str;
  }
  const orderedKeys = Object.keys(fields).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const joined = orderedKeys.map(k => fields[k]).join(':');
  const hashInput = `${joined}:${signatureKey}`;
  const expected = crypto.createHash('sha256').update(hashInput, 'utf8').digest('base64');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(providedSig, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return null;
  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) return null;

  const qrStatusRaw = String(result.qrStatus || '').toLowerCase();
  const isPaid = qrStatusRaw === 'plătit' || qrStatusRaw === 'platit' || qrStatusRaw === 'paid';

  return {
    qrId:      result.qrId,
    payId:     result.payId,
    orderId:   result.orderId,
    status:    isPaid ? 'PAID' : 'OTHER',
    amountLei: result.amount != null ? Number(result.amount) : null,
    executedAt: result.executedAt || null,
  };
}
