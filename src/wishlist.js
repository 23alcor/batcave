import { userDB, userStub } from './userdb.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const bad = (error, status = 400) => json({ error }, status);
const statuses = ['Searching', 'Waiting for discount', 'Saving money', 'Bought', 'Gave up'];
export const webURL = (value) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
};
export async function wishlistDB(env) {
  if (env.UID === 'demo' || env.UID == null) return env.DB;
  const host = await (env.D1 || env.DB).prepare('SELECT host FROM wish_members WHERE uid = ?1').bind(env.UID).first('host');
  return host == null || host === env.UID ? env.DB : host === 0 ? env.D1 || env.DB : userDB(userStub(env, host));
}
export async function wishlist(req, env, path, method, today) {
  let b = {};
  if (method !== 'GET' && !['/api/wishlist/share', '/api/wishlist/leave'].includes(path)) { try { b = await req.json(); } catch { return bad('Invalid JSON'); } }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('Invalid item');
  const central = env.D1 || env.DB, uid = env.UID ?? 0;
  const host = uid === 'demo' ? uid : (await central.prepare('SELECT host FROM wish_members WHERE uid = ?1').bind(uid).first('host')) ?? uid;
  if (path === '/api/wishlist/share' && method === 'POST') {
    const code = crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
    await central.prepare('INSERT INTO wish_codes (code, host) VALUES (?1, ?2)').bind(code, host).run();
    return json({ code }, 201);
  }
  if (path === '/api/wishlist/join' && method === 'POST') {
    const code = typeof b.code === 'string' ? b.code.trim().toUpperCase() : '';
    const target = await central.prepare('SELECT host FROM wish_codes WHERE code = ?1').bind(code).first('host');
    if (target == null) return bad('That code is not valid or was already used.', 404);
    if (target === host) return bad('You already have this list open.');
    if (target === uid) return bad('Use Return to my wishlist to open your own list.');
    if (host !== uid || await central.prepare('SELECT uid FROM wish_members WHERE host = ?1 LIMIT 1').bind(uid).first()) return bad('Leave your shared wishlist before joining another.');
    // Claiming and joining happen together; a reused code cannot grant access.
    const result = await central.batch([
      central.prepare('INSERT INTO wish_members (uid, host) SELECT ?1, host FROM wish_codes WHERE code = ?2').bind(uid, code),
      central.prepare('DELETE FROM wish_codes WHERE code = ?1').bind(code),
    ]);
    return result[0].meta.changes ? json({ ok: true }) : bad('That code was already used.', 409);
  }
  if (path === '/api/wishlist/leave' && method === 'POST') {
    if (host === uid) {
      await central.batch([
        central.prepare('DELETE FROM wish_members WHERE host = ?1').bind(uid),
        central.prepare('DELETE FROM wish_codes WHERE host = ?1').bind(uid),
      ]);
    } else await central.prepare('DELETE FROM wish_members WHERE uid = ?1').bind(uid).run();
    return json({ ok: true });
  }
  const db = await wishlistDB(env);
  if (path === '/api/wishlist' && method === 'GET') {
    const { results } = await db.prepare('SELECT * FROM wishlist ORDER BY created_at DESC').all();
    const { results: people } = uid === 'demo' ? { results: [] } : await central.prepare('SELECT uid FROM wish_members WHERE host = ?1').bind(host).all();
    const memberIds = [...new Set([host, ...people.map(p => p.uid)])];
    const contributorIds = [...new Set([uid, ...memberIds, ...results.map(i => i.added_by).filter(id => id != null)])];
    const userIds = contributorIds.filter(id => id !== 0 && id !== 'demo');
    const { results: names } = userIds.length ? await central.prepare(`SELECT id, name FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`).bind(...userIds).all() : { results: [] };
    const name = id => id === 0 ? env.OWNER_NAME || 'Owner' : id === 'demo' ? 'Preview' : names.find(n => n.id === id)?.name || 'Someone';
    return json({
      items: results.map(i => ({ ...i, links: [...new Set([i.link, ...JSON.parse(i.links || '[]')].filter(webURL))], images: JSON.parse(i.images || '[]') })),
      members: memberIds.filter(id => id !== uid && id !== 'demo').map(name), own: host === uid,
      viewer_id: uid, contributors: contributorIds.map(id => ({ id, name: name(id) })),
    });
  }
  const match = path.match(/^\/api\/wishlist\/([\w-]+)$/);
  if (!(path === '/api/wishlist' && method === 'POST') && !(match && method === 'PATCH')) return bad('not found', 404);
  const sets = [], values = [];
  for (const [key, max] of Object.entries({ name: 300, category: 60 })) {
    if (!(key in b)) continue;
    if (typeof b[key] !== 'string' || b[key].length > max || (key === 'name' && !b[key].trim())) return bad(`Invalid ${key}`);
    sets.push(`${key} = ?${values.push(b[key].trim() || null)}`);
  }
  if ('price' in b) {
    if (b.price !== '' && b.price !== null && (!['string', 'number'].includes(typeof b.price) || !Number.isFinite(+b.price) || +b.price < 0)) return bad('Invalid price');
    sets.push(`price = ?${values.push(b.price === '' || b.price === null ? null : +b.price)}`);
  }
  if ('status' in b) {
    if (!statuses.includes(b.status)) return bad('Invalid status');
    sets.push(`status = ?${values.push(b.status)}`);
    if (b.status === 'Bought') sets.push(`acquired_on = ?${values.push(today)}`);
  }
  if ('links' in b || 'link' in b) {
    const links = b.links ?? (b.link ? [b.link] : []);
    if (!Array.isArray(links) || links.length > 10 || links.some(v => typeof v !== 'string' || v.length > 2000 || !webURL(v))) return bad('Use up to 10 http or https links.');
    sets.push(`links = ?${values.push(JSON.stringify(links))}`, `link = ?${values.push(links[0] || null)}`);
  }
  if ('images' in b) {
    if (!Array.isArray(b.images) || b.images.length > 6 || b.images.some(v => typeof v !== 'string' || !(v.length <= 2000 && webURL(v) || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(v))) || JSON.stringify(b.images).length > 700000) return bad('Use up to 6 images (about 700 KB in all), or image URLs.');
    sets.push(`images = ?${values.push(JSON.stringify(b.images))}`);
  }
  if (method === 'POST') {
    if (!b.name?.trim()) return bad('name is required');
    const id = crypto.randomUUID().replace(/-/g, '');
    sets.push(`added_by = ?${values.push(uid)}`);
    const columns = sets.map(s => s.split(' = ')[0]);
    await db.prepare(`INSERT INTO wishlist (id, ${columns.join(', ')}) VALUES (?1, ${values.map((_, i) => '?' + (i + 2)).join(', ')})`).bind(id, ...values).run();
    return json({ id }, 201);
  }
  if (!sets.length) return bad('nothing to update');
  const result = await db.prepare(`UPDATE wishlist SET ${sets.join(', ')} WHERE id = ?${values.length + 1}`).bind(...values, match[1]).run();
  return result.meta.changes ? json({ ok: true }) : bad('item not found', 404);
}
