import { ToolError } from './chat.js';

export const NOTE_TOOLS = [
  { type: 'function', name: 'create_note', description: 'Create a NEW Obsidian note only when asked. First search for an existing note and use list_notes/search_notes to choose an existing folder. Cannot edit, replace or delete notes. Never store secrets. Returns queued until the Mac bridge confirms saving; do not claim it is saved while queued.', parameters: { type: 'object', properties: {
    title: { type: 'string', description: 'New note title, without .md or filename punctuation, maximum 120 characters' },
    folder: { type: 'string', description: 'Exact existing vault folder from list_notes/search_notes paths; no Sessions, daily notes, memory, archive or system folders' },
    content: { type: 'string', description: 'Markdown body, maximum 20000 characters; omit frontmatter and the top-level title, which the bridge supplies. Include relevant [[links]].' },
  }, required: ['title', 'folder', 'content'], additionalProperties: false } },
  { type: 'function', name: 'note_status', description: 'Check whether a requested Obsidian note is queued, saved or failed. Only saved=true confirms a file was saved. If queued, the Mac bridge must run; check again on a later user request rather than repeatedly polling.', parameters: { type: 'object', properties: {
    request_id: { type: 'string', description: 'id returned by create_note' },
  }, required: ['request_id'], additionalProperties: false } },
];

const owner = (env) => { if (env.UID && env.UID !== 0) throw new ToolError('Obsidian note creation is available only to the owner.'); };
const state = (row) => ({ id: row.id, path: row.path, status: row.status, saved: row.status === 'saved', error: row.error || null, saved_at: row.saved_at || null });
export function validateNote(a) {
  if (typeof a.title !== 'string' || !a.title.trim() || a.title.length > 120 || /[\x00-\x1f\x7f\\/:#^|\[\]?*"<>]/.test(a.title) || /[. ]$/.test(a.title) || /\.md$/i.test(a.title) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(a.title) || ['Home', 'AI Instructions', 'About Me'].some(t => t.toLowerCase() === a.title.toLowerCase())) throw new ToolError('Use a plain note title of 1–120 characters without .md or filename punctuation.');
  if (typeof a.folder !== 'string' || a.folder.length > 350 || !/^(00 Home|10 Learning and Teaching|20 Work and Career|30 Project and Hobby|40 Content and Creativity|80 Knowledge Library)(\/|$)/.test(a.folder) || a.folder.split('/').some(p => !p || p.startsWith('.') || /[. ]$|[\x00-\x1f\x7f\\:#^|\[\]?*"<>]/.test(p) || /^(templates|attachments|agent context|daily notes|sessions|transcripts|memory)$/i.test(p))) throw new ToolError('Choose an existing regular note folder, excluding system folders, daily notes, sessions, memory and archive.');
  if (typeof a.content !== 'string' || !a.content.trim() || a.content.length > 20000 || a.content.includes('\0')) throw new ToolError('content must contain 1–20000 characters of Markdown.');
  return `${a.folder}/${a.title.trim()}.md`;
}

export function noteTools(env, actions = []) {
  return {
    async create_note(a) {
      owner(env);
      const path = validateNote(a), title = a.title.trim();
      const existing = await env.DB.prepare('SELECT * FROM note_requests WHERE path = ?1 COLLATE NOCASE').bind(path).first();
      if (existing) {
        if (existing.content !== a.content || existing.title !== title) throw new ToolError('A different note request already uses this path. Choose a new title.');
        return state(existing);
      }
      if (await env.DB.prepare('SELECT path FROM vault_notes WHERE lower(title) = lower(?1) OR lower(path) = lower(?2)').bind(title, path).first()) throw new ToolError('A note with this title or path already exists. Existing notes cannot be overwritten.');
      if (!(await env.DB.prepare('SELECT path FROM vault_notes WHERE folder = ?1 LIMIT 1').bind(a.folder).first())) throw new ToolError('Folder not found in the vault mirror. Use an exact existing folder from list_notes or search_notes.');
      const id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO note_requests (id, path, title, folder, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(path) DO NOTHING')
        .bind(id, path, title, a.folder, a.content, new Date().toISOString()).run();
      const row = await env.DB.prepare('SELECT * FROM note_requests WHERE path = ?1').bind(path).first();
      if (row.content !== a.content) throw new ToolError('Another request already uses this path. Choose a new title.');
      actions.push(`Queued Obsidian note: ${path}`);
      return { ...state(row), message: 'Queued for the Mac bridge. Use note_status to confirm it was saved.' };
    },
    async note_status(a) {
      owner(env);
      const row = typeof a.request_id === 'string' && await env.DB.prepare('SELECT * FROM note_requests WHERE id = ?1').bind(a.request_id).first();
      if (!row) throw new ToolError('Unknown note request id.');
      return state(row);
    },
  };
}

export async function noteRequestsIngest(req, env, pathname) {
  const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  if (pathname === '/api/ingest/notes' && req.method === 'GET') {
    const { results } = await env.DB.prepare("SELECT * FROM note_requests WHERE status = 'queued' ORDER BY created_at LIMIT 50").all();
    return json({ notes: results });
  }
  if (pathname !== '/api/ingest/notes/filed' || req.method !== 'POST') return json({ error: 'not found' }, 404);
  const a = await req.json().catch(() => null);
  if (!a || typeof a.id !== 'string' || !['saved', 'error'].includes(a.status) || (a.status === 'error' && (typeof a.error !== 'string' || !a.error.trim()))) return json({ error: 'Send id, status (saved/error), and error when failed.' }, 400);
  const row = await env.DB.prepare('SELECT * FROM note_requests WHERE id = ?1').bind(a.id).first();
  if (!row) return json({ error: 'Unknown note request' }, 404);
  if (row.status !== 'queued') return row.status === a.status ? json(state(row)) : json({ error: 'Request already completed' }, 409);
  await env.DB.prepare("UPDATE note_requests SET status = ?2, error = ?3, saved_at = ?4 WHERE id = ?1 AND status = 'queued'")
    .bind(a.id, a.status, a.status === 'error' ? a.error.slice(0, 300) : null, a.status === 'saved' ? new Date().toISOString() : null).run();
  return json(state(await env.DB.prepare('SELECT * FROM note_requests WHERE id = ?1').bind(a.id).first()));
}
