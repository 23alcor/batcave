// Sessions: transcripts of work or study sessions (from a script, a phone shortcut or an AI tool) are stored,
// summarized by the assistant's model into a short session note, and handed to a notes bridge, for example a
// script on your computer that writes them into an Obsidian vault.
//
// Nothing personal lives here. Which notes a session can belong to ("targets") and any extra rules come from
// the bridge (PUT /api/ingest/transcripts/targets) and are kept in the meta table.
//
// Ingest routes use the INGEST_TOKEN bearer token; /api/transcripts/* is the signed-in app.
import { recordActivity } from './agent-graph.js';
import { cfg } from './config.js';
import { DEFAULT_MODEL } from './chat.js';

const MAX_BYTES = 1_500_000;     // stored transcript size (D1 rows top out at 2 MB)
const MODEL_CHARS = 400_000;     // what the model reads; longer transcripts keep the start and the end
const STALE_MIN = 10;            // a summary stuck in "summarizing" this long is tried again
const STATUSES = ['new', 'summarizing', 'ready', 'filed', 'error', 'dismissed'];
const LIST_COLS = 'id, created_at, received_on, source, hint_title, hint_target, hint_kind, started_at, ended_at, chars, status, title, kind, target, summary, error, filed_path, filed_at';
const TARGETS_KEY = 'transcripts:targets';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const isWall = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s);
const newId = () => crypto.randomUUID().replace(/-/g, '');

// 'YYYY-MM-DDTHH:MM' in the owner's time zone.
function wallNow(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}
const withSummary = (r) => {
  if (!r) return r;
  let summary = null;
  try { summary = r.summary ? JSON.parse(r.summary) : null; } catch { summary = null; }
  return { ...r, summary };
};

// ---------- targets (sent by the notes bridge) ----------
async function targetsOf(env) {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(TARGETS_KEY).first();
  try {
    const v = JSON.parse(row?.value || '{}');
    return { targets: Array.isArray(v.targets) ? v.targets : [], rules: typeof v.rules === 'string' ? v.rules : '', updated: v.updated || null };
  } catch { return { targets: [], rules: '', updated: null }; }
}
async function setTargets(env, b) {
  const targets = (Array.isArray(b?.targets) ? b.targets : []).slice(0, 400)
    .map((t) => ({ name: clip(t?.name, 120), kind: clip(t?.kind, 30), hint: clip(t?.hint, 300) }))
    .filter((t) => t.name);
  const rules = clip(b?.rules, 6000);
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(TARGETS_KEY, JSON.stringify({ targets, rules, updated: new Date().toISOString() })).run();
  return json({ ok: true, targets: targets.length, rules: rules.length });
}
const matchTarget = (targets, name) => {
  const n = String(name || '').trim().toLowerCase();
  return n ? (targets.find((t) => t.name.toLowerCase() === n)?.name || '') : '';
};

// ---------- receive ----------
// JSON {transcript | text, source?, title?, target?, kind?, started_at?, ended_at?} or a plain-text body
// (then ?source=, ?title=, ?target= and ?kind= in the URL work too).
async function receive(req, env, url, ctx, defaults = {}) {
  const type = req.headers.get('content-type') || '';
  let b = {};
  if (type.includes('application/json')) b = await req.json().catch(() => ({}));
  else {
    const raw = await req.text().catch(() => '');
    try { b = JSON.parse(raw); } catch { b = { transcript: raw }; }
    if (!b || typeof b !== 'object') b = { transcript: raw };
  }
  const q = (k) => b[k] ?? url.searchParams.get(k) ?? defaults[k];
  const text = typeof (b.transcript ?? b.text) === 'string' ? (b.transcript ?? b.text).trim() : '';
  if (!text) return bad('send {"transcript": "..."} or a plain-text body');
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_BYTES) return bad(`That transcript is ${(bytes / 1e6).toFixed(1)} MB; the limit is ${(MAX_BYTES / 1e6).toFixed(1)} MB.`, 413);
  const kind = ['work', 'study'].includes(q('kind')) ? q('kind') : null;
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO transcripts (id, received_on, source, hint_title, hint_target, hint_kind, started_at, ended_at, transcript, chars)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  ).bind(id, wallNow(), clip(q('source'), 40) || null, clip(q('title'), 120) || null, clip(q('target'), 120) || null, kind,
    isWall(q('started_at')) ? q('started_at') : null, isWall(q('ended_at')) ? q('ended_at') : null, text, text.length).run();
  // Try to summarize right away; anything that doesn't finish here is picked up later (bridge, cron or Retry).
  if (env.OPENAI_API_KEY && ctx?.waitUntil) ctx.waitUntil(summarize(env, id).catch((e) => console.error('transcript summary', e.message)));
  return json({ id, status: 'new', received_on: wallNow() }, 202);
}

// ---------- summarize ----------
const LIST = (description) => ({ type: 'array', items: { type: 'string' }, description });
// What kind of session it was, so notes apps can tag and group them (#call, #lecture…).
export const CATEGORIES = ['call', 'interview', 'meeting', 'lecture', 'coding', 'study', 'research', 'writing', 'planning', 'other'];
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'kind', 'category', 'target', 'summary', 'changed', 'decisions', 'next', 'covered', 'key_ideas', 'unclear', 'review', 'links', 'concepts'],
  properties: {
    title: { type: 'string', description: '2-6 words, outcome first' },
    kind: { type: 'string', enum: ['work', 'study'] },
    category: { type: 'string', enum: CATEGORIES },
    target: { type: 'string', description: 'Exact name of the best matching target, or an empty string' },
    summary: { type: 'string', description: '2-4 sentences' },
    changed: LIST('Work: concrete files, features and results'),
    decisions: LIST('Work: each choice made and why'),
    next: LIST('Work: open items'),
    covered: LIST('Study: topics, problems or chapters worked through'),
    key_ideas: LIST('Study: the core points learned'),
    unclear: LIST('Study: what was confusing or got wrong'),
    review: LIST('Study: what to revisit'),
    links: LIST('URLs, repos, pull requests and commit hashes mentioned'),
    concepts: LIST('At most 5 key concepts, sentence case'),
  },
};

function instructionsFor(t) {
  const who = cfg.owner || 'the owner';
  const lines = [
    `You turn the raw transcript of one work or study session (usually a chat with an AI assistant or coding agent) into a short session note for ${who}'s notes. Answer only with JSON that matches the schema.`,
    'title: 2-6 words, outcome first. Do not use any of these characters: : / \\ # ^ | [ ] ? * " < >',
    'kind: "study" when they were learning (coursework, homework, exam prep, practice problems, reading papers); otherwise "work".',
    'category: call (a phone or video call, e.g. a recruiter screen), interview (a formal or technical interview), meeting (a work or team meeting), lecture (a class), coding (building or debugging software with a tool), study (self-study, homework, practice problems), research (papers, experiments), writing (documents, resumes, posts), planning (organizing plans or systems), or other.',
    'target: copy the name of the best matching note from TARGETS exactly, using the hints. If the sender suggested a target that is in the list, use it. If nothing fits, use "".',
    `summary: 2-4 sentences, outcome first, past tense, written for ${who} reading it a month from now.`,
    "Work sessions fill changed, decisions and next; study sessions fill covered, key_ideas, unclear and review. Leave the other kind's lists empty. One line per item, concrete, no filler.",
    'links: URLs, repos, pull requests and commit hashes that appear in the transcript. concepts: at most 5 key ideas or technologies as plain sentence-case names, e.g. "Gradient descent".',
    'Never copy secrets (passwords, API keys, tokens, account or card numbers) into any field.',
  ];
  if (t.rules) lines.push('', 'Rules from their notes (follow them):', t.rules);
  lines.push('', 'TARGETS (name · kind · hint):', ...(t.targets.length ? t.targets.map((x) => `- ${x.name} · ${x.kind || 'note'}${x.hint ? ' · ' + x.hint : ''}`) : ['(none yet, so use "")']));
  return lines.join('\n');
}

function transcriptInput(row) {
  let text = row.transcript;
  if (text.length > MODEL_CHARS) {
    const head = 60_000;
    text = text.slice(0, head) + `\n\n[... ${(text.length - MODEL_CHARS).toLocaleString()} characters cut from the middle ...]\n\n` + text.slice(-(MODEL_CHARS - head));
  }
  const meta = [`Source: ${row.source || 'unknown'}`, `Received: ${row.received_on}`];
  if (row.started_at || row.ended_at) meta.push(`Session: ${row.started_at || '?'} to ${row.ended_at || '?'}`);
  if (row.hint_title) meta.push(`Suggested title: ${row.hint_title}`);
  if (row.hint_target) meta.push(`Suggested target: ${row.hint_target}`);
  if (row.hint_kind) meta.push(`Suggested kind: ${row.hint_kind}`);
  return [{ role: 'user', content: meta.join('\n') + '\n\nTRANSCRIPT:\n' + text }];
}

const BAD_TITLE = /[:/\\#^|[\]?*"<>]/g;
function cleanSummary(s, t, row) {
  const list = (v, n = 12) => (Array.isArray(v) ? v : []).map((x) => clip(String(x ?? ''), 400)).filter(Boolean).slice(0, n);
  const fixTitle = (x) => clip(String(x || ''), 80).replace(BAD_TITLE, ' ').replace(/\s+/g, ' ').trim();
  return {
    title: fixTitle(row.hint_title) || fixTitle(s.title) || 'Session',
    kind: row.hint_kind || (s.kind === 'study' ? 'study' : 'work'),
    category: CATEGORIES.includes(s.category) ? s.category : 'other',
    target: matchTarget(t.targets, row.hint_target) || matchTarget(t.targets, s.target),
    summary: clip(String(s.summary || ''), 2000),
    changed: list(s.changed), decisions: list(s.decisions), next: list(s.next),
    covered: list(s.covered), key_ideas: list(s.key_ideas), unclear: list(s.unclear), review: list(s.review),
    links: list(s.links, 20),
    concepts: list(s.concepts, 5).map((c) => c.replace(/[[\]|#^]/g, '').trim()).filter(Boolean),
    keep_transcript: true, // transcripts are always kept and filed in full
  };
}

async function callModel(env, row, t) {
  const effort = env.OPENAI_REASONING || 'low';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 240000);
  try {
    const res = await fetch(`${env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/responses`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || DEFAULT_MODEL,
        instructions: instructionsFor(t),
        input: transcriptInput(row),
        text: { format: { type: 'json_schema', name: 'session_note', schema: SCHEMA, strict: true } },
        max_output_tokens: 8000,
        store: false,
        ...(effort === 'off' ? {} : { reasoning: { effort } }),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('openai transcripts', res.status, data?.error?.message);
      if (res.status === 401) throw new Error('OpenAI rejected the API key. Check OPENAI_API_KEY.');
      if (res.status === 429) throw new Error('OpenAI says you hit a rate limit or ran out of credits.');
      throw new Error(`OpenAI error ${res.status}: ${String(data?.error?.message || 'unknown').slice(0, 200)}`);
    }
    const text = (Array.isArray(data.output) ? data.output : []).filter((i) => i.type === 'message').flatMap((i) => i.content || [])
      .filter((c) => c.type === 'output_text').map((c) => c.text).join('');
    if (!text) throw new Error(data.status === 'incomplete' ? 'The summary got cut off. Try again.' : 'The model returned no summary.');
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('The model returned something that was not a summary.'); }
    return cleanSummary(parsed, t, row);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The model took too long. Try again.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Claims the transcript (so two runs never summarize the same one), summarizes it and stores the result.
// Returns the updated row, or null when it isn't waiting for a summary (or someone else is on it).
export async function summarize(env, id, { again = false } = {}) {
  const now = new Date().toISOString(), stale = new Date(Date.now() - STALE_MIN * 60e3).toISOString();
  const claim = await env.DB.prepare(
    `UPDATE transcripts SET status = 'summarizing', claimed_at = ?2, error = NULL
     WHERE id = ?1 AND (status IN ('new', 'error') OR (status = 'summarizing' AND claimed_at < ?3)${again ? " OR status = 'ready'" : ''})`
  ).bind(id, now, stale).run();
  if (!claim.meta.changes) return null;
  const row = await env.DB.prepare('SELECT * FROM transcripts WHERE id = ?1').bind(id).first();
  try {
    if (!env.OPENAI_API_KEY) throw new Error('Summaries need an OpenAI API key (the OPENAI_API_KEY secret).');
    const s = await callModel(env, row, await targetsOf(env));
    // Only a row still "summarizing" changes status: if it was dismissed meanwhile, it stays dismissed (the summary is kept).
    await env.DB.prepare(`UPDATE transcripts SET status = CASE status WHEN 'summarizing' THEN 'ready' ELSE status END, title = ?2, kind = ?3, target = ?4, summary = ?5, claimed_at = NULL WHERE id = ?1`)
      .bind(id, s.title, s.kind, s.target || null, JSON.stringify(s)).run();
  } catch (e) {
    await env.DB.prepare(`UPDATE transcripts SET status = CASE status WHEN 'summarizing' THEN 'error' ELSE status END, error = ?2, claimed_at = NULL WHERE id = ?1`).bind(id, String(e.message || e).slice(0, 500)).run();
  }
  return withSummary(await env.DB.prepare(`SELECT ${LIST_COLS} FROM transcripts WHERE id = ?1`).bind(id).first());
}

// Cron (optional, see wrangler.example.jsonc): summarize what's waiting, a few at a time.
export async function summarizePending(env, max = 5) {
  const stale = new Date(Date.now() - STALE_MIN * 60e3).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id FROM transcripts WHERE status = 'new' OR (status = 'summarizing' AND claimed_at < ?1) ORDER BY created_at LIMIT ?2`
  ).bind(stale, max).all();
  for (const r of results) await summarize(env, r.id).catch((e) => console.error('transcript summary', e.message));
  return results.length;
}

// ---------- read / update ----------
async function list(env, url) {
  const wanted = (url.searchParams.get('status') || '').split(',').filter((s) => STATUSES.includes(s));
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);
  const where = wanted.length ? `WHERE status IN (${wanted.map((_, i) => '?' + (i + 1)).join(', ')})` : '';
  const { results } = await env.DB.prepare(`SELECT ${LIST_COLS} FROM transcripts ${where} ORDER BY created_at DESC LIMIT ${limit}`).bind(...wanted).all();
  const { results: counts } = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM transcripts GROUP BY status').all();
  const t = await targetsOf(env);
  return json({
    transcripts: results.map(withSummary),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    targets: t.targets.map((x) => ({ name: x.name, kind: x.kind })),
    targets_updated: t.updated,
  });
}
async function getOne(env, id) {
  const row = await env.DB.prepare(`SELECT ${LIST_COLS}, transcript FROM transcripts WHERE id = ?1`).bind(id).first();
  if (!row) return bad('not found', 404);
  const t = await targetsOf(env);
  return json({ ...withSummary(row), targets: t.targets.map((x) => ({ name: x.name, kind: x.kind })) });
}
// The bridge saved it: remember where.
async function markFiled(env, id, b) {
  const row = await env.DB.prepare('SELECT status FROM transcripts WHERE id = ?1').bind(id).first();
  if (!row) return bad('not found', 404);
  if (row.status !== 'ready') return bad(`it is ${row.status}, not ready`, 409);
  await env.DB.prepare(`UPDATE transcripts SET status = 'filed', filed_path = ?2, filed_at = ?3 WHERE id = ?1`)
    .bind(id, clip(b?.path, 500) || null, wallNow()).run();
  try {
    const event = await env.DB.prepare("SELECT session_id FROM agent_events WHERE ref=?1 AND action='save_requested' ORDER BY id DESC LIMIT 1").bind(id).first();
    await recordActivity(env, event?.session_id, 'file_saved', [clip(b?.path, 500)].filter(Boolean), 'completed', id);
  } catch { console.error('Agent filing activity unavailable'); }
  return json({ ok: true });
}
// App edits: dismiss / restore (both undoable) and moving a summary to another note before it's filed.
async function update(env, id, b) {
  const row = await env.DB.prepare('SELECT status, summary, filed_at FROM transcripts WHERE id = ?1').bind(id).first();
  if (!row) return bad('not found', 404);
  if ('status' in b) {
    let to;
    if (b.status === 'dismissed') to = 'dismissed';
    else if (b.status === 'restore') to = row.status !== 'dismissed' ? row.status : row.filed_at ? 'filed' : row.summary ? 'ready' : 'new';
    else return bad('status must be dismissed or restore');
    await env.DB.prepare('UPDATE transcripts SET status = ?2 WHERE id = ?1').bind(id, to).run();
    return json({ ok: true, status: to });
  }
  if ('target' in b) {
    if (row.status !== 'ready') return bad('only a summary that is not in your notes yet can be moved');
    const t = await targetsOf(env);
    const name = b.target ? matchTarget(t.targets, b.target) : '';
    if (b.target && !name) return bad('unknown note');
    const s = withSummary(row).summary || {};
    s.target = name;
    await env.DB.prepare('UPDATE transcripts SET target = ?2, summary = ?3 WHERE id = ?1').bind(id, name || null, JSON.stringify(s)).run();
    return json({ ok: true, target: name });
  }
  return bad('nothing to update');
}

// ---------- routes ----------
// Bridge / scripts / shortcuts (INGEST_TOKEN). Returns null when the path isn't ours.
export async function transcriptsIngest(req, env, url, ctx) {
  const m = req.method, path = url.pathname.replace(/\/+$/, '');
  let match;
  if (path === '/api/ingest/transcripts' && m === 'POST') return receive(req, env, url, ctx);
  if (path === '/api/ingest/transcripts' && m === 'GET') return list(env, url);
  if (path === '/api/ingest/transcripts/targets' && m === 'PUT') return setTargets(env, await req.json().catch(() => ({})));
  if (path === '/api/ingest/transcripts/targets' && m === 'GET') return json(await targetsOf(env));
  if ((match = path.match(/^\/api\/ingest\/transcripts\/([\w-]+)$/)) && m === 'GET') return getOne(env, match[1]);
  if ((match = path.match(/^\/api\/ingest\/transcripts\/([\w-]+)\/summarize$/)) && m === 'POST') {
    const r = await summarize(env, match[1]);
    return r ? json(r) : bad('not waiting for a summary', 409);
  }
  if ((match = path.match(/^\/api\/ingest\/transcripts\/([\w-]+)\/filed$/)) && m === 'POST') return markFiled(env, match[1], await req.json().catch(() => ({})));
  return null;
}
// The signed-in app. Returns null when the path isn't ours.
export async function transcriptsApi(req, env, url, ctx) {
  const m = req.method, path = url.pathname.replace(/\/+$/, '');
  let match;
  if (path === '/api/transcripts' && m === 'GET') return list(env, url);
  if (path === '/api/transcripts' && m === 'POST') return receive(req, env, url, ctx, { source: 'batcave' });
  if ((match = path.match(/^\/api\/transcripts\/([\w-]+)$/))) {
    if (m === 'GET') return getOne(env, match[1]);
    if (m === 'PATCH') return update(env, match[1], await req.json().catch(() => ({})));
  }
  if ((match = path.match(/^\/api\/transcripts\/([\w-]+)\/summarize$/)) && m === 'POST') {
    const b = await req.json().catch(() => ({}));
    const r = await summarize(env, match[1], { again: !!b.again });
    return r ? json(r) : bad('It is already being summarized, or it is already in your notes.', 409);
  }
  return null;
}
