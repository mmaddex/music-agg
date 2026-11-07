// One shared, self-adjusting request pace per TIDAL account, kept in Postgres so that every task
// run acting for that account (parallel matchChunk runs, writeCollection) uses the same budget.
//
// TIDAL's rate limit is shared by all requests for one account: when two runs paced themselves
// independently they both hit 429 at the same moments and each kept sending during the other's
// back-off. Here instead:
//
//   reserve()      before every request: atomically take the next slot (one UPDATE). Slots are
//                  `interval_ms` apart across all runs; the database's clock decides, so task
//                  instances agree. Returns how long to wait.
//   rateLimited()  on a 429: nobody gets a slot before Retry-After has passed, and the interval
//                  grows ×1.5 (once per pause, however many requests hit the 429).
//   succeeded()    after every 2xx: every 20 successes in a row shrink the interval by 5%, down to
//                  the floor (TIDAL_MIN_INTERVAL_MS). The pace settles just under TIDAL's limit.
//
// The learned interval is kept between imports; after an hour unused it starts over from
// TIDAL_START_INTERVAL_MS. If the database can't be reached, the client falls back to its own
// local spacing rather than failing the request.

export const PACE = {
  growth: 1.5,
  shrink: 0.95,
  successesToShrink: 20,
  maxIntervalMs: 10_000,
};

// $1 account, $2 start interval, $3 floor
const RESERVE = `
  WITH start AS (SELECT GREATEST($2::int, $3::int) AS ms)
  INSERT INTO tidal_pace AS p (account_id, interval_ms, next_at, updated_at)
  SELECT $1, ms, clock_timestamp() + make_interval(secs => ms / 1000.0::float8), clock_timestamp() FROM start
  ON CONFLICT (account_id) DO UPDATE SET
    interval_ms = CASE WHEN p.updated_at < clock_timestamp() - interval '1 hour' THEN EXCLUDED.interval_ms
                       ELSE GREATEST(p.interval_ms, $3::int) END,
    next_at = CASE WHEN p.updated_at < clock_timestamp() - interval '1 hour' THEN EXCLUDED.next_at
                   ELSE GREATEST(p.next_at, clock_timestamp()) + make_interval(secs => GREATEST(p.interval_ms, $3::int) / 1000.0::float8) END,
    paused_until = CASE WHEN p.updated_at < clock_timestamp() - interval '1 hour' THEN NULL ELSE p.paused_until END,
    updated_at = clock_timestamp()
  RETURNING interval_ms,
            EXTRACT(EPOCH FROM (next_at - make_interval(secs => interval_ms / 1000.0::float8) - clock_timestamp())) * 1000 AS wait_ms`;

// $1 account, $2 Retry-After ms, $3 max interval, $4 growth
const RATE_LIMITED = `
  UPDATE tidal_pace SET
    interval_ms = CASE WHEN paused_until IS NULL OR paused_until < clock_timestamp()
                       THEN LEAST($3::int, CEIL(interval_ms * $4::float8)::int) ELSE interval_ms END,
    paused_until = GREATEST(COALESCE(paused_until, clock_timestamp()), clock_timestamp() + make_interval(secs => $2::float8 / 1000)),
    next_at = GREATEST(next_at, clock_timestamp() + make_interval(secs => $2::float8 / 1000)),
    updated_at = clock_timestamp()
  WHERE account_id = $1
  RETURNING interval_ms`;

// $1 account, $2 floor, $3 shrink
const SHRINK = `
  UPDATE tidal_pace SET interval_ms = GREATEST($2::int, FLOOR(interval_ms * $3::float8)::int), updated_at = clock_timestamp()
  WHERE account_id = $1 AND (paused_until IS NULL OR paused_until < clock_timestamp())
  RETURNING interval_ms`;

/**
 * @returns pacer for TidalClient: { reserve(), rateLimited(retryAfterMs), succeeded() }
 *          reserve() resolves to { waitMs, intervalMs } or null if the database failed.
 */
export function dbPacer(pool, accountId, { minIntervalMs = 200, startIntervalMs = 750, log } = {}) {
  let streak = 0;
  let warned = false;
  const failed = (op, err) => {
    // Warn once per client; the request still goes out, locally spaced.
    if (!warned) log?.warn('tidal.pace.db_failed', { op, err, action: 'using local spacing' });
    warned = true;
    return null;
  };

  return {
    async reserve() {
      try {
        const { rows } = await pool.query(RESERVE, [accountId, startIntervalMs, minIntervalMs]);
        return { waitMs: Math.max(0, Math.round(Number(rows[0].wait_ms))), intervalMs: rows[0].interval_ms };
      } catch (err) {
        return failed('reserve', err);
      }
    },

    /** @returns true if the shared pace now holds everyone back (the caller needn't sleep). */
    async rateLimited(retryAfterMs) {
      streak = 0;
      try {
        const { rows } = await pool.query(RATE_LIMITED, [accountId, Math.max(0, Math.round(retryAfterMs)), PACE.maxIntervalMs, PACE.growth]);
        if (!rows.length) return false;
        log?.info('tidal.pace.slower', { intervalMs: rows[0].interval_ms, pausedForMs: Math.round(retryAfterMs) });
        return true;
      } catch (err) {
        failed('rateLimited', err);
        return false;
      }
    },

    async succeeded() {
      streak += 1;
      if (streak < PACE.successesToShrink) return;
      streak = 0;
      try {
        const { rows } = await pool.query(SHRINK, [accountId, minIntervalMs, PACE.shrink]);
        if (rows.length) log?.debug('tidal.pace.faster', { intervalMs: rows[0].interval_ms });
      } catch (err) {
        failed('succeeded', err);
      }
    },
  };
}
