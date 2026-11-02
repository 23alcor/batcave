// Google Calendar two-way sync.
//   OAuth (offline access) → refresh token kept AES-GCM encrypted in D1 → short-lived access tokens.
//   Calendar list with per-calendar visibility; events for the week view; create / move / cancel events.
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (token encryption key is derived from SESSION_SECRET).
// Test overrides (vars): GOOGLE_API_BASE, GOOGLE_TOKEN_URL, GOOGLE_CONSENT_URL, GOOGLE_REVOKE_URL, PUBLIC_ORIGIN.
import { cfg } from './config.js';
import { utcToWall, zonedToUtc } from './calendar.js';

const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
const STATE_COOKIE = 'bc_gstate';
// Google Calendar's event colors as they look in the app (colorId 1–11).
const EVENT_COLORS = { 1: '#7986CB', 2: '#33B679', 3: '#8E24AA', 4: '#E67C73', 5: '#F6BF26', 6: '#F4511E', 7: '#039BE5', 8: '#616161', 9: '#3F51B5', 10: '#0B8043', 11: '#D50000' };

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const apiBase = (env) => env.GOOGLE_API_BASE || 'https://www.googleapis.com/calendar/v3';
const tokenUrl = (env) => env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const consentUrl = (env) => env.GOOGLE_CONSENT_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
// PUBLIC_ORIGIN lets local dev (where the request URL carries the production host) use its own callback.
const redirectUri = (env, url) => `${env.PUBLIC_ORIGIN || url.origin}/api/google/callback`;
const revokeUrl = (env) => env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';
const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s) => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);

export class GoogleError extends Error {
  constructor(message, code = 'error') { super(message); this.code = code; }
}
export const googleConfigured = (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET);

// ---------- token storage ----------
async function cryptoKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('batcave-google-tokens:' + env.SESSION_SECRET));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(env), enc.encode(text));
  return `${b64(iv)}.${b64(ct)}`;
}
async function unseal(env, sealed) {
  const [iv, ct] = String(sealed).split('.').map(unb64);
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await cryptoKey(env), ct));
}
async function tokenRequest(env, params) {
  const r = await fetch(tokenUrl(env), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}

export async function googleState(env) {
  if (!googleConfigured(env)) return { configured: false, connected: false };
  const row = await env.DB.prepare('SELECT email, status, scope, connected_at FROM google_auth WHERE id = 1').first().catch(() => null);
  return { configured: true, connected: !!row && row.status === 'ok', needsReconnect: !!row && row.status !== 'ok', email: row?.email || null };
}

let refreshing = null; // one token refresh at a time, shared by parallel calendar fetches
async function accessToken(env, force = false) {
  const row = await env.DB.prepare('SELECT refresh_enc, access_enc, expires_at, status FROM google_auth WHERE id = 1').first();
  if (!row) throw new GoogleError('Google Calendar is not connected.', 'not_connected');
  if (row.status !== 'ok') throw new GoogleError('Google Calendar needs to be reconnected.', 'reauth');
  if (!force && row.access_enc && row.expires_at > Date.now() + 60e3) return unseal(env, row.access_enc);
  if (!refreshing) refreshing = refreshToken(env, row).finally(() => { refreshing = null; });
  return refreshing;
}
async function refreshToken(env, row) {
  const { ok, j } = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: await unseal(env, row.refresh_enc) });
  if (!ok) {
    if (j.error === 'invalid_grant') {
      await env.DB.prepare("UPDATE google_auth SET status = 'reauth', access_enc = NULL WHERE id = 1").run();
      throw new GoogleError('Google sign-in expired or was revoked. Reconnect Google Calendar.', 'reauth');
    }
    throw new GoogleError(`Google token refresh failed (${j.error || 'unknown'}).`);
  }
  await env.DB.prepare('UPDATE google_auth SET access_enc = ?1, expires_at = ?2 WHERE id = 1').bind(await seal(env, j.access_token), Date.now() + (j.expires_in || 3600) * 1000).run();
  return j.access_token;
}

async function gfetch(env, path, init = {}, retried = false) {
  const token = await accessToken(env, retried);
  const r = await fetch(apiBase(env) + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } });
  if (r.status === 401 && !retried) return gfetch(env, path, init, true);
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error?.message || r.statusText;
    if (r.status === 403 && /insufficient/i.test(msg)) throw new GoogleError('Google did not grant calendar access. Reconnect and allow both calendar permissions.', 'reauth');
    if (r.status === 404 || r.status === 410) throw new GoogleError('That event or calendar no longer exists in Google Calendar.', 'not_found');
    throw new GoogleError(`Google Calendar error ${r.status}: ${String(msg).slice(0, 160)}`);
  }
  return j;
}

// ---------- connect / disconnect ----------
const cookie = (req, name) => (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] || null;
const redirectTo = (location, extra = {}) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', ...extra } });

export function connect(req, env, url) {
  if (!googleConfigured(env)) return redirectTo('/?google=not_configured');
  const state = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(env, url), response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return redirectTo(`${consentUrl(env)}?${q}`, { 'set-cookie': `${STATE_COOKIE}=${state}; Path=/api/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax` });
}

export async function callback(req, env, url) {
  const clear = { 'set-cookie': `${STATE_COOKIE}=; Path=/api/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax` };
  const state = url.searchParams.get('state');
  if (!state || state !== cookie(req, STATE_COOKIE)) return redirectTo('/?google=error', clear);
  if (url.searchParams.get('error')) return redirectTo('/?google=denied', clear);
  const { ok, j } = await tokenRequest(env, { grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: redirectUri(env, url) });
  if (!ok || !j.refresh_token) { console.error('google token exchange', j.error, j.error_description); return redirectTo('/?google=error', clear); }
  const granted = String(j.scope || '').split(' ');
  if (!granted.includes(SCOPES[0])) return redirectTo('/?google=missing_scope', clear);
  await env.DB.prepare(
    `INSERT INTO google_auth (id, refresh_enc, access_enc, expires_at, scope, status, connected_at) VALUES (1, ?1, ?2, ?3, ?4, 'ok', datetime('now'))
     ON CONFLICT(id) DO UPDATE SET refresh_enc = excluded.refresh_enc, access_enc = excluded.access_enc, expires_at = excluded.expires_at, scope = excluded.scope, status = 'ok', connected_at = excluded.connected_at`
  ).bind(await seal(env, j.refresh_token), await seal(env, j.access_token), Date.now() + (j.expires_in || 3600) * 1000, j.scope || '').run();
  try { await syncCalendars(env); } catch (e) { console.error('calendar list', e.message); }
  clearCache();
  return redirectTo('/?google=connected', clear);
}

export async function disconnect(env) {
  const row = await env.DB.prepare('SELECT refresh_enc FROM google_auth WHERE id = 1').first();
  if (row) {
    try { await fetch(revokeUrl(env), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: await unseal(env, row.refresh_enc) }) }); } catch { /* best effort */ }
  }
  await env.DB.batch([env.DB.prepare('DELETE FROM google_auth'), env.DB.prepare('DELETE FROM google_calendars')]);
  clearCache();
}

// ---------- calendars ----------
// First time a calendar is seen: show your own calendars you have ticked in Google, plus holidays.
// Skip ones named like Notion (deadlines already show from tasks) and other people's shared calendars.
function defaultShown(c) {
  if (c.primary) return 1;
  if (/#holiday@group\.v\.calendar\.google\.com$/.test(c.id)) return 1;
  if (/notion/i.test(c.summary || '')) return 0;
  return c.accessRole === 'owner' && c.selected ? 1 : 0;
}
export async function syncCalendars(env) {
  const j = await gfetch(env, '/users/me/calendarList?maxResults=250&fields=items(id,summary,summaryOverride,backgroundColor,accessRole,primary,selected,hidden)');
  const items = (j.items || []).filter((c) => !c.hidden);
  const { results: known } = await env.DB.prepare('SELECT id FROM google_calendars').all();
  const knownIds = new Set(known.map((k) => k.id));
  const stmts = items.map((c, i) => env.DB.prepare(
    `INSERT INTO google_calendars (id, summary, color, access_role, is_primary, shown, sort) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, color = excluded.color, access_role = excluded.access_role, is_primary = excluded.is_primary, sort = excluded.sort`
  ).bind(c.id, c.summaryOverride || c.summary || c.id, c.backgroundColor || '#2563EB', c.accessRole || 'reader', c.primary ? 1 : 0, knownIds.has(c.id) ? 0 : defaultShown(c), c.primary ? -1 : i));
  const live = items.map((c) => c.id);
  stmts.push(env.DB.prepare(`DELETE FROM google_calendars WHERE id NOT IN (${live.map((_, i) => `?${i + 1}`).join(',') || "''"})`).bind(...live));
  const primary = items.find((c) => c.primary);
  if (primary) stmts.push(env.DB.prepare('UPDATE google_auth SET email = ?1 WHERE id = 1').bind(primary.id));
  await env.DB.batch(stmts);
  clearCache();
  return listCalendars(env);
}
export async function listCalendars(env) {
  const { results } = await env.DB.prepare('SELECT id, summary, color, access_role, is_primary, shown FROM google_calendars ORDER BY sort, summary').all();
  return results.map((c) => ({ ...c, writable: ['owner', 'writer'].includes(c.access_role), shown: !!c.shown, is_primary: !!c.is_primary }));
}
export async function setCalendarShown(env, id, shown) {
  const r = await env.DB.prepare('UPDATE google_calendars SET shown = ?1 WHERE id = ?2').bind(shown ? 1 : 0, id).run();
  clearCache();
  return r.meta.changes > 0;
}
async function resolveCalendar(env, name, needWrite = false) {
  const cals = await listCalendars(env);
  if (!name) { const p = cals.find((c) => c.is_primary); return p ? p.id : 'primary'; }
  const n = String(name).toLowerCase().trim();
  const hit = cals.find((c) => c.id.toLowerCase() === n || c.summary.toLowerCase() === n) || cals.find((c) => c.summary.toLowerCase().includes(n));
  if (!hit) throw new GoogleError(`No calendar matches "${name}". Calendars: ${cals.map((c) => c.summary).join(', ')}`, 'bad_input');
  if (needWrite && !hit.writable) throw new GoogleError(`You can't add events to "${hit.summary}" (read-only).`, 'bad_input');
  return hit.id;
}

// ---------- reading events ----------
let cache = new Map();
function clearCache() { cache = new Map(); }
const wallToUtcIso = (wall) => { const [d, t = '00:00'] = wall.split('T'); const [y, mo, da] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return new Date(zonedToUtc(y, mo, da, h, mi, cfg.tz)).toISOString(); };
// Google normally sends RFC 3339 with an offset; a bare local time is read in the event's own time zone.
const toWall = (dateTime, zone = cfg.tz) => {
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(dateTime)) return utcToWall(Date.parse(dateTime), cfg.tz);
  const local = String(dateTime).slice(0, 16);
  if (!zone || zone === cfg.tz) return local;
  const [d, t] = local.split('T'); const [y, mo, da] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number);
  return utcToWall(zonedToUtc(y, mo, da, h, mi, zone), cfg.tz);
};
const wallOf = (when) => (when?.dateTime ? toWall(when.dateTime, when.timeZone) : null);
const readableText = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#FFFFFF';
  const n = parseInt(m[1], 16), [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111827' : '#FFFFFF';
};

// Returns events in the week view's shape: { id, calendarId, title, allDay, start, end, location, color, ink, link, recurring }.
export async function googleEvents(env, start, end, { fresh = false } = {}) {
  const key = `${start}|${end}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 30e3) return hit.events;
  const cals = (await listCalendars(env)).filter((c) => c.shown);
  const timeMin = wallToUtcIso(start + 'T00:00'), timeMax = wallToUtcIso(end + 'T00:00');
  const fields = 'items(id,status,summary,location,start,end,colorId,htmlLink,recurringEventId,eventType),nextPageToken';
  const lists = await Promise.all(cals.map(async (c) => {
    const items = [];
    let page = '';
    do {
      const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax, maxResults: '250', timeZone: cfg.tz, fields, ...(page ? { pageToken: page } : {}) });
      const j = await gfetch(env, `/calendars/${encodeURIComponent(c.id)}/events?${q}`);
      items.push(...(j.items || []));
      page = j.nextPageToken || '';
    } while (page && items.length < 1000);
    return items.map((e) => ({ e, c }));
  }));
  const out = [];
  for (const { e, c } of lists.flat()) {
    if (e.status === 'cancelled' || e.eventType === 'workingLocation') continue;
    const color = (e.colorId && EVENT_COLORS[e.colorId]) || c.color || '#2563EB';
    const base = { id: e.id, calendarId: c.id, calendar: c.summary, title: e.summary || '(no title)', location: e.location || null, color, ink: readableText(color), link: e.htmlLink || null, recurring: !!e.recurringEventId, writable: c.writable };
    if (e.start?.date) {
      const last = e.end?.date ? addDays(e.end.date, -1) : e.start.date;
      for (let d = e.start.date > start ? e.start.date : start; d <= last && d < end; d = addDays(d, 1)) out.push({ ...base, allDay: true, start: d, end: null });
    } else if (e.start?.dateTime) {
      out.push({ ...base, allDay: false, start: wallOf(e.start), end: wallOf(e.end) });
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  cache.set(key, { at: Date.now(), events: out });
  return out;
}

// ---------- writing events ----------
function timesFor(a, existing) {
  if (a.all_day) {
    const date = a.date || existing?.start?.date || wallOf(existing?.start)?.slice(0, 10);
    if (!isDay(date)) throw new GoogleError('date must be YYYY-MM-DD', 'bad_input');
    const endDate = isDay(a.end_date) ? addDays(a.end_date, 1) : addDays(date, 1);
    return { start: { date, dateTime: null, timeZone: null }, end: { date: endDate, dateTime: null, timeZone: null } };
  }
  const oldStart = wallOf(existing?.start);
  const oldEnd = wallOf(existing?.end);
  const date = a.date || oldStart?.slice(0, 10);
  const st = a.start_time || oldStart?.slice(11, 16);
  if (!isDay(date)) throw new GoogleError('date must be YYYY-MM-DD', 'bad_input');
  if (!isTime(st)) throw new GoogleError('start_time must be HH:MM (24h), or set all_day', 'bad_input');
  let en = a.end_time;
  if (!en) {
    // Keep the old length when moving; new events default to one hour.
    const mins = oldStart && oldEnd ? (Date.parse(oldEnd + ':00Z') - Date.parse(oldStart + ':00Z')) / 60e3 : 60;
    const t = new Date(Date.parse(`${date}T${st}:00Z`) + mins * 60e3).toISOString();
    return { start: { dateTime: `${date}T${st}:00`, timeZone: cfg.tz, date: null }, end: { dateTime: t.slice(0, 16) + ':00', timeZone: cfg.tz, date: null } };
  }
  if (!isTime(en)) throw new GoogleError('end_time must be HH:MM (24h)', 'bad_input');
  const endDate = en <= st ? addDays(date, 1) : date;
  return { start: { dateTime: `${date}T${st}:00`, timeZone: cfg.tz, date: null }, end: { dateTime: `${endDate}T${en}:00`, timeZone: cfg.tz, date: null } };
}
const describe = (e) => {
  if (e.start?.date) return `${e.summary} (all day ${e.start.date})`;
  const s = wallOf(e.start), en = wallOf(e.end) || '';
  return `${e.summary} (${s.replace('T', ' ')}${en ? '–' + en.slice(11) : ''})`;
};

export async function createEvent(env, a) {
  const title = String(a.title || '').trim().slice(0, 300);
  if (!title) throw new GoogleError('title is required', 'bad_input');
  const calId = await resolveCalendar(env, a.calendar, true);
  const t = timesFor(a);
  for (const k of ['start', 'end']) for (const f of Object.keys(t[k])) if (t[k][f] === null) delete t[k][f];
  const body = { summary: title, ...t, ...(a.location ? { location: String(a.location).slice(0, 300) } : {}), ...(a.description ? { description: String(a.description).slice(0, 4000) } : {}) };
  const e = await gfetch(env, `/calendars/${encodeURIComponent(calId)}/events`, { method: 'POST', body: JSON.stringify(body) });
  clearCache();
  return { id: e.id, calendarId: calId, link: e.htmlLink, summary: `Added to calendar: ${describe(e)}` };
}

export async function updateEvent(env, a) {
  if (!a.event_id) throw new GoogleError('event_id is required (from get_schedule)', 'bad_input');
  const calId = a.calendar_id || await resolveCalendar(env, null);
  const path = `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(a.event_id)}`;
  const existing = await gfetch(env, path);
  const patch = {};
  if (a.title && a.title !== existing.summary) patch.summary = String(a.title).slice(0, 300);
  if (a.location !== undefined && (a.location || '') !== (existing.location || '')) patch.location = String(a.location || '').slice(0, 300);
  if (a.description !== undefined && (a.description || '') !== (existing.description || '')) patch.description = String(a.description || '').slice(0, 8000);
  if (a.date || a.start_time || a.end_time || a.all_day !== undefined) Object.assign(patch, timesFor(a, existing));
  if (!Object.keys(patch).length) return { summary: 'Nothing needed changing.' };
  const e = await gfetch(env, path, { method: 'PATCH', body: JSON.stringify(patch) });
  clearCache();
  return { summary: `Updated: ${describe(e)}${existing.recurringEventId ? ' (this occurrence only)' : ''}` };
}

export async function cancelEvent(env, a) {
  if (!a.event_id) throw new GoogleError('event_id is required (from get_schedule)', 'bad_input');
  const calId = a.calendar_id || await resolveCalendar(env, null);
  const path = `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(a.event_id)}`;
  const existing = await gfetch(env, path);
  await gfetch(env, path, { method: 'DELETE' });
  clearCache();
  return { summary: `Cancelled: ${describe(existing)}${existing.recurringEventId ? ' (this occurrence only)' : ''}` };
}

// Full details of one event for the editor (description is not in the week payload).
export async function getEvent(env, a) {
  if (!a.event_id || !a.calendar_id) throw new GoogleError('event_id and calendar_id are required', 'bad_input');
  const e = await gfetch(env, `/calendars/${encodeURIComponent(a.calendar_id)}/events/${encodeURIComponent(a.event_id)}`);
  return {
    id: e.id, calendarId: a.calendar_id, title: e.summary || '', location: e.location || '', description: e.description || '',
    allDay: !!e.start?.date, start: e.start?.date || wallOf(e.start), end: e.end?.date ? addDays(e.end.date, -1) : wallOf(e.end),
    recurring: !!e.recurringEventId, link: e.htmlLink || null, status: e.status,
  };
}

// Undo for cancel: bring the occurrence back; if Google won't, recreate it from the snapshot.
export async function restoreEvent(env, a) {
  const path = `/calendars/${encodeURIComponent(a.calendar_id)}/events/${encodeURIComponent(a.event_id)}`;
  try {
    const e = await gfetch(env, path, { method: 'PATCH', body: JSON.stringify({ status: 'confirmed' }) });
    clearCache();
    return { id: e.id, calendarId: a.calendar_id, summary: `Restored: ${describe(e)}` };
  } catch (err) {
    if (!a.snapshot) throw err;
    return createEvent(env, { ...a.snapshot, calendar: a.calendar_id });
  }
}
