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
 * Tasks may also have: cat (category id), parentId (subtask of another task), collapsed (hide its subtasks), remind (ms timestamp to ring the phone) and remindLoud, note ({ id, title }: a
 * link to one of the notes).
 * Albums have kind 'album' (music) or 'project' (anything else); both have steps and sessions.
 * categories: { id, name, color, order, retired, updated }
 * notes: { id, text, tags, src, file, created, updated, removed }   the first line of text is the title
 * Nothing is ever deleted, so two devices can always be merged item by item.
 */

// Albums and projects keep a manual order, and one jumps to the top when you work on it.
// Older data has no order yet, so start it from what was worked on most recently.
function seedAlbumOrder(albums, tasks, sessions) {
  const copy = albums.map((a) => ({ ...a }));
  const missing = copy.filter((a) => a.order == null);
  if (!missing.length) return copy;
  const lastOf = (a) => {
    let last = '';
    for (const x of sessions) if (x.albumId === a.id && !x.removed && x.day > last) last = x.day;
    for (const t of tasks) if (t.albumId === a.id && t.doneDay && t.doneDay > last) last = t.doneDay;
    return last;
  };
  const top = copy.reduce((m, a) => (a.order == null ? m : Math.max(m, a.order)), 0);
  missing.map((a) => ({ a, last: lastOf(a) }))
    .sort((x, y) => y.last.localeCompare(x.last) || (x.a.created || 0) - (y.a.created || 0))
    .forEach(({ a }, i) => { a.order = top + i + 1; });
  return copy;
}

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  return {
    version: 1,
    tasks: Array.isArray(d.tasks) ? d.tasks : [],
    habits: Array.isArray(d.habits) ? d.habits.map((h) => ({ ...h, log: h.log || {} })) : [],
    symptoms: Array.isArray(d.symptoms) ? d.symptoms : [],
    albums: seedAlbumOrder(Array.isArray(d.albums) ? d.albums : [], Array.isArray(d.tasks) ? d.tasks : [], Array.isArray(d.sessions) ? d.sessions : []),
    sessions: Array.isArray(d.sessions) ? d.sessions : [],
    limits: Array.isArray(d.limits) ? d.limits : [],
    doses: Array.isArray(d.doses) ? d.doses : [],
    categories: Array.isArray(d.categories) ? d.categories : [],
    notes: Array.isArray(d.notes) ? d.notes : [],
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
  const t = { id: uid(), text, albumId, order, created: now, doneAt: null, doneDay: null, updated: now, cat: null, parentId: null, ...extra };
  data.tasks.push(t);
  change();
  return t;
}

/* ---------- plain-language reminders: "movie Friday 4:15pm" ---------- */

const DAY_WORDS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_WORDS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const WORD_TIMES = { noon: [12, 0], midnight: [0, 0], morning: [9, 0], afternoon: [15, 0], evening: [18, 0], tonight: [20, 0], night: [20, 0] };

// Finds a day and time written inside a task ("movie Friday 4:15pm", "call mom in 2 hours",
// "pay rent tomorrow at 9") and returns { text: the task without it, at: ms }, or null.
// It needs a clock time, a time of day (tonight, evening…), "in 2 hours" or "tomorrow";
// a bare weekday or date isn't enough, so things like "Sunday school" are left alone.
function parseReminder(raw, nowDate = new Date()) {
  const text = String(raw);
  const cuts = [];
  const take = (re) => {
    const m = re.exec(text);
    if (!m) return null;
    cuts.push([m.index, m.index + m[0].length]);
    return m;
  };
  const now = new Date(nowDate);
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

  // "in 2 hours", "in half an hour", "in 3 days"
  const rel = take(/\bin\s+(half an?|an?|\d+(?:\.\d+)?)\s*(min(?:ute)?s?|hrs?|hours?|days?|weeks?|months?)\b/i);
  let relMs = null;
  let relDays = 0;
  let relMonths = 0;
  if (rel) {
    const n = /half/i.test(rel[1]) ? 0.5 : /^an?$/i.test(rel[1]) ? 1 : parseFloat(rel[1]);
    const unit = rel[2].toLowerCase();
    if (unit.startsWith('mo')) relMonths = Math.max(1, Math.round(n));
    else if (unit.startsWith('m')) relMs = n * 60000;
    else if (unit.startsWith('h')) relMs = n * 3600000;
    else relDays = Math.round(n * (unit.startsWith('w') ? 7 : 1));
  }

  // clock time: 4:15pm, 4pm, 16:30, "at 4", @4
  let hm = null;
  let softWord = null;
  let m = take(/(?:\bat\s+|@\s*)?\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b\.?/i);
  if (m) {
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2] || '0', 10);
    if (hh < 1 || hh > 12 || mm > 59) return null;
    hm = [(hh % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0), mm];
  } else if ((m = take(/(\bat\s+)?\b([01]?\d|2[0-3]):([0-5]\d)\b/))) {
    let h = parseInt(m[2], 10);
    // "4:15" or "7:30" with no am/pm: afternoons for 1–6, mornings for 7–11
    if (h >= 1 && h <= 6) h += 12;
    hm = [h, parseInt(m[3], 10)];
    // a bare "3:16" could be a Bible verse: it needs a day ("Friday 3:16") or "at"
    if (!m[1]) softWord = cuts[cuts.length - 1];
  } else if ((m = take(/(?:\bat\s+|@\s*)(\d{1,2})\b(?!\s*[:/\-])/i))) {
    let h = parseInt(m[1], 10);
    if (h > 23) hm = null;
    else { if (h >= 1 && h <= 6) h += 12; hm = [h, 0]; }
  }
  // "evening", "morning"… only count next to a day ("tomorrow evening") or after "at"; "Midnight Mass" stays a task name
  if (!hm) {
    const w = take(/(\bat\s+)?\b(noon|midnight|morning|afternoon|evening|tonight|night)\b/i);
    if (w) {
      hm = WORD_TIMES[w[2].toLowerCase()];
      if (!w[1] && w[2].toLowerCase() !== 'tonight') softWord = cuts[cuts.length - 1];
    }
  }
  if (hm) hm = [hm[0], hm[1]];

  // the day: today, tomorrow, a weekday, or a date
  let day = null;
  let explicit = false;
  if ((m = take(/\b(?:(next|this)\s+)?(sun|mon|tue|wed|thu|fri|sat)(?:day|s|sday|nesday|rsday|urday|r|rs)?\b/i))) {
    const target = DAY_WORDS[m[2].toLowerCase()];
    day = startOfDay(now);
    let diff = (target - day.getDay() + 7) % 7;
    if (m[1] && m[1].toLowerCase() === 'next') diff = (7 - day.getDay()) + target; // that weekday in next Sunday–Saturday week
    else if (diff === 0 && hm && (hm[0] * 60 + hm[1]) * 60000 <= now - startOfDay(now)) diff = 7;
    day.setDate(day.getDate() + diff);
    explicit = true;
  } else if ((m = take(/\b(tomorrow|tmrw|tmr|today|tonight)\b/i))) {
    const word = m[1].toLowerCase();
    day = startOfDay(now);
    if (word.startsWith('tom') || word === 'tmr' || word === 'tmrw') day.setDate(day.getDate() + 1);
    if (word === 'tonight' && !hm) hm = WORD_TIMES.tonight;
    if (/^t(om|mr)/.test(word) && !hm) hm = [9, 0];
    explicit = true;
  } else if ((m = take(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i)) || (m = take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    let month; let date; let year = now.getFullYear();
    if (/^[a-z]/i.test(m[1])) { month = MONTH_WORDS[m[1].toLowerCase()]; date = parseInt(m[2], 10); }
    else { month = parseInt(m[1], 10) - 1; date = parseInt(m[2], 10); if (m[3]) year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10); }
    if (month < 0 || month > 11 || date < 1 || date > 31) return null;
    day = new Date(year, month, date);
    if (!m[3] && day < startOfDay(now)) day.setFullYear(year + 1);
    explicit = true;
  }

  if (softWord && !explicit) {
    cuts.splice(cuts.indexOf(softWord), 1);
    hm = null;
  }

  let at;
  if (relMs != null) {
    at = now.getTime() + relMs;
  } else if (relDays || relMonths) {
    const d = startOfDay(now);
    if (relMonths) d.setMonth(d.getMonth() + relMonths); else d.setDate(d.getDate() + relDays);
    d.setHours(hm ? hm[0] : 9, hm ? hm[1] : 0, 0, 0);
    at = d.getTime();
  } else if (hm || (day && /tomorrow|tmrw|tmr/i.test(text))) {
    const d = day ? new Date(day) : startOfDay(now);
    d.setHours(hm[0], hm[1], 0, 0);
    if (!day && d.getTime() <= now.getTime() + 60000) d.setDate(d.getDate() + 1); // "at 9" after 9: tomorrow
    at = d.getTime();
  } else {
    return null;
  }
  if (!explicit && !hm && relMs == null && !relDays && !relMonths) return null;
  if (at <= now.getTime()) return null;

  // the task is what's left once the time words are taken out
  let out = text;
  for (const [a, b] of cuts.sort((x, y) => y[0] - x[0])) out = `${out.slice(0, a)} ${out.slice(b)}`;
  out = out.replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:at|on|by|for|around|this|next|in|@|-|,|:)\s+)+/i, '')
    .replace(/(?:\s+(?:at|on|by|for|around|this|next|in|@|-|,|:))+$/i, '').trim();
  return { text: out || text.trim(), at };
}

// 9 AM, this many days/weeks/months from now: the time the quick reminder options use.
function fromNow(n, unit, nowDate = new Date()) {
  const d = new Date(nowDate);
  d.setHours(9, 0, 0, 0);
  if (unit.startsWith('mo')) d.setMonth(d.getMonth() + n);
  else d.setDate(d.getDate() + n * (unit.startsWith('w') ? 7 : 1));
  return d.getTime();
}
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3 };

// A loose "2 weeks", "three days", "a month" or "next week" in a task isn't a firm time, so the app only offers a reminder.
// Returns { at, label } or null.
function parseVagueWhen(raw, nowDate = new Date()) {
  const text = String(raw);
  let m = /\bnext\s+(week|month)\b/i.exec(text);
  if (m) return { at: fromNow(1, m[1].toLowerCase()), label: `next ${m[1].toLowerCase()}` };
  m = /\b(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple of|few)\s+(days?|weeks?|months?)\b/i.exec(text);
  if (!m) return null;
  const w = m[1].toLowerCase().replace(/ of$/, '');
  const n = /^\d/.test(w) ? parseInt(w, 10) : NUM_WORDS[w];
  if (!n || n > 365) return null;
  const unit = m[2].toLowerCase().replace(/s$/, '');
  return { at: fromNow(n, unit, nowDate), label: `${n === 1 ? (w === 'a' || w === 'an' ? 'a' : '1') : n} ${unit}${n === 1 ? '' : 's'}` };
}

// "buy lamp $40" (or "buy lamp 40", "buy lamp 40 dollars") → { text: 'lamp', cost: 40 }; null without a price.
function parseBuy(raw) {
  const m = /^\s*buy\s+(.+)$/i.exec(raw);
  if (!m) return null;
  const rest = m[1];
  const price = /\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:dollars?|bucks)\b|(?:^|\s)(\d[\d,]*(?:\.\d{1,2})?)\s*$/i.exec(rest);
  if (!price) return null;
  const cost = Number((price[1] || price[2] || price[3]).replace(/,/g, ''));
  const text = clean((rest.slice(0, price.index) + ' ' + rest.slice(price.index + price[0].length)).replace(/\s+(for|at|around|about)\s*$/i, ''));
  return text && cost > 0 ? { text, cost } : null;
}

// Adds a task; if the text says when ("movie Friday 4:15pm") it also sets that reminder.
function addTaskSmart(raw, albumId = null, extra = {}) {
  const b = !albumId && !extra.parentId && parseBuy(raw);
  if (b) {
    const item = addBuy(b.text, 'someday', b.cost);
    toast(`🛒 “${b.text}” (${money(b.cost)}) added to To buy · Someday`, () => { data.tasks = data.tasks.filter((x) => x.id !== item.id); change(); });
    return null;
  }
  const r = parseReminder(raw);
  if (!r) {
    const t = addTask(raw, albumId, extra);
    const v = parseVagueWhen(raw);
    if (v) toast(`Remind you in ${v.label}? (${remindText(v.at)})`, () => { setReminder(t.id, v.at); }, 9000, 'Remind me');
    return t;
  }
  const t = addTask(r.text, albumId, { ...extra, remind: r.at, remindLoud: false });
  toast(`⏰ “${r.text}” — ${remindText(r.at)}`, () => { touch(t, { text: raw, remind: null }); change(); });
  const bridge = window.AndroidApp;
  if (bridge && bridge.reminderStatus && bridge.reminderStatus() === 'notifications-off') bridge.requestNotifications();
  return t;
}
function completeTask(id) {
  const t = find(data.tasks, id);
  const now = Date.now();
  // Checking a task also checks off its open subtasks.
  const done = [t];
  const walk = (pid) => { for (const c of childTasks(pid)) { done.push(c); walk(c.id); } };
  walk(t.id);
  for (const x of done) touch(x, { doneAt: now, doneDay: dayKey() });
  if (t.albumId) bumpAlbum(t.albumId);
  change();
  const extra = done.length > 1 ? ` and ${plural(done.length - 1, 'subtask')}` : '';
  toast(`${t.buy ? 'Bought' : 'Archived'} “${t.text}”${extra}`, () => { for (const x of done) touch(x, { doneAt: null, doneDay: null }); change(); });
  // Checking off a step of an album or project: offer to log the session (once a day is plenty).
  const album = t.albumId && find(data.albums, t.albumId);
  if (album && !album.finishedAt && !albumSessions(album.id).some((x) => x.day === dayKey())) {
    openSessionDialog({ albumId: album.id, day: dayKey(), note: `Finished “${t.text}”` });
  }
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
function celebrate(message = '🎉 All done for today!', { pop = true } = {}) {
  const pill = $('#daily-progress');
  if (pop) {
    pill.classList.remove('pop');
    void pill.offsetWidth;
    pill.classList.add('pop');
  }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#2f7d5b', '#e8b04a', '#e0735f', '#5b8def', '#b66fd1', '#f06bb0'];
  const layer = el('div', { class: 'confetti', 'aria-hidden': 'true' },
    Array.from({ length: 70 }, (_, i) => el('i', {
      style: `--x:${(Math.random() * 100).toFixed(1)}vw;--dx:${((Math.random() - 0.5) * 40).toFixed(1)}vw;--r:${Math.round(Math.random() * 720 - 360)}deg;`
        + `--d:${(1.8 + Math.random() * 1.4).toFixed(2)}s;--w:${(Math.random() * 0.5).toFixed(2)}s;--c:${colors[i % colors.length]}`,
    })),
    el('div', { class: 'cheer' }, message));
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

/* ---------- links in task text ---------- */

// Links to notes made in the old Scriptorium app (before notes moved into Daily).
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

/* ---------- notes ----------
 * notes: { id, text, tags, src, file, created, updated, removed }
 * The first line of text is the title. Each note is also written to the repo as Notes/<title>.md
 * (front matter + text), the same layout the old Scriptorium app used, so existing notes import as they are.
 */

const noteTitle = (n) => {
  const line = (n.text || '').split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
  return (line || 'Untitled').slice(0, 80);
};
const noteBody = (n) => (n.text || '').split('\n').slice(1).join(' ').replace(/\[[ xX]\]|[*#>=~`_]+/g, '').replace(/\s+/g, ' ').trim();
const liveNotes = () => data.notes.filter((n) => !n.removed).sort((a, b) => b.updated - a.updated);
const shortDay = (ms) => { const d = new Date(ms); return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`; };

let noteLib = null; // formatting and math (notelib.js), loaded in the background
import('./notelib.js').then((m) => { noteLib = m; if (openNoteId) showNoteMode(); }).catch(() => {});
let noteReading = false;

let openNoteId = null;
let openNoteDraft = null; // a new note that hasn't been typed in yet isn't saved
let noteQuery = '';

function renderNotes() {
  const all = liveNotes();
  $('#note-count').textContent = all.length ? String(all.length) : '';
  const q = noteQuery.toLowerCase();
  const hits = q ? all.filter((n) => `${n.text}\n${(n.tags || []).join(' ')}`.toLowerCase().includes(q)) : all;
  fill($('#notes'), hits.length ? hits.map((n) => el('li', { class: 'item note-item' },
    el('button', { class: 'note-open', type: 'button', onclick: () => openNote(n.id) },
      el('span', { class: 'note-name' }, noteTitle(n)),
      el('span', { class: 'note-date' }, shortDay(n.updated)),
      noteBody(n) ? el('span', { class: 'note-snip' }, noteBody(n).slice(0, 110)) : null,
      (n.tags || []).length ? el('span', { class: 'note-tags' }, n.tags.map((t) => el('span', { class: 'note-tag' }, `#${t}`))) : null)))
    : el('li', { class: 'empty' }, q ? 'No matching notes.' : 'No notes yet. Tap + to write one.'));
}

function openNote(id) {
  const n = find(data.notes, id) || (openNoteDraft && openNoteDraft.id === id ? openNoteDraft : null);
  if (!n) return;
  openNoteId = id;
  $('#task-dialog').open && $('#task-dialog').close();
  if ($('#view-notes').hidden) showView('notes');
  $('#notes-list-pane').hidden = true;
  $('#note-pane').hidden = false;
  $('#note-text').value = n.text || '';
  $('#note-math').hidden = true;
  $('#note-meta').textContent = n.updated ? `Edited ${shortDay(n.updated)}` : 'New';
  const src = $('#note-src');
  src.hidden = !n.src;
  fill(src, n.src ? ['From ', el('a', { href: n.src, target: '_blank', rel: 'noopener' }, shortUrl(n.src))] : []);
  noteReading = !!(n.text || '').trim() && !(openNoteDraft && openNoteDraft.id === id);
  showNoteMode();
  scrollTo(0, 0);
}

// Read mode shows the formatting (and answers to tick boxes); Edit mode is the plain text with a toolbar.
function showNoteMode() {
  const reading = noteReading && !!noteLib;
  $('#note-read').hidden = !reading;
  $('#note-text').hidden = reading;
  $('#note-format').hidden = reading;
  $('#note-math').hidden = true;
  $('#note-mode').textContent = reading ? 'Edit' : 'Read';
  $('#note-mode').hidden = !noteLib;
  if (reading) renderNoteRead();
}

function renderNoteRead() {
  const n = find(data.notes, openNoteId);
  const box = $('#note-read');
  box.innerHTML = noteLib.markdownToHtml(n ? n.text : '');
  [...box.querySelectorAll('ul.checklist > li, ul.checklist li')].forEach((li, i) => {
    const on = li.dataset.checked === 'true';
    li.classList.toggle('done', on);
    li.prepend(el('input', { type: 'checkbox', class: 'note-check', ...(on ? { checked: '' } : {}), 'aria-label': 'Done', onchange: (e) => toggleNoteCheck(i, e.target.checked) }));
  });
  if (!box.textContent.trim()) box.append(el('p', { class: 'hint' }, 'Nothing here yet. Tap Edit to write.'));
}

// The i-th "- [ ]" line in the note (outside code blocks) is ticked or unticked.
function toggleNoteCheck(i, on) {
  const n = find(data.notes, openNoteId);
  if (!n) return;
  let fence = false;
  let seen = -1;
  const lines = n.text.split('\n').map((line) => {
    if (/^\s*```/.test(line)) { fence = !fence; return line; }
    if (fence || !/^\s*([-*+]|\d+[.)])\s+\[[ xX]\]/.test(line)) return line;
    return ++seen === i ? line.replace(/\[[ xX]\]/, on ? '[x]' : '[ ]') : line;
  });
  touch(n, { text: lines.join('\n') });
  $('#note-text').value = n.text;
  change();
  renderNoteRead();
}

function closeNote() {
  const n = find(data.notes, openNoteId);
  if (n && !(n.text || '').trim()) { touch(n, { removed: true }); change(); }
  openNoteId = null;
  openNoteDraft = null;
  $('#note-pane').hidden = true;
  $('#notes-list-pane').hidden = false;
  renderNotes();
  scrollTo(0, 0);
}

function newNote(text = '', extra = {}) {
  const now = Date.now();
  return { id: uid(), text, tags: [], src: '', file: null, created: now, updated: now, removed: false, ...extra };
}

function startNote() {
  openNoteDraft = newNote();
  openNote(openNoteDraft.id);
  $('#note-text').focus();
}

$('#note-text').addEventListener('input', (e) => {
  let n = find(data.notes, openNoteId);
  if (!n && openNoteDraft && openNoteDraft.id === openNoteId) { n = openNoteDraft; data.notes.push(n); openNoteDraft = null; }
  if (!n) return;
  touch(n, { text: $('#note-text').value });
  const ta = $('#note-text');
  if (noteLib && e.data === '=' && e.inputType === 'insertText' && ta.selectionStart === ta.selectionEnd) {
    // "12*4 + 3 =" → the answer appears after the "="
    const caret = ta.selectionStart;
    const res = noteLib.inlineCalc(ta.value.slice(ta.value.lastIndexOf('\n', caret - 1) + 1, caret));
    if (res) { replaceNoteText(caret, caret, ` ${res.text}`); return; }
  }
  $('#note-meta').textContent = `Edited ${shortDay(n.updated)}`;
  change();
});
$('#note-mode').addEventListener('click', () => {
  noteReading = !noteReading;
  showNoteMode();
  if (!noteReading) $('#note-text').focus();
});
// Formatting buttons act on the selected text (or the lines it touches) without taking focus from the text box.
$('#note-tools').addEventListener('mousedown', (e) => { if (e.target.closest('button[data-fmt]')) e.preventDefault(); });
$('#note-tools').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-fmt]');
  if (b) formatNote(b.dataset.fmt);
});

function replaceNoteText(start, end, text, selStart = start + text.length, selEnd = selStart) {
  const ta = $('#note-text');
  ta.focus();
  ta.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) { // keeps Undo working where the browser allows it
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  ta.setSelectionRange(selStart, selEnd);
}

function wrapNote(mark) {
  const ta = $('#note-text');
  const { selectionStart: a, selectionEnd: b, value } = ta;
  const m = mark.length;
  if (a !== b && value.slice(a - m, a) === mark && value.slice(b, b + m) === mark) { // already wrapped: unwrap
    replaceNoteText(a - m, b + m, value.slice(a, b), a - m, b - m);
  } else if (a === b) {
    replaceNoteText(a, b, mark + mark, a + m);
  } else {
    replaceNoteText(a, b, mark + value.slice(a, b) + mark, a + m, b + m);
  }
}

function prefixNoteLines(kind) {
  const ta = $('#note-text');
  const { selectionStart: a, selectionEnd: b, value } = ta;
  const start = value.lastIndexOf('\n', a - 1) + 1;
  let end = value.indexOf('\n', b);
  if (end < 0) end = value.length;
  const lines = value.slice(start, end).split('\n');
  const LIST = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?|#{1,6}\s+)/;
  const marks = {
    ul: [/^\s*[-*+]\s+(?!\[[ xX]\])/, () => '- '],
    ol: [/^\s*\d+[.)]\s+/, (i) => `${i + 1}. `],
    check: [/^\s*[-*+]\s+\[[ xX]\]\s+/, () => '- [ ] '],
    quote: [/^\s*>\s?/, () => '> '],
  };
  let out = lines;
  if (kind === 'head') { // none → # → ## → ### → none
    const level = (/^(#{1,6})\s+/.exec(lines[0]) || [''])[0].trim().length;
    const body = lines[0].replace(/^#{1,6}\s+/, '');
    out = [level >= 3 ? body : `${'#'.repeat(level + 1)} ${body}`, ...lines.slice(1)];
  } else {
    const [has, make] = marks[kind];
    const all = lines.every((l) => !l.trim() || has.test(l));
    out = lines.map((l, i) => (!l.trim() ? l : all ? l.replace(has, '') : make(i) + l.replace(LIST, '$1')));
  }
  const text = out.join('\n');
  replaceNoteText(start, end, text, start, start + text.length);
}

function linkNote() {
  const ta = $('#note-text');
  const { selectionStart: a, selectionEnd: b, value } = ta;
  const label = value.slice(a, b) || 'link';
  const ins = `[${label}](https://)`;
  replaceNoteText(a, b, ins, a + label.length + 3, a + ins.length - 1);
}

function mathNote() {
  const box = $('#note-math');
  if (!box.hidden) { box.hidden = true; return; }
  const ta = $('#note-text');
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  const text = sel || ta.value;
  const nums = noteLib.extractNumbers(text);
  const stats = noteLib.summarize(nums);
  const rows = stats ? [['Sum', stats.sum], ['Average', stats.average], ['Count', stats.count], ['Min', stats.min], ['Max', stats.max], ['Difference', stats.difference], ['Product', stats.product], ['Quotient', stats.quotient]] : [];
  const at = ta.selectionEnd;
  fill(box,
    el('p', { class: 'math-head' }, stats ? `${plural(nums.length, 'number')} in ${sel ? 'your selection' : 'this note'}: ${nums.slice(0, 8).map(noteLib.formatNumber).join(', ')}${nums.length > 8 ? '…' : ''}` : 'No numbers found.'),
    rows.map(([label, v]) => el('button', {
      class: 'math-row', type: 'button',
      onclick: () => {
        const value = noteLib.formatNumber(v);
        if (sel) replaceNoteText(at, at, ` = ${value}`);
        else { const end = ta.value.length; replaceNoteText(end, end, `${end && !ta.value.endsWith('\n') ? '\n' : ''}**${label}: ${value}**\n`); }
        box.hidden = true;
      },
    }, el('span', {}, label), el('b', {}, noteLib.formatNumber(v)), el('span', { class: 'math-ins' }, 'Insert'))),
    el('p', { class: 'hint' }, 'Tip: type something like 12*4 + 3 = and the answer appears.'));
  box.hidden = false;
}

function formatNote(kind) {
  if (!openNoteId) return;
  if (kind === 'bold') return wrapNote('**');
  if (kind === 'italic') return wrapNote('*');
  if (kind === 'strike') return wrapNote('~~');
  if (kind === 'mark') return wrapNote('==');
  if (kind === 'link') return linkNote();
  if (kind === 'math') return noteLib && mathNote();
  prefixNoteLines(kind);
}
$('#new-note').addEventListener('click', startNote);
$('#note-back').addEventListener('click', closeNote);
$('#note-search').addEventListener('input', (e) => { noteQuery = clean(e.target.value); renderNotes(); });
$('#note-delete').addEventListener('click', () => {
  const n = find(data.notes, openNoteId);
  if (n) {
    touch(n, { removed: true });
    change();
    toast('Note deleted', () => { touch(n, { removed: false }); change(); });
  }
  openNoteId = null;
  openNoteDraft = null;
  $('#note-pane').hidden = true;
  $('#notes-list-pane').hidden = false;
  renderNotes();
});

/* ---------- saving shared articles as text ---------- */

// The Android app can fetch a page itself (no browser cross-site limits); elsewhere the page is read through a reader service.
const pageCalls = new Map();
window.__pageDone = (id, ok, charset, b64) => {
  const call = pageCalls.get(id);
  if (!call) return;
  pageCalls.delete(id);
  if (!ok) return call.reject(new Error(b64 || 'Could not load the page'));
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    let label = charset || (/charset=["']?([\w-]+)/i.exec(new TextDecoder('latin1').decode(bytes.slice(0, 2048))) || [])[1] || 'utf-8';
    let html;
    try { html = new TextDecoder(label).decode(bytes); } catch { html = new TextDecoder('utf-8').decode(bytes); }
    call.resolve(html);
  } catch (err) { call.reject(err); }
};
function nativeFetch(url) {
  return new Promise((resolve, reject) => {
    const id = uid();
    pageCalls.set(id, { resolve, reject });
    window.AndroidApp.fetchPage(url, id);
    setTimeout(() => { if (pageCalls.delete(id)) reject(new Error('The page took too long to load')); }, 30000);
  });
}

const ARTICLE_JUNK = /^(advertisement|ad|sponsored|read more|read next|related( stories| articles| coverage| content)?|more from|recommended|see also|also read|most read|trending|watch:?|listen:?|sign up|subscribe|get the newsletter|newsletter|follow us|share( this)?( article| story)?|click here|copy link|comments?|image credit|getty images|tags?:|topics?:|cookie|we use cookies|accept all)\b/i;

// Pulls the readable text out of a web page: title, site, and the article body as plain paragraphs.
function extractArticle(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = (sel) => (doc.querySelector(sel) || {}).content || '';
  const host = new URL(url).hostname.replace(/^www\./, '');
  const site = clean(meta('meta[property="og:site_name"]')) || host;
  let title = clean(meta('meta[property="og:title"]') || (doc.querySelector('h1') || {}).textContent || doc.title || '');
  const m = title.match(/^(.{12,}?)\s+[|–—·-]\s+([^|–—·]{2,60})$/);
  if (m && (m[2].toLowerCase().includes(site.toLowerCase().slice(0, 8)) || site.toLowerCase().includes(m[2].toLowerCase()))) title = m[1];
  const byline = clean(meta('meta[name="author"]') || meta('meta[property="article:author"]'));
  doc.querySelectorAll('script, style, noscript, nav, aside, footer, header, form, button, iframe, svg, figure, [role="navigation"], [aria-hidden="true"]').forEach((e) => e.remove());

  const textOf = (e) => e.textContent.replace(/\s+/g, ' ').trim();
  const score = (c) => [...c.querySelectorAll('p')].reduce((n, p) => { const t = textOf(p).length; return n + (t >= 40 ? t : 0); }, 0);
  const cands = [...doc.querySelectorAll('article, main, [itemprop="articleBody"], [class*="article-body"], [class*="story-body"], [class*="post-content"], [class*="entry-content"], [class*="article-content"]'), doc.body].filter(Boolean);
  const scored = cands.map((c) => ({ c, s: score(c) }));
  const best = Math.max(...scored.map((x) => x.s));
  const pick = scored.filter((x) => x.s >= best * 0.85).sort((a, b) => a.c.textContent.length - b.c.textContent.length)[0].c;

  const lines = [];
  for (const b of pick.querySelectorAll('h2, h3, h4, p, li, blockquote')) {
    if (b.tagName === 'BLOCKQUOTE' && b.querySelector('p')) continue;
    const t = textOf(b);
    if (!t) continue;
    const links = [...b.querySelectorAll('a')].reduce((n, a) => n + textOf(a).length, 0);
    if (links / t.length > 0.6 && t.length < 200) continue;
    if (t.length < 120 && ARTICLE_JUNK.test(t)) continue;
    const tag = b.tagName;
    if (/^H/.test(tag)) lines.push(`## ${t}`);
    else if (tag === 'LI') { if (t.length >= 30) lines.push(`- ${t}`); }
    else if (tag === 'BLOCKQUOTE') lines.push(`> ${t}`);
    else if (t.length >= 25 || /[.!?"”]$/.test(t)) lines.push(t);
  }
  const body = lines.filter((l, i) => l !== lines[i - 1]).join('\n\n');
  if (body.length < 400) throw new Error('No article text found on that page');
  return { title, site, byline, body };
}

async function readerArticle(url) {
  const res = await fetch(`https://r.jina.ai/${url}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Reader service ${res.status}`);
  const j = await res.json();
  const d = j.data || j;
  const body = String(d.content || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  if (body.length < 400) throw new Error('No article text found on that page');
  return { title: clean(d.title || ''), site: new URL(url).hostname.replace(/^www\./, ''), byline: '', body };
}

async function fetchArticleText(url) {
  const errors = [];
  const attempts = [];
  if (window.AndroidApp && window.AndroidApp.fetchPage) attempts.push(async () => extractArticle(await nativeFetch(url), url));
  else attempts.push(async () => { const r = await fetch(url); if (!r.ok) throw new Error(String(r.status)); return extractArticle(await r.text(), url); });
  attempts.push(() => readerArticle(url));
  for (const run of attempts) {
    try { return await run(); } catch (err) { errors.push(err.message); }
  }
  throw new Error(errors.join('; '));
}

const articleText = (a, url) => [a.title, [a.byline, a.site].filter(Boolean).join(' · ') + ` · ${url}`, a.body].join('\n\n');

// Something shared to Daily from another app or the browser: a link becomes a saved article, plain text becomes a note.
async function receiveShare({ title = '', text = '', url = '' } = {}) {
  title = clean(title);
  text = String(text || '').trim();
  const link = url || (text.match(URL_RE) || [])[0] || '';
  showView('notes');
  if (!link) {
    const n = newNote([title, text].filter(Boolean).join('\n\n'));
    data.notes.push(n);
    change();
    toast('Saved to Notes');
    return;
  }
  const rest = text.replace(link, '').trim();
  const n = newNote(`${title || rest || link}\n\n${link}`, { src: link });
  data.notes.push(n);
  change();
  toast('Saving the article…', null, 30000);
  const started = n.updated;
  try {
    const art = await fetchArticleText(link);
    if (n.updated !== started || n.removed) { toast('Saved the link (you edited the note, so the article was not added)'); return; }
    touch(n, { text: articleText(art, link) });
    change();
    if (openNoteId === n.id) $('#note-text').value = n.text;
    toast('Article saved to Notes');
  } catch (err) {
    toast('Saved the link, but could not read the article', null, 8000);
  }
}
window.receiveShare = receiveShare;

// Chrome's "install app" share target sends ?share=1&title=…&text=…&url=…
(() => {
  const p = new URLSearchParams(location.search);
  if (!p.has('share')) return;
  history.replaceState(null, '', location.pathname);
  setTimeout(() => receiveShare({ title: p.get('title') || '', text: p.get('text') || '', url: p.get('url') || '' }), 300);
})();

// Reads the Notes/*.md files the old Scriptorium app left in the repo (once) so nothing is lost.
async function importOldNotes(remote) {
  const dir = (settings.notesFolder || 'Notes').replace(/^\/+|\/+$/g, '');
  const paths = [...remote.keys()].filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.md') && !p.slice(dir.length + 1).includes('/'));
  let added = 0;
  for (const path of paths) {
    const blob = await gh(`/git/blobs/${remote.get(path)}`);
    const raw = fromBase64(blob.content);
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    const fm = {};
    for (const line of (m ? m[1] : '').split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    const id = fm.id || `import-${path}`;
    if (find(data.notes, id)) continue;
    let tags = [];
    try { tags = JSON.parse(fm.tags || '[]'); } catch { /* ignore */ }
    const created = Date.parse(fm.created) || Date.now();
    data.notes.push(newNote((m ? m[2] : raw).replace(/\n+$/, ''), { id, tags, file: path, created, updated: Date.parse(fm.updated) || created }));
    added++;
  }
  return added;
}

// A task's linked note: opens in the Notes tab (or the old Scriptorium app if it never made it across).
function noteChip(link) {
  const live = find(data.notes, link.id);
  return el('a', {
    class: 'note-chip', href: live ? '#' : noteUrl(link.id), target: live ? null : '_blank', rel: 'noopener', title: 'Open the note',
    onclick: live ? (e) => { e.preventDefault(); openNote(link.id); } : null,
  }, `📝 ${live ? noteTitle(live) : link.title}`);
}

// Notes → markdown files. Renamed or deleted notes leave their old file behind in `staleNoteFiles` for the sync to remove.
let staleNoteFiles = [];
function noteFiles() {
  const dir = (settings.notesFolder || 'Notes').replace(/^\/+|\/+$/g, '');
  const files = {};
  staleNoteFiles = [];
  for (const n of [...data.notes].sort((a, b) => a.created - b.created)) {
    if (n.removed) {
      if (n.file) { staleNoteFiles.push(n.file); n.file = null; }
      continue;
    }
    let path = `${dir}/${fileSafe(noteTitle(n))}.md`;
    for (let i = 2; path in files; i++) path = `${dir}/${fileSafe(noteTitle(n))} (${i}).md`;
    if (n.file && n.file !== path) staleNoteFiles.push(n.file);
    n.file = path;
    const head = ['---', `id: ${n.id}`, `created: ${new Date(n.created).toISOString()}`, `updated: ${new Date(n.updated).toISOString()}`];
    if ((n.tags || []).length) head.push(`tags: ${JSON.stringify(n.tags)}`);
    if (n.src) head.push(`source: ${n.src}`);
    head.push('---');
    files[path] = `${head.join('\n')}\n${(n.text || '').replace(/\s+$/, '')}\n`;
  }
  return files;
}

/* ---------- albums ---------- */

const DUST_DAYS = 14;
const kindOf = (a) => a.kind || 'album';
const KIND = {
  album: { one: 'album', icon: '🎵', folder: 'Albums', title: 'Albums' },
  project: { one: 'project', icon: '🛠️', folder: 'Projects', title: 'Projects' },
};
const byAlbumOrder = (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.created - b.created;
const activeOf = (kind) => data.albums.filter((a) => !a.finishedAt && kindOf(a) === kind).sort(byAlbumOrder);
const activeAlbums = () => activeOf('album');
const activeAll = () => data.albums.filter((a) => !a.finishedAt).sort(byAlbumOrder);
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

// The 💤 reminder on Today: swiping it away hides it until another DUST_DAYS days have passed.
function dustAlert(a) {
  const n = dustDays(a);
  if (!n || !a.dustSnoozed) return n;
  return daysBetween(a.dustSnoozed, dayKey()) >= DUST_DAYS ? n : 0;
}
function dismissDust(id) {
  const a = find(data.albums, id);
  touch(a, { dustSnoozed: dayKey() });
  change();
  toast(`Hid “${a.name}” — it'll nudge you again in ${DUST_DAYS} days`, () => { touch(a, { dustSnoozed: null }); change(); });
}

function addAlbum(name, kind = 'album') {
  const now = Date.now();
  const order = data.albums.reduce((m, a) => Math.max(m, a.order || 0), 0) + 1;
  data.albums.push({ id: uid(), name, kind, order, created: now, createdDay: dayKey(), finishedAt: null, finishedDay: null, updated: now });
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
  if (finished) {
    toast(`Finished “${a.name}” 🎉 — moved to the Archive`, () => setAlbumFinished(id, false));
    celebrate(`🏁 “${a.name}” is finished!`, { pop: false });
  }
  else toast(`Reopened “${a.name}”`);
}
// Working on an album or project moves it to the top of its list.
function bumpAlbum(id) {
  const a = find(data.albums, id);
  if (!a || a.finishedAt) return;
  const top = data.albums.reduce((m, x) => Math.min(m, x.order ?? 0), 0);
  if (activeAll()[0] === a) return;
  touch(a, { order: top - 1 });
}
function logSession(albumId, day, note, habitId) {
  const now = Date.now();
  data.sessions.push({ id: uid(), albumId, day, at: now, note, habitId: habitId || null, removed: false, updated: now });
  if (day === dayKey()) bumpAlbum(albumId);
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
  const t = { id: uid(), text, buy: true, ...parseWhen(when), cost, order: now, created: now, doneAt: null, doneDay: null, updated: now };
  data.tasks.push(t);
  change();
  return t;
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
    notes: mergeById(local.notes, remote.notes, newer),
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
  const notes = noteFiles(); // first: it records where each note's file went, which data.json carries
  const files = {
    [repoPath('data.json')]: JSON.stringify(data, null, 2) + '\n',
    [repoPath('Todo.md')]: todoMarkdown(),
    ...notes,
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
    const before = JSON.stringify(data);
    data = mergeData(data, normalize(JSON.parse(fromBase64(blob.content))));
    if (JSON.stringify(data) !== before) {
      store.set('data', data);
      render();
    }
  }

  if (!store.get('notesImported', false)) {
    const added = await importOldNotes(remote);
    store.set('notesImported', true);
    if (added) { store.set('data', data); render(); }
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

  for (const path of staleNoteFiles) {
    if (remote.has(path) && !(path in files)) changes.push({ path, mode: '100644', type: 'blob', sha: null });
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

// A tap that lands while the screen is being rebuilt gets lost, so wait until the finger is up.
let pointerDownAt = 0;
addEventListener('pointerdown', () => { pointerDownAt = Date.now(); }, true);
const pointerUp = () => {
  pointerDownAt = 0;
  if (renderPending) setTimeout(() => { if (!pointerDownAt) render(); }, 80);
};
addEventListener('pointerup', pointerUp, true);
addEventListener('pointercancel', pointerUp, true);
const fingerDown = () => pointerDownAt && Date.now() - pointerDownAt < 3000;

function render() {
  if (dragging || fingerDown()) { renderPending = true; return; }
  if (document.activeElement && document.activeElement.matches('.text, .cost, .limit-amount, .note-text')) {
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
  renderNotes();
  syncReminders();
}

/* ---------- reminders (ring the phone through the Android app) ---------- */

let remindersSent = '';
// The Android app keeps one alarm per upcoming reminder; give it the whole list whenever it changes.
function syncReminders() {
  const bridge = window.AndroidApp;
  if (!bridge || !bridge.setReminders) return;
  const since = Date.now() - 864e5;
  const list = data.tasks.filter((t) => t.remind && !t.doneAt && t.remind > since)
    .map((t) => ({ id: t.id, at: t.remind, title: t.text, loud: !!t.remindLoud }));
  const json = JSON.stringify(list);
  if (json === remindersSent) return;
  remindersSent = json;
  try { bridge.setReminders(json); } catch { /* the app is older than reminders */ }
}
function remindText(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = daysBetween(dayKey(), dayKey(d));
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${time}`;
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${time}`;
}
const localInput = (ms) => { const d = new Date(ms); return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function setReminder(id, at, loud) {
  const t = find(data.tasks, id);
  touch(t, { remind: at, remindLoud: loud ?? !!t.remindLoud });
  change();
  const bridge = window.AndroidApp;
  if (bridge && bridge.reminderStatus && bridge.reminderStatus() === 'notifications-off') bridge.requestNotifications();
}
function clearReminder(id) {
  touch(find(data.tasks, id), { remind: null, remindLoud: false });
  change();
}
// In a browser (no Android app) a reminder can only show while the app is open.
const shownReminders = new Set();
setInterval(() => {
  if (window.AndroidApp && window.AndroidApp.setReminders) return;
  const now = Date.now();
  for (const t of data.tasks) {
    if (!t.remind || t.doneAt || t.remind > now || now - t.remind > 5 * 60000 || shownReminders.has(t.id + t.remind)) continue;
    shownReminders.add(t.id + t.remind);
    toast(`⏰ ${t.text}`, null, 30000);
  }
}, 15000);

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
      t.note ? noteChip(t.note) : null,
      t.remind ? el('button', {
        class: `remind-chip${t.remind < Date.now() ? ' over' : ''}`, type: 'button', title: 'Change the reminder', onclick: () => openTaskDialog(t.id),
      }, `⏰ ${remindText(t.remind)}`) : null),
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
  const dusty = activeAll().map((a) => [a, dustAlert(a)]).filter(([, n]) => n);
  $('#dust').hidden = !dusty.length;
  fill($('#dust'), dusty.map(([a, n]) => {
    const row = el('div', { class: 'dust-row' },
      el('button', { class: 'dust', type: 'button', title: 'Swipe away to hide it for now', onclick: () => showView(kindOf(a) === 'album' ? 'albums' : 'projects') },
        `💤 ${a.name} — untouched for ${n} days`),
      el('button', { class: 'x', type: 'button', 'aria-label': `Hide the reminder for ${a.name}`, onclick: () => dismissDust(a.id) }, '×'));
    swipeAway(row, () => dismissDust(a.id));
    return row;
  }));
}

// Drag a row sideways far enough and it slides off; a short drag springs back. Vertical drags still scroll.
function swipeAway(row, onGone) {
  let start = null;
  let swiping = false;
  row.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.x') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    swiping = false;
  });
  row.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!swiping) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { start = null; return; }
      if (Math.abs(dx) < 8) return;
      swiping = true;
      row.setPointerCapture(e.pointerId);
      row.style.transition = 'none';
    }
    row.style.transform = `translateX(${dx}px)`;
    row.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / (row.offsetWidth * 1.1)));
  });
  const finish = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const was = swiping;
    start = null;
    swiping = false;
    if (!was) return;
    row.style.transition = 'transform 0.2s, opacity 0.2s';
    if (e.type === 'pointerup' && Math.abs(dx) > Math.max(80, row.offsetWidth * 0.3)) {
      row.style.transform = `translateX(${dx > 0 ? '110%' : '-110%'})`;
      row.style.opacity = '0';
      setTimeout(onGone, 200);
    } else {
      row.style.transform = '';
      row.style.opacity = '';
    }
  };
  row.addEventListener('pointerup', finish);
  row.addEventListener('pointercancel', finish);
  // A drag that ends on the button shouldn't also count as a tap on it.
  row.addEventListener('click', (e) => { if (Math.abs(e.clientX - (row._downX ?? e.clientX)) > 8) e.stopPropagation(); }, true);
  row.addEventListener('pointerdown', (e) => { row._downX = e.clientX; });
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
    bindAdd(form, (text) => { refocusAlbum = a.id; addTaskSmart(text, a.id); });
    if (refocusAlbum === a.id) { refocusAlbum = null; focusAfter = form.text; }
    return el('section', { class: `card album${dust ? ' dusty' : ''}`, 'data-id': a.id },
      el('div', { class: 'card-head' },
        el('span', { class: 'grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⋮⋮'),
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

function openSessionDialog({ habitId = null, albumId = null, day, note = '' }) {
  sessionContext = { habitId, day, fixed: !!albumId };
  sessionAlbum = albumId;
  const h = habitId && find(data.habits, habitId);
  $('#session-title').textContent = albumId ? `Log a session · ${albumName(albumId)}` : 'Which album?';
  $('#session-sub').textContent = `${h ? `${h.text} · ` : ''}${dayLabel(day) || longDate(day)}`;
  $('#session-form').note.value = note;
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
let remindPicking = false;

function openTaskDialog(id) {
  taskDialogId = id;
  notePicking = false;
  remindPicking = false;
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
  renderRemindPicker(t);
}
function renderRemindPicker(t) {
  const box = $('#task-remind');
  const bridge = window.AndroidApp;
  const status = bridge && bridge.reminderStatus ? bridge.reminderStatus() : null;
  const pick = (ms) => { setReminder(t.id, ms); remindPicking = false; renderTaskDialog(); };
  const hint = !bridge
    ? el('p', { class: 'hint' }, 'Rings your phone in the Android app. In a browser it only shows while this page is open.')
    : !bridge.setReminders
      ? el('p', { class: 'hint' }, 'Update the Android app to make your phone ring: ', el('a', { href: 'daily.apk', download: '' }, 'get the new version'), '.')
      : status === 'notifications-off'
        ? el('p', { class: 'hint warn' }, 'Notifications are off for Daily. ', el('button', { class: 'link', type: 'button', onclick: () => bridge.requestNotifications() }, 'Allow them'))
        : status === 'exact-off'
          ? el('p', { class: 'hint warn' }, 'Android may ring a few minutes late until you allow alarms. ', el('button', { class: 'link', type: 'button', onclick: () => bridge.openAlarmSettings() }, 'Allow alarms'))
          : null;
  if (t.remind && !remindPicking) {
    fill(box, el('div', { class: 'note-row' },
      el('span', { class: `remind-chip${t.remind < Date.now() ? ' over' : ''}` }, `⏰ ${remindText(t.remind)}`),
      el('button', { class: 'small-btn', type: 'button', onclick: () => { remindPicking = true; renderRemindPicker(t); } }, 'Change'),
      el('button', { class: 'small-btn', type: 'button', onclick: () => { clearReminder(t.id); renderTaskDialog(); } }, 'Remove'),
      el('button', {
        class: `small-btn${t.remindLoud ? ' on' : ''}`, type: 'button', 'aria-pressed': String(!!t.remindLoud),
        title: 'Ring like an alarm instead of a normal notification', onclick: () => { setReminder(t.id, t.remind, !t.remindLoud); renderTaskDialog(); },
      }, '🚨 Ring like an alarm')), hint);
    return;
  }
  if (!remindPicking) {
    fill(box, el('button', { class: 'small-btn', type: 'button', onclick: () => { remindPicking = true; renderRemindPicker(t); } }, '⏰ Remind me…'), hint);
    return;
  }
  const at = (days, hour) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.getTime(); };
  const soon = Date.now() + 3600000;
  const input = el('input', { type: 'datetime-local', class: 'remind-input', value: localInput(Math.ceil(soon / 900000) * 900000), 'aria-label': 'Day and time' });
  const countInput = el('input', { type: 'number', min: '1', max: '365', inputmode: 'numeric', value: '3', class: 'remind-count', 'aria-label': 'How many' });
  const unitSelect = el('select', { 'aria-label': 'Days, weeks or months' }, el('option', { value: 'day' }, 'days'), el('option', { value: 'week' }, 'weeks'), el('option', { value: 'month' }, 'months'));
  fill(box,
    el('div', { class: 'chips' },
      el('button', { class: 'chip', type: 'button', onclick: () => pick(Date.now() + 3600000) }, 'In 1 hour'),
      new Date().getHours() < 17 ? el('button', { class: 'chip', type: 'button', onclick: () => pick(at(0, 18)) }, 'This evening') : null,
      el('button', { class: 'chip', type: 'button', onclick: () => pick(at(1, 9)) }, 'Tomorrow 9 AM'),
      el('button', { class: 'chip', type: 'button', onclick: () => pick(fromNow(1, 'week')) }, 'Next week'),
      el('button', { class: 'chip', type: 'button', onclick: () => pick(fromNow(2, 'week')) }, 'In 2 weeks'),
      el('button', { class: 'chip', type: 'button', onclick: () => pick(fromNow(1, 'month')) }, 'In a month')),
    el('div', { class: 'add in-n' }, el('span', { class: 'in-label' }, 'In'), countInput, unitSelect,
      el('button', {
        type: 'button', 'aria-label': 'Set reminder after this long',
        onclick: () => { const n = parseInt(countInput.value, 10); if (n > 0) pick(fromNow(n, unitSelect.value)); },
      }, '✓')),
    el('div', { class: 'add' }, input,
      el('button', {
        type: 'button', 'aria-label': 'Set reminder',
        onclick: () => { const ms = new Date(input.value).getTime(); if (!ms) return; pick(ms); },
      }, '✓')),
    t.remind ? el('button', { class: 'link', type: 'button', onclick: () => { remindPicking = false; renderRemindPicker(t); } }, 'Cancel') : null,
    hint);
}
function renderNotePicker(t) {
  const box = $('#task-note');
  if (t.note && !notePicking) {
    fill(box, el('div', { class: 'note-row' },
      noteChip(t.note),
      el('button', { class: 'small-btn', type: 'button', onclick: () => { notePicking = true; renderNotePicker(t); } }, 'Change'),
      el('button', { class: 'small-btn', type: 'button', onclick: () => { touch(t, { note: null }); change(); renderTaskDialog(); } }, 'Remove')));
    return;
  }
  if (!notePicking) {
    fill(box, el('button', { class: 'small-btn', type: 'button', onclick: () => { notePicking = true; renderNotePicker(t); } }, '📝 Link a note…'));
    return;
  }
  const input = el('input', { class: 'note-search', placeholder: 'Search your notes', autocomplete: 'off', 'aria-label': 'Search notes' });
  const list = el('ul', { class: 'list plain note-results' });
  const draw = () => {
    const q = clean(input.value).toLowerCase();
    const hits = liveNotes().filter((n) => !q || noteTitle(n).toLowerCase().includes(q)).slice(0, 30);
    fill(list, hits.length ? hits.map((n) => el('li', { class: 'item' },
      el('button', { class: 'note-pick', type: 'button', onclick: () => { touch(t, { note: { id: n.id, title: noteTitle(n) } }); notePicking = false; change(); renderTaskDialog(); } }, `📝 ${noteTitle(n)}`)))
      : el('li', { class: 'empty' }, q ? 'No matching notes.' : 'No notes yet. Add one in the Notes tab.'));
  };
  input.addEventListener('input', draw);
  fill(box, input, list);
  draw();
  input.focus();
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
    const item = grip.closest('li, .album');
    // Nested lists (steps inside an album, subtasks inside a task) have their own handler.
    if (!item || item.parentElement !== list) return;
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
function toast(text, undo, ms = 5000, label = 'Undo') {
  $('#toast-text').textContent = text;
  $('#toast-undo').textContent = label;
  toastUndo = undo;
  $('#toast-undo').hidden = !undo;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; toastUndo = null; }, ms);
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
bindAdd($('#add-task'), (text) => { addTaskSmart(text, null, { cat: todoFilter }); $('#task-hint').hidden = true; });
// Show what it understood as you type, so you can see the reminder before adding.
$('#add-task').text.addEventListener('input', () => {
  const b = parseBuy($('#add-task').text.value);
  if (b) { $('#task-hint').hidden = false; $('#task-hint').textContent = `🛒 Goes to To buy · Someday: “${b.text}” ${money(b.cost)}`; return; }
  const r = parseReminder($('#add-task').text.value);
  const v = !r && parseVagueWhen($('#add-task').text.value);
  if (v) { $('#task-hint').hidden = false; $('#task-hint').textContent = `⏰ I'll offer a reminder in ${v.label}`; return; }
  $('#task-hint').hidden = !r;
  if (r) $('#task-hint').textContent = `⏰ Reminder: ${remindText(r.at)} — “${r.text}”`;
});
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
enableDrag($('#albums'), (ids) => reorder(data.albums, ids));
enableDrag($('#projects'), (ids) => reorder(data.albums, ids));

$('#backfill-day').addEventListener('change', (e) => {
  if (e.target.value && e.target.value <= dayKey()) { backfillDay = e.target.value; renderBackfill(); }
});
$('#edit-habits').addEventListener('click', () => { editingHabits = !editingHabits; render(); });

document.addEventListener('focusout', (e) => {
  if (e.target.matches && e.target.matches('.text, .cost, .limit-amount, .note-text') && renderPending) setTimeout(render);
});

const VIEWS = { today: 'Today', notes: 'Notes', albums: 'Albums', projects: 'Projects', buy: 'To buy', archive: 'Archive', symptoms: 'Symptoms' };
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
  if (openNoteId) { closeNote(); return true; }
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
  addTaskSmart(text, t.albumId || null, { parentId: t.id, cat: t.cat || null });
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
