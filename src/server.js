import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import multer from 'multer';

import { config, configProblems } from './config.js';
import { buildAuthorizeUrl, createPkcePair, createState, exchangeCode } from './auth/tidalAuth.js';
import { TidalClient } from './tidal/client.js';
import { getMe } from './tidal/catalog.js';
import { listFormats, parseExport, UnknownFormatError } from './importers/registry.js';
import { BundleError } from './importers/bundle.js';
import { summarizeLibrary } from './importers/model.js';
import { clearTokens, getAccount, upsertAccount } from './accounts.js';
import * as repo from './imports/repo.js';
import { createPool, migrate } from './db/pool.js';
import { buildDeps, setDeps, workflowSettings } from './workflows/deps.js';
import { createInlineDispatcher, createRenderDispatcher } from './workflows/dispatch.js';
import { log } from './util/log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMPORT_PATH = /^\/api\/imports\/([^/]+)/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** RFC 4180 cell; a leading = + - @ is prefixed with ' so spreadsheets don't run it as a formula. */
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build the JSON the browser polls for one import. */
async function importView(pool, imp, { withResults = false } = {}) {
  const view = {
    id: imp.id,
    filename: imp.filename,
    format: imp.format,
    formatLabel: imp.format_label,
    status: imp.status,
    stage: imp.stage,
    error: imp.error,
    warnings: imp.warnings,
    selected: imp.selected,
    createdAt: imp.created_at,
    collections: summarizeLibrary({ format: imp.format, formatLabel: imp.format_label, warnings: [], collections: imp.library.collections }).collections,
    progress: null,
  };
  if (imp.stage === 'match' || imp.stage === 'load') {
    const counts = await repo.trackCounts(pool, imp.id);
    view.matchStats = counts;
    if (imp.stage === 'match') view.progress = { phase: 'Finding your music on TIDAL', done: counts.total - counts.pending, total: counts.total };
  }
  if (imp.stage === 'load') {
    const targets = await repo.getTargets(pool, imp.id);
    let done = 0;
    let total = 0;
    view.targets = targets.map((t) => {
      total += t.items.length;
      done += Math.min(t.items.length, t.batches_done * 50);
      return {
        id: t.collection_id,
        kind: t.kind,
        name: t.name,
        status: t.status,
        added: t.added,
        skipped: t.skipped,
        error: t.error,
        url: t.kind === 'favorites' ? 'https://tidal.com/my-collection/tracks' : t.tidal_playlist_id ? `https://tidal.com/playlist/${t.tidal_playlist_id}` : null,
        notImported: t.unimported.length,
        albums: (t.albums || []).map((a) => ({ id: a.id, title: a.title, artists: a.artists, trackCount: a.trackCount, rule: a.rule || 'exact', extras: a.extras || 0 })),
        albumsAdded: t.albums_added,
      };
    });
    view.progress = { phase: 'Importing to TIDAL', done, total };
    view.notImported = targets.reduce((n, t) => n + t.unimported.length, 0);
  }
  if (withResults && imp.stage) view.results = await repo.matchResults(pool, imp);
  return view;
}

export function createApp({ pool, dispatcher, fetchImpl = fetch }) {
  const app = express();
  app.set('trust proxy', 1); // Render terminates TLS in front of us
  app.disable('x-powered-by');

  const PgStore = connectPgSimple(session);
  app.use(
    session({
      name: 'music_agg.sid',
      secret: config.sessionSecret || crypto.randomBytes(32).toString('hex'),
      store: new PgStore({ pool, createTableIfMissing: true, pruneSessionInterval: 60 * 60 }),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProduction ? true : 'auto', maxAge: 30 * 24 * 3600 * 1000 },
    }),
  );
  app.use(express.static(path.join(here, '..', 'public')));

  // One line per API/auth request. Static files and health checks are skipped as noise.
  app.use((req, res, next) => {
    if (req.path === '/healthz' || !(req.path.startsWith('/api/') || req.path.startsWith('/auth/'))) return next();
    const startedAt = performance.now();
    res.on('finish', () => {
      const fields = {
        method: req.method,
        path: req.path.replace(IMPORT_PATH, '/api/imports/:importId'),
        importId: IMPORT_PATH.exec(req.path)?.[1],
        status: res.statusCode,
        ms: Math.round(performance.now() - startedAt),
        accountId: req.session?.accountId,
        error: res.locals.errorMessage,
      };
      if (res.statusCode >= 500) log.error('http.request', fields);
      else if (res.statusCode >= 400) log.warn('http.request', fields);
      else log.info('http.request', fields);
    });
    next();
  });
  app.use(express.json({ limit: '5mb' }));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  // The session store is async: persist before redirecting, or the browser can arrive at the
  // next URL before the session row exists (losing the PKCE verifier or the login).
  const saveSession = (req) => new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));

  const requireLogin = wrap(async (req, res, next) => {
    const account = req.session.accountId ? await getAccount(pool, req.session.accountId) : null;
    if (!account?.has_tokens) return res.status(401).json({ error: 'Please log in with TIDAL first.' });
    req.account = account;
    next();
  });

  const loadImport = async (req) => {
    const imp = await repo.getImport(pool, req.params.importId, req.account.id);
    if (!imp) throw new HttpError(404, 'Import not found.');
    return imp;
  };

  /** Atomically move an import into an active status so double-clicks can't start two runs. */
  const claim = async (importId, fromStatuses, toStatus, stage) => {
    const { rowCount } = await pool.query(
      `UPDATE imports SET status = $3, stage = $4, error = NULL, updated_at = now() WHERE id = $1 AND status = ANY($2::text[])`,
      [importId, fromStatuses, toStatus, stage],
    );
    if (!rowCount) throw new HttpError(409, 'This import is busy or not ready for that step.');
  };

  const dispatch = async (imp, taskName, stage) => {
    const n = await repo.bumpDispatchCount(pool, imp.id);
    try {
      const runId = await dispatcher.start(taskName, [imp.id], { idempotencyKey: `${imp.id}:${stage}:${n}` });
      await pool.query(`UPDATE imports SET ${stage === 'load' ? 'load_run_id' : 'match_run_id'} = $2 WHERE id = $1`, [imp.id, runId]);
      log.info('import.dispatched', { importId: imp.id, task: taskName, stage, dispatch: n, taskRunId: runId, mode: dispatcher.mode });
    } catch (err) {
      log.error('import.dispatch_failed', { importId: imp.id, task: taskName, stage, dispatch: n, err });
      await repo.setStatus(pool, imp.id, 'failed', { error: `Could not start the ${stage} workflow (${err.message}). Press Retry.` });
      throw new HttpError(502, 'Could not start the workflow. Please press Retry.');
    }
  };

  app.get('/healthz', wrap(async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }));

  // ---- Auth -------------------------------------------------------------------------

  app.get('/auth/login', wrap(async (req, res) => {
    const problems = configProblems().filter((p) => !p.startsWith('Running workflows inline'));
    if (problems.length) return res.status(500).send(`Server is not configured: ${problems.join(' ')}`);
    const { verifier, challenge } = createPkcePair();
    const state = createState();
    req.session.oauth = { verifier, state };
    await saveSession(req);
    res.redirect(buildAuthorizeUrl({ clientId: config.tidal.clientId, redirectUri: config.tidal.redirectUri, challenge, state }));
  }));

  app.get('/auth/callback', wrap(async (req, res) => {
    const { code, state, error, error_description: description } = req.query;
    const pending = req.session.oauth;
    delete req.session.oauth;
    if (error) {
      log.warn('auth.login_denied', { error, description });
      return res.redirect(`/?authError=${encodeURIComponent(description || error)}`);
    }
    if (!pending || !code || state !== pending.state) {
      log.warn('auth.login_state_mismatch', { hasPending: Boolean(pending), hasCode: Boolean(code) });
      return res.redirect(`/?authError=${encodeURIComponent('Login expired or was tampered with. Please try again.')}`);
    }
    try {
      const tokens = await exchangeCode({ clientId: config.tidal.clientId, code, redirectUri: config.tidal.redirectUri, verifier: pending.verifier, fetchImpl });
      const me = await getMe(new TidalClient({ fetchImpl, getAccessToken: async () => tokens.accessToken }));
      const account = await upsertAccount(pool, { tidalUserId: me.id, username: me.username, country: me.country, tokens });
      // New session id after login (session fixation protection).
      await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
      req.session.accountId = account.id;
      await saveSession(req);
      log.info('auth.login', { accountId: account.id, country: me.country });
      res.redirect('/');
    } catch (err) {
      log.error('auth.login_failed', { err });
      res.redirect(`/?authError=${encodeURIComponent(err.message)}`);
    }
  }));

  app.post('/auth/logout', wrap(async (req, res) => {
    const accountId = req.session.accountId;
    if (accountId) {
      // Keep tokens while a workflow is still running on the user's behalf.
      const { rows } = await pool.query(`SELECT 1 FROM imports WHERE account_id = $1 AND status = ANY($2::text[]) LIMIT 1`, [accountId, repo.ACTIVE_STATUSES]);
      if (!rows.length) await clearTokens(pool, accountId);
    }
    req.session.destroy(() => res.json({ ok: true }));
  }));

  // ---- API --------------------------------------------------------------------------

  app.get('/api/me', wrap(async (req, res) => {
    const account = req.session.accountId ? await getAccount(pool, req.session.accountId) : null;
    res.json({
      loggedIn: Boolean(account?.has_tokens),
      user: account ? { username: account.username, country: account.country } : null,
      configProblems: configProblems(),
      formats: listFormats(),
      workflowMode: dispatcher.mode,
    });
  }));

  app.get('/api/imports', requireLogin, wrap(async (req, res) => {
    res.json({ imports: await repo.listImports(pool, req.account.id) });
  }));

  app.post('/api/uploads', requireLogin, upload.single('file'), wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    let library;
    const startedAt = performance.now();
    const fileFields = { accountId: req.account.id, filename: req.file.originalname, bytes: req.file.size, requestedFormat: req.body?.format || undefined };
    try {
      library = await parseExport({ filename: req.file.originalname, buffer: req.file.buffer, formatId: req.body?.format || undefined });
    } catch (err) {
      if (err instanceof BundleError || err instanceof UnknownFormatError) {
        log.warn('import.parse_rejected', { ...fileFields, ms: Math.round(performance.now() - startedAt), err });
        return res.status(422).json({ error: err.message });
      }
      throw err;
    }
    const id = await repo.createImport(pool, { accountId: req.account.id, filename: req.file.originalname, library });
    log.info('import.created', {
      ...fileFields,
      importId: id,
      format: library.format,
      collections: library.collections.length,
      tracks: library.collections.reduce((n, c) => n + c.tracks.length, 0),
      needsLookup: library.collections.reduce((n, c) => n + c.tracks.filter((t) => t.needsLookup).length, 0),
      warnings: library.warnings?.length || 0,
      ms: Math.round(performance.now() - startedAt),
    });
    res.json(await importView(pool, await repo.getImport(pool, id)));
  }));

  app.get('/api/imports/:importId', requireLogin, wrap(async (req, res) => {
    const imp = await loadImport(req);
    res.json(await importView(pool, imp, { withResults: req.query.results === '1' }));
  }));

  // Every source track that did not end up in TIDAL, with title / artist / album and the reason.
  app.get('/api/imports/:importId/not-imported.csv', requireLogin, wrap(async (req, res) => {
    const imp = await loadImport(req);
    const targets = await repo.getTargets(pool, imp.id);
    const header = ['collection', 'title', 'artist', 'album', 'reason', 'detail', 'source_url'];
    const lines = [header.join(',')];
    for (const t of targets) {
      for (const u of t.unimported) lines.push([t.name, u.title, u.artist, u.album, u.reason, u.detail, u.url].map(csvCell).join(','));
    }
    const base = imp.filename.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'import';
    res.set('content-type', 'text/csv; charset=utf-8');
    res.set('content-disposition', `attachment; filename="${base}-not-imported.csv"`);
    res.send(`\ufeff${lines.join('\r\n')}\r\n`); // BOM so Excel reads UTF-8
  }));

  app.post('/api/imports/:importId/match', requireLogin, wrap(async (req, res) => {
    const imp = await loadImport(req);
    const collectionIds = Array.isArray(req.body?.collectionIds) ? req.body.collectionIds.map(String) : [];
    if (!collectionIds.length) throw new HttpError(400, 'Choose at least one playlist or library.');
    // Once writing to TIDAL has started, only Retry may continue it (re-matching could duplicate playlists).
    if (imp.stage === 'load') throw new HttpError(409, 'This import has already started writing to TIDAL. Use Retry instead.');
    await claim(imp.id, ['parsed', 'matched', 'failed'], 'matching', 'match');
    try {
      await repo.prepareMatch(pool, imp, collectionIds, req.account.country || 'US');
    } catch (err) {
      await repo.setStatus(pool, imp.id, 'parsed', { stage: null });
      throw new HttpError(400, err.message);
    }
    await dispatch(imp, 'matchImport', 'match');
    res.status(202).json(await importView(pool, await repo.getImport(pool, imp.id)));
  }));

  app.post('/api/imports/:importId/load', requireLogin, wrap(async (req, res) => {
    const imp = await loadImport(req);
    const targets = Array.isArray(req.body?.collections) ? req.body.collections : [];
    const decisions = req.body?.decisions && typeof req.body.decisions === 'object' ? req.body.decisions : {};
    await claim(imp.id, ['matched'], 'loading', 'load');
    try {
      await repo.prepareLoad(pool, imp, targets, decisions);
    } catch (err) {
      await repo.setStatus(pool, imp.id, 'matched', { stage: 'match' });
      throw new HttpError(400, err.message);
    }
    await dispatch(imp, 'loadToTidal', 'load');
    res.status(202).json(await importView(pool, await repo.getImport(pool, imp.id)));
  }));

  // Resume a failed import from its checkpoints.
  app.post('/api/imports/:importId/retry', requireLogin, wrap(async (req, res) => {
    const imp = await loadImport(req);
    if (imp.status !== 'failed' || !imp.stage) throw new HttpError(409, 'Only failed imports can be retried.');
    if (imp.stage === 'match') {
      await claim(imp.id, ['failed'], 'matching', 'match');
      await pool.query(`UPDATE import_tracks SET status = 'pending', attempts = 0 WHERE import_id = $1 AND status = 'error'`, [imp.id]);
      await dispatch(imp, 'matchImport', 'match');
    } else {
      await claim(imp.id, ['failed'], 'loading', 'load');
      // Rows recorded because a write failed are re-attempted now, so drop them from the record.
      await pool.query(
        `UPDATE import_targets
            SET status = 'pending', error = NULL,
                unimported = COALESCE((SELECT jsonb_agg(u) FROM jsonb_array_elements(unimported) u WHERE u->>'reason' <> 'write_failed'), '[]'::jsonb)
          WHERE import_id = $1 AND status <> 'done'`,
        [imp.id],
      );
      await dispatch(imp, 'loadToTidal', 'load');
    }
    res.status(202).json(await importView(pool, await repo.getImport(pool, imp.id)));
  }));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${config.maxUploadBytes / 1024 / 1024} MB.` : err.message;
      return res.status(413).json({ error: msg });
    }
    if (err instanceof HttpError) {
      res.locals.errorMessage = err.message;
      return res.status(err.status).json({ error: err.message });
    }
    log.error('http.unhandled_error', { method: req.method, path: req.path, err });
    res.status(500).json({ error: 'Unexpected server error.' });
  });

  return app;
}

/** Wire up Postgres + the workflow dispatcher from config. */
export async function createRuntime({ fetchImpl = fetch } = {}) {
  const pool = createPool(config.databaseUrl, { max: 10 });
  await migrate(pool);
  let dispatcher;
  if (config.workflows.mode === 'render') {
    dispatcher = createRenderDispatcher({ workflowSlug: config.workflows.slug });
  } else {
    // Local development: run the workflow tasks in this process against the same database.
    setDeps(buildDeps({ pool, fetchImpl, settings: workflowSettings() }));
    dispatcher = createInlineDispatcher();
  }
  return { pool, dispatcher };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = configProblems();
  if (problems.length) log.warn('config.problems', { problems: problems.join(' ') });
  process.on('unhandledRejection', (err) => log.error('server.unhandled_rejection', { err }));
  const { pool, dispatcher } = await createRuntime();
  const cleanup = () =>
    repo
      .deleteOldImports(pool, config.retentionDays)
      .then((deleted) => log.info('imports.cleanup', { retentionDays: config.retentionDays, deleted }))
      .catch((err) => log.error('imports.cleanup_failed', { err }));
  cleanup();
  setInterval(cleanup, 24 * 3600 * 1000).unref();
  createApp({ pool, dispatcher }).listen(config.port, () => {
    log.info('server.listening', { port: config.port, workflowMode: dispatcher.mode, redirectUri: config.tidal.redirectUri, node: process.version });
  });
}
