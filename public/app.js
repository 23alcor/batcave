// Batcave front end — vanilla JS, hash routing, talks to /api/*.
// window.__CFG (name, assistant, time zone…) is filled in by the Worker from wrangler.jsonc vars.
import { temperature, weatherInfo, weatherIcon } from './weather.js';
import { setupPlaceMap, setupPlacePhotos } from './place-map.js';
import { renderBudgetApp } from './budget.js';
import { createPageRenderer } from './navigation.js';
const CFG = { app: 'Batcave', owner: '', assistant: 'Alfred', tz: 'America/New_York', ...(window.__CFG || {}) };
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login' + (location.hash ? '#' + location.hash.slice(1) : '');
    throw new Error('Signed out. Taking you to the login page.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
let toastTimer;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
// withUndo adds an Undo button and the shortcut hint, and keeps the toast up a little longer.
function toast(msg, withUndo = false) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${withUndo ? `<button type="button" class="toast-undo" data-undo>Undo</button><kbd>${IS_MAC ? '⌘Z' : 'Ctrl+Z'}</kbd>` : ''}`;
  t.classList.toggle('actionable', withUndo);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show', 'actionable'), withUndo ? 5000 : 2200);
}

// ---------- undo / redo for clicks (⌘Z / ⌘⇧Z) ----------
const undoStack = [], redoStack = [];
function remember(label, undoFn, redoFn) {
  undoStack.push({ label, undo: undoFn, redo: redoFn });
  if (undoStack.length > 50) undoStack.shift();
  redoStack.length = 0;
  toast(label, true);
}
async function undoLast() {
  const a = undoStack.pop();
  if (!a) return toast('Nothing to undo');
  try { await a.undo(); redoStack.push(a); toast('Undid · ' + a.label); }
  catch (e) { undoStack.push(a); toast(e.message); }
  refreshDash().catch(() => {}); rerender();
}
async function redoLast() {
  const a = redoStack.pop();
  if (!a) return toast('Nothing to redo');
  try { await a.redo(); undoStack.push(a); toast('Redid · ' + a.label); }
  catch (e) { redoStack.push(a); toast(e.message); }
  refreshDash().catch(() => {}); rerender();
}
const editingText = () => { const el = document.activeElement; return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !['checkbox', 'radio', 'button', 'submit'].includes(el.type)) || el?.isContentEditable; };
document.addEventListener('keydown', (ev) => {
  const mod = ev.metaKey || ev.ctrlKey;
  if (!mod || ev.altKey || editingText() || document.querySelector('dialog[open]')) return;
  const k = ev.key.toLowerCase();
  if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); undoLast(); }
  else if ((k === 'z' && ev.shiftKey) || (ev.ctrlKey && k === 'y')) { ev.preventDefault(); redoLast(); }
});
document.addEventListener('click', (ev) => { if (ev.target.closest('[data-undo]')) undoLast(); });

// ---------- dates ----------
const parseDay = (d) => new Date(d + 'T00:00:00Z');
const addDays = (d, n) => { const x = parseDay(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const fmtDay = (d, o) => parseDay(d).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
const fmtTime = (hm) => { let [h, m] = hm.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return m ? `${h}:${String(m).padStart(2, '0')} ${ap}` : `${h} ${ap}`; };
const fmtRange = (s, e) => {
  const a = s.slice(11, 16), b = e ? e.slice(11, 16) : null;
  if (!b) return fmtTime(a);
  const pa = +a.slice(0, 2) >= 12 ? 'PM' : 'AM', pb = +b.slice(0, 2) >= 12 ? 'PM' : 'AM';
  return pa === pb ? `${fmtTime(a).replace(/ [AP]M$/, '')}–${fmtTime(b)}` : `${fmtTime(a)}–${fmtTime(b)}`;
};
function when(t) {
  if (t.date_tbd) return { text: 'Date TBD', cls: 'muted' };
  if (!t.due_at) return { text: 'No date', cls: 'muted' };
  const d = t.days, time = t.due_at.length > 10 ? ' · ' + fmtTime(t.due_at.slice(11, 16)) : '';
  if (d < 0) return { text: `${-d}d late`, cls: 'red' };
  if (d === 0) return { text: 'Today' + time, cls: 'amber' };
  if (d === 1) return { text: 'Tomorrow' + time, cls: '' };
  if (d < 7) return { text: fmtDay(t.due_at.slice(0, 10), { weekday: 'short' }) + time, cls: '' };
  return { text: fmtDay(t.due_at.slice(0, 10), { month: 'short', day: 'numeric' }), cls: 'muted' };
}
const greeting = (hm) => { const h = +hm.slice(0, 2); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };

// ---------- shared state ----------
const state = { dash: null, weekStart: null, wishFilter: 'Searching', eatFilter: 'want' };
async function refreshDash() {
  state.dash = await api('/api/dashboard');
  const k = state.dash.kpis;
  const set = (key, v) => $$(`[data-count="${key}"]`).forEach((el) => { el.textContent = v ? (el.classList.contains('tab-badge') && v > 99 ? '99+' : String(v)) : ''; });
  set('due', k.due); set('inbox', k.inbox);
  return state.dash;
}

// ---------- components ----------
const EV_COLORS = { gym: '#15803D', work: '#475569', cap: '#4F46E5', ai: '#7C3AED', rel: '#0F766E', oop: '#0369A1', ml: '#9D174D', eh: '#B45309', per: '#BE123C', cal: '#2563EB' };

// Short zone name for the week view's corner, e.g. "EST" / "EDT" for America/New_York.
function tzLabel(day) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: CFG.tz, timeZoneName: 'short' }).formatToParts(new Date(day + 'T12:00:00Z')).find((p) => p.type === 'timeZoneName')?.value || ''; }
  catch { return ''; }
}
function weekHtml(w) {
  const days = [...Array(7)].map((_, i) => addDays(w.start, i));
  w.events.forEach((e, i) => { e._i = i; });
  w.deadlines.forEach((t, j) => { t._j = j; });
  const timed = w.events.filter((e) => !e.allDay);
  const timedTasks = w.deadlines.filter((t) => t.due_at.length > 10);
  const wakeMins = days.map((d) => w.wake?.[d]?.time).filter(Boolean).map((t) => +t.slice(0, 2) * 60 + +t.slice(3, 5));
  // Start the grid a little before the earliest wake-up so its night shading and label show.
  const H0 = Math.max(0, Math.min(4, ...timed.map((e) => +e.start.slice(11, 13)), ...timedTasks.map((t) => +t.due_at.slice(11, 13)), ...wakeMins.map((m) => Math.floor((m - 45) / 60))));
  const H1 = 24, PX = 28;
  Object.assign(w, { _H0: H0, _PX: PX, _days: days });
  const a = parseDay(days[0]), b = parseDay(days[6]);
  const sameMonth = a.getUTCMonth() === b.getUTCMonth();
  const title = sameMonth
    ? `${fmtDay(days[0], { month: 'long' })} ${a.getUTCDate()} – ${b.getUTCDate()}, ${b.getUTCFullYear()}`
    : `${fmtDay(days[0], { month: 'short', day: 'numeric' })} – ${fmtDay(days[6], { month: 'short', day: 'numeric' })}, ${b.getUTCFullYear()}`;

  const head = days.map((d) => `<div class="wk-day${d === w.today ? ' today' : ''}"><div class="wk-dow">${fmtDay(d, { weekday: 'short' }).toUpperCase()}</div><div class="wk-num">${parseDay(d).getUTCDate()}</div><div class="wk-weather" data-weather-day="${d}">${dailyWeather(d)}</div></div>`).join('');
  const allday = days.map((d) => {
    const chips = [
      ...w.events.filter((e) => e.allDay && e.start === d).map((e) => ({ cls: 'hol', text: e.title, color: e.color?.startsWith('#') ? e.color : null, ink: e.ink, i: e._i })),
      ...w.deadlines.filter((t) => t.day === d && t.due_at.length <= 10).map((t) => ({ cls: t.state, text: t.title + (t.project ? ` · ${t.project}` : '') })),
    ];
    const shown = chips.slice(0, 3), rest = chips.slice(3);
    return `<div>${shown.map((c) => c.i !== undefined
      ? `<button type="button" class="ad ${c.cls} ev-chip" data-i="${c.i}" title="${esc(c.text)}"${c.color ? ` style="background:${esc(c.color)};color:${esc(c.ink || '#FFFFFF')}"` : ''}>${esc(c.text)}</button>`
      : `<span class="ad ${c.cls}" title="${esc(c.text)}">${esc(c.text)}</span>`).join('')}${rest.length ? `<span class="ad more" title="${esc(rest.map((c) => c.text).join('\n'))}">+${rest.length} more</span>` : ''}</div>`;
  }).join('');
  const hours = [];
  for (let h = H0 + 1; h < H1; h++) hours.push(`<span style="top:${(h - H0) * PX - 7}px">${fmtTime(String(h).padStart(2, '0') + ':00')}</span>`);
  const cols = days.map((d) => {
    const evs = timed.filter((e) => e.start.slice(0, 10) === d).map((e) => {
      const s = +e.start.slice(11, 13) * 60 + +e.start.slice(14, 16);
      let en = e.end ? (e.end.slice(0, 10) > d ? 1440 : +e.end.slice(11, 13) * 60 + +e.end.slice(14, 16)) : s + 60;
      if (en <= s) en = s + 30;
      return { ...e, s, e: en };
    });
    // Tasks with a time sit in the grid as 30-minute blocks.
    for (const t of timedTasks) if (t.day === d) { const s = minsOf(t.due_at); evs.push({ _task: t, s, e: Math.min(1440, s + 30) }); }
    evs.sort((x, y) => x.s - y.s || y.e - x.e);
    const laid = layout(evs);
    const blocks = laid.map((e) => {
      if (e._task) return taskBlock(e, H0, PX);
      const top = (e.s / 60 - H0) * PX, height = Math.max(18, ((e.e - e.s) / 60) * PX - 2);
      const left = `calc(${(e.lane / e.lanes) * 100}% + 2px)`, width = `calc(${100 / e.lanes}% - 5px)`;
      const bg = e.color?.startsWith('#') ? e.color : (EV_COLORS[e.color] || EV_COLORS.cal);
      const tip = `${e.title} · ${fmtRange(e.start, e.end)}${e.location ? ' · ' + e.location : ''}${e.calendar ? ' · ' + e.calendar : ''}`;
      const inner = `<strong>${esc(e.title)}</strong><span${height > 30 ? '' : ' hidden'}>${esc(fmtRange(e.start, e.end))}</span>`;
      const style = `top:${top}px;height:${height}px;left:${left};width:${width};background:${esc(bg)};color:${esc(e.ink || '#FFFFFF')}`;
      return `<div class="ev${e.writable ? ' editable' : ''}" data-i="${e._i}" style="${style}" title="${esc(tip)}">${inner}${e.writable ? '<div class="ev-rs" aria-hidden="true"></div>' : ''}</div>`;
    }).join('');
    let now = '';
    if (d === w.today) { const [hh, mm] = w.now.split(':').map(Number); now = `<div class="now" style="top:${(hh + mm / 60 - H0) * PX}px" aria-hidden="true"></div>`; }
    return `<div class="wk-col${d === w.today ? ' today' : ''}" data-day="${d}" style="height:${(H1 - H0) * PX}px">${wakeLine(w, d, H0, PX)}${blocks}${now}</div>`;
  }).join('');
  return `<div class="week-bar">
      <button class="btn small" data-action="week-today">Today</button>
      <button class="btn small icon" data-action="week-prev" aria-label="Previous week">‹</button>
      <button class="btn small icon" data-action="week-next" aria-label="Next week">›</button>
      <h2>${esc(title)}</h2>
      ${calendarControls(w)}
    </div>
    <div class="week-scroll-x"><div class="week-inner">
      <div class="wk-row wk-head"><span class="wk-gutter" style="padding-top:8px">${esc(tzLabel(w.today))}</span>${head}</div>
      <div class="wk-row wk-allday"><span class="wk-gutter">all-day</span>${allday}</div>
      <div class="wk-body"><div class="wk-row"><div class="wk-hours" style="height:${(H1 - H0) * PX}px">${hours.join('')}</div>${cols}</div></div>
    </div></div>`;
}
const SUN_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function wakeSource(w, d) {
  const x = w.wake?.[d];
  if (!x) return '';
  return x.from === 'day' ? 'this day only' : x.from === 'weekday' ? `every ${WEEKDAY_NAMES[parseDay(d).getUTCDay()]}` : 'every day';
}
function wakeLine(w, d, H0, PX) {
  const x = w.wake?.[d];
  if (!x) return '';
  const m = +x.time.slice(0, 2) * 60 + +x.time.slice(3, 5);
  const top = (m / 60 - H0) * PX;
  // If an event fills the space just above the line, put the label below it instead.
  const covered = w.events.some((e) => !e.allDay && e.start.slice(0, 10) === d && minsOf(e.start) < m && (e.end ? (e.end.slice(0, 10) > d ? 1440 : minsOf(e.end)) : minsOf(e.start) + 60) > m - 30);
  return `<div class="wk-night" style="height:${Math.max(0, top)}px" aria-hidden="true"></div>`
    + `<button type="button" class="wake${x.from === 'default' ? '' : ' custom'}${covered ? ' below' : ''}" data-day="${d}" style="top:${top}px" title="Wake up ${fmtTime(x.time)} (${wakeSource(w, d)}). Click to change, drag to move this day." aria-label="Wake up ${fmtTime(x.time)} on ${fmtDay(d, { weekday: 'long' })}, ${wakeSource(w, d)}. Change">`
    + `<span class="wake-pill">${SUN_ICON}<span>${fmtTime(x.time)}</span></span></button>`;
}
function taskBlock(e, H0, PX) {
  const t = e._task;
  const top = (e.s / 60 - H0) * PX, height = Math.max(20, ((e.e - e.s) / 60) * PX - 2);
  const left = `calc(${(e.lane / e.lanes) * 100}% + 2px)`, width = `calc(${100 / e.lanes}% - 5px)`;
  const tip = `${t.title} · ${t.state === 'overdue' ? 'overdue · ' : ''}${fmtTime(t.due_at.slice(11, 16))}${t.project ? ' · ' + t.project : ''}`;
  return `<div class="ev tk ${esc(t.state)}" data-j="${t._j}" style="top:${top}px;height:${height}px;left:${left};width:${width}" title="${esc(tip)}">`
    + `<button type="button" class="tk-check" aria-label="Mark ${esc(t.title)} done"></button><strong>${esc(t.title)}</strong></div>`;
}
function layout(evs) {
  const out = [];
  let cluster = [], end = -1;
  const flush = () => {
    const lanes = [];
    for (const e of cluster) { let i = lanes.findIndex((x) => x <= e.s); if (i < 0) { i = lanes.length; lanes.push(0); } lanes[i] = e.e; e.lane = i; }
    for (const e of cluster) e.lanes = lanes.length;
    out.push(...cluster);
    cluster = [];
  };
  for (const e of evs) { if (cluster.length && e.s >= end) { flush(); end = -1; } cluster.push(e); end = Math.max(end, e.e); }
  if (cluster.length) flush();
  return out;
}

function projectCard(p) {
  const total = p.open || 1;
  const w = (n) => `${((n / total) * 100).toFixed(1)}%`;
  let status = 'Nothing open', cls = '';
  if (p.overdue) { status = `${p.overdue} overdue${p.soon ? ` · ${p.soon} due soon` : ''}`; cls = 'red'; }
  else if (p.soon) { status = `${p.soon} due within 7 days`; cls = 'amber'; }
  else if (p.next) status = `Next: ${fmtDay(p.next.due_at.slice(0, 10), { month: 'short', day: 'numeric' })}`;
  else if (p.tbd) status = 'Dates TBD';
  return `<a class="pc" href="#/projects/${esc(p.id)}">
    <span class="pc-top"><strong>${esc(p.name)}</strong><span>${p.open} open</span></span>
    <span class="bar" aria-hidden="true"><span class="b-od" style="width:${w(p.overdue)}"></span><span class="b-soon" style="width:${w(p.soon)}"></span><span class="b-later" style="width:${w(p.later)}"></span><span class="b-tbd" style="width:${w(p.tbd)}"></span></span>
    <span class="pc-status ${cls}">${esc(status)}</span></a>`;
}
function projectsHtml(list, title, all = false) {
  const sorted = [...list].sort((a, b) => (b.overdue - a.overdue) || (b.soon - a.soon) || (a.sort - b.sort));
  return `<section class="card" aria-label="${esc(title)}">
    <div class="card-head"><h2>${esc(title)}</h2>
      <div class="legend"><span><i class="b-od"></i>Overdue</span><span><i class="b-soon"></i>Due within 7 days</span><span><i class="b-later"></i>Later</span><span><i class="b-tbd"></i>No date yet</span></div></div>
    ${sorted.length ? `<div class="pgrid">${sorted.map(projectCard).join('')}</div>` : `<div class="empty">${all ? 'No projects yet.' : 'No project has open tasks.'}</div>`}
  </section>`;
}
function taskRow(t) {
  const wn = when(t);
  return `<div class="row"><input type="checkbox" class="check" data-action="done" data-id="${esc(t.id)}" aria-label="Mark ${esc(t.title)} done">
    <span class="grow">${esc(t.title)}${t.project ? `<span class="meta">${esc(t.project)}</span>` : ''}</span>
    <span class="when ${wn.cls}">${esc(wn.text)}</span><button class="btn small" data-action="task-edit" data-id="${esc(t.id)}">Edit</button></div>`;
}
function habitsHtml(habits, title = 'Daily', weekly = null) {
  const done = habits.filter((h) => h.done).length;
  return `<section class="card"><div class="card-head"><h2>${esc(title)}</h2><span class="muted">${done} of ${habits.length}</span></div>
    <div class="chips">${habits.map((h) => `<label class="chip${h.done ? ' on' : ''}"><input type="checkbox" class="check" style="width:15px;height:15px" data-action="habit" data-id="${esc(h.id)}"${h.done ? ' checked' : ''}><span>${esc(h.name)}</span></label>`).join('')}</div>
    ${weekly?.length ? `<div class="group-title"><span>This week</span></div><div class="chips">${weekly.map(weeklyChip).join('')}</div>` : ''}</section>`;
}
// A weekly habit is done once it's checked any day Sunday–Saturday.
function weeklyChip(h) {
  const d = state.dash, today = d?.now?.date, end = d?.weekStart ? addDays(d.weekStart, 6) : null;
  const left = today && end ? Math.round((parseDay(end) - parseDay(today)) / 864e5) + 1 : null;
  const meta = h.done ? `Done ${fmtDay(h.done_day, { weekday: 'short' })}` : left === 1 ? 'Last day' : left ? `${left} days left` : '';
  return `<label class="chip${h.done ? ' on' : ''}"><input type="checkbox" class="check" style="width:15px;height:15px" data-action="habit" data-weekly="1" data-id="${esc(h.id)}"${h.done ? ' checked' : ''}><span>${esc(h.name)}</span>${meta ? `<span class="chip-meta">${esc(meta)}</span>` : ''}</label>`;
}

// ---------- home widgets ----------
// The home page is a grid of widgets the owner can rearrange, resize, add and remove (Edit, or hold one on a phone).
// Layout = [{ id, size }] in screen order, saved on the server (meta 'home:layout'). The same widget may appear twice.
const SIZE_NAMES = { s: 'Small', m: 'Medium', l: 'Large' };
function countWidget(size, o) {
  const num = `<div class="num${o.red && o.n ? ' red' : ''}">${o.n}</div>`;
  if (size === 's') return `<a class="card kpi wg-link" href="${o.href}"><div class="label"><span>${o.label}</span>${o.badge || ''}</div>${num}<div class="cap">${o.cap}</div></a>`;
  const rows = o.list.slice(0, size === 'm' ? 3 : 8);
  return `<section class="card"><div class="card-head"><h2>${o.label}${o.badge || ''}</h2><a href="${o.href}">${o.n > rows.length ? `All ${o.n}` : 'Deadlines'}</a></div>
    <div class="wg-split">${num}<div class="wg-list">${rows.length ? rows.map(taskRow).join('') : `<div class="empty">${o.empty}</div>`}</div></div></section>`;
}
function dailyWeather(day) {
  const forecast = state.weather?.days?.[day];
  if (!forecast) return '<span class="muted" title="Weather is unavailable for this date">—</span>';
  const info = weatherInfo(forecast.code);
  const label = `${info.label}, high ${temperature(forecast.high, state.weather.unit)}, low ${temperature(forecast.low, state.weather.unit)} · ${state.weather.location}`;
  return `<span class="weather-daily" role="img" aria-label="${esc(label)}" title="${esc(label)}">${weatherIcon(info.icon)}<span>${temperature(forecast.high)} <span class="muted">${temperature(forecast.low)}</span></span></span>`;
}
function currentWeather() {
  const w = state.weather;
  if (!w) return '<span class="muted">Locating weather…</span>';
  if (w.error || !w.current) return `<span class="muted">${esc(w.error || 'Weather unavailable')}</span><button class="btn small" data-action="weather-retry">${w.locationDenied ? 'Use my location' : 'Retry'}</button>`;
  const info = weatherInfo(w.current.code, w.current.is_day), today = w.days[state.dash.now.date];
  return `<span class="weather-location" title="${esc(w.location)}">${esc(w.location)}</span><div class="weather-now">${weatherIcon(info.icon)}<span>${temperature(w.current.temperature, w.unit)}</span></div>
    <span class="weather-condition">${esc(info.label)}</span>${today ? `<span class="weather-range">H:${temperature(today.high)} L:${temperature(today.low)}</span>` : ''}
    <a class="weather-source" href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer" title="Weather by Open-Meteo · updated ${esc(new Date(w.updated_at).toLocaleTimeString('en-US', { timeZone: CFG.tz, hour: 'numeric', minute: '2-digit' }))}">Open-Meteo</a>`;
}
function fillWeather() {
  $$('[data-weather-today]').forEach((el) => { el.innerHTML = currentWeather(); });
  $$('[data-weather-day]').forEach((el) => { el.innerHTML = dailyWeather(el.dataset.weatherDay); });
}
async function loadWeather() {
  try {
    if (!navigator.geolocation) throw new Error('Location is unavailable on this device');
    const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { maximumAge: 900000, timeout: 10000 }));
    const query = new URLSearchParams({ latitude: position.coords.latitude.toFixed(2), longitude: position.coords.longitude.toFixed(2) });
    state.weather = await api('/api/weather?' + query);
  } catch (e) {
    state.weather = { error: e.code === 1 ? 'Allow location for weather' : 'Weather unavailable', locationDenied: e.code === 1, days: {} };
  }
  fillWeather();
}
// Keep the date and weather together; medium and large also show the month.
function dateWidget(day, size) {
  const label = fmtDay(day, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const big = `<div class="dw-day"><div class="dw-dow">${esc(fmtDay(day, { weekday: size === 's' ? 'long' : 'short' }))}</div><div class="dw-num">${parseDay(day).getUTCDate()}</div>${size === 's' ? `<div class="dw-mon">${esc(fmtDay(day, { month: 'long' }))}</div>` : ''}</div>`;
  const overview = `<div class="dw-overview">${big}<div class="weather-summary" data-weather-today aria-label="Weather">${currentWeather()}</div></div>`;
  if (size === 's') return `<section class="card dw dw-s" aria-label="${esc(label)} and weather">${overview}</section>`;
  const first = day.slice(0, 8) + '01', start = addDays(first, -parseDay(first).getUTCDay()), cells = [];
  for (let i = 0; i < 42; i++) {
    const c = addDays(start, i);
    if (i % 7 === 0 && i && c.slice(5, 7) !== day.slice(5, 7)) break; // stop after the week the month ends in
    cells.push(c.slice(5, 7) === day.slice(5, 7) ? `<span${c === day ? ' class="today"' : ''}>${+c.slice(8)}</span>` : '<span></span>');
  }
  return `<section class="card dw dw-${size}" aria-label="${esc(label)} and weather">${overview}
    <div class="dw-cal" aria-hidden="true"><div class="dw-cal-head">${esc(fmtDay(day, { month: 'long' }))}</div>
      <div class="dw-grid">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w) => `<b>${w}</b>`).join('')}${cells.join('')}</div></div></section>`;
}
const WIDGETS = {
  overdue: { name: 'Overdue', desc: 'Tasks past their due date', sizes: 'sml', html: (d, size) => countWidget(size, {
    label: 'Overdue', n: d.kpis.overdue, red: true, href: '#/deadlines', list: d.due.overdue, empty: 'Nothing overdue',
    badge: d.kpis.overdueDelta > 0 ? ` <span class="badge red">+${d.kpis.overdueDelta} vs yesterday</span>` : '',
    cap: d.oldestOverdue ? `Oldest: ${esc(d.oldestOverdue.title)}, ${d.oldestOverdue.days}d` : 'Nothing overdue' }) },
  today: { name: 'Due today', desc: 'Deadlines due today', sizes: 'sml', html: (d, size) => countWidget(size, {
    label: 'Due today', n: d.kpis.today, href: '#/deadlines', list: d.due.today, empty: 'Nothing has a deadline today',
    cap: d.kpis.today ? 'Clear these before tonight' : 'Nothing has a deadline today' }) },
  soon: { name: 'Next 7 days', desc: 'Due later this week', sizes: 'sml', html: (d, size) => countWidget(size, {
    label: 'Next 7 days', n: d.kpis.soon, href: '#/deadlines', list: d.due.soon, empty: 'Clear week',
    cap: d.nextSoon ? `First: ${esc(d.nextSoon.title)} · ${fmtDay(d.nextSoon.due_at.slice(0, 10), { weekday: 'short', month: 'short', day: 'numeric' })}` : 'Clear week' }) },
  habits: { name: 'Daily', desc: 'Habits done today', sizes: 'sml', html: (d, size) => {
    if (size !== 's') return habitsHtml(d.habits, 'Daily', d.weekly);
    const done = d.habits.filter((h) => h.done).length, pct = d.habits.length ? Math.round((done / d.habits.length) * 100) : 0;
    return `<a class="card kpi wg-link" href="#/daily"><div class="label"><span>Daily habits</span></div><div class="num">${done}<span class="muted" style="font-size:20px">/${d.habits.length}</span></div>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Habits done today"><span style="width:${pct}%"></span></div></a>`;
  } },
  calendar: { name: 'Calendar', desc: 'Small: next events. Medium: today. Large: the full week.', sizes: 'sml', html: (d, size, firstWeek) => {
    if (size !== 'l') return `<section class="card cal-w cal-${size}" data-agenda="${size}" aria-label="Calendar"><div class="cal-none">Loading…</div></section>`;
    return firstWeek ? '<section class="card week" id="week" aria-label="Week view"><div class="empty" style="margin:0 20px 16px">Loading week…</div></section>'
      : '<section class="card"><div class="empty">The week view is already on this page.</div></section>';
  } },
  date: { name: 'Date & weather', desc: 'Today’s date and local weather. Medium and Large add the month.', sizes: 'sml', html: (d, size) => dateWidget(d.now.date, size) },
  projects: { name: 'Projects', desc: 'Progress of open projects', sizes: 'ml', html: (d) => projectsHtml(d.projects, 'Projects') },
  focus: { name: 'Focus', desc: 'What to do next', sizes: 'ml', html: (d, size) => {
    const list = size === 'l' ? [...d.due.today, ...d.due.overdue.slice().reverse(), ...d.due.soon].slice(0, 8) : d.focus;
    return `<section class="card"><div class="card-head"><h2>Focus</h2><a href="#/deadlines">All ${d.kpis.due} due</a></div>
      ${list.length ? list.map(taskRow).join('') : '<div class="empty">You are clear. Nice.</div>'}</section>`;
  } },
  garage: { name: 'Garage & more', desc: 'Vehicles, wishlist and inbox', sizes: 'sm', html: (d) => `<section class="card"><div class="card-head"><h2>Garage &amp; more</h2></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">${d.vehicles.map((v) => `<a class="car" href="#/garage"><strong style="font-size:22px">${esc(v.name)}</strong><span class="meta muted" style="display:block;font-size:12px">${v.mileage ? v.mileage.toLocaleString() + ' mi' : 'Service log'}</span></a>`).join('')}</div>
    <div style="display:flex;gap:16px;margin-top:12px;font-size:13px;flex-wrap:wrap"><a href="#/wishlist">${d.counts.wishlist_open} on wishlist</a><a href="#/inbox">${d.kpis.inbox} in inbox</a></div></section>` },
};
const DEFAULT_HOME = [['overdue', 's'], ['today', 's'], ['soon', 's'], ['habits', 's'], ['calendar', 'l'], ['projects', 'l'], ['focus', 'm'], ['habits', 'm'], ['garage', 'm']].map(([id, size]) => ({ id, size }));
const fitLayout = (l) => (l || DEFAULT_HOME).filter((w) => WIDGETS[w.id]).map((w) => ({ id: w.id, size: WIDGETS[w.id].sizes.includes(w.size) ? w.size : WIDGETS[w.id].sizes[0] }));

// Small and medium calendar widgets: the rest of today (or tomorrow once today is over), like the iPhone's.
const agendaRow = (e) => `<div class="ag-row" style="--c:${esc(e.color?.startsWith('#') ? e.color : 'var(--accent)')}"><span class="ag-title">${esc(e.title)}</span>
  <span class="ag-time">${esc(e.allDay ? 'All day' : fmtRange(e.start, e.end?.slice(0, 10) === e.start.slice(0, 10) ? e.end : null))}</span></div>`;
function fillAgenda() {
  const d = state.dash, a = state.agenda;
  if (!d || !a) return;
  const today = d.now.date, nowWall = `${today}T${d.now.time}`;
  const on = (day) => a.events.filter((e) => (e.allDay ? e.start === day : e.start.slice(0, 10) === day)).sort((x, y) => (y.allDay - x.allDay) || x.start.localeCompare(y.start));
  const left = on(today).filter((e) => e.allDay || (e.end || e.start) > nowWall), next = on(addDays(today, 1));
  const date = `<div class="cal-dow">${esc(fmtDay(today, { weekday: 'long' }))}</div><div class="cal-num">${parseDay(today).getUTCDate()}</div>`;
  const rest = (n) => (left.length ? left.slice(0, n).map(agendaRow).join('')
    : `<div class="cal-none">No more events today</div>${next.length ? `<div class="cal-sub">Tomorrow</div>${next.slice(0, Math.max(1, n - 1)).map(agendaRow).join('')}` : ''}`);
  $$('[data-agenda]').forEach((el) => {
    el.innerHTML = el.dataset.agenda === 's' ? `<div>${date}</div>${rest(2)}` : `<div class="cal-date">${date}</div><div class="cal-list">${rest(4)}</div>`;
  });
}
async function loadAgenda() {
  if (!$('[data-agenda]') || !state.dash) return;
  try { state.agenda = await api(`/api/events?start=${state.dash.now.date}&days=2${Date.now() < (state.calDirty || 0) ? '&fresh=1' : ''}`); }
  catch { $$('[data-agenda]').forEach((el) => { el.innerHTML = '<div class="cal-none">Calendar unavailable</div>'; }); return; }
  $('#quick').dataset.google = state.agenda.google?.connected ? '1' : '';
  fillAgenda();
}

function drawHome(view = $('#view'), fetchMissing = true) {
  const d = state.dash, editing = !!state.homeEdit;
  let weekShown = false;
  const tiles = state.layout.map((w, i) => {
    const def = WIDGETS[w.id];
    const firstWeek = w.id === 'calendar' && w.size === 'l' && !weekShown && (weekShown = true);
    const sizes = editing && def.sizes.length > 1 ? `<div class="wg-sizes" role="group" aria-label="${esc(def.name)} size">${[...def.sizes].map((s) =>
      `<button type="button" data-home="size" data-size="${s}" aria-pressed="${s === w.size}" title="${SIZE_NAMES[s]}">${s.toUpperCase()}</button>`).join('')}</div>` : '';
    return `<div class="wg wg-${w.size}" data-i="${i}"${editing ? ` tabindex="0" role="group" aria-roledescription="widget" aria-label="${esc(def.name)}, ${SIZE_NAMES[w.size]}. Arrow keys move it, Delete removes it."` : ''}>
      <div class="wg-j"><div class="wg-body"${editing ? ' inert' : ''}>${def.html(d, w.size, firstWeek)}</div>
      ${editing ? `<button type="button" class="wg-x" data-home="remove" aria-label="Remove ${esc(def.name)}">−</button>${sizes}` : ''}</div></div>`;
  }).join('');
  view.innerHTML = `
    <header class="head"><div><h1>${greeting(d.now.time)}${CFG.owner ? `, ${esc(CFG.owner)}` : ''}</h1><div class="sub">${fmtDay(d.now.date, { weekday: 'long', month: 'long', day: 'numeric' })}</div></div>
      ${editing ? '' : '<div class="actions"><button class="btn primary" data-action="new">New</button></div>'}</header>
    <div class="home-grid${editing ? ' editing' : ''}" id="home">${tiles || '<div class="empty wg-empty">No widgets here. Choose Edit, then Add widget.</div>'}</div>`;
  if ($('#wg-bar').hidden === editing) $('#wg-bar').hidden = !editing; // only on change, so it pops in once
  fillWeek(); fillAgenda();
  // A calendar widget just added in edit mode has nothing cached to draw yet.
  if (!fetchMissing) return;
  if ($('#week') && !state.week) loadWeek(state.weekStart).catch((e) => toast(e.message));
  if ($('[data-agenda]') && !state.agenda) loadAgenda();
}

// ---------- views ----------
async function viewCommand(view) {
  await state.layoutSave; // a layout change still being saved would otherwise come back as the old one
  const d = await refreshDash();
  state.layout = fitLayout(d.layout);
  drawHome(view, false);
  // Fill independent widgets in the background so navigation never waits on location permission.
  Promise.all([loadWeek(state.weekStart), loadAgenda(), loadWeather()]).catch(e => toast(e.message));
}
function calendarControls(w) {
  const g = w.google || {};
  if (g.connected) {
    return `<div class="cal-ctl"><span class="cal-src${w.calendarError ? ' err' : ''}" title="${esc(w.calendarError || 'Live from Google Calendar')}">${w.calendarError ? 'Google Calendar unavailable · saved schedule' : 'Google Calendar'}</span>
      <button class="btn small" data-action="cal-picker" aria-haspopup="true" aria-expanded="false">Calendars</button><div class="cal-pop" id="cal-pop" hidden></div></div>`;
  }
  if (g.configured) return `<div class="cal-ctl"><span class="cal-src">Saved schedule</span><a class="btn small primary" href="/api/google/connect">${g.needsReconnect ? 'Reconnect' : 'Connect'} Google Calendar</a></div>`;
  return '';
}
async function showCalendarPicker(open) {
  const pop = $('#cal-pop'), btn = $('[data-action="cal-picker"]');
  if (!pop) return;
  if (!open) { pop.hidden = true; btn?.setAttribute('aria-expanded', 'false'); return; }
  pop.hidden = false; btn?.setAttribute('aria-expanded', 'true');
  pop.innerHTML = '<div class="muted" style="padding:6px 4px">Loading calendars…</div>';
  const s = await api('/api/google/status');
  pop.innerHTML = `<div class="cal-pop-head">${esc(s.email || 'Google Calendar')}</div>
    ${s.calendars.map((c) => `<label class="cal-row"><input type="checkbox" class="check" data-action="cal-show" data-id="${esc(c.id)}"${c.shown ? ' checked' : ''}>
      <span class="cal-dot" style="background:${esc(c.color || '#2563EB')}"></span><span class="grow">${esc(c.summary)}</span>${c.writable ? '' : '<span class="muted" style="font-size:11px">read-only</span>'}</label>`).join('') || '<div class="muted">No calendars found.</div>'}
    <div class="cal-pop-foot"><button class="btn small" data-action="cal-sync">Refresh list</button><button class="btn small" data-action="cal-disconnect">Disconnect</button></div>`;
}
async function loadWeek(start) {
  const box = $('#week');
  if (!box) return;
  const q = new URLSearchParams();
  if (start) q.set('start', start);
  if (Date.now() < (state.calDirty || 0)) q.set('fresh', '1');
  const w = await api('/api/events' + (q.toString() ? '?' + q : ''));
  closeEventEditor(); closeTaskEditor(); closeWakeEditor();
  state.week = w;
  state.weekStart = w.start;
  state.google = w.google;
  $('#quick').dataset.google = w.google?.connected ? '1' : '';
  fillWeek();
}
function fillWeek() {
  const box = $('#week');
  if (!box || !state.week) return;
  box.innerHTML = weekHtml(state.week);
  if (isPhone()) {
    const sx = $('.week-scroll-x', box), day = $('.wk-head .wk-day.today', box);
    sx.scrollLeft = day ? day.getBoundingClientRect().left - sx.getBoundingClientRect().left - $('.wk-gutter', box).offsetWidth : 0;
  }
}

async function viewDeadlines(view) {
  const [{ tasks }, d] = await Promise.all([api('/api/tasks?view=open'), state.dash ? Promise.resolve(state.dash) : refreshDash()]);
  const groups = [['overdue', 'Overdue', true], ['today', 'Today', true], ['soon', 'Next 7 days', true], ['later', 'Later', false], ['tbd', 'Dates TBD', false], ['nodate', 'No date', false]];
  view.innerHTML = `
    <header class="head"><div><h1>Deadlines</h1><div class="sub">${tasks.length} open across all projects</div></div></header>
    <section class="card"><form class="form-row" data-form="add-task">
      <label class="sr" for="nt-title">New task</label><input id="nt-title" class="input" name="title" placeholder="Add a task…" required>
      <label class="sr" for="nt-proj">Project</label><select id="nt-proj" class="input" name="project_id" style="flex:0 1 220px"><option value="">Other</option>${d.allProjects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
      <label class="sr" for="nt-due">Due date</label><input id="nt-due" class="input" type="date" name="due" style="flex:0 1 170px">
      <button class="btn primary">Add</button></form></section>
    ${groups.map(([key, label, open]) => {
      const list = tasks.filter((t) => t.bucket === key);
      if (!list.length) return '';
      return `<section class="card"><details${open ? ' open' : ''}><summary class="card-head" style="cursor:pointer;margin:0"><h2>${label} <span class="muted" style="font-weight:400">· ${list.length}</span></h2></summary>
        <div style="margin-top:8px">${list.map(taskRow).join('')}</div></details></section>`;
    }).join('')}`;
}
async function viewInbox(view) {
  const { tasks } = await api('/api/tasks?view=inbox');
  view.innerHTML = `
    <header class="head"><div><h1>Inbox</h1><div class="sub">Loose ideas and to-dos. Check off what is done, promote what matters.</div></div></header>
    <section class="card"><form class="form-row" data-form="add-inbox"><label class="sr" for="ni">New inbox item</label><input id="ni" class="input" name="title" placeholder="Capture something…" required><button class="btn primary">Add</button></form></section>
    <section class="card">${tasks.length ? tasks.map((t) => `<div class="row"><input type="checkbox" class="check" data-action="done" data-id="${esc(t.id)}" aria-label="Mark ${esc(t.title)} done">
      <span class="grow">${esc(t.title)}<span class="meta">${esc(t.project || 'Other')}</span>${t.notes ? `<span class="meta">${esc(t.notes)}</span>` : ''}</span>
      ${t.due_at ? `<span class="when muted">${esc(fmtDay(t.due_at.slice(0, 10), { month: 'short', day: 'numeric' }))}</span>` : ''}
      <button class="btn small" data-action="task-edit" data-inbox="1" data-id="${esc(t.id)}">Edit</button><button class="btn small" data-action="to-task" data-id="${esc(t.id)}">Make task</button></div>`).join('') : '<div class="empty">Inbox zero.</div>'}</section>`;
}
async function viewProjects(view) {
  const { projects } = await api('/api/projects');
  const editing = !!state.projectEdit;
  view.innerHTML = `<header class="head"><div><h1>Projects</h1><div class="sub">${projects.length} projects</div></div>
    <button type="button" class="btn small" data-action="projects-edit" aria-pressed="${editing}">${editing ? 'Done' : 'Edit'}</button></header>
    ${editing ? `<section class="card"><h2> Edit projects</h2>
      <form class="form-row" data-form="add-project"><label class="sr" for="new-project">Project name</label><input id="new-project" class="input" name="name" maxlength="120" placeholder="New project name" required><button class="btn primary">Add project</button></form>
      <p class="muted">Deleting hides a project and keeps its tasks. Use Undo to restore it.</p>
      ${projects.map((p) => `<div class="row"><span class="grow">${esc(p.name)}</span><button type="button" class="btn small" data-action="project-delete" data-id="${esc(p.id)}" data-name="${esc(p.name)}" aria-label="Delete ${esc(p.name)}">Delete</button></div>`).join('')}
    </section>` : ''}${projectsHtml(projects, 'All projects', true)}`;
}
async function viewProject(view, id) {
  const { project: p, tasks, done } = await api('/api/projects/' + encodeURIComponent(id));
  const groups = [['overdue', 'Overdue'], ['today', 'Today'], ['soon', 'Next 7 days'], ['later', 'Later'], ['tbd', 'Dates TBD'], ['nodate', 'No date']];
  view.innerHTML = `
    <header class="head"><div><div class="sub"><a href="#/projects">Projects</a> /</div><h1>${esc(p.name)}</h1></div>
      ${p.status ? `<span class="badge" style="background:var(--accent-soft);color:var(--link)">${esc(p.status)}</span>` : ''}</header>
    <section class="kpis">
      <div class="card kpi"><div class="label">Open</div><div class="num">${tasks.length}</div></div>
      <div class="card kpi"><div class="label">Overdue</div><div class="num${tasks.some((t) => t.bucket === 'overdue') ? ' red' : ''}">${tasks.filter((t) => t.bucket === 'overdue').length}</div></div>
      <div class="card kpi"><div class="label">Next 7 days</div><div class="num">${tasks.filter((t) => t.bucket === 'today' || t.bucket === 'soon').length}</div></div>
      <div class="card kpi"><div class="label">Done</div><div class="num">${done.length}</div></div>
    </section>
    <section class="card"><form class="form-row" data-form="add-task"><input type="hidden" name="project_id" value="${esc(p.id)}">
      <label class="sr" for="pt-title">New task</label><input id="pt-title" class="input" name="title" placeholder="Add a task to ${esc(p.short_name || p.name)}…" required>
      <label class="sr" for="pt-due">Due date</label><input id="pt-due" class="input" type="date" name="due" style="flex:0 1 170px"><button class="btn primary">Add</button></form></section>
    <section class="card">${tasks.length ? groups.map(([k, label]) => { const l = tasks.filter((t) => t.bucket === k); return l.length ? `<div class="group-title"><span>${label}</span><span>${l.length}</span></div>${l.map(taskRow).join('')}` : ''; }).join('') : '<div class="empty">Nothing open in this project.</div>'}</section>
    ${done.length ? `<section class="card"><details><summary class="card-head" style="cursor:pointer;margin:0"><h2>Recently done · ${done.length}</h2></summary>${done.map((t) => `<label class="row"><input type="checkbox" class="check" checked data-action="done" data-id="${esc(t.id)}"><span class="grow" style="text-decoration:line-through;color:var(--muted)">${esc(t.title)}</span></label>`).join('')}</details></section>` : ''}`;
}
async function viewDaily(view) {
  const [h, d] = await Promise.all([api('/api/habits'), refreshDash()]);
  const days = [...Array(28)].map((_, i) => addDays(h.from, i));
  const weeks = [...Array(12)].map((_, i) => addDays(h.weeksFrom, 7 * i));
  const set = new Set(h.checks.map((c) => c.habit_id + '|' + c.day));
  const doneIn = (x, ws) => h.checks.filter((c) => c.habit_id === x.id && c.day >= ws && c.day <= addDays(ws, 6)).map((c) => c.day).sort();
  const dailies = h.habits.filter((x) => x.cadence !== 'weekly'), weeklies = h.habits.filter((x) => x.cadence === 'weekly');
  const short = (dd) => fmtDay(dd, { month: 'short', day: 'numeric' });
  const name = (x) => `<span style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.name)}</span>`;
  const acts = (x, to) => `<span class="heat-acts"><button type="button" class="mv" data-action="habit-cadence" data-id="${esc(x.id)}" data-name="${esc(x.name)}" data-to="${to}" title="Make ${esc(x.name)} a ${to} habit">${to === 'weekly' ? 'Weekly' : 'Daily'}</button><button type="button" class="rm" data-action="habit-remove" data-id="${esc(x.id)}" data-name="${esc(x.name)}" title="Remove ${esc(x.name)} from Daily" aria-label="Remove ${esc(x.name)} from Daily">×</button></span>`;
  const editing = !!state.habitEdit;
  view.innerHTML = `<div class="daily-page${editing ? ' editing' : ''}">
    <header class="head"><div><h1>Daily</h1><div class="sub">Daily habits reset every morning, weekly ones every Sunday.</div></div>
      <div class="actions"><button type="button" class="btn small" data-action="habits-edit" aria-pressed="${editing}">${editing ? 'Done' : 'Edit'}</button></div></header>
    ${habitsHtml(d.habits, 'Today')}
    ${d.weekly.length ? `<section class="card"><div class="card-head"><h2>This week</h2><span class="muted">${short(d.weekStart)} – ${short(addDays(d.weekStart, 6))} · ${d.weekly.filter((x) => x.done).length} of ${d.weekly.length}</span></div>
      <div class="chips">${d.weekly.map(weeklyChip).join('')}</div></section>` : ''}
    <section class="card habit-add"><form class="form-row" data-form="add-habit"><label class="sr" for="new-habit">New habit</label><input class="input" id="new-habit" name="name" maxlength="80" placeholder="New habit, e.g. Read (20 min)" required>
      <label class="sr" for="new-habit-cadence">How often</label><select class="input" id="new-habit-cadence" name="cadence" style="flex:0 0 120px"><option value="daily">Daily</option><option value="weekly">Weekly</option></select><button class="btn primary">Add habit</button></form></section>
    <section class="card"><div class="card-head"><h2>Last 4 weeks</h2><span class="muted">${short(h.from)} – today</span></div>
      <div class="table-wrap"><div class="heat">${dailies.map((x) => `${name(x)}${days.map((dd) => `<span class="cell${set.has(x.id + '|' + dd) ? ' on' : ''}" title="${esc(x.name)} · ${short(dd)}"></span>`).join('')}${acts(x, 'weekly')}`).join('')}</div></div></section>
    ${weeklies.length ? `<section class="card"><div class="card-head"><h2>Weekly · last 12 weeks</h2><span class="muted">Week of ${short(h.weeksFrom)} – this week</span></div>
      <div class="table-wrap"><div class="heat heat-wk">${weeklies.map((x) => `${name(x)}${weeks.map((ws) => { const on = doneIn(x, ws); return `<span class="cell${on.length ? ' on' : ''}" title="${esc(x.name)} · week of ${short(ws)}${on.length ? ` · done ${fmtDay(on[on.length - 1], { weekday: 'short', month: 'short', day: 'numeric' })}` : ''}"></span>`; }).join('')}${acts(x, 'daily')}`).join('')}</div></div></section>` : ''}
  </div>`;
}

async function viewGarage(view) {
  const { vehicles, logs } = await api('/api/garage');
  view.innerHTML = `
    <header class="head"><div><h1>Garage</h1><div class="sub">${vehicles.length} vehicles</div></div></header>
    <div class="grid-auto">${vehicles.map((v) => `<section class="card"><h2 style="font-size:40px;letter-spacing:-0.02em">${esc(v.name)}</h2>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px">
        <div><div class="muted" style="font-size:12px">Mileage</div><strong>${v.mileage ? v.mileage.toLocaleString() + ' mi' : '—'}</strong></div>
        <div><div class="muted" style="font-size:12px">Plate</div><strong>${esc(v.plate || '—')}</strong></div>
        <div><div class="muted" style="font-size:12px">Purchased</div><strong>${v.purchase_date ? esc(fmtDay(v.purchase_date, { month: 'short', year: 'numeric' })) : '—'}</strong></div>
        <div><div class="muted" style="font-size:12px">Insurance until</div><strong>${v.insurance_until ? esc(fmtDay(v.insurance_until, { month: 'short', day: 'numeric', year: 'numeric' })) : '—'}</strong></div>
      </div>
      <div class="group-title"><span>Log</span></div>
      ${logs.filter((l) => l.vehicle_id === v.id).map((l) => `<div class="row"><span class="tag">${esc(l.kind)}</span><span class="grow">${esc(l.title)}${l.notes ? `<span class="meta">${esc(l.notes)}</span>` : ''}</span><span class="when muted">${l.cost != null ? '$' + Number(l.cost).toLocaleString() + ' · ' : ''}${l.day ? esc(fmtDay(l.day, { month: 'short', day: 'numeric', year: 'numeric' })) : ''}</span></div>`).join('') || '<div class="muted">No entries yet.</div>'}
    </section>`).join('')}</div>
    <section class="card"><h2 style="margin-bottom:10px">Add a log entry</h2><form class="form-row" data-form="add-log">
      <label class="sr" for="lg-v">Vehicle</label><select id="lg-v" class="input" name="vehicle_id" style="flex:0 1 140px">${vehicles.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select>
      <label class="sr" for="lg-k">Type</label><select id="lg-k" class="input" name="kind" style="flex:0 1 160px"><option value="maintenance">Maintenance</option><option value="ticket">Ticket</option><option value="insurance">Insurance</option></select>
      <label class="sr" for="lg-t">What</label><input id="lg-t" class="input" name="title" placeholder="Oil change, tint, ticket…" required>
      <label class="sr" for="lg-d">Date</label><input id="lg-d" class="input" type="date" name="day" style="flex:0 1 160px">
      <label class="sr" for="lg-c">Cost</label><input id="lg-c" class="input" name="cost" inputmode="decimal" placeholder="Cost" style="flex:0 1 110px">
      <label class="sr" for="lg-m">Mileage</label><input id="lg-m" class="input" name="mileage" inputmode="numeric" placeholder="Mileage" style="flex:0 1 120px">
      <button class="btn primary">Add</button></form></section>`;
}
async function viewRecipes(view) {
  const { recipes } = await api('/api/recipes');
  view.innerHTML = `<header class="head"><div><h1>Recipes</h1><div class="sub">Your recipes, all in one place.</div></div></header>
    <div class="recipe-grid">${recipes.map((r) => `<article class="card recipe-card">
      <h2>${esc(r.name)}</h2>
      ${r.time || r.servings ? `<div class="recipe-meta">${[r.time, r.servings].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
      ${r.description ? `<p class="recipe-description">${esc(r.description)}</p>` : ''}
      <div class="recipe-actions"><button class="recipe-link" data-action="recipe-view" data-id="${esc(r.id)}" aria-label="View ${esc(r.name)}">View recipe</button><button class="recipe-link recipe-edit" data-action="recipe-edit" data-id="${esc(r.id)}" aria-label="Edit ${esc(r.name)}">Edit</button></div>
    </article>`).join('')}
    <button class="card recipe-card recipe-add" data-action="recipe-add"><span class="recipe-plus" aria-hidden="true">+</span><strong>Add recipe</strong><small>Save something worth making again.</small></button></div>`;
}

// The native dialog keeps recipe drafts open if saving fails.
function openRecipe(recipe = null, edit = true) {
  const dlg = $('#recipe-dialog'), form = $('#recipe-form');
  form.reset();
  form.elements.name.setCustomValidity('');
  dlg.dataset.id = recipe?.id || '';
  for (const name of ['name', 'time', 'servings', 'description', 'ingredients', 'instructions']) form.elements[name].value = recipe?.[name] || '';
  $('#recipe-title').textContent = edit ? (recipe ? 'Edit recipe' : 'Add recipe') : recipe.name;
  $('#recipe-fields').hidden = !edit;
  form.elements.name.required = edit;
  $('#recipe-reader').hidden = edit;
  $('#recipe-reader').innerHTML = recipe && !edit ? `
    <p class="recipe-meta">${[recipe.time, recipe.servings].filter(Boolean).map(esc).join(' · ')}</p>
    ${recipe.description ? `<p class="recipe-text muted">${esc(recipe.description)}</p>` : ''}
    <h3>Ingredients</h3><p class="recipe-text">${esc(recipe.ingredients || 'No ingredients added yet.')}</p>
    <h3>Instructions</h3><p class="recipe-text">${esc(recipe.instructions || 'No instructions added yet.')}</p>` : '';
  $('#recipe-save').hidden = !edit;
  $('#recipe-edit').hidden = edit;
  $('#recipe-remove').hidden = !recipe;
  $('#recipe-remove').textContent = 'Remove';
  delete $('#recipe-remove').dataset.armed;
  $('#recipe-close').textContent = edit ? 'Cancel' : 'Close';
  $('#recipe-error').hidden = true;
  if (!dlg.open) dlg.showModal();
  if (edit) form.elements.name.focus();
}
$('#recipe-close').onclick = () => $('#recipe-dialog').close();
$('#recipe-edit').onclick = () => openRecipe({ id: $('#recipe-dialog').dataset.id, ...Object.fromEntries(new FormData($('#recipe-form'))) });
$('#recipe-form').onsubmit = async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget, dlg = $('#recipe-dialog'), data = Object.fromEntries(new FormData(form));
  if (!data.name.trim()) { form.elements.name.setCustomValidity('Enter a recipe name.'); form.elements.name.reportValidity(); return; }
  const controls = $$('button, input, textarea', form);
  controls.forEach((el) => { el.disabled = true; });
  dlg.dataset.busy = '1';
  $('#recipe-error').hidden = true;
  try {
    await api('/api/recipes' + (dlg.dataset.id ? '/' + dlg.dataset.id : ''), { method: dlg.dataset.id ? 'PUT' : 'POST', body: data });
    dlg.close(); toast('Recipe saved'); await render();
  } catch (e) { $('#recipe-error').textContent = e.message; $('#recipe-error').hidden = false; }
  finally { controls.forEach((el) => { el.disabled = false; }); delete dlg.dataset.busy; }
};
$('#recipe-form').elements.name.oninput = (ev) => ev.target.setCustomValidity('');
$('#recipe-dialog').addEventListener('cancel', (ev) => { if (ev.currentTarget.dataset.busy) ev.preventDefault(); });
$('#recipe-remove').onclick = async () => {
  const button = $('#recipe-remove'), dlg = $('#recipe-dialog');
  if (!button.dataset.armed) { button.dataset.armed = '1'; button.textContent = 'Confirm removal'; return; }
  const buttons = $$('button', dlg);
  buttons.forEach((b) => { b.disabled = true; }); dlg.dataset.busy = '1';
  try {
    await api('/api/recipes/' + dlg.dataset.id, { method: 'DELETE' });
    dlg.close(); toast('Recipe removed'); await render();
  } catch (e) { $('#recipe-error').textContent = e.message; $('#recipe-error').hidden = false; }
  finally { buttons.forEach((b) => { b.disabled = false; }); delete dlg.dataset.busy; }
};

function wishMediaFields(item = {}) {
  return `<label>Links (one per line)<textarea class="input" name="links" rows="2" placeholder="https://…">${esc((item.links || []).join('\n'))}</textarea></label>
    <label>Image URLs (one per line)<textarea class="input" name="image_urls" rows="2" placeholder="https://…">${esc((item.images || []).filter(i => !i.startsWith('data:')).join('\n'))}</textarea></label>
    ${(item.images || []).filter(i => i.startsWith('data:')).map(i => `<label class="wish-keep"><input type="checkbox" name="keep_image" value="${esc(i)}" checked><img src="${esc(i)}" alt="Saved image" loading="lazy">Keep image</label>`).join('')}
    <label>Add images<input class="input" type="file" name="uploads" accept="image/png,image/jpeg,image/webp,image/gif" multiple><span class="meta">Up to 6 images. Large photos are shrunk to fit.</span></label>`;
}
// Uploaded images live in the item's database row (capped by the server), so shrink each one to fit `budget` characters.
async function shrinkImage(file, budget) {
  const read = () => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('Could not read image')); r.readAsDataURL(file); });
  if (file.size * 1.37 < budget && file.type === 'image/gif') return read(); // small GIFs stay animated
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error(`Could not open ${file.name}. Try a JPEG or PNG.`); }
  const canvas = document.createElement('canvas');
  for (let max = 1600, quality = 0.85; max >= 200; max = Math.round(max * 0.75), quality = Math.max(0.6, quality - 0.08)) {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/webp', quality);
    const out = url.startsWith('data:image/webp') ? url : canvas.toDataURL('image/jpeg', quality); // Safari < 17 can't encode WebP
    if (out.length <= budget) return out;
  }
  throw new Error(`${file.name} is too detailed to fit. Use an image URL instead.`);
}
const WISH_STATUSES = ['Searching', 'Waiting for discount', 'Saving money', 'Bought', 'Gave up'];
const WISH_STYLES = {
  'budget-classic': 'Budget classic', 'image-first': 'Image first', 'compact-horizontal': 'Compact horizontal',
  editorial: 'Editorial', 'split-panel': 'Split panel', 'text-only': 'Text only',
  'photo-showcase': 'Photo showcase', 'price-first': 'Price first', gallery: 'Gallery', 'status-led': 'Status led',
};
state.wishStyle = 'budget-classic';
try {
  const saved = localStorage.getItem('batcave-wish-style');
  if (Object.hasOwn(WISH_STYLES, saved)) state.wishStyle = saved;
} catch { /* storage unavailable */ }

async function viewWishlist(view) {
  const { items, members, own } = await api('/api/wishlist');
  const f = state.wishFilter;
  const shown = items.filter((i) => f === 'All' || i.status === f);
  const cats = [...new Set(shown.map((i) => i.category || 'Other'))].sort();
  view.innerHTML = `
    <header class="head sharing-head"><div><h1>Wishlist</h1><div class="sub">${items.filter((i) => !['Bought', 'Gave up'].includes(i.status)).length} things you want · ${members.length ? 'shared with ' + members.map(esc).join(', ') : 'private'}</div></div><div class="actions"><button class="btn primary" type="button" data-action="wish-add" aria-haspopup="dialog" aria-controls="wish-add-dialog">Add item</button></div></header>
    <dialog id="wish-add-dialog" aria-labelledby="wish-add-title"><form data-form="add-wish">
      <h2 id="wish-add-title">Add wishlist item</h2>
      <label for="w-n">Item<input id="w-n" class="input" name="name" placeholder="What are you wishing for?" maxlength="300" required autofocus></label>
      <label for="w-c">Category<input id="w-c" class="input" name="category" placeholder="Category" list="wish-cats" maxlength="60"></label><datalist id="wish-cats">${[...new Set(items.map((i) => i.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <label for="w-p">Price<input id="w-p" class="input" name="price" type="number" min="0" step="any" inputmode="decimal" placeholder="Optional"></label>
      <details class="wish-media"><summary>Add images and links</summary><div class="wish-fields">${wishMediaFields()}</div></details>
      <p data-wish-error role="alert" hidden></p>
      <div class="form-row"><button class="btn" type="button" data-action="wish-add-cancel">Cancel</button><button class="btn primary" type="submit">Add item</button></div>
    </form></dialog>
    <div class="wish-toolbar"><div class="chips" role="group" aria-label="Status">${[...WISH_STATUSES, 'All'].map((s) => `<button class="chip${f === s ? ' on' : ''}" data-action="wish-filter" data-filter="${esc(s)}" aria-pressed="${f === s}">${esc(s)}</button>`).join('')}</div>
      <label class="wish-style-label" for="wish-style">Card style<select id="wish-style" class="input" data-action="wish-style">${Object.entries(WISH_STYLES).map(([value, label]) => `<option value="${value}"${state.wishStyle === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label></div>
    <div id="wish-list" data-style="${state.wishStyle}">
      ${cats.map((c, index) => `<section class="wish-category" aria-labelledby="wish-category-${index}"><h2 id="wish-category-${index}">${esc(c)} <span class="muted">(${shown.filter((i) => (i.category || 'Other') === c).length})</span></h2><div class="wish-grid">${shown.filter((i) => (i.category || 'Other') === c).map((i) => `<article class="wish-item" aria-labelledby="wish-title-${esc(i.id)}">
        <div class="wish-title"><span class="wish-category-label">${esc(c)}</span><h3 id="wish-title-${esc(i.id)}">${i.links?.length ? `<a href="${esc(i.links[0])}" target="_blank" rel="noopener noreferrer">${esc(i.name)}</a>` : esc(i.name)}</h3></div>
        ${i.price != null ? `<span class="wish-price">${Number(i.price).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</span>` : ''}
        <label class="wish-status"><span class="sr">Status for ${esc(i.name)}</span><select class="input" data-action="wish-status" data-id="${esc(i.id)}" data-prev="${esc(i.status)}">${WISH_STATUSES.map((s) => `<option${s === i.status ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
        ${i.images?.length ? `<div class="wish-images">${i.images.map(src => `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer"><img src="${esc(src)}" alt="${esc(i.name)}" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div>` : ''}
        ${i.notes ? `<p class="wish-notes">${esc(i.notes)}</p>` : ''}
        ${i.links?.length ? `<div class="wish-links">${i.links.map((url, index) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(new URL(url).hostname)}${i.links.length > 1 ? ' · ' + (index + 1) : ''}</a>`).join('')}</div>` : ''}
        <details class="wish-edit"><summary>Edit item, images and links</summary><form class="wish-fields" data-form="edit-wish" data-id="${esc(i.id)}">
          <label>Item<input class="input" name="name" value="${esc(i.name)}" maxlength="300" required></label>
          <label>Category<input class="input" name="category" value="${esc(i.category || '')}" maxlength="60"></label>
          <label>Price<input class="input" name="price" value="${esc(i.price ?? '')}" type="number" min="0" step="any"></label>
          ${wishMediaFields(i)}<button class="btn primary">Save</button></form></details></article>`).join('')}</div></section>`).join('') || '<section class="card"><div class="empty">Nothing here.</div></section>'}
    </div>
    <details class="card sharing-settings"><summary>Sharing settings</summary><h2>${members.length ? 'Shared wishlist' : 'Share this wishlist'}</h2>
      <p>${members.length ? `You and ${members.map(esc).join(', ')} can add and edit everything on this wishlist.` : 'This wishlist is private. Invite someone with a Batcave account to add and edit items together.'}</p>
      <p class="muted">Wishlist sharing is separate from Eating Out. One wishlist is open at a time. Joining keeps your private wishlist saved.</p>
      <div class="form-row"><button class="btn" data-action="wish-share">${members.length ? 'Invite another person' : 'Make a share code'}</button>${members.length || !own ? `<button class="btn" data-action="wish-leave">${own ? 'Stop sharing' : 'Return to my wishlist'}</button>` : ''}</div>
      ${!members.length && own ? '<details style="margin-top:12px"><summary>Join someone’s wishlist</summary><p>Your private items stay in your own wishlist; they are not added to theirs.</p><form class="form-row" data-form="wish-join"><label class="sr" for="wish-code">Wishlist code</label><input id="wish-code" class="input" name="code" placeholder="Wishlist share code" required><button class="btn">Join wishlist</button></form></details>' : ''}
    </details>`;
}
// ---------- eating out ----------
const EAT_FILTERS = [['want', 'Want to go'], ['been', 'Been'], ['all', 'All']];
async function viewEating(view) {
  const { places, dishes, members, today, photos_enabled } = await api('/api/eating');
  const f = state.eatFilter, shown = places.filter((p) => f === 'all' || p.status === f);
  const day = (d) => esc(fmtDay(d, { month: 'short', day: 'numeric', year: 'numeric' }));
  view.innerHTML = `
    <header class="head sharing-head"><div><h1>Eating out</h1><div class="sub">${places.filter((p) => p.status === 'want').length} to try · ${places.filter((p) => p.status === 'been').length} been${members.length ? ` · shared with ${members.map(esc).join(', ')}` : ''}</div></div></header>
    <dialog class="place-picker" id="place-picker" aria-labelledby="place-picker-title">
      <div class="card-head"><h2 id="place-picker-title">Add an address</h2><button class="btn small" type="button" data-map-close aria-label="Close address search">Close</button></div>
      <form class="form-row"><label class="sr" for="place-query">Business name or address</label><input id="place-query" class="input" name="query" placeholder="Business name, or name + city" minlength="2" maxlength="200" required><button class="btn primary" type="submit">Search</button><button class="btn" type="button" data-map-nearby>Near me</button></form>
      <p class="place-map-status muted" data-map-status role="status">Loading map…</p>
      <div class="place-map" data-place-map aria-label="Business map"></div>
      <div class="place-results" data-map-results aria-label="Search results"></div>
      <p class="place-map-credit">Search by <a href="https://photon.komoot.io/" target="_blank" rel="noopener noreferrer">Photon</a> and <a href="https://data.cityofnewyork.us/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/43nn-pn8j" target="_blank" rel="noopener noreferrer">NYC Open Data</a> · <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener noreferrer">Report a map issue</a></p>
    </dialog>
    <section class="card"><form class="form-row" data-form="add-place"><label class="sr" for="pl-n">Place</label><input id="pl-n" class="input" name="name" placeholder="Add a place…" required>
      <label class="sr" for="pl-c">Cuisine</label><input id="pl-c" class="input" name="cuisine" placeholder="Cuisine" list="eat-cuisines" style="flex:0 1 160px"><datalist id="eat-cuisines">${[...new Set(places.map((p) => p.cuisine).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <label class="sr" for="pl-a">Area</label><input id="pl-a" class="input" name="area" placeholder="Area" style="flex:0 1 160px">
      <label class="sr" for="pl-s">Status</label><select id="pl-s" class="input" name="status" style="flex:0 1 140px"><option value="want">Want to go</option><option value="been">Been</option></select>
      <button class="btn" type="button" data-map-open aria-haspopup="dialog" aria-controls="place-picker">Add address</button><button class="btn primary">Add</button></form><p class="place-picked muted" data-map-picked role="status"></p></section>
    <div class="chips" role="group" aria-label="Show">${EAT_FILTERS.map(([v, label]) => `<button class="chip${f === v ? ' on' : ''}" data-action="eat-filter" data-filter="${v}" aria-pressed="${f === v}">${label}</button>`).join('')}</div>
    ${shown.length ? `<div class="grid-auto">${shown.map((p) => `<section class="card">
      ${photos_enabled ? `<figure class="place-photo" data-place-photo="${esc(p.id)}" aria-label="${esc(p.name)} photo"><span class="place-photo-empty">Business photo</span></figure>` : ''}
      <div class="card-head"><div><h2>${esc(p.name)}</h2>${p.cuisine || p.area ? `<div class="muted" style="font-size:13px">${[p.cuisine, p.area].filter(Boolean).map(esc).join(' · ')}</div>` : ''}</div>
        <label class="sr" for="ps-${esc(p.id)}">Status</label><select id="ps-${esc(p.id)}" class="input" style="min-height:34px;flex:0 0 auto;width:auto" data-action="place-status" data-id="${esc(p.id)}" data-prev="${esc(p.status)}"><option value="want"${p.status === 'want' ? ' selected' : ''}>Want to go</option><option value="been"${p.status === 'been' ? ' selected' : ''}>Been</option></select></div>
      ${p.address ? `<p class="place-address muted">${esc(p.address)}</p>` : ''}
      <details class="eat-details"><summary>Edit place</summary><form class="form-row eat-edit" data-form="edit-place" data-id="${esc(p.id)}">
        <label>Name<input class="input" name="name" value="${esc(p.name)}" maxlength="300" required></label><label>Cuisine<input class="input" name="cuisine" value="${esc(p.cuisine || '')}" maxlength="60"></label>
        <label>Area<input class="input" name="area" value="${esc(p.area || '')}" maxlength="120"></label><label>Address<input class="input" name="address" value="${esc(p.address || '')}" maxlength="500"></label>
        <button class="btn primary">Save</button><button class="btn red" type="button" data-action="eat-place-remove" data-id="${esc(p.id)}">Remove place</button></form></details>
      ${dishes.filter((d) => d.place_id === p.id).map((d) => `<div class="eat-dish"><div class="row"><span class="grow">${esc(d.name)}${d.notes ? `<span class="meta">${esc(d.notes)}</span>` : ''}</span><span class="when muted">${d.day ? day(d.day) : ''}</span><button class="btn small" data-action="eat-dish-edit" data-id="${esc(d.id)}" aria-label="Edit ${esc(d.name)} and date">Edit</button></div>
        <form class="form-row eat-edit" id="dish-edit-${esc(d.id)}" data-form="edit-dish" data-id="${esc(d.id)}" hidden><label>Dish<input class="input" name="name" value="${esc(d.name)}" maxlength="300" required></label><label>Notes<input class="input" name="notes" value="${esc(d.notes || '')}" maxlength="2000"></label><label>Date<input class="input" type="date" name="day" value="${esc(d.day || today)}" required></label><button class="btn primary">Save</button><button class="btn" type="button" data-action="eat-dish-edit" data-id="${esc(d.id)}">Cancel</button><button class="btn red" type="button" data-action="eat-dish-remove" data-id="${esc(d.id)}">Remove dish</button></form></div>`).join('') || (p.status === 'been' ? '<div class="muted">No dishes logged yet.</div>' : '')}
      <form class="form-row" data-form="add-dish" data-id="${esc(p.id)}" data-status="${esc(p.status)}" style="margin-top:10px"><label class="sr" for="dn-${esc(p.id)}">Dish</label><input id="dn-${esc(p.id)}" class="input" name="name" placeholder="What did you eat?" required>
        <label class="sr" for="dt-${esc(p.id)}">Notes</label><input id="dt-${esc(p.id)}" class="input" name="notes" placeholder="Notes"><label class="eat-date">Date<input class="input" type="date" name="day" value="${esc(today)}" required></label><button class="btn">Log</button></form>
    </section>`).join('')}</div>` : '<section class="card"><div class="empty">Nothing here.</div></section>'}
    <details class="card sharing-settings"><summary>Sharing settings</summary><h2 style="margin-bottom:6px">Share this list</h2>
      <p class="muted" style="margin:0 0 10px">${members.length ? `You and ${members.map(esc).join(', ')} see and edit this entire Eating Out list. New codes invite more people to this same list.` : 'This Eating Out list is private. A one-time code lets someone with an account join it and edit the same places and dishes.'}</p>
      <p class="muted">You have one Eating Out list at a time. Separate lists with different people are not supported. Sharing this list does not share your other tabs.</p>
      <div class="form-row"><button class="btn" data-action="eat-share">${members.length ? 'Invite another person' : 'Make a share code'}</button>${members.length ? '<button class="btn" data-action="eat-leave">Leave shared list</button>' : ''}</div>
      ${members.length ? '<p class="muted">To join a different list, leave this one first. Leaving keeps its places with the others and starts an empty private list.</p>' : '<details style="margin-top:12px"><summary>Join someone’s Eating Out list</summary><p>Your current places will move into their list and become visible to everyone on it.</p><form class="form-row" data-form="eat-join"><label class="sr" for="eat-code">Share code</label><input id="eat-code" class="input" name="code" placeholder="Eating Out share code" autocapitalize="characters" required><button class="btn">Join list</button></form></details>'}
    </details>`;
  const cleanupMap = setupPlaceMap($('#place-picker'), api, esc);
  const cleanupPhotos = setupPlacePhotos(view, api, esc);
  state.eatingCleanup = () => { cleanupMap(); cleanupPhotos(); };
}
async function viewSpending(view) {
  await renderBudgetApp(view, { api, esc, toast });
}

// ---------- sessions (transcripts summarized into your notes) ----------
const TS_STATUS = { new: ['Waiting', ''], summarizing: ['Summarizing…', ''], ready: ['Ready for notes', 'amber'], filed: ['In notes', 'green'], error: ['Problem', 'red'], dismissed: ['Dismissed', ''] };
const TS_FILTERS = [['all', 'All', 'new,summarizing,ready,filed,error'], ['waiting', 'Not in notes yet', 'new,summarizing,ready'], ['filed', 'In notes', 'filed'], ['problems', 'Problems', 'error'], ['dismissed', 'Dismissed', 'dismissed']];
const fmtWall = (w) => (w ? `${fmtDay(w.slice(0, 10), { month: 'short', day: 'numeric' })} · ${fmtTime(w.slice(11, 16))}` : '');
const tsBadge = (t) => { const [label, cls] = TS_STATUS[t.status] || [t.status, '']; return `<span class="badge ${cls}">${esc(label)}</span>`; };
const tsTitle = (t) => t.title || t.hint_title || (t.status === 'error' ? 'Could not summarize' : 'Summarizing…');
// Re-check while something is still being summarized.
function tsPoll(pending) {
  clearTimeout(state.tsPoll);
  if (pending) state.tsPoll = setTimeout(() => { if (location.hash.startsWith('#/sessions')) render(); }, 5000);
}
function tsTargetSelect(t, targets, id) {
  return `<label class="sr" for="${id}">Note</label><select id="${id}" class="input" data-action="ts-target" data-id="${esc(t.id)}" data-prev="${esc(t.target || '')}" style="flex:0 1 260px">
    <option value="">No note (daily note only)</option>${targets.map((x) => `<option value="${esc(x.name)}"${x.name === t.target ? ' selected' : ''}>${esc(x.name)}${x.kind ? ` · ${esc(x.kind)}` : ''}</option>`).join('')}</select>`;
}
function tsActions(t) {
  return [
    t.status === 'error' ? `<button class="btn small" data-action="ts-retry" data-id="${esc(t.id)}">Retry</button>` : '',
    t.status === 'dismissed' ? `<button class="btn small" data-action="ts-restore" data-id="${esc(t.id)}" data-name="${esc(tsTitle(t))}">Restore</button>`
      : `<button class="btn small" data-action="ts-dismiss" data-id="${esc(t.id)}" data-name="${esc(tsTitle(t))}">Dismiss</button>`,
  ].join('');
}
async function viewSessions(view) {
  const f = TS_FILTERS.find((x) => x[0] === state.tsFilter) || TS_FILTERS[0];
  const { transcripts, counts, targets, targets_updated } = await api('/api/transcripts?status=' + f[2]);
  const n = (statuses) => statuses.split(',').reduce((a, s) => a + (counts[s] || 0), 0);
  view.innerHTML = `
    <header class="head"><div><h1>Sessions</h1><div class="sub">Transcripts of work and study sessions, summarized and sent to your notes</div></div></header>
    <section class="card"><details${n('new,summarizing,ready,filed,error,dismissed') ? '' : ' open'}><summary class="card-head" style="cursor:pointer;margin:0"><h2>Add a transcript</h2></summary>
      <form data-form="add-transcript"><label class="sr" for="ts-text">Transcript</label>
        <textarea id="ts-text" class="input ts-text" name="transcript" placeholder="Paste a chat or session transcript…" required></textarea>
        <div class="form-row"><label class="sr" for="ts-title">Title</label><input id="ts-title" class="input" name="title" maxlength="120" placeholder="Title (optional)">
          <label class="sr" for="ts-target">Note</label><select id="ts-target" class="input" name="target" style="flex:0 1 260px"><option value="">Let ${esc(CFG.assistant)} pick the note</option>${targets.map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('')}</select>
          <button class="btn primary">Send</button></div></form>
      ${targets.length ? '' : '<p class="muted" style="margin:10px 0 0">No notes to sort into yet. They show up once your notes bridge sends its list.</p>'}</details></section>
    <section class="card">
      <div class="chips" role="group" aria-label="Filter" style="margin-bottom:10px">${TS_FILTERS.map(([k, label, st]) => `<button class="chip${f[0] === k ? ' on' : ''}" data-action="ts-filter" data-filter="${k}" aria-pressed="${f[0] === k}">${label}${n(st) ? `<span class="chip-meta">${n(st)}</span>` : ''}</button>`).join('')}</div>
      ${transcripts.length ? transcripts.map((t) => `<div class="row">
        <span class="grow"><a href="#/sessions/${esc(t.id)}">${esc(tsTitle(t))}</a><span class="meta">${[t.target, t.summary?.category || t.kind, t.source, fmtWall(t.received_on)].filter(Boolean).map(esc).join(' · ')}</span></span>
        ${tsBadge(t)}${tsActions(t)}</div>`).join('') : `<div class="empty">${n('new,summarizing,ready,filed,error,dismissed') ? 'Nothing in this filter.' : 'No sessions yet. Paste a transcript above, or send one to /api/ingest/transcripts.'}</div>`}
      ${targets_updated ? `<p class="muted" style="margin:10px 0 0;font-size:12px">Notes list from your bridge, updated ${esc(new Date(targets_updated).toLocaleString('en-US', { timeZone: CFG.tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</p>` : ''}
    </section>`;
  tsPoll(transcripts.some((t) => t.status === 'new' || t.status === 'summarizing'));
}
async function viewSession(view, id) {
  const t = await api('/api/transcripts/' + encodeURIComponent(id));
  const s = t.summary || {};
  const list = (title, items) => (items?.length ? `<div class="group-title"><span>${title}</span></div><ul class="ts-list">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  const shown = (t.transcript || '').slice(0, 200000);
  view.innerHTML = `
    <header class="head"><div><div class="sub"><a href="#/sessions">Sessions</a> /</div><h1>${esc(tsTitle(t))}</h1></div>${tsBadge(t)}</header>
    <section class="card">
      <div class="ts-meta muted">${[s.category, s.kind || t.kind, t.source, fmtWall(t.received_on), `${(t.chars || 0).toLocaleString()} characters`].filter(Boolean).map(esc).join(' · ')}</div>
      ${t.status === 'ready' ? `<div class="form-row" style="margin-bottom:6px">${tsTargetSelect(t, t.targets || [], 'ts-move')}</div>` : t.target ? `<p style="margin:0 0 6px">Note: <strong>${esc(t.target)}</strong></p>` : ''}
      ${t.filed_path ? `<p class="muted" style="margin:0 0 6px">Saved to ${esc(t.filed_path)}${fmtWall(t.filed_at) ? ` · ${esc(fmtWall(t.filed_at))}` : ''}</p>` : ''}
      ${t.error ? `<p class="ts-error">${esc(t.error)}</p>` : ''}
      ${s.summary ? `<p class="ts-summary">${esc(s.summary)}</p>` : t.status === 'new' || t.status === 'summarizing' ? '<p class="muted">Summarizing…</p>' : ''}
      ${list('What changed', s.changed)}${list('Decisions', s.decisions)}${list('Next steps', s.next)}
      ${list('What I covered', s.covered)}${list('Key ideas', s.key_ideas)}${list('Still unclear', s.unclear)}${list('Review next', s.review)}
      ${list('Concepts', s.concepts)}${list('Links', s.links)}
      <div class="ts-actions">${tsActions(t)}${t.status === 'ready' ? `<button class="btn small" data-action="ts-again" data-id="${esc(t.id)}">Summarize again</button>` : ''}</div>
    </section>
    <section class="card"><details><summary class="card-head" style="cursor:pointer;margin:0"><h2>Transcript</h2></summary>
      ${t.transcript ? `<pre class="ts-pre">${esc(shown)}${t.transcript.length > shown.length ? '\n\n[…]' : ''}</pre>` : '<p class="muted">Removed after it was saved to your notes.</p>'}</details></section>`;
  tsPoll(t.status === 'new' || t.status === 'summarizing');
}

// ---------- router ----------
const ROUTES = { '': viewCommand, deadlines: viewDeadlines, inbox: viewInbox, projects: viewProjects, daily: viewDaily, sessions: viewSessions, garage: viewGarage, wishlist: viewWishlist, spending: viewSpending, recipes: viewRecipes, eating: viewEating };
const render = createPageRenderer(renderPage, $('#view'));
async function renderPage() {
  state.eatingCleanup?.(); state.eatingCleanup = null;
  const [, page = '', arg] = location.hash.replace(/^#/, '').split('/');
  $$('.nav a, .tabbar a, .more-panel a').forEach((a) => { const p = a.getAttribute('href').replace(/^#\//, ''); if (p === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#tab-more').classList.toggle('on', ['projects', 'sessions', 'garage', 'wishlist', 'spending', 'recipes', 'eating'].includes(page));
  showMore(false);
  if (page) { state.homeEdit = false; $('#wg-bar').hidden = true; }
  lastRender = Date.now();
  const view = $('#view');
  try {
    if (page === 'projects' && arg) await viewProject(view, decodeURIComponent(arg));
    else if (page === 'sessions' && arg) await viewSession(view, decodeURIComponent(arg));
    else await (ROUTES[page] || viewCommand)(view);
  } catch (e) {
    view.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p><button class="btn" data-action="reload">Try again</button></div>`;
  }
}

// ---------- actions ----------
const rerender = () => setTimeout(render, 250);
document.addEventListener('change', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id;
  try {
    if (el.dataset.action === 'done') {
      const title = el.closest('.row')?.querySelector('.grow')?.firstChild?.textContent?.trim() || 'task';
      const set = (status) => api('/api/tasks/' + id, { method: 'PATCH', body: { status } });
      const [to, from] = el.checked ? ['done', 'open'] : ['open', 'done'];
      await set(to);
      remember(`${to === 'done' ? 'Done' : 'Reopened'}: ${title}`, () => set(from), () => set(to));
      rerender();
    }
    if (el.dataset.action === 'habit') {
      const name = el.closest('.chip')?.querySelector('span')?.textContent.trim() || 'habit';
      const day = state.dash?.now?.date;
      const toggle = () => api(`/api/habits/${id}/toggle`, { method: 'POST', body: day ? { day } : {} });
      await toggle();
      el.closest('.chip')?.classList.toggle('on', el.checked);
      remember(`${el.checked ? 'Checked' : 'Unchecked'}: ${name}${el.dataset.weekly ? ' (this week)' : ''}`, toggle, toggle);
      refreshDash().then(() => { if (!location.hash || location.hash === '#/' || el.dataset.weekly) rerender(); });
    }
    if (el.dataset.action === 'cal-show') {
      await api('/api/google/calendars', { method: 'POST', body: { id: el.dataset.id, shown: el.checked } });
      await loadWeek(state.weekStart); await showCalendarPicker(true);
    }
    if (el.dataset.action === 'wish-style' && Object.hasOwn(WISH_STYLES, el.value)) {
      state.wishStyle = el.value;
      $('#wish-list').dataset.style = el.value;
      try { localStorage.setItem('batcave-wish-style', el.value); } catch { /* storage unavailable */ }
    }
    if (el.dataset.action === 'wish-status') {
      const prev = el.dataset.prev, next = el.value;
      const set = (status) => api('/api/wishlist/' + id, { method: 'PATCH', body: { status } });
      await set(next);
      el.dataset.prev = next;
      remember(`Status: ${next}`, () => set(prev), () => set(next));
    }
    if (el.dataset.action === 'place-status') {
      const prev = el.dataset.prev, next = el.value;
      const set = (status) => api('/api/eating/' + id, { method: 'PATCH', body: { status } });
      await set(next);
      el.dataset.prev = next;
      remember(next === 'been' ? 'Marked as been' : 'Back on the want-to-go list', () => set(prev), () => set(next));
      rerender();
    }
    if (el.dataset.action === 'ts-target') {
      const prev = el.dataset.prev, next = el.value;
      const set = (target) => api('/api/transcripts/' + id, { method: 'PATCH', body: { target } });
      await set(next);
      el.dataset.prev = next;
      remember(next ? `Will go to ${next}` : 'Will go to the daily note only', () => set(prev), () => set(next));
    }
  } catch (e) { toast(e.message); }
});
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('button[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  try {
    if (a === 'task-edit') {
      const { tasks } = await api('/api/tasks?view=' + (el.dataset.inbox ? 'inbox' : 'open'));
      const task = tasks.find((t) => t.id === el.dataset.id);
      if (task) { openTaskEditor(task, el); tkEditing.fromList = true; }
    }
    if (a === 'eat-dish-edit') { const form = $('#dish-edit-' + el.dataset.id); form.hidden = !form.hidden; }
    if (a === 'eat-place-remove' || a === 'eat-dish-remove') {
      if (!el.dataset.armed) { el.dataset.armed = '1'; el.textContent = a === 'eat-place-remove' ? 'Confirm removal with dish history' : 'Confirm removal'; return; }
      el.disabled = true;
      try { await api('/api/eating/' + (a === 'eat-dish-remove' ? 'dishes/' : '') + el.dataset.id, { method: 'DELETE' }); toast('Removed'); await render(); }
      finally { el.disabled = false; }
    }
    if (a === 'weather-retry') await loadWeather();
    if (a === 'recipe-add') openRecipe();
    if (a === 'recipe-view' || a === 'recipe-edit') {
      el.disabled = true;
      try {
        const { recipe } = await api('/api/recipes/' + el.dataset.id);
        openRecipe(recipe, a === 'recipe-edit');
      } finally { el.disabled = false; }
    }
    if (a === 'week-prev') await loadWeek(addDays(state.weekStart, -7));
    if (a === 'week-next') await loadWeek(addDays(state.weekStart, 7));
    if (a === 'week-today') { state.weekStart = null; await loadWeek(null); }
    if (a === 'cal-picker') await showCalendarPicker($('#cal-pop')?.hidden);
    if (a === 'cal-sync') { await api('/api/google/sync', { method: 'POST', body: {} }); await showCalendarPicker(true); await loadWeek(state.weekStart); await showCalendarPicker(true); toast('Calendar list refreshed'); }
    if (a === 'cal-disconnect') {
      if (!el.dataset.armed) { el.dataset.armed = '1'; el.textContent = 'Click again to disconnect'; return; }
      await api('/api/google/disconnect', { method: 'POST', body: {} }); toast('Google Calendar disconnected'); await loadWeek(state.weekStart);
    }
    if (a === 'new') openQuick();
    if (a === 'reload') render();
    if (a === 'projects-edit') {
      state.projectEdit = !state.projectEdit;
      await render();
      if (state.projectEdit && !isPhone()) $('#new-project')?.focus();
    }
    if (a === 'project-delete') {
      const set = (archived) => api('/api/projects/' + el.dataset.id, { method: 'PATCH', body: { archived } });
      el.disabled = true;
      try {
        await set(true);
        remember(`Deleted ${el.dataset.name}`, () => set(false), () => set(true));
        await refreshDash();
        await render();
      } finally { el.disabled = false; }
    }
    if (a === 'habits-edit') {
      state.habitEdit = !state.habitEdit;
      el.closest('.daily-page')?.classList.toggle('editing', state.habitEdit);
      el.textContent = state.habitEdit ? 'Done' : 'Edit';
      el.setAttribute('aria-pressed', String(state.habitEdit));
      if (state.habitEdit && !isPhone()) $('#new-habit')?.focus();
    }
    if (a === 'habit-cadence') {
      const to = el.dataset.to, from = to === 'weekly' ? 'daily' : 'weekly';
      const set = (cadence) => api('/api/habits/' + el.dataset.id, { method: 'PATCH', body: { cadence } });
      await set(to);
      remember(`${el.dataset.name} is now ${to}`, () => set(from), () => set(to));
      render();
    }
    if (a === 'habit-remove') {
      if (!el.dataset.armed) { el.dataset.armed = '1'; el.textContent = 'Remove?'; el.classList.add('armed'); setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.textContent = '×'; el.classList.remove('armed'); } }, 3000); return; }
      await api('/api/habits/' + el.dataset.id, { method: 'PATCH', body: { active: false } });
      toast(`Removed ${el.dataset.name}. Add it again to bring it back.`); render();
    }
    if (a === 'to-task') {
      const set = (kind) => api('/api/tasks/' + el.dataset.id, { method: 'PATCH', body: { kind } });
      await set('task');
      remember('Moved to Deadlines', () => set('inbox'), () => set('task'));
      rerender();
    }
    if (a === 'wish-add') $('#wish-add-dialog').showModal();
    if (a === 'wish-add-cancel') $('#wish-add-dialog').close();
    if (a === 'wish-filter') { state.wishFilter = el.dataset.filter; render(); }
    if (a === 'eat-share' || a === 'wish-share') {
      const { code } = await api(a === 'eat-share' ? '/api/eating/share' : '/api/wishlist/share', { method: 'POST' });
      let copied = false;
      try { await navigator.clipboard.writeText(code); copied = true; } catch {}
      el.textContent = `Code: ${code}${copied ? ' (copied)' : ''}`;
    }
    if (a === 'wish-leave') {
      if (!el.dataset.armed) { el.dataset.armed = '1'; el.textContent = 'Confirm? Everyone keeps their own wishlist'; setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; render(); } }, 4000); return; }
      await api('/api/wishlist/leave', { method: 'POST' });
      toast('Your own wishlist is open.'); render();
    }
    if (a === 'eat-leave') {
      if (!el.dataset.armed) { el.dataset.armed = '1'; el.textContent = 'Leave? The shared places stay with the others'; setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.textContent = 'Leave shared list'; } }, 4000); return; }
      await api('/api/eating/leave', { method: 'POST' });
      toast('Left the shared list. Ask for a new code to rejoin.'); render();
    }
    if (a === 'eat-filter') { state.eatFilter = el.dataset.filter; render(); }
    if (a === 'ts-filter') { state.tsFilter = el.dataset.filter; render(); }
    if (a === 'ts-retry' || a === 'ts-again') {
      el.disabled = true; el.textContent = 'Summarizing…';
      try { await api(`/api/transcripts/${el.dataset.id}/summarize`, { method: 'POST', body: { again: a === 'ts-again' } }); toast('Summarized'); }
      finally { render(); }
    }
    if (a === 'ts-dismiss' || a === 'ts-restore') {
      const set = (status) => api('/api/transcripts/' + el.dataset.id, { method: 'PATCH', body: { status } });
      const [to, back] = a === 'ts-dismiss' ? ['dismissed', 'restore'] : ['restore', 'dismissed'];
      await set(to);
      remember(`${a === 'ts-dismiss' ? 'Dismissed' : 'Restored'}: ${el.dataset.name}`, () => set(back), () => set(to));
      render();
    }
  } catch (e) { toast(e.message); }
});
document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form[data-form]');
  if (!form) return;
  ev.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  try {
    if (form.dataset.form === 'edit-place' || form.dataset.form === 'edit-dish') {
      const button = $('button[type="submit"], button:not([type])', form); button.disabled = true;
      try { await api('/api/eating/' + (form.dataset.form === 'edit-dish' ? 'dishes/' : '') + form.dataset.id, { method: 'PATCH', body: f }); toast('Saved'); await render(); }
      finally { button.disabled = false; }
      return;
    }
    if (form.dataset.form === 'add-project') {
      const button = $('button', form);
      button.disabled = true;
      try {
        const p = await api('/api/projects', { method: 'POST', body: { name: f.name } });
        const set = (archived) => api('/api/projects/' + p.id, { method: 'PATCH', body: { archived } });
        remember(`Added ${p.name}`, () => set(true), () => set(false));
        await refreshDash();
        await render();
        $('#new-project')?.focus();
      } finally { button.disabled = false; }
      return;
    }
    if (form.dataset.form === 'add-transcript') {
      const button = $('button', form);
      button.disabled = true;
      try {
        const r = await api('/api/transcripts', { method: 'POST', body: { transcript: f.transcript, title: f.title || undefined, target: f.target || undefined } });
        const set = (status) => api('/api/transcripts/' + r.id, { method: 'PATCH', body: { status } });
        remember('Sent. Summarizing…', () => set('dismissed'), () => set('restore'));
        state.tsFilter = 'all';
        await render();
      } finally { button.disabled = false; }
      return;
    }
    if (form.dataset.form === 'add-task') await api('/api/tasks', { method: 'POST', body: { title: f.title, project_id: f.project_id || null, due_at: f.due || null } });
    if (form.dataset.form === 'add-inbox') await api('/api/tasks', { method: 'POST', body: { title: f.title, kind: 'inbox' } });
    if (form.dataset.form === 'add-log') await api('/api/garage/logs', { method: 'POST', body: f });
    if (form.dataset.form === 'wish-join') {
      await api('/api/wishlist/join', { method: 'POST', body: f });
      toast('Shared wishlist is open. Your private items are saved.'); return render();
    }
    if (form.dataset.form === 'eat-join') {
      await api('/api/eating/join', { method: 'POST', body: f });
      toast('Joined. You now share this list.');
      return render();
    }
    if (form.dataset.form === 'add-place') {
      const location = form.dataset.latitude !== undefined ? { latitude: +form.dataset.latitude, longitude: +form.dataset.longitude, address: form.dataset.address } : {};
      await api('/api/eating', { method: 'POST', body: { ...f, ...location } });
      if (state.eatFilter !== 'all') state.eatFilter = f.status; // show the list the new place landed in
    }
    if (form.dataset.form === 'add-dish') {
      const pid = form.dataset.id, prev = form.dataset.status;
      let dishId = (await api(`/api/eating/${pid}/dishes`, { method: 'POST', body: f })).id;
      const undo = async () => { await api('/api/eating/dishes/' + dishId, { method: 'DELETE' }); await api('/api/eating/' + pid, { method: 'PATCH', body: { status: prev } }); };
      const redo = async () => { dishId = (await api(`/api/eating/${pid}/dishes`, { method: 'POST', body: f })).id; };
      remember(`Logged ${f.name}`, undo, redo);
      return render();
    }
    if (['add-wish', 'edit-wish'].includes(form.dataset.form)) {
      const button = $('button:not([type]), button[type="submit"]', form); button.disabled = true;
      try {
        const lines = value => (value || '').split('\n').map(s => s.trim()).filter(Boolean);
        const data = new FormData(form), files = data.getAll('uploads').filter(file => file.size);
        if (files.some(file => !file.type.startsWith('image/'))) throw new Error('Choose image files, or use image URLs.');
        const kept = data.getAll('keep_image'), budget = (650000 - kept.join('').length) / Math.max(files.length, 1);
        if (budget < 20000) throw new Error('Not enough room for more images on this item. Untick a saved image or use image URLs.');
        const uploads = await Promise.all(files.map(file => shrinkImage(file, budget)));
        const payload = { name: f.name, category: f.category, price: f.price, links: lines(f.links), images: [...kept, ...lines(f.image_urls), ...uploads] };
        const edit = form.dataset.form === 'edit-wish';
        await api('/api/wishlist' + (edit ? '/' + form.dataset.id : ''), { method: edit ? 'PATCH' : 'POST', body: payload });
        if (!edit) { $('#wish-add-dialog').close(); state.wishFilter = 'Searching'; }
        toast(edit ? 'Saved' : 'Added'); return render();
      } catch (error) {
        if (form.dataset.form === 'edit-wish') throw error;
        const message = $('[data-wish-error]', form); message.textContent = error.message; message.hidden = false;
      } finally { button.disabled = false; }
    }
    if (form.dataset.form === 'add-habit') {
      const r = await api('/api/habits', { method: 'POST', body: { name: f.name, cadence: f.cadence || 'daily' } });
      if (r.existed) { toast(`${r.name} is already on your ${r.cadence} list`); return; }
      if (r.moved) { toast(`${r.name} is now ${r.cadence}`); render(); return; }
    }
    toast('Added');
    render();
  } catch (e) { toast(e.message); }
});

// ---------- quick add (New button, N or ⌘K) ----------
function openQuick() {
  const dlg = $('#quick');
  const sel = $('select[name="project_id"]', dlg);
  if (state.dash) sel.innerHTML = '<option value="">Other</option>' + state.dash.allProjects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('#quick-form').reset();
  dlg.dataset.type = 'task';
  dlg.showModal();
  $('input[name="title"]', dlg).focus();
}
$('#quick-form').addEventListener('change', (ev) => { if (ev.target.name === 'type') $('#quick').dataset.type = ev.target.value; });
$('#quick-form').addEventListener('submit', async (ev) => {
  const btn = ev.submitter;
  if (!btn || btn.value !== 'save') return;
  ev.preventDefault();
  const f = Object.fromEntries(new FormData(ev.target));
  const due = f.due ? f.due + (f.time ? 'T' + f.time : '') : null;
  try {
    if (f.type === 'task' || f.type === 'inbox') await api('/api/tasks', { method: 'POST', body: { title: f.title, kind: f.type, project_id: f.project_id || null, due_at: due } });
    if (f.type === 'event') {
      if (!f.due) { toast('Pick a date for the event'); return; }
      await api('/api/calendar/events', { method: 'POST', body: { title: f.title, date: f.due, ...(f.time ? { start_time: f.time, ...(f.end ? { end_time: f.end } : {}) } : { all_day: true }) } });
    }
    if (f.type === 'wish') await api('/api/wishlist', { method: 'POST', body: { name: f.title } });
    $('#quick').close();
    toast(f.type === 'event' ? 'Added to Google Calendar' : 'Added');
    render();
  } catch (e) { toast(e.message); }
});
document.addEventListener('keydown', (ev) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); openQuick(); }
  else if (!typing && !ev.metaKey && !ev.ctrlKey && !ev.altKey && ev.key === 'n' && !$('#quick').open) { ev.preventDefault(); openQuick(); }
});

// ---------- assistant (bottom-left chat) ----------
const CHAT_KEY = 'batcave-chat';
const SUGGESTIONS = ['What should I work on right now?', 'What\'s due this week?', 'What does tomorrow look like?', 'Which habits haven\'t I done today?'];
const chat = { messages: [], busy: false };
try { chat.messages = JSON.parse(sessionStorage.getItem(CHAT_KEY) || '[]'); } catch { chat.messages = []; }
const saveChat = () => { try { sessionStorage.setItem(CHAT_KEY, JSON.stringify(chat.messages.slice(-40))); } catch { /* storage unavailable */ } };

// Escape first, then allow a tiny subset: paragraphs, "- " bullets, **bold**.
function richText(text) {
  const out = [];
  let list = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const fmt = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    if (bullet) { if (!list) { list = []; out.push(list); } list.push(fmt(bullet[1])); continue; }
    list = null;
    if (line) out.push(`<p>${fmt(line)}</p>`);
  }
  return out.map((x) => (Array.isArray(x) ? `<ul>${x.map((li) => `<li>${li}</li>`).join('')}</ul>` : x)).join('');
}
function renderChat() {
  const log = $('#chat-log');
  if (!chat.messages.length) {
    log.innerHTML = `<div class="chat-empty"><p>Ask about your week, or tell it to add, move or finish things.</p>${SUGGESTIONS.map((s) => `<button type="button" class="suggest" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
  } else {
    log.innerHTML = chat.messages.map((m) => {
      if (m.role === 'user') return `<div class="msg user">${richText(m.content)}</div>`;
      const acts = m.actions?.length ? `<ul class="acts">${m.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : '';
      return `<div class="msg ${m.error ? 'err' : 'bot'}">${richText(m.content)}${acts}</div>`;
    }).join('') + (chat.busy ? '<div class="typing" aria-label="Thinking"><span></span><span></span><span></span></div>' : '');
  }
  log.scrollTop = log.scrollHeight;
  $('#chat-send').disabled = chat.busy;
}
function openChat(open = true) {
  if (CFG.role === 'demo') return;
  const panel = $('#chat');
  panel.hidden = !open;
  showLayoutMenu(false);
  applyLayout();
  $('#ask-btn').setAttribute('aria-expanded', String(open));
  $('#ask-fab').setAttribute('aria-expanded', String(open));
  if (open) { renderChat(); $('#chat-input').focus(); } else (sidebarHidden() && !isPhone() ? $('#ask-fab') : $('#ask-btn')).focus();
}

// ---------- chat window: drag, resize, snap (desktop only) ----------
const LAYOUT_KEY = 'batcave-chat-layout';
const GAP = 12, MIN_W = 320, MIN_H = 360;
const DEFAULT_LAYOUT = { mode: 'corner', where: 'bl', x: GAP, y: GAP, w: 400, h: 620, dockW: 420, dockH: 320 };
const chatLayout = { ...DEFAULT_LAYOUT };
try { Object.assign(chatLayout, JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}')); } catch { /* storage unavailable */ }
const saveLayout = () => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(chatLayout)); } catch { /* ignore */ } };
const isPhone = () => matchMedia('(max-width: 820px)').matches;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const viewport = () => ({ vw: document.documentElement.clientWidth, vh: window.innerHeight });

function rectFor(l) {
  const { vw, vh } = viewport();
  const w = clamp(l.w, MIN_W, vw - 2 * GAP), h = clamp(l.h, MIN_H, vh - 2 * GAP);
  const dw = clamp(l.dockW, MIN_W, vw * 0.6), dh = clamp(l.dockH, 240, vh * 0.6);
  if (l.mode === 'dock') {
    if (l.where === 'left') return { x: 0, y: 0, w: dw, h: vh };
    if (l.where === 'right') return { x: vw - dw, y: 0, w: dw, h: vh };
    if (l.where === 'top') return { x: 0, y: 0, w: vw, h: dh };
    return { x: 0, y: vh - dh, w: vw, h: dh };
  }
  if (l.mode === 'corner') return { x: l.where.endsWith('l') ? GAP : vw - w - GAP, y: l.where.startsWith('t') ? GAP : vh - h - GAP, w, h };
  return { x: clamp(l.x, 0, vw - w), y: clamp(l.y, 0, vh - h), w, h };
}
const HANDLES = {
  dock: { left: ['e'], right: ['w'], top: ['s'], bottom: ['n'] },
  corner: { tl: ['s', 'e', 'se'], tr: ['s', 'w', 'sw'], bl: ['n', 'e', 'ne'], br: ['n', 'w', 'nw'] },
};
function applyLayout() {
  const panel = $('#chat'), root = document.documentElement.style;
  for (const k of ['l', 'r', 't', 'b']) root.removeProperty('--dock-' + k);
  if (isPhone()) { panel.removeAttribute('style'); delete panel.dataset.mode; delete panel.dataset.where; return; }
  const r = rectFor(chatLayout);
  Object.assign(panel.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', right: 'auto', bottom: 'auto' });
  panel.dataset.mode = chatLayout.mode;
  panel.dataset.where = chatLayout.mode === 'free' ? '' : chatLayout.where;
  if (!panel.hidden && chatLayout.mode === 'dock') root.setProperty('--dock-' + chatLayout.where[0], (chatLayout.where === 'left' || chatLayout.where === 'right' ? r.w : r.h) + 'px');
  const allowed = HANDLES[chatLayout.mode]?.[chatLayout.where] || ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  $$('.rz', panel).forEach((el) => { el.hidden = !allowed.includes(el.dataset.rz); });
}
function snapTarget(px, py) {
  const { vw, vh } = viewport(), E = 32, C = 150;
  const L = px <= E, R = px >= vw - E, T = py <= E, B = py >= vh - E;
  if ((L && py < C) || (T && px < C)) return { mode: 'corner', where: 'tl' };
  if ((R && py < C) || (T && px > vw - C)) return { mode: 'corner', where: 'tr' };
  if ((L && py > vh - C) || (B && px < C)) return { mode: 'corner', where: 'bl' };
  if ((R && py > vh - C) || (B && px > vw - C)) return { mode: 'corner', where: 'br' };
  if (L) return { mode: 'dock', where: 'left' };
  if (R) return { mode: 'dock', where: 'right' };
  if (T) return { mode: 'dock', where: 'top' };
  if (B) return { mode: 'dock', where: 'bottom' };
  return null;
}
function showSnap(target) {
  const box = $('#chat-snap');
  if (!target) { box.hidden = true; return; }
  const r = rectFor({ ...chatLayout, ...target });
  Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  box.dataset.mode = target.mode;
  box.hidden = false;
}
function snapTo(where) {
  if (where === 'center') {
    const { vw, vh } = viewport();
    Object.assign(chatLayout, { mode: 'free', x: (vw - chatLayout.w) / 2, y: (vh - chatLayout.h) / 2 });
  } else Object.assign(chatLayout, ['tl', 'tr', 'bl', 'br'].includes(where) ? { mode: 'corner', where } : { mode: 'dock', where });
  saveLayout(); applyLayout();
}
function showLayoutMenu(open) {
  const pop = $('#layout-pop');
  pop.hidden = !open;
  $('[data-chat="layout"]').setAttribute('aria-expanded', String(open));
  if (open) $('button', pop).focus();
}

let drag = null, resize = null;
const chatHead = $('.chat-head');
chatHead.addEventListener('pointerdown', (ev) => {
  if (isPhone() || ev.button !== 0 || ev.target.closest('button, .layout-pop')) return;
  ev.preventDefault(); // stops text selection / native drag from cancelling the pointer
  const r = $('#chat').getBoundingClientRect();
  const w = clamp(chatLayout.w, MIN_W, viewport().vw - 2 * GAP), h = clamp(chatLayout.h, MIN_H, viewport().vh - 2 * GAP);
  drag = { sx: ev.clientX, sy: ev.clientY, offX: Math.min(ev.clientX - r.left, w - 60), offY: ev.clientY - r.top, w, h, moved: false };
  chatHead.setPointerCapture(ev.pointerId);
});
chatHead.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  if (!drag.moved) {
    if (Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 5) return;
    drag.moved = true;
    showLayoutMenu(false);
    $('#chat').classList.add('dragging');
    document.body.classList.add('chat-moving');
    for (const k of ['l', 'r', 't', 'b']) document.documentElement.style.removeProperty('--dock-' + k);
  }
  const { vw, vh } = viewport();
  drag.x = clamp(ev.clientX - drag.offX, 0, vw - drag.w);
  drag.y = clamp(ev.clientY - drag.offY, 0, vh - 48);
  const panel = $('#chat');
  Object.assign(panel.style, { left: drag.x + 'px', top: drag.y + 'px', width: drag.w + 'px', height: drag.h + 'px' });
  panel.dataset.mode = 'free'; panel.dataset.where = '';
  drag.target = snapTarget(ev.clientX, ev.clientY);
  showSnap(drag.target);
});
const endDrag = () => {
  if (!drag) return;
  const d = drag; drag = null;
  $('#chat').classList.remove('dragging');
  document.body.classList.remove('chat-moving');
  showSnap(null);
  if (!d.moved) return;
  Object.assign(chatLayout, d.target || { mode: 'free', x: d.x, y: d.y });
  saveLayout(); applyLayout();
};
chatHead.addEventListener('pointerup', endDrag);
chatHead.addEventListener('pointercancel', endDrag);
chatHead.addEventListener('dblclick', (ev) => {
  if (isPhone() || ev.target.closest('button, .layout-pop')) return;
  Object.assign(chatLayout, { mode: DEFAULT_LAYOUT.mode, where: DEFAULT_LAYOUT.where, w: DEFAULT_LAYOUT.w, h: DEFAULT_LAYOUT.h });
  saveLayout(); applyLayout();
});

$('#chat').addEventListener('pointerdown', (ev) => {
  const handle = ev.target.closest('.rz');
  if (!handle || isPhone() || ev.button !== 0) return;
  ev.preventDefault();
  const r = $('#chat').getBoundingClientRect();
  resize = { dir: handle.dataset.rz, sx: ev.clientX, sy: ev.clientY, r, start: { ...chatLayout }, handle };
  handle.setPointerCapture(ev.pointerId);
  handle.classList.add('active');
  $('#chat').classList.add('resizing');
  document.body.classList.add('chat-moving');
});
$('#chat').addEventListener('pointermove', (ev) => {
  if (!resize) return;
  const { dir, r, start } = resize, dx = ev.clientX - resize.sx, dy = ev.clientY - resize.sy;
  const { vw, vh } = viewport();
  if (start.mode === 'dock') {
    if (start.where === 'left') chatLayout.dockW = clamp(r.width + dx, MIN_W, vw * 0.6);
    if (start.where === 'right') chatLayout.dockW = clamp(r.width - dx, MIN_W, vw * 0.6);
    if (start.where === 'top') chatLayout.dockH = clamp(r.height + dy, 240, vh * 0.6);
    if (start.where === 'bottom') chatLayout.dockH = clamp(r.height - dy, 240, vh * 0.6);
  } else {
    let w = r.width, h = r.height;
    if (dir.includes('e')) w += dx;
    if (dir.includes('w')) w -= dx;
    if (dir.includes('s')) h += dy;
    if (dir.includes('n')) h -= dy;
    w = clamp(w, MIN_W, vw - 2 * GAP); h = clamp(h, MIN_H, vh - 2 * GAP);
    chatLayout.w = w; chatLayout.h = h;
    if (start.mode === 'free') {
      chatLayout.x = dir.includes('w') ? r.right - w : r.left;
      chatLayout.y = dir.includes('n') ? r.bottom - h : r.top;
    }
  }
  applyLayout();
});
const endResize = () => {
  if (!resize) return;
  resize.handle.classList.remove('active');
  resize = null;
  $('#chat').classList.remove('resizing');
  document.body.classList.remove('chat-moving');
  saveLayout();
};
$('#chat').addEventListener('pointerup', endResize);
$('#chat').addEventListener('pointercancel', endResize);
window.addEventListener('resize', applyLayout);
matchMedia('(max-width: 820px)').addEventListener('change', applyLayout);
applyLayout();
async function sendChat(text) {
  if (CFG.role === 'demo') return;
  text = text.trim();
  if (!text || chat.busy) return;
  chat.messages.push({ role: 'user', content: text });
  chat.busy = true; renderChat(); saveChat();
  const history = chat.messages.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ messages: history }) });
    if (res.status === 401) { location.href = '/login'; return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) chat.messages.push({ role: 'assistant', content: data.error || 'Something went wrong.', error: true, actions: data.actions });
    else chat.messages.push({ role: 'assistant', content: data.reply, actions: data.actions });
    if (data.changed) { state.calDirty = Date.now() + 60e3; refreshDash().catch(() => {}); rerender(); }
  } catch {
    chat.messages.push({ role: 'assistant', content: 'Couldn\'t reach the server. Check your connection and try again.', error: true });
  } finally {
    chat.busy = false; renderChat(); saveChat();
  }
}
$('#ask-btn').addEventListener('click', () => openChat($('#chat').hidden));
$('#ask-fab').addEventListener('click', () => openChat($('#chat').hidden));

// ---------- sidebar toggle ----------
const SIDE_KEY = 'batcave-sidebar';
const sidebarHidden = () => document.documentElement.classList.contains('side-hidden');
function setSidebar(hidden) {
  document.documentElement.classList.toggle('side-hidden', hidden);
  $('#side-toggle').setAttribute('aria-expanded', String(!hidden));
  try { localStorage.setItem(SIDE_KEY, hidden ? 'hidden' : 'shown'); } catch { /* ignore */ }
}
$('#side-toggle').setAttribute('aria-expanded', String(!sidebarHidden()));
$('#side-toggle').addEventListener('click', () => { setSidebar(true); $('#side-show').focus(); });
$('#side-show').addEventListener('click', () => { setSidebar(false); $('#side-toggle').focus(); });
document.addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'b' && !isPhone()) {
    ev.preventDefault();
    setSidebar(!sidebarHidden());
  }
});
$('#chat').addEventListener('click', (ev) => {
  const s = ev.target.closest('[data-suggest]');
  if (s) return sendChat(s.dataset.suggest);
  const snap = ev.target.closest('[data-snap]');
  if (snap) { snapTo(snap.dataset.snap); showLayoutMenu(false); $('#chat-input').focus(); return; }
  if (!ev.target.closest('.layout-pop, [data-chat="layout"]')) showLayoutMenu(false);
  const b = ev.target.closest('[data-chat]');
  if (b?.dataset.chat === 'layout') showLayoutMenu($('#layout-pop').hidden);
  if (b?.dataset.chat === 'close') openChat(false);
  if (b?.dataset.chat === 'clear') { chat.messages = []; saveChat(); renderChat(); $('#chat-input').focus(); }
});
const chatInput = $('#chat-input');
const growInput = () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px'; };
chatInput.addEventListener('input', growInput);
chatInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); $('#chat-form').requestSubmit(); }
});
$('#chat-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = chatInput.value;
  chatInput.value = ''; growInput();
  sendChat(text);
});
document.addEventListener('keydown', (ev) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (ev.key === '/' && !typing && !$('#quick').open) { ev.preventDefault(); openChat(true); }
  else if (ev.key === 'Escape' && !$('#layout-pop').hidden) { showLayoutMenu(false); $('[data-chat="layout"]').focus(); }
  else if (ev.key === 'Escape' && !$('#chat').hidden) openChat(false);
});

// ---------- week view editing (Google Calendar style) ----------
// Click an event: details card. Drag it: move (snaps to 15 min, across days). Drag its bottom edge: resize.
// Click or drag on empty space: new event. Every change goes to Google Calendar and can be undone with ⌘Z.
const SNAP = 15;
const minsOf = (wall) => +wall.slice(11, 13) * 60 + +wall.slice(14, 16);
const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const calApi = (path, body) => { state.calDirty = Date.now() + 60e3; return api('/api/calendar/' + path, { method: 'POST', body }); };
const reloadWeek = () => Promise.all([loadWeek(state.weekStart), loadAgenda()]);
const evField = (n) => $('#ev-form').elements[n];
const colMinutes = (col, y) => (y - col.getBoundingClientRect().top) / state.week._PX * 60 + state.week._H0 * 60;
function placeBlock(el, s, e) {
  const { _H0: H0, _PX: PX } = state.week;
  el.style.top = `${(s / 60 - H0) * PX}px`;
  el.style.height = `${Math.max(18, ((e - s) / 60) * PX - 2)}px`;
  const lbl = el.querySelector('span');
  if (lbl) { const d = el.closest('.wk-col')?.dataset.day || ''; lbl.textContent = fmtRange(`${d}T${hhmm(s)}`, `${d}T${hhmm(e)}`); lbl.hidden = (e - s) / 60 * PX < 30; }
}
let ghost = null;
function showGhost(col, s, e) {
  if (!ghost) { ghost = document.createElement('div'); ghost.className = 'ev ghost'; ghost.innerHTML = '<strong>(No title)</strong><span></span>'; }
  if (ghost.parentElement !== col) col.appendChild(ghost);
  Object.assign(ghost.style, { left: '2px', width: 'calc(100% - 5px)' });
  placeBlock(ghost, s, e);
}
const removeGhost = () => { ghost?.remove(); };

let evDrag = null, editing = null;
document.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const wk = ev.target.closest('.wk-col .wake');
  if (wakeEditing && !ev.target.closest('#wake-pop') && !wk) {
    closeWakeEditor();
    if (ev.target.closest('.wk-col')) evDrag = { kind: 'swallow' };
    return;
  }
  if (wk && !editing && state.week?._days) {
    const x = state.week.wake?.[wk.dataset.day];
    if (!x) return;
    evDrag = { kind: 'wake', el: wk, day: wk.dataset.day, x0: ev.clientX, y0: ev.clientY, moved: false, m0: minsOf('0000-00-00T' + x.time), canDrag: ev.pointerType !== 'touch' };
    if (evDrag.canDrag) { ev.preventDefault(); wk.setPointerCapture(ev.pointerId); }
    return;
  }
  const tkEl = ev.target.closest('.wk-col .ev.tk');
  if (tkEditing && !ev.target.closest('#tk-pop') && !tkEl) {
    closeTaskEditor();
    if (ev.target.closest('.wk-col')) evDrag = { kind: 'swallow' };
    return;
  }
  if (tkEl && !editing && state.week?._days) {
    if (ev.target.closest('.tk-check')) return; // its click handler marks it done
    const t = state.week.deadlines[+tkEl.dataset.j];
    if (!t) return;
    evDrag = { kind: 'task', el: tkEl, t, col: tkEl.closest('.wk-col'), x0: ev.clientX, y0: ev.clientY, moved: false, s0: minsOf(t.due_at), day0: t.day, canDrag: ev.pointerType !== 'touch' };
    if (evDrag.canDrag) { ev.preventDefault(); tkEl.setPointerCapture(ev.pointerId); }
    return;
  }
  const inPop = ev.target.closest('#ev-pop');
  const col = ev.target.closest('.wk-col');
  const el = ev.target.closest('.wk-col .ev:not(.ghost):not(.tk)');
  if (editing && !inPop && !el) {
    // First click outside an open card just closes it (like Google Calendar).
    closeEventEditor();
    if (col) evDrag = { kind: 'swallow' };
    return;
  }
  if (!col || !state.week?._days) return;
  if (el) {
    const e = state.week.events[+el.dataset.i];
    if (!e) return;
    const sameDayEnd = e.end && e.end.slice(0, 10) === e.start.slice(0, 10);
    evDrag = {
      kind: 'event', mode: ev.target.closest('.ev-rs') ? 'resize' : 'move', el, e, col, x0: ev.clientX, y0: ev.clientY, moved: false,
      canDrag: !!e.writable && ev.pointerType !== 'touch',
      s0: minsOf(e.start), e0: sameDayEnd ? minsOf(e.end) : e.end ? 1440 : minsOf(e.start) + 60, day0: e.start.slice(0, 10),
    };
    if (evDrag.canDrag) { ev.preventDefault(); el.setPointerCapture(ev.pointerId); }
  } else {
    evDrag = { kind: 'new', col, day: col.dataset.day, x0: ev.clientX, y0: ev.clientY, moved: false, m0: colMinutes(col, ev.clientY), touch: ev.pointerType === 'touch' };
    if (!evDrag.touch) { ev.preventDefault(); col.setPointerCapture(ev.pointerId); }
  }
});
document.addEventListener('pointermove', (ev) => {
  const d = evDrag;
  if (!d || d.kind === 'swallow') return;
  const dx = ev.clientX - d.x0, dy = ev.clientY - d.y0;
  if (!d.moved && Math.hypot(dx, dy) < 5) return;
  d.moved = true;
  if (d.kind === 'wake') {
    if (!d.canDrag) return;
    const PX = state.week._PX, H0 = state.week._H0;
    d.m = Math.max(H0 * 60, Math.min(23 * 60 + 45, Math.round((d.m0 + dy / PX * 60) / SNAP) * SNAP));
    const top = (d.m / 60 - H0) * PX;
    d.el.style.top = `${top}px`;
    d.el.classList.add('dragging');
    const night = d.el.parentElement.querySelector('.wk-night');
    if (night) night.style.height = `${top}px`;
    d.el.querySelector('.wake-pill span').textContent = fmtTime(hhmm(d.m));
    document.body.classList.add('chat-moving');
    return;
  }
  if (d.kind === 'task') {
    if (!d.canDrag) return;
    d.el.classList.add('dragging');
    document.body.classList.add('chat-moving');
    const days = state.week._days, i0 = days.indexOf(d.day0), PX = state.week._PX;
    const di = Math.max(-i0, Math.min(days.length - 1 - i0, Math.round(dx / d.col.getBoundingClientRect().width)));
    d.ns = Math.max(0, Math.min(1410, Math.round((d.s0 + dy / PX * 60) / SNAP) * SNAP));
    d.nday = days[i0 + di];
    const target = $(`.wk-col[data-day="${d.nday}"]`);
    if (target && d.el.parentElement !== target) target.appendChild(d.el);
    Object.assign(d.el.style, { left: '2px', width: 'calc(100% - 5px)' });
    placeBlock(d.el, d.ns, d.ns + 30);
    d.el.title = `${d.t.title} · ${fmtDay(d.nday, { weekday: 'short' })} ${fmtTime(hhmm(d.ns))}`;
    return;
  }
  if (d.kind === 'event') {
    if (!d.canDrag) return;
    d.el.classList.add('dragging');
    document.body.classList.add('chat-moving');
    const dur = d.e0 - d.s0, PX = state.week._PX;
    if (d.mode === 'move') {
      const days = state.week._days, i0 = days.indexOf(d.day0);
      const di = Math.max(-i0, Math.min(days.length - 1 - i0, Math.round(dx / d.col.getBoundingClientRect().width)));
      const s = Math.max(0, Math.min(1440 - Math.min(dur, 1440), Math.round((d.s0 + dy / PX * 60) / SNAP) * SNAP));
      d.nday = days[i0 + di];
      const target = $(`.wk-col[data-day="${d.nday}"]`);
      if (target && d.el.parentElement !== target) target.appendChild(d.el);
      Object.assign(d.el.style, { left: '2px', width: 'calc(100% - 5px)' });
      d.ns = s; d.ne = s + dur;
    } else {
      d.nday = d.day0; d.ns = d.s0;
      d.ne = Math.max(d.s0 + SNAP, Math.min(1440, Math.round((d.e0 + dy / PX * 60) / SNAP) * SNAP));
    }
    placeBlock(d.el, d.ns, d.ne);
  } else if (d.kind === 'new' && !d.touch) {
    const cur = colMinutes(d.col, ev.clientY);
    d.s = Math.max(0, Math.floor(Math.min(d.m0, cur) / SNAP) * SNAP);
    d.e = Math.min(1440, Math.max(d.s + SNAP, Math.ceil(Math.max(d.m0, cur) / SNAP) * SNAP));
    showGhost(d.col, d.s, d.e);
  }
});
document.addEventListener('pointercancel', () => { if (evDrag?.moved && evDrag.canDrag && ['event', 'wake', 'task'].includes(evDrag.kind)) reloadWeek(); evDrag = null; document.body.classList.remove('chat-moving'); });
document.addEventListener('pointerup', async () => {
  const d = evDrag;
  evDrag = null;
  if (!d || d.kind === 'swallow') return;
  document.body.classList.remove('chat-moving');
  if (d.kind === 'task') {
    d.el.classList.remove('dragging');
    if (!d.moved) return openTaskEditor(d.t, d.el);
    if (!d.canDrag || d.ns === undefined || (d.ns === d.s0 && d.nday === d.day0)) return;
    return moveTask(d.t, d.nday, d.ns);
  }
  if (d.kind === 'wake') {
    d.el.classList.remove('dragging');
    if (!d.moved) return openWakeEditor(d.day, d.el);
    if (!d.canDrag || d.m === undefined || d.m === d.m0) return;
    return saveWake([{ key: d.day, time: hhmm(d.m) }], `Wake up ${fmtTime(hhmm(d.m))} on ${fmtDay(d.day, { weekday: 'short', month: 'short', day: 'numeric' })} (this day only)`);
  }
  if (d.kind === 'event') {
    d.el.classList.remove('dragging');
    if (!d.moved) return openEventEditor(d.e, d.el);
    if (!d.canDrag || (d.ns === d.s0 && d.ne === d.e0 && d.nday === d.day0)) return;
    return moveEvent(d.e, d.nday, d.ns, d.ne);
  }
  if (d.touch && d.moved) return; // that was a scroll
  if (!state.week?.google?.connected) { toast('Connect Google Calendar to add events'); return; }
  const s = d.moved ? d.s : Math.floor(d.m0 / 30) * 30;
  const e = d.moved ? d.e : Math.min(1440, s + 60);
  showGhost(d.col, s, e);
  openEventEditor({ isNew: true, title: '', allDay: false, start: `${d.day}T${hhmm(s)}`, end: `${d.day}T${hhmm(e)}` }, ghost);
});
document.addEventListener('click', (ev) => {
  const chip = ev.target.closest('.ev-chip');
  if (chip && state.week) openEventEditor(state.week.events[+chip.dataset.i], chip);
});

async function moveEvent(e, day, s, en) {
  const before = { date: e.start.slice(0, 10), start_time: e.start.slice(11, 16), end_time: e.end ? e.end.slice(11, 16) : hhmm(minsOf(e.start) + 60) };
  const after = { date: day, start_time: hhmm(s), end_time: hhmm(en % 1440) };
  const set = (t) => calApi('events/update', { calendar_id: e.calendarId, event_id: e.id, ...t });
  try {
    await set(after);
    const when = `${fmtDay(day, { weekday: 'short' })} ${fmtTime(after.start_time)}`;
    remember(`Moved ${e.title} to ${when}${e.recurring ? ' (this day only)' : ''}`, () => set(before), () => set(after));
  } catch (err) { toast(err.message); }
  await reloadWeek();
}

async function writableCalendars() {
  if (!state.calendars) state.calendars = (await api('/api/google/status')).calendars || [];
  return state.calendars.filter((c) => c.writable);
}
function positionPop(pop, anchor) {
  if (isPhone() || !anchor?.isConnected) { pop.style.left = pop.style.top = ''; return; }
  const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight, vw = innerWidth, vh = innerHeight;
  let x = r.right + 10;
  if (x + w > vw - 8) x = r.left - w - 10;
  if (x < 8) x = Math.max(8, Math.min(vw - w - 8, r.left));
  pop.style.left = `${x}px`;
  pop.style.top = `${Math.max(8, Math.min(r.top, vh - h - 8))}px`;
}
function syncAllDay() { $('#ev-pop').classList.toggle('all-day', evField('all_day').checked); }
async function openEventEditor(e, anchor) {
  if (!e) return;
  closeTaskEditor(); closeWakeEditor();
  const pop = $('#ev-pop'), form = $('#ev-form');
  const connected = !!state.week?.google?.connected;
  const isNew = !!e.isNew, canEdit = isNew ? connected : !!(e.calendarId && e.writable);
  if (!isNew) removeGhost();
  editing = { e, isNew, anchor, description: undefined };
  form.reset();
  delete $('[data-evp="delete"]').dataset.armed;
  $('[data-evp="delete"]').textContent = 'Delete';
  evField('title').value = e.title || '';
  evField('date').value = e.start.slice(0, 10);
  evField('all_day').checked = !!e.allDay;
  evField('start').value = e.allDay ? '09:00' : e.start.slice(11, 16);
  evField('end').value = e.allDay ? '10:00' : e.end ? e.end.slice(11, 16) : hhmm(minsOf(e.start) + 60);
  evField('location').value = e.location || '';
  syncAllDay();
  for (const el of form.elements) if (el.name) el.disabled = !canEdit;
  $('#ev-save').hidden = !canEdit;
  $('[data-evp="delete"]').hidden = !canEdit || isNew;
  const link = $('#ev-open-g');
  link.hidden = !e.link; if (e.link) link.href = e.link;
  $('#ev-cal-dot').style.background = e.color?.startsWith?.('#') ? e.color : 'var(--accent)';
  $('#ev-cal-name').textContent = isNew ? 'New event' : (e.calendar || 'Saved schedule');
  const note = $('#ev-note');
  note.textContent = !e.calendarId && !isNew ? 'From your saved weekly schedule. Connect Google Calendar to edit events here.'
    : !canEdit ? 'Read-only calendar.'
    : e.recurring ? 'Repeating event: changes here apply to this day only.' : '';
  note.hidden = !note.textContent;
  const pick = $('.ev-cal-pick');
  pick.hidden = !isNew;
  pop.hidden = false;
  positionPop(pop, anchor);
  if (isNew) {
    evField('title').focus();
    const cals = await writableCalendars().catch(() => []);
    if (editing?.e !== e) return;
    evField('calendar_id').innerHTML = cals.map((c) => `<option value="${esc(c.id)}"${c.is_primary ? ' selected' : ''}>${esc(c.summary)}</option>`).join('');
    pick.hidden = cals.length < 2;
    positionPop(pop, anchor);
  } else if (e.calendarId) {
    try {
      const full = await api(`/api/calendar/event?calendar_id=${encodeURIComponent(e.calendarId)}&event_id=${encodeURIComponent(e.id)}`);
      if (editing?.e !== e) return;
      editing.description = full.description;
      if (!evField('description').value) evField('description').value = full.description;
      if (!evField('location').value && full.location) evField('location').value = full.location;
      positionPop(pop, anchor);
    } catch (err) { if (editing?.e === e) toast(err.message); }
  }
}
function closeEventEditor() {
  const pop = $('#ev-pop');
  if (pop) pop.hidden = true;
  editing = null;
  removeGhost();
}
$('#ev-form').addEventListener('change', (ev) => { if (ev.target.name === 'all_day') { syncAllDay(); positionPop($('#ev-pop'), editing?.anchor); } });
$('#ev-form').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); $('#ev-form').requestSubmit(); }
  if (ev.key === 'Escape') { ev.stopPropagation(); closeEventEditor(); }
});
$('#ev-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!editing) return;
  const { e, isNew } = editing;
  const allDay = evField('all_day').checked;
  const fields = {
    title: evField('title').value.trim(), date: evField('date').value,
    ...(allDay ? { all_day: true } : { all_day: false, start_time: evField('start').value, end_time: evField('end').value }),
    location: evField('location').value.trim(), description: evField('description').value,
  };
  if (!fields.title) { evField('title').focus(); return; }
  if (!fields.date || (!allDay && !fields.start_time)) { toast('Pick a date and start time'); return; }
  const save = $('#ev-save');
  save.disabled = true;
  try {
    if (isNew) {
      const r = await calApi('events', { ...fields, calendar: evField('calendar_id').value || undefined });
      let id = r.id; const cal = r.calendarId;
      remember(`Added ${fields.title}`, () => calApi('events/delete', { calendar_id: cal, event_id: id }), async () => { id = (await calApi('events', { ...fields, calendar: cal })).id; });
    } else {
      const before = {
        title: e.title, date: e.start.slice(0, 10), all_day: !!e.allDay, location: e.location || '',
        ...(e.allDay ? {} : { start_time: e.start.slice(11, 16), end_time: e.end ? e.end.slice(11, 16) : hhmm(minsOf(e.start) + 60) }),
        ...(editing.description !== undefined ? { description: editing.description } : {}),
      };
      const set = (t) => calApi('events/update', { calendar_id: e.calendarId, event_id: e.id, ...t });
      await set(fields);
      remember(`Updated ${fields.title}${e.recurring ? ' (this day only)' : ''}`, () => set(before), () => set(fields));
    }
    closeEventEditor();
    await reloadWeek();
  } catch (err) { toast(err.message); }
  finally { save.disabled = false; }
});
$('#ev-pop').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-evp]');
  if (!b || !editing) return;
  if (b.dataset.evp === 'close') return closeEventEditor();
  if (b.dataset.evp === 'delete') {
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Delete?'; return; }
    const { e } = editing;
    const snapshot = {
      title: e.title, date: e.start.slice(0, 10), all_day: !!e.allDay, location: e.location || undefined, description: editing.description || undefined,
      ...(e.allDay ? {} : { start_time: e.start.slice(11, 16), end_time: e.end ? e.end.slice(11, 16) : undefined }),
    };
    try {
      await calApi('events/delete', { calendar_id: e.calendarId, event_id: e.id });
      let id = e.id;
      remember(`Deleted ${e.title}${e.recurring ? ' (this day only)' : ''}`,
        async () => { id = (await calApi('events/restore', { calendar_id: e.calendarId, event_id: id, snapshot })).id || id; },
        () => calApi('events/delete', { calendar_id: e.calendarId, event_id: id }));
      closeEventEditor();
      await reloadWeek();
    } catch (err) { toast(err.message); }
  }
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && editing) closeEventEditor(); });
window.addEventListener('resize', () => { if (editing) positionPop($('#ev-pop'), editing.anchor); });

// ---------- wake-up line ----------
// Each day shows when he wakes up. Drag the line to change one day; click it to set that day, every <weekday>, or the default.
let wakeEditing = null;
const wakeApi = (changes) => api('/api/wake', { method: 'POST', body: { changes } });
const wakeField = (n) => $('#wake-form').elements[n];
function wakePrior(key) {
  const w = state.week;
  if (key === 'default') return w.wakeDefaults?.default ?? null;
  if (key.startsWith('dow:')) return w.wakeDefaults?.weekdays?.[key.slice(4)] ?? null;
  const x = w.wake?.[key];
  return x?.from === 'day' ? x.time : null;
}
async function saveWake(changes, label) {
  const before = changes.map((c) => ({ key: c.key, time: wakePrior(c.key) }));
  try {
    await wakeApi(changes);
    remember(label, () => wakeApi(before), () => wakeApi(changes));
  } catch (err) { toast(err.message); }
  await reloadWeek();
}
function openWakeEditor(day, anchor) {
  const x = state.week?.wake?.[day];
  if (!x) return;
  closeEventEditor();
  const n = parseDay(day).getUTCDay(), wd = WEEKDAY_NAMES[n];
  const short = fmtDay(day, { weekday: 'short', month: 'short', day: 'numeric' });
  closeTaskEditor();
  wakeEditing = { day, n, x, anchor };
  $('#wake-pop-title').textContent = `Wake up · ${short}`;
  wakeField('time').value = x.time;
  $('[data-wk="day"]').textContent = `Just ${short}`;
  $('[data-wk="weekday"]').textContent = `Every ${wd}`;
  for (const r of $$('#wake-form [name="scope"]')) r.checked = r.value === x.from;
  const others = Object.entries(state.week.wakeDefaults?.weekdays || {}).filter(([k]) => +k !== n).map(([k, t]) => `${WEEKDAY_NAMES[k].slice(0, 3)} ${fmtTime(t)}`);
  const src = x.from === 'day' ? `Set for ${short} only.` : x.from === 'weekday' ? `Set for every ${wd}.` : 'The default for every day.';
  const dflt = state.week.wakeDefaults?.default;
  $('#wake-note').textContent = [src, x.from !== 'default' && dflt ? `Default: ${fmtTime(dflt)}.` : '', others.length ? `Other weekdays: ${others.join(', ')}.` : ''].filter(Boolean).join(' ');
  const reset = $('#wake-reset');
  reset.hidden = x.from === 'default';
  const fallback = x.from === 'day' && state.week.wakeDefaults?.weekdays?.[n] ? `${wd}'s time` : 'the default';
  reset.textContent = x.from === 'day' ? `Use ${fallback}` : `Stop ${wd} time`;
  const pop = $('#wake-pop');
  pop.hidden = false;
  positionPop(pop, anchor);
  if (!isPhone()) wakeField('time').focus();
}
function closeWakeEditor() { $('#wake-pop').hidden = true; wakeEditing = null; }
$('#wake-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!wakeEditing) return;
  const { day, n, x } = wakeEditing;
  const time = wakeField('time').value;
  if (!/^\d{2}:\d{2}$/.test(time)) { wakeField('time').focus(); return; }
  const scope = $('#wake-form [name="scope"]:checked')?.value || 'day';
  const short = fmtDay(day, { weekday: 'short', month: 'short', day: 'numeric' });
  let changes, label;
  if (scope === 'day') { changes = [{ key: day, time }]; label = `Wake up ${fmtTime(time)} on ${short}`; }
  else if (scope === 'weekday') {
    changes = [{ key: `dow:${n}`, time }, ...(x.from === 'day' ? [{ key: day, time: null }] : [])];
    label = `Wake up ${fmtTime(time)} every ${WEEKDAY_NAMES[n]}`;
  } else {
    // The day being edited follows the new default, so its own and its weekday's times give way.
    changes = [{ key: 'default', time }, ...(x.from === 'day' ? [{ key: day, time: null }] : []), ...(state.week.wakeDefaults?.weekdays?.[n] ? [{ key: `dow:${n}`, time: null }] : [])];
    label = `Wake up ${fmtTime(time)} every day`;
  }
  closeWakeEditor();
  await saveWake(changes, label);
});
$('#wake-pop').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-wkp]');
  if (!b || !wakeEditing) return;
  if (b.dataset.wkp === 'close') return closeWakeEditor();
  if (b.dataset.wkp === 'reset') {
    const { day, n, x } = wakeEditing;
    closeWakeEditor();
    if (x.from === 'day') saveWake([{ key: day, time: null }], `${fmtDay(day, { weekday: 'short', month: 'short', day: 'numeric' })} back to the usual wake-up`);
    else if (x.from === 'weekday') saveWake([{ key: `dow:${n}`, time: null }], `${WEEKDAY_NAMES[n]}s back to the default wake-up`);
  }
});
$('#wake-form').addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closeWakeEditor(); } });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && wakeEditing) closeWakeEditor(); });
window.addEventListener('resize', () => { if (wakeEditing) positionPop($('#wake-pop'), wakeEditing.anchor); });

// ---------- tasks on the week grid ----------
// Tasks with a due time show in the grid. Tick the circle: done. Drag: new day/time. Click: small card to edit.
let tkEditing = null;
const patchTask = (id, body) => api('/api/tasks/' + id, { method: 'PATCH', body });
const tkField = (n) => $('#tk-form').elements[n];
const shortDay = (d) => fmtDay(d, { weekday: 'short', month: 'short', day: 'numeric' });
async function moveTask(t, day, s) {
  const before = { due_at: t.due_at }, after = { due_at: `${day}T${hhmm(s)}` };
  try {
    await patchTask(t.id, after);
    remember(`Moved ${t.title} to ${fmtDay(day, { weekday: 'short' })} ${fmtTime(hhmm(s))}`, () => patchTask(t.id, before), () => patchTask(t.id, after));
  } catch (err) { toast(err.message); }
  await reloadWeek();
  refreshDash().catch(() => {});
}
async function completeTask(t, el) {
  el?.classList.add('done');
  try {
    await patchTask(t.id, { status: 'done' });
    remember(`Done: ${t.title}`, () => patchTask(t.id, { status: 'open' }), () => patchTask(t.id, { status: 'done' }));
  } catch (err) { el?.classList.remove('done'); toast(err.message); return; }
  refreshDash().catch(() => {});
  rerender();
}
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('.wk-col .tk-check');
  if (!b) return;
  const el = b.closest('.tk'), t = state.week?.deadlines[+el.dataset.j];
  if (t) completeTask(t, el);
});
function openTaskEditor(t, anchor) {
  closeEventEditor(); closeWakeEditor();
  tkEditing = { t, anchor };
  const pop = $('#tk-pop');
  pop.dataset.state = t.state;
  $('#tk-meta').textContent = ['Task', t.project, t.state === 'overdue' ? 'overdue' : t.state === 'today' ? 'due today' : ''].filter(Boolean).join(' · ');
  tkField('title').value = t.title;
  tkField('date').value = t.due_at?.slice(0, 10) || '';
  tkField('time').value = t.due_at?.length > 10 ? t.due_at.slice(11, 16) : '';
  tkField('notes').value = t.notes || '';
  pop.hidden = false;
  positionPop(pop, anchor);
}
function closeTaskEditor() { const pop = $('#tk-pop'); if (pop) pop.hidden = true; tkEditing = null; }
$('#tk-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!tkEditing) return;
  const { t, fromList } = tkEditing;
  const title = tkField('title').value.trim(), date = tkField('date').value, time = tkField('time').value, notes = tkField('notes').value.trim();
  if (!title) { tkField('title').focus(); return; }
  if (time && !date) { tkField('date').focus(); return; }
  const due = date ? (time ? `${date}T${time}` : date) : null;
  const after = {}, before = {};
  if (title !== t.title) { after.title = title; before.title = t.title; }
  if (due !== t.due_at) { after.due_at = due; before.due_at = t.due_at; }
  if (notes !== (t.notes || '').trim()) { after.notes = notes; before.notes = t.notes || ''; }
  closeTaskEditor();
  if (!Object.keys(after).length) return;
  try {
    await patchTask(t.id, after);
    remember(`Updated ${title}${after.due_at ? ` · ${shortDay(date)}${time ? ' ' + fmtTime(time) : ''}` : ''}`, () => patchTask(t.id, before), () => patchTask(t.id, after));
  } catch (err) { toast(err.message); }
  if (fromList) { await refreshDash(); await render(); }
  else { await reloadWeek(); refreshDash().catch(() => {}); }
});
$('#tk-pop').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-tkp]');
  if (!b || !tkEditing) return;
  if (b.dataset.tkp === 'close') return closeTaskEditor();
  if (b.dataset.tkp === 'done') {
    const { t, anchor } = tkEditing;
    closeTaskEditor();
    completeTask(t, anchor?.isConnected ? anchor : null);
  }
});
$('#tk-form').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); $('#tk-form').requestSubmit(); }
  if (ev.key === 'Escape') { ev.stopPropagation(); closeTaskEditor(); }
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && tkEditing) closeTaskEditor(); });
window.addEventListener('resize', () => { if (tkEditing) positionPop($('#tk-pop'), tkEditing.anchor); });

// ---------- home screen editing (iPhone style: jiggle, drag to move, resize, add, remove) ----------
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function saveHome(layout) {
  state.layout = layout;
  state.layoutSave = api('/api/home/layout', { method: 'PUT', body: { layout } }).catch((e) => toast(e.message));
  return state.layoutSave;
}
function commitLayout(next, label, redraw = true) {
  const prev = state.layout;
  saveHome(next);
  if (redraw && $('#home')) drawHome();
  remember(label, () => saveHome(prev), () => saveHome(next));
}
function setHomeEdit(on) {
  if (!!state.homeEdit === on || !state.layout) return;
  state.homeEdit = on;
  if (!on && $('#wg-gallery').open) $('#wg-gallery').close();
  drawHome();
  (on ? $('#wg-bar [data-home="done"]') : $('#view'))?.focus({ preventScroll: true });
}
function moveWidget(i, j) {
  if (j < 0 || j >= state.layout.length || i === j) return;
  const next = [...state.layout];
  next.splice(j, 0, next.splice(i, 1)[0]);
  commitLayout(next, `Moved ${WIDGETS[next[j].id].name}`);
  $(`#home .wg[data-i="${j}"]`)?.focus();
}
function removeWidget(i) {
  const w = state.layout[i];
  commitLayout(state.layout.filter((_, k) => k !== i), `Removed ${WIDGETS[w.id].name}`);
  ($(`#home .wg[data-i="${Math.min(i, state.layout.length - 1)}"]`) || $('[data-home="add"]'))?.focus();
}
function openWidgetGallery() {
  $('#wg-gallery-list').innerHTML = Object.entries(WIDGETS).map(([id, w]) => `<div class="wg-opt"><div class="grow"><strong>${esc(w.name)}</strong><span class="muted">${esc(w.desc)}</span></div>
    <div class="wg-opt-sizes">${[...w.sizes].map((s) => `<button type="button" class="btn small" data-home="add-one" data-id="${id}" data-size="${s}" aria-label="Add ${esc(w.name)}, ${SIZE_NAMES[s]}">${SIZE_NAMES[s]}</button>`).join('')}</div></div>`).join('');
  $('#wg-gallery').showModal();
}

let swallowClick = false;
document.addEventListener('click', (ev) => {
  if (swallowClick) { swallowClick = false; ev.preventDefault(); ev.stopPropagation(); }
}, true);
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-home]');
  if (!b) {
    if (ev.target.closest('[data-close-gallery]')) $('#wg-gallery').close();
    else if (state.homeEdit && ev.target.id === 'home') setHomeEdit(false); // tap on empty space, like the iPhone
    return;
  }
  const a = b.dataset.home, i = +(b.closest('.wg')?.dataset.i ?? -1);
  if (a === 'edit') {
    $('#settings').close();
    if ($('#home')) setHomeEdit(true);
    else { state.homeEdit = true; location.hash = '#/'; } // the home view draws itself in edit mode
  }
  if (a === 'done') setHomeEdit(false);
  if (a === 'add') openWidgetGallery();
  if (a === 'remove') removeWidget(i);
  if (a === 'size' && state.layout[i].size !== b.dataset.size) {
    const next = state.layout.map((w, k) => (k === i ? { ...w, size: b.dataset.size } : w));
    commitLayout(next, `${WIDGETS[next[i].id].name}: ${SIZE_NAMES[b.dataset.size].toLowerCase()}`);
    $(`#home .wg[data-i="${i}"] [data-size="${b.dataset.size}"]`)?.focus();
  }
  if (a === 'add-one') {
    $('#wg-gallery').close();
    commitLayout([{ id: b.dataset.id, size: b.dataset.size }, ...state.layout], `Added ${WIDGETS[b.dataset.id].name}`);
    window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    $('#home .wg[data-i="0"]')?.focus({ preventScroll: true });
  }
  if (a === 'reset') { $('#wg-gallery').close(); $('#settings').close(); commitLayout(fitLayout(null), 'Reset the home screen'); }
});
document.addEventListener('keydown', (ev) => {
  if (!state.homeEdit || ev.metaKey || ev.ctrlKey || ev.altKey || document.querySelector('dialog[open]')) return;
  if (ev.key === 'Escape') { ev.preventDefault(); setHomeEdit(false); return; }
  const wg = ev.target.classList?.contains('wg') ? ev.target : null;
  if (!wg) return;
  const i = +wg.dataset.i;
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') { ev.preventDefault(); moveWidget(i, i - 1); }
  if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') { ev.preventDefault(); moveWidget(i, i + 1); }
  if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); removeWidget(i); }
});

// Dragging. Mouse: press and move. Touch: hold a moment, then drag (a quick swipe still scrolls the page).
// Outside edit mode, holding a widget on a touch screen starts editing.
let wgDrag = null;
function flip(els, mutate) {
  const before = els.map((el) => el.getBoundingClientRect());
  els.forEach((el) => el.getAnimations().forEach((an) => an.cancel()));
  mutate();
  if (reducedMotion()) return;
  els.forEach((el, k) => {
    const a = before[k], b = el.getBoundingClientRect();
    if (a.left !== b.left || a.top !== b.top) el.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  });
}
function placeDragged() {
  const { wg, gx, gy, px, py } = wgDrag, g = $('#home').getBoundingClientRect();
  wg.style.transform = `translate(${px - gx - g.left - wg.offsetLeft}px, ${py - gy - g.top - wg.offsetTop}px) scale(1.03)`;
}
function reorderUnder() {
  const t = document.elementFromPoint(wgDrag.px, wgDrag.py)?.closest('#home > .wg');
  if (!t) { wgDrag.last = null; return; }
  if (t === wgDrag.wg || t === wgDrag.last) return;
  wgDrag.last = t; // don't swap straight back while the pointer is still over the widget that just moved
  const items = $$('#home > .wg'), i = items.indexOf(wgDrag.wg), j = items.indexOf(t);
  flip(items.filter((el) => el !== wgDrag.wg), () => (i < j ? t.after(wgDrag.wg) : t.before(wgDrag.wg)));
  placeDragged();
}
function dragAutoScroll() {
  if (!wgDrag?.active) return;
  const y = wgDrag.py, top = 80, bottom = innerHeight - (isPhone() ? 130 : 80);
  const v = y < top ? -(top - y) / 3 : y > bottom ? (y - bottom) / 3 : 0;
  if (v) { scrollBy(0, v); placeDragged(); reorderUnder(); }
  requestAnimationFrame(dragAutoScroll);
}
function startWidgetDrag() {
  Object.assign(wgDrag, { active: true, px: wgDrag.x0, py: wgDrag.y0 });
  wgDrag.wg.classList.add('dragging');
  document.body.classList.add('wg-dragging');
  navigator.vibrate?.(8);
  placeDragged();
  requestAnimationFrame(dragAutoScroll);
}
function endWidgetDrag() {
  if (!wgDrag) return;
  const d = wgDrag;
  wgDrag = null;
  clearTimeout(d.hold);
  if (!d.active) return;
  swallowClick = true;
  document.body.classList.remove('wg-dragging');
  d.wg.classList.remove('dragging');
  const from = d.wg.style.transform;
  d.wg.style.transform = '';
  if (!reducedMotion()) d.wg.animate([{ transform: from }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  const items = $$('#home > .wg'), order = items.map((el) => +el.dataset.i);
  if (order.every((v, k) => v === k)) return;
  const next = order.map((k) => state.layout[k]);
  items.forEach((el, k) => { el.dataset.i = k; });
  commitLayout(next, `Moved ${WIDGETS[next[+d.wg.dataset.i].id].name}`, false);
}
document.addEventListener('pointerdown', (ev) => {
  swallowClick = false;
  const wg = ev.target.closest('#home > .wg');
  if (!wg || ev.button > 0) return;
  const base = { wg, x0: ev.clientX, y0: ev.clientY, touch: ev.pointerType !== 'mouse' };
  if (!state.homeEdit) {
    if (!base.touch) return;
    wgDrag = { ...base, pressOnly: true, hold: setTimeout(() => { wgDrag = null; swallowClick = true; navigator.vibrate?.(10); setHomeEdit(true); }, 550) };
    return;
  }
  if (ev.target.closest('button')) return;
  const r = wg.getBoundingClientRect();
  wgDrag = { ...base, gx: ev.clientX - r.left, gy: ev.clientY - r.top, active: false };
  if (base.touch) wgDrag.hold = setTimeout(startWidgetDrag, 170);
});
document.addEventListener('pointermove', (ev) => {
  if (!wgDrag) return;
  if (!wgDrag.active) {
    if (Math.hypot(ev.clientX - wgDrag.x0, ev.clientY - wgDrag.y0) < (wgDrag.touch ? 8 : 4)) return;
    if (wgDrag.touch) { clearTimeout(wgDrag.hold); wgDrag = null; return; } // moved before the hold finished: it's a scroll
    startWidgetDrag();
  }
  wgDrag.px = ev.clientX; wgDrag.py = ev.clientY;
  placeDragged(); reorderUnder();
});
document.addEventListener('pointerup', endWidgetDrag);
document.addEventListener('pointercancel', endWidgetDrag);
// Once a touch drag has started, keep the page from scrolling under the finger.
document.addEventListener('touchmove', (ev) => { if (wgDrag?.active) ev.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (ev) => { if (ev.target.closest('#home > .wg') && (wgDrag || state.homeEdit)) ev.preventDefault(); });

// ---------- theme ----------
const THEMES = ['auto', 'light', 'dark', 'nord', 'signal', 'forest', 'solarized', 'rose'];
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $$('[data-theme-pick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themePick === t)));
  // Phone status bar follows the sidebar color.
  $('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--side').trim());
}
let theme = 'auto';
try { theme = localStorage.getItem('batcave-theme') || 'auto'; if (!THEMES.includes(theme)) theme = 'auto'; } catch { /* storage unavailable */ }
applyTheme(theme);

// ---------- settings (bottom-left, or More on a phone) ----------
function openSettings() {
  showMore(false);
  $('#set-sidebar').checked = !sidebarHidden();
  $('#settings').showModal();
  if (CFG.role === 'friend') loadProfile(); else if (CFG.role === 'owner') loadFriends();
}

// Friends edit their own name, time zone and password; the owner's settings live in wrangler.jsonc.
async function loadProfile() {
  const sec = $('#set-profile'), form = $('[data-form="profile"]', sec);
  const a = await api('/api/account').catch((e) => { toast(e.message); return null; });
  if (!a) return;
  const zones = (Intl.supportedValuesOf?.('timeZone') || []).filter((z) => z !== a.timezone);
  form.timezone.innerHTML = [a.timezone, ...zones].map((z) => `<option>${esc(z)}</option>`).join('');
  form.name.value = a.name;
  $('#set-email').textContent = a.email;
  sec.hidden = false;
}

// Owner: invite codes (one sign-up each) and who has signed up, with the space each person uses.
const kb = (n) => (n == null ? '?' : n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
async function loadFriends() {
  const sec = $('#set-friends');
  const d = await api('/api/admin/friends').catch(() => null);
  if (!d) return;
  const link = (code) => `${location.origin}/signup?code=${encodeURIComponent(code)}`;
  const open = d.invites.filter((i) => !i.used_at);
  $('#set-friends-list').innerHTML = `
    ${open.map((i) => `<div class="set-row"><span><code>${esc(i.code)}</code>${i.note ? ` <span class="muted">· ${esc(i.note)}</span>` : ''}</span>
      <span class="set-btns"><button type="button" class="btn small" data-copy="${esc(link(i.code))}">Copy link</button><button type="button" class="btn small" data-uninvite="${esc(i.code)}">Delete</button></span></div>`).join('')}
    ${d.users.map((u) => `<div class="set-row"><span>${esc(u.name || u.email)} <span class="muted">· ${esc(u.email)} · ${kb(u.bytes)}</span></span>
      <button type="button" class="btn small" data-reset-user="${u.id}" data-name="${esc(u.name || u.email)}">Reset password</button></div>`).join('')}
    ${!open.length && !d.users.length ? '<p class="muted" style="margin:6px 0">No friends yet. Make an invite code and send them the link.</p>' : ''}`;
  sec.hidden = false;
}
$('#set-friends').addEventListener('click', async (ev) => {
  const copy = ev.target.closest('[data-copy]'), del = ev.target.closest('[data-uninvite]'), reset = ev.target.closest('[data-reset-user]');
  try {
    if (copy) { await navigator.clipboard.writeText(copy.dataset.copy); toast('Sign-up link copied'); }
    if (del) { await api('/api/admin/invites/' + encodeURIComponent(del.dataset.uninvite), { method: 'DELETE' }); toast('Invite deleted'); loadFriends(); }
    if (reset && confirm(`Give ${reset.dataset.name} a new password? Their old one stops working.`)) {
      const r = await api(`/api/admin/users/${reset.dataset.resetUser}/reset`, { method: 'POST' });
      prompt(`New password for ${reset.dataset.name}. Send it to them; they can change it in Settings.`, r.password);
    }
  } catch (e) { toast(e.message); }
});
$('#settings').addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form[data-form]');
  if (!['profile', 'password', 'invite'].includes(form?.dataset.form)) return;
  ev.preventDefault();
  ev.stopPropagation();
  const f = Object.fromEntries(new FormData(form));
  try {
    if (form.dataset.form === 'profile') {
      await api('/api/account', { method: 'PATCH', body: { name: f.name, timezone: f.timezone } });
      location.reload(); // the greeting, assistant and every date use these
    }
    if (form.dataset.form === 'password') {
      await api('/api/account', { method: 'PATCH', body: { current_password: f.current_password, password: f.password } });
      form.reset();
      toast('Password changed. Other devices are signed out.');
    }
    if (form.dataset.form === 'invite') {
      const { code } = await api('/api/admin/invites', { method: 'POST', body: { note: f.note } });
      form.reset();
      await loadFriends();
      await navigator.clipboard.writeText(`${location.origin}/signup?code=${code}`).then(() => toast(`Invite ${code} made, sign-up link copied`), () => toast(`Invite ${code} made`));
    }
  } catch (e) { toast(e.message); }
});
$('#settings-btn').addEventListener('click', openSettings);
$('#settings-btn-m').addEventListener('click', openSettings);
$('#settings').addEventListener('click', (ev) => {
  const pick = ev.target.closest('[data-theme-pick]');
  if (pick && THEMES.includes(pick.dataset.themePick)) {
    theme = pick.dataset.themePick;
    applyTheme(theme);
    try { localStorage.setItem('batcave-theme', theme); } catch { /* ignore */ }
  }
  if (ev.target.closest('[data-close-settings]') || ev.target === ev.currentTarget) $('#settings').close();
});
$('#set-sidebar').addEventListener('change', (ev) => setSidebar(!ev.target.checked));

// ---------- phone: More sheet, keyboard-aware chat height, refresh when reopened ----------
function showMore(open) {
  const sheet = $('#more-sheet');
  if (sheet.hidden === !open) return;
  sheet.hidden = !open;
  $('#tab-more').setAttribute('aria-expanded', String(open));
  if (open) $('a', sheet).focus(); else if (document.activeElement && sheet.contains(document.activeElement)) $('#tab-more').focus();
}
$('#tab-more').addEventListener('click', () => showMore($('#more-sheet').hidden));
$('#more-sheet').addEventListener('click', (ev) => { if (ev.target.closest('[data-more-close]')) showMore(false); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('#more-sheet').hidden) showMore(false); });
if (window.visualViewport) {
  const fit = () => {
    const root = document.documentElement.style;
    root.setProperty('--vvh', visualViewport.height + 'px');
    root.setProperty('--vvt', visualViewport.offsetTop + 'px');
  };
  visualViewport.addEventListener('resize', fit);
  visualViewport.addEventListener('scroll', fit);
  fit();
}
let lastRender = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastRender > 60e3 && !document.querySelector('dialog[open]')) render();
});

document.addEventListener('click', (ev) => { if (!ev.target.closest('.cal-ctl')) showCalendarPicker(false); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && $('#cal-pop') && !$('#cal-pop').hidden) showCalendarPicker(false); });

// Coming back from Google's consent screen
{
  const g = new URLSearchParams(location.search).get('google');
  const msg = { connected: 'Google Calendar connected', denied: 'Google Calendar was not connected (access denied)', missing_scope: 'Google Calendar needs permission to edit events. Connect again and allow it.', error: 'Could not connect Google Calendar. Try again.', not_configured: 'Google Calendar sync is not set up on the server yet.' }[g];
  if (msg) { setTimeout(() => toast(msg), 600); history.replaceState(null, '', '/' + location.hash); }
}

// The public preview (/demo) says so at the top and points back to sign-up.
if (CFG.role === 'demo') document.body.insertAdjacentHTML('afterbegin', `<div class="demo-bar" role="note"><span>You're looking at a preview with example data. Nothing you change is saved.</span><a class="btn primary small" href="/signup">Create account</a></div>`);

window.addEventListener('hashchange', () => { state.habitEdit = false; render(); });
render();
