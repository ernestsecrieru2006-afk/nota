// ── MIA "Request-to-Pay" integration ────────────────────────────────────────
//
// MOCK — swap this file's function bodies for real bank API calls once you
// have MIA Moldova credentials. The function SIGNATURES stay identical so
// server.js doesn't need changes.
//
// Real MIA documentation:
//   https://mia.md  →  ask your MIA account manager for the API spec.
//   Env variables you'll need:
//     MIA_MERCHANT_ID  — your merchant identifier from the bank
//     MIA_SECRET       — API secret / Bearer token
//     MIA_WEBHOOK_SECRET — to verify webhook signatures
//
// Typical live flow:
//   1. POST /api/payment/initiate  →  server calls requestPayment()
//   2. Server receives { paymentId, deepLinkUrl }
//   3. Client redirects the customer to deepLinkUrl (opens their bank app)
//   4. Customer confirms in bank app → bank POSTs to our /api/payment/webhook
//   5. Webhook verifies signature, calls confirmPayment(paymentId)
//   6. Server emits socket event to mark items paid

// ---------------------------------------------------------------------------
// requestPayment
// ---------------------------------------------------------------------------
// Initiates a Request-to-Pay at the bank and returns the payment ID plus
// the URL that opens the customer's bank app.
//
// In production replace the body with a real fetch to MIA's API.
export async function requestPayment({ amountLei, merchantFiscalCode, reference, callbackUrl }) {
  // ── REPLACE WITH REAL MIA API CALL ──────────────────────────────────────
  // const res = await fetch('https://api.mia.md/v1/rtp', {
  //   method: 'POST',
  //   headers: {
  //     'Authorization': `Bearer ${process.env.MIA_SECRET}`,
  //     'Content-Type': 'application/json',
  //   },
  //   body: JSON.stringify({
  //     merchantId: process.env.MIA_MERCHANT_ID,
  //     amount:     { value: amountLei, currency: 'MDL' },
  //     reference,
  //     callbackUrl,
  //   }),
  // });
  // if (!res.ok) throw new Error(`MIA API error: ${res.status}`);
  // const data = await res.json();
  // return { paymentId: data.id, deepLinkUrl: data.rtpLink, expiresIn: data.expiresIn };
  // ── END REPLACE ──────────────────────────────────────────────────────────

  // Mock: create a fake payment ID. The client shows the simulated bank screen
  // instead of redirecting to a real bank URL.
  const paymentId = `mck_${reference}_${Date.now()}`;
  console.log(`[mock-mia] payment initiated — id: ${paymentId}, amount: ${amountLei} MDL`);
  return { paymentId, deepLinkUrl: null, expiresIn: 300 };
}

// ---------------------------------------------------------------------------
// getPaymentStatus
// ---------------------------------------------------------------------------
// Checks the current status of a payment request.
// Called by the webhook or a polling fallback.
//
// Possible statuses: 'pending' | 'confirmed' | 'rejected' | 'expired'
export async function getPaymentStatus(paymentId) {
  // ── REPLACE WITH REAL MIA API CALL ──────────────────────────────────────
  // const res = await fetch(`https://api.mia.md/v1/rtp/${paymentId}`, {
  //   headers: { 'Authorization': `Bearer ${process.env.MIA_SECRET}` },
  // });
  // if (!res.ok) throw new Error(`MIA API error: ${res.status}`);
  // return res.json(); // { status, paymentId, confirmedAt? }
  // ── END REPLACE ──────────────────────────────────────────────────────────

  // Mock: confirmation happens via the socket event from the bank screen,
  // not via polling — so this is never actually called in the demo.
  return { paymentId, status: 'pending' };
}

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// ---------------------------------------------------------------------------
// Call this at the top of POST /api/payment/webhook to ensure the request
// really comes from MIA and not a random caller.
export function verifyWebhookSignature(rawBody, signatureHeader) {
  // ── REPLACE WITH REAL HMAC VERIFICATION ─────────────────────────────────
  // import { createHmac } from 'crypto';
  // const expected = createHmac('sha256', process.env.MIA_WEBHOOK_SECRET)
  //   .update(rawBody).digest('hex');
  // return signatureHeader === `sha256=${expected}`;
  // ── END REPLACE ──────────────────────────────────────────────────────────

  return true; // mock: always valid
}
