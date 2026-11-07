// MCP server (Model Context Protocol) at /mcp, so any AI client (Claude, ChatGPT, Cursor, Codex…) can read the
// owner's notes vault and dashboard. Stateless Streamable HTTP: each POST is one JSON-RPC message, answered as JSON.
// Runs as the owner (D1). Auth (MCP_TOKEN bearer or OAuth) is checked in worker.js before this runs.
//
// The vault is a read-only mirror pushed by the notes bridge: PUT /api/ingest/vault (see vaultIngest below).
import { AuthorizationError, CimdFetchError, OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { cfg } from './config.js';
import { TOOLS, ToolError, makeTools } from './chat.js';
import { transcriptsIngest } from './transcripts.js';

const MAX_RESULT = 24000; // chars per tool result, like the assistant
const MAX_NOTE = 200_000; // bytes per stored note
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const tool = (name, description, properties = {}, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });

// Dashboard tools reused from the assistant. Read-only, plus adding a task; nothing that edits or deletes.
const REUSED = ['get_overview', 'find_tasks', 'get_schedule', 'find_free_time', 'list_projects', 'create_task', 'get_habits',
  'list_wishlist', 'get_garage', 'list_recipes', 'get_recipe', 'list_eating_out'];

const VAULT_TOOLS = [
  tool('whoami', 'Who the owner is: their "About Me" note (background, school, work, projects, goals, routine, how they like answers), plus the current date, time and time zone. Call this first in every conversation.'),
  tool('search_notes', 'Full-text search of their notes vault (projects, courses, areas, session notes, daily notes). Returns paths and matching snippets; read a note with read_note.', {
    query: S('Words to look for'), folder: S('Optional folder prefix, e.g. "01 Projects" or "02 Areas/School"'), limit: { type: 'integer', description: 'Max results, default 10, up to 30' },
  }, ['query']),
  tool('read_note', 'Read one note in full (with its YAML properties). Takes a path from search_notes/list_notes, or a note title.', { path: S('Path like "01 Projects/Batcave/Batcave.md", or a note title') }, ['path']),
  tool('list_notes', 'List notes in their vault, newest first: path, title, tags, last edit.', { folder: S('Optional folder prefix'), limit: { type: 'integer', description: 'Default 50, up to 300' } }),
  tool('recent_sessions', 'Their recent work and study sessions (session notes): what got done, decisions and next steps. Use for "what have I been working on" or to pick up where a project left off.', {
    days: { type: 'integer', description: 'How far back, default 7, up to 90' }, project: S('Optional project, course or area name, e.g. "Batcave" or "EECE 448"'),
  }),
  tool('log_session', 'Save a summary of this conversation to their notes as a session note. Call it at the end of a real work or study session (not for quick questions). Send the conversation or a thorough account of it: what was done, decided and left open.', {
    transcript: S('The conversation, or a detailed account of the session'), title: S('Optional 2-6 word title, outcome first'),
    project: S('Optional project, course or area it belongs to'), kind: S('work or study', { enum: ['work', 'study'] }), source: S('Which AI/app this is, e.g. chatgpt, claude'),
  }, ['transcript']),
];

const toMcp = (t) => ({ name: t.name, description: t.description, inputSchema: t.parameters });
const LIST = [...VAULT_TOOLS, ...TOOLS.filter((t) => REUSED.includes(t.name)).map(toMcp)];

const instructions = () => [
  `This server is ${cfg.owner || 'the owner'}'s personal context: their notes vault and their ${cfg.app} dashboard (tasks, calendar, habits and more).`,
  'Call whoami first and use it to tailor answers. Look things up (search_notes, recent_sessions, get_schedule) before asking them something their notes might answer.',
  'At the end of a real work or study session, call log_session so it lands in their notes.',
].join(' ');

const words = (q) => [...new Set((clip(q, 200).toLowerCase().match(/[\p{L}\p{N}_'-]+/gu) || []))].slice(0, 8);
const like = (w) => '%' + w.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
function snippet(body, ws) {
  const lower = body.toLowerCase();
  const at = Math.max(0, Math.min(...ws.map((w) => lower.indexOf(w)).filter((i) => i >= 0)));
  return (at > 80 ? '…' : '') + body.slice(Math.max(0, at - 80), at + 160).replace(/\s+/g, ' ').trim() + '…';
}
const sectionOf = (body, heading) => {
  const m = body.match(new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'));
  return m ? m[1].trim().slice(0, 800) : undefined;
};

function vaultTools(env, lib, ctx) {
  const db = env.DB;
  const note = async (p) => {
    const path = clip(p, 500);
    return (await db.prepare('SELECT * FROM vault_notes WHERE path = ?1').bind(path).first())
      || (await db.prepare('SELECT * FROM vault_notes WHERE lower(title) = lower(?1) ORDER BY length(path) LIMIT 1').bind(path.replace(/\.md$/i, '')).first());
  };
  return {
    async whoami() {
      const about = await db.prepare("SELECT body, updated_at FROM vault_notes WHERE lower(title) = 'about me' ORDER BY length(path) LIMIT 1").first();
      const n = await db.prepare('SELECT COUNT(*) AS n FROM vault_notes').first('n');
      return {
        name: cfg.ownerFull || cfg.owner || null, now: lib.localNow(), time_zone: cfg.tz, notes_in_vault: n,
        about_me: about?.body || 'No "About Me" note yet. Use search_notes and recent_sessions to learn about them.',
      };
    },
    async search_notes(a) {
      // shortcut: a LIKE scan, fine for a few thousand notes; move to FTS5 (D1 has it) if the vault grows past that.
      const ws = words(a.query);
      if (!ws.length) throw new ToolError('query needs at least one word');
      const limit = Math.min(Math.max(+a.limit || 10, 1), 30);
      const args = [], where = [];
      for (const w of ws) { args.push(like(w)); where.push(`(lower(title) LIKE ?${args.length} ESCAPE '\\' OR lower(tags) LIKE ?${args.length} ESCAPE '\\' OR lower(body) LIKE ?${args.length} ESCAPE '\\')`); }
      if (a.folder) { args.push(clip(a.folder, 200).replace(/\/+$/, '') + '/%'); where.push(`path LIKE ?${args.length}`); }
      const { results } = await db.prepare(`SELECT path, title, tags, updated_at, body FROM vault_notes WHERE ${where.join(' AND ')}`).bind(...args).all();
      const titleHits = (n) => ws.filter((w) => n.title.toLowerCase().includes(w)).length;
      results.sort((x, y) => titleHits(y) - titleHits(x) || String(y.updated_at).localeCompare(String(x.updated_at)));
      return { query: a.query, total: results.length, results: results.slice(0, limit).map((n) => ({ path: n.path, title: n.title, tags: n.tags, updated_at: n.updated_at, snippet: snippet(n.body, ws) })) };
    },
    async read_note(a) {
      const n = await note(a.path);
      if (!n) throw new ToolError('No note with that path or title. Use search_notes or list_notes.');
      return { path: n.path, title: n.title, tags: n.tags, updated_at: n.updated_at, body: n.body };
    },
    async list_notes(a) {
      const limit = Math.min(Math.max(+a.limit || 50, 1), 300);
      const args = [limit];
      let where = '1';
      if (a.folder) { args.push(clip(a.folder, 200).replace(/\/+$/, '') + '/%'); where = `path LIKE ?${args.length}`; }
      const { results } = await db.prepare(`SELECT path, title, tags, updated_at FROM vault_notes WHERE ${where} ORDER BY updated_at DESC LIMIT ?1`).bind(...args).all();
      return { notes: results };
    },
    async recent_sessions(a) {
      const days = Math.min(Math.max(+a.days || 7, 1), 90);
      const since = lib.addDays(lib.localNow().date, -days);
      const args = [since];
      let where = "(path LIKE 'Sessions/%' OR path LIKE '%/Sessions/%') AND path NOT LIKE '%/Transcripts/%' AND substr(updated_at, 1, 10) >= ?1";
      if (a.project) { // the note's folder, or its `project: "[[…]]"` property
        const p = clip(a.project, 120).replace(/^\[\[|\]\]$/g, '');
        args.push(`%/${p}%/Sessions/%`, `%project: "[[${p}%`);
        where += ` AND (path LIKE ?${args.length - 1} OR body LIKE ?${args.length})`;
      }
      const { results } = await db.prepare(`SELECT path, title, updated_at, body FROM vault_notes WHERE ${where} ORDER BY title DESC LIMIT 40`).bind(...args).all();
      return {
        since, sessions: results.map((n) => ({
          path: n.path, title: n.title, summary: sectionOf(n.body, 'Summary'),
          next_steps: sectionOf(n.body, 'Next steps') ?? sectionOf(n.body, 'Review next'),
        })),
      };
    },
    async log_session(a) {
      const transcript = clip(a.transcript, 400_000);
      if (transcript.length < 40) throw new ToolError('Send the conversation or a detailed account of the session.');
      const body = { transcript, title: clip(a.title, 120), target: clip(a.project, 120), kind: a.kind, source: clip(a.source, 40) || 'mcp' };
      const url = new URL('https://batcave.internal/api/ingest/transcripts');
      const res = await transcriptsIngest(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, url, ctx);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ToolError(data.error || 'could not save the session');
      return { ok: true, id: data.id, note: 'Saved. It is summarized and filed in their notes within a few minutes.' };
    },
  };
}

async function callTool(env, lib, ctx, name, args) {
  if (!LIST.some((t) => t.name === name)) throw new ToolError(`Unknown tool ${name}`);
  const vault = vaultTools(env, lib, ctx);
  if (vault[name]) return vault[name](args);
  const tools = makeTools(env, lib, []);
  if (name === 'create_task') await tools.list_projects({}); // each MCP call is fresh; the assistant's tools want projects reviewed first
  return tools[name](args);
}

const rpc = (id, result) => json({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message, status = 200) => json({ jsonrpc: '2.0', id, error: { code, message } }, status);

export async function mcp(req, env, lib, ctx) {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  let msg;
  try { msg = await req.json(); } catch { return rpcError(null, -32700, 'Parse error', 400); }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') return rpcError(null, -32600, 'Invalid request', 400);
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 }); // notifications and responses
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      // shortcut: echoes the client's protocol version; this server only uses tools, which every version shares.
      return rpc(msg.id, {
        protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: cfg.app, version: '1.0.0' }, instructions: instructions(),
      });
    case 'ping': return rpc(msg.id, {});
    case 'tools/list': return rpc(msg.id, { tools: LIST });
    case 'tools/call': {
      let text, isError = false;
      try {
        text = JSON.stringify(await callTool(env, lib, ctx, String(p.name || ''), p.arguments && typeof p.arguments === 'object' ? p.arguments : {}));
      } catch (e) {
        if (!(e instanceof ToolError)) console.error('mcp tool', p.name, e);
        text = e instanceof ToolError ? e.message : 'That failed on the server.';
        isError = true;
      }
      if (text.length > MAX_RESULT) text = text.slice(0, MAX_RESULT) + '… (truncated)';
      return rpc(msg.id, { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });
    }
    default: return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

// ---------- vault mirror (notes bridge, INGEST_TOKEN) ----------
// GET  /api/ingest/vault → {hashes: {path: hash}} so the bridge sends only what changed.
// PUT  /api/ingest/vault {notes: [{path, title, folder?, tags?, updated_at?, hash?, body}], keep?: [path]}
//      upserts the notes; with `keep`, every stored note not listed is removed (deleted in the vault).
export async function vaultIngest(req, env) {
  if (req.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT path, hash FROM vault_notes').all();
    return json({ hashes: Object.fromEntries(results.map((r) => [r.path, r.hash])) });
  }
  if (req.method !== 'PUT') return bad('not found', 404);
  const b = await req.json().catch(() => null);
  if (!b || !Array.isArray(b.notes) || b.notes.length > 500) return bad('send {"notes": [...]} with up to 500 notes');
  const enc = new TextEncoder();
  const stmts = [];
  for (const n of b.notes) {
    const path = clip(n?.path, 500), body = typeof n?.body === 'string' ? n.body : '';
    if (!path || !path.endsWith('.md') || path.startsWith('/') || path.split('/').includes('..')) return bad(`bad path: ${path || '(empty)'}`);
    if (enc.encode(body).length > MAX_NOTE) return bad(`${path} is over ${MAX_NOTE / 1000} KB`, 413);
    stmts.push(env.DB.prepare(
      `INSERT INTO vault_notes (path, title, folder, tags, updated_at, hash, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(path) DO UPDATE SET title = ?2, folder = ?3, tags = ?4, updated_at = ?5, hash = ?6, body = ?7`
    ).bind(path, clip(n.title, 300) || path.split('/').pop().replace(/\.md$/, ''), clip(n.folder, 500), clip(n.tags, 1000),
      clip(n.updated_at, 16) || null, clip(n.hash, 128) || null, body));
  }
  let removed = 0;
  if (Array.isArray(b.keep) && b.keep.length) { // an empty list never wipes the mirror
    const keep = new Set(b.keep.concat(b.notes.map((n) => n.path)));
    const { results } = await env.DB.prepare('SELECT path FROM vault_notes').all();
    for (const r of results) if (!keep.has(r.path)) { stmts.push(env.DB.prepare('DELETE FROM vault_notes WHERE path = ?1').bind(r.path)); removed++; }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, saved: b.notes.length, removed });
}

// ---------- OAuth (claude.ai, ChatGPT and other connector UIs) ----------
// One Worker is both the authorization server and the MCP resource. Approving a connector = being signed in
// as the owner (the normal login) and clicking Allow. Needs a KV namespace bound as OAUTH_KV.
export const OAUTH_PATH = /^\/(mcp|authorize|oauth\/(token|register)|\.well-known\/oauth-[\w-]+(\/mcp)?)$/;
const providers = new Map(); // one per origin: the resource URL is part of the config

export function oauthProvider(origin, { lib, owner, consentPage, loginRedirect }) {
  if (providers.has(origin)) return providers.get(origin);
  const authorize = {
    async fetch(req, env) {
      const oauth = env.OAUTH_PROVIDER;
      if (!(await owner(req, env))) return loginRedirect(req);
      try {
        if (req.method === 'GET') {
          const request = await oauth.parseAuthRequest(req);
          const details = await oauth.describeConsent(request);
          const consent = await oauth.beginConsent(request);
          consent.headers.set('content-type', 'text/html; charset=utf-8');
          return new Response(consentPage(details, consent.handle), { headers: consent.headers });
        }
        if (req.method !== 'POST') return new Response(null, { status: 405 });
        const form = await req.formData();
        const handle = String(form.get('handle') || '');
        if (form.get('decision') !== 'approve') {
          const denied = await oauth.denyConsent(req, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const approved = await oauth.approveConsent(req, handle, { scope: ['mcp'] });
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request, userId: 'owner', metadata: {}, scope: ['mcp'], props: { uid: 0 },
        });
        approved.headers.set('location', redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      } catch (e) {
        if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
        if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
          return new Response(e instanceof AuthorizationError ? e.description || 'This request expired. Start connecting again.' : 'This app could not be verified.',
            { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }
        throw e;
      }
    },
  };
  const provider = new OAuthProvider({
    apiRoute: '/mcp',
    apiHandler: { fetch: (req, env, ctx) => mcp(req, { ...env, UID: 0 }, lib(), ctx) },
    defaultHandler: authorize,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: ['mcp'],
    resourceMetadata: { resource: origin + '/mcp', authorization_servers: [origin] },
    clientIdMetadataDocumentEnabled: true, // needs the global_fetch_strictly_public compatibility flag
  });
  providers.set(origin, provider);
  return provider;
}
