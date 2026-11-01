import { readFile } from 'node:fs/promises';
import pg from 'pg';

/**
 * Create a pg Pool from a connection string.
 *
 * Render's *internal* database URLs (host like "dpg-xxxx-a") are plain TCP on the private
 * network; *external* URLs (host like "dpg-xxxx-a.oregon-postgres.render.com") need TLS.
 * Set DATABASE_SSL=true|false to override the guess.
 */
export function createPool(connectionString = process.env.DATABASE_URL, { max = 5 } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  const host = new URL(connectionString).hostname;
  const override = process.env.DATABASE_SSL;
  const guess = host.includes('.') && host !== '127.0.0.1' && host !== 'localhost';
  const ssl = override ? override === 'true' : guess;
  return new pg.Pool({ connectionString, max, ssl: ssl ? { rejectUnauthorized: false } : false });
}

const SCHEMA_URL = new URL('./schema.sql', import.meta.url);
const MIGRATION_LOCK = 7_301_997; // arbitrary app-wide advisory lock id

/** Apply schema.sql (idempotent). Safe to call from several processes at once. */
export async function migrate(pool) {
  const sql = await readFile(SCHEMA_URL, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

/** Run fn(client) inside a transaction. */
export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
