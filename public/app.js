// Front-end for the import flow: login → upload → choose → match → review → import.
// All user/track text is inserted with textContent (exports are untrusted input).

const $ = (sel) => document.querySelector(sel);
const STEPS = ['login', 'upload', 'select', 'progress', 'review', 'done'];

const state = {
  me: null,
  upload: null, // response of POST /api/uploads
  names: {}, // collectionId -> playlist name on TIDAL
  selected: new Set(), // collectionIds
  match: null, // match job result
  matchJobId: null,
  decisions: {}, // trackKey -> tidal track id | null
  filter: 'all',
};

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

function show(step) {
  for (const s of STEPS) $(`#step-${s}`).hidden = s !== step;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function flash(message, kind = 'error') {
  const el = $('#flash');
  el.textContent = message || '';
  el.className = `flash ${kind === 'info' ? 'info' : ''}`;
  el.hidden = !message;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    await loadMe();
    throw new Error(body.error || 'Your TIDAL session expired. Please log in again.');
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const postJson = (path, data) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

const fmtDuration = (ms) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}` : '');
const describe = (c) => `${c.title}${c.version ? ` (${c.version})` : ''} — ${c.artists.join(', ')}${c.album ? ` · ${c.album}` : ''}`;

// ---- account / login -------------------------------------------------------------

async function loadMe() {
  state.me = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json());
  const acct = $('#account');
  acct.replaceChildren();
  if (state.me.loggedIn) {
    const u = state.me.user || {};
    acct.append(
      h('span', {}, 'TIDAL: ', h('strong', {}, u.username || 'logged in'), u.country ? ` (${u.country})` : ''),
      h('button', { class: 'link', onclick: logout }, 'Log out'),
    );
  }
  $('#formats').replaceChildren(...state.me.formats.map((f) => h('li', {}, h('strong', {}, f.label), ' — ', f.description)));
  if (state.me.configProblems?.length) flash(`Server configuration: ${state.me.configProblems.join(' ')}`);
  return state.me;
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  location.href = '/';
}

// ---- upload ---------------------------------------------------------------------

async function uploadFile(file) {
  if (!file) return;
  flash('');
  show('progress');
  setProgress('Reading your export…', `${file.name}`, 0, 0);
  const form = new FormData();
  form.append('file', file);
  try {
    state.upload = await api('/api/uploads', { method: 'POST', body: form });
    state.names = Object.fromEntries(state.upload.collections.map((c) => [c.id, c.name]));
    state.selected = new Set(state.upload.collections.filter((c) => c.suggested && c.trackCount).map((c) => c.id));
    renderSelect();
    show('select');
  } catch (err) {
    flash(err.message);
    show('upload');
  }
}

function renderSelect() {
  const up = state.upload;
  $('#detected').textContent = `${up.filename} · detected ${up.formatLabel}`;
  $('#warnings').replaceChildren(...up.warnings.map((w) => h('li', {}, w)));
  const rows = up.collections.map((c) => {
    const box = h('input', {
      type: 'checkbox',
      checked: state.selected.has(c.id),
      disabled: !c.trackCount,
      onchange: (e) => {
        if (e.target.checked) state.selected.add(c.id);
        else state.selected.delete(c.id);
        updateMatchButton();
      },
    });
    const nameCell =
      c.kind === 'favorites'
        ? h('td', {}, h('div', {}, c.name), h('div', { class: 'sub' }, c.description || ''))
        : h(
            'td',
            {},
            h('input', { type: 'text', value: state.names[c.id], maxlength: '250', oninput: (e) => (state.names[c.id] = e.target.value) }),
            c.needsLookupCount ? h('div', { class: 'sub' }, `${c.needsLookupCount} of ${c.trackCount} only have a YouTube video id; titles are looked up on YouTube first`) : null,
          );
    return h(
      'tr',
      {},
      h('td', {}, box),
      nameCell,
      h('td', {}, c.kind === 'favorites' ? 'Favourites' : 'Playlist'),
      h('td', { class: 'num-col' }, c.trackCount),
    );
  });
  $('#collections').replaceChildren(...rows);
  updateMatchButton();
}

function updateMatchButton() {
  const n = state.upload.collections.filter((c) => state.selected.has(c.id)).reduce((a, c) => a + c.trackCount, 0);
  $('#btn-match').disabled = !state.selected.size;
  $('#btn-match').textContent = state.selected.size ? `Find ${n} tracks on TIDAL` : 'Select something to import';
}

// ---- jobs -----------------------------------------------------------------------

function setProgress(title, phase, done, total) {
  $('#progress-title').textContent = title;
  $('#progress-phase').textContent = phase || '';
  $('#progress-bar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  $('#progress-count').textContent = total ? `${done} / ${total}` : '';
}

async function waitForJob(jobId, title) {
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    setProgress(title, job.phase, job.progress.done, job.progress.total);
    if (job.status === 'done') return job.result;
    if (job.status === 'failed') throw new Error(job.error || 'Job failed');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function startMatch() {
  flash('');
  show('progress');
  setProgress('Finding your music on TIDAL', 'Starting…', 0, 0);
  try {
    const job = await postJson(`/api/uploads/${state.upload.uploadId}/match`, { collectionIds: [...state.selected] });
    state.matchJobId = job.id;
    state.match = await waitForJob(job.id, 'Finding your music on TIDAL');
    state.decisions = {};
    renderReview();
    show('review');
  } catch (err) {
    flash(err.message);
    show('select');
  }
}

// ---- review ---------------------------------------------------------------------

function chosenId(key) {
  if (Object.hasOwn(state.decisions, key)) return state.decisions[key];
  const m = state.match.tracks[key].match;
  return m.status === 'matched' ? m.best.id : null;
}

function renderReview() {
  const s = state.match.stats;
  $('#stats').replaceChildren(
    h('div', { class: 'stat' }, h('b', {}, s.matched), 'matched'),
    h('div', { class: 'stat' }, h('b', {}, s.review), 'need review'),
    h('div', { class: 'stat' }, h('b', {}, s.not_found + s.error), 'not found'),
  );
  const wrap = $('#review-collections');
  wrap.replaceChildren(
    ...state.match.collections.map((c) => {
      const details = h('details', { class: 'coll' });
      const counter = h('span', { class: 'muted small' });
      details.append(h('summary', {}, h('span', { class: 'name' }, state.names[c.id] || c.name), counter));
      details.dataset.id = c.id;
      details.addEventListener('toggle', () => details.open && renderTracks(details, c));
      details._counter = counter;
      return details;
    }),
  );
  updateCounts();
}

function renderTracks(details, c) {
  details.querySelector('.table-wrap')?.remove();
  const rows = [];
  const seen = new Set();
  for (const item of c.items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    const t = state.match.tracks[item.key];
    const m = t.match;
    if (state.filter !== 'all' && m.status !== state.filter && !(state.filter === 'not_found' && m.status === 'error')) continue;
    const label = { matched: 'Matched', review: 'Needs review', not_found: 'Not found', error: 'Error' }[m.status];
    const options = [m.best, ...(m.alternatives || [])].filter(Boolean);
    const select = h(
      'select',
      {
        onchange: (e) => {
          state.decisions[item.key] = e.target.value || null;
          updateCounts();
        },
      },
      h('option', { value: '' }, "Don't import"),
      ...options.map((o) => h('option', { value: o.id }, `${describe(o)} (${Math.round(o.score * 100)}%)`)),
    );
    select.value = chosenId(item.key) || '';
    const src = t.title
      ? [h('div', { class: 'src-title' }, t.title), h('div', { class: 'sub' }, [t.artistCredit, t.album].filter(Boolean).join(' · '))]
      : [h('div', { class: 'src-title' }, `YouTube video ${t.source?.id || ''}`)];
    if (t.videoTitle) src.push(h('div', { class: 'sub' }, `from video “${t.videoTitle}”`));
    rows.push(
      h(
        'tr',
        {},
        h('td', {}, ...src),
        h('td', {}, h('span', { class: `status ${m.status}` }, label), m.reason ? h('div', { class: 'sub' }, m.reason) : null),
        h('td', {}, options.length ? select : h('span', { class: 'muted small' }, '—')),
      ),
    );
  }
  const table = h(
    'table',
    { class: 'track-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'From your export'), h('th', {}, 'Status'), h('th', {}, 'TIDAL track'))),
    h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: '3', class: 'muted' }, 'Nothing in this view.'))),
  );
  details.append(h('div', { class: 'table-wrap' }, table));
}

function updateCounts() {
  let total = 0;
  for (const details of $('#review-collections').children) {
    const c = state.match.collections.find((x) => x.id === details.dataset.id);
    const ids = new Set(c.items.map((i) => chosenId(i.key)).filter(Boolean));
    total += ids.size;
    details._counter.textContent = `${ids.size} of ${c.items.length} will be imported`;
  }
  $('#import-summary').textContent = `${total} tracks across ${state.match.collections.length} collection(s)`;
  $('#btn-import').disabled = total === 0;
}

function acceptAllReview() {
  let n = 0;
  for (const [key, t] of Object.entries(state.match.tracks)) {
    if (t.match.status === 'review' && t.match.best && !Object.hasOwn(state.decisions, key)) {
      state.decisions[key] = t.match.best.id;
      n += 1;
    }
  }
  flash(n ? `Accepted ${n} suggested matches. You can still change any of them below.` : 'Nothing left to accept.', 'info');
  setFilter(state.filter);
  updateCounts();
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll('.filters .chip[data-filter]').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
  for (const details of $('#review-collections').children) {
    if (details.open) renderTracks(details, state.match.collections.find((x) => x.id === details.dataset.id));
  }
}

async function startImport() {
  if (!confirm('Create these playlists and add tracks to your TIDAL account?')) return;
  flash('');
  show('progress');
  setProgress('Importing to TIDAL', 'Starting…', 0, 0);
  try {
    const job = await postJson('/api/imports', {
      matchJobId: state.matchJobId,
      collections: state.match.collections.map((c) => ({ id: c.id, name: state.names[c.id] || c.name })),
      decisions: state.decisions,
    });
    const result = await waitForJob(job.id, 'Importing to TIDAL');
    $('#done-list').replaceChildren(
      ...result.collections.map((c) =>
        h(
          'li',
          {},
          c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener' }, c.name) : c.name,
          ` — ${c.added} added`,
          c.skipped ? `, ${c.skipped} skipped` : '',
          c.error ? h('div', { class: 'err' }, c.error) : null,
        ),
      ),
    );
    show('done');
  } catch (err) {
    flash(err.message);
    show('review');
  }
}

// ---- wiring ---------------------------------------------------------------------

function wire() {
  const input = $('#file');
  const zone = $('#dropzone');
  input.addEventListener('change', () => uploadFile(input.files[0]));
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
    uploadFile(e.dataTransfer.files[0]);
  });
  $('#btn-match').addEventListener('click', startMatch);
  $('#btn-reupload').addEventListener('click', () => {
    input.value = '';
    show('upload');
  });
  $('#btn-import').addEventListener('click', startImport);
  $('#btn-again').addEventListener('click', () => {
    input.value = '';
    show('upload');
  });
  document.querySelectorAll('.filters .chip[data-filter]').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
  $('#btn-accept-review').addEventListener('click', acceptAllReview);
}

async function init() {
  wire();
  const params = new URLSearchParams(location.search);
  if (params.get('authError')) flash(`TIDAL login failed: ${params.get('authError')}`);
  if (params.size) history.replaceState(null, '', '/');
  const me = await loadMe();
  show(me.loggedIn ? 'upload' : 'login');
}

init();
