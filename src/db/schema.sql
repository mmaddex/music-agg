-- Shared, durable state for the web service and the Render Workflow tasks.
-- Every statement is idempotent; migrate.js runs this file on startup under an advisory lock.

-- A TIDAL user who has logged in. Tokens are AES-256-GCM encrypted (see src/crypto.js).
CREATE TABLE IF NOT EXISTS accounts (
  id             uuid PRIMARY KEY,
  tidal_user_id  text NOT NULL UNIQUE,
  username       text,
  country        text,
  tokens_enc     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One uploaded export and its progress through match → load.
--   status: parsed | matching | matched | loading | done | failed
--   stage:  which workflow last ran / should be retried: match | load
CREATE TABLE IF NOT EXISTS imports (
  id                uuid PRIMARY KEY,
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  filename          text NOT NULL,
  format            text NOT NULL,
  format_label      text NOT NULL,
  library           jsonb NOT NULL,          -- collections + tracks, as parsed
  warnings          jsonb NOT NULL DEFAULT '[]',
  selected          jsonb NOT NULL DEFAULT '[]',  -- collection ids chosen for matching
  country_code      text,
  status            text NOT NULL,
  stage             text,
  error             text,
  match_run_id      text,
  load_run_id       text,
  dispatch_count    integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS imports_account_idx ON imports (account_id, created_at DESC);

-- Checkpoint per unique source track: written as soon as that track is matched.
--   status: pending | matched | review | not_found | error
CREATE TABLE IF NOT EXISTS import_tracks (
  import_id   uuid NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  key         text NOT NULL,
  track       jsonb NOT NULL,               -- source track, incl. YouTube enrichment once done
  status      text NOT NULL DEFAULT 'pending',
  match       jsonb,
  attempts    integer NOT NULL DEFAULT 0,   -- transient failures for this track
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_id, key)
);
CREATE INDEX IF NOT EXISTS import_tracks_pending_idx ON import_tracks (import_id) WHERE status = 'pending';

-- Checkpoint per collection being written to TIDAL.
--   status: pending | done | failed
CREATE TABLE IF NOT EXISTS import_targets (
  import_id          uuid NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  collection_id      text NOT NULL,
  position           integer NOT NULL,
  kind               text NOT NULL,          -- playlist | favorites
  name               text NOT NULL,
  description        text,
  created_at_source  text,
  items              jsonb NOT NULL,         -- [{ id, addedAt, key, albumId }] TIDAL track ids, in order
  tidal_playlist_id  text,
  batches_done       integer NOT NULL DEFAULT 0,
  added              integer NOT NULL DEFAULT 0,
  skipped            integer NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'pending',
  error              text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_id, collection_id)
);

-- Added later; ADD COLUMN IF NOT EXISTS keeps existing databases in step.
--   unimported:  source tracks of this collection that did not end up in TIDAL, with the reason
--                [{ key, title, artist, album, url, reason, detail }]
--   albums:      favourites only: albums saved whole instead of as loose tracks
--                [{ id, title, artists, trackCount }]; NULL = not worked out yet
ALTER TABLE import_targets ADD COLUMN IF NOT EXISTS unimported jsonb NOT NULL DEFAULT '[]';
ALTER TABLE import_targets ADD COLUMN IF NOT EXISTS albums jsonb;
ALTER TABLE import_targets ADD COLUMN IF NOT EXISTS albums_done integer NOT NULL DEFAULT 0;
ALTER TABLE import_targets ADD COLUMN IF NOT EXISTS albums_added integer NOT NULL DEFAULT 0;

-- Why an import stopped without finishing, when its workflow run ended on its own:
--   cancelled   | the run was cancelled (e.g. from the Render dashboard)
--   interrupted | the run ended (crashed, failed or returned) while the import was still active
-- NULL for imports that finished, are running, or failed with an error the app recorded itself.
ALTER TABLE imports ADD COLUMN IF NOT EXISTS stopped_reason text;

-- Shared request pace per TIDAL account (src/tidal/pacer.js): every task run reserves its next
-- request slot here, so parallel runs share TIDAL's per-account rate limit instead of colliding.
CREATE TABLE IF NOT EXISTS tidal_pace (
  account_id    uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  interval_ms   integer NOT NULL,             -- current gap between requests (learned)
  next_at       timestamptz NOT NULL,         -- earliest time the next slot can start
  paused_until  timestamptz,                  -- set from Retry-After on a 429
  updated_at    timestamptz NOT NULL DEFAULT now()
);
