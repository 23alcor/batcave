// Password login: PBKDF2 password check, HMAC-signed session cookie, per-IP lockout.
//
// Secrets (set with `npm run set-password`, never committed):
//   PASSWORD_HASH   pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>
//   SESSION_SECRET  random string used to sign session cookies
import { cfg } from './config.js';

const enc = new TextEncoder();
const COOKIE = 'bc_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 8; // wrong passwords per IP per window
const WINDOW_MS = 15 * 60e3;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function checkPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2-sha256' || !iter || !salt || !hash || !password) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const expected = fromB64(hash);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(salt), iterations: Number(iter) }, key, expected.length * 8);
  return sameBytes(new Uint8Array(bits), expected);
}

// Signing over the password hash means changing a password signs that person's devices out.
async function sign(env, msg, pwHash) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(`${msg}.${pwHash}`)));
}

export const authConfigured = (env) => Boolean(env.PASSWORD_HASH && env.SESSION_SECRET);

export async function hashPassword(password, iterations = 100000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(bits)}`;
}

// uid 0 is the owner (PASSWORD_HASH); anyone else is a row in users.
export async function makeSessionCookie(env, uid = 0, pwHash = env.PASSWORD_HASH) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const sig = await sign(env, `${exp}.${uid}.${nonce}`, pwHash);
  return `${COOKIE}=${exp}.${uid}.${nonce}.${sig}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}
export const clearSessionCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// The signed-in person: { id: 0 } for the owner, their users row for a friend, or null.
export async function sessionUser(req, env) {
  if (!authConfigured(env)) return null;
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [exp, uid, nonce, sig] = m[1].split('.');
  if (!exp || !/^\d{1,9}$/.test(uid || '') || !nonce || !sig || !(Number(exp) > Date.now() / 1000)) return null;
  const user = uid === '0' ? { id: 0, password_hash: env.PASSWORD_HASH }
    : await env.DB.prepare('SELECT id, email, name, timezone, password_hash FROM users WHERE id = ?1').bind(Number(uid)).first();
  if (!user) return null;
  return sameBytes(enc.encode(await sign(env, `${exp}.${uid}.${nonce}`, user.password_hash)), enc.encode(sig)) ? user : null;
}

export async function lockedOut(env, ip) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_failures WHERE ip = ?1 AND at > ?2').bind(ip, Date.now() - WINDOW_MS).first();
  return (r?.n || 0) >= MAX_FAILS;
}
export async function recordFailure(env, ip) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO auth_failures (ip, at) VALUES (?1, ?2)').bind(ip, Date.now()),
    env.DB.prepare('DELETE FROM auth_failures WHERE at < ?1').bind(Date.now() - 86400e3),
  ]);
}
export const clearFailures = (env, ip) => env.DB.prepare('DELETE FROM auth_failures WHERE ip = ?1').bind(ip).run();

// Only same-site relative paths, so the login form can't be used as an open redirect.
export function safeNext(next, hash) {
  let path = typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') && !next.startsWith('/login') ? next : '/';
  if (typeof hash === 'string' && /^#\/[\w/-]{0,100}$/.test(hash)) path += hash;
  return path;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shell(title, inner) {
  const app = esc(cfg.app);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="${app}">
<link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest">
<title>${app} · ${title}</title><meta name="theme-color" content="#0F1012"><meta name="robots" content="noindex">
<link rel="icon" href="/moon.svg" type="image/svg+xml">
<style>
:root{--bg:#F4F4F5;--card:#FFFFFF;--ink:#16171A;--muted:#5C5F66;--line:#DADBDF;--accent:#16171A;--accent-ink:#FFFFFF;--err:#B42318}
@media (prefers-color-scheme:dark){:root{--bg:#0F1012;--card:#17181B;--ink:#E6E6E8;--muted:#A6A9B0;--line:#2A2B30;--accent:#E6E6E8;--accent-ink:#0F1012;--err:#FF8A80}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 Inter,system-ui,-apple-system,sans-serif;padding:16px}
main{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 24px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px;margin:0 0 20px}
.brand svg{flex:none}
label{display:block;font-size:14px;color:var(--muted);margin:12px 0 6px}
label:first-of-type{margin-top:0}
input{width:100%;min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit}
input:focus{outline:2px solid var(--ink);outline-offset:1px}
button{margin-top:16px;width:100%;min-height:44px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-ink);font-family:inherit;font-size:15px;font-weight:600;cursor:pointer}
.err{color:var(--err);font-size:14px;margin:10px 0 0}
.alt{margin:18px 0 0;font-size:14px;color:var(--muted);text-align:center}
.alt a{color:var(--ink)}
</style></head>
<body><main>
<p class="brand"><svg width="26" height="26" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="9" fill="#0F1012"/><path d="M22 6 A14 14 0 1 0 22 34 A6 14 0 1 1 22 6 Z" fill="#FFFFFF"/></svg>${app}</p>
${inner}
</main></body></html>`;
}
const errLine = (error) => (error ? `<p class="err" role="alert">${esc(error)}</p>` : '');

export function loginPage({ error = '', next = '/', hash = '', email = '' } = {}) {
  const h = typeof hash === 'string' && /^#\/[\w/-]{0,100}$/.test(hash) ? hash : '';
  return shell('sign in', `<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(next)}"><input type="hidden" name="hash" value="${esc(h)}">
<label for="em">Email</label>
<input id="em" type="text" name="email" value="${esc(email)}" autocomplete="username" autocapitalize="none" spellcheck="false" required ${email ? '' : 'autofocus'}>
<label for="pw">Password</label>
<input id="pw" type="password" name="password" autocomplete="current-password" required ${email ? 'autofocus' : ''}>
${errLine(error)}
<button type="submit">Sign in</button>
</form>
<p class="alt">Got an invite code? <a href="/signup">Create an account</a></p>
<script>if (location.hash) document.querySelector('[name=hash]').value = location.hash;</script>`);
}

export function signupPage({ error = '', code = '', name = '', email = '' } = {}) {
  return shell('create account', `<form method="post" action="/signup">
<input type="hidden" name="timezone" value="">
<label for="code">Invite code</label>
<input id="code" type="text" name="code" value="${esc(code)}" autocomplete="off" autocapitalize="characters" spellcheck="false" required ${code ? '' : 'autofocus'}>
<label for="nm">First name</label>
<input id="nm" type="text" name="name" value="${esc(name)}" autocomplete="given-name" maxlength="40" required ${code ? 'autofocus' : ''}>
<label for="em">Email</label>
<input id="em" type="email" name="email" value="${esc(email)}" autocomplete="username" autocapitalize="none" spellcheck="false" required>
<label for="pw">Password <span style="font-size:12px">(at least 8 characters)</span></label>
<input id="pw" type="password" name="password" autocomplete="new-password" minlength="8" maxlength="200" required>
${errLine(error)}
<button type="submit">Create account</button>
</form>
<p class="alt">Already have an account? <a href="/login">Sign in</a></p>
<script>try { document.querySelector('[name=timezone]').value = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}</script>`);
}
