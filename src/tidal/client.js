// Minimal TIDAL API v2 (JSON:API) client.
// Spec: https://tidal-music.github.io/tidal-api-reference/ (server https://openapi.tidal.com/v2)
//
// - Every request carries `Authorization: Bearer <token>` and JSON:API media types.
// - 401 → refresh the token once and retry.
// - 429 / 5xx → back off (honouring Retry-After) and retry. Mutations send an
//   Idempotency-Key so a retried write is replayed rather than applied twice.
// - Requests are spaced by `minIntervalMs` to stay well under rate limits.

import crypto from 'node:crypto';

export const API_BASE = 'https://openapi.tidal.com/v2';
const JSONAPI = 'application/vnd.api+json';

export class TidalApiError extends Error {
  constructor(message, { status, errors, path } = {}) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.path = path;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TidalClient {
  /**
   * @param {object} opts
   * @param {() => Promise<string>} opts.getAccessToken  returns a valid access token
   * @param {() => Promise<string>} [opts.forceRefresh]  refreshes and returns a new token
   */
  constructor({ getAccessToken, forceRefresh, fetchImpl = fetch, baseUrl = API_BASE, minIntervalMs = 200, maxRetries = 5, sleepImpl = sleep }) {
    this.getAccessToken = getAccessToken;
    this.forceRefresh = forceRefresh;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl;
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.sleep = sleepImpl;
    this.queue = Promise.resolve();
    this.lastRequestAt = 0;
  }

  /** Serialise request starts so we never exceed one request per minIntervalMs. */
  async throttle() {
    const turn = this.queue.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
    });
    this.queue = turn.catch(() => {});
    return turn;
  }

  url(path, query) {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return u.toString();
  }

  async request(method, path, { query, body } = {}) {
    const isWrite = method !== 'GET';
    const idempotencyKey = isWrite ? crypto.randomUUID() : null;
    let refreshed = false;

    for (let attempt = 0; ; attempt += 1) {
      await this.throttle();
      const token = await this.getAccessToken();
      const headers = { accept: JSONAPI, authorization: `Bearer ${token}` };
      if (body) headers['content-type'] = JSONAPI;
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

      let res;
      try {
        res = await this.fetch(this.url(path, query), { method, headers, body: body ? JSON.stringify(body) : undefined });
      } catch (err) {
        if (attempt >= this.maxRetries) throw new TidalApiError(`Network error calling TIDAL: ${err.message}`, { path });
        await this.sleep(backoff(attempt));
        continue;
      }

      if (res.status === 401 && !refreshed && this.forceRefresh) {
        refreshed = true;
        await this.forceRefresh();
        attempt -= 1; // a token refresh doesn't count as a retry
        continue;
      }

      // 409 on a retried write means "original still processing" under the idempotency contract.
      const retryable = res.status === 429 || res.status >= 500 || (isWrite && attempt > 0 && res.status === 409);
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(retryAfterMs(res) ?? backoff(attempt));
        continue;
      }

      const text = await res.text();
      const doc = text ? safeJson(text) : null;
      if (!res.ok) {
        const errors = doc?.errors || [];
        const detail = errors.map((e) => e.detail || e.title || e.code).filter(Boolean).join('; ');
        throw new TidalApiError(`TIDAL API ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`, {
          status: res.status,
          errors,
          path,
        });
      }
      return doc;
    }
  }

  get(path, query) {
    return this.request('GET', path, { query });
  }

  post(path, body, query) {
    return this.request('POST', path, { body, query });
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function backoff(attempt) {
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function retryAfterMs(res) {
  const h = res.headers?.get?.('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(60_000, secs * 1000);
  const date = Date.parse(h);
  return Number.isNaN(date) ? null : Math.max(0, Math.min(60_000, date - Date.now()));
}

/** Index a JSON:API document's `included` array by "type:id". */
export function indexIncluded(doc) {
  const map = new Map();
  for (const r of doc?.included || []) map.set(`${r.type}:${r.id}`, r);
  return map;
}
