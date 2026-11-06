// Batcave — Cloudflare Worker: password-protected JSON API + static Ops Console UI.
// Personal settings (name, time zone, assistant name…) come from wrangler.jsonc vars via src/config.js.
import { expandEvents, parseICS } from './calendar.js';
import { chat, processTodo } from './chat.js';
import { cfg, loadConfig, publicConfig, validTz, withUser } from './config.js';
import { GoogleError, callback as googleCallback, cancelEvent, connect as googleConnect, createEvent, disconnect as googleDisconnect, getEvent, googleEvents, googleState, listCalendars, restoreEvent, setCalendarShown, syncCalendars, updateEvent } from './google.js';
import { authConfigured, checkPassword, clearFailures, clearSessionCookie, hashPassword, lockedOut, loginPage, makeSessionCookie, recordFailure, safeNext, sessionUser, signupPage } from './auth.js';
import { userDB, userStub } from './userdb.js';
export { UserDB } from './userdb.js';
import { summarizePending, transcriptsApi, transcriptsIngest } from './transcripts.js';
import { weather } from './weather.js';


// ---------- helpers ----------
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const plain = (text, status = 200) => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
const newId = () => crypto.randomUUID().replace(/-/g, '');

// Wall-clock date and time in the owner's time zone (TIMEZONE).
export function localNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t).value;
  const hh = g('hour') === '24' ? '00' : g('hour');
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${hh}:${g('minute')}` };
}
export const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isDue = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s);
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

// ---------- ingest token (Pi webhook server) ----------
async function verifyIngest(req, env) {
  const t = env.INGEST_TOKEN;
  const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!t || !got || t.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < t.length; i++) diff |= t.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// ---------- wake-up times ----------
// Kept in meta as wake:default, wake:dow:<0-6, Sunday = 0> and wake:<YYYY-MM-DD>.
// A day uses its own time, else its weekday's, else the default.
const WAKE_FALLBACK = '07:00';
const isHHMM = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const dowOf = (day) => new Date(day + 'T12:00:00Z').getUTCDay();
async function wakeConfig(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM meta WHERE key LIKE 'wake:%'").all();
  const cfg = { default: WAKE_FALLBACK, weekdays: {}, days: {} };
  for (const r of results) {
    const k = r.key.slice(5);
    if (!isHHMM(r.value)) continue;
    if (k === 'default') cfg.default = r.value;
    else if (/^dow:[0-6]$/.test(k)) cfg.weekdays[k.slice(4)] = r.value;
    else if (isDay(k)) cfg.days[k] = r.value;
  }
  return cfg;
}
export function wakeFor(cfg, day) {
  if (cfg.days[day]) return { time: cfg.days[day], from: 'day' };
  const w = cfg.weekdays[dowOf(day)];
  return w ? { time: w, from: 'weekday' } : { time: cfg.default, from: 'default' };
}
// changes: [{ key: 'default' | 'dow:0'..'dow:6' | 'YYYY-MM-DD', time: 'HH:MM' or null to remove }]
async function setWake(env, changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 20) return bad('send {"changes": [{"key", "time"}]}');
  const stmts = [];
  for (const c of changes) {
    const key = String(c?.key || '');
    if (!(key === 'default' || /^dow:[0-6]$/.test(key) || isDay(key))) return bad(`unknown wake key "${key}"`);
    if (c.time == null || c.time === '') {
      if (key === 'default') return bad('the default wake-up time can be changed but not removed');
      stmts.push(env.DB.prepare('DELETE FROM meta WHERE key = ?1').bind('wake:' + key));
    } else if (isHHMM(c.time)) {
      stmts.push(env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('wake:' + key, c.time));
    } else return bad('time must be HH:MM');
  }
  // One-day times are forgotten two weeks after the day.
  stmts.push(env.DB.prepare("DELETE FROM meta WHERE key GLOB 'wake:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(key, 6) < ?1").bind(addDays(localNow().date, -14)));
  await env.DB.batch(stmts);
  return json(await wakeConfig(env));
}

// ---------- task classification ----------
function bucket(t, today) {
  if (t.date_tbd) return 'tbd';
  if (!t.due_at) return 'nodate';
  const day = t.due_at.slice(0, 10);
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  if (day <= addDays(today, 7)) return 'soon';
  return 'later';
}
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);

async function openTasks(env) {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.project_id, t.kind, t.due_at, t.date_tbd, t.url, t.notes, COALESCE(p.short_name, p.name, 'Other') AS project, p.color AS project_color
     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.status = 'open' ORDER BY t.due_at IS NULL, t.due_at`
  ).all();
  return results;
}

// ---------- API: dashboard ----------
async function dashboard(env) {
  const now = localNow();
  const today = now.date;
  const yesterday = addDays(today, -1);
  const all = await openTasks(env);
  const tasks = all.filter((t) => t.kind === 'task');
  const inbox = all.filter((t) => t.kind === 'inbox');
  const k = { overdue: 0, today: 0, soon: 0, later: 0, tbd: 0, nodate: 0 };
  for (const t of tasks) { t.bucket = bucket(t, today); k[t.bucket]++; }
  const overdueYesterday = tasks.filter((t) => t.due_at && !t.date_tbd && t.due_at.slice(0, 10) < yesterday).length;
  const overdue = tasks.filter((t) => t.bucket === 'overdue').sort((a, b) => a.due_at.localeCompare(b.due_at));
  const soon = tasks.filter((t) => t.bucket === 'soon').sort((a, b) => a.due_at.localeCompare(b.due_at));
  const dueToday = tasks.filter((t) => t.bucket === 'today');
  const focus = [...dueToday, ...overdue.slice().reverse(), ...soon].slice(0, 3).map((t) => ({ ...t, days: t.due_at ? daysBetween(today, t.due_at.slice(0, 10)) : null }));

  const { results: projects } = await env.DB.prepare('SELECT id, name, short_name, status, color, sort FROM projects WHERE archived = 0 ORDER BY sort').all();
  for (const p of projects) {
    const mine = tasks.filter((t) => t.project_id === p.id);
    p.open = mine.length;
    p.overdue = mine.filter((t) => t.bucket === 'overdue').length;
    p.soon = mine.filter((t) => t.bucket === 'today' || t.bucket === 'soon').length;
    p.later = mine.filter((t) => t.bucket === 'later').length;
    p.tbd = mine.filter((t) => t.bucket === 'tbd' || t.bucket === 'nodate').length;
    const next = mine.filter((t) => t.bucket === 'today' || t.bucket === 'soon' || t.bucket === 'later').sort((a, b) => a.due_at.localeCompare(b.due_at))[0];
    p.next = next ? { title: next.title, due_at: next.due_at, days: daysBetween(today, next.due_at.slice(0, 10)) } : null;
  }

  const ws = weekStartOf(today);
  const { results: allHabits } = await env.DB.prepare(
    `SELECT h.id, h.name, h.cadence,
            EXISTS (SELECT 1 FROM habit_checks c WHERE c.habit_id = h.id AND c.day = ?1) AS done,
            (SELECT MAX(c.day) FROM habit_checks c WHERE c.habit_id = h.id AND c.day BETWEEN ?2 AND ?3) AS week_day
     FROM habits h WHERE h.active = 1 ORDER BY h.sort`
  ).bind(today, ws, addDays(ws, 6)).all();
  const habits = allHabits.filter((h) => h.cadence !== 'weekly').map((h) => ({ id: h.id, name: h.name, done: h.done }));
  const weekly = allHabits.filter((h) => h.cadence === 'weekly').map((h) => ({ id: h.id, name: h.name, done: h.week_day ? 1 : 0, done_day: h.week_day || null }));
  const { results: vehicles } = await env.DB.prepare('SELECT id, name, plate, mileage FROM vehicles ORDER BY name').all();
  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM wishlist WHERE status NOT IN ('Bought','Gave up')) AS wishlist_open`
  ).first();
  const slim = (t) => ({ id: t.id, title: t.title, project: t.project, due_at: t.due_at, date_tbd: t.date_tbd, days: daysBetween(today, t.due_at.slice(0, 10)) });
  const layoutRow = await env.DB.prepare("SELECT value FROM meta WHERE key = 'home:layout'").first();

  return {
    now, kpis: { ...k, due: k.overdue + k.today, overdueDelta: k.overdue - overdueYesterday, inbox: inbox.length },
    oldestOverdue: overdue[0] ? { title: overdue[0].title, project: overdue[0].project, days: daysBetween(overdue[0].due_at.slice(0, 10), today) } : null,
    nextSoon: soon[0] ? { title: soon[0].title, due_at: soon[0].due_at } : null,
    focus, projects: projects.filter((p) => p.open > 0), allProjects: projects, habits, weekly, weekStart: ws, vehicles, counts,
    due: { overdue: overdue.slice(0, 8).map(slim), today: dueToday.slice(0, 8).map(slim), soon: soon.slice(0, 8).map(slim) },
    layout: cleanLayout(safeJson(layoutRow?.value)),
  };
}

// ---------- API: home screen layout (widget order and sizes) ----------
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
// A list of { id, size } in screen order; the browser knows which widget ids exist and drops unknown ones.
function cleanLayout(v) {
  if (!Array.isArray(v) || v.length > 40) return null;
  const out = [];
  for (const w of v) {
    if (!w || typeof w.id !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(w.id) || !['s', 'm', 'l'].includes(w.size)) return null;
    out.push({ id: w.id, size: w.size });
  }
  return out;
}
async function saveLayout(env, b) {
  if (b.layout === null) { await env.DB.prepare("DELETE FROM meta WHERE key = 'home:layout'").run(); return json({ ok: true }); }
  const layout = cleanLayout(b.layout);
  if (!layout) return bad('layout must be a list of { id, size } with size s, m or l');
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('home:layout', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(layout)).run();
  return json({ ok: true });
}

// ---------- API: calendar ----------
let icsCache = { url: null, at: 0, events: null };
async function calendarSource(env) {
  if (env.GCAL_ICS_URL) {
    if (icsCache.url === env.GCAL_ICS_URL && icsCache.events && Date.now() - icsCache.at < 10 * 60e3) return icsCache.events;
    try {
      const r = await fetch(env.GCAL_ICS_URL, { cf: { cacheTtl: 300 } });
      if (r.ok) {
        const events = parseICS(await r.text(), cfg.tz);
        icsCache = { url: env.GCAL_ICS_URL, at: Date.now(), events };
        return events;
      }
    } catch { /* fall back to stored events */ }
  }
  const { results } = await env.DB.prepare('SELECT id, title, starts_at, ends_at, all_day, rrule, location, color_key FROM events').all();
  return results.map((e) => ({ ...e, exdates: [], overrides: [] }));
}
async function events(env, url) {
  const today = localNow().date;
  let start = url.searchParams.get('start');
  if (!isDay(start)) { const dow = new Date(today + 'T00:00:00Z').getUTCDay(); start = addDays(today, -dow); }
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 42);
  const end = addDays(start, days);
  const google = await googleState(env);
  let evs = null, source = 'stored', calendarError = null;
  if (google.connected) {
    try { evs = await googleEvents(env, start, end, { fresh: url.searchParams.get('fresh') === '1' }); source = 'google'; }
    catch (e) { console.error('google events', e.message); calendarError = e.message; }
  }
  if (!evs) evs = expandEvents(await calendarSource(env), start, end);
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.due_at, t.notes, COALESCE(p.short_name, p.name, 'Other') AS project FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.status = 'open' AND t.kind = 'task' AND t.date_tbd = 0 AND t.due_at IS NOT NULL AND substr(t.due_at,1,10) >= ?1 AND substr(t.due_at,1,10) < ?2
     ORDER BY t.due_at`
  ).bind(start, end).all();
  const deadlines = results.map((t) => ({ ...t, day: t.due_at.slice(0, 10), state: t.due_at.slice(0, 10) < today ? 'overdue' : t.due_at.slice(0, 10) === today ? 'today' : 'upcoming' }));
  const wcfg = await wakeConfig(env);
  const wake = {};
  for (let d = start; d < end; d = addDays(d, 1)) wake[d] = wakeFor(wcfg, d);
  return { start, end, today, now: localNow().time, events: evs, deadlines, wake, wakeDefaults: { default: wcfg.default, weekdays: wcfg.weekdays }, source, calendarError, google: { configured: google.configured, connected: google.connected, needsReconnect: !!google.needsReconnect } };
}

// ---------- API: tasks ----------
async function listTasks(env, url) {
  const today = localNow().date;
  const view = url.searchParams.get('view') || 'open';
  const project = url.searchParams.get('project');
  let rows = await openTasks(env);
  if (view === 'inbox') rows = rows.filter((t) => t.kind === 'inbox');
  else rows = rows.filter((t) => t.kind === 'task');
  if (project) rows = rows.filter((t) => t.project_id === project);
  for (const t of rows) { t.bucket = bucket(t, today); t.days = t.due_at ? daysBetween(today, t.due_at.slice(0, 10)) : null; }
  if (['overdue', 'today', 'soon', 'later', 'tbd', 'nodate'].includes(view)) rows = rows.filter((t) => t.bucket === view);
  if (url.searchParams.get('include') === 'done') {
    const { results } = await env.DB.prepare(`SELECT t.*, COALESCE(p.short_name, p.name, 'Other') AS project FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.status = 'done' ${project ? 'AND t.project_id = ?1' : ''} ORDER BY t.done_at DESC LIMIT 50`).bind(...(project ? [project] : [])).all();
    return { today, tasks: rows, done: results };
  }
  return { today, tasks: rows };
}
async function createTask(env, b, kind = 'task') {
  const title = str(b.title, 300);
  if (!title) return bad('title is required');
  if (b.due_at && !isDue(b.due_at)) return bad('due_at must be YYYY-MM-DD or YYYY-MM-DDTHH:MM');
  const id = newId();
  await env.DB.prepare('INSERT INTO tasks (id, title, project_id, kind, due_at, url, notes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(id, title, b.project_id || null, b.kind === 'inbox' ? 'inbox' : kind, b.due_at || null, str(b.url, 2000) || null, str(b.notes, 4000) || null).run();
  return json({ id }, 201);
}
async function updateTask(env, id, b) {
  const sets = [], vals = [];
  const add = (col, v) => { sets.push(`${col} = ?${vals.length + 1}`); vals.push(v); };
  if ('title' in b) { const t = str(b.title, 300); if (!t) return bad('title cannot be empty'); add('title', t); }
  if ('due_at' in b) { if (b.due_at && !isDue(b.due_at)) return bad('bad due_at'); add('due_at', b.due_at || null); add('date_tbd', 0); }
  if ('project_id' in b) add('project_id', b.project_id || null);
  if ('notes' in b) add('notes', str(b.notes, 4000) || null);
  if ('kind' in b && ['task', 'inbox'].includes(b.kind)) add('kind', b.kind);
  if ('status' in b) {
    if (!['open', 'done', 'cancelled'].includes(b.status)) return bad('bad status');
    add('status', b.status); add('done_at', b.status === 'done' ? new Date().toISOString() : null);
  }
  if (!sets.length) return bad('nothing to update');
  add('updated_at', new Date().toISOString());
  const r = await env.DB.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?${vals.length + 1}`).bind(...vals, id).run();
  return r.meta.changes ? json({ ok: true }) : bad('not found', 404);
}

// ---------- API: projects ----------
async function createProject(env, b) {
  const name = str(b.name, 120);
  if (!name) return bad('name is required');
  const id = newId();
  await env.DB.prepare('INSERT INTO projects (id, name, short_name, sort) VALUES (?1, ?2, ?2, (SELECT COALESCE(MAX(sort), 0) + 1 FROM projects))').bind(id, name).run();
  return json({ id, name }, 201);
}
async function updateProject(env, id, b) {
  const sets = [], vals = [];
  if ('name' in b) {
    const name = str(b.name, 120);
    if (!name) return bad('name is required');
    vals.push(name); sets.push('name = ?1', 'short_name = ?1');
  }
  if ('archived' in b) {
    if (typeof b.archived !== 'boolean') return bad('archived must be a boolean');
    vals.push(b.archived ? 1 : 0); sets.push(`archived = ?${vals.length}`);
  }
  if (!sets.length) return bad('nothing to update');
  const r = await env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?${vals.length + 1}`).bind(...vals, id).run();
  return r.meta.changes ? json({ ok: true }) : bad('not found', 404);
}
async function projectDetail(env, id) {
  const p = await env.DB.prepare('SELECT * FROM projects WHERE id = ?1').bind(id).first();
  if (!p) return bad('not found', 404);
  const url = new URL('http://x/?view=open&include=done&project=' + encodeURIComponent(id));
  return json({ project: p, ...(await listTasks(env, url)) });
}

// ---------- API: habits ----------
// Weeks run Sunday to Saturday, like the calendar.
export const weekStartOf = (day) => addDays(day, -dowOf(day));
const CADENCES = ['daily', 'weekly'];
async function toggleHabit(env, id, b) {
  const day = isDay(b.day) ? b.day : localNow().date;
  const h = await env.DB.prepare('SELECT cadence FROM habits WHERE id = ?1').bind(id).first();
  if (!h) return bad('not found', 404);
  if (h.cadence === 'weekly') {
    // Weekly: any check this week counts. Unchecking clears the week; checking marks the given day.
    const ws = weekStartOf(day), we = addDays(ws, 6);
    const r = await env.DB.prepare('DELETE FROM habit_checks WHERE habit_id = ?1 AND day BETWEEN ?2 AND ?3').bind(id, ws, we).run();
    if (r.meta.changes) return json({ done: false });
    await env.DB.prepare('INSERT INTO habit_checks (habit_id, day) VALUES (?1, ?2)').bind(id, day).run();
    return json({ done: true, day });
  }
  const existing = await env.DB.prepare('SELECT 1 FROM habit_checks WHERE habit_id = ?1 AND day = ?2').bind(id, day).first();
  if (existing) await env.DB.prepare('DELETE FROM habit_checks WHERE habit_id = ?1 AND day = ?2').bind(id, day).run();
  else await env.DB.prepare('INSERT INTO habit_checks (habit_id, day) VALUES (?1, ?2)').bind(id, day).run();
  return json({ done: !existing });
}
// Adding a name that exists (even hidden) brings that habit back with its history.
async function createHabit(env, b) {
  const name = str(b.name, 80);
  if (!name) return bad('name is required');
  const cadence = CADENCES.includes(b.cadence) ? b.cadence : null;
  const existing = await env.DB.prepare('SELECT id, name, active, cadence FROM habits WHERE lower(name) = lower(?1)').bind(name).first();
  if (existing) {
    // Re-adding an existing name brings it back and/or switches it to the cadence asked for.
    const to = cadence || existing.cadence;
    const moved = !!existing.active && to !== existing.cadence;
    if (!existing.active || moved) await env.DB.prepare('UPDATE habits SET active = 1, cadence = ?2 WHERE id = ?1').bind(existing.id, to).run();
    return json({ id: existing.id, name: existing.name, cadence: to, restored: !existing.active, moved, existed: !!existing.active && !moved });
  }
  const id = newId();
  await env.DB.prepare('INSERT INTO habits (id, name, sort, active, cadence) VALUES (?1, ?2, (SELECT COALESCE(MAX(sort), -1) + 1 FROM habits), 1, ?3)').bind(id, name, cadence || 'daily').run();
  return json({ id, name, cadence: cadence || 'daily' }, 201);
}
async function updateHabit(env, id, b) {
  const sets = [], vals = [];
  if ('name' in b) {
    const name = str(b.name, 80);
    if (!name) return bad('name cannot be empty');
    const clash = await env.DB.prepare('SELECT 1 FROM habits WHERE lower(name) = lower(?1) AND id != ?2').bind(name, id).first();
    if (clash) return bad('another habit already has that name');
    sets.push(`name = ?${vals.push(name)}`);
  }
  if ('active' in b) sets.push(`active = ?${vals.push(b.active ? 1 : 0)}`);
  if ('cadence' in b) { if (!CADENCES.includes(b.cadence)) return bad('cadence must be daily or weekly'); sets.push(`cadence = ?${vals.push(b.cadence)}`); }
  if (!sets.length) return bad('nothing to update');
  const r = await env.DB.prepare(`UPDATE habits SET ${sets.join(', ')} WHERE id = ?${vals.length + 1}`).bind(...vals, id).run();
  return r.meta.changes ? json({ ok: true }) : bad('not found', 404);
}
async function habitHistory(env) {
  const today = localNow().date;
  const from = addDays(today, -27);
  const weekStart = weekStartOf(today), weeksFrom = addDays(weekStart, -7 * 11); // 12 weeks for weekly habits
  const { results: habits } = await env.DB.prepare('SELECT id, name, cadence FROM habits WHERE active = 1 ORDER BY sort').all();
  const { results: checks } = await env.DB.prepare('SELECT habit_id, day FROM habit_checks WHERE day >= ?1').bind(weeksFrom < from ? weeksFrom : from).all();
  return json({ today, from, weekStart, weeksFrom, habits, checks });
}

// ---------- API: Google Calendar ----------
async function googleApi(req, env, url, path, m) {
  try {
    if (path === '/api/google/connect' && m === 'GET') return googleConnect(req, env, url);
    if (path === '/api/google/callback' && m === 'GET') return await googleCallback(req, env, url);
    if (path === '/api/google/status' && m === 'GET') {
      const s = await googleState(env);
      return json({ ...s, calendars: s.connected ? await listCalendars(env) : [] });
    }
    if (path === '/api/google/sync' && m === 'POST') return json({ calendars: await syncCalendars(env) });
    if (path === '/api/google/calendars' && m === 'POST') {
      const b = await body(req);
      return (await setCalendarShown(env, String(b.id || ''), !!b.shown)) ? json({ ok: true }) : bad('not found', 404);
    }
    if (path === '/api/google/disconnect' && m === 'POST') { await googleDisconnect(env); return json({ ok: true }); }
    if (path === '/api/calendar/events' && m === 'POST') return json(await createEvent(env, await body(req)), 201);
    if (path === '/api/calendar/event' && m === 'GET') return json(await getEvent(env, { calendar_id: url.searchParams.get('calendar_id'), event_id: url.searchParams.get('event_id') }));
    if (path === '/api/calendar/events/update' && m === 'POST') return json(await updateEvent(env, await body(req)));
    if (path === '/api/calendar/events/delete' && m === 'POST') return json(await cancelEvent(env, await body(req)));
    if (path === '/api/calendar/events/restore' && m === 'POST') return json(await restoreEvent(env, await body(req)));
    return bad('not found', 404);
  } catch (e) {
    if (!(e instanceof GoogleError)) throw e;
    const status = { not_connected: 409, reauth: 409, bad_input: 400, not_found: 404 }[e.code] || 502;
    return bad(e.message, status);
  }
}

// ---------- recipes ----------
async function saveRecipe(env, b, id) {
  const limits = { name: 150, time: 80, servings: 80, description: 500, ingredients: 20000, instructions: 30000 };
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('send a recipe object');
  for (const [field, max] of Object.entries(limits)) {
    if (b[field] !== undefined && (typeof b[field] !== 'string' || b[field].length > max)) return bad(`${field} must be text, up to ${max} characters`);
  }
  if (!b.name?.trim()) return bad('name is required');
  const values = Object.keys(limits).map((key) => (b[key] || '').trim());
  if (id) {
    const result = await env.DB.prepare('UPDATE recipes SET name = ?1, time = ?2, servings = ?3, description = ?4, ingredients = ?5, instructions = ?6 WHERE id = ?7').bind(...values, id).run();
    if (!result.meta.changes) return bad('recipe not found', 404);
    return json({ id });
  }
  id = newId();
  await env.DB.prepare('INSERT INTO recipes (name, time, servings, description, ingredients, instructions, id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(...values, id).run();
  return json({ id }, 201);
}

async function deleteRecipe(env, id) {
  const result = await env.DB.prepare('DELETE FROM recipes WHERE id = ?1').bind(id).run();
  return result.meta.changes ? json({ ok: true }) : bad('recipe not found', 404);
}

// ---------- router ----------
async function api(req, env, url, ctx) {
  const m = req.method;
  const path = url.pathname.replace(/\/+$/, '');
  let match;
  if (path === '/api/weather' && m === 'GET') return weather(url, ctx);
  if (path === '/api/recipes' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM recipes ORDER BY created_at DESC, rowid DESC').all();
    return json({ recipes: results });
  }
  if (path === '/api/recipes' && m === 'POST') return saveRecipe(env, await body(req));
  if ((match = path.match(/^\/api\/recipes\/([\w-]+)$/))) {
    if (m === 'GET') {
      const recipe = await env.DB.prepare('SELECT * FROM recipes WHERE id = ?1').bind(match[1]).first();
      return recipe ? json({ recipe }) : bad('recipe not found', 404);
    }
    if (m === 'PUT') return saveRecipe(env, await body(req), match[1]);
    if (m === 'DELETE') return deleteRecipe(env, match[1]);
  }
  if (path === '/api/chat' && m === 'POST') return chat(req, env, alfredLib());
  if (path === '/api/transcripts' || path.startsWith('/api/transcripts/')) return (await transcriptsApi(req, env, url, ctx)) || bad('not found', 404);
  if (path.startsWith('/api/google/') || path.startsWith('/api/calendar/')) return googleApi(req, env, url, path, m);
  if (path === '/api/dashboard' && m === 'GET') return json(await dashboard(env));
  if (path === '/api/home/layout' && m === 'PUT') return saveLayout(env, await body(req));
  if (path === '/api/wake' && m === 'GET') return json(await wakeConfig(env));
  if (path === '/api/wake' && m === 'POST') return setWake(env, (await body(req)).changes);
  if (path === '/api/events' && m === 'GET') return json(await events(env, url));
  if (path === '/api/tasks' && m === 'GET') return json(await listTasks(env, url));
  if (path === '/api/tasks' && m === 'POST') return createTask(env, await body(req));
  if ((match = path.match(/^\/api\/tasks\/([\w-]+)$/))) {
    if (m === 'PATCH') return updateTask(env, match[1], await body(req));
    if (m === 'DELETE') { await env.DB.prepare('DELETE FROM tasks WHERE id = ?1').bind(match[1]).run(); return json({ ok: true }); }
  }
  if (path === '/api/projects' && m === 'GET') { const d = await dashboard(env); return json({ projects: d.allProjects }); }
  if (path === '/api/projects' && m === 'POST') return createProject(env, await body(req));
  if ((match = path.match(/^\/api\/projects\/([\w-]+)$/))) {
    if (m === 'GET') return projectDetail(env, match[1]);
    if (m === 'PATCH') return updateProject(env, match[1], await body(req));
  }
  if (path === '/api/habits' && m === 'GET') return habitHistory(env);
  if (path === '/api/habits' && m === 'POST') return createHabit(env, await body(req));
  if ((match = path.match(/^\/api\/habits\/([\w-]+)$/)) && m === 'PATCH') return updateHabit(env, match[1], await body(req));
  if ((match = path.match(/^\/api\/habits\/([\w-]+)\/toggle$/)) && m === 'POST') return toggleHabit(env, match[1], await body(req));
  if (path === '/api/garage' && m === 'GET') {
    const { results: vehicles } = await env.DB.prepare('SELECT * FROM vehicles ORDER BY name').all();
    const { results: logs } = await env.DB.prepare('SELECT * FROM vehicle_logs ORDER BY day DESC').all();
    return json({ vehicles, logs });
  }
  if (path === '/api/garage/logs' && m === 'POST') {
    const b = await body(req);
    if (!b.vehicle_id || !str(b.title)) return bad('vehicle_id and title are required');
    if (!['maintenance', 'ticket', 'insurance'].includes(b.kind)) return bad('kind must be maintenance, ticket or insurance');
    const id = newId();
    await env.DB.prepare('INSERT INTO vehicle_logs (id, vehicle_id, kind, day, title, cost, notes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(id, b.vehicle_id, b.kind, isDay(b.day) ? b.day : localNow().date, str(b.title, 300), Number.isFinite(+b.cost) && b.cost !== '' ? +b.cost : null, str(b.notes, 2000) || null).run();
    if (b.mileage && Number.isFinite(+b.mileage)) await env.DB.prepare('UPDATE vehicles SET mileage = ?1 WHERE id = ?2').bind(Math.round(+b.mileage), b.vehicle_id).run();
    return json({ id }, 201);
  }
  if (path === '/api/wishlist' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM wishlist ORDER BY created_at DESC').all();
    return json({ items: results });
  }
  if (path === '/api/wishlist' && m === 'POST') {
    const b = await body(req);
    const name = str(b.name, 300);
    if (!name) return bad('name is required');
    const id = newId();
    await env.DB.prepare('INSERT INTO wishlist (id, name, category, status, price, link) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(id, name, str(b.category, 60) || null, 'Searching', Number.isFinite(+b.price) && b.price !== '' ? +b.price : null, str(b.link, 2000) || null).run();
    return json({ id }, 201);
  }
  if ((match = path.match(/^\/api\/wishlist\/([\w-]+)$/)) && m === 'PATCH') {
    const b = await body(req);
    if (!['Searching', 'Waiting for discount', 'Saving money', 'Bought', 'Gave up'].includes(b.status)) return bad('bad status');
    await env.DB.prepare('UPDATE wishlist SET status = ?1, acquired_on = CASE WHEN ?1 = \'Bought\' THEN ?2 ELSE acquired_on END WHERE id = ?3').bind(b.status, localNow().date, match[1]).run();
    return json({ ok: true });
  }
  return bad('not found', 404);
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
};
const withHeaders = (res) => { const r = new Response(res.body, res); for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v); return r; };

const html = (markup, status = 200, extra = {}) => withHeaders(new Response(markup, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra } }));
const redirect = (location, extra = {}) => withHeaders(new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', ...extra } }));
const crossSite = (req, url) => { const o = req.headers.get('origin'); return Boolean(o) && o !== url.origin; };
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Public page for Google's OAuth consent screen ("privacy policy" link). Filled in from your config.
function privacyPage(host) {
  const app = escHtml(cfg.app), who = escHtml(cfg.ownerFull || cfg.owner);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${app} · Privacy</title>
<style>body{margin:0;background:#0F1012;color:#E6E6E8;font:16px/1.6 system-ui,-apple-system,sans-serif}main{max-width:680px;margin:0 auto;padding:40px 20px}h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 6px}p,li{color:#C9CBD1}a{color:#B4B7FF}</style></head>
<body><main><h1>${app} privacy policy</h1>
<p>${app} (${escHtml(host)}) is a private, password-protected personal dashboard run by ${who || 'its owner'} for themselves and a few invited friends. It is not offered to the public; each person sees only their own data.</p>
<h2>Google Calendar data</h2><ul>
<li>When the owner connects Google Calendar, ${app} reads events from the calendars the owner chooses so they appear on the dashboard, and creates, moves or cancels events only when the owner asks it to.</li>
<li>Event data is fetched on demand and held only briefly in memory to draw the page. The Google sign-in token is stored encrypted and is used only to talk to Google Calendar on the owner's behalf.</li>
<li>${app} does not sell, share, or transfer Google user data to anyone, does not use it for advertising, and does not use it to train AI models. Requests the owner types into the built-in assistant may be sent to OpenAI to generate a reply.</li>
<li>${app}'s use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</li></ul>
<h2>Disconnecting</h2><p>The owner can disconnect Google Calendar from the dashboard at any time, which revokes the token and deletes it, or remove access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>
${cfg.contact ? `<h2>Contact</h2><p>${escHtml(cfg.contact)}</p>` : ''}</main></body></html>`;
}
const PUBLIC_ASSETS = new Set(['/moon.svg', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png']);

// Home-screen app manifest, named from your config.
async function manifest(env, req) {
  const base = await (await env.ASSETS.fetch(req)).json().catch(() => ({}));
  const body = { ...base, name: cfg.app, short_name: cfg.app, description: cfg.owner ? `${cfg.owner}'s command center` : 'Personal command center' };
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' } });
}
// The app page: put your settings into the HTML before it reaches the browser (no flash of defaults).
function personalize(res) {
  if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
  // Read now: the handlers below run while the body streams, after this request's settings are gone.
  const { app, tagline } = cfg;
  const ask = `Ask ${cfg.assistant}`;
  const json = JSON.stringify(publicConfig()).replace(/</g, '\\u003c');
  const out = new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(app); } })
    .on('meta[name="apple-mobile-web-app-title"]', { element(el) { el.setAttribute('content', app); } })
    .on('[data-cfg="app"]', { element(el) { el.setInnerContent(app); } })
    .on('[data-cfg="ask"]', { element(el) { el.setInnerContent(ask); } })
    .on('[data-cfg-title="ask"]', { element(el) { el.setAttribute('title', `${ask} (/)`); } })
    .on('[data-cfg-label="ask"]', { element(el) { el.setAttribute('aria-label', ask); } })
    .on('[data-cfg="tagline"]', { element(el) { if (tagline) el.setInnerContent(tagline); else el.remove(); } })
    .on('head', { element(el) { el.append(`<script>window.__CFG=${json};</script>`, { html: true }); } })
    .transform(res);
  // The page differs per person, so it must never be served from the browser cache (an ETag would allow that).
  out.headers.set('cache-control', 'no-store');
  out.headers.delete('etag');
  return out;
}

// What Alfred's tools call into (chat window and to-do API).
const alfredLib = () => ({ dashboard, events, wakeConfig, setWake, weekStartOf, listTasks, createTask, updateTask, createProject, updateProject, saveRecipe, deleteRecipe, createHabit, updateHabit, localNow, addDays, bucket, google: { state: googleState, listCalendars, createEvent, updateEvent, cancelEvent, GoogleError } });

// POST /api/ingest/todo — JSON {text | title | name | task, notes?, due_at?, url?, source?, alfred?} or a plain-text body.
// ?format=text answers with just Alfred's sentence (handy for a phone/Mac shortcut notification).
async function ingestTodo(req, env, url) {
  const type = req.headers.get('content-type') || '';
  let b = {};
  if (type.includes('application/json')) b = await body(req);
  else { const raw = (await req.text().catch(() => '')).trim(); try { b = JSON.parse(raw); } catch { b = { text: raw }; } }
  if (!b || typeof b !== 'object') b = {};
  const command = url.pathname === '/api/ingest/alfred';
  const asText = url.searchParams.get('format') === 'text';
  const text = str(b.text ?? b.todo ?? b.title ?? b.name ?? b.task ?? b.message, 2000);
  if (!text) return asText ? plain('Send a message first.', 400) : bad('send {"text": "..."} or a plain-text body');
  if (command) {
    const res = await chat(new Request(req.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: text }] }) }), env, alfredLib());
    const data = await res.json();
    return asText ? plain(data.reply || data.error || 'Done.', res.status) : json({ handled_by: 'alfred', ...data }, res.status);
  }
  if (b.due_at && !isDue(b.due_at)) return bad('due_at must be YYYY-MM-DD or YYYY-MM-DDTHH:MM');
  const alfred = !(b.alfred === false || ['0', 'false', 'no'].includes(url.searchParams.get('alfred')));
  const r = await processTodo(env, alfredLib(), { text, notes: str(b.notes, 2000), due_at: b.due_at || null, url: str(b.url, 2000), source: str(b.source, 60), alfred });
  if (asText) return plain(r.body.reply || r.body.error || 'Done.', r.status);
  return json(r.body, r.status);
}

// ---------- accounts: sign in, sign up with an invite code ----------
const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'local';
const formOf = async (req) => { try { return await req.formData(); } catch { return null; } };

// Friends sign in with their email. Anything else is checked against the owner's password (PASSWORD_HASH).
async function login(req, env, url) {
  if (crossSite(req, url)) return bad('forbidden', 403);
  if (!authConfigured(env)) return html(loginPage({ error: 'Login is not set up yet.' }), 503);
  const ip = clientIp(req);
  if (await lockedOut(env, ip)) return html(loginPage({ error: 'Too many wrong attempts. Try again in 15 minutes.' }), 429);
  const form = await formOf(req);
  if (!form) return html(loginPage({ error: 'Something went wrong. Try again.' }), 400);
  const next = form.get('next'), email = str(form.get('email'), 200).toLowerCase(), password = String(form.get('password') || '');
  const friend = email ? await env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?1').bind(email).first() : null;
  const ok = friend ? await checkPassword(password, friend.password_hash) : await checkPassword(password, env.PASSWORD_HASH);
  if (!ok) {
    await recordFailure(env, ip);
    return html(loginPage({ error: 'Wrong email or password.', next: safeNext(next), hash: form.get('hash'), email }), 401);
  }
  await clearFailures(env, ip);
  const cookie = friend ? await makeSessionCookie(env, friend.id, friend.password_hash) : await makeSessionCookie(env);
  return redirect(safeNext(next, form.get('hash')), { 'set-cookie': cookie });
}

async function signup(req, env, url) {
  if (crossSite(req, url)) return bad('forbidden', 403);
  if (!authConfigured(env)) return html(signupPage({ error: 'Sign-up is not set up yet.' }), 503);
  const ip = clientIp(req);
  if (await lockedOut(env, ip)) return html(signupPage({ error: 'Too many wrong attempts. Try again in 15 minutes.' }), 429);
  const form = await formOf(req);
  if (!form) return html(signupPage({ error: 'Something went wrong. Try again.' }), 400);
  const code = str(form.get('code'), 40).toUpperCase(), name = str(form.get('name'), 40), email = str(form.get('email'), 200).toLowerCase();
  const password = String(form.get('password') || ''), tz = str(form.get('timezone'), 60);
  const again = (error, status = 400) => html(signupPage({ error, code, name, email }), status);
  if (!name) return again('Enter your first name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return again('Enter a valid email address.');
  if (password.length < 8 || password.length > 200) return again('Use a password of at least 8 characters.');
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?1').bind(email).first()) return again('There is already an account with that email. Sign in instead.', 409);
  const hash = await hashPassword(password);
  // One transaction: the account is only created if the code is still unused, and the code is used up with it.
  const [made] = await env.DB.batch([
    env.DB.prepare('INSERT INTO users (email, password_hash, name, timezone) SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM invites WHERE code = ?5 AND used_at IS NULL)')
      .bind(email, hash, name, validTz(tz) && tz ? tz : cfg.tz, code),
    env.DB.prepare("UPDATE invites SET used_by = (SELECT id FROM users WHERE email = ?1), used_at = datetime('now') WHERE code = ?2 AND used_at IS NULL").bind(email, code),
  ]);
  if (!made.meta.changes) { await recordFailure(env, ip); return again('That invite code is not valid or was already used.', 403); }
  const user = await env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?1').bind(email).first();
  return redirect('/', { 'set-cookie': await makeSessionCookie(env, user.id, user.password_hash) });
}

// A friend's own settings (name, time zone, password). The owner's come from wrangler.jsonc.
async function account(req, env, user) {
  if (!user.id) return bad('the owner\'s settings are in wrangler.jsonc', 400);
  if (req.method === 'GET') return json({ email: user.email, name: user.name, timezone: user.timezone });
  if (req.method !== 'PATCH') return bad('not found', 404);
  const b = await body(req);
  const sets = [], vals = [];
  if ('name' in b) { const n = str(b.name, 40); if (!n) return bad('name cannot be empty'); sets.push(`name = ?${vals.push(n)}`); }
  if ('timezone' in b) { if (typeof b.timezone !== 'string' || !b.timezone || !validTz(b.timezone)) return bad('unknown time zone'); sets.push(`timezone = ?${vals.push(b.timezone)}`); }
  let cookie = null;
  if ('password' in b) {
    if (!(await checkPassword(String(b.current_password || ''), user.password_hash))) return bad('current password is wrong', 403);
    if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) return bad('use at least 8 characters');
    const hash = await hashPassword(b.password);
    sets.push(`password_hash = ?${vals.push(hash)}`);
    cookie = await makeSessionCookie(env, user.id, hash); // other devices are signed out, this one stays in
  }
  if (!sets.length) return bad('nothing to update');
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?${vals.length + 1}`).bind(...vals, user.id).run();
  const res = json({ ok: true });
  if (cookie) res.headers.set('set-cookie', cookie);
  return res;
}

// Owner only: invite codes and the list of friends with how much space each one uses.
const inviteCode = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', r = crypto.getRandomValues(new Uint8Array(8)); return [...r].map((n) => a[n % a.length]).join('').replace(/^(.{4})/, '$1-'); };
async function admin(req, env, path) {
  const m = req.method;
  let match;
  if (path === '/api/admin/friends' && m === 'GET') {
    const { results: invites } = await env.DB.prepare('SELECT i.code, i.note, i.created_at, i.used_at, u.email AS used_by FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC').all();
    const { results: users } = await env.DB.prepare('SELECT id, email, name, timezone, created_at FROM users ORDER BY created_at').all();
    await Promise.all(users.map(async (u) => { u.bytes = await userStub(env, u.id).size().catch(() => null); }));
    return json({ invites, users });
  }
  if (path === '/api/admin/invites' && m === 'POST') {
    const code = inviteCode();
    await env.DB.prepare('INSERT INTO invites (code, note) VALUES (?1, ?2)').bind(code, str((await body(req)).note, 80) || null).run();
    return json({ code }, 201);
  }
  if ((match = path.match(/^\/api\/admin\/invites\/([A-Z0-9-]+)$/)) && m === 'DELETE') {
    const r = await env.DB.prepare('DELETE FROM invites WHERE code = ?1 AND used_at IS NULL').bind(match[1]).run();
    return r.meta.changes ? json({ ok: true }) : bad('not found or already used', 404);
  }
  if ((match = path.match(/^\/api\/admin\/users\/(\d+)\/reset$/)) && m === 'POST') {
    const password = inviteCode().toLowerCase() + '-' + inviteCode().toLowerCase();
    const r = await env.DB.prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2').bind(await hashPassword(password), Number(match[1])).run();
    return r.meta.changes ? json({ password }) : bad('not found', 404);
  }
  return bad('not found', 404);
}

// What a signed-in person's request runs with: the owner uses D1 and wrangler.jsonc settings; a friend gets
// their own database and settings, and none of the owner's integrations (calendar feed, ingest token).
function asUser(env, user) {
  if (!user.id) return { env: { ...env, UID: 0 }, settings: {} };
  const { GCAL_ICS_URL, INGEST_TOKEN, ...shared } = env;
  return {
    env: { ...shared, UID: user.id, DB: userDB(userStub(env, user.id)) },
    settings: { owner: user.name, ownerFull: user.name, honorific: user.name, tz: user.timezone, tagline: '', role: 'friend' },
  };
}

export default {
  async fetch(req, env, ctx) {
    loadConfig(env);
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/ingest/')) {
        if (!(await verifyIngest(req, env))) return bad('unauthorized', 401);
        if (['/api/ingest/todo', '/api/ingest/alfred'].includes(url.pathname) && req.method === 'POST') return withHeaders(await ingestTodo(req, env, url));
        if (url.pathname.startsWith('/api/ingest/transcripts')) return withHeaders((await transcriptsIngest(req, env, url, ctx)) || bad('not found', 404));
        return bad('not found', 404);
      }
      if (url.pathname === '/login') {
        if (req.method === 'POST') return await login(req, env, url);
        if (await sessionUser(req, env)) return redirect(safeNext(url.searchParams.get('next')));
        return html(loginPage({ next: safeNext(url.searchParams.get('next')) }));
      }
      if (url.pathname === '/signup') {
        if (req.method === 'POST') return await signup(req, env, url);
        return html(signupPage({ code: str(url.searchParams.get('code'), 40).toUpperCase() }));
      }
      if (url.pathname === '/logout' && req.method === 'POST') {
        if (crossSite(req, url)) return bad('forbidden', 403);
        return redirect('/login', { 'set-cookie': clearSessionCookie() });
      }
      if (PUBLIC_ASSETS.has(url.pathname)) return withHeaders(await env.ASSETS.fetch(req));
      if (url.pathname === '/manifest.webmanifest') return withHeaders(await manifest(env, req));
      if (url.pathname === '/privacy') return html(privacyPage(url.host));

      // DEV_BYPASS (local only) signs you in as the owner unless you signed in as someone else.
      const user = (await sessionUser(req, env)) || (env.DEV_BYPASS === '1' ? { id: 0 } : null);
      if (!user) {
        if (url.pathname.startsWith('/api/')) return bad('unauthorized', 401);
        return redirect('/login' + (url.pathname === '/' ? '' : '?next=' + encodeURIComponent(url.pathname + url.search)));
      }
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method) && crossSite(req, url)) return bad('forbidden', 403);
      const path = url.pathname.replace(/\/+$/, '');
      if (path === '/api/account') return withHeaders(await account(req, env, user));
      if (path.startsWith('/api/admin/')) return withHeaders(user.id ? bad('not found', 404) : await admin(req, env, path));
      const { env: uenv, settings } = asUser(env, user);
      return await withUser(settings, async () => {
        if (url.pathname.startsWith('/api/')) return withHeaders(await api(req, uenv, url, ctx));
        // Pages (no file extension) are fetched without the browser's If-None-Match, so they are never a stale 304.
        const page = !/\.\w+$/.test(url.pathname);
        return withHeaders(personalize(await env.ASSETS.fetch(page ? new Request(req.url) : req)));
      });
    } catch (err) {
      console.error(err);
      return bad('server error', 500);
    }
  },
  // Optional cron (see wrangler.example.jsonc): summarize the owner's session transcripts that are still waiting.
  // shortcut: friends' transcripts are only summarized when they arrive or on request; loop over users if they need it.
  async scheduled(event, env, ctx) {
    loadConfig(env);
    ctx.waitUntil(summarizePending({ ...env, UID: 0 }).catch((e) => console.error('cron transcripts', e.message)));
  },
};
