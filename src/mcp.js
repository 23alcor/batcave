// MCP server (Model Context Protocol) at /mcp, so any AI client (Claude, ChatGPT, Cursor, Codex…) can read the
// owner's notes vault and dashboard. Stateless Streamable HTTP: each POST is one JSON-RPC message, answered as JSON.
// Runs as the owner (D1). Auth (MCP_TOKEN bearer or OAuth) is checked in worker.js before this runs.
//
// The vault is a read-only mirror pushed by the notes bridge: PUT /api/ingest/vault (see vaultIngest below).
import { AuthorizationError, CimdFetchError, OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { cfg } from './config.js';
import { TOOLS, ToolError, makeTools } from './chat.js';
import { transcriptsIngest } from './transcripts.js';
import { VAULT_TOOLS, memoryQueue, vaultTools } from './vault.js';
import { NOTE_TOOLS, noteTools } from './note-requests.js';
import { CONTEXT_TOOLS, contextTools, newAgentSession, recordActivity } from './agent-graph.js';

const MAX_RESULT = 24000; // chars per tool result, like the assistant
const MAX_NOTE = 200_000; // bytes per stored note
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const tool = (name, description, properties = {}, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });

// Dashboard tools reused from the assistant. Budget edits are proposals requiring approval in the app.
const REUSED = ['get_budget', 'propose_budget_change', 'get_overview', 'find_tasks', 'get_schedule', 'find_free_time', 'list_projects', 'create_task', 'get_habits',
  'list_wishlist', 'get_garage', 'list_recipes', 'get_recipe', 'list_eating_out'];

const LOG_SESSION = tool('log_session', 'Save a summary of this conversation to their notes as a session note. Call it at the end of a real work or study session (not for quick questions). Send the conversation or a thorough account of it: what was done, decided and left open.', {
    transcript: S('The conversation, or a detailed account of the session'), title: S('Optional 2-6 word title, outcome first'),
    project: S('Optional project, course or area it belongs to'), kind: S('work or study', { enum: ['work', 'study'] }), source: S('Which AI/app this is, e.g. chatgpt, claude'),
  }, ['transcript']);

const toMcp = (t) => ({ name: t.name, description: t.description, inputSchema: { ...t.parameters, properties: { ...t.parameters.properties, session_id: S('Session returned by resume_project or resume_task; reuse throughout this task') } } });
const LIST = [...VAULT_TOOLS.concat(NOTE_TOOLS).map(toMcp), ...CONTEXT_TOOLS, { ...LOG_SESSION, inputSchema: { ...LOG_SESSION.inputSchema, properties: { ...LOG_SESSION.inputSchema.properties, session_id: S('Current task session') } } }, ...TOOLS.filter((t) => REUSED.includes(t.name)).map(toMcp)];

const instructions = () => [
  `This server is ${cfg.owner || 'the owner'}'s personal context: their notes vault and their ${cfg.app} dashboard (tasks, calendar, habits and more).`,
  'For project work, resume_project or resume_task first; keep the returned session_id on later tool calls. Reuse context already read; use read_note section/offset/max_chars for detail. Save the task handoff at milestones with its expected_revision. Call whoami when personal background matters and use it to tailor answers. Look things up (search_notes, recent_sessions, get_schedule) before asking them something their notes might answer; related_notes follows links from a note to connected projects, courses, sessions and ideas.',
  'At the end of a real work or study session, call log_session so it lands in their notes.',
].join(' ');

function mcpTools(env, lib, ctx) {
  return {
    ...vaultTools(env, lib),
    ...noteTools(env),
    ...contextTools(env),
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
  const vault = mcpTools(env, lib, ctx);
  if (vault[name]) return vault[name](args);
  const tools = makeTools(env, lib, []);
  if (name === 'create_task') await tools.list_projects({}); // each MCP call is fresh; the assistant's tools want projects reviewed first
  const { session_id, ...fields } = args; // Session metadata belongs to the MCP activity log, not domain validation.
  return tools[name](fields);
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
    case 'initialize': {
      const sessionId = await newAgentSession(env, p.clientInfo?.name);
      // shortcut: echoes the client's protocol version; this server only uses tools, which every version shares.
      const response = rpc(msg.id, {
        protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: cfg.app, version: '1.0.0' }, instructions: instructions(),
      });
      response.headers.set('Mcp-Session-Id', sessionId);
      return response;
    }
    case 'ping': return rpc(msg.id, {});
    case 'tools/list': return rpc(msg.id, { tools: LIST });
    case 'tools/call': {
      let text, isError = false;
      try {
        const name = String(p.name || '');
        const args = p.arguments && typeof p.arguments === 'object' ? { ...p.arguments } : {};
        args.session_id ||= req.headers.get('Mcp-Session-Id') || undefined;
        const result = await callTool(env, lib, ctx, name, args);
        text = JSON.stringify(result);
        const paths = [result.handoff?.entry_note, result.brief?.entry_note, result.path, result.project_path, result.about_me_path, result.note?.path,
          ...[result.results, result.notes, result.sessions].filter(Array.isArray).flatMap((items) => items.map((n) => n.path))].filter(Boolean);
        const write = ['save_handoff', 'save_project_brief', 'log_session', 'create_note'].includes(name);
        try { await recordActivity(env, result.session_id || args.session_id, write ? 'save_requested' : name, paths, write ? 'queued' : 'completed', result.context_id ? result.context_id + ':' + result.revision : result.id || null); }
        catch { console.error('Agent activity recording unavailable'); }
      } catch (e) {
        if (!(e instanceof ToolError)) console.error('mcp tool', p.name, e);
        text = e instanceof ToolError ? e.message : 'That failed on the server.';
        isError = true;
      }
      if (text.length > MAX_RESULT) text = JSON.stringify({ truncated: true, message: 'Result exceeds the context budget. Request fewer results or a smaller note section.' });
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

// ---------- the owner's remembered facts (notes bridge, INGEST_TOKEN) ----------
// GET  /api/ingest/memories → {memories: [{id, fact, note, at}]}: what the assistant saved, for the bridge to file.
// POST /api/ingest/memories/filed {ids} → drops those from the queue once they are in the notes app.
export async function memoriesIngest(req, env, path) {
  const list = await memoryQueue.list(env.DB);
  if (path === '/api/ingest/memories' && req.method === 'GET') return json({ memories: list });
  if (path === '/api/ingest/memories/filed' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const ids = new Set(Array.isArray(b.ids) ? b.ids : []);
    const keep = list.filter((m) => !ids.has(m.id));
    await memoryQueue.save(env.DB, keep);
    return json({ ok: true, filed: list.length - keep.length, remaining: keep.length });
  }
  return bad('not found', 404);
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
      const who = await owner(req, env);
      if (who === null) return loginRedirect(req);
      if (!who) return new Response(`Only the owner of this ${cfg.app} can connect AI apps.`, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
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
