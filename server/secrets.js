/**
 * secrets.js — symmetric encryption for per-restaurant credentials at rest (maib + Poster).
 *
 * Not a secrets manager — a pragmatic "never store plaintext in the DB" layer. Protects against
 * a DB dump exposing credentials; doesn't protect against a compromised server process reading
 * its own env. Credentials are still never returned to any client or logged anywhere.
 *
 * Key material: prefer a dedicated CREDENTIAL_ENCRYPTION_KEY env var. If unset, falls back to
 * deriving from JWT_SECRET (the original scheme, kept as the default so no new required env var
 * is forced on existing deployments). The JWT_SECRET-derived key has a real operational hazard:
 * JWT_SECRET is expected to rotate occasionally (e.g. to force-logout all sessions), and doing so
 * would silently make every already-stored credential undecryptable — decryptSecret would start
 * returning null for all of them, degrading every restaurant to demo mode at once with no warning
 * beyond a log line. CREDENTIAL_ENCRYPTION_KEY decouples the two: rotate JWT_SECRET freely without
 * touching stored credentials.
 *
 * Migration path (safe, zero-downtime, no forced re-entry):
 *   - encryptSecret always uses the CURRENT key (CREDENTIAL_ENCRYPTION_KEY if set, else the
 *     legacy JWT_SECRET-derived one — so behavior is unchanged for anyone who never sets it).
 *   - decryptSecret tries the current key first; if that fails AND a dedicated key is configured
 *     (so current ≠ legacy), it retries with the legacy JWT_SECRET-derived key. Values encrypted
 *     before CREDENTIAL_ENCRYPTION_KEY existed keep decrypting transparently forever — nobody
 *     needs to re-paste credentials just because this env var got introduced.
 *   - Any credential that gets re-saved after that point (owner edits it, or an ops-triggered
 *     re-encrypt) is written under the new key on its next encryptSecret call, so the fleet
 *     migrates gradually and non-disruptively as data is naturally touched.
 */

import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'nota-dev-secret-change-in-production';
const KEY_LEGACY  = crypto.createHash('sha256').update(`${JWT_SECRET}:maib-creds-v1`).digest(); // 32 bytes

const DEDICATED_KEY_RAW = process.env.CREDENTIAL_ENCRYPTION_KEY || null;
const KEY_CURRENT = DEDICATED_KEY_RAW
  ? crypto.createHash('sha256').update(`${DEDICATED_KEY_RAW}:cred-key-v1`).digest()
  : KEY_LEGACY;

// Only meaningfully different from KEY_LEGACY when CREDENTIAL_ENCRYPTION_KEY is actually set —
// used to decide whether the legacy-key decrypt fallback below is worth attempting at all.
const HAS_DEDICATED_KEY = !!DEDICATED_KEY_RAW;

export function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY_CURRENT, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function tryDecrypt(buf, key) {
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function decryptSecret(stored) {
  if (!stored) return null;
  const buf = Buffer.from(stored, 'base64');
  try {
    return tryDecrypt(buf, KEY_CURRENT);
  } catch {
    // Fall through to the legacy key only if one is actually configured to differ — no point
    // retrying with the same key twice.
  }
  if (HAS_DEDICATED_KEY) {
    try {
      return tryDecrypt(buf, KEY_LEGACY);
    } catch { /* fall through to the shared failure log below */ }
  }
  console.error('[secrets] decrypt failed under all known keys (corrupt data, or JWT_SECRET rotated with no CREDENTIAL_ENCRYPTION_KEY set)');
  return null;
}
