/**
 * email.js — receipt email sending for nota.
 *
 * Uses Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email) via plain
 * fetch — no SDK/dependency, same style as telegram.js's fetch-based bot calls.
 *
 * Mock mode (no RESEND_API_KEY): logs the receipt instead of sending, so local/demo dev never
 * needs real email credentials — consistent with mia.js/telegram.js's "off unless configured".
 *
 * Deliberately stateless: nothing about the recipient email is stored anywhere by this module or
 * its caller — it's used for exactly one outbound send and then discarded.
 */

const RESEND_API = 'https://api.resend.com/emails';
const FROM = process.env.EMAIL_FROM || 'nota. <receipts@paynota.com>';

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function buildReceiptHtml({ restaurantName, itemLines, tipLei, totalLei, paidAt }) {
  const rows = (itemLines || []).map(l =>
    `<tr><td style="padding:4px 0;color:#191c1d">${esc(l.name)}</td><td style="padding:4px 0;text-align:right;color:#191c1d">${esc(l.price)}</td></tr>`
  ).join('');
  const dateTxt = new Date(paidAt).toLocaleString('ro-MD', { dateStyle: 'medium', timeStyle: 'short' });
  return `
<div style="font-family:Georgia,serif;max-width:420px;margin:0 auto;padding:24px;background:#fff8f5;color:#191c1d">
  <div style="text-align:center;font-size:22px;font-weight:700;color:#00333c;margin-bottom:4px">nota<span style="color:#C5A059">.</span></div>
  <div style="text-align:center;font-size:12px;color:#775a19;text-transform:uppercase;letter-spacing:.08em;margin-bottom:20px">Bon de plată</div>
  <div style="background:#fff;border:1px solid #e9e1dc;border-radius:12px;padding:18px 20px">
    <div style="font-size:15px;font-weight:700;margin-bottom:2px">${esc(restaurantName)}</div>
    <div style="font-size:12px;color:#70787b;margin-bottom:14px">${esc(dateTxt)}</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">${rows}</table>
    <div style="border-top:1px solid #e9e1dc;margin-top:10px;padding-top:10px;font-size:13px;display:flex;justify-content:space-between">
      <span>Bacșiș</span><span>${esc(tipLei)} MDL</span>
    </div>
    <div style="margin-top:6px;font-size:16px;font-weight:700;display:flex;justify-content:space-between">
      <span>Total achitat</span><span>${esc(totalLei)} MDL</span>
    </div>
  </div>
  <div style="text-align:center;font-size:11px;color:#70787b;margin-top:16px;line-height:1.6">
    Acesta este un bon informativ trimis de nota. Bonul fiscal electronic rămâne emis de casa restaurantului.
  </div>
</div>`;
}

export async function sendReceiptEmail({ to, restaurantName, itemLines, tipLei, totalLei, paidAt }) {
  const html = buildReceiptHtml({ restaurantName, itemLines, tipLei, totalLei, paidAt });
  if (!process.env.RESEND_API_KEY) {
    console.log(`[email:mock] receipt -> ${to} — ${restaurantName}, total ${totalLei} MDL (RESEND_API_KEY not set, not actually sent)`);
    return { ok: true, mock: true };
  }
  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: FROM, to: [to], subject: `Bonul tău — ${restaurantName}`, html }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[email] receipt send failed', res.status, body.slice(0, 200));
      return { ok: false, error: 'Trimiterea a eșuat' };
    }
    return { ok: true };
  } catch (err) {
    console.error('[email] receipt send error', err.message);
    return { ok: false, error: 'Nu s-a putut trimite emailul' };
  }
}

// Same email + template, but framed as a service-recovery note (see server.js's
// /api/dashboard/feedback/:id/reply) rather than a payment receipt.
export async function sendApologyEmail({ to, restaurantName, message }) {
  const html = `
<div style="font-family:Georgia,serif;max-width:420px;margin:0 auto;padding:24px;background:#fff8f5;color:#191c1d">
  <div style="text-align:center;font-size:22px;font-weight:700;color:#00333c;margin-bottom:4px">nota<span style="color:#C5A059">.</span></div>
  <div style="text-align:center;font-size:12px;color:#775a19;text-transform:uppercase;letter-spacing:.08em;margin-bottom:20px">Mesaj de la ${esc(restaurantName)}</div>
  <div style="background:#fff;border:1px solid #e9e1dc;border-radius:12px;padding:18px 20px;font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(message)}</div>
</div>`;
  if (!process.env.RESEND_API_KEY) {
    console.log(`[email:mock] apology -> ${to} — from ${restaurantName}: ${message.slice(0, 100)}`);
    return { ok: true, mock: true };
  }
  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: FROM, to: [to], subject: `Un mesaj din partea ${restaurantName}`, html }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[email] apology send failed', res.status, body.slice(0, 200));
      return { ok: false, error: 'Trimiterea a eșuat' };
    }
    return { ok: true };
  } catch (err) {
    console.error('[email] apology send error', err.message);
    return { ok: false, error: 'Nu s-a putut trimite emailul' };
  }
}
