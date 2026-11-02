import { randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { TokenSet } from '../core/tidal/auth.js';
import type { TidalClient, TidalUser } from '../core/tidal/client.js';
import type { Job } from './jobs.js';
import type { UploadState } from './pipeline.js';

/**
 * Server-side, in-memory sessions. Tokens and uploaded exports never leave the
 * server process and are dropped on logout or after the idle TTL — TIDAL's
 * developer guidelines prohibit apps that store end-user data, so nothing is
 * persisted to disk. (A multi-instance deployment would need a shared store.)
 */
export interface Session {
  id: string;
  createdAt: number;
  lastSeen: number;
  oauth?: { state: string; verifier: string; createdAt: number };
  tokens?: TokenSet;
  user?: TidalUser;
  tidal?: TidalClient;
  uploads: Map<string, UploadState>;
  jobs: Map<string, Job>;
}

export const COOKIE_NAME = 'music_agg_sid';

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly ttlMs: number,
    private readonly secureCookies: boolean,
  ) {
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  get(req: Request): Session | undefined {
    const id = readCookie(req.headers.cookie, COOKIE_NAME);
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (Date.now() - s.lastSeen > this.ttlMs && !hasRunningJob(s)) {
      this.destroy(s);
      return undefined;
    }
    s.lastSeen = Date.now();
    return s;
  }

  getOrCreate(req: Request, res: Response): Session {
    const existing = this.get(req);
    if (existing) return existing;
    const s: Session = {
      id: randomBytes(32).toString('base64url'),
      createdAt: Date.now(),
      lastSeen: Date.now(),
      uploads: new Map(),
      jobs: new Map(),
    };
    this.sessions.set(s.id, s);
    res.cookie(COOKIE_NAME, s.id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secureCookies,
      path: '/',
      maxAge: this.ttlMs,
    });
    return s;
  }

  destroy(s: Session, res?: Response) {
    for (const job of s.jobs.values()) job.abort.abort(new Error('Session ended'));
    this.sessions.delete(s.id);
    res?.clearCookie(COOKIE_NAME, { path: '/' });
  }

  private sweep() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (now - s.lastSeen > this.ttlMs && !hasRunningJob(s)) this.destroy(s);
      // Old finished jobs hold large results; keep only recent ones.
      for (const [id, job] of s.jobs) {
        if (job.status !== 'running' && job.finishedAt && now - job.finishedAt > this.ttlMs) s.jobs.delete(id);
      }
    }
  }

  close() {
    clearInterval(this.timer);
  }
}

function hasRunningJob(s: Session) {
  return [...s.jobs.values()].some((j) => j.status === 'running');
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: Session;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Require a logged-in TIDAL user; attaches `req.session`. */
export function requireUser(store: SessionStore) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const s = store.get(req);
    if (!s?.user || !s.tidal) return next(new HttpError(401, 'Please log in to TIDAL first.'));
    req.session = s;
    next();
  };
}
