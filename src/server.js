import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import createMemoryStore from 'memorystore';
import multer from 'multer';

import { config, configProblems } from './config.js';
import { buildAuthorizeUrl, createPkcePair, createState, exchangeCode, refreshTokens } from './auth/tidalAuth.js';
import { TidalClient } from './tidal/client.js';
import { getMe } from './tidal/catalog.js';
import { listFormats, parseExport, UnknownFormatError } from './importers/registry.js';
import { BundleError } from './importers/bundle.js';
import { summarizeLibrary } from './importers/model.js';
import { clearState, getState, newId, peekState } from './state.js';
import { publicJob, startJob } from './jobs.js';
import { runImport, runMatch } from './importService.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A TidalClient bound to one session's tokens, refreshing them as needed. */
export function clientForState(state, { fetchImpl = fetch } = {}) {
  let refreshing = null;
  const refresh = async () => {
    refreshing ??= refreshTokens({ clientId: config.tidal.clientId, tokens: state.tokens, fetchImpl })
      .then((t) => {
        state.tokens = t;
        return t.accessToken;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };
  return new TidalClient({
    fetchImpl,
    minIntervalMs: config.tidalMinIntervalMs,
    getAccessToken: async () => {
      if (!state.tokens) throw Object.assign(new Error('Not logged in to TIDAL'), { status: 401 });
      if (Date.now() >= state.tokens.expiresAt) return refresh();
      return state.tokens.accessToken;
    },
    forceRefresh: refresh,
  });
}

export function createApp({ fetchImpl = fetch } = {}) {
  const app = express();
  app.set('trust proxy', 1); // Render terminates TLS in front of us
  app.disable('x-powered-by');

  const MemoryStore = createMemoryStore(session);
  app.use(
    session({
      name: 'music_agg.sid',
      secret: config.sessionSecret || crypto.randomBytes(32).toString('hex'),
      store: new MemoryStore({ checkPeriod: 60 * 60 * 1000 }),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProduction ? true : 'auto', maxAge: 7 * 24 * 3600 * 1000 },
    }),
  );
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(here, '..', 'public')));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });

  const stateOf = (req) => {
    req.session.touched = true; // make sure the session (and its cookie) persist
    return getState(req.sessionID);
  };
  const requireLogin = (req, res, next) => {
    const state = peekState(req.sessionID);
    if (!state?.tokens) return res.status(401).json({ error: 'Please log in with TIDAL first.' });
    req.state = state;
    next();
  };

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---- Auth -------------------------------------------------------------------------

  app.get('/auth/login', (req, res) => {
    const problems = configProblems();
    if (problems.length) return res.status(500).send(`Server is not configured: ${problems.join(' ')}`);
    const { verifier, challenge } = createPkcePair();
    const state = createState();
    req.session.oauth = { verifier, state };
    res.redirect(buildAuthorizeUrl({ clientId: config.tidal.clientId, redirectUri: config.tidal.redirectUri, challenge, state }));
  });

  app.get('/auth/callback', async (req, res) => {
    const { code, state, error, error_description: description } = req.query;
    const pending = req.session.oauth;
    delete req.session.oauth;
    if (error) return res.redirect(`/?authError=${encodeURIComponent(description || error)}`);
    if (!pending || !code || state !== pending.state) {
      return res.redirect(`/?authError=${encodeURIComponent('Login expired or was tampered with. Please try again.')}`);
    }
    try {
      const tokens = await exchangeCode({
        clientId: config.tidal.clientId,
        code,
        redirectUri: config.tidal.redirectUri,
        verifier: pending.verifier,
        fetchImpl,
      });
      // New session id after login (session fixation protection).
      await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
      const st = stateOf(req);
      st.tokens = tokens;
      st.user = await getMe(clientForState(st, { fetchImpl }));
      res.redirect('/');
    } catch (err) {
      console.error('TIDAL login failed', err);
      res.redirect(`/?authError=${encodeURIComponent(err.message)}`);
    }
  });

  app.post('/auth/logout', (req, res) => {
    clearState(req.sessionID);
    req.session.destroy(() => res.json({ ok: true }));
  });

  // ---- API --------------------------------------------------------------------------

  app.get('/api/me', (req, res) => {
    const st = peekState(req.sessionID);
    res.json({
      loggedIn: !!st?.tokens,
      user: st?.user || null,
      configProblems: configProblems(),
      formats: listFormats(),
    });
  });

  app.post('/api/uploads', requireLogin, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    try {
      const library = await parseExport({ filename: req.file.originalname, buffer: req.file.buffer, formatId: req.body?.format || undefined });
      const id = newId();
      req.state.uploads.clear(); // one active upload per session keeps memory bounded
      req.state.uploads.set(id, { id, filename: req.file.originalname, library, createdAt: Date.now() });
      res.json({ uploadId: id, filename: req.file.originalname, ...summarizeLibrary(library) });
    } catch (err) {
      if (err instanceof BundleError || err instanceof UnknownFormatError) return res.status(422).json({ error: err.message });
      console.error('Upload parse failed', err);
      res.status(500).json({ error: `Could not read this export: ${err.message}` });
    }
  });

  app.post('/api/uploads/:uploadId/match', requireLogin, (req, res) => {
    const up = req.state.uploads.get(req.params.uploadId);
    if (!up) return res.status(404).json({ error: 'Upload not found; please upload the export again.' });
    const collectionIds = Array.isArray(req.body?.collectionIds) ? req.body.collectionIds.map(String) : [];
    if (!collectionIds.length) return res.status(400).json({ error: 'Choose at least one playlist or library.' });
    const client = clientForState(req.state, { fetchImpl });
    const countryCode = req.state.user?.country || 'US';
    const job = startJob(req.state, 'match', (update) =>
      runMatch({ library: up.library, collectionIds, client, countryCode, update, fetchImpl }),
    );
    up.matchJobId = job.id;
    res.status(202).json(publicJob(job, { includeResult: false }));
  });

  app.post('/api/imports', requireLogin, (req, res) => {
    const matchJob = req.state.jobs.get(String(req.body?.matchJobId || ''));
    if (!matchJob || matchJob.type !== 'match' || matchJob.status !== 'done') {
      return res.status(400).json({ error: 'Run matching first.' });
    }
    const targets = Array.isArray(req.body?.collections) ? req.body.collections : [];
    const decisions = req.body?.decisions && typeof req.body.decisions === 'object' ? req.body.decisions : {};
    const client = clientForState(req.state, { fetchImpl });
    const job = startJob(req.state, 'import', (update) =>
      runImport({ matchResult: matchJob.result, targets, decisions, client, update }),
    );
    res.status(202).json(publicJob(job, { includeResult: false }));
  });

  app.get('/api/jobs/:jobId', requireLogin, (req, res) => {
    const job = req.state.jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json(publicJob(job, { includeResult: job.status !== 'running' }));
  });

  // Multer/size errors and anything else unhandled.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${config.maxUploadBytes / 1024 / 1024} MB.` : err.message;
      return res.status(413).json({ error: msg });
    }
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error.' });
  });

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = configProblems();
  if (problems.length) console.warn(`Configuration warning: ${problems.join(' ')}`);
  createApp().listen(config.port, () => {
    console.log(`music-agg listening on :${config.port} (redirect URI ${config.tidal.redirectUri})`);
  });
}
