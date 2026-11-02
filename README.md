# Music Import for TIDAL

A web app that takes a music-service export — today a **YouTube Music** Google Takeout `.zip`, or any CSV with
title/artist columns — finds every song on **TIDAL**, lets you review the matches, and then creates the playlists
and adds your library to your TIDAL collection.

The user signs in with their own TIDAL account (OAuth 2.1, authorization code + PKCE), so everything is written
to *their* account.

```
Upload (.zip / .csv) → detect format → parse → look up missing details → search TIDAL → review → write to TIDAL
```

## Quick start

1. **Create a TIDAL app** at <https://developer.tidal.com/dashboard>.
   - Add the redirect URI `http://localhost:5173/auth/callback`.
   - Enable the scopes `user.read search.read playlists.read playlists.write collection.read collection.write`.
2. **Configure**:
   ```sh
   cp .env.example .env      # then set TIDAL_CLIENT_ID (and TIDAL_CLIENT_SECRET if you have one)
   npm install
   ```
3. **Run** (API on :3000, web UI on :5173 with `/api` and `/auth` proxied to the API):
   ```sh
   npm run dev
   ```
   Open <http://localhost:5173>, log in with TIDAL, and upload your export.

### Getting a YouTube Music export

[takeout.google.com](https://takeout.google.com) → *Deselect all* → tick **YouTube and YouTube Music** → under
*All YouTube data included*, keep `music-library-songs` and `playlists` → export. Upload the `.zip` as-is.

### Production

```sh
npm run build    # compiles the server to dist/server and the UI to dist/web
npm start        # one process serves both on $PORT
```

Set `TIDAL_REDIRECT_URI=https://your-host/auth/callback` (and register it with the TIDAL app). `APP_BASE_URL`
defaults to that URI's origin; cookies are marked `Secure` when it is `https`. See `.env.example` for all settings.

Sessions are kept in memory, so run a **single instance** (or add a shared session store; see `src/server/session.ts`).

## Using it

1. **Upload**: drop the `.zip` (or one or more `.csv` files). The format is detected automatically; you can override it.
2. **Choose**: each playlist and your library are listed with a suggested destination:
   - YouTube Music library → *My Collection* (favourite tracks)
   - Playlists → a new **unlisted** TIDAL playlist (name editable)
   - *Watch later* and *Uploads from …* are unticked by default (rarely music)
3. **Match**: YouTube playlist files contain only video ids. Those that are also in your library CSV reuse its
   title/artist/album. The rest are looked up on YouTube first, via the keyless oEmbed endpoint, or the Data API if
   `YOUTUBE_API_KEY` is set. Then every song is searched on TIDAL.
4. **Review**: confident matches are ticked. *Check* rows are close-but-uncertain (e.g. a live video vs the studio
   recording) and offer alternative candidates. *Not found* rows can be downloaded as a CSV.
5. **Import**: playlists are created, then filled in order, 50 tracks per request. The original "added" date is kept
   when TIDAL accepts it.

To preview what an export contains without logging in:

```sh
npm run inspect-export -- path/to/takeout.zip            # parse only
npm run inspect-export -- path/to/takeout.zip --lookup   # also resolve YouTube video ids
```

## Architecture

```
src/
  core/                       framework-free, unit-tested
    model.ts                  source-agnostic model: SourceCollection / SourceTrack
    bundle/bundle.ts          uploads → flat list of files (unzips, nested zips, plain files, junk filtering)
    importers/                one file per export format
      types.ts                ExportImporter interface: detect() + parse()
      registry.ts             list of importers; picks the most confident one
      youtube-music.ts        Google Takeout: music-library-songs.csv + playlists/*.csv
      generic-csv.ts          any CSV with title + artist columns (loose header matching)
    enrich/                   fill in missing metadata before matching
      youtube.ts              video id → title/channel (oEmbed, or Data API with a key)
      video-title.ts          "Artist - Song (Official Video)" / "… - Topic" → artist + title
    matching/                 normalisation, similarity, scoring, search strategy
    tidal/
      auth.ts                 OAuth 2.1 + PKCE, token refresh
      client.ts               TIDAL API v2 (JSON:API): search, tracks, playlists, collection
  server/                     Express API: sessions, background jobs, upload/match/import endpoints
  shared/api.ts               request/response types shared with the web client
web/                          React UI (Vite)
test/                         Vitest: parsers, matcher, TIDAL client (against a fake API), full HTTP flow
```

### Adding another export format

Everything after parsing works on the source-agnostic model in `src/core/model.ts`, so a new service only needs
an importer:

1. Create `src/core/importers/<service>.ts` implementing `ExportImporter`:
   - `detect(bundle)`: look at file paths and CSV header lines and return a confidence from 0 to 1, or `null`.
     Prefer headers over folder names, because Takeout localises folder names.
   - `parse(bundle)`: return `ParsedExport` (collections of `SourceTrack`s). Set `quality: 'export'` when
     title/artist come from structured columns. Use `'missing'` plus a `refs` entry when you only have a
     service-specific id.
2. Add it to `IMPORTERS` in `src/core/importers/registry.ts`.
3. Add a small synthetic fixture and tests in `test/`.

Related extension points:

- **New container format** (e.g. `.tar.gz`): add an `Unpacker` to `UNPACKERS` in `src/core/bundle/bundle.ts`.
  Archives inside archives are expanded automatically.
- **Id-only tracks from another service** (e.g. Apple Music catalog ids): add a `TrackEnricher` (see
  `src/core/enrich/types.ts`) and include it in `defaultEnrichers`.
- **ISRCs**: if an export includes them, set `SourceTrack.isrc`. The matcher looks those up exactly before falling
  back to search.

### Matching

- Titles are normalised: accents folded, `&` = `and`, `feat.` clauses and `(2009 Remaster)`-style qualifiers dropped.
  Meaningful qualifiers (live, acoustic, remix, demo…) are kept and compared.
- The score is mostly title similarity plus artist similarity, with small bonuses for matching album or duration.
  Karaoke/tribute versions and live/studio mismatches are penalised.
  Multi-artist credits like `John Lennon, Yoko Ono` and band names with commas like `Crosby, Stills, Nash & Young`
  are both handled.
- When the artist was guessed from an uploader's channel name, it can confirm a match but not veto one.
- Queries run from most to least specific, and the matcher stops at the first confident hit. Identical songs
  across playlists are only searched once.
- Thresholds live in `src/core/matching/matcher.ts` (`THRESHOLDS`, `classify`, `shouldPreselect`).

### TIDAL API usage

Base URL `https://openapi.tidal.com/v2` (JSON:API, `application/vnd.api+json`):

| Purpose | Endpoint |
| --- | --- |
| Current user and country | `GET /users/me` |
| Search | `GET /searchResults?filter[query]=…&include=tracks` (tries nested `tracks.artists` includes first, falls back automatically) |
| Track details / ISRC lookup | `GET /tracks?filter[id]=…` / `filter[isrc]=…` (≤ 20 per call) |
| Create playlist | `POST /playlists` (`accessType: UNLISTED`) |
| Add to playlist | `POST /playlists/{id}/relationships/items` (≤ 50 per call) |
| Add to favourites | `POST /userCollectionTracks/me/relationships/items` (≤ 50 per call) |

TIDAL doesn't publish its rate limit or send rate-limit headers, so requests are **paced adaptively**. The gap
between requests widens on every `429` (honouring `Retry-After`) and narrows again while requests succeed. `5xx`
responses are retried with backoff. Every write carries an `Idempotency-Key`, so retries never add a track twice.
Expired tokens are refreshed automatically.

## Privacy and TIDAL developer terms

- Users sign in on tidal.com; the app never sees passwords.
- Access tokens and uploaded exports stay **in server memory only**. They are discarded on logout or after
  `SESSION_TTL_MINUTES` of inactivity, and nothing is written to disk.
- The UI links back to TIDAL and states it isn't affiliated, per the TIDAL Developer Guidelines.
- New TIDAL apps start with limited access. To open the app to other users, request production approval in the
  TIDAL developer dashboard.

## Development

```sh
npm test            # vitest
npm run typecheck   # server + web
```

If you run behind an HTTP proxy, Node's built-in `fetch` only uses it with `NODE_USE_ENV_PROXY=1`
(Node ≥ 22.21).
