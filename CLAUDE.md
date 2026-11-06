# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo. User-facing docs are in README.md.

## What this is

Batcave is a self-hosted personal dashboard: one Cloudflare Worker serving a JSON API plus a static,
no-build front end, with Cloudflare D1 (SQLite) as the database. It covers tasks, a Google-Calendar-style week
view with two-way Google sync, daily/weekly habits, wake-up times, a wishlist, a garage log, a
to-do API, and a chat assistant (OpenAI Responses API + function tools). It is a public template: anything
personal comes from config, never from code.

## Commands

```bash
npm install
npx wrangler dev --var DEV_BYPASS:1      # local, login skipped (needs wrangler.jsonc; see below)
npm run db:migrate:local                 # create/upgrade local tables
npm run db:examples:local                # optional sample data
npm run deploy                           # wrangler deploy
npm run db:migrate                       # apply new migrations to the remote D1
npm run set-password [-- --local]        # login password (remote secret, or .dev.vars)
npm run setup [-- --dry-run]             # first-time setup for a new install
node --check src/*.js public/app.js scripts/*.mjs   # quick syntax check (there is no build or test suite)
```

`wrangler.jsonc` is git-ignored. Without one, copy `wrangler.example.jsonc` (any D1 id works for local dev).

## Layout

```
src/worker.js     Entry point: fetch(), auth gate, router api(), every REST handler, HTML personalization
src/chat.js       Assistant: TOOLS (schemas), makeTools() (handlers), instructions(), runAlfred() loop,
                  chat() for /api/chat, processTodo() for the to-do API
src/google.js     Google OAuth + Calendar reads/writes (events are converted to local wall-clock strings)
src/transcripts.js Sessions: transcript intake, structured-JSON summaries (Responses API), bridge API, cron
src/calendar.js   Weekly RRULE expansion, iCal parsing, utcToWall()/zonedToUtc()
src/auth.js       Password hashing, per-user signed session cookie, IP lockout, login and sign-up page HTML
src/userdb.js     UserDB Durable Object (a friend's own SQLite) + userDB(), a D1-shaped wrapper around it
src/config.js     cfg (per-install settings) + loadConfig(env) + publicConfig()
public/app.js     The whole front end, split into "// ---------- name ----------" sections
public/app.css    Styles; tokens in :root, dark theme, phone rules in @media (max-width: 820px)
public/index.html Shell markup + the event/task/wake-up cards and chat window
migrations/       D1 schema, numbered; scripts/ setup, set-password, Notion import; examples/ sample data
```

## Rules that matter

**Nothing personal in code.** Names, time zone, domain, emails, ids go in `wrangler.jsonc` vars and are read
through `cfg` (server) or `CFG` / `window.__CFG` (browser). `loadConfig(env)` runs at the top of `fetch()`.
To expose a new setting: add it to `DEFAULTS` + `cfg` in src/config.js, to `wrangler.example.jsonc` (with a
comment), to the README settings table, and to `scripts/setup.mjs` if new installs should be asked. Only put
non-secret values in `publicConfig()`. Static text in `index.html` that depends on config gets a `data-cfg`
hook and a handler in `personalize()` (HTMLRewriter) in worker.js.

**Never commit secrets or personal data.** Secrets go through `npx wrangler secret put`. Git-ignored on purpose:
`wrangler.jsonc`, `.env`, `.dev.vars`, `.site-password`, `scripts/notion.config.json`, `seed/`,
`CLAUDE.local.md`. Before committing, `git grep --cached` for tokens, keys and real names.

**Dates are local wall-clock strings.** Everything stored and passed around is `'YYYY-MM-DD'` or
`'YYYY-MM-DDTHH:MM'` in the owner's `TIMEZONE`. On the server use `localNow()` and `addDays()` (worker.js) and
`utcToWall()` / `zonedToUtc()` (calendar.js); don't use `new Date()` getters, which are UTC. In the browser,
day strings are formatted with `timeZone: 'UTC'` (`fmtDay`, `parseDay`) on purpose. Weeks run Sunday to
Saturday (`weekStartOf()`), matching the calendar.

**Schema changes = a new migration.** Add `migrations/000N_name.sql`; never change an applied one (wrangler
tracks them by file name). Prefer additive changes (`ALTER TABLE … ADD COLUMN … DEFAULT …`) so an old Worker
still runs while the migration is applied. Small key/value settings can live in the `meta` table instead
(see the `wake:*` keys). A migration that changes per-user tables must also be imported and appended to
`MIGRATIONS` in src/userdb.js, or friends' databases won't get it.

**Friends (multi-user).** The owner (uid 0, `PASSWORD_HASH`) uses D1. Each invited friend (`users` table, made
with a one-time `invites` code at `/signup`) gets their own Durable Object SQLite database. `asUser()` in
worker.js swaps `env.DB` for a D1-shaped wrapper (`userDB()`), so handlers never filter by user. Per-person
settings (name, time zone) come through `cfg`, which reads AsyncLocalStorage (`withUser()`); don't cache
per-person data in module globals without keying it by `env.UID` (see google.js). `/api/account` and
`/api/admin/*` always use the real D1.

**Every visible change can be undone.** Front-end writes call `remember(label, undoFn, redoFn)`, which shows a
toast with Undo and wires ⌘Z / ⇧⌘Z. Keep both functions idempotent API calls.

**Works on a phone.** Check new UI at 393×852 (iPhone) as well as desktop. Breakpoint is 820px (`isPhone()`).
Cards (`.ev-pop`) become bottom sheets on phones; dragging is desktop-only (touch scrolls). Inputs are ≥16px
on phones to avoid iOS zoom.

## Back end conventions

- Handlers return `Response`s via `json(data, status)` / `bad(message, status)`; `withHeaders()` adds the
  security headers. All `/api/*` routes are in `api()` in worker.js.
- Auth: everything except `/login`, `/privacy`, icons, `/manifest.webmanifest` and `/api/ingest/*` requires a
  session (or `DEV_BYPASS=1` locally). Non-GET requests with a foreign `Origin` are refused.
- `/api/ingest/*` uses the `INGEST_TOKEN` bearer token (constant-time compare in `verifyIngest()`).
- Google: `GoogleError` carries user-facing messages. Reads are cached ~30 s per isolate; the front end passes
  `fresh=1` for a minute after a calendar write (`state.calDirty`). For local tests, `GOOGLE_API_BASE`,
  `GOOGLE_TOKEN_URL`, `GOOGLE_CONSENT_URL`, `GOOGLE_REVOKE_URL` can point at a mock, and `PUBLIC_ORIGIN`
  must be set because `wrangler dev` reports the production host in `request.url`.

## Assistant (src/chat.js)

- Add a tool in two places: a schema in `TOOLS` (built with `fn(name, description, properties, required)`)
  and a handler in `makeTools()`. If it needs a worker.js function, pass it in through `alfredLib()` in
  worker.js. Write descriptions in neutral wording ("their calendar"); the persona text lives only in
  `instructions()`, built from `cfg`.
- Handlers look things up before changing them, throw `ToolError` for messages the model should see, and
  call `actions.push(summary)` for every real change. The to-do API relies on that: if nothing was pushed and
  `find_tasks` wasn't called, `processTodo()` saves the text to the inbox so nothing is lost.
- The assistant never deletes: tasks are marked done/cancelled; calendar cancels are one occurrence.
- Tool results are JSON, truncated at 24k chars. Loop limits: `MAX_ROUNDS` 6, `MAX_HISTORY` 20.
- Test without spending tokens: set `OPENAI_BASE_URL` to a small mock of `POST /v1/responses` that returns
  `function_call` items, then a `message`.

## Front end conventions (public/app.js)

- Vanilla JS, no framework, no build. `$`/`$$` query helpers, `esc()` for every interpolated string,
  `api(path, { method, body })` for requests (redirects to /login on 401).
- Views are `view<Name>(el)` functions in `ROUTES`; `render()` redraws the current route, `rerender()` does it
  after 250 ms. Shared data lives in `state` (`state.dash`, `state.week`, …).
- Clicks and checkbox changes go through delegated document listeners keyed on `data-action`; forms on
  `data-form`.
- Week view editing uses one set of document pointer listeners with `evDrag.kind` = `event` | `new` | `task` |
  `wake` | `swallow`. A click outside an open card only closes it.
- CSS: use the tokens (`--card`, `--ink`, `--muted`, `--accent`, `--amber-*`, `--red-*`…); both dark-theme
  blocks (`prefers-color-scheme` and `[data-theme="dark"]`) must stay in sync. `.main` is a flex column with a
  gap, so wrapper elements need `gap: inherit`.

## Before you finish a change

1. `node --check` the files you touched.
2. Run it locally (`wrangler dev --var DEV_BYPASS:1`), click through the feature on desktop and phone sizes,
   and check the console for errors.
3. New table/column? Migration file + `npm run db:migrate:local`.
4. User-visible feature or setting? Update README.md (and `wrangler.example.jsonc` for settings).
5. Nothing personal or secret in the diff.
