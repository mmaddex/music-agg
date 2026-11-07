import test from 'node:test';
import assert from 'node:assert/strict';
import { log, setLogLevel } from '../src/util/log.js';

function capture(fn) {
  const lines = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = (s) => lines.push(['out', s]) && true;
  process.stderr.write = (s) => lines.push(['err', s]) && true;
  try {
    fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return lines;
}

test('log lines are logfmt with context, flattened objects and quoted values', (t) => {
  setLogLevel('info');
  t.after(() => setLogLevel('silent'));
  const lines = capture(() => {
    log.child({ importId: 'imp-1' }).info('match.chunk.done', { ms: 12, tidal: { requests: 3, rateLimited: 0 }, reason: 'two words', skipped: undefined });
  });
  assert.deepEqual(lines, [['out', 'level=info event=match.chunk.done importId=imp-1 ms=12 tidal.requests=3 tidal.rateLimited=0 reason="two words"\n']]);
});

test('levels filter, warnings go to stderr, errors carry fields and a stack', (t) => {
  setLogLevel('info');
  t.after(() => setLogLevel('silent'));
  const err = Object.assign(new Error('boom'), { status: 503 });
  const lines = capture(() => {
    log.debug('hidden');
    log.warn('careful', { err });
    log.error('broken', { err });
  });
  assert.equal(lines.length, 2);
  assert.equal(lines[0][0], 'err');
  assert.equal(lines[0][1], 'level=warn event=careful err=boom errType=Error errStatus=503\n');
  assert.match(lines[1][1], /^level=error event=broken err=boom errType=Error errStatus=503\nError: boom\n/);
});
