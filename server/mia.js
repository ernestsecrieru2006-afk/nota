/**
 * mia.js — maib MIA QR API integration for nota.
 *
 * Real docs: https://docs.maibmerchants.md/mia-qr-api  (fetched & followed directly, not assumed)
 *
 * Three modes, selected by env:
 *   mock        (default) — no credentials needed. Internal-timer behavior, unchanged from before.
 *   sandbox     — MAIB_MIA_ENV=sandbox + MAIB_CLIENT_ID/MAIB_CLIENT_SECRET/MAIB_SIGNATURE_KEY set.
 *                 Real calls against https://sandbox.maibmerchants.md, incl. the test-pay
 *                 simulation endpoint (sandbox only).
 *   production  — MAIB_MIA_ENV=production + same credentials. Real calls against
 *                 https://api.maibmerchants.md.
 *
 * If MAIB_MIA_ENV is set to sandbox/production but credentials are missing, we fall back to
 * mock rather than crash — graceful degradation so demos never break on misconfiguration.
 *
 * Flow (sandbox/production):
 *   1. requestPayment() creates a Dynamic QR (POST /v2/mia/qr) — single-use, fixed MDL amount,
 *      3-minute validity (matches our own reconciliation timeout in server.js).
 *   2. Guest is already on their own phone (they scanned the table QR to get here), so a second
 *      QR to scan is the wrong UX. We return both the raw `url` from the QR-creation response
 *      (docs call it "the HTTPS QR link") as a tap-to-open deep link, AND render it as a QR image
 *      (guest can screenshot/show staff if tapping doesn't open the MIA app on their device).
 *      We could not confirm same-device deep-link behavior without a live device + sandbox
 *      credentials — this is flagged in the verification report.
 *   3. maib calls our webhook at /api/payment/webhook when the QR reaches a final state.
 *      We verify the documented signature scheme (SHA-256 of sorted result-field values,
 *      colon-joined, salted with the signature key, base64-encoded) before trusting anything.
 *   4. Fallback: reconciliation polls GET /v2/mia/qr/{qrId} every 30s. If Paid, we do one more
 *      call (GET /v2/mia/payments?qrId=...) to recover the real payId for refund purposes,
 *      since the QR-details endpoint doesn't return payId itself.
 */

import crypto from 'crypto';

const PROD_BASE    = 'https://api.maibmerchants.md';
const SANDBOX_BASE = 'https://sandbox.maibmerchants.md';

const CLIENT_ID     = process.env.MAIB_CLIENT_ID     || null;
const CLIENT_SECRET = process.env.MAIB_CLIENT_SECRET || null;
const SIGNATURE_KEY = process.env.MAIB_SIGNATURE_KEY || null;

const rawEnv  = (process.env.MAIB_MIA_ENV || '').toLowerCase();
const hasCreds = !!(CLIENT_ID && CLIENT_SECRET);

let MODE = 'mock';
if ((rawEnv === 'sandbox' || rawEnv === 'production') && hasCreds) {
  MODE = rawEnv;
} else if (rawEnv === 'sandbox' || rawEnv === 'production') {
  console.warn(`[mia] MAIB_MIA_ENV=${rawEnv} set but MAIB_CLIENT_ID/MAIB_CLIENT_SECRET missing — falling back to mock mode`);
}

export const MIA_MODE = MODE;
const LIVE = MODE !== 'mock';
const BASE = MODE === 'production' ? PROD_BASE : SANDBOX_BASE;

const round2 = v => Math.round(Number(v) * 100) / 100;

// One-shot flag: set via /api/dev/mock-fail-next to make next mock payment fail
let _mockFailNext = false;
export function setMockFailNext() { _mockFailNext = true; }

// ─── token auth ───────────────────────────────────────────────────────────────

let _token = null; // { accessToken, expiresAt (epoch ms) }

async function getAccessToken() {
  if (_token && Date.now() < _token.expiresAt - 30_000) return _token.accessToken;

  const res = await fetch(`${BASE}/v2/auth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new Error(`maib auth/token failed: HTTP ${res.status} ${data?.errors ? JSON.stringify(data.errors) : ''}`);
  }
  _token = {
    accessToken: data.result.accessToken,
    expiresAt:   Date.now() + Number(data.result.expiresIn) * 1000,
  };
  return _token.accessToken;
}

async function authedFetch(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
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
 * requestPayment({ amountLei, tipLei, orderId, tableNumber, description })
 * Creates a per-transaction Dynamic QR. Returns:
 *   { paymentId, qrId, deepLinkUrl, expiresAt, referenceId, _mock? }
 * `paymentId` === `qrId` in sandbox/production — it's the one identifier maib gives us up
 * front (before a payId exists), so it's what we use everywhere as the correlation key
 * (paymentMeta map, payments.mia_payment_id column, webhook lookups).
 */
export async function requestPayment({ amountLei, tipLei = 0, orderId, tableNumber, description }) {
  if (LIVE) {
    const totalLei  = round2(Number(amountLei) + Number(tipLei));
    const ourOrderId = `nota-${orderId}-${Date.now()}`.slice(0, 100);
    const expiresAt  = new Date(Date.now() + 180_000).toISOString(); // 3 min — matches server.js reconciliation timeout
    const callbackUrl = `${process.env.APP_URL || ''}/api/payment/webhook`;

    const result = await authedFetch('/v2/mia/qr', {
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
 * getPaymentStatus(qrId)
 * Polls maib for the current state of a QR (reconciliation fallback for missed webhooks).
 * Returns { status: 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED' | 'CANCELLED', paidAt, payId }
 * `payId` is only populated once status is PAID (needs a second call — the QR-details
 * endpoint doesn't return it) and is what's needed later for refunds.
 */
export async function getPaymentStatus(qrId) {
  if (LIVE && !String(qrId).startsWith('mock-')) {
    const result = await authedFetch(`/v2/mia/qr/${encodeURIComponent(qrId)}`);
    const statusMap = { Paid: 'PAID', Expired: 'EXPIRED', Cancelled: 'CANCELLED', Inactive: 'FAILED', Active: 'PENDING' };
    const status = statusMap[result.status] || 'PENDING';

    let payId = null, paidAt = null;
    if (status === 'PAID') {
      try {
        const list = await authedFetch(
          `/v2/mia/payments?qrId=${encodeURIComponent(qrId)}&count=1&offset=0&sortBy=executedAt&order=desc`
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
 * cancelPayment(qrId, reason)
 * Best-effort: cancels an active QR on maib's side (expired/abandoned pendings) so it can no
 * longer be paid after we've already released the items. Never throws — our own release must
 * proceed regardless of whether maib's cancel call succeeds.
 */
export async function cancelPayment(qrId, reason = 'Anulat de restaurant') {
  if (!LIVE || !qrId || String(qrId).startsWith('mock-')) return { skipped: true };
  try {
    const result = await authedFetch(`/v2/mia/qr/${encodeURIComponent(qrId)}/cancel`, {
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
 * refundPayment({ payId, amountLei, reason })
 * amountLei omitted → full refund; provided → partial refund (both documented).
 * Returns { refundId, status }. Throws on failure — caller (dashboard route) surfaces the error.
 */
export async function refundPayment({ payId, amountLei = null, reason }) {
  if (!LIVE) throw new Error('Refunds require sandbox or production MIA mode');
  const body = { reason: String(reason || 'Refund solicitat de restaurant').slice(0, 500) };
  if (amountLei != null) body.amount = round2(amountLei);
  const result = await authedFetch(`/v2/payments/${encodeURIComponent(payId)}/refund`, { method: 'POST', body });
  return { refundId: result.refundId, status: result.status };
}

/**
 * simulatePayment({ qrId, amountLei, iban, payerName })
 * Sandbox-only test-pay endpoint — completes a payment against a live sandbox QR so we can
 * exercise the full webhook → settlement loop before real maib credentials exist.
 */
export async function simulatePayment({ qrId, amountLei, iban, payerName }) {
  if (MODE !== 'sandbox') throw new Error('Payment simulation is only available in sandbox mode');
  const result = await authedFetch('/v2/mia/test-pay', {
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
 * verifyAndParseCallback(rawBody)
 * Validates the documented signature scheme and returns a normalized payload, or null if the
 * signature is missing/invalid/unverifiable — fail closed, always.
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
export function verifyAndParseCallback(rawBody) {
  if (!SIGNATURE_KEY) return null; // no key configured — reject everything, fail closed

  let json;
  try {
    json = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
  } catch {
    return null;
  }

  const result = json?.result;
  const providedSig = json?.signature;
  if (!result || typeof providedSig !== 'string') return null;

  const fields = {};
  for (const [key, value] of Object.entries(result)) {
    if (value === null || value === undefined) continue;
    const str = (key === 'amount' || key === 'commission') ? Number(value).toFixed(2) : String(value);
    if (str.trim() !== '') fields[key] = str;
  }
  const orderedKeys = Object.keys(fields).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const joined = orderedKeys.map(k => fields[k]).join(':');
  const hashInput = `${joined}:${SIGNATURE_KEY}`;
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
