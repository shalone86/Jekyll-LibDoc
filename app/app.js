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
 * symptoms: { id, name, day, time, at, severity (1 mild, 2 moderate, 3 acute), note, removed, updated }
 * albums:   { id, name, created, createdDay, finishedAt, finishedDay, updated }   steps are tasks with albumId
 * sessions: { id, albumId, day, at, note, habitId, removed, updated }   a day spent working on an album
 * A habit with asksAlbum set asks "Which album?" when it's checked.
 * limits: { id, name, unit, dose, windowMax, windowHours, dayMax, order, retired, updated }
 * doses:  { id, limitId, amount, at, day, time, removed, updated }   one logged amount of a limited thing
 * Things to buy are tasks with buy: true, plus dueMonth ('YYYY-MM', or null for someday),
 * whenLabel (e.g. 'Spring') and an optional cost.
 * Tasks may also have: cat (category id), parentId (subtask of another task), collapsed (hide its subtasks), note ({ id, title }: a
 * link to a note in the Scriptorium notes app).
 * Albums have kind 'album' (music) or 'project' (anything else); both have steps and sessions.
 * categories: { id, name, color, order, retired, updated }
 * Nothing is ever deleted, so two devices can always be merged item by item.
 */

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  return {
    version: 1,
    tasks: Array.isArray(d.tasks) ? d.tasks : [],
    habits: Array.isArray(d.habits) ? d.habits.map((h) => ({ ...h, log: h.log || {} })) : [],
    symptoms: Array.isArray(d.symptoms) ? d.symptoms : [],
    albums: Array.isArray(d.albums) ? d.albums : [],
    sessions: Array.isArray(d.sessions) ? d.sessions : [],
    limits: Array.isArray(d.limits) ? d.limits : [],
    doses: Array.isArray(d.doses) ? d.doses : [],
    categories: Array.isArray(d.categories) ? d.categories : [],
  };
}

let data = normalize(store.get('data', null));
let settings = { owner: '', repo: '', branch: 'main', folder: 'Todo', token: '', ...store.get('settings', {}) };
let lastSyncedSha = store.get('lastSyncedSha', null);
// The commit we last synced with, and whether this device has changes GitHub hasn't seen yet.
// Together they let the once-a-minute check stop after a single small request when nothing changed.
let lastHeadSha = store.get('lastHeadSha', null);
let dirty = store.get('dirty', true);
let edits = 0; // counts local changes, so edits made during a sync aren't marked as saved

const find = (list, id) => list.find((x) => x.id === id);
const byOrder = (a, b) => a.order - b.order;
// Album steps are tasks too; the To do list only shows the ones that don't belong to an album.
const openTasks = (albumId = null) => data.tasks.filter((t) => !t.doneAt && !t.buy && (t.albumId || null) === albumId).sort(byOrder);
// Subtasks: a task whose parent is still open is drawn under that parent.
const openParent = (t) => { const p = t.parentId && find(data.tasks, t.parentId); return p && !p.doneAt ? p : null; };
const topTasks = (albumId = null) => openTasks(albumId).filter((t) => !openParent(t));
const childTasks = (id) => data.tasks.filter((t) => !t.doneAt && t.parentId === id).sort(byOrder);
const activeHabits = () => data.habits.filter((h) => !h.retired).sort(byOrder);
const nextOrder = (list) => list.reduce((m, x) => Math.max(m, x.order), 0) + 1;

const doneOn = (h, day) => !!(h.log[day] && h.log[day].done);
const doneDays = (h) => Object.keys(h.log).filter((d) => h.log[d].done).sort();

// A habit repeats every day (the default), every week (Sunday to Saturday) or every month.
// Checks are always logged on the day they happen; a weekly or monthly habit is "done" once
// its period holds as many checks as it needs.
const EVERY = { day: { one: 'day', tag: 'Daily' }, week: { one: 'week', tag: 'Weekly' }, month: { one: 'month', tag: 'Monthly' } };
const everyOf = (h) => (h.every === 'week' || h.every === 'month' ? h.every : 'day');
const timesOf = (h) => (everyOf(h) === 'day' ? 1 : Math.max(1, Math.round(h.times) || 1));
const periodStart = (day, every) => (every === 'week' ? addDays(day, -parseDay(day).getDay()) : every === 'month' ? `${day.slice(0, 7)}-01` : day);
function periodAfter(start, every, n) {
  if (every !== 'month') return addDays(start, (every === 'week' ? 7 : 1) * n);
  const d = parseDay(start);
  d.setMonth(d.getMonth() + n, 1);
  return dayKey(d);
}
const periodDays = (h, day) => { const e = everyOf(h); const s = periodStart(day, e); return doneDays(h).filter((d) => periodStart(d, e) === s); };
const periodCount = (h, day) => periodDays(h, day).length;
const doneIn = (h, day) => (everyOf(h) === 'day' ? doneOn(h, day) : periodCount(h, day) >= timesOf(h));
// Days left in this week or month after today; used to nudge a habit that's still waiting.
function daysLeft(every, day = dayKey()) {
  const d = parseDay(day);
  return every === 'week' ? 6 - d.getDay() : new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate();
}
const isDaily = (h) => everyOf(h) === 'day';
const dailiesDone = (day = dayKey()) => { const ds = activeHabits().filter(isDaily); return ds.length > 0 && ds.every((h) => doneOn(h, day)); };

function streak(h) {
  const e = everyOf(h);
  let p = periodStart(dayKey(), e);
  if (!doneIn(h, p)) p = periodAfter(p, e, -1);
  let n = 0;
  while (doneIn(h, p)) { n++; p = periodAfter(p, e, -1); }
  return n;
}
function bestStreak(h) {
  const e = everyOf(h);
  const need = timesOf(h);
  const counts = new Map();
  for (const d of doneDays(h)) { const p = periodStart(d, e); counts.set(p, (counts.get(p) || 0) + 1); }
  let best = 0;
  let run = 0;
  let prev = null;
  for (const p of [...counts.keys()].sort()) {
    if (counts.get(p) < need) continue;
    run = prev && periodAfter(prev, e, 1) === p ? run + 1 : 1;
    best = Math.max(best, run);
    prev = p;
  }
  return best;
}
function streakText(h) {
  const now = streak(h);
  const best = bestStreak(h);
  const unit = EVERY[everyOf(h)].one;
  // Like the Today screen, a single day isn't a streak yet.
  if (best < 2) return '';
  return now === best ? `🔥 ${now}-${unit} streak (best)` : `${now > 1 ? `🔥 ${now}-${unit} streak · ` : ''}best 🔥 ${best}`;
}

function change() {
  edits++;
  dirty = true;
  store.set('dirty', true);
  store.set('data', data);
  render();
  scheduleSync();
}
function touch(item, patch) { Object.assign(item, patch, { updated: Date.now() }); }

function addTask(text, albumId = null, extra = {}) {
  const now = Date.now();
  const siblings = extra.parentId ? childTasks(extra.parentId) : openTasks(albumId);
  // New tasks go on top; new subtasks go at the bottom of their parent.
  const order = extra.parentId ? nextOrder(siblings) : siblings.reduce((m, x) => Math.min(m, x.order), 1) - 1;
  data.tasks.push({ id: uid(), text, albumId, order, created: now, doneAt: null, doneDay: null, updated: now, cat: null, parentId: null, ...extra });
  change();
}
function completeTask(id) {
  const t = find(data.tasks, id);
  const now = Date.now();
  // Checking a task also checks off its open subtasks.
  const done = [t];
  const walk = (pid) => { for (const c of childTasks(pid)) { done.push(c); walk(c.id); } };
  walk(t.id);
  for (const x of done) touch(x, { doneAt: now, doneDay: dayKey() });
  change();
  const extra = done.length > 1 ? ` and ${plural(done.length - 1, 'subtask')}` : '';
  toast(`${t.buy ? 'Bought' : 'Archived'} “${t.text}”${extra}`, () => { for (const x of done) touch(x, { doneAt: null, doneDay: null }); change(); });
}
function restoreTask(id) {
  const t = find(data.tasks, id);
  touch(t, { doneAt: null, doneDay: null, order: nextOrder(openTasks(t.albumId || null)) });
  change();
}
function addHabit(text, every = 'day') {
  const now = Date.now();
  data.habits.push({ id: uid(), text, every, times: 1, order: nextOrder(activeHabits()), created: now, retired: false, updated: now, log: {} });
  change();
}
function toggleHabit(id, day = dayKey()) {
  const h = find(data.habits, id);
  const e = everyOf(h);
  const wasAllDone = dailiesDone();
  // A weekly or monthly habit that's already complete shows as ticked for the whole period,
  // so tapping it takes back the latest check (or the only one) whichever day that was on.
  const undo = e !== 'day' && doneIn(h, day);
  const days = undo ? (timesOf(h) === 1 ? periodDays(h, day) : periodDays(h, day).slice(-1)) : [day];
  const done = undo ? false : !doneOn(h, day);
  for (const d of days) h.log[d] = { done, at: Date.now() };
  if (!done) {
    // Unchecking takes back the album session that check logged.
    for (const d of days) for (const x of data.sessions) if (x.habitId === id && x.day === d && !x.removed) touch(x, { removed: true });
  }
  change();
  if (done && h.asksAlbum && activeAlbums().length) openSessionDialog({ habitId: id, day });
  renderSymptomLog();
  if (done && e === 'day' && day === dayKey() && !wasAllDone && dailiesDone()) celebrate();
}

// Confetti and a cheer, for finishing the last daily habit of the day.
function celebrate() {
  const pill = $('#daily-progress');
  pill.classList.remove('pop');
  void pill.offsetWidth;
  pill.classList.add('pop');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#2f7d5b', '#e8b04a', '#e0735f', '#5b8def', '#b66fd1', '#f06bb0'];
  const layer = el('div', { class: 'confetti', 'aria-hidden': 'true' },
    Array.from({ length: 70 }, (_, i) => el('i', {
      style: `--x:${(Math.random() * 100).toFixed(1)}vw;--dx:${((Math.random() - 0.5) * 40).toFixed(1)}vw;--r:${Math.round(Math.random() * 720 - 360)}deg;`
        + `--d:${(1.8 + Math.random() * 1.4).toFixed(2)}s;--w:${(Math.random() * 0.5).toFixed(2)}s;--c:${colors[i % colors.length]}`,
    })),
    el('div', { class: 'cheer' }, '🎉 All done for today!'));
  document.body.append(layer);
  setTimeout(() => layer.remove(), 3800);
}
function setRetired(id, retired) {
  const h = find(data.habits, id);
  touch(h, { retired, order: retired ? h.order : nextOrder(activeHabits()) });
  change();
  if (retired) toast(`Retired “${h.text}” — its count is kept in the archive`, () => setRetired(id, false));
}
function rename(list, id, text) { touch(find(list, id), { text }); change(); }
function reorder(list, ids) {
  // Reuse the moved items' own order slots so items hidden by a filter keep their places.
  const items = ids.map((id) => find(list, id)).filter(Boolean);
  const slots = items.map((x) => x.order).sort((a, b) => a - b);
  items.forEach((x, i) => { if (x.order !== slots[i]) touch(x, { order: slots[i] }); });
  change();
}

/* ---------- categories (colored, like tags) ---------- */

const CAT_COLORS = ['#7c5cc4', '#2f9e44', '#868e96', '#1c7ed6', '#e8590c', '#d6336c', '#0c8599', '#c79100'];
const DEFAULT_CATS = [['cat-church', 'Church', '#7c5cc4'], ['cat-groceries', 'Groceries', '#2f9e44'], ['cat-basic', 'Basic', '#868e96']];
const activeCats = () => data.categories.filter((c) => !c.retired).sort(byOrder);
const catOf = (t) => (t.cat ? find(data.categories, t.cat) : null);
let todoFilter = store.get('todoFilter', null); // category id, or null for all

function seedCategories() {
  // Fixed ids so two phones seeding at the same time merge into the same three.
  if (data.categories.length || store.get('catsSeeded', false)) return;
  DEFAULT_CATS.forEach(([id, name, color], i) => data.categories.push({ id, name, color, order: i + 1, retired: false, updated: 1 }));
  store.set('catsSeeded', true);
  store.set('data', data);
}
function addCategory(name) {
  const used = new Set(activeCats().map((c) => c.color));
  const color = CAT_COLORS.find((c) => !used.has(c)) || CAT_COLORS[data.categories.length % CAT_COLORS.length];
  const c = { id: uid(), name, color, order: nextOrder(activeCats()), retired: false, updated: Date.now() };
  data.categories.push(c);
  change();
  return c;
}
function setTaskCat(id, cat) {
  const t = find(data.tasks, id);
  touch(t, { cat });
  for (const c of childTasks(id)) if (!c.cat) touch(c, { cat }); // subtasks follow their parent
  change();
}

/* ---------- subtasks ---------- */

// Indent: make a task a subtask of the task just above it at the same level.
function indentTask(id) {
  const t = find(data.tasks, id);
  const siblings = t.parentId ? childTasks(t.parentId) : topTasks(t.albumId || null);
  const i = siblings.findIndex((x) => x.id === id);
  if (i <= 0) { toast('Nothing above it to go under'); return; }
  const parent = siblings[i - 1];
  touch(t, { parentId: parent.id, order: nextOrder(childTasks(parent.id)), cat: t.cat || parent.cat || null });
  change();
}
// Outdent: move a subtask up one level, right after its old parent.
function outdentTask(id) {
  const t = find(data.tasks, id);
  const parent = openParent(t);
  if (!parent) return;
  const siblings = parent.parentId ? childTasks(parent.parentId) : topTasks(parent.albumId || null);
  const ids = siblings.map((x) => x.id);
  ids.splice(ids.indexOf(parent.id) + 1, 0, id);
  touch(t, { parentId: parent.parentId || null });
  ids.forEach((x, i) => touch(find(data.tasks, x), { order: i + 1 }));
  change();
}

/* ---------- links (task text) and notes (Scriptorium) ---------- */

// The notes app lives next to Daily on GitHub Pages.
const NOTES_APP = location.hostname.endsWith('github.io') ? `${location.origin}/quickstart/` : 'https://shalone86.github.io/quickstart/';
const noteUrl = (id) => `${NOTES_APP}#/note/${encodeURIComponent(id)}`;
const URL_RE = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'’]/g;

function shortUrl(u) {
  try {
    const url = new URL(u);
    if (url.href.startsWith(NOTES_APP) && /#\/note\//.test(url.hash)) return '📝 note';
    const host = url.hostname.replace(/^www\./, '');
    const rest = (url.pathname + url.search).replace(/\/$/, '');
    return rest ? `${host}/…` : host;
  } catch { return u.slice(0, 30); }
}

// Task text with links turned into short, tappable links.
function linkedText(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(el('a', { class: 'tlink', href: m[0], target: '_blank', rel: 'noopener', title: m[0] }, shortUrl(m[0])));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Notes from Scriptorium: from this browser if both apps are open here (same site), else from GitHub,
// where Scriptorium keeps Notes/.scriptorium/db.json in the same repository as Daily.
async function scriptoriumNotes() {
  const fromDevice = await notesFromDevice().catch(() => []);
  if (fromDevice.length) return fromDevice;
  if (!configured()) throw new Error('Connect GitHub in settings to see your notes here.');
  const branch = settings.branch || 'main';
  const res = await fetch(`https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${encodeURI(settings.notesFolder || 'Notes')}/.scriptorium/db.json?ref=${encodeURIComponent(branch)}`, {
    headers: { Authorization: `Bearer ${settings.token}`, Accept: 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28' }, cache: 'no-store',
  });
  if (res.status === 404) throw new Error('No notes found in this repository yet. Turn on GitHub sync in the notes app.');
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
  const db = await res.json();
  return (db.records && db.records.notes || []).filter((n) => !n.deleted && !n.trashed)
    .map((n) => ({ id: n.id, title: n.title || 'Untitled', updated: n.updated || 0 })).sort((a, b) => b.updated - a.updated);
}
async function notesFromDevice() {
  if (indexedDB.databases) {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === 'scriptorium')) return [];
  }
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('scriptorium');
    // Never create the notes app's database from here.
    req.onupgradeneeded = () => req.transaction.abort();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    if (!db.objectStoreNames.contains('notes')) return [];
    const notes = await new Promise((resolve, reject) => {
      const r = db.transaction('notes', 'readonly').objectStore('notes').getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return notes.filter((n) => !n.deleted && !n.trashed).map((n) => ({ id: n.id, title: n.title || 'Untitled', updated: n.updated || 0 })).sort((a, b) => b.updated - a.updated);
  } finally { db.close(); }
}

/* ---------- albums ---------- */

const DUST_DAYS = 14;
const kindOf = (a) => a.kind || 'album';
const KIND = {
  album: { one: 'album', icon: '🎵', folder: 'Albums', title: 'Albums' },
  project: { one: 'project', icon: '🛠️', folder: 'Projects', title: 'Projects' },
};
const activeOf = (kind) => data.albums.filter((a) => !a.finishedAt && kindOf(a) === kind).sort((a, b) => a.created - b.created);
const activeAlbums = () => activeOf('album');
const activeAll = () => data.albums.filter((a) => !a.finishedAt).sort((a, b) => a.created - b.created);
const albumSessions = (id) => data.sessions.filter((x) => x.albumId === id && !x.removed).sort((a, b) => b.at - a.at);
const albumName = (id) => (find(data.albums, id) || { name: 'Album' }).name;
const albumIcon = (id) => KIND[kindOf(find(data.albums, id) || {})].icon;
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 864e5);
const agoText = (n) => (n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`);

// The last day anything happened on an album: a session, or one of its steps checked off.
function lastWorked(a) {
  let last = null;
  for (const x of albumSessions(a.id)) if (!last || x.day > last) last = x.day;
  for (const t of data.tasks) if (t.albumId === a.id && t.doneDay && (!last || t.doneDay > last)) last = t.doneDay;
  return last;
}
function dustDays(a) {
  const since = lastWorked(a) || a.createdDay || dayKey(new Date(a.created));
  const n = daysBetween(since, dayKey());
  return n >= DUST_DAYS ? n : 0;
}

function addAlbum(name, kind = 'album') {
  const now = Date.now();
  data.albums.push({ id: uid(), name, kind, created: now, createdDay: dayKey(), finishedAt: null, finishedDay: null, updated: now });
  // First album: if there's an obvious song habit, have it ask which album from now on.
  if (kind === 'album' && !data.habits.some((h) => h.asksAlbum)) {
    const songs = activeHabits().filter((h) => /song|music|album|track|beat/i.test(h.text));
    if (songs.length === 1) {
      touch(songs[0], { asksAlbum: true });
      toast(`Checking “${songs[0].text}” will now ask which album`);
    }
  }
  change();
}
function setAlbumFinished(id, finished) {
  const a = find(data.albums, id);
  touch(a, finished ? { finishedAt: Date.now(), finishedDay: dayKey() } : { finishedAt: null, finishedDay: null });
  change();
  // Finished albums and projects leave their tab right away; they live in the Archive.
  if (finished) toast(`Finished “${a.name}” 🎉 — moved to the Archive`, () => setAlbumFinished(id, false));
  else toast(`Reopened “${a.name}”`);
}
function logSession(albumId, day, note, habitId) {
  const now = Date.now();
  data.sessions.push({ id: uid(), albumId, day, at: now, note, habitId: habitId || null, removed: false, updated: now });
  change();
}
function removeSession(id) {
  const x = find(data.sessions, id);
  touch(x, { removed: true });
  change();
  toast('Session removed', () => { touch(x, { removed: false }); change(); });
}

/* ---------- things to buy ---------- */

const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); return monthKey(new Date(y, mo - 1 + n, 1)); };
const monthName = (m) => { const [y, mo] = m.split('-').map(Number); return `${MONTHS[mo - 1]} ${y}`; };
// Seasons are northern-hemisphere; "tax time" is April.
const WHEN_MONTHS = { Spring: 3, Summer: 6, Fall: 9, Winter: 12, 'Tax time': 4 };
function nextMonthNumbered(n) {
  const now = new Date();
  const year = now.getMonth() + 1 <= n ? now.getFullYear() : now.getFullYear() + 1;
  return `${year}-${pad(n)}`;
}
// What the "When" menu offers: a few named times, then the next 12 months.
function whenOptions() {
  const cur = monthKey();
  const opts = [['someday', 'Someday'], ['m:' + cur, 'This month'], ['m:' + addMonths(cur, 1), 'Next month']];
  for (const [label, n] of Object.entries(WHEN_MONTHS)) opts.push([`w:${label}`, `${label} (${monthName(nextMonthNumbered(n)).replace(/ \d{4}$/, '')})`]);
  for (let i = 2; i < 13; i++) opts.push(['m:' + addMonths(cur, i), monthName(addMonths(cur, i))]);
  return opts;
}
function parseWhen(value) {
  if (value.startsWith('w:')) { const label = value.slice(2); return { dueMonth: nextMonthNumbered(WHEN_MONTHS[label]), whenLabel: label }; }
  if (value.startsWith('m:')) return { dueMonth: value.slice(2), whenLabel: null };
  return { dueMonth: null, whenLabel: null };
}
const whenText = (t) => (!t.dueMonth ? 'Someday' : t.whenLabel ? `${t.whenLabel} · ${monthName(t.dueMonth)}` : monthName(t.dueMonth));
const buyItems = () => data.tasks.filter((t) => t.buy && !t.doneAt);
const dueBuys = () => buyItems().filter((t) => t.dueMonth && t.dueMonth <= monthKey()).sort((a, b) => a.dueMonth.localeCompare(b.dueMonth) || byOrder(a, b));
const money = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
function parseCost(text) {
  const n = Number(String(text).replace(/[^0-9.]/g, ''));
  return text && Number.isFinite(n) && n > 0 ? n : null;
}

function addBuy(text, when, cost) {
  const now = Date.now();
  data.tasks.push({ id: uid(), text, buy: true, ...parseWhen(when), cost, order: now, created: now, doneAt: null, doneDay: null, updated: now });
  change();
}
function snoozeBuy(id) {
  const t = find(data.tasks, id);
  touch(t, { dueMonth: addMonths(t.dueMonth && t.dueMonth > monthKey() ? t.dueMonth : monthKey(), 1), whenLabel: null });
  change();
  toast(`“${t.text}” moved to ${monthName(t.dueMonth)}`);
}

/* ---------- limits (things with a maximum per hours / per day) ---------- */

const HOUR = 3600e3;
const activeLimits = () => data.limits.filter((l) => !l.retired).sort(byOrder);
const limitDoses = (id) => data.doses.filter((x) => x.limitId === id && !x.removed).sort((a, b) => a.at - b.at);
const amt = (n) => String(Math.round(n * 100) / 100);
const withUnit = (n, unit) => (unit ? `${amt(n)} ${unit}` : amt(n));
const doseLine = (x) => { const l = find(data.limits, x.limitId) || { name: 'Limit', unit: '' }; return `${l.name} ${withUnit(x.amount, l.unit)}`; };
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function untilText(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60e3));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}`;
}

// How much is used under each rule right now, and the earliest time `amount` more would fit both rules.
function limitStatus(l, amount = l.dose, now = Date.now()) {
  const doses = limitDoses(l.id);
  const out = { windowUsed: 0, dayUsed: 0, okAt: null, never: false, reason: null };
  if (l.windowMax && l.windowHours) {
    const from = now - l.windowHours * HOUR;
    const recent = doses.filter((x) => x.at > from);
    out.windowUsed = recent.reduce((sum, x) => sum + x.amount, 0);
    if (amount > l.windowMax) out.never = true;
    else if (out.windowUsed + amount > l.windowMax) {
      // Wait until enough of the oldest doses in the window have aged out.
      let excess = out.windowUsed + amount - l.windowMax;
      for (const x of recent) {
        excess -= x.amount;
        if (excess <= 1e-9) { out.okAt = x.at + l.windowHours * HOUR; out.reason = 'window'; break; }
      }
    }
  }
  if (l.dayMax) {
    const today = dayKey(new Date(now));
    out.dayUsed = doses.filter((x) => x.day === today).reduce((sum, x) => sum + x.amount, 0);
    if (amount > l.dayMax) out.never = true;
    else if (out.dayUsed + amount > l.dayMax) {
      const midnight = parseDay(addDays(today, 1)).getTime();
      if (!out.okAt || midnight > out.okAt) { out.okAt = midnight; out.reason = 'day'; }
    }
  }
  return out;
}

function logDose(l, amount) {
  const now = new Date();
  const x = { id: uid(), limitId: l.id, amount, at: now.getTime(), day: dayKey(now), time: nowTime(now), removed: false, updated: now.getTime() };
  data.doses.push(x);
  change();
  toast(`Logged ${withUnit(amount, l.unit)} of ${l.name} at ${clock(x.at)}`, () => { touch(x, { removed: true }); change(); });
}
function removeDose(id) {
  const x = find(data.doses, id);
  touch(x, { removed: true });
  change();
  toast('Removed', () => { touch(x, { removed: false }); change(); });
}

/* ---------- symptoms ---------- */

const SEVERITY = { 1: 'Mild', 2: 'Moderate', 3: 'Acute' };
const COMMON_SYMPTOMS = [
  'Headache', 'Migraine', 'Fatigue', 'Dizziness', 'Nausea', 'Vomiting', 'Fever', 'Chills', 'Sweating',
  'Cough', 'Sore throat', 'Runny nose', 'Congestion', 'Sneezing', 'Shortness of breath', 'Wheezing',
  'Chest pain', 'Heart palpitations', 'Stomach ache', 'Heartburn', 'Bloating', 'Diarrhea', 'Constipation',
  'Loss of appetite', 'Back pain', 'Neck pain', 'Joint pain', 'Muscle aches', 'Cramps', 'Swelling',
  'Numbness or tingling', 'Rash', 'Itching', 'Ear pain', 'Blurred vision', 'Dry eyes', 'Insomnia',
  'Brain fog', 'Anxiety', 'Low mood', 'Irritability',
];
let severity = 1;
let showAllChips = false;

const liveSymptoms = () => data.symptoms.filter((s) => !s.removed);
const nowTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const shortDate = (s) => { const d = parseDay(s); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`; };

// Your most-used symptoms come first, then anything else you've ever logged, then the common list.
function symptomNames() {
  const since = addDays(dayKey(), -90);
  const uses = new Map();
  for (const s of liveSymptoms()) uses.set(s.name, (uses.get(s.name) || 0) + (s.day >= since ? 1 : 0));
  const logged = [...uses.keys()].sort((a, b) => uses.get(b) - uses.get(a) || a.localeCompare(b));
  const seen = new Set(logged.map((n) => n.toLowerCase()));
  return [...logged, ...COMMON_SYMPTOMS.filter((n) => !seen.has(n.toLowerCase()))];
}
const canonicalName = (text) => symptomNames().find((n) => n.toLowerCase() === text.toLowerCase()) || text;

function logSymptom(name) {
  const now = new Date();
  const s = {
    id: uid(), name: canonicalName(name), day: dayKey(now), time: nowTime(now), at: now.getTime(),
    severity, note: '', removed: false, updated: now.getTime(),
  };
  data.symptoms.push(s);
  change();
  toast(`Logged ${s.name} · ${SEVERITY[s.severity].toLowerCase()}`, () => { touch(s, { removed: true }); change(); });
}
function removeSymptom(id) {
  const s = find(data.symptoms, id);
  touch(s, { removed: true });
  change();
  toast(`Removed ${s.name} at ${s.time}`, () => { touch(s, { removed: false }); change(); });
}
function cycleSeverity(id) { const s = find(data.symptoms, id); touch(s, { severity: (s.severity % 3) + 1 }); change(); }
function setSymptomNote(id, note) { touch(find(data.symptoms, id), { note }); change(); }

function symptomReport(from, to) {
  const entries = liveSymptoms().filter((s) => s.day >= from && s.day <= to).sort((a, b) => a.at - b.at);
  const byName = new Map();
  for (const s of entries) {
    const x = byName.get(s.name) || { name: s.name, times: 0, days: new Set(), sev: [0, 0, 0, 0], first: s.day, last: s.day };
    x.times++; x.days.add(s.day); x.sev[s.severity]++; x.last = s.day;
    byName.set(s.name, x);
  }
  const summary = [...byName.values()].sort((a, b) => b.times - a.times || a.name.localeCompare(b.name));
  let byDay = new Map();
  for (const s of entries) (byDay.get(s.day) || byDay.set(s.day, []).get(s.day)).push(s);
  byDay = new Map([...byDay].sort((a, b) => b[0].localeCompare(a[0])));
  return { from, to, entries, summary, byDay };
}
const severityBreakdown = (sev) => [1, 2, 3].filter((n) => sev[n]).map((n) => `${sev[n]} ${SEVERITY[n].toLowerCase()}`).join(', ');
const summaryLine = (x) => `${plural(x.times, 'time')} on ${plural(x.days.size, 'day')} · ${severityBreakdown(x.sev)} · `
  + (x.first === x.last ? `on ${shortDate(x.first)}` : `first ${shortDate(x.first)}, last ${shortDate(x.last)}`);
const entryLine = (s) => `${s.time}  ${s.name} (${SEVERITY[s.severity].toLowerCase()})${s.note ? ` – ${s.note}` : ''}`;

function reportText(r) {
  const days = Math.round((parseDay(r.to) - parseDay(r.from)) / 864e5) + 1;
  const lines = ['SYMPTOM LOG', `${shortDate(r.from)} – ${shortDate(r.to)} (${plural(days, 'day')})`, 'Severity scale: mild, moderate, acute', ''];
  if (!r.entries.length) lines.push('No symptoms logged in this period.');
  else {
    lines.push('SUMMARY');
    for (const x of r.summary) lines.push(`${x.name}: ${summaryLine(x)}`);
    lines.push('', 'BY DAY');
    for (const [day, list] of r.byDay) {
      lines.push('', longDate(day));
      for (const s of list) lines.push(`  ${entryLine(s)}`);
    }
  }
  return lines.join('\n') + '\n';
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
    symptoms: mergeById(local.symptoms, remote.symptoms, newer),
    albums: mergeById(local.albums, remote.albums, newer),
    sessions: mergeById(local.sessions, remote.sessions, newer),
    limits: mergeById(local.limits, remote.limits, newer),
    doses: mergeById(local.doses, remote.doses, newer),
    categories: mergeById(local.categories, remote.categories, newer),
  };
}

/* ---------- markdown files written to the repo (readable in Obsidian) ---------- */

function archiveByDay() {
  const days = new Map();
  const get = (d) => days.get(d) || days.set(d, { habits: [], tasks: [], sessions: [], doses: [], finished: [] }).get(d);
  for (const h of [...data.habits].sort(byOrder)) for (const d of doneDays(h)) get(d).habits.push(h);
  for (const t of data.tasks.filter((t) => t.doneAt).sort((a, b) => a.doneAt - b.doneAt)) get(t.doneDay).tasks.push(t);
  for (const x of data.sessions.filter((x) => !x.removed).sort((a, b) => a.at - b.at)) get(x.day).sessions.push(x);
  for (const x of data.doses.filter((x) => !x.removed).sort((a, b) => a.at - b.at)) get(x.day).doses.push(x);
  for (const a of data.albums.filter((a) => a.finishedAt)) get(a.finishedDay).finished.push(a);
  return new Map([...days].sort((a, b) => b[0].localeCompare(a[0])));
}

const taskLabel = (t) => (t.albumId ? `${t.text} (${albumName(t.albumId)})` : t.buy ? `${t.text} (bought${t.cost ? `, ${money(t.cost)}` : ''})` : t.text);
const sessionLine = (x) => `${albumIcon(x.albumId)} ${albumName(x.albumId)}${x.note ? ` – ${x.note}` : ''}`;

function archiveMarkdown(day, { habits, tasks, sessions, doses, finished = [] }) {
  const lines = [`# ${longDate(day)}`, ''];
  if (habits.length) {
    lines.push('## Daily', '');
    for (const h of habits) lines.push(`- [x] ${h.text} (${isDaily(h) ? '' : `${EVERY[everyOf(h)].tag.toLowerCase()} `}#${doneDays(h).indexOf(day) + 1})`);
    lines.push('');
  }
  if (tasks.length) {
    lines.push('## Tasks', '');
    for (const t of tasks) lines.push(`- [x] ${taskLabel(t)}`);
    lines.push('');
  }
  if (sessions.length) {
    lines.push('## Albums & projects', '');
    for (const x of sessions) lines.push(`- ${sessionLine(x)}`);
    lines.push('');
  }
  if (finished.length) {
    lines.push('## Finished', '');
    for (const a of finished) lines.push(`- 🏁 ${a.name} (${KIND[kindOf(a)].one})`);
    lines.push('');
  }
  if (doses.length) {
    lines.push('## Limits', '');
    for (const x of doses) lines.push(`- ${x.time} ${doseLine(x)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function todoMarkdown() {
  const today = dayKey();
  const lines = ['# To do', '', '> Written by the Daily app. Edit your list in the app — changes made here are overwritten.', ''];
  lines.push(`## Daily · ${longDate(today)}`, '');
  for (const h of activeHabits()) {
    lines.push(`- [${doneOn(h, today) ? 'x' : ' '}] ${h.text} — ${plural(doneDays(h).length, 'time')}, ${streak(h)}-day streak (best ${bestStreak(h)})`);
  }
  lines.push('', '## Tasks', '');
  lines.push(...taskTreeMd(topTasks()));
  const buys = buyItems().sort((a, b) => (a.dueMonth || '9999').localeCompare(b.dueMonth || '9999') || byOrder(a, b));
  if (buys.length) {
    lines.push('', '## To buy', '');
    for (const t of buys) lines.push(`- [ ] ${t.text} — ${whenText(t)}${t.cost ? `, ${money(t.cost)}` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

// Open tasks as an Obsidian checklist: subtasks indented, category as a #tag, linked note as [[Title]].
function taskTreeMd(list, depth = 0) {
  const lines = [];
  for (const t of list) {
    const cat = catOf(t);
    const tag = cat ? ` #${cat.name.replace(/\s+/g, '-')}` : '';
    const note = t.note ? ` — [[${t.note.title.replace(/[[\]|#^]/g, '')}]]` : '';
    lines.push(`${'    '.repeat(depth)}- [ ] ${t.text}${note}${tag}`);
    lines.push(...taskTreeMd(childTasks(t.id), depth + 1));
  }
  return lines;
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
  const { byDay } = symptomReport('0000-00-00', '9999-99-99');
  for (const [day, list] of byDay) {
    files[repoPath(`Symptoms/${day}.md`)] = [`# Symptoms · ${longDate(day)}`, '', ...list.map((s) => `- ${entryLine(s)}`), ''].join('\n');
  }
  for (const a of data.albums) files[repoPath(`${KIND[kindOf(a)].folder}/${fileSafe(a.name)}.md`)] = albumMarkdown(a);
  return files;
}

const fileSafe = (name) => name.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim() || 'Album';

function albumMarkdown(a) {
  const sessions = albumSessions(a.id);
  const lines = [`# ${a.name}`, ''];
  lines.push(a.finishedDay ? `Finished ${longDate(a.finishedDay)}.` : `Started ${longDate(a.createdDay || dayKey(new Date(a.created)))}.`, '');
  lines.push('## Steps', '');
  lines.push(...taskTreeMd(topTasks(a.id)));
  for (const t of data.tasks.filter((t) => t.albumId === a.id && t.doneAt).sort((x, y) => y.doneAt - x.doneAt)) lines.push(`- [x] ${t.text} (${t.doneDay})`);
  lines.push('', `## Sessions (${sessions.length})`, '');
  for (const x of sessions) lines.push(`- ${x.day}${x.note ? ` – ${x.note}` : ''}`);
  lines.push('');
  return lines.join('\n');
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
  // Nothing new on GitHub and nothing new here: done.
  if (ref.object.sha === lastHeadSha && !dirty) return;
  const editsAtStart = edits;
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
  const datedDirs = [repoPath('Archive/'), repoPath('Symptoms/')];
  for (const path of remote.keys()) {
    const generated = (datedDirs.some((dir) => path.startsWith(dir)) && /\/\d{4}-\d\d-\d\d\.md$/.test(path))
      || ((path.startsWith(repoPath('Albums/')) || path.startsWith(repoPath('Projects/'))) && path.endsWith('.md')); // e.g. a renamed album
    if (generated && !(path in files)) {
      changes.push({ path, mode: '100644', type: 'blob', sha: null });
    }
  }

  let newHead = ref.object.sha;
  if (changes.length) {
    const newTree = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree: changes }) });
    const commit = await gh('/git/commits', {
      method: 'POST',
      body: JSON.stringify({ message: `Daily: update ${dayKey()}`, tree: newTree.sha, parents: [ref.object.sha] }),
    });
    await gh(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
    newHead = commit.sha;
  }
  lastSyncedSha = await gitBlobSha(files[dataPath]);
  store.set('lastSyncedSha', lastSyncedSha);
  lastHeadSha = newHead;
  store.set('lastHeadSha', lastHeadSha);
  // Edits made while this sync was running stay dirty for the next round.
  if (edits === editsAtStart) { dirty = false; store.set('dirty', false); }
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

function editableText(text, onRename, { allowEmpty = false, placeholder = null, links = false } = {}) {
  const span = el('span', { class: 'text', contenteditable: 'true', spellcheck: 'false', enterkeyhint: 'done', 'data-placeholder': placeholder }, text);
  // Text with web links: show short, tappable links; tapping anywhere else edits the full text.
  const showLinks = () => {
    span.setAttribute('contenteditable', 'false');
    span.classList.add('has-links');
    fill(span, linkedText(text));
  };
  const hasLinks = links && !!text.match(URL_RE);
  if (hasLinks) {
    showLinks();
    span.tabIndex = 0;
    span.addEventListener('click', (e) => {
      if (e.target.closest('a') || span.isContentEditable) return;
      span.classList.remove('has-links');
      span.textContent = text;
      span.setAttribute('contenteditable', 'true');
      span.focus();
      const r = document.createRange();
      r.selectNodeContents(span);
      r.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
  }
  span.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
    if (e.key === 'Escape') { span.textContent = text; span.blur(); }
  });
  span.addEventListener('blur', () => {
    if (hasLinks && !span.isContentEditable) return;
    const value = clean(span.textContent);
    if (!value && !allowEmpty) span.textContent = text;
    else if (value !== text) { onRename(value); return; }
    if (hasLinks) showLinks();
  });
  return span;
}

function render() {
  if (dragging) { renderPending = true; return; }
  if (document.activeElement && document.activeElement.matches('.text, .cost, .limit-amount')) {
    // Don't yank a line out from under someone who is typing; re-render when they finish.
    renderPending = true;
    return;
  }
  renderPending = false;
  renderedDay = dayKey();
  $('#date').textContent = longDate(renderedDay);
  renderToday();
  renderDust();
  renderBuys();
  renderAlbums('album');
  renderAlbums('project');
  renderFinished();
  renderSymptomsToday();
  renderLimits();
  renderArchive();
  renderSymptomLog();
}

function renderToday() {
  const today = dayKey();
  const rank = { day: 0, week: 1, month: 2 };
  // Daily first, then weekly, then monthly; dragging keeps the order within each.
  const habits = activeHabits().sort((x, y) => rank[everyOf(x)] - rank[everyOf(y)] || byOrder(x, y));
  const dailies = habits.filter(isDaily);
  const done = dailies.filter((h) => doneOn(h, today)).length;
  $('#daily-progress').textContent = dailies.length ? `${done}/${dailies.length}` : '';
  $('#daily-progress').classList.toggle('all', dailies.length > 0 && done === dailies.length);
  $('#edit-habits').textContent = editingHabits ? 'Done' : 'Edit';
  $('#edit-habits').hidden = !habits.length;

  const others = habits.filter((h) => !isDaily(h));
  const line = ['week', 'month'].map((e) => {
    const hs = others.filter((h) => everyOf(h) === e);
    return hs.length ? `This ${e} ${hs.filter((h) => doneIn(h, today)).length}/${hs.length}` : null;
  }).filter(Boolean).join(' · ');
  $('#period-progress').textContent = line;
  $('#period-progress').hidden = !line;

  fill($('#habits'), ...(habits.length ? habits.map((h) => {
    const e = everyOf(h);
    const need = timesOf(h);
    const complete = doneIn(h, today);
    const cnt = e === 'day' ? 0 : periodCount(h, today);
    // "Part": ticked today, but a several-times habit still needs more checks this period.
    const part = !complete && e !== 'day' && doneOn(h, today);
    const due = !complete && e !== 'day' && daysLeft(e) <= (e === 'week' ? 1 : 2);
    const n = doneDays(h).length;
    const s = streak(h);
    const unit = EVERY[e].one;
    return el('li', { class: `item habit${complete ? ' done' : ''}${part ? ' part' : ''}${due ? ' due' : ''}${editingHabits ? ' editing' : ''}`, 'data-id': h.id },
      el('span', { class: 'grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⋮⋮'),
      el('button', { class: 'check', type: 'button', role: 'checkbox', 'aria-checked': String(complete || part), 'aria-label': h.text, onclick: () => toggleHabit(h.id) }),
      editableText(h.text, (v) => rename(data.habits, h.id, v)),
      e !== 'day' ? el('span', { class: 'cad', title: need > 1 ? `${cnt} of ${need} this ${unit}` : `Once a ${unit}` }, need > 1 ? `${EVERY[e].tag} ${cnt}/${need}` : EVERY[e].tag) : null,
      editingHabits
        ? el('div', { class: 'habit-tools' },
          el('button', {
            class: 'small-btn', type: 'button', title: 'Tap to change how often',
            onclick: () => { touch(h, { every: e === 'day' ? 'week' : e === 'week' ? 'month' : 'day' }); change(); },
          }, `↻ ${EVERY[e].tag}`),
          e !== 'day' ? el('button', {
            class: 'small-btn', type: 'button', title: `How many times each ${unit}`,
            onclick: () => { touch(h, { times: need >= 7 ? 1 : need + 1 }); change(); },
          }, `${need}× a ${unit}`) : null,
          el('button', {
            class: `small-btn${h.asksAlbum ? ' on' : ''}`, type: 'button', 'aria-pressed': String(!!h.asksAlbum),
            title: 'Ask which album when this is checked', onclick: () => { touch(h, { asksAlbum: !h.asksAlbum }); change(); },
          }, '🎵'),
          el('button', { class: 'small-btn', type: 'button', onclick: () => setRetired(h.id, true) }, 'Retire'))
        : el('span', { class: 'meta', title: `${plural(n, 'time')} in total, ${s}-${unit} streak` }, el('b', {}, `${n}×`), s > 1 ? ` · 🔥${s}` : ''));
  }) : [el('li', { class: 'empty' }, 'No habits yet.')]));

  const all = openTasks();
  $('#task-count').textContent = all.length ? String(all.length) : '';
  if (todoFilter && !activeCats().some((c) => c.id === todoFilter)) todoFilter = null;
  renderCatChips(all);
  const tasks = topTasks().filter((t) => !todoFilter || t.cat === todoFilter);
  const filterName = todoFilter ? find(data.categories, todoFilter).name : null;
  $('#add-task').text.placeholder = filterName ? `Add a ${filterName} task` : 'Add a task';
  fill($('#tasks'), ...(tasks.length ? tasks.map((t) => taskRow(t)) : [el('li', { class: 'empty' }, filterName ? `Nothing in ${filterName}.` : 'Nothing to do. Nice.')]));
}

// One task line, with its subtasks nested underneath.
function taskRow(t) {
  const cat = catOf(t);
  const kids = childTasks(t.id);
  // Subtasks can be tucked away until you're ready for them (remembered per task).
  const hidden = kids.length > 0 && !!t.collapsed;
  const sub = kids.length && !hidden ? el('ul', { class: 'list sub' }, kids.map((k) => taskRow(k))) : null;
  if (sub) enableDrag(sub, (ids) => reorder(data.tasks, ids));
  return el('li', { class: `item task${cat ? ' has-cat' : ''}`, 'data-id': t.id, style: cat ? `--cat:${cat.color}` : null },
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
    el('div', { class: 'task-main' },
      editableText(t.text, (v) => rename(data.tasks, t.id, v), { links: true }),
      kids.length ? el('button', {
        class: 'sub-toggle', type: 'button', 'aria-expanded': String(!hidden),
        title: hidden ? 'Show subtasks' : 'Hide subtasks',
        onclick: () => { touch(t, { collapsed: !hidden }); change(); },
      }, el('span', { class: 'caret', 'aria-hidden': 'true' }, hidden ? '▸' : '▾'), ` ${plural(kids.length, 'subtask')}`) : null,
      t.note ? el('a', { class: 'note-chip', href: noteUrl(t.note.id), target: '_blank', rel: 'noopener', title: 'Open in your notes' }, `📝 ${t.note.title}`) : null),
    el('button', { class: 'more-btn', type: 'button', 'aria-label': `Options for ${t.text}`, onclick: () => openTaskDialog(t.id) }, '⋯'),
    sub);
}

function renderCatChips(all) {
  const count = (id) => all.filter((t) => t.cat === id).length;
  fill($('#todo-cats'),
    el('button', { class: 'chip cat-chip', type: 'button', 'aria-pressed': String(!todoFilter), onclick: () => setTodoFilter(null) }, 'All'),
    activeCats().map((c) => el('button', {
      class: 'chip cat-chip', type: 'button', style: `--cat:${c.color}`, 'aria-pressed': String(todoFilter === c.id),
      onclick: () => setTodoFilter(todoFilter === c.id ? null : c.id),
    }, el('span', { class: 'cat-dot' }), c.name, count(c.id) ? el('span', { class: 'cat-n' }, String(count(c.id))) : null)),
    el('button', { class: 'chip more-chip', type: 'button', title: 'Add or edit categories', onclick: openCatDialog }, '✎'));
}
function setTodoFilter(id) {
  todoFilter = id;
  store.set('todoFilter', id);
  renderToday();
}

function dayLabel(day) {
  const today = dayKey();
  if (day === today) return 'Today';
  if (day === addDays(today, -1)) return 'Yesterday';
  return null;
}

let backfillDay = null; // null = yesterday

function renderBackfill() {
  const today = dayKey();
  const day = backfillDay || addDays(today, -1);
  $('#backfill-day').value = day;
  $('#backfill-day').max = today;
  const habits = activeHabits().filter(isDaily);
  fill($('#backfill'), habits.length
    ? habits.map((h) => {
      const checked = doneOn(h, day);
      return el('li', { class: `item habit${checked ? ' done' : ''}` },
        el('button', {
          class: 'check', type: 'button', role: 'checkbox', 'aria-checked': String(checked),
          'aria-label': `${h.text} on ${longDate(day)}`, onclick: () => toggleHabit(h.id, day),
        }),
        el('span', { class: 'text' }, h.text));
    })
    : el('li', { class: 'empty' }, 'No daily habits yet.'));
}

function renderArchive() {
  renderBackfill();
  const allHabits = [...data.habits].sort((a, b) => (a.retired - b.retired) || byOrder(a, b));
  const doneTasks = data.tasks.filter((t) => t.doneAt).length;
  fill($('#stats'), 
    el('div', { class: 'stat' }, el('span', { class: 'name' }, 'Tasks completed'), el('span', { class: 'num' }, String(doneTasks))),
    ...allHabits.map((h) => el('div', { class: 'stat' },
      el('span', { class: 'name' }, h.text, h.retired ? el('span', { class: 'extra' }, ' (retired)') : null),
      el('span', { class: 'extra' }, streakText(h)),
      el('span', { class: 'num' }, `${doneDays(h).length}×`))),
  );

  const days = [...archiveByDay()];
  const shown = days.slice(0, archiveDays);
  fill($('#archive'), 
    ...(days.length ? [] : [el('section', { class: 'card' }, el('p', { class: 'empty' }, 'Things you finish will show up here, grouped by day.'))]),
    ...shown.map(([day, { habits, tasks, sessions, doses, finished }]) => el('section', { class: 'card day' },
      el('h3', {}, longDate(day), dayLabel(day) ? el('small', {}, dayLabel(day)) : null),
      el('ul', { class: 'list plain' },
        ...habits.map((h) => el('li', { class: 'item' },
          el('span', { class: 'done-mark' }, '✓'), el('span', { class: 'text' }, h.text), el('span', { class: 'tag' }, `${EVERY[everyOf(h)].tag.toLowerCase()} #${doneDays(h).indexOf(day) + 1}`))),
        ...tasks.map((t) => el('li', { class: 'item' },
          el('span', { class: 'done-mark' }, '✓'), el('span', { class: 'text' }, t.text),
          t.albumId ? el('span', { class: 'tag' }, albumName(t.albumId)) : catOf(t) ? el('span', { class: 'tag cat-tag', style: `--cat:${catOf(t).color}` }, catOf(t).name) : t.buy ? el('span', { class: 'tag' }, t.cost ? `bought · ${money(t.cost)}` : 'bought') : null,
          el('button', { class: 'small-btn', type: 'button', onclick: () => restoreTask(t.id) }, 'Restore'))),
        ...finished.map((a) => el('li', { class: 'item' },
          el('span', { class: 'done-mark' }, '🏁'), el('span', { class: 'text' }, `Finished ${a.name}`), el('span', { class: 'tag' }, KIND[kindOf(a)].one))),
        ...sessions.map((x) => el('li', { class: 'item' },
          el('span', { class: 'done-mark' }, albumIcon(x.albumId)),
          el('span', { class: 'text' }, albumName(x.albumId), x.note ? el('span', { class: 'note' }, ` – ${x.note}`) : null))),
        ...doses.map((x) => el('li', { class: 'item' },
          el('span', { class: 'done-mark' }, '•'),
          el('span', { class: 'text' }, doseLine(x)),
          el('span', { class: 'tag' }, x.time)))))),
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

function renderSymptomChips() {
  const query = clean($('#add-symptom').text.value).toLowerCase();
  const names = symptomNames();
  let shown;
  if (query) {
    shown = names.filter((n) => n.toLowerCase().includes(query));
  } else {
    shown = showAllChips ? names : names.slice(0, 12);
  }
  fill($('#symptom-chips'),
    query && !names.some((n) => n.toLowerCase() === query)
      ? el('button', { class: 'chip add-chip', type: 'button', onclick: () => pickSymptom(clean($('#add-symptom').text.value)) }, `+ ${clean($('#add-symptom').text.value)}`)
      : null,
    shown.map((n) => el('button', { class: 'chip', type: 'button', onclick: () => pickSymptom(n) }, n)),
    !query && names.length > 12
      ? el('button', { class: 'chip more-chip', type: 'button', onclick: () => { showAllChips = !showAllChips; renderSymptomChips(); } }, showAllChips ? 'Fewer' : `More (${names.length - 12})`)
      : null);
}
function pickSymptom(name) {
  if (!name) return;
  $('#add-symptom').text.value = '';
  logSymptom(name);
}

function renderSymptomsToday() {
  for (const b of document.querySelectorAll('#severity button')) b.setAttribute('aria-pressed', String(Number(b.dataset.sev) === severity));
  renderSymptomChips();
  const today = liveSymptoms().filter((s) => s.day === dayKey()).reverse().sort((a, b) => b.at - a.at);
  $('#symptom-count').textContent = today.length ? String(today.length) : '';
  fill($('#symptoms-today'), today.map((s) => el('li', { class: 'item symptom' },
    el('span', { class: 'time' }, s.time),
    el('div', { class: 'sym-main' },
      el('span', { class: 'sym-name' }, s.name),
      editableText(s.note, (v) => setSymptomNote(s.id, v), { allowEmpty: true, placeholder: 'Add a note' })),
    el('button', { class: `sev sev${s.severity}`, type: 'button', title: 'Tap to change severity', onclick: () => cycleSeverity(s.id) }, SEVERITY[s.severity]),
    el('button', { class: 'x', type: 'button', 'aria-label': `Remove ${s.name} at ${s.time}`, onclick: () => removeSymptom(s.id) }, '×'))));
}

let symptomFrom = null; // null = last 30 days
const rangeFrom = () => symptomFrom || addDays(dayKey(), -29);
const currentReport = () => symptomReport(rangeFrom(), dayKey());

function renderSymptomLog() {
  const r = currentReport();
  $('#range-from').value = r.from;
  $('#range-from').max = r.to;
  for (const b of document.querySelectorAll('#range button')) {
    b.setAttribute('aria-pressed', String(b.dataset.days === 'all'
      ? r.from === earliestSymptomDay()
      : addDays(dayKey(), 1 - Number(b.dataset.days)) === r.from));
  }
  fill($('#sym-summary'), r.summary.length
    ? r.summary.map((x) => el('div', { class: 'stat sym-stat' },
      el('div', { class: 'name' }, el('b', {}, x.name), el('div', { class: 'extra' }, summaryLine(x).split(' · ').slice(1).join(' · '))),
      el('span', { class: 'num' }, `${x.times}×`, el('div', { class: 'extra' }, plural(x.days.size, 'day')))))
    : el('p', { class: 'empty' }, 'No symptoms logged in this period.'));
  fill($('#sym-days'), [...r.byDay].map(([day, list]) => el('section', { class: 'card day' },
    el('h3', {}, longDate(day), dayLabel(day) ? el('small', {}, dayLabel(day)) : null),
    el('ul', { class: 'list plain' }, list.map((s) => el('li', { class: 'item symptom' },
      el('span', { class: 'time' }, s.time),
      el('div', { class: 'sym-main' }, el('span', { class: 'sym-name' }, s.name), s.note ? el('span', { class: 'note' }, s.note) : null),
      el('span', { class: `sev sev${s.severity}` }, SEVERITY[s.severity])))))));
}
function earliestSymptomDay() {
  return liveSymptoms().reduce((m, s) => (s.day < m ? s.day : m), dayKey());
}

function openDoctorView() {
  const r = currentReport();
  fill($('#doctor-body'),
    el('p', { class: 'doc-range' }, `${shortDate(r.from)} – ${shortDate(r.to)}`),
    r.summary.length ? null : el('p', {}, 'No symptoms logged in this period.'),
    r.summary.map((x) => el('div', { class: 'doc-sym' }, el('h3', {}, x.name), el('p', {}, summaryLine(x)))),
    r.byDay.size ? el('h2', {}, 'By day') : null,
    [...r.byDay].map(([day, list]) => el('div', { class: 'doc-day' }, el('h3', {}, longDate(day)),
      list.map((s) => el('p', {}, entryLine(s))))));
  $('#doctor').showModal();
}

// Inside the Android app, text goes straight to Android's share sheet.
const androidApp = window.AndroidApp || null;

async function shareReport() {
  const r = currentReport();
  const text = reportText(r);
  if (androidApp) { androidApp.shareText('Symptom log', text); return; }
  const name = `symptoms-${r.from}-to-${r.to}.txt`;
  const file = new File([text], name, { type: 'text/plain' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Symptom log' }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  el('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let armed = null; // limit id whose Log button is waiting for a second tap to go over the limit

function renderLimits() {
  const now = Date.now();
  const today = dayKey();
  const limits = activeLimits();
  fill($('#limits'), limits.length ? limits.map((l) => {
    const st = limitStatus(l, l.dose, now);
    const all = limitDoses(l.id);
    const todays = all.filter((x) => x.day === today).reverse();
    const last = all[all.length - 1];
    let state;
    if (st.never) state = el('span', { class: 'lim-state warn' }, 'Usual amount is over your limit');
    else if (!st.okAt) state = el('span', { class: 'lim-state ok' }, 'OK');
    else if (st.reason === 'day') state = el('span', { class: 'lim-state stop' }, 'Done for today');
    else state = el('span', { class: 'lim-state wait' }, `Wait until ${clock(st.okAt)} · ${untilText(st.okAt - now)}`);

    const bar = (label, used, max) => el('div', { class: 'lim-rule' },
      el('span', { class: 'lim-label' }, label),
      el('span', { class: 'lim-bar' }, el('span', { class: `lim-fill${used >= max ? ' full' : ''}`, style: `width:${Math.min(100, (used / max) * 100)}%` })),
      el('span', { class: 'lim-num' }, `${amt(used)} / ${withUnit(max, l.unit)}`));

    const input = el('input', { class: 'limit-amount', type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: amt(l.dose), 'aria-label': `Amount of ${l.name}` });
    const over = armed === l.id;
    const btn = el('button', {
      class: `lim-log${over ? ' over' : ''}`, type: 'button',
      onclick: () => {
        const amount = Number(input.value);
        if (!(amount > 0)) { input.focus(); return; }
        const s2 = limitStatus(l, amount);
        if ((s2.okAt || s2.never) && armed !== l.id) {
          // Over the limit: log only on a second, deliberate tap.
          armed = l.id;
          renderLimits();
          setTimeout(() => { if (armed === l.id) { armed = null; renderLimits(); } }, 4000);
          return;
        }
        armed = null;
        logDose(l, amount);
      },
    }, over ? 'Over limit — tap again to log' : 'Log');

    return el('div', { class: 'limit' },
      el('div', { class: 'lim-head' },
        el('b', { class: 'lim-name' }, l.name), state,
        el('button', { class: 'link lim-edit', type: 'button', onclick: () => openLimitDialog(l.id) }, 'Edit')),
      l.windowMax && l.windowHours ? bar(`Past ${plural(l.windowHours, 'hour')}`, st.windowUsed, l.windowMax) : null,
      l.dayMax ? bar('Today', st.dayUsed, l.dayMax) : null,
      el('div', { class: 'lim-logrow' }, input, l.unit ? el('span', { class: 'lim-unit' }, l.unit) : null, btn),
      todays.length
        ? el('div', { class: 'lim-doses' }, todays.map((x) => el('span', { class: 'lim-dose' }, `${clock(x.at)} · ${withUnit(x.amount, l.unit)}`,
          el('button', { class: 'x', type: 'button', 'aria-label': `Remove ${withUnit(x.amount, l.unit)} at ${clock(x.at)}`, onclick: () => removeDose(x.id) }, '×'))))
        : el('p', { class: 'hint lim-last' }, last ? `Last: ${dayLabel(last.day) ? dayLabel(last.day).toLowerCase() : shortDate(last.day)} at ${clock(last.at)}` : 'Nothing logged yet.'));
  }) : el('p', { class: 'empty' }, 'Track things with a limit — like a pill you can take every few hours, or drinks per hour and per day. Tap + Add.'));
}

let editingLimit = null;
function openLimitDialog(id = null) {
  editingLimit = id;
  const l = id ? find(data.limits, id) : null;
  const f = $('#limit-form');
  f.name.value = l ? l.name : '';
  f.unit.value = l ? l.unit : '';
  f.dose.value = l ? amt(l.dose) : '1';
  f.windowMax.value = l && l.windowMax ? amt(l.windowMax) : '';
  f.windowHours.value = l && l.windowHours ? amt(l.windowHours) : '';
  f.dayMax.value = l && l.dayMax ? amt(l.dayMax) : '';
  $('#limit-title').textContent = l ? `Edit ${l.name}` : 'Add a limit';
  $('#limit-remove').hidden = !l;
  $('#limit-templates').hidden = !!l;
  $('#limit-error').hidden = true;
  $('#limit-dialog').showModal();
}
function saveLimitForm() {
  const f = $('#limit-form');
  const num = (v) => { const n = Number(v); return v !== '' && n > 0 ? n : null; };
  const fields = {
    name: clean(f.name.value), unit: clean(f.unit.value), dose: num(f.dose.value) || 1,
    windowMax: num(f.windowMax.value), windowHours: num(f.windowHours.value), dayMax: num(f.dayMax.value),
  };
  const err = !fields.name ? 'Give it a name.'
    : (!!fields.windowMax !== !!fields.windowHours) ? 'For the time-window rule, fill in both the amount and the hours.'
      : (!fields.windowMax && !fields.dayMax) ? 'Set at least one rule.' : null;
  if (err) { $('#limit-error').textContent = err; $('#limit-error').hidden = false; return; }
  if (editingLimit) touch(find(data.limits, editingLimit), fields);
  else data.limits.push({ id: uid(), ...fields, order: nextOrder(activeLimits()), retired: false, updated: Date.now() });
  $('#limit-dialog').close();
  change();
}

function renderBuys() {
  const cur = monthKey();
  const due = dueBuys();
  // Today only gets one line, and only once something's month has come.
  $('#due-buys').hidden = !due.length;
  fill($('#due-buys'), due.length ? el('button', { class: 'dust due', type: 'button', onclick: () => showView('buy') },
    `🛒 Time to buy: ${due.map((t) => t.text).join(', ')}`) : null);
  $('#buy-badge').textContent = due.length ? String(due.length) : '';
  $('#buy-when').replaceChildren(...whenOptions().map(([v, label]) => el('option', { value: v }, label)));
  $('#buy-when').value = lastWhen;
  if ($('#buy-when').value !== lastWhen) $('#buy-when').value = 'someday';

  const groups = new Map();
  const sorted = buyItems().sort((a, b) => (a.dueMonth || '9999').localeCompare(b.dueMonth || '9999') || byOrder(a, b));
  for (const t of sorted) {
    const key = !t.dueMonth ? 'someday' : t.dueMonth <= cur ? 'now' : t.dueMonth;
    (groups.get(key) || groups.set(key, []).get(key)).push(t);
  }
  const title = (key) => (key === 'now' ? 'Now' : key === 'someday' ? 'Someday' : key === addMonths(cur, 1) ? `Next month · ${monthName(key)}` : monthName(key));
  fill($('#buy-groups'), groups.size ? [...groups].map(([key, items]) => {
    const total = items.reduce((sum, t) => sum + (t.cost || 0), 0);
    return el('section', { class: `card${key === 'now' ? ' due-card' : ''}` },
      el('div', { class: 'card-head' }, el('h2', {}, title(key)), total ? el('span', { class: 'pill' }, `≈ ${money(total)}`) : null),
      el('ul', { class: 'list' }, items.map((t) => el('li', { class: 'item buy' },
        el('button', {
          class: 'check', type: 'button', role: 'checkbox', 'aria-checked': 'false', 'aria-label': `Bought ${t.text}`,
          onclick: (e) => {
            const li = e.currentTarget.closest('li');
            li.classList.add('done', 'leaving');
            setTimeout(() => completeTask(t.id), 450);
          },
        }),
        el('div', { class: 'buy-main' },
          editableText(t.text, (v) => rename(data.tasks, t.id, v)),
          el('span', { class: 'buy-meta' },
            whenSelect(t),
            el('span', {
              class: 'cost', contenteditable: 'true', inputmode: 'decimal', 'data-placeholder': '+ cost',
              onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
              onblur: (e) => { const c = parseCost(e.target.textContent); if (c !== (t.cost || null)) { touch(t, { cost: c }); change(); } else e.target.textContent = t.cost ? money(t.cost) : ''; },
            }, t.cost ? money(t.cost) : ''))),
        key === 'now' ? el('button', { class: 'small-btn', type: 'button', title: 'Push to next month', onclick: () => snoozeBuy(t.id) }, 'Later') : null))));
  }) : el('section', { class: 'card' }, el('p', { class: 'empty' }, 'Nothing planned. Add things you’ll need to buy later — they’ll show up on Today when their month comes.')));
}
function whenSelect(t) {
  const sel = el('select', { class: 'when-select', 'aria-label': `When to buy ${t.text}` },
    el('option', { value: '' }, whenText(t)),
    whenOptions().map(([v, label]) => el('option', { value: v }, label)));
  sel.addEventListener('change', () => { if (sel.value) { touch(t, parseWhen(sel.value)); change(); } });
  return sel;
}
let lastWhen = 'someday';

function renderDust() {
  const dusty = activeAll().map((a) => [a, dustDays(a)]).filter(([, n]) => n);
  $('#dust').hidden = !dusty.length;
  fill($('#dust'), dusty.map(([a, n]) => el('button', { class: 'dust', type: 'button', onclick: () => showView(kindOf(a) === 'album' ? 'albums' : 'projects') },
    `💤 ${a.name} — untouched for ${n} days`)));
}

const stepRow = (t) => taskRow(t);

const openSessionLists = new Set();
let refocusAlbum = null;

function renderAlbums(kind = 'album') {
  let focusAfter = null;
  const albums = activeOf(kind);
  fill($(kind === 'album' ? '#albums' : '#projects'), albums.length ? albums.map((a) => {
    const steps = topTasks(a.id);
    const sessions = albumSessions(a.id);
    const last = lastWorked(a);
    const dust = dustDays(a);
    const showAll = openSessionLists.has(a.id);
    const list = el('ul', { class: 'list' }, steps.map(stepRow));
    enableDrag(list, (ids) => reorder(data.tasks, ids));
    const form = el('form', { class: 'add add-top' },
      el('input', { name: 'text', placeholder: 'Add a step', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': `New step for ${a.name}` }),
      el('button', { type: 'submit', 'aria-label': 'Add step' }, '+'));
    bindAdd(form, (text) => { refocusAlbum = a.id; addTask(text, a.id); });
    if (refocusAlbum === a.id) { refocusAlbum = null; focusAfter = form.text; }
    return el('section', { class: `card album${dust ? ' dusty' : ''}` },
      el('div', { class: 'card-head' },
        el('h2', { class: 'album-name' }, editableText(a.name, (v) => { touch(a, { name: v }); change(); })),
        el('button', { class: 'link', type: 'button', onclick: () => setAlbumFinished(a.id, true) }, 'Finished')),
      el('p', { class: 'hint album-meta' },
        dust ? el('b', { class: 'dust-text' }, `💤 Untouched for ${dust} days`) : last ? `Last worked on ${agoText(daysBetween(last, dayKey()))}` : 'Not started yet',
        ` · ${plural(sessions.length, 'session')}`),
      form,
      list,
      el('div', { class: 'sessions-head' },
        el('h3', {}, 'Sessions'),
        el('button', { class: 'small-btn', type: 'button', onclick: () => openSessionDialog({ albumId: a.id, day: dayKey() }) }, '+ Log a session')),
      sessions.length
        ? el('ul', { class: 'list plain sessions' }, (showAll ? sessions : sessions.slice(0, 3)).map((x) => el('li', { class: 'item' },
          el('span', { class: 'time' }, shortDate(x.day).replace(/ \d{4}$/, '')),
          el('span', { class: 'text' }, x.note || el('span', { class: 'muted' }, 'Worked on it')),
          el('button', { class: 'x', type: 'button', 'aria-label': 'Remove session', onclick: () => removeSession(x.id) }, '×'))))
        : el('p', { class: 'empty' }, 'No sessions yet.'),
      sessions.length > 3
        ? el('button', { class: 'link more-link', type: 'button', onclick: () => { showAll ? openSessionLists.delete(a.id) : openSessionLists.add(a.id); renderAlbums(); } },
          showAll ? 'Show fewer' : `Show all ${sessions.length} sessions`)
        : null);
  }) : el('section', { class: 'card' }, el('p', { class: 'empty' }, `Add ${kind === 'album' ? 'an album' : 'a project'} you’re working on to give it its own step list and session log.`)));

  // Focus right away (not in a timeout) so the phone keyboard stays open for the next step.
  if (focusAfter) focusAfter.focus();
}

// Finished albums and projects live in the Archive, where they can be reopened.
function renderFinished() {
  const finished = data.albums.filter((a) => a.finishedAt).sort((a, b) => b.finishedAt - a.finishedAt);
  $('#finished-card').hidden = !finished.length;
  fill($('#finished'), finished.map((a) => el('li', { class: 'item' },
    el('span', { class: 'done-mark' }, KIND[kindOf(a)].icon),
    el('span', { class: 'text' }, a.name, el('span', { class: 'note' }, ` · finished ${shortDate(a.finishedDay)} · ${plural(albumSessions(a.id).length, 'session')}`)),
    el('button', { class: 'small-btn', type: 'button', onclick: () => setAlbumFinished(a.id, false) }, 'Reopen'))));
}

let sessionContext = null;
let sessionAlbum = null;

function openSessionDialog({ habitId = null, albumId = null, day }) {
  sessionContext = { habitId, day, fixed: !!albumId };
  sessionAlbum = albumId;
  const h = habitId && find(data.habits, habitId);
  $('#session-title').textContent = albumId ? `Log a session · ${albumName(albumId)}` : 'Which album?';
  $('#session-sub').textContent = `${h ? `${h.text} · ` : ''}${dayLabel(day) || longDate(day)}`;
  $('#session-form').note.value = '';
  renderSessionChoices();
  $('#session').showModal();
}
function renderSessionChoices() {
  $('#session-albums').hidden = sessionContext.fixed;
  fill($('#session-albums'), activeAlbums().map((a) => el('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(a.id === sessionAlbum),
    onclick: () => { sessionAlbum = a.id; renderSessionChoices(); },
  }, a.name)));
  $('#session-save').disabled = !sessionAlbum;
}

/* ---------- task options: category, linked note, subtasks ---------- */

let taskDialogId = null;
let notePicking = false;
let noteList = null;

function openTaskDialog(id) {
  taskDialogId = id;
  notePicking = false;
  $('#task-form').sub.value = '';
  renderTaskDialog();
  $('#task-dialog').showModal();
}
function renderTaskDialog() {
  const t = find(data.tasks, taskDialogId);
  if (!t) return;
  $('#task-title').textContent = t.text;
  fill($('#task-cats'),
    el('button', { class: 'chip cat-chip', type: 'button', 'aria-pressed': String(!t.cat), onclick: () => { setTaskCat(t.id, null); renderTaskDialog(); } }, 'None'),
    activeCats().map((c) => el('button', {
      class: 'chip cat-chip', type: 'button', style: `--cat:${c.color}`, 'aria-pressed': String(t.cat === c.id),
      onclick: () => { setTaskCat(t.id, c.id); renderTaskDialog(); },
    }, el('span', { class: 'cat-dot' }), c.name)),
    el('button', {
      class: 'chip more-chip', type: 'button',
      onclick: () => { openCatDialog(); $('#cat-form').name.focus(); },
    }, '+ New'));
  const parent = openParent(t);
  $('#task-outdent').hidden = !parent;
  $('#task-where').textContent = parent ? `Subtask of “${parent.text}”` : '';
  renderNotePicker(t);
}
function renderNotePicker(t) {
  const box = $('#task-note');
  if (t.note && !notePicking) {
    fill(box, el('div', { class: 'note-row' },
      el('a', { class: 'note-chip', href: noteUrl(t.note.id), target: '_blank', rel: 'noopener' }, `📝 ${t.note.title}`),
      el('button', { class: 'small-btn', type: 'button', onclick: () => { notePicking = true; renderNotePicker(t); } }, 'Change'),
      el('button', { class: 'small-btn', type: 'button', onclick: () => { touch(t, { note: null }); change(); renderTaskDialog(); } }, 'Remove')));
    return;
  }
  if (!notePicking) {
    fill(box, el('button', { class: 'small-btn', type: 'button', onclick: () => { notePicking = true; renderNotePicker(t); } }, '📝 Link a note…'));
    return;
  }
  const input = el('input', { class: 'note-search', placeholder: 'Search your notes', autocomplete: 'off', 'aria-label': 'Search notes' });
  const list = el('ul', { class: 'list plain note-results' }, el('li', { class: 'empty' }, 'Loading your notes…'));
  const draw = () => {
    if (!Array.isArray(noteList)) return;
    const q = clean(input.value).toLowerCase();
    const hits = noteList.filter((n) => !q || n.title.toLowerCase().includes(q)).slice(0, 30);
    fill(list, hits.length ? hits.map((n) => el('li', { class: 'item' },
      el('button', { class: 'note-pick', type: 'button', onclick: () => { touch(t, { note: { id: n.id, title: n.title } }); notePicking = false; change(); renderTaskDialog(); } }, `📝 ${n.title}`)))
      : el('li', { class: 'empty' }, q ? 'No matching notes.' : 'No notes yet.'));
  };
  input.addEventListener('input', draw);
  fill(box, input, list);
  input.focus();
  scriptoriumNotes().then((notes) => { noteList = notes; draw(); })
    .catch((err) => fill(list, el('li', { class: 'empty' }, err.message)));
}

function openCatDialog() {
  renderCatDialog();
  $('#cat-dialog').showModal();
}
function renderCatDialog() {
  fill($('#cat-list'), activeCats().map((c) => el('li', { class: 'item' },
    el('button', {
      class: 'cat-swatch', type: 'button', style: `--cat:${c.color}`, title: 'Change color', 'aria-label': `Change color of ${c.name}`,
      onclick: () => { touch(c, { color: CAT_COLORS[(CAT_COLORS.indexOf(c.color) + 1) % CAT_COLORS.length] }); change(); renderCatDialog(); },
    }),
    editableText(c.name, (v) => { touch(c, { name: v }); change(); renderCatDialog(); }),
    el('button', {
      class: 'small-btn', type: 'button',
      onclick: () => {
        touch(c, { retired: true });
        change();
        renderCatDialog();
        toast(`Removed ${c.name} — its tasks keep their text`, () => { touch(c, { retired: false }); change(); renderCatDialog(); });
      },
    }, 'Remove'))));
}

/* ---------- Today: jump to a section ---------- */

function setupJumpBar() {
  const bar = $('#jump');
  for (const b of bar.querySelectorAll('button')) {
    b.addEventListener('click', () => $(`#${b.dataset.target}`).scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
  if (!('IntersectionObserver' in window)) return;
  const visible = new Map();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) visible.set(e.target.id, e.isIntersecting);
    const first = [...bar.querySelectorAll('button')].find((b) => visible.get(b.dataset.target));
    for (const b of bar.querySelectorAll('button')) b.classList.toggle('on', b === first);
  }, { rootMargin: '-110px 0px -55% 0px' });
  for (const b of bar.querySelectorAll('button')) io.observe($(`#${b.dataset.target}`));
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
  $('#toast-undo').hidden = !undo;
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
bindAdd($('#add-task'), (text) => addTask(text, null, { cat: todoFilter }));
bindAdd($('#add-habit'), (text) => addHabit(text, $('#add-habit').every.value));
bindAdd($('#add-symptom'), pickSymptom);
$('#add-symptom').text.addEventListener('input', renderSymptomChips);
for (const b of document.querySelectorAll('#severity button')) {
  b.addEventListener('click', () => { severity = Number(b.dataset.sev); renderSymptomsToday(); });
}
for (const b of document.querySelectorAll('#range button')) {
  b.addEventListener('click', () => {
    symptomFrom = b.dataset.days === 'all' ? earliestSymptomDay() : addDays(dayKey(), 1 - Number(b.dataset.days));
    renderSymptomLog();
  });
}
$('#range-from').addEventListener('change', (e) => { if (e.target.value) { symptomFrom = e.target.value; renderSymptomLog(); } });
$('#doctor-open').addEventListener('click', openDoctorView);
$('#doctor-close').addEventListener('click', () => $('#doctor').close());
$('#share-report').addEventListener('click', shareReport);
$('#copy-report').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(reportText(currentReport())); toast('Symptom log copied'); } catch { toast('Couldn’t copy — use Share instead'); }
});

enableDrag($('#habits'), (ids) => reorder(data.habits, ids));
enableDrag($('#tasks'), (ids) => reorder(data.tasks, ids));

$('#backfill-day').addEventListener('change', (e) => {
  if (e.target.value && e.target.value <= dayKey()) { backfillDay = e.target.value; renderBackfill(); }
});
$('#edit-habits').addEventListener('click', () => { editingHabits = !editingHabits; render(); });

document.addEventListener('focusout', (e) => {
  if (e.target.matches && e.target.matches('.text, .cost, .limit-amount') && renderPending) setTimeout(render);
});

const VIEWS = { today: 'Today', albums: 'Albums', projects: 'Projects', buy: 'To buy', archive: 'Archive', symptoms: 'Symptoms' };
function showView(view) {
  for (const b of document.querySelectorAll('.tabs button')) {
    b.classList.toggle('active', b.dataset.view === view);
    if (b.dataset.view === view) b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
  for (const v of Object.keys(VIEWS)) $(`#view-${v}`).hidden = view !== v;
  $('#title').textContent = VIEWS[view];
  scrollTo(0, 0);
}
for (const btn of document.querySelectorAll('.tabs button')) btn.addEventListener('click', () => showView(btn.dataset.view));

// Android's Back button: close an open dialog, else go back to Today, else let the app close.
window.handleBack = () => {
  const open = document.querySelector('dialog[open]');
  if (open) { open.close(); return true; }
  if ($('#view-today').hidden) { showView('today'); return true; }
  return false;
};
if (androidApp) $('#get-android').hidden = true;

bindAdd($('#add-album'), (name) => addAlbum(name, 'album'));
bindAdd($('#add-project'), (name) => addAlbum(name, 'project'));
$('#add-limit').addEventListener('click', () => openLimitDialog());
$('#limit-cancel').addEventListener('click', () => $('#limit-dialog').close());
$('#limit-form').addEventListener('submit', (e) => { e.preventDefault(); saveLimitForm(); });
$('#limit-remove').addEventListener('click', () => {
  const l = find(data.limits, editingLimit);
  touch(l, { retired: true });
  $('#limit-dialog').close();
  change();
  toast(`Removed ${l.name} — its history stays in the archive`, () => { touch(l, { retired: false }); change(); });
});
for (const b of document.querySelectorAll('#limit-templates button')) {
  b.addEventListener('click', () => {
    const f = $('#limit-form');
    for (const [k, v] of Object.entries(JSON.parse(b.dataset.fill))) f[k].value = v;
  });
}
$('#buy-when').addEventListener('change', (e) => { lastWhen = e.target.value; });
bindAdd($('#add-buy'), (text) => {
  lastWhen = $('#buy-when').value;
  addBuy(text, lastWhen, parseCost($('#buy-cost').value));
  $('#buy-cost').value = '';
});
$('#session-skip').addEventListener('click', () => $('#session').close());
$('#task-close').addEventListener('click', () => $('#task-dialog').close());
$('#task-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = clean($('#task-form').sub.value);
  if (!text) return;
  const t = find(data.tasks, taskDialogId);
  addTask(text, t.albumId || null, { parentId: t.id, cat: t.cat || null });
  $('#task-form').sub.value = '';
  $('#task-form').sub.focus();
  toast(`Added a subtask to “${t.text}”`);
});
$('#task-indent').addEventListener('click', () => { indentTask(taskDialogId); renderTaskDialog(); });
$('#task-outdent').addEventListener('click', () => { outdentTask(taskDialogId); renderTaskDialog(); });
$('#cat-close').addEventListener('click', () => $('#cat-dialog').close());
$('#cat-dialog').addEventListener('close', () => { if ($('#task-dialog').open) renderTaskDialog(); });
$('#cat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = clean($('#cat-form').name.value);
  if (!name) return;
  addCategory(name);
  $('#cat-form').name.value = '';
  renderCatDialog();
});
setupJumpBar();
$('#session-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!sessionAlbum) return;
  logSession(sessionAlbum, sessionContext.day, clean($('#session-form').note.value), sessionContext.habitId);
  $('#session').close();
  toast(`Logged a session on ${albumName(sessionAlbum)}`);
});

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
  if (target(next) !== target(settings)) { lastSyncedSha = null; store.set('lastSyncedSha', null); lastHeadSha = null; store.set('lastHeadSha', null); }
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
  if (androidApp) { androidApp.shareText(`Daily backup ${dayKey()}`, JSON.stringify(data, null, 2)); return; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  el('a', { href: url, download: `daily-backup-${dayKey()}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// Daily items reset at midnight: re-render when the date changes, and pull fresh data when the app comes back.
setInterval(() => {
  if (dayKey() !== renderedDay) render();
  else if (!document.hidden && !(document.activeElement && document.activeElement.matches('.limit-amount'))) renderLimits();
}, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { if (syncTimer) sync(); } else { render(); sync(); }
});
addEventListener('online', () => sync());
// Pick up changes from your other devices while the app stays open: on focus, and once a minute.
addEventListener('focus', () => sync());
setInterval(() => { if (!document.hidden && !syncing) sync(); }, 60000);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

seedCategories();
render();
sync();
