# music-agg

A web app that imports music-service exports into **TIDAL**. You log in with your TIDAL
account and upload an export. Then you review the matches, and the app creates the playlists
and adds favourites in your TIDAL account.

Today it supports **YouTube Music (Google Takeout)** and **plain CSV files with title/artist
columns**. The importer is built so Google Play Music, Apple Music and other exports can be
added as small plug-in adapters (see [Adding an export format](#adding-an-export-format)).

The slow, network-heavy work runs as **[Render Workflows](https://render.com/docs/workflows)**:
*matching* (finding each song on TIDAL) and *loading* (writing playlists and favourites).
Each step gets retries with backoff, and an import resumes from its last checkpoint after a
failure, a deploy or a crash.

## Architecture

```
Browser ──► Web service (Express)                     Render Workflow service
            • TIDAL login (OAuth 2.1 + PKCE)            src/workflows/main.js
            • upload → parse → store import
            • start runs ─────── Render SDK ─────────►  matchImport(importId)
            • poll status                                 └─ matchChunk(importId, keys) × N
                    │                                   loadToTidal(importId)
                    ▼                                     └─ writeCollection(importId, collectionId) × M
              Postgres  ◄───────────────────────────────────────┘
              accounts (encrypted TIDAL tokens) · imports · import_tracks (per-track
              checkpoints) · import_targets (per-collection write cursor) · sessions
```

* **Parsing stays in the web service.** It takes under a second, makes no network calls, and
  you see the result right away to pick playlists. Retries would add nothing.
* **Both services and the database are in the Blueprint** (`render.yaml`).
* **Task inputs are only ids.** Track data and TIDAL tokens are read from Postgres, never
  passed as run arguments. Run arguments are visible in the Render Dashboard and capped at 4 MB.

### Why an import survives failures

| Task | Checkpoint | On retry |
| ---- | ---------- | -------- |
| `matchChunk` (~100 tracks) | each track's result is saved as soon as it's known | only tracks still `pending` are processed |
| `writeCollection` (one playlist / favourites) | created playlist id, then a cursor after every 50-track batch | resumes at the next batch; never creates a second playlist |
| roots `matchImport` / `loadToTidal` | status on the import row | fan out only the unfinished work |

* **No double-writes:** each TIDAL write sends an `Idempotency-Key` derived from
  *(import, collection, batch)*. If a batch succeeded but the task crashed before saving the
  cursor, the retry sends the same key and TIDAL replays the original response.
* **Error policy:** the SDK retries any thrown error, so tasks throw only for transient
  problems (429, 5xx, network, timeouts). Permanent problems are recorded instead: one bad
  track, one rejected playlist, or an expired login. A track that keeps failing is given up on
  after 4 tries so it can't block the rest.
* **Expired login:** the import stops with "log in again, then press Retry". After you log in,
  Retry picks up where it stopped.
* **Token refresh** happens under a row lock, so parallel task instances never race each
  other and invalidate the refresh token.

Task settings (`src/workflows/tasks.js`):

| Task | Retries (backoff) | Timeout | Plan |
| ---- | ----------------- | ------- | ---- |
| `matchChunk`, `writeCollection` | 6 × from 15 s, ×2 | 30 min | starter |
| `matchImport`, `loadToTidal` | 2 × from 30 s, ×2 | 12 h | starter |

## TIDAL API usage

Login and endpoints follow TIDAL's
[authorization guide](https://developer.tidal.com/documentation/api-sdk/api-sdk-authorization)
and [API reference](https://tidal-music.github.io/tidal-api-reference/) (v2, JSON:API).
Scopes requested: `user.read search.read playlists.write collection.write`.

| Step | Endpoint |
| ---- | -------- |
| Who's logged in | `GET /users/me` |
| Match by ISRC | `GET /tracks?filter[isrc]=…&include=artists,albums` |
| Match by search | `GET /searchResults?filter[query]=…&include=tracks.artists,tracks.albums` |
| Create playlist | `POST /playlists` (created as `UNLISTED`) |
| Add playlist tracks | `POST /playlists/{id}/relationships/items` (≤ 50 per call) |
| Add favourites | `POST /userCollectionTracks/me/relationships/items` (≤ 50; already-saved tracks come back in `meta.skipped`) |

Matching scores each candidate on title, artist, album, duration and version markers
(live / remix / karaoke …). Each track ends up *matched* (imported by default), *needs review*
(you decide; there's a bulk "accept suggestions" button) or *not found*.

### About the YouTube Music export

Takeout's playlist CSVs contain only **YouTube video ids**, with no song or artist. Titles
come from `music-library-songs.csv` where possible. For the rest, the app asks YouTube's
public oEmbed endpoint for the video's title and channel; no API key is needed. Matches built
from video titles must clear a stricter threshold. Private or deleted videos show as
*not found*.

## Running locally

Requires Node 20+ and a Postgres database.

```bash
npm install
cp .env.example .env        # set TIDAL_CLIENT_ID, DATABASE_URL, TOKEN_ENCRYPTION_KEY
node --env-file=.env src/server.js
```

Without `RENDER_API_KEY`/`WORKFLOW_SLUG` the web service runs the same task functions
**inline**, in-process, with the same retry policy. That's convenient for development but
has no durability across restarts. To exercise real workflow runs locally, use the Render CLI
(v2.11+):

```bash
render workflows dev -- node src/workflows/main.js     # local task server on :8120
render workflows tasks list --local                    # in another terminal
```

Register `http://localhost:3000/auth/callback` as a redirect URI for your TIDAL app.

Tests:

```bash
npm test          # everything; Postgres-backed tests are skipped without TEST_DATABASE_URL
npm run test:db   # uses TEST_DATABASE_URL (default: local musicagg_test database)
npm run inspect-export -- path/to/export.zip    # what an export would import, no TIDAL calls
```

## Deploying to Render

`render.yaml` defines everything: the web service, the **Workflow service**
(`music-agg-workflows`), the `music-agg-db` Postgres database, and the `music-agg-shared` env
group. The env group holds a generated `TOKEN_ENCRYPTION_KEY` that both services share.

1. Dashboard → **New → Blueprint** → this repo. When prompted, enter:
   * `TIDAL_CLIENT_ID` on **both** services (same value)
   * `RENDER_API_KEY` on the web service (Account settings → API keys), so it can start runs
   * `TIDAL_REDIRECT_URI` only if you use a custom domain; otherwise leave it blank
2. The web service gets `DATABASE_URL` and `WORKFLOW_SLUG` automatically (`fromDatabase` /
   `fromService … property: slug`), and the four tasks register when the Workflow service
   deploys. `/api/me` reports `workflowMode: "render"` once it's wired.
3. **TIDAL redirect URI:** register `https://<web-service>.onrender.com/auth/callback` (the exact
   URL is on the service page). For a custom domain, register that domain's callback and set
   `TIDAL_REDIRECT_URI` to it.

Both services must use the **same** `TOKEN_ENCRYPTION_KEY` (the shared group handles this), or
tasks can't read the user's TIDAL tokens.

## Configuration

| Variable | Used by | Required | Notes |
| -------- | ------- | -------- | ----- |
| `TIDAL_CLIENT_ID` | web, workflow | yes | From developer.tidal.com |
| `DATABASE_URL` | web, workflow | yes | Same database for both |
| `TOKEN_ENCRYPTION_KEY` | web, workflow | yes | Same value for both |
| `SESSION_SECRET` | web | prod | Signs the session cookie |
| `RENDER_API_KEY`, `WORKFLOW_SLUG` | web | prod | Start runs on Render Workflows (otherwise inline) |
| `WORKFLOW_MODE` | web | no | Force `render` or `inline` |
| `TIDAL_REDIRECT_URI` | web | no | Default `$PUBLIC_BASE_URL/auth/callback` |
| `PUBLIC_BASE_URL` | web | no | Default `$RENDER_EXTERNAL_URL` or `http://localhost:$PORT` |
| `TIDAL_MIN_INTERVAL_MS` | workflow | no | Spacing between TIDAL calls per run (default 200) |
| `MATCH_CHUNK_SIZE` / `MATCH_PARALLELISM` | workflow | no | Default 100 / 2 |
| `DATABASE_SSL` | both | no | Override TLS auto-detection |
| `MAX_UPLOAD_MB` / `IMPORT_RETENTION_DAYS` | web | no | Default 100 / 30 |

`TIDAL_CLIENT_SECRET` is **not** used: TIDAL's user-login (PKCE) flow needs only the client id.

## Adding an export format

1. Create `src/importers/adapters/<name>.js` exporting
   `{ id, label, description, detect(bundle), parse(bundle) }`:
   * `bundle.files` is a list of `{ path, size, text }` covering every CSV/TSV/TXT/JSON/XML/M3U
     file in the upload, whether that was a zip or a single file. macOS junk is already removed
     and UTF-8/UTF-16 is already decoded.
   * `detect` returns a confidence from 0 to 1. The highest score wins, and the generic CSV
     adapter scores 0.5.
   * `parse` returns `{ collections, warnings }` built with `makeCollection` / `makeTrack` from
     `src/importers/model.js`. Include `isrc` whenever the source has it, because ISRC matching
     is exact.
2. Add it to `ADAPTERS` in `src/importers/registry.js`.
3. Add a small fixture and test in `test/`.

To accept a new container type (for example `.tar.gz`), add a loader to `LOADERS` in
`src/importers/bundle.js`. Zip uploads are read with streaming size limits, so declared sizes
in a malicious archive are never trusted.
