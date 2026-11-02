import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import type { AppConfig } from '../config.js';
import { BundleError } from '../core/bundle/bundle.js';
import { IMPORTERS, UnsupportedExportError } from '../core/importers/registry.js';
import { TidalAuthError, TokenManager, buildAuthorizeUrl, createPkcePair, createState, exchangeCode } from '../core/tidal/auth.js';
import { TidalApiError, TidalClient, type TidalClientOptions } from '../core/tidal/client.js';
import type { SessionView } from '../shared/api.js';
import { jobView, startJob } from './jobs.js';
import { createUpload, runImport, runMatch, summarize, validatePlan } from './pipeline.js';
import { HttpError, SessionStore, requireUser, type Session } from './session.js';

export interface AppOptions {
  config: AppConfig;
  /** Override for tests. */
  fetch?: typeof fetch;
  /** Directory with the built web client (served in production). */
  staticDir?: string;
  /** Extra TIDAL client options (e.g. pacing in tests). */
  tidalClient?: Partial<TidalClientOptions>;
}

export function createApp({ config, fetch: fetchImpl = fetch, staticDir, tidalClient }: AppOptions) {
  const app = express();
  const store = new SessionStore(config.sessionTtlMs, config.secureCookies);
  const auth = requireUser(store);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 20 },
  });

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '5mb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // ------------------------------------------------------------------ auth

  app.get('/auth/login', (req, res) => {
    const s = store.getOrCreate(req, res);
    const { verifier, challenge } = createPkcePair();
    const state = createState();
    s.oauth = { state, verifier, createdAt: Date.now() };
    res.redirect(buildAuthorizeUrl(config.tidal, challenge, state));
  });

  app.get('/auth/callback', async (req, res) => {
    const back = (params: Record<string, string> = {}) => {
      const qs = new URLSearchParams(params).toString();
      res.redirect(`${config.appBaseUrl}/${qs ? `?${qs}` : ''}`);
    };
    const s = store.get(req);
    const { code, state, error, error_description } = req.query as Record<string, string | undefined>;
    if (error) return back({ authError: error_description || error });
    if (!s?.oauth || !state || state !== s.oauth.state || Date.now() - s.oauth.createdAt > 10 * 60_000) {
      return back({ authError: 'Login expired or was started in another browser — please try again.' });
    }
    if (!code) return back({ authError: 'TIDAL did not return an authorization code.' });
    const { verifier } = s.oauth;
    s.oauth = undefined;
    try {
      const tokens = await exchangeCode(config.tidal, code, verifier, fetchImpl);
      const manager = new TokenManager(config.tidal, tokens, (t) => (s.tokens = t), fetchImpl);
      const client = new TidalClient(manager, { ...tidalClient, baseUrl: config.tidal.apiBaseUrl, fetch: fetchImpl });
      const user = await client.getMe();
      client.countryCode = user.country;
      s.tokens = tokens;
      s.user = user;
      s.tidal = client;
      back();
    } catch (err) {
      console.error('TIDAL login failed:', err);
      back({ authError: err instanceof Error ? err.message : 'Login failed' });
    }
  });

  app.post('/auth/logout', (req, res) => {
    const s = store.get(req);
    if (s) store.destroy(s, res);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ api

  app.get('/api/session', (req, res) => {
    const s = store.get(req);
    const body: SessionView = {
      user: s?.user
        ? { id: s.user.id, username: s.user.username, firstName: s.user.firstName, country: s.user.country }
        : null,
      importers: IMPORTERS.map((i) => ({ id: i.id, label: i.label, description: i.description })),
      youtubeApiKey: Boolean(config.youtubeApiKey),
    };
    res.json(body);
  });

  app.post('/api/uploads', auth, upload.array('files', 20), (req, res) => {
    const s = req.session!;
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw new HttpError(400, 'No file uploaded.');
    const importerId = typeof req.body?.importerId === 'string' ? req.body.importerId : undefined;
    const state = createUpload(
      files.map((f) => ({ name: decodeFilename(f.originalname), data: new Uint8Array(f.buffer) })),
      importerId,
      config.maxUploadBytes * 5,
    );
    // One export at a time per session keeps memory bounded.
    for (const [id] of s.uploads) dropUpload(s, id);
    s.uploads.set(state.id, state);
    res.json(summarize(state));
  });

  app.get('/api/uploads/:id', auth, (req, res) => {
    const s = req.session!;
    const u = getUpload(s, String(req.params.id));
    const running = [...s.jobs.values()].find((j) => j.uploadId === u.id && j.status === 'running');
    res.json({
      summary: summarize(u),
      matches: u.matches ? [...u.matches.values()] : [],
      runningJob: running ? jobView(running) : null,
    });
  });

  app.delete('/api/uploads/:id', auth, (req, res) => {
    dropUpload(req.session!, String(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/uploads/:id/match', auth, (req, res) => {
    const s = req.session!;
    const u = getUpload(s, String(req.params.id));
    const ids = req.body?.collectionIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string') || !ids.length) {
      throw new HttpError(400, 'Select at least one playlist or library.');
    }
    assertNoRunningJob(s, u.id);
    const job = startJob(s.jobs, 'match', u.id, (h) =>
      runMatch(u, ids, { catalog: s.tidal!, youtubeApiKey: config.youtubeApiKey, fetch: fetchImpl }, h),
    );
    res.status(202).json(jobView(job));
  });

  app.post('/api/uploads/:id/import', auth, (req, res) => {
    const s = req.session!;
    const u = getUpload(s, String(req.params.id));
    let plan;
    try {
      plan = validatePlan(u, req.body?.plan);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    assertNoRunningJob(s, u.id);
    const job = startJob(s.jobs, 'import', u.id, (h) => runImport(u, plan, s.tidal!, h));
    res.status(202).json(jobView(job));
  });

  app.get('/api/jobs/:id', auth, (req, res) => {
    const job = req.session!.jobs.get(String(req.params.id));
    if (!job) throw new HttpError(404, 'Job not found.');
    res.json(jobView(job));
  });

  app.post('/api/jobs/:id/cancel', auth, (req, res) => {
    const job = req.session!.jobs.get(String(req.params.id));
    if (!job) throw new HttpError(404, 'Job not found.');
    if (job.status === 'running') job.abort.abort(new Error('Cancelled'));
    res.json(jobView(job));
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  // ------------------------------------------------------------------ web client

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|auth\/).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  // ------------------------------------------------------------------ errors

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, message } = toHttpError(err);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message });
  });

  return { app, store };
}

/** Busboy hands multipart filenames over as latin1; recover UTF-8 names like "Forró.csv". */
function decodeFilename(name: string): string {
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return utf8.includes('\uFFFD') ? name : utf8;
}

function getUpload(s: Session, id: string) {
  const u = s.uploads.get(id);
  if (!u) throw new HttpError(404, 'That upload has expired — please upload the export again.');
  return u;
}

function dropUpload(s: Session, id: string) {
  for (const job of s.jobs.values()) if (job.uploadId === id && job.status === 'running') job.abort.abort(new Error('Upload removed'));
  s.uploads.delete(id);
}

function assertNoRunningJob(s: Session, uploadId: string) {
  for (const job of s.jobs.values()) {
    if (job.uploadId === uploadId && job.status === 'running') {
      throw new HttpError(409, `A ${job.kind} job is already running for this upload.`);
    }
  }
}

function toHttpError(err: unknown): { status: number; message: string } {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  if (err instanceof UnsupportedExportError || err instanceof BundleError) return { status: 422, message: err.message };
  if (err instanceof multer.MulterError) {
    return { status: 413, message: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : err.message };
  }
  if (err instanceof TidalAuthError) return { status: 401, message: err.message };
  if (err instanceof TidalApiError) return { status: 502, message: err.message };
  if (err instanceof SyntaxError) return { status: 400, message: 'Malformed request.' };
  return { status: 500, message: 'Something went wrong.' };
}
