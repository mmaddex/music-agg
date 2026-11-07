// TIDAL accounts + tokens, stored encrypted in Postgres so that both the web service and the
// workflow task instances can act on the user's behalf.

import crypto from 'node:crypto';
import { decryptJson, encryptJson } from './crypto.js';
import { tx } from './db/pool.js';
import { refreshTokens, TidalAuthError } from './auth/tidalAuth.js';
import { TidalClient } from './tidal/client.js';
import { log as rootLog, since } from './util/log.js';

/** The user must log in again (refresh token revoked/expired). Not worth retrying. */
export class AuthExpiredError extends Error {
  constructor(message = 'Your TIDAL login has expired. Log in again, then press Retry.') {
    super(message);
    this.permanent = true;
    this.status = 401;
  }
}

export async function upsertAccount(pool, { tidalUserId, username, country, tokens }) {
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, tidal_user_id, username, country, tokens_enc)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tidal_user_id) DO UPDATE
       SET username = EXCLUDED.username, country = EXCLUDED.country,
           tokens_enc = EXCLUDED.tokens_enc, updated_at = now()
     RETURNING id, tidal_user_id, username, country`,
    [crypto.randomUUID(), tidalUserId, username, country, encryptJson(tokens)],
  );
  return rows[0];
}

export async function getAccount(pool, accountId) {
  const { rows } = await pool.query('SELECT id, tidal_user_id, username, country, tokens_enc IS NOT NULL AS has_tokens FROM accounts WHERE id = $1', [accountId]);
  return rows[0] || null;
}

export async function clearTokens(pool, accountId) {
  await pool.query('UPDATE accounts SET tokens_enc = NULL, updated_at = now() WHERE id = $1', [accountId]);
}

async function readTokens(db, accountId, { lock = false } = {}) {
  const { rows } = await db.query(`SELECT tokens_enc FROM accounts WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [accountId]);
  if (!rows[0]?.tokens_enc) throw new AuthExpiredError('Not logged in to TIDAL. Log in again, then press Retry.');
  return decryptJson(rows[0].tokens_enc);
}

/**
 * Return a fresh access token, refreshing under a row lock if needed. `stale` is the token a
 * caller just saw rejected (401); if someone else already replaced it we use theirs.
 */
async function refreshUnderLock(pool, accountId, { clientId, fetchImpl, stale = null, log: parentLog = rootLog }) {
  const log = parentLog.child({ component: 'auth', accountId });
  const reason = stale ? 'rejected' : 'expired';
  const startedAt = performance.now();
  return tx(pool, async (client) => {
    const tokens = await readTokens(client, accountId, { lock: true });
    const replaced = stale && tokens.accessToken !== stale;
    if (replaced || (!stale && Date.now() < tokens.expiresAt)) {
      log.debug('tidal.token.already_refreshed', { reason, waitedMs: since(startedAt) });
      return tokens.accessToken;
    }
    let next;
    try {
      next = await refreshTokens({ clientId, tokens, fetchImpl });
    } catch (err) {
      if (err instanceof TidalAuthError && err.status >= 400 && err.status < 500) {
        log.warn('tidal.token.refresh_refused', { reason, err, action: 'user must log in again' });
        throw new AuthExpiredError();
      }
      log.warn('tidal.token.refresh_failed', { reason, transient: true, err });
      throw err; // network / 5xx: transient
    }
    await client.query('UPDATE accounts SET tokens_enc = $2, updated_at = now() WHERE id = $1', [accountId, encryptJson(next)]);
    log.info('tidal.token.refreshed', { reason, ms: since(startedAt), expiresInS: Math.round((next.expiresAt - Date.now()) / 1000) });
    return next.accessToken;
  });
}

/** A TidalClient acting as this account. Works in any process that can reach the database. */
export function clientForAccount(pool, accountId, { clientId = process.env.TIDAL_CLIENT_ID, fetchImpl = fetch, minIntervalMs, clientOptions = {}, log = rootLog } = {}) {
  let current = null;
  return new TidalClient({
    ...clientOptions,
    fetchImpl,
    minIntervalMs,
    log,
    getAccessToken: async () => {
      const tokens = current || (await readTokens(pool, accountId));
      if (Date.now() < tokens.expiresAt) {
        current = tokens;
        return tokens.accessToken;
      }
      current = null;
      return refreshUnderLock(pool, accountId, { clientId, fetchImpl, log });
    },
    forceRefresh: async () => {
      const stale = current?.accessToken || null;
      current = null;
      return refreshUnderLock(pool, accountId, { clientId, fetchImpl, stale: stale || '__force__', log });
    },
  });
}
