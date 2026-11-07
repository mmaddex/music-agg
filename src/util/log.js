// Structured logging: one line per event, `key=value` pairs (logfmt), written to stdout/stderr.
//
//   level=info event=match.chunk.done importId=… chunk=3/12 tracks=100 ms=143210
//
// Search Render's log viewer by text, e.g. `event=match.chunk.done` or `importId=<id>`.
// Use log.child({ importId }) to carry context on every line.
//
// LOG_LEVEL: debug | info (default) | warn | error | silent. Defaults to silent under
// `node --test` so test output stays readable.
//
// Never log tokens, Authorization headers, OAuth codes or cookies.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function defaultLevel(env = process.env) {
  if (env.LOG_LEVEL && LEVELS[env.LOG_LEVEL] !== undefined) return env.LOG_LEVEL;
  return env.NODE_TEST_CONTEXT ? 'silent' : 'info';
}

let threshold = LEVELS[defaultLevel()];

/** Change the level at runtime (tests, scripts). */
export function setLogLevel(level) {
  if (LEVELS[level] === undefined) throw new Error(`Unknown log level ${level}`);
  threshold = LEVELS[level];
}

const SAFE = /^[A-Za-z0-9_.:/@+\-]+$/;

function formatValue(v) {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return SAFE.test(s) ? s : JSON.stringify(s);
}

/** Pull the useful parts of an error into fields. */
export function errorFields(err) {
  if (!err) return {};
  const fields = { err: err.message || String(err), errType: err.constructor?.name };
  if (err.status !== undefined) fields.errStatus = err.status;
  if (err.path) fields.errPath = err.path;
  return fields;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** { tidal: { requests: 2 } } → [['tidal.requests', 2]] so nested values stay searchable. */
function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) flatten(v, key, out);
    else out.push([key, v]);
  }
  return out;
}

function write(level, base, event, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const { err, ...rest } = fields;
  const all = { level, event, ...base, ...rest, ...(err ? errorFields(err) : {}) };
  let line = flatten(all)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(' ');
  // Stack traces only for errors, on following lines so the summary line stays greppable.
  if (err?.stack && level === 'error') line += `\n${err.stack}`;
  (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
}

function makeLogger(base) {
  return {
    debug: (event, fields) => write('debug', base, event, fields),
    info: (event, fields) => write('info', base, event, fields),
    warn: (event, fields) => write('warn', base, event, fields),
    error: (event, fields) => write('error', base, event, fields),
    child: (fields) => makeLogger({ ...base, ...fields }),
    isDebug: () => threshold <= LEVELS.debug,
  };
}

export const log = makeLogger({});

/** Milliseconds since `start` (from performance.now()), rounded. */
export const since = (start) => Math.round(performance.now() - start);
