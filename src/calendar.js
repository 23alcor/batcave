// Calendar helpers: a small RRULE expander and an iCalendar (.ics) parser.
// Everything works in local wall-clock strings (the owner's TIMEZONE): 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM'.

const DOW = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
const weekday = (day) => new Date(day + 'T00:00:00Z').getUTCDay();
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = (day, mins) => {
  const extra = Math.floor(mins / 1440);
  const m = ((mins % 1440) + 1440) % 1440;
  return `${addDays(day, extra)}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export function parseRRule(rule) {
  const out = { freq: null, byday: null, until: null, interval: 1, count: null };
  for (const part of (rule || '').replace(/^RRULE:/i, '').split(';')) {
    const [k, v] = part.split('=');
    if (!k || !v) continue;
    const key = k.toUpperCase();
    if (key === 'FREQ') out.freq = v.toUpperCase();
    else if (key === 'BYDAY') out.byday = v.toUpperCase().split(',').map((d) => d.replace(/^[+-]?\d+/, ''));
    else if (key === 'INTERVAL') out.interval = Math.max(1, parseInt(v, 10) || 1);
    else if (key === 'COUNT') out.count = parseInt(v, 10) || null;
    else if (key === 'UNTIL') out.until = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  }
  return out;
}

// Expand stored or parsed events into concrete occurrences inside [start, end) (days).
export function expandEvents(list, start, end) {
  const out = [];
  for (const e of list) {
    const allDay = !!e.all_day || e.starts_at.length === 10;
    const firstDay = e.starts_at.slice(0, 10);
    const startTime = allDay ? null : e.starts_at.slice(11, 16);
    let durMin = 60;
    if (!allDay && e.ends_at && e.ends_at.length > 10) durMin = dayDiff(firstDay, e.ends_at.slice(0, 10)) * 1440 + toMin(e.ends_at.slice(11, 16)) - toMin(startTime);
    let spanDays = 1;
    if (allDay && e.ends_at && e.ends_at.length === 10) spanDays = Math.max(1, dayDiff(firstDay, e.ends_at));
    const exdates = new Set(e.exdates || []);
    const overrides = new Map((e.overrides || []).map((o) => [o.rid, o]));

    const emit = (day) => {
      const key = allDay ? day : `${day}T${startTime}`;
      if (exdates.has(key) || exdates.has(day)) return;
      const o = overrides.get(key);
      if (o) {
        if (o.cancelled || !o.event) return;
        out.push(...expandEvents([{ ...o.event, rrule: null, exdates: [], overrides: [] }], start, end));
        return;
      }
      for (let i = 0; i < spanDays; i++) {
        const d = addDays(day, i);
        if (d < start || d >= end) continue;
        out.push({
          id: `${e.id}@${d}`, title: e.title, allDay, location: e.location || null, color: e.color_key || 'cal',
          start: allDay ? d : `${d}T${startTime}`, end: allDay ? null : fromMin(d, toMin(startTime) + durMin),
        });
      }
    };

    if (!e.rrule) { emit(firstDay); continue; }
    const r = parseRRule(e.rrule);
    if (!r.freq || !['DAILY', 'WEEKLY'].includes(r.freq)) { emit(firstDay); continue; }
    const byday = r.byday && r.byday.length ? r.byday : [DOW[weekday(firstDay)]];
    const firstWeekStart = addDays(firstDay, -weekday(firstDay));
    let count = 0;
    for (let d = firstDay; d < end; d = addDays(d, 1)) {
      if (r.until && d > r.until) break;
      let hit;
      if (r.freq === 'DAILY') hit = dayDiff(firstDay, d) % r.interval === 0;
      else hit = byday.includes(DOW[weekday(d)]) && Math.floor(dayDiff(firstWeekStart, d) / 7) % r.interval === 0;
      if (!hit) continue;
      count++;
      if (r.count && count > r.count) break;
      if (addDays(d, spanDays) > start) emit(d);
    }
    // Overrides that moved an occurrence into range from outside the recurrence pattern
    for (const o of overrides.values()) {
      if (o.cancelled || !o.event) continue;
      const od = o.event.starts_at.slice(0, 10);
      const rd = o.rid.slice(0, 10);
      if ((rd < start || rd >= end) && od >= start && od < end) out.push(...expandEvents([{ ...o.event, rrule: null, exdates: [], overrides: [] }], start, end));
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

// ---------- iCalendar parsing ----------
function wallParts(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t).value;
  return { y: +g('year'), mo: +g('month'), d: +g('day'), h: g('hour') === '24' ? 0 : +g('hour'), mi: +g('minute') };
}
export function utcToWall(ms, zone) {
  const p = wallParts(ms, zone);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}T${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}
export function zonedToUtc(y, mo, d, h, mi, zone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = (ms) => { const p = wallParts(ms, zone); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - ms; };
  let utc = guess - off(guess);
  utc = guess - off(utc);
  return utc;
}
function parseIcsDate(value, params, tz) {
  const v = value.trim();
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(v)) return { allDay: true, wall: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` };
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (z) return { allDay: false, wall: utcToWall(Date.UTC(+y, +mo - 1, +d, +h, +mi), tz) };
  const zone = params.TZID || tz;
  if (zone === tz) return { allDay: false, wall: `${y}-${mo}-${d}T${h}:${mi}` };
  try { return { allDay: false, wall: utcToWall(zonedToUtc(+y, +mo, +d, +h, +mi, zone), tz) }; } catch { return { allDay: false, wall: `${y}-${mo}-${d}T${h}:${mi}` }; }
}
const unescapeText = (s) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
const colorFor = (title) => (/\bgym\b/i.test(title) ? 'gym' : /^work$/i.test(title.trim()) ? 'work' : 'cal');

export function parseICS(text, tz) {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const masters = new Map();
  const overrides = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.uid && cur.start) {
        const ev = {
          id: cur.uid, title: cur.summary || '(busy)', starts_at: cur.start.wall, all_day: cur.start.allDay ? 1 : 0,
          ends_at: cur.end ? cur.end.wall : null, rrule: cur.rrule || null, location: cur.location || null, color_key: colorFor(cur.summary || ''),
          exdates: cur.exdates, overrides: [],
        };
        if (cur.rid) overrides.push({ uid: cur.uid, rid: cur.rid.wall, cancelled: cur.status === 'CANCELLED', event: ev });
        else if (cur.status !== 'CANCELLED') masters.set(cur.uid, ev);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const [name, ...rawParams] = line.slice(0, idx).split(';');
    const value = line.slice(idx + 1);
    const params = Object.fromEntries(rawParams.map((p) => { const [k, v] = p.split('='); return [k.toUpperCase(), (v || '').replace(/"/g, '')]; }));
    switch (name.toUpperCase()) {
      case 'UID': cur.uid = value.trim(); break;
      case 'SUMMARY': cur.summary = unescapeText(value); break;
      case 'LOCATION': cur.location = unescapeText(value); break;
      case 'STATUS': cur.status = value.trim().toUpperCase(); break;
      case 'DTSTART': cur.start = parseIcsDate(value, params, tz); break;
      case 'DTEND': cur.end = parseIcsDate(value, params, tz); break;
      case 'RRULE': {
        const um = value.match(/UNTIL=(\d{8})(T\d{6}Z?)?/);
        let rule = value;
        if (um) {
          const u = um[2] && um[2].endsWith('Z') ? parseIcsDate(um[1] + um[2], {}, tz).wall.slice(0, 10) : `${um[1].slice(0, 4)}-${um[1].slice(4, 6)}-${um[1].slice(6, 8)}`;
          rule = value.replace(um[0], 'UNTIL=' + u);
        }
        cur.rrule = rule;
        break;
      }
      case 'EXDATE':
        for (const v of value.split(',')) { const p = parseIcsDate(v, params, tz); if (p) cur.exdates.push(p.wall); }
        break;
      case 'RECURRENCE-ID': cur.rid = parseIcsDate(value, params, tz); break;
      default: break;
    }
  }
  for (const o of overrides) {
    const m = masters.get(o.uid);
    if (m) m.overrides.push(o);
    else if (!o.cancelled) masters.set(o.uid + '@' + o.rid, { ...o.event, id: o.uid + '@' + o.rid });
  }
  return [...masters.values()];
}
