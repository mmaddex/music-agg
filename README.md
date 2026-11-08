# music-agg

A web app that imports music-service exports into **TIDAL**. You log in with your TIDAL
account and upload an export. Then you review the matches, and the app creates the playlists
and adds favourites in your TIDAL account.

Today it supports **YouTube Music (Google Takeout)**, **Google Play Music (Google Takeout)**,
**Apple Music (Apple's privacy export)** and **plain CSV files with title/artist columns**.
Multi-part exports are uploaded together in one go (up to 10 files, 1 GB each). Uploads are
streamed to temporary files and deleted after parsing, so large exports full of audio don't
use memory; only the files an adapter can read are decompressed. The importer is built so other services can be added as small plug-in
adapters (see [Adding an export format](#adding-an-export-format)).

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
* **Cancelled or interrupted runs:** if an import still says matching/importing but Render
  reports its workflow run as `canceled`, `failed`, or finished without completing it, the
  import is marked **Cancelled** or **Interrupted** (checked when the import or the recent-imports
  list is viewed, at most every 30 s per import). Retry resumes from the checkpoints. A run that
  is pending, running or paused, or a status the API can't return, leaves the import alone.
* **Expired login:** the import stops with "log in again, then press Retry". After you log in,
  Retry picks up where it stopped.
* **Rate limits:** TIDAL limits requests per account, so all task runs for one account share
  one pace (`tidal_pace` table, `src/tidal/pacer.js`). Each request reserves the next slot; a 429
  pauses every run until `Retry-After` and widens the gap ×1.5; every 20 successes narrow it 5%.
  The pace settles just under TIDAL's limit instead of hitting it, and is remembered between
  imports (reset after an hour idle).
* **Token refresh** happens under a row lock, so parallel task instances never race each
  other and invalidate the refresh token.

Task settings (`src/workflows/tasks.js`):

| Task | Retries (backoff) | Timeout | Plan |
| ---- | ----------------- | ------- | ---- |
| `matchChunk`, `writeCollection` | 6 × from 15 s, ×2 | 30 min | flex |
| `matchImport`, `loadToTidal` | 2 × from 30 s, ×2 | 12 h | flex |

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
| Save whole albums | `POST /userCollectionAlbums/me/relationships/items` (≤ 50) |
| Album of a track | `GET /tracks?filter[id]=…&include=albums` (≤ 20 ids; only for matches saved before album ids were recorded) |
| Album track list | `GET /albums/{id}?include=items,artists`, then `GET /albums/{id}/relationships/items?page[cursor]=…` |

Matching scores each candidate on title, artist, album, duration and version markers
(live / remix / karaoke …). Each track ends up *matched* (imported by default), *needs review*
(you decide; there's a bulk "accept suggestions" button) or *not found*.

### Whole albums (favourites only)

Before adding your liked songs, the load step groups them by the TIDAL album each one matched
to. If you have the whole album, it's saved to My Collection › Albums and those tracks are
**not** also added one by one. Everything else is added as individual favourite tracks.
"The whole album" means either:

* **exact:** every track TIDAL lists on the album is in your liked songs, or
* **expanded edition:** TIDAL only has a Deluxe / Expanded / Anniversary / Remastered … edition
  with songs your source never had. It's saved when, in album order, every track up to your last
  one is present or is an obvious extra (Demo, Live, Remix, Bonus …); the rest is treated as the
  bonus tail (including whole extra discs); you have at least half its tracks and at least 3; and,
  if your export has album names, yours matches TIDAL's title without the edition suffix.

* Singles are never saved as albums, and an album needs at least 2 tracks.
* "Every track" is judged by TIDAL track id. If some songs matched a different release of the
  album (deluxe edition, compilation, single), the album isn't complete and its tracks are added
  individually.
* Playlists are not affected: a playlist keeps its tracks in order.
* If album lookups fail permanently, the tracks are added individually (`load.albums.plan_failed`
  in the logs). If TIDAL refuses an album when saving it, its tracks are added instead.

The done screen lists the albums saved for each collection.

### Tracks that weren't imported

Every source track that didn't end up in TIDAL is recorded on its collection with title,
artist, album, source link and a reason:

| Reason | Meaning |
| ------ | ------- |
| `not_found_on_tidal` | no match on TIDAL |
| `match_not_accepted` | only a possible match was found and it wasn't accepted on the review screen |
| `excluded_by_you` | you unticked it on the review screen |
| `match_error` | matching kept failing for this track |
| `unavailable_on_tidal` | TIDAL refused it at write time (`NOT_FOUND`: not available for your account/country) |
| `write_failed` | the collection stopped after repeated errors; cleared when you press Retry |
| `own_audio_file` | an audio file in the export (e.g. an MP3 you uploaded to Google Play Music). TIDAL only adds songs from its catalogue and can't store your own audio |

Audio files are listed under the collection **Your audio files**, one row per file (duplicate
copies listed once). The `audio_file` column holds the file's path inside the export, on those
rows and on any other row whose song has an audio file, so you can tell when an MP3 of a
missing song exists. When the file's song is also in the export's song lists, the row's detail
says whether that song was added from TIDAL's catalogue anyway.

The done screen shows the count and a **Download the list (CSV)** link
(`GET /api/imports/{id}/not-imported.csv`). The record is deleted with the import after
`IMPORT_RETENTION_DAYS` (default 30), so download the CSV to keep it.

**Songs missing from TIDAL** (linked from Recent imports and the done screen) puts these
records from every import into one table you can search and filter by source and reason
(`GET /api/missing`, or `GET /api/missing.csv` for all of it as one CSV). A song missing from
several playlists or exports is one row listing each place; songs match on title + artist,
ignoring case, accents and punctuation. A song that another import did add to TIDAL (same
source track) is left out.

### About the YouTube Music export

Takeout's playlist CSVs contain only **YouTube video ids**, with no song or artist. Titles
come from `music-library-songs.csv` where possible. For the rest, the app asks YouTube's
public oEmbed endpoint for the video's title and channel; no API key is needed. Matches built
from video titles must clear a stricter threshold. Private or deleted videos show as
*not found*.

### About the Apple Music export

Request it at [privacy.apple.com](https://privacy.apple.com) ("Apple Media Services
information"). Apple sends one or more `Apple Media Services Information Part N of M.zip` files.
Upload all of them at once. The data is nested zips deep; the app opens them and reads only
`Apple Music Library Tracks.json` and `Apple Music Library Playlists.json`. Everything else in
the export (App Store, TV, play history) is ignored.

* **Library songs** become TIDAL favourites, and complete albums among them are saved whole.
  Songs Apple shows only inside playlists, songs you disliked, and music videos are left out.
* **Playlists** you made (and *Favorite Songs*) become TIDAL playlists, in order.
  Subscribed playlists are skipped because the export doesn't list their songs.
* The export has no ISRCs, so every song is matched by title, artist, album and duration.

### About the Google Play Music export

Google Play Music closed in 2020, but its Takeout zips still work. They hold one CSV per song
under `Google Play Music/Tracks/`, a folder per playlist under `Playlists/`, and any MP3s you
uploaded. Radio stations are ignored. The MP3s are never decompressed: TIDAL can't take your
own audio, so each one is listed in the import's "not imported" record (reason
`own_audio_file`) with its path in the export. This works for audio files in any export.

* **Library songs** become TIDAL favourites, and complete albums among them are saved whole.
  Removed songs and thumbs-down songs are left out.
* **Playlists**, including the automatic *Thumbs Up* list, become TIDAL playlists in their
  original order. Entries marked removed and deleted playlists are skipped.
* Text in the export is HTML-escaped (`I&#39;m`) and is decoded. There are no ids or ISRCs,
  so songs are matched by title, artist, album and duration.

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
npm run inspect-export -- path/to/export.zip [part2.zip …]   # what an export would import, no TIDAL calls
```

## Deploying to Render

`render.yaml` defines everything: the web service, the **Workflow service**
(`music-agg-workflows`), the `music-agg-db` Postgres database, and the `music-agg-shared` env
group. Both services link the env group, which holds `TIDAL_CLIENT_ID` and a generated
`TOKEN_ENCRYPTION_KEY`. To use a different TIDAL app, change `TIDAL_CLIENT_ID` in
`render.yaml`, or in the env group in the Dashboard.

1. Dashboard → **New → Blueprint** → this repo. When prompted, enter:
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
| `TIDAL_MIN_INTERVAL_MS` | workflow | no | Fastest the shared TIDAL pace may go: minimum gap between requests per account (default 200) |
| `TIDAL_START_INTERVAL_MS` | workflow | no | Gap a fresh (or 1 h idle) account starts at before the pace adapts (default 750) |
| `MATCH_CHUNK_SIZE` / `MATCH_PARALLELISM` | workflow | no | Default 100 / 2 |
| `LOG_LEVEL` | both | no | `debug`, `info` (default), `warn`, `error`, `silent`. See [Logs](#logs) |
| `DATABASE_SSL` | both | no | Override TLS auto-detection |
| `MAX_UPLOAD_MB` / `IMPORT_RETENTION_DAYS` | web | no | Default 1024 (per file) / 30 |
| `UPLOAD_DIR` | web | no | Where uploads are written while they're parsed. Default: the OS temp dir |

`TIDAL_CLIENT_SECRET` is **not** used: TIDAL's user-login (PKCE) flow needs only the client id.

## Logs

Both services write one line per event as `key=value` pairs, e.g.

```
level=info event=match.chunk.done task=matchChunk taskRunId=trn-… importId=… tracks=100 ms=143210 msPerTrack=1432 youtubeMs=… tidalMs=… dbMs=… matched=91 review=6 not_found=3 tidal.requests=212 tidal.rateLimited=0 tidal.throttleWaitMs=…
```

Search Render's log viewer by text: `importId=<id>` follows one import through the web service and
every task run; `taskRunId=<trn-…>` matches a run in the Workflow dashboard.

| Event | Where | Tells you |
| ----- | ----- | --------- |
| `http.request` | web | method, route, status, duration, account, error message for 4xx |
| `import.created` / `import.parse_rejected` | web | file, detected format, collection/track counts |
| `import.dispatched` / `import.dispatch_failed` | web | which workflow run was started for an import |
| `auth.login*`, `tidal.token.*` | web, workflow | logins, token refreshes, refused refreshes (user must log in again) |
| `task.started` / `task.finished` / `task.threw` | workflow | every task run with duration and Render run ids; `task.threw` is retried by Render |
| `match.plan`, `match.chunk.started/finished/failed`, `match.finished/failed` | `matchImport` | chunk count and settings, each chunk's duration, final counts |
| `match.chunk.progress` | `matchChunk` | every 25 tracks / 30 s: tracks done, outcomes so far, tracks per minute, TIDAL requests / 429s, current pace |
| `tidal.pace.slower` / `faster` (debug) / `db_failed` | workflow | the shared pace reacting to a 429 (new gap, pause) or speeding up; `db_failed` = fell back to local spacing |
| `match.chunk.begin/done/will_retry` | `matchChunk` | per-chunk time split (YouTube lookup / TIDAL / database), outcomes, TIDAL request, retry and 429 counts, time waiting on the throttle |
| `match.track.transient_error` / `gave_up` / `error` | `matchChunk` | one line per failing track, with the phase it failed in |
| `tidal.request.retry` / `gave_up` | workflow | every TIDAL retry: status, attempt, wait, `Retry-After` |
| `youtube.lookup.failed` | workflow | video id, status, whether it will be retried |
| `load.plan`, `load.collection.*`, `load.write.*`, `load.playlist.created` | load tasks | per collection: playlist id, batches written, added/skipped, failures |
| `load.albums.planned` / `saved` / `unavailable` / `plan_failed` | `writeCollection` | albums checked, saved whole, tracks they cover; `load.album.checked` (debug) per album with how many tracks were missing |
| `load.tracks.unavailable` | `writeCollection` | tracks TIDAL refused, recorded as not imported |

`LOG_LEVEL=debug` adds one line per TIDAL request (`tidal.request`), per matched track
(`match.track`, with its timings and request count), per YouTube lookup and per 50-track
batch. It's verbose: turn it on to investigate, then back off.

Tokens, OAuth codes, cookies and Authorization headers are never logged.

## Adding an export format

1. Create `src/importers/adapters/<name>.js` exporting
   `{ id, label, description, detect(bundle), parse(bundle) }`:
   * `bundle.files` is a list of `{ path, size, text }` covering every CSV/TSV/TXT/JSON/XML/M3U
     file in the upload, across all uploaded files, whether they were zips or single files.
     Zips inside zips are opened too (up to 3 levels), and their files' paths are prefixed with
     the nested archive's path (`outer/inner.zip/dir/file.json`). macOS junk is already removed
     and UTF-8/UTF-16 is already decoded.
   * `text` is decoded each time it is read, so read it once per pass. In `detect`, use
     `fileHead(file)` from `bundle.js` to sniff headers without decoding a large file.
   * Files over 100 MB are skipped rather than failing the upload; they're listed in
     `bundle.skipped`. Files of other types (audio, HTML) are never decompressed.
   * `detect` returns a confidence from 0 to 1. The highest score wins, and the generic CSV
     adapter scores 0.5.
   * `parse` returns `{ collections, warnings }` built with `makeCollection` / `makeTrack` from
     `src/importers/model.js`. Include `isrc` whenever the source has it, because ISRC matching
     is exact.
2. Add it to `ADAPTERS` in `src/importers/registry.js`.
3. Add a small fixture and test in `test/`.

To accept a new container type (for example `.tar.gz`), add a loader to `LOADERS` in
`src/importers/bundle.js`. Zip uploads are read with streaming size limits, so declared sizes
in a malicious archive are never trusted. Entry, file and byte limits (`LIMITS`) apply to the
whole upload, nested archives included.
