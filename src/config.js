import { AsyncLocalStorage } from 'node:async_hooks';

// Per-install settings. They come from `vars` in wrangler.jsonc (see wrangler.example.jsonc) and are
// loaded at the start of every request, so nothing personal is hardcoded in the code.
const DEFAULTS = {
  APP_NAME: 'Batcave',          // shown in the sidebar, page titles, login page and home-screen icon
  OWNER_NAME: '',               // first name: "Good evening, <name>" and how the assistant refers to you
  OWNER_FULL_NAME: '',          // used on the public /privacy page (falls back to OWNER_NAME)
  ASSISTANT_NAME: 'Alfred',     // the chat assistant ("Ask Alfred"); its personality is a polite butler
  HONORIFIC: 'sir',             // how the assistant addresses you: sir, ma'am, boss, your first name…
  TIMEZONE: 'America/New_York', // IANA time zone; every date and time in the app uses it
  TAGLINE: '',                  // optional line under the sidebar's assistant button
  CONTACT_EMAIL: '',            // optional, shown on /privacy (Google asks for a privacy page)
};

const base = {
  app: DEFAULTS.APP_NAME, owner: '', ownerFull: '', assistant: DEFAULTS.ASSISTANT_NAME,
  honorific: DEFAULTS.HONORIFIC, tz: DEFAULTS.TIMEZONE, tagline: '', contact: '', role: 'owner',
};
// A friend's request sees their own name and time zone. AsyncLocalStorage keeps that per request, since one
// isolate serves several people's requests at once.
const als = new AsyncLocalStorage();
export const cfg = new Proxy(base, { get: (t, k) => (als.getStore() || t)[k] });
export const withUser = (over, fn) => als.run({ ...base, ...over }, fn);

const val = (env, k, max = 120) => (typeof env[k] === 'string' && env[k].trim() ? env[k].trim().slice(0, max) : DEFAULTS[k]);

export const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
export function loadConfig(env = {}) {
  cfg.app = val(env, 'APP_NAME', 40);
  cfg.owner = val(env, 'OWNER_NAME', 40);
  cfg.ownerFull = val(env, 'OWNER_FULL_NAME', 80);
  cfg.assistant = val(env, 'ASSISTANT_NAME', 30);
  cfg.honorific = val(env, 'HONORIFIC', 30);
  const tz = val(env, 'TIMEZONE', 60);
  cfg.tz = validTz(tz) ? tz : DEFAULTS.TIMEZONE;
  cfg.tagline = val(env, 'TAGLINE', 200);
  cfg.contact = val(env, 'CONTACT_EMAIL', 120);
  return cfg;
}

// What the browser gets (window.__CFG): nothing secret.
export const publicConfig = () => ({ app: cfg.app, owner: cfg.owner, assistant: cfg.assistant, tz: cfg.tz, tagline: cfg.tagline, role: cfg.role });
