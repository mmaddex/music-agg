// Minimal TIDAL API v2 (JSON:API) client.
// Spec: https://tidal-music.github.io/tidal-api-reference/ (server https://openapi.tidal.com/v2)
//
// - Every request carries `Authorization: Bearer <token>` and JSON:API media types.
// - 401 → refresh the token once and retry.
// - 429 / 5xx → back off (honouring Retry-After) and retry. Mutations send an
//   Idempotency-Key so a retried write is replayed rather than applied twice.
// - Requests are spaced by `minIntervalMs` to stay well under rate limits.

import crypto from 'node:crypto';
import { log as rootLog } from '../util/log.js';

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

const newStats = () => ({ requests: 0, retries: 0, rateLimited: 0, serverErrors: 0, networkErrors: 0, requestMs: 0, throttleWaitMs: 0, retryWaitMs: 0 });

export class TidalClient {
  /**
   * @param {object} opts
   * @param {() => Promise<string>} opts.getAccessToken  returns a valid access token
   * @param {() => Promise<string>} [opts.forceRefresh]  refreshes and returns a new token
   */
  constructor({ getAccessToken, forceRefresh, fetchImpl = fetch, baseUrl = API_BASE, minIntervalMs = 200, maxRetries = 5, sleepImpl = sleep, log = rootLog }) {
    this.getAccessToken = getAccessToken;
    this.forceRefresh = forceRefresh;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl;
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.sleep = sleepImpl;
    this.queue = Promise.resolve();
    this.lastRequestAt = 0;
    this.log = log.child({ component: 'tidal' });
    this.stats = newStats();
  }

  /** Counters since the last reset; callers diff or reset them to report per track / chunk. */
  resetStats() {
    const prev = this.stats;
    this.stats = newStats();
    return prev;
  }

  /** Serialise request starts so we never exceed one request per minIntervalMs. */
  async throttle() {
    const queuedAt = performance.now();
    const turn = this.queue.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
    });
    this.queue = turn.catch(() => {});
    await turn;
    this.stats.throttleWaitMs += Math.round(performance.now() - queuedAt);
  }

  url(path, query) {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      // Arrays repeat the key (OpenAPI form/explode, the spec's default): filter[id]=1&filter[id]=2
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x)));
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  /**
   * @param {string} [opts.idempotencyKey]  for writes; pass a deterministic key when the same
   *        logical write may be re-sent by a later process (workflow retries). TIDAL replays the
   *        original response for an identical request with the same key within one hour.
   */
  async request(method, path, { query, body, idempotencyKey: key } = {}) {
    const isWrite = method !== 'GET';
    const idempotencyKey = isWrite ? key || crypto.randomUUID() : null;
    let refreshed = false;

    for (let attempt = 0; ; attempt += 1) {
      await this.throttle();
      const token = await this.getAccessToken();
      const headers = { accept: JSONAPI, authorization: `Bearer ${token}` };
      if (body) headers['content-type'] = JSONAPI;
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

      let res;
      const startedAt = performance.now();
      this.stats.requests += 1;
      try {
        res = await this.fetch(this.url(path, query), { method, headers, body: body ? JSON.stringify(body) : undefined });
      } catch (err) {
        this.stats.requestMs += Math.round(performance.now() - startedAt);
        this.stats.networkErrors += 1;
        if (attempt >= this.maxRetries) {
          this.log.warn('tidal.request.gave_up', { method, path, attempt, reason: 'network', err });
          throw new TidalApiError(`Network error calling TIDAL: ${err.message}`, { path });
        }
        const waitMs = backoff(attempt);
        this.stats.retries += 1;
        this.log.warn('tidal.request.retry', { method, path, attempt, reason: 'network', waitMs, err });
        await this.sleep(waitMs);
        continue;
      }
      const ms = Math.round(performance.now() - startedAt);
      this.stats.requestMs += ms;
      this.log.debug('tidal.request', { method, path, status: res.status, ms, attempt });

      if (res.status === 401 && !refreshed && this.forceRefresh) {
        refreshed = true;
        this.log.info('tidal.request.unauthorized', { method, path, action: 'refresh_token' });
        await this.forceRefresh();
        attempt -= 1; // a token refresh doesn't count as a retry
        continue;
      }

      // 409 on a retried write means "original still processing" under the idempotency contract.
      // 409 on a write means "a request with this Idempotency-Key is still processing" — either our
      // own earlier attempt, or (with a caller-supplied key) a previous workflow attempt.
      const inFlight = isWrite && res.status === 409 && (attempt > 0 || Boolean(key));
      const retryable = res.status === 429 || res.status >= 500 || inFlight;
      if (res.status === 429) this.stats.rateLimited += 1;
      else if (res.status >= 500) this.stats.serverErrors += 1;
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = retryAfterMs(res);
        const waitMs = retryAfter ?? backoff(attempt);
        this.stats.retries += 1;
        this.stats.retryWaitMs += waitMs;
        this.log.warn('tidal.request.retry', { method, path, status: res.status, attempt, waitMs, retryAfterMs: retryAfter });
        await this.sleep(waitMs);
        continue;
      }
      if (retryable) this.log.warn('tidal.request.gave_up', { method, path, status: res.status, attempt });

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

  post(path, body, { query, idempotencyKey } = {}) {
    return this.request('POST', path, { body, query, idempotencyKey });
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
