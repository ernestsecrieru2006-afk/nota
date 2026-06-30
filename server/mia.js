/**
 * mia.js — Real MIA Plăți Instant (Request-to-Pay) integration for nota.
 *
 * Set in .env to go live:
 *   MIA_BASE_URL=https://api.mia.md          (confirm exact URL with MIA)
 *   MIA_MERCHANT_ID=your-merchant-id
 *   MIA_SECRET=your-api-secret
 *   MIA_WEBHOOK_SECRET=your-webhook-secret   (for HMAC verification)
 *
 * Without those vars the module returns realistic mock responses automatically.
 *
 * MIA Request-to-Pay flow:
 *   1. nota. server calls requestPayment()  → gets paymentId + deepLinkUrl
 *   2. Guest opens deepLinkUrl in MIA app   → approves payment
 *   3. MIA calls our webhook               → we emit pay-claimed via socket
 *   4. (Fallback) We poll getPaymentStatus() every 3 s if webhook doesn't arrive
 */

import crypto from 'crypto';

const MIA_BASE    = (process.env.MIA_BASE_URL || '').replace(/\/$/, '');
const MERCHANT_ID = process.env.MIA_MERCHANT_ID  || null;
const SECRET      = process.env.MIA_SECRET        || null;
const WH_SECRET   = process.env.MIA_WEBHOOK_SECRET|| null;
const LIVE        = !!(MIA_BASE && MERCHANT_ID && SECRET);

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * requestPayment({ amountLei, orderId, tableNumber, description })
 * Initiates a Request-to-Pay via MIA.
 * Returns { paymentId, deepLinkUrl, expiresAt }
 */
export async function requestPayment({ amountLei, tipLei = 0, orderId, tableNumber, description }) {
  if (LIVE) {
    const totalLei    = Number(amountLei) + Number(tipLei);
    const totalBani   = Math.round(totalLei * 100);   // MIA uses smallest currency unit (bani)
    const referenceId = `nota-${orderId}-${Date.now()}`;
    const callbackUrl = `${process.env.APP_URL || ''}/api/payment/webhook`;

    const body = {
      merchantId:   MERCHANT_ID,
      amount:       totalBani,
      currency:     'MDL',
      referenceId,
      description:  description || `Masă ${tableNumber} — nota.`,
      callbackUrl,
      expirySeconds: 180,   // 3 minutes to pay
    };

    // HMAC-SHA256 signature: merchantId|amount|currency|referenceId
    body.signature = sign(`${MERCHANT_ID}|${totalBani}|MDL|${referenceId}`);

    const res = await fetch(`${MIA_BASE}/api/v1/payment/request`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${SECRET}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MIA requestPayment failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    return {
      paymentId:   data.paymentId   || data.id,
      deepLinkUrl: data.deepLink    || data.deepLinkUrl || data.url,
      expiresAt:   data.expiresAt   || new Date(Date.now() + 180_000).toISOString(),
      referenceId,
    };
  }

  // ── Mock ──────────────────────────────────────────────────────────────────
  const paymentId = `mock-pay-${Date.now()}`;
  return {
    paymentId,
    deepLinkUrl: `https://mock-mia.nota.md/pay/${paymentId}`,
    expiresAt:   new Date(Date.now() + 180_000).toISOString(),
    referenceId: `nota-${orderId}-mock`,
    _mock: true,
  };
}

/**
 * getPaymentStatus(paymentId)
 * Polls MIA for the current status of a payment.
 * Returns { status: 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED', paidAt? }
 */
export async function getPaymentStatus(paymentId) {
  if (LIVE && !paymentId.startsWith('mock-')) {
    const sig = sign(`${MERCHANT_ID}|${paymentId}`);
    const res = await fetch(
      `${MIA_BASE}/api/v1/payment/status?paymentId=${encodeURIComponent(paymentId)}&merchantId=${MERCHANT_ID}&signature=${sig}`,
      { headers: { Authorization: `Bearer ${SECRET}` } }
    );
    if (!res.ok) throw new Error(`MIA status check failed: ${res.status}`);
    const data = await res.json();
    return {
      status:  data.status,          // PENDING | PAID | EXPIRED | FAILED
      paidAt:  data.paidAt || null,
    };
  }

  // Mock: always return PAID after a short delay (simulates user approval)
  return { status: 'PAID', paidAt: new Date().toISOString(), _mock: true };
}

/**
 * verifyWebhookSignature(rawBody, signatureHeader)
 * Returns true if the webhook came from MIA.
 * rawBody must be the raw Buffer/string (not parsed JSON).
 */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!WH_SECRET) {
    // No secret configured → accept in dev, warn loudly
    console.warn('[MIA] MIA_WEBHOOK_SECRET not set — accepting all webhooks (dev mode only!)');
    return true;
  }
  const expected = crypto
    .createHmac('sha256', WH_SECRET)
    .update(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'))
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(signatureHeader || '', 'hex')
  );
}

/**
 * parseWebhookPayload(body)
 * Normalizes a MIA webhook payload to our internal format.
 * MIA sends: { paymentId, referenceId, status, amount, currency, paidAt }
 */
export function parseWebhookPayload(body) {
  return {
    paymentId:   body.paymentId   || body.id,
    referenceId: body.referenceId || body.reference,
    status:      body.status,             // PAID | FAILED | EXPIRED
    amountBani:  body.amount     || 0,
    paidAt:      body.paidAt     || body.timestamp || new Date().toISOString(),
  };
}

// ─── internal ─────────────────────────────────────────────────────────────────

function sign(data) {
  return crypto.createHmac('sha256', SECRET || 'mock-secret').update(data).digest('hex');
}
