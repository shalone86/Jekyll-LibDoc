'use strict';

/* ---------- small helpers ---------- */

const $ = (sel) => document.querySelector(sel);

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep going in memory */ }
  },
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return dayKey(d); };
const longDate = (s) => { const d = parseDay(s); return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clean = (s) => s.replace(/\s+/g, ' ').trim();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  e.append(...kids.flat().filter((k) => k != null && k !== false));
  return e;
}
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

/* ---------- data ----------
 * tasks:  { id, text, order, created, doneAt, doneDay, updated }   doneAt set = archived
 * habits: { id, text, order, created, retired, updated, log: { 'YYYY-MM-DD': { done, at } } }
 * Nothing is ever deleted, so two devices can always be merged item by item.
 */

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  return {
    version: 1,
    tasks: Array.isArray(d.tasks) ? d.tasks : [],
    habits: Array.isArray(d.habits) ? d.habits.map((h) => ({ ...h, log: h.log || {} })) : [],
  };
}

let data = normalize(store.get('data', null));
let settings = { owner: '', repo: '', branch: 'main', folder: 'Todo', token: '', ...store.get('settings', {}) };
let lastSyncedSha = store.get('lastSyncedSha', null);

const find = (list, id) => list.find((x) => x.id === id);
const byOrder = (a, b) => a.order - b.order;
const openTasks = () => data.tasks.filter((t) => !t.doneAt).sort(byOrder);
const activeHabits = () => data.habits.filter((h) => !h.retired).sort(byOrder);
const nextOrder = (list) => list.reduce((m, x) => Math.max(m, x.order), 0) + 1;

const doneOn = (h, day) => !!(h.log[day] && h.log[day].done);
const doneDays = (h) => Object.keys(h.log).filter((d) => h.log[d].done).sort();
function streak(h) {
  let d = dayKey();
  if (!doneOn(h, d)) d = addDays(d, -1);
  let n = 0;
  while (doneOn(h, d)) { n++; d = addDays(d, -1); }
  return n;
}

function change() {
  store.set('data', data);
  render();
  scheduleSync();
}
function touch(item, patch) { Object.assign(item, patch, { updated: Date.now() }); }

function addTask(text) {
  const now = Date.now();
  data.tasks.push({ id: uid(), text, order: nextOrder(openTasks()), created: now, doneAt: null, doneDay: null, updated: now });
  change();
}
function completeTask(id) {
  const t = find(data.tasks, id);
  touch(t, { doneAt: Date.now(), doneDay: dayKey() });
  change();
  toast(`Archived “${t.text}”`, () => { touch(t, { doneAt: null, doneDay: null }); change(); });
}
function restoreTask(id) {
  touch(find(data.tasks, id), { doneAt: null, doneDay: null, order: nextOrder(openTasks()) });
  change();
}
function addHabit(text) {
  const now = Date.now();
  data.habits.push({ id: uid(), text, order: nextOrder(activeHabits()), created: now, retired: false, updated: now, log: {} });
  change();
}
function toggleHabit(id) {
  const h = find(data.habits, id);
  const day = dayKey();
  h.log[day] = { done: !doneOn(h, day), at: Date.now() };
  change();
}
function setRetired(id, retired) {
  const h = find(data.habits, id);
  touch(h, { retired, order: retired ? h.order : nextOrder(activeHabits()) });
  change();
  if (retired) toast(`Retired “${h.text}” — its count is kept in the archive`, () => setRetired(id, false));
}
function rename(list, id, text) { touch(find(list, id), { text }); change(); }
function reorder(list, ids) {
  ids.forEach((id, i) => { const x = find(list, id); if (x && x.order !== i + 1) touch(x, { order: i + 1 }); });
  change();
}

/* ---------- merge (used when another device has pushed changes) ---------- */

function mergeById(a, b, pick) {
  const out = new Map(a.map((x) => [x.id, x]));
  for (const y of b) { const x = out.get(y.id); out.set(y.id, x ? pick(x, y) : y); }
  return [...out.values()];
}
const newer = (x, y) => ((y.updated || 0) > (x.updated || 0) ? y : x);
function mergeData(local, remote) {
  return {
    version: 1,
    tasks: mergeById(local.tasks, remote.tasks, newer),
    habits: mergeById(local.habits, remote.habits, (x, y) => {
      const log = { ...x.log };
      for (const [d, e] of Object.entries(y.log)) if (!log[d] || e.at > log[d].at) log[d] = e;
      return { ...newer(x, y), log };
    }),
  };
}

/* ---------- markdown files written to the repo (readable in Obsidian) ---------- */

function archiveByDay() {
  const days = new Map();
  const get = (d) => days.get(d) || days.set(d, { habits: [], tasks: [] }).get(d);
  for (const h of [...data.habits].sort(byOrder)) for (const d of doneDays(h)) get(d).habits.push(h);
  for (const t of data.tasks.filter((t) => t.doneAt).sort((a, b) => a.doneAt - b.doneAt)) get(t.doneDay).tasks.push(t);
  return new Map([...days].sort((a, b) => b[0].localeCompare(a[0])));
}

function archiveMarkdown(day, { habits, tasks }) {
  const lines = [`# ${longDate(day)}`, ''];
  if (habits.length) {
    lines.push('## Daily', '');
    for (const h of habits) lines.push(`- [x] ${h.text} (#${doneDays(h).indexOf(day) + 1})`);
    lines.push('');
  }
  if (tasks.length) {
    lines.push('## Tasks', '');
    for (const t of tasks) lines.push(`- [x] ${t.text}`);
    lines.push('');
  }
  return lines.join('\n');
}

function todoMarkdown() {
  const today = dayKey();
  const lines = ['# To do', '', '> Written by the Daily app. Edit your list in the app — changes made here are overwritten.', ''];
  lines.push(`## Daily · ${longDate(today)}`, '');
  for (const h of activeHabits()) {
    lines.push(`- [${doneOn(h, today) ? 'x' : ' '}] ${h.text} — ${plural(doneDays(h).length, 'time')}, ${streak(h)}-day streak`);
  }
  lines.push('', '## Tasks', '');
  for (const t of openTasks()) lines.push(`- [ ] ${t.text}`);
  lines.push('');
  return lines.join('\n');
}

function repoPath(name) {
  const dir = (settings.folder || '').trim().replace(/^\/+|\/+$/g, '');
  return dir ? `${dir}/${name}` : name;
}

function buildFiles() {
  const files = {
    [repoPath('data.json')]: JSON.stringify(data, null, 2) + '\n',
    [repoPath('Todo.md')]: todoMarkdown(),
  };
  for (const [day, entry] of archiveByDay()) files[repoPath(`Archive/${day}.md`)] = archiveMarkdown(day, entry);
  return files;
}

/* ---------- GitHub sync ---------- */

const utf8 = new TextEncoder();
async function gitBlobSha(text) {
  const body = utf8.encode(text);
  const head = utf8.encode(`blob ${body.length}\0`);
  const buf = new Uint8Array(head.length + body.length);
  buf.set(head);
  buf.set(body, head.length);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
function toBase64(text) {
  let bin = '';
  for (const b of utf8.encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const configured = () => settings.owner && settings.repo && settings.token;

async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${settings.owner}/${settings.repo}${path}`, {
    ...options,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${settings.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let message = '';
    try { message = (await res.json()).message || ''; } catch { /* not JSON */ }
    const err = new Error(message || `GitHub error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function explain(err) {
  if (!navigator.onLine || err instanceof TypeError) return 'Offline — saved on this device';
  if (err.status === 401) return 'Token rejected — check settings';
  if (err.status === 404) return 'Repo or branch not found — check settings';
  if (err.status === 403) return /rate limit/i.test(err.message) ? 'GitHub rate limit — will retry' : 'Token can’t write to this repo';
  return err.message;
}

async function syncOnce() {
  const branch = settings.branch || 'main';
  const dataPath = repoPath('data.json');
  let ref;
  try {
    ref = await gh(`/git/ref/heads/${branch}`);
  } catch (err) {
    if (err.status !== 409) throw err;
    // 409 = brand-new empty repository: create the first commit so there is a branch to build on.
    await gh(`/contents/${encodeURI(dataPath)}`, {
      method: 'PUT',
      body: JSON.stringify({ message: 'Start Daily to-do data', content: toBase64(JSON.stringify(data, null, 2) + '\n') }),
    });
    ref = await gh(`/git/ref/heads/${branch}`);
  }
  const head = await gh(`/git/commits/${ref.object.sha}`);
  const tree = await gh(`/git/trees/${head.tree.sha}?recursive=1`);
  const remote = new Map(tree.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t.sha]));

  // Pull in anything another device pushed since we last synced.
  const remoteSha = remote.get(dataPath);
  if (remoteSha && remoteSha !== lastSyncedSha) {
    const blob = await gh(`/git/blobs/${remoteSha}`);
    data = mergeData(data, normalize(JSON.parse(fromBase64(blob.content))));
    store.set('data', data);
    render();
  }

  const files = buildFiles();
  const changes = [];
  for (const [path, content] of Object.entries(files)) {
    if (remote.get(path) !== await gitBlobSha(content)) changes.push({ path, mode: '100644', type: 'blob', content });
  }
  const archiveDir = repoPath('Archive/');
  for (const path of remote.keys()) {
    if (path.startsWith(archiveDir) && /\/\d{4}-\d\d-\d\d\.md$/.test(path) && !(path in files)) {
      changes.push({ path, mode: '100644', type: 'blob', sha: null });
    }
  }

  if (changes.length) {
    const newTree = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree: changes }) });
    const commit = await gh('/git/commits', {
      method: 'POST',
      body: JSON.stringify({ message: `Daily: update ${dayKey()}`, tree: newTree.sha, parents: [ref.object.sha] }),
    });
    await gh(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
  }
  lastSyncedSha = await gitBlobSha(files[dataPath]);
  store.set('lastSyncedSha', lastSyncedSha);
}

let syncing = false;
let syncAgain = false;
let syncTimer = null;

function scheduleSync(delay = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

async function sync() {
  clearTimeout(syncTimer);
  syncTimer = null;
  if (!configured()) return setStatus('local', 'On this device only — tap to back up');
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setStatus('syncing', 'Syncing…');
  try {
    for (let attempt = 1; ; attempt++) {
      try { await syncOnce(); break; } catch (err) {
        // 409/422 here means another device pushed in the middle of our save: start over from its commit.
        if (attempt < 3 && (err.status === 409 || err.status === 422)) continue;
        throw err;
      }
    }
    const t = new Date();
    setStatus('ok', `Backed up ${pad(t.getHours())}:${pad(t.getMinutes())}`);
  } catch (err) {
    console.error(err);
    setStatus('error', explain(err));
    return err;
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(300); }
  }
}

function setStatus(state, text) {
  $('#status').dataset.state = state;
  $('#status-text').textContent = text;
}

/* ---------- rendering ---------- */

let renderedDay = dayKey();
let dragging = false;
let renderPending = false;
let editingHabits = false;
let archiveDays = 30;

function editableText(text, onRename) {
  const span = el('span', { class: 'text', contenteditable: 'true', spellcheck: 'false', enterkeyhint: 'done' }, text);
  span.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
    if (e.key === 'Escape') { span.textContent = text; span.blur(); }
  });
  span.addEventListener('blur', () => {
    const value = clean(span.textContent);
    if (!value) span.textContent = text;
    else if (value !== text) onRename(value);
  });
  return span;
}

function render() {
  if (dragging) { renderPending = true; return; }
  if (document.activeElement && document.activeElement.classList.contains('text')) {
    // Don't yank a line out from under someone who is typing; re-render when they finish.
    renderPending = true;
    return;
  }
  renderPending = false;
  renderedDay = dayKey();
  $('#date').textContent = longDate(renderedDay);
  renderToday();
  renderArchive();
}

function renderToday() {
  const today = dayKey();
  const habits = activeHabits();
  const done = habits.filter((h) => doneOn(h, today)).length;
  $('#daily-progress').textContent = habits.length ? `${done}/${habits.length}` : '';
  $('#edit-habits').textContent = editingHabits ? 'Done' : 'Edit';
  $('#edit-habits').hidden = !habits.length;

  fill($('#habits'), ...(habits.length ? habits.map((h) => {
    const checked = doneOn(h, today);
    const n = doneDays(h).length;
    const s = streak(h);
    return el('li', { class: `item habit${checked ? ' done' : ''}`, 'data-id': h.id },
      el('span', { class: 'grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⋮⋮'),
      el('button', { class: 'check', type: 'button', role: 'checkbox', 'aria-checked': String(checked), 'aria-label': h.text, onclick: () => toggleHabit(h.id) }),
      editableText(h.text, (v) => rename(data.habits, h.id, v)),
      editingHabits
        ? el('button', { class: 'small-btn', type: 'button', onclick: () => setRetired(h.id, true) }, 'Retire')
        : el('span', { class: 'meta', title: `${plural(n, 'time')} in total, ${s}-day streak` }, el('b', {}, `${n}×`), s > 1 ? ` · 🔥${s}` : ''));
  }) : [el('li', { class: 'empty' }, 'No daily habits yet.')]));

  const tasks = openTasks();
  $('#task-count').textContent = tasks.length ? String(tasks.length) : '';
  fill($('#tasks'), ...(tasks.length ? tasks.map((t) => el('li', { class: 'item', 'data-id': t.id },
    el('span', { class: 'grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⋮⋮'),
    el('button', {
      class: 'check', type: 'button', role: 'checkbox', 'aria-checked': 'false', 'aria-label': t.text,
      onclick: (e) => {
        // Show the tick for a moment before the task slides off to the archive.
        const li = e.currentTarget.closest('li');
        li.classList.add('done', 'leaving');
        setTimeout(() => completeTask(t.id), 450);
      },
    }),
    editableText(t.text, (v) => rename(data.tasks, t.id, v)))) : [el('li', { class: 'empty' }, 'Nothing to do. Nice.')]));
}

function dayLabel(day) {
  const today = dayKey();
  if (day === today) return 'Today';
  if (day === addDays(today, -1)) return 'Yesterday';
  return null;
}

function renderArchive() {
  const allHabits = [...data.habits].sort((a, b) => (a.retired - b.retired) || byOrder(a, b));
  const doneTasks = data.tasks.filter((t) => t.doneAt).length;
  fill($('#stats'), 
    el('div', { class: 'stat' }, el('span', { class: 'name' }, 'Tasks completed'), el('span', { class: 'num' }, String(doneTasks))),
    ...allHabits.map((h) => el('div', { class: 'stat' },
      el('span', { class: 'name' }, h.text, h.retired ? el('span', { class: 'extra' }, ' (retired)') : null),
      el('span', { class: 'extra' }, streak(h) ? `🔥 ${streak(h)}-day streak` : ''),
      el('span', { class: 'num' }, `${doneDays(h).length}×`))),
  );

  const days = [...archiveByDay()];
  const shown = days.slice(0, archiveDays);
  fill($('#archive'), 
    ...(days.length ? [] : [el('section', { class: 'card' }, el('p', { class: 'empty' }, 'Things you finish will show up here, grouped by day.'))]),
    ...shown.map(([day, { habits, tasks }]) => el('section', { class: 'card day' },
      el('h3', {}, longDate(day), dayLabel(day) ? el('small', {}, dayLabel(day)) : null),
      el('ul', { class: 'list plain' },
        ...habits.map((h) => el('li', { class: 'item' },
          el('span', { class: 'done-mark' }, '✓'), el('span', { class: 'text' }, h.text), el('span', { class: 'tag' }, `daily #${doneDays(h).indexOf(day) + 1}`))),
        ...tasks.map((t) => el('li', { class: 'item' },
          el('span', { class: 'done-mark' }, '✓'), el('span', { class: 'text' }, t.text),
          el('button', { class: 'small-btn', type: 'button', onclick: () => restoreTask(t.id) }, 'Restore')))))),
    days.length > shown.length
      ? el('button', { class: 'more', type: 'button', onclick: () => { archiveDays += 60; renderArchive(); } }, `Show older (${days.length - shown.length} more days)`)
      : null,
  );

  const retired = data.habits.filter((h) => h.retired).sort(byOrder);
  $('#retired-card').hidden = !retired.length;
  fill($('#retired'), ...retired.map((h) => el('li', { class: 'item' },
    el('span', { class: 'text' }, h.text), el('span', { class: 'meta' }, `${doneDays(h).length}×`),
    el('button', { class: 'small-btn', type: 'button', onclick: () => setRetired(h.id, false) }, 'Bring back'))));
}

/* ---------- drag to reorder (works with mouse and touch) ---------- */

function enableDrag(list, onDrop) {
  list.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.grip');
    if (!grip || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const item = grip.closest('li');
    e.preventDefault();
    dragging = true;
    item.classList.add('dragging');
    const before = [...list.children].map((x) => x.dataset.id).join();
    let scrollTimer = null;
    let lastY = e.clientY;

    const place = () => {
      const others = [...list.children].filter((x) => x !== item);
      const next = others.find((x) => { const r = x.getBoundingClientRect(); return lastY < r.top + r.height / 2; }) || null;
      if (item.nextElementSibling !== next) list.insertBefore(item, next);
    };
    const move = (ev) => {
      lastY = ev.clientY;
      place();
      const edge = 70;
      const speed = lastY < edge ? -8 : lastY > innerHeight - edge - 70 ? 8 : 0;
      clearInterval(scrollTimer);
      if (speed) scrollTimer = setInterval(() => { scrollBy(0, speed); place(); }, 16);
    };
    const end = () => {
      clearInterval(scrollTimer);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      item.classList.remove('dragging');
      dragging = false;
      const ids = [...list.children].map((x) => x.dataset.id);
      if (ids.join() !== before) onDrop(ids);
      else if (renderPending) render();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  });
}

/* ---------- toast with undo ---------- */

let toastTimer = null;
let toastUndo = null;
function toast(text, undo) {
  $('#toast-text').textContent = text;
  toastUndo = undo;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; toastUndo = null; }, 5000);
}
$('#toast-undo').addEventListener('click', () => {
  $('#toast').hidden = true;
  clearTimeout(toastTimer);
  if (toastUndo) toastUndo();
  toastUndo = null;
});

/* ---------- wiring ---------- */

function bindAdd(form, add) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = clean(form.text.value);
    if (!value) return;
    add(value);
    form.text.value = '';
    form.text.focus();
  });
}
bindAdd($('#add-task'), addTask);
bindAdd($('#add-habit'), addHabit);

enableDrag($('#habits'), (ids) => reorder(data.habits, ids));
enableDrag($('#tasks'), (ids) => reorder(data.tasks, ids));

$('#edit-habits').addEventListener('click', () => { editingHabits = !editingHabits; render(); });

document.addEventListener('focusout', (e) => {
  if (e.target.classList && e.target.classList.contains('text') && renderPending) setTimeout(render);
});

for (const btn of document.querySelectorAll('.tabs button')) {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b === btn);
    $('#view-today').hidden = view !== 'today';
    $('#view-archive').hidden = view !== 'archive';
    $('#title').textContent = view === 'today' ? 'Today' : 'Archive';
    scrollTo(0, 0);
  });
}

const dialog = $('#settings');
const form = $('#settings-form');
function openSettings() {
  for (const key of ['owner', 'repo', 'branch', 'folder', 'token']) form[key].value = settings[key] || '';
  $('#settings-error').hidden = true;
  dialog.showModal();
}
$('#open-settings').addEventListener('click', openSettings);
$('#status').addEventListener('click', () => (configured() ? sync() : openSettings()));
$('#settings-cancel').addEventListener('click', () => dialog.close());
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = {};
  for (const key of ['owner', 'repo', 'branch', 'folder', 'token']) next[key] = form[key].value.trim();
  next.branch = next.branch || 'main';
  const target = (s) => [s.owner, s.repo, s.branch, s.folder].join('|');
  // A different repo/folder is a fresh start for syncing: merge everything that's there.
  if (target(next) !== target(settings)) { lastSyncedSha = null; store.set('lastSyncedSha', null); }
  settings = next;
  store.set('settings', settings);
  $('#settings-save').disabled = true;
  const err = await sync();
  $('#settings-save').disabled = false;
  if (err) {
    $('#settings-error').textContent = explain(err);
    $('#settings-error').hidden = false;
  } else {
    dialog.close();
  }
});
$('#backup').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  el('a', { href: url, download: `daily-backup-${dayKey()}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// Daily items reset at midnight: re-render when the date changes, and pull fresh data when the app comes back.
setInterval(() => { if (dayKey() !== renderedDay) render(); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { if (syncTimer) sync(); } else { render(); sync(); }
});
addEventListener('online', () => sync());

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
sync();
