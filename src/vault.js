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
    query: S('Words to look for'), folder: S('Optional folder prefix, e.g. "01 Projects" or "02 Areas/School"'), limit: { type: 'integer', description: 'Max results, default 10, up to 30' },
  }, ['query']),
  fn('read_note', 'Read one note in full (with its YAML properties). Takes a path from search_notes/list_notes, or a note title.', { path: S('Path like "01 Projects/Batcave/Batcave.md", or a note title') }, ['path']),
  fn('list_notes', 'List notes in their vault, newest first: path, title, tags, last edit.', { folder: S('Optional folder prefix'), limit: { type: 'integer', description: 'Default 50, up to 300' } }),
  fn('recent_sessions', 'Their recent work and study sessions (session notes): what got done, decisions and next steps. Use for "what have I been working on" or to pick up where a project left off.', {
    days: { type: 'integer', description: 'How far back, default 7, up to 90' }, project: S('Optional project, course or area name, e.g. "Batcave" or "EECE 448"'),
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

export function vaultTools(env, lib) {
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
      const queued = env.UID ? [] : await queue(db);
      return {
        name: cfg.ownerFull || cfg.owner || null, now: lib.localNow(), time_zone: cfg.tz, notes_in_vault: n,
        about_me: about?.body || 'No "About Me" note yet. Use search_notes and recent_sessions to learn about them.',
        ...(queued.length ? { just_remembered: queued.map((m) => m.fact) } : {}),
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
        if (keep.length === list.length) throw new ToolError('Nothing waiting matches. Facts already filed are in "00 Inbox/Alfred memory.md" in their notes app, where they can delete the line.');
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
