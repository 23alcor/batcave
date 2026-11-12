import { DurableObject } from 'cloudflare:workers';
import { ToolError } from './chat.js';
import { noteSection } from './vault.js';

const stamp = () => new Date().toISOString(); // UTC timestamps for event ordering across devices.
const bounded = (s, max, name) => {
  if (typeof s !== 'string' || !s.trim() || s.length > max) throw new ToolError(`${name} must be 1–${max} characters.`);
  return s.trim();
};
const owner = (env) => { if (env.UID) throw new ToolError('Agent context is available only to the owner.'); };
const hub = (env) => env.GRAPH_HUB?.get(env.GRAPH_HUB.idFromName('owner'));
const tokenHash = async (token) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token || ''))), (b) => b.toString(16).padStart(2, '0')).join('');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function newAgentSession(env, agent = 'MCP client') {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO agent_sessions (id, agent, updated_at) VALUES (?1, ?2, ?3)').bind(id, String(agent).slice(0, 80), stamp()).run();
  return id;
}

export async function recordActivity(env, sessionId, action, paths = [], status = 'completed', ref = null) {
  const session = sessionId ? await env.DB.prepare('SELECT * FROM agent_sessions WHERE id = ?1').bind(sessionId).first() : null;
  const event = { session_id: session?.id || null, agent: session?.agent || 'Unidentified MCP client', project: session?.project || '', task: session?.task || '', action, status,
    paths: [...new Set(paths.filter((p) => typeof p === 'string').map((p) => p.split('#')[0]))].slice(0, 30), ref, at: stamp() };
  const row = await env.DB.prepare('INSERT INTO agent_events (session_id, agent, project, task, action, status, paths, ref, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING *')
    .bind(event.session_id, event.agent, event.project, event.task, action, status, JSON.stringify(event.paths), ref, event.at).first();
  // Keep bounded history; this is an activity viewer, not a transcript archive.
  await env.DB.prepare('DELETE FROM agent_events WHERE id <= (SELECT COALESCE(MAX(id), 0) - 2000 FROM agent_events)').run();
  if (session) await env.DB.prepare('UPDATE agent_sessions SET updated_at = ?2 WHERE id = ?1').bind(session.id, event.at).run();
  if (row) { try { await hub(env)?.publish({ ...row, paths: JSON.parse(row.paths) }); } catch { console.error('Agent graph broadcast unavailable'); } }
  return row?.id;
}

export async function activitySnapshot(env, after = 0) {
  const { results } = await env.DB.prepare('SELECT * FROM (SELECT * FROM agent_events WHERE id > ?1 ORDER BY id DESC LIMIT 200) ORDER BY id').bind(Math.max(0, Number(after) || 0)).all();
  const { results: contexts } = await env.DB.prepare('SELECT id, project, task, entry_note, revision, filed_revision, file_path, updated_at FROM agent_contexts ORDER BY project, task LIMIT 500').all();
  return { events: results.map((e) => ({ ...e, paths: JSON.parse(e.paths) })), contexts, now: stamp() };
}

async function resolveNote(env, value) {
  const [key, section] = bounded(value, 500, 'note').split('#', 2);
  const row = await env.DB.prepare('SELECT path, title, body FROM vault_notes WHERE path = ?1 OR lower(title) = lower(?1) ORDER BY length(path) LIMIT 1').bind(key).first();
  if (!row) throw new ToolError('Note not found. Search the vault first.');
  if (section) noteSection(row.body, section);
  return { ...row, bookmark: row.path + (section ? '#' + section : '') };
}

export const CONTEXT_TOOLS = [
  { name: 'resume_project', description: 'Start here for an existing project. Returns its brief, task bookmarks and a session_id. Pass that session_id on subsequent tool calls; do not read the entire vault.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, agent: { type: 'string', description: 'Your app or agent name' }, session_id: { type: 'string' } }, required: ['project'], additionalProperties: false } },
  { name: 'resume_task', description: 'Resume one task bookmark and handoff. Returns a session_id and revision; use the revision when saving. If since_revision matches, returns only unchanged status.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, task: { type: 'string' }, agent: { type: 'string' }, session_id: { type: 'string' }, since_revision: { type: 'integer', minimum: 0 } }, required: ['project', 'task'], additionalProperties: false } },
  { name: 'save_project_brief', description: 'Save the short shared project brief and its starting-note bookmark. Only manages a separate agent-created note; cannot overwrite the original project note. Resume first; expected_revision 0 creates a new brief.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, entry_note: { type: 'string' }, content: { type: 'string', maxLength: 1500 }, expected_revision: { type: 'integer', minimum: 0 }, session_id: { type: 'string' } }, required: ['project', 'entry_note', 'content', 'expected_revision', 'session_id'], additionalProperties: false } },
  { name: 'save_handoff', description: 'Save this task handoff and bookmark at a meaningful milestone or wrap-up. Include progress, decisions and relevant links in content; next_action names the next step. Resume first; expected_revision prevents overwriting another agent. Queued until the bridge confirms filing.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, task: { type: 'string', maxLength: 120 }, entry_note: { type: 'string' }, content: { type: 'string', maxLength: 3000 }, next_action: { type: 'string', maxLength: 500 }, expected_revision: { type: 'integer', minimum: 0 }, session_id: { type: 'string' } }, required: ['project', 'task', 'entry_note', 'content', 'next_action', 'expected_revision', 'session_id'], additionalProperties: false } },
];

export function contextTools(env) {
  const sessionFor = async (a, project, task, saving = false) => {
    let id = a.session_id;
    let session = id ? await env.DB.prepare('SELECT * FROM agent_sessions WHERE id = ?1').bind(id).first() : null;
    if (id && !session) throw new ToolError('Unknown session_id. Resume the task again without it.');
    if (session?.project && (session.project !== project || session.task !== task)) {
      if (saving) {
        if (!task && session.project === project) return id; // A task may also maintain the shared project brief.
        throw new ToolError('This session belongs to another task. Resume the intended task first.');
      }
      id = null; // One connector can serve several chats; each task gets its own trail.
    }
    if (!id) id = await newAgentSession(env, a.agent || session?.agent || 'MCP client');
    await env.DB.prepare('UPDATE agent_sessions SET project = ?2, task = ?3, updated_at = ?4 WHERE id = ?1').bind(id, project, task, stamp()).run();
    return id;
  };
  const resume = async (a, task) => {
    owner(env);
    const project = await resolveNote(env, a.project);
    const session_id = await sessionFor(a, project.title, task);
    const row = await env.DB.prepare('SELECT * FROM agent_contexts WHERE project = ?1 AND task = ?2').bind(project.title, task).first();
    const base = { project: project.title, project_path: project.path, task, session_id, revision: row?.revision || 0 };
    if (row && a.since_revision === row.revision) return { ...base, unchanged: true };
    if (task) return { ...base, handoff: row || null, next: row ? 'Read the entry_note only if more detail is needed.' : 'New task: search once, then save_handoff with expected_revision 0.' };
    const { results: tasks } = await env.DB.prepare("SELECT task, entry_note, next_action, revision, updated_at FROM agent_contexts WHERE project = ?1 AND task != '' ORDER BY updated_at DESC LIMIT 10").bind(project.title).all();
    return { ...base, brief: row || null, tasks };
  };
  const save = async (a, task) => {
    owner(env);
    const project = await resolveNote(env, a.project), entry = await resolveNote(env, a.entry_note);
    const frontmatter = project.body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
    if (!/^type:\s*(project|course|area)\s*$/m.test(frontmatter)) throw new ToolError('Choose a project, course or area note with a type property.');
    if (!Number.isSafeInteger(a.expected_revision) || a.expected_revision < 0) throw new ToolError('expected_revision must be a nonnegative integer.');
    if (!a.session_id) throw new ToolError('Resume the task first to obtain a session_id.');
    const session_id = await sessionFor(a, project.title, task, true);
    const content = bounded(a.content, task ? 3000 : 1500, 'content');
    const next = task ? bounded(a.next_action, 500, 'next_action') : '';
    const id = crypto.randomUUID(), at = stamp();
    const folder = project.path.includes('/') ? project.path.slice(0, project.path.lastIndexOf('/')) + '/' : '';
    const label = task ? 'Task ' + task.replace(/[^\p{L}\p{N} -]/gu, '').slice(0, 60).trim() : 'Project brief';
    const file_path = folder + 'Agent Context/' + label + ' - ' + id.slice(0, 8) + '.md';
    let row;
    if (a.expected_revision === 0) {
      row = await env.DB.prepare(`INSERT INTO agent_contexts (id, project, task, project_path, entry_note, content, next_action, file_path, session_id, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT(project, task) DO NOTHING RETURNING *`)
        .bind(id, project.title, task, project.path, entry.bookmark, content, next, file_path, session_id, at).first();
    } else {
      row = await env.DB.prepare('UPDATE agent_contexts SET entry_note=?3, content=?4, next_action=?5, session_id=?6, updated_at=?7, revision=revision+1 WHERE project=?1 AND task=?2 AND revision=?8 RETURNING *')
        .bind(project.title, task, entry.bookmark, content, next, session_id, at, a.expected_revision).first();
    }
    if (!row) throw new ToolError('Revision conflict. Resume again and merge the newer handoff.');
    return { ok: true, status: 'queued', session_id, revision: row.revision, path: row.file_path, context_id: row.id };
  };
  return {
    resume_project: (a) => resume(a, ''),
    resume_task: (a) => resume(a, bounded(a.task, 120, 'task')),
    save_project_brief: (a) => save(a, ''),
    save_handoff: (a) => save(a, bounded(a.task, 120, 'task')),
  };
}

export async function contextQueue(req, env, url) {
  if (req.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM agent_contexts WHERE filed_revision < revision ORDER BY updated_at LIMIT 50').all();
    return json({ contexts: results });
  }
  if (req.method !== 'POST' || !url.pathname.endsWith('/filed')) return json({ error: 'not found' }, 404);
  const b = await req.json().catch(() => ({}));
  if (typeof b.id !== 'string' || !Number.isSafeInteger(b.revision) || b.revision < 1) return json({ error: 'id and revision required' }, 400);
  const row = await env.DB.prepare('SELECT * FROM agent_contexts WHERE id=?1').bind(b.id).first();
  if (!row || b.revision > row.revision) return json({ error: 'unknown context revision' }, 409);
  const changed = await env.DB.prepare('UPDATE agent_contexts SET filed_revision=?2 WHERE id=?1 AND filed_revision < ?2').bind(row.id, b.revision).run();
  if (changed.meta.changes) {
    const ref = row.id + ':' + b.revision;
    const requested = await env.DB.prepare("SELECT session_id FROM agent_events WHERE ref=?1 AND action='save_requested' ORDER BY id DESC LIMIT 1").bind(ref).first();
    await recordActivity(env, requested?.session_id || (b.revision === row.revision ? row.session_id : null), 'file_saved', [row.file_path], 'completed', ref);
  }
  return json({ ok: true });
}

// WebSocket auth happens in the first frame, keeping the long-lived token out of URLs and vault files.
export class AgentGraphHub extends DurableObject {
  async fetch(req) {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ authenticated: false, deadline: Date.now() + 10000 });
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm || alarm > Date.now() + 11000) await this.ctx.storage.setAlarm(Date.now() + 11000);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(socket, message) {
    const state = socket.deserializeAttachment();
    if (state?.authenticated) { if (message === 'ping') socket.send('pong'); return; }
    if (Date.now() > (state?.deadline || 0) || typeof message !== 'string' || message.length > 4096) return socket.close(1008, 'Authentication required');
    let token; try { const b = JSON.parse(message); if (b.type === 'authenticate') token = b.token; } catch {}
    const a = new TextEncoder().encode(String(token || '')), b = new TextEncoder().encode(String(this.env.MCP_TOKEN || ''));
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
    if (!b.length || diff) return socket.close(1008, 'Authentication failed');
    socket.serializeAttachment({ authenticated: true, key_hash: await tokenHash(this.env.MCP_TOKEN) });
    socket.send(JSON.stringify({ type: 'connected', at: stamp() }));
  }
  async alarm() {
    let next = Infinity;
    for (const socket of this.ctx.getWebSockets()) {
      const a = socket.deserializeAttachment();
      if (!a?.authenticated) {
        if (a.deadline <= Date.now()) socket.close(1008, 'Authentication required');
        else next = Math.min(next, a.deadline + 1);
      }
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }
  async publish(event) {
    const key_hash = await tokenHash(this.env.MCP_TOKEN);
    for (const socket of this.ctx.getWebSockets()) if (socket.deserializeAttachment()?.authenticated) {
      if (socket.deserializeAttachment().key_hash !== key_hash) { socket.close(1008, 'Reconnect after key rotation'); continue; }
      try { socket.send(JSON.stringify({ type: 'activity', event })); } catch { socket.close(1011, 'Reconnect'); }
    }
  }
}
