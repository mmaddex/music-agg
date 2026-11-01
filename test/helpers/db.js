// Gives each test file its own throwaway schema in TEST_DATABASE_URL.
// Tests that need Postgres are skipped when TEST_DATABASE_URL is not set.
import crypto from 'node:crypto';
import pg from 'pg';
import { createPool, migrate } from '../../src/db/pool.js';

export const hasDb = Boolean(process.env.TEST_DATABASE_URL);

export async function testPool() {
  const base = process.env.TEST_DATABASE_URL;
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.toString(), { max: 10 });
  await migrate(pool);

  return {
    pool,
    async close() {
      await pool.end();
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      await c.query(`DROP SCHEMA ${schema} CASCADE`);
      await c.end();
    },
  };
}
