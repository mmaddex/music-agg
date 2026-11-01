# music-agg

A small web app that imports music-service exports into **TIDAL**. You log in with your TIDAL
account, upload an export, review the matches, and the app creates the playlists and adds
favourites in your TIDAL account.

Today it supports **YouTube Music (Google Takeout)** and **plain CSV files with title/artist
columns**. The importer is built so Google Play Music, Apple Music and other exports can be
added as small plug-in adapters (see [Adding an export format](#adding-an-export-format)).

## How it works

```
upload (.zip / .csv)
  └─ bundle loader      zip or text file  → flat list of text files       src/importers/bundle.js
      └─ format adapter  files            → Library (playlists, favourites) src/importers/adapters/*
          └─ enrichers   video-id-only tracks → title/artist (YouTube oEmbed) src/enrich/youtube.js
              └─ matcher  Library tracks  → TIDAL track ids (ISRC, then search + scoring) src/tidal/matcher.js
                  └─ review in the browser (accept / change / skip)
                      └─ writer  → TIDAL playlists + My Collection tracks   src/tidal/writer.js
```

* **Login:** OAuth 2.1 authorization code + PKCE, exactly as in TIDAL's
  [authorization guide](https://developer.tidal.com/documentation/api-sdk/api-sdk-authorization).
  Users sign in on `login.tidal.com`. The app never sees their password. Tokens are kept
  server-side and refreshed automatically.
* **API:** TIDAL API v2 (`https://openapi.tidal.com/v2`, JSON:API), per the
  [API reference](https://tidal-music.github.io/tidal-api-reference/). Scopes requested:
  `user.read search.read playlists.write collection.write`.

  | Step                | Endpoint                                                        |
  | ------------------- | --------------------------------------------------------------- |
  | Who's logged in     | `GET /users/me`                                                 |
  | Match by ISRC       | `GET /tracks?filter[isrc]=…&include=artists,albums`             |
  | Match by search     | `GET /searchResults?filter[query]=…&include=tracks.artists,tracks.albums` |
  | Create playlist     | `POST /playlists` (created as `UNLISTED`)                       |
  | Add playlist tracks | `POST /playlists/{id}/relationships/items` (≤ 50 per call)      |
  | Add favourites      | `POST /userCollectionTracks/me/relationships/items` (≤ 50 per call) |

  Requests are rate-limited per user. `429` responses honour `Retry-After`. Writes carry an
  `Idempotency-Key` so a retry never adds tracks twice.
* **Matching:** each track is scored on title, artist, album, duration and version markers
  (live / remix / karaoke …). It is then marked *matched* (imported by default), *needs review*
  (you decide), or *not found*. The same song in several playlists is looked up once.

### About the YouTube Music export

Takeout's playlist CSVs contain only **YouTube video ids**, with no song or artist. The app
fills in what it can from `music-library-songs.csv`, which does have titles. For the rest it
looks up the video's title and channel through YouTube's public oEmbed endpoint
(`https://www.youtube.com/oembed`, no API key needed). Matches built from video titles are
held to a stricter threshold, so more of them land in *needs review*. Private or deleted
videos show as *not found*.

* `Library songs` → added to TIDAL **My Collection › Tracks**.
* Each playlist → a new TIDAL playlist. You can rename it before importing. The original
  "time added" dates are sent along (`meta.addedAt`).
* `Watch later` and `Uploads from …` are listed but unchecked by default.

## Running locally

Requires Node 20+.

```bash
npm install
cp .env.example .env            # set TIDAL_CLIENT_ID
node --env-file=.env src/server.js
# open http://localhost:3000
```

In the [TIDAL developer dashboard](https://developer.tidal.com), register the redirect URI
`http://localhost:3000/auth/callback` for your app and enable the scopes listed above.

Other commands:

```bash
npm test                                        # unit + end-to-end tests (no network needed)
npm run inspect-export -- path/to/export.zip    # show what an export would import, no TIDAL calls
```

## Deploying to Render

`render.yaml` is a Render Blueprint for a single Node web service.

1. Render Dashboard → **New → Blueprint** → select this repo.
2. Set `TIDAL_CLIENT_ID` when prompted. `SESSION_SECRET` is generated for you.
3. After the first deploy, register `https://<your-service>.onrender.com/auth/callback` as a
   redirect URI for your TIDAL app. If you use a custom domain, register that domain's
   callback instead and set `TIDAL_REDIRECT_URI` to it.

Sessions, uploads and jobs live **in memory**, so run a single instance. A restart or redeploy
logs users out and drops any import that is in progress. The Blueprint uses the `starter`
plan because free instances spin down when idle. To scale out, move `src/state.js` to Redis
or Postgres.

## Configuration

| Variable                | Required | Default                                   | Notes |
| ----------------------- | -------- | ----------------------------------------- | ----- |
| `TIDAL_CLIENT_ID`       | yes      |                                           | From developer.tidal.com |
| `SESSION_SECRET`        | prod     | random per process                        | Signs the session cookie |
| `PUBLIC_BASE_URL`       | no       | `$RENDER_EXTERNAL_URL` or `http://localhost:$PORT` | |
| `TIDAL_REDIRECT_URI`    | no       | `$PUBLIC_BASE_URL/auth/callback`          | Must match the TIDAL app config exactly |
| `TIDAL_MIN_INTERVAL_MS` | no       | `200`                                     | Spacing between TIDAL calls per user |
| `MAX_UPLOAD_MB`         | no       | `100`                                     | |
| `PORT`                  | no       | `3000`                                    | Render sets this |

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

Until a dedicated adapter exists, many exports already work through the generic CSV adapter.
It recognises common column names such as `Title`/`Track Name`/`Name`,
`Artist`/`Artist Name(s)`, `Album`, `ISRC` and `Duration (ms)`.
