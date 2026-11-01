// AES-256-GCM for TIDAL tokens at rest. The web service and the workflow tasks must share
// the same TOKEN_ENCRYPTION_KEY (any long random string; it is hashed to 32 bytes).

import crypto from 'node:crypto';

function keyFrom(secret) {
  if (!secret) throw new Error('TOKEN_ENCRYPTION_KEY is not set.');
  return crypto.createHash('sha256').update(String(secret)).digest();
}

export function encryptJson(value, secret = process.env.TOKEN_ENCRYPTION_KEY) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decryptJson(payload, secret = process.env.TOKEN_ENCRYPTION_KEY) {
  const [version, iv, tag, body] = String(payload).split('.');
  if (version !== 'v1') throw new Error('Unknown token encryption format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8'));
}

/**
 * Deterministic UUID-shaped key from parts. Used as TIDAL Idempotency-Key so that a retried
 * workflow step sends the *same* key as the attempt that may already have succeeded.
 */
export function deterministicKey(...parts) {
  const h = crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
