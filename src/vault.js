// Notes vaults: tool schemas and handlers shared by the assistant (chat.js) and the MCP server (mcp.js).
// The owner's vault is a read-only copy of their notes app, kept by the notes bridge (vaultIngest in mcp.js); what
// the assistant remembers for them is queued and the bridge files it there. A friend's vault lives in their own
// database and is built by the assistant as they talk to it (remember / forget).
import { cfg } from './config.js';
import { ToolError } from './chat.js';

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
});

export const VAULT_TOOLS = [
  fn('whoami', 'Who the owner is: their "About Me" note (background, school, work, projects, goals, routine, how they like answers), plus the current date, time and time zone. Use it when the answer depends on who they are or what they are working on.'),
  fn('search_notes', 'Full-text search of their notes vault (projects, courses, areas, session notes, daily notes). Returns paths and matching snippets; read a note with read_note.', {
    query: S('Words to look for'), folder: S('Optional folder prefix, e.g. "30 Project and Hobby/31 Pet Projects" or "10 Learning and Teaching/11 Academic"'), limit: { type: 'integer', description: 'Max results, default 5, up to 10' },
  }, ['query']),
  fn('read_note', 'Read a bounded part of a note. Prefer a named section; use next_offset to continue. Default 4000 characters, maximum 12000. Takes a path or note title.', { path: S('Note path or title'), section: S('Exact heading text, without #'), offset: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 200, maximum: 12000 } }, ['path']),
  fn('list_notes', 'List notes in their vault, newest first: path, title, tags, last edit.', { folder: S('Optional folder prefix'), limit: { type: 'integer', description: 'Default 50, up to 300' } }),
  fn('related_notes', 'Follow the links of their notes (a knowledge graph): what a note links to, and every note that links to it, with the line around each link. Works for concepts without a note of their own too, e.g. "CUDA". Use it to widen from one note to related projects, courses, sessions and ideas.', {
    note: S('A note title or path, or a concept name'),
  }, ['note']),
  fn('recent_sessions', 'Their recent work and study sessions (session notes): what got done, decisions and next steps. Use for "what have I been working on" or to pick up where a project left off.', {
    limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Default 5 sessions' }, days: { type: 'integer', description: 'How far back, default 7, up to 90' }, project: S('Optional project, course or area name, e.g. "Batcave" or "EECE 448"'),
  }),
];

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

// [[Target]], [[Target|label]], [[Target#heading]], [[Folder/Target]]; ![[embeds]] of non-notes (.base, images) are skipped.
const LINK = /(!?)\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
const linksIn = (body) => [...new Set([...body.matchAll(LINK)].filter((m) => !(m[1] && /\.\w+$/.test(m[2]))).map((m) => m[2].trim()).filter(Boolean))];
// LIKE patterns for a link to `title`: [[Title]], [[Title|…]], [[Title#…]] and path-style [[Folder/Title…]].
const linkPatterns = (title) => {
  const t = title.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c);
  return [']]', '|', '#'].flatMap((end) => [`%[[${t}${end}%`, `%[[%/${t}${end}%`]);
};

export function noteSection(body, heading) {
  if (typeof heading !== 'string' || heading.length > 200) throw new ToolError('section must be a heading of at most 200 characters.');
  const lines = body.split('\n');
  let fence = null, start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1]; else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    if (fence) continue;
    const h = lines[i].match(/^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
    if (!h) continue;
    if (start >= 0 && h[1].length <= level) return lines.slice(start, i).join('\n').trimEnd();
    if (start < 0 && h[2] === heading.trim()) { start = i; level = h[1].length; }
  }
  if (start >= 0) return lines.slice(start).join('\n');
  throw new ToolError('Section not found. Read the beginning of the note to find its heading.');
}

export function vaultTools(env, lib) {
  const db = env.DB;
  const note = async (p) => {
    const path = clip(p, 500);
    return (await db.prepare('SELECT * FROM vault_notes WHERE path = ?1').bind(path).first())
      || (await db.prepare('SELECT * FROM vault_notes WHERE lower(title) = lower(?1) ORDER BY length(path) LIMIT 1').bind(path.replace(/\.md$/i, '')).first());
  };
  return {
    async whoami() {
      const about = await db.prepare("SELECT path, body, updated_at FROM vault_notes WHERE lower(title) = 'about me' ORDER BY length(path) LIMIT 1").first();
      const n = await db.prepare('SELECT COUNT(*) AS n FROM vault_notes').first('n');
      const queued = env.UID ? [] : await queue(db);
      return {
        name: cfg.ownerFull || cfg.owner || null, now: lib.localNow(), time_zone: cfg.tz, notes_in_vault: n,
        about_me_path: about?.path || null,
        about_me_truncated: (about?.body.length || 0) > 4000,
        about_me: about?.body.slice(0, 4000) || 'No "About Me" note yet. Use search_notes and recent_sessions to learn about them.',
        ...(queued.length ? { just_remembered: queued.map((m) => m.fact) } : {}),
      };
    },
    async search_notes(a) {
      // shortcut: a LIKE scan, fine for a few thousand notes; move to FTS5 (D1 has it) if the vault grows past that.
      const ws = words(a.query);
      if (!ws.length) throw new ToolError('query needs at least one word');
      const limit = Math.min(Math.max(+a.limit || 5, 1), 10);
      const args = [], where = [];
      for (const w of ws) { args.push(like(w)); where.push(`(lower(title) LIKE ?${args.length} ESCAPE '\\' OR lower(tags) LIKE ?${args.length} ESCAPE '\\' OR lower(body) LIKE ?${args.length} ESCAPE '\\')`); }
      if (a.folder) { args.push(clip(a.folder, 200).replace(/\/+$/, '') + '/%'); where.push(`path LIKE ?${args.length}`); }
      const { results } = await db.prepare(`SELECT path, title, tags, updated_at, body FROM vault_notes WHERE ${where.join(' AND ')}`).bind(...args).all();
      const titleHits = (n) => ws.filter((w) => n.title.toLowerCase().includes(w)).length;
      results.sort((x, y) => titleHits(y) - titleHits(x) || String(y.updated_at).localeCompare(String(x.updated_at)));
      return { query: a.query, total: results.length, results: results.slice(0, limit).map((n) => ({ path: n.path, title: n.title, tags: n.tags, updated_at: n.updated_at, snippet: snippet(n.body, ws) })) };
    },
    async read_note(a) {
      const [path, fragment] = typeof a.path === 'string' ? a.path.split('#', 2) : [];
      const n = await note(path);
      if (!n) throw new ToolError('No note with that path or title. Use search_notes or list_notes.');
      const section = a.section || fragment;
      const source = section ? noteSection(n.body, section) : n.body;
      const offset = a.offset ?? 0, max = a.max_chars ?? 4000;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max) || max < 200 || max > 12000) throw new ToolError('Use a nonnegative offset and max_chars between 200 and 12000.');
      let end = Math.min(source.length, offset + max);
      if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1] || '')) end--;
      const truncated = end < source.length;
      return { path: n.path, title: n.title, tags: n.tags, updated_at: n.updated_at, section: section || null, body: source.slice(offset, end), offset, next_offset: truncated ? end : null, truncated };
    },
    async list_notes(a) {
      const limit = Math.min(Math.max(+a.limit || 50, 1), 300);
      const args = [limit];
      let where = '1';
      if (a.folder) { args.push(clip(a.folder, 200).replace(/\/+$/, '') + '/%'); where = `path LIKE ?${args.length}`; }
      const { results } = await db.prepare(`SELECT path, title, tags, updated_at FROM vault_notes WHERE ${where} ORDER BY updated_at DESC LIMIT ?1`).bind(...args).all();
      return { notes: results };
    },
    async related_notes(a) {
      // shortcut: links are parsed at query time with LIKE scans, fine for a few thousand notes; store them at ingest if it grows.
      const name = clip(a.note, 300);
      if (!name) throw new ToolError('note is required');
      const n = await note(name);
      const title = n?.title || name.replace(/\.md$/i, '').split('/').pop();
      const targets = n ? linksIn(n.body) : [];
      const resolved = [];
      for (const t of targets.slice(0, 60)) {
        const hit = await note(t.includes('/') ? t + '.md' : t);
        resolved.push({ title: t.split('/').pop(), path: hit?.path || null });
      }
      const pats = linkPatterns(title);
      const { results } = await db.prepare(
        `SELECT path, title, body FROM vault_notes WHERE (${pats.map((_, i) => `lower(body) LIKE ?${i + 1} ESCAPE '\\'`).join(' OR ')}) ${n ? `AND path != ?${pats.length + 1}` : ''}
         ORDER BY updated_at DESC LIMIT 30`
      ).bind(...pats, ...(n ? [n.path] : [])).all();
      const lower = title.toLowerCase();
      const linked_from = results.map((r) => ({
        path: r.path, title: r.title,
        context: (r.body.split('\n').find((l) => linksIn(l).some((t) => t.toLowerCase().split('/').pop() === lower)) || '').trim().slice(0, 240),
      }));
      return {
        note: n ? { path: n.path, title: n.title } : { title, path: null, has_own_note: false },
        links_to: resolved.filter((r) => r.path), mentions_without_note: resolved.filter((r) => !r.path).map((r) => r.title),
        linked_from,
      };
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
      const { results } = await db.prepare(`SELECT path, title, updated_at, body FROM vault_notes WHERE ${where} ORDER BY title DESC LIMIT ${Math.min(Math.max(Math.floor(+a.limit || 5), 1), 10)}`).bind(...args).all();
      return {
        since, sessions: results.map((n) => ({
          path: n.path, title: n.title, summary: sectionOf(n.body, 'Summary'),
          next_steps: sectionOf(n.body, 'Next steps') ?? sectionOf(n.body, 'Review next'),
        })),
      };
    },
  };
}

// ---------- memory: the assistant saves lasting facts as they come up ----------
const MEMORY_KEY = 'alfred:memories'; // owner: facts waiting for the notes bridge to file them
const ABOUT = 'About Me';
const noteName = (n) => clip(n, 60).replace(/[\\/:#^|[\]?*"<>]/g, '').trim() || ABOUT;
const queue = async (db) => JSON.parse((await db.prepare('SELECT value FROM meta WHERE key = ?1').bind(MEMORY_KEY).first('value')) || '[]');
const saveQueue = (db, list) => db.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2').bind(MEMORY_KEY, JSON.stringify(list)).run();
export const memoryQueue = { list: queue, save: saveQueue };

export const MEMORY_TOOLS = [
  fn('remember', 'Save one lasting fact about them to their notes: background, school, work, goals, preferences, routines, important people. Call it on your own whenever they mention one; do not ask first. Not for passwords or other secrets, tasks, events or one-off details.', {
    fact: S('One short fact in plain words, e.g. "Studies nursing at Hunter College" or "Prefers short answers"'),
    note: S('Optional topic note, e.g. "Work", "People", "Health". Default: About Me'),
  }, ['fact']),
  fn('forget', 'Remove saved facts they ask you to forget. Removes the saved lines that contain the given words.', {
    text: S('Words from the fact to forget'), note: S('Optional topic note; default: every note'),
  }, ['text']),
];

export function memoryTools(env, lib, actions) {
  const db = env.DB;
  const stamp = () => { const { date, time } = lib.localNow(); return `${date}T${time}`; };
  return {
    async remember(a) {
      const fact = clip(a.fact, 300).replace(/\s+/g, ' ').replace(/^-\s*/, '');
      if (fact.length < 3) throw new ToolError('fact is required');
      const note = noteName(a.note);
      if (!env.UID) { // the owner: the notes bridge writes it into their notes app
        const list = await queue(db);
        if (list.some((m) => m.fact.toLowerCase() === fact.toLowerCase())) return { ok: true, already_saved: true };
        list.push({ id: crypto.randomUUID().slice(0, 8), fact, note, at: stamp() });
        await saveQueue(db, list.slice(-200));
      } else {
        const path = note + '.md';
        const row = await db.prepare('SELECT body FROM vault_notes WHERE path = ?1').bind(path).first();
        if (row?.body.toLowerCase().includes(fact.toLowerCase())) return { ok: true, already_saved: true };
        const body = (row?.body || `# ${note}\n`).replace(/\n*$/, '\n') + `- ${fact}\n`;
        if (body.length > 100_000) throw new ToolError(`The ${note} note is full; save it under another topic.`);
        await db.prepare(`INSERT INTO vault_notes (path, title, folder, updated_at, body) VALUES (?1, ?2, '', ?3, ?4)
          ON CONFLICT(path) DO UPDATE SET updated_at = ?3, body = ?4`).bind(path, note, stamp(), body).run();
      }
      const summary = `Remembered: ${fact}`;
      actions.push(summary);
      return { ok: true, note, summary };
    },
    async forget(a) {
      const text = clip(a.text, 200).toLowerCase();
      if (text.length < 3) throw new ToolError('Say which fact to forget.');
      const only = a.note ? noteName(a.note) : null;
      if (!env.UID) {
        const list = await queue(db);
        const keep = list.filter((m) => !(m.fact.toLowerCase().includes(text) && (!only || m.note === only)));
        if (keep.length === list.length) throw new ToolError('Nothing waiting matches. Facts already filed are in "00 Home/01 About Me/Alfred memory.md" in their notes app, where they can delete the line.');
        await saveQueue(db, keep);
        const summary = `Forgot ${list.length - keep.length} saved fact(s)`;
        actions.push(summary);
        return { ok: true, summary };
      }
      const { results } = await db.prepare("SELECT path, title, body FROM vault_notes WHERE folder = ''").all();
      const changes = [];
      let removed = [];
      for (const n of results) {
        if (only && n.title !== only) continue;
        const lines = n.body.split('\n');
        const gone = lines.filter((l) => l.startsWith('- ') && l.toLowerCase().includes(text));
        if (gone.length) { removed = removed.concat(gone); changes.push([n.path, lines.filter((l) => !gone.includes(l)).join('\n')]); }
      }
      if (!removed.length) throw new ToolError('No saved fact matches. Use whoami or search_notes to see what is saved.');
      if (removed.length > 5) throw new ToolError(`That matches ${removed.length} facts; be more specific.`);
      await db.batch(changes.map(([path, body]) => db.prepare('UPDATE vault_notes SET body = ?2, updated_at = ?3 WHERE path = ?1').bind(path, body, stamp())));
      const summary = `Forgot: ${removed.map((l) => l.slice(2)).join('; ')}`;
      actions.push(summary);
      return { ok: true, summary };
    },
  };
}
