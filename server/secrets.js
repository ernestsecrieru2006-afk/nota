/**
 * secrets.js — symmetric encryption for per-restaurant maib credentials at rest.
 *
 * Not a secrets manager — a pragmatic "never store plaintext in the DB" layer, keyed off
 * JWT_SECRET (already required in production) via a KDF, so no new required env var. Protects
 * against a DB dump exposing credentials; doesn't protect against a compromised server process
 * reading its own env. Credentials are still never returned to any client or logged anywhere.
 */

import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'nota-dev-secret-change-in-production';
const KEY = crypto.createHash('sha256').update(`${JWT_SECRET}:maib-creds-v1`).digest(); // 32 bytes

export function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptSecret(stored) {
  if (!stored) return null;
  try {
    const buf = Buffer.from(stored, 'base64');
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('[secrets] decrypt failed (corrupt data or key mismatch)', err.message);
    return null;
  }
}
