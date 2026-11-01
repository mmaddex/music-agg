// In-memory, per-browser-session state: TIDAL tokens, parsed uploads, and jobs.
//
// Kept server-side (never in the cookie). Being in-memory means a restart/redeploy logs
// everyone out and drops in-flight jobs, which is fine for a single-instance Render
// service; swap this module for Redis/Postgres if you scale out.

import crypto from 'node:crypto';

const IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map();

export function getState(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { tokens: null, user: null, uploads: new Map(), jobs: new Map(), lastSeen: Date.now() };
    sessions.set(sessionId, s);
  }
  s.lastSeen = Date.now();
  return s;
}

/** Look up without creating (for anonymous requests). */
export function peekState(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.lastSeen = Date.now();
  return s || null;
}

export function clearState(sessionId) {
  sessions.delete(sessionId);
}

export const newId = () => crypto.randomUUID();

const sweeper = setInterval(() => {
  const cutoff = Date.now() - IDLE_TTL_MS;
  for (const [id, s] of sessions) {
    const busy = [...s.jobs.values()].some((j) => j.status === 'running');
    if (s.lastSeen < cutoff && !busy) sessions.delete(id);
  }
}, 60 * 60 * 1000);
sweeper.unref();
