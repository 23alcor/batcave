# Batcave

A personal command center you host yourself: tasks and deadlines, a Google-Calendar-style week view with
two-way Google Calendar sync, daily and weekly habits, wake-up times, a wishlist, a garage log, and a
chat assistant (a polite butler named Alfred by default) that can read and change all of it.

It runs on Cloudflare Workers + D1 (the free plan is enough), has no build step, and is locked behind your own
password. Name it, rename the assistant, and set your time zone in one config file.

![Batcave dashboard](docs/screenshot.png)

## What you get

- **Command page** built from widgets: overdue, due today, next 7 days, daily habits, calendar, date, projects, focus, garage.
  Choose **Settings → Edit home screen** (or hold a widget on a phone) to customize it like an iPhone home screen:
  drag to rearrange, pick Small / Medium / Large, remove with −, or use **+ Add widget** in the bar that pops up.
  The calendar widget shows your next events (small), the rest of today (medium) or the full week (large); the date
  widget shows today like the iPhone's, with the month in medium and large. The layout is saved to your account.
- **Settings** (bottom-left, or More on a phone): theme (Auto, Light, Dark, or a color theme: Nord, Signal, Forest, Solarized, Rosé), home screen editing, sidebar, and Lock.
- **Week calendar** you edit like Google Calendar: drag events to move them, drag the bottom edge to resize,
  click or drag on empty space to create, click an event for a details card. Changes go straight to Google
  Calendar. Tasks with a time sit in the grid too (tick to finish, drag to reschedule).
- **Wake-up line** on every day (drag to change one day; click to set a weekday or the default).
- **Weather** beside the date and in each calendar day header: current conditions and daily highs/lows in Fahrenheit from [Open-Meteo](https://open-meteo.com/), cached for 15 minutes. Allow browser location access to follow your device; coordinates are rounded to two decimals before fetching the forecast. Dates outside the forecast range show a dash.
- **Projects page**: click **Edit** to add or delete projects. Deleting hides the project, keeps its tasks, and supports Undo / Redo.
- **Daily page**: daily habits, weekly habits (done once each Sunday–Saturday week) and their history.
- **Recipes page**: medium cards with an **Add recipe** card. Save a name, time, servings, ingredients and instructions; view or edit a recipe, or permanently remove it after confirmation. Alfred can find, read, add, edit and remove recipes from chat.
- **Wishlist**: **Add item** opens the item form in a dialog, with optional images and links. Choose from all 10 layouts with **Card style**; your choice is remembered on this browser. Switching styles keeps in-progress edits and does not change the shared list. add and edit items with up to 10 links and 6 images (large photos are shrunk in the browser to fit, or use image URLs). **Sharing settings** hides invite and code-entry controls until expanded. Invite someone to edit the same wishlist. Joining preserves your private wishlist; **Return to my wishlist** restores it. The host can **Stop sharing** to return everyone to their own list. Wishlist and Eating Out sharing are independent.
- **Eating out page**: click **Add address** in the new-place form to open map search, choose a business, and add it with its address and location. The map stays hidden until requested. When `GOOGLE_MAPS_API_KEY` is configured, cards load the first matched Google business photo with author credits, falling back to Street View at the saved address. Photos are fetched as cards become visible; Google photo references are never stored. **Near me** centers the map using your device location; adding a city to a search also narrows it down. Uses Leaflet, OpenStreetMap tiles, Photon search and NYC Open Data restaurant results without an API key; manual entry remains available. Restaurants you want to try and ones you've been to have cuisine and area. Edit place details or remove a place with its dish history. Log what you ate at each place (with notes and a date), then edit or remove any dish/visit. Alfred can add, edit and remove restaurants and dated dishes using the same shared-list permissions; logging a dish moves the place to **Been**. Status changes and dish logs support Undo / Redo. You have one active Eating Out list; separate simultaneous lists are not supported. Sharing affects only Eating Out. Open **Sharing settings**, then click **Make a share code** and send them the code; once they enter it you both see and edit the same places. **Leave shared list** gives you a fresh empty list and leaves the shared places with the others.
- **Assistant** (bottom-left, press `/`): "what's overdue?", "move my dentist appointment to Friday at 3",
  "add laundry as a weekly habit". It uses OpenAI with tools over your data; recipe removal is permanent and requires an explicit request.
  Give it a vague to-do and it picks a sensible time from your free slots.
  New tasks are matched to your active projects using their context; tasks with no clear match are labeled **Other**.
- **To-do API**: send a sentence from a phone shortcut or script; the assistant files it and answers.
- **Sessions**: send in the transcript of a work or study session (a chat with an AI tool, a coding-agent run);
  it's summarized into a short session note, matched to the right note, and handed to your notes app through a
  small bridge (for example an Obsidian vault on your computer).
- **Undo** supported changes with ⌘Z / Ctrl+Z, and an **iPhone** layout you can add to your home screen.

## Quick start

You need [Node.js 20+](https://nodejs.org) and a free [Cloudflare account](https://dash.cloudflare.com/sign-up). Running the SQLite-backed test suite requires Node.js 22.13+.

```bash
git clone https://github.com/23alcor/batcave.git
cd batcave
npm install
npm run setup
```

`npm run setup` asks for your name, the dashboard and assistant names, your time zone and (optionally) a
domain. It then creates the D1 database, writes `wrangler.jsonc`, creates the tables, offers some example data,
deploys, and sets your login password. At the end, open the URL it printed and sign in.

Everything personal lives in files git ignores (`wrangler.jsonc`, `.env`, `.dev.vars`, `.site-password`), so you
can pull updates without conflicts.

## Settings

In `wrangler.jsonc` → `vars` (template: [`wrangler.example.jsonc`](wrangler.example.jsonc)). Run `npm run deploy`
after changing them.

| Var | What it does | Default |
| --- | --- | --- |
| `APP_NAME` | Name in the sidebar, page titles, login page and home-screen icon | `Batcave` |
| `OWNER_NAME` | Your first name ("Good evening, Sam") | empty |
| `OWNER_FULL_NAME` | Shown on the public `/privacy` page | `OWNER_NAME` |
| `ASSISTANT_NAME` | The assistant's name ("Ask Alfred") | `Alfred` |
| `HONORIFIC` | How the assistant addresses you | `sir` |
| `TIMEZONE` | IANA time zone used for every date and time | `America/New_York` |
| `TAGLINE` | Optional line under the sidebar's assistant button | empty |
| `CONTACT_EMAIL` | Optional contact on `/privacy` | empty |
| `OPENAI_MODEL`, `OPENAI_REASONING` | Assistant model and reasoning effort | `gpt-6.1-terra`, `low` |

Secrets are set with `npx wrangler secret put NAME` and never stored in the repo:

| Secret | For |
| --- | --- |
| `PASSWORD_HASH`, `SESSION_SECRET` | Login (set by `npm run set-password`) |
| `OPENAI_API_KEY` | The assistant |
| `INGEST_TOKEN` | The to-do API, the Alfred command API and the Sessions API |
| `MCP_TOKEN` | Optional: lets AI tools that take a header (Claude Code, Cursor, Codex) use the MCP server |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Calendar sync |
| `GOOGLE_MAPS_API_KEY` | Optional Eating Out business photos; enable Places API (New) and Street View Static API with billing |

## Keyboard shortcuts

| Key | Does |
| --- | --- |
| `N` or `⌘K` | New task / inbox item / event |
| `/` | Open the assistant |
| `⌘Z` / `⇧⌘Z` | Undo / redo the last change |
| `⌘B` | Hide or show the sidebar |
| `Esc` | Close a card, or finish editing the Command page |
| `←` `→` | While editing the Command page: move the focused widget (`Delete` removes it) |

On iPhone: open the site in Safari → Share → **Add to Home Screen**.

## The assistant

Set an OpenAI key (a [project key](https://platform.openai.com/api-keys) with a monthly budget is a good idea):

```bash
npx wrangler secret put OPENAI_API_KEY
```

It uses the OpenAI Responses API with about two dozen tools over your data (projects, tasks, calendar, habits, wake-up times,
wishlist, garage). Conversation history stays in your browser tab. Its personality is a dry-witted English
butler; the name and how it addresses you come from your settings.

## Budget

Budget lives in the existing sidebar. Set category limits for the current month or week, review manual/CSV expenses, and track monthly or annual subscriptions on a renewal calendar. The dashboard totals confirmed personal spending; scheduled subscriptions and transactions awaiting review are excluded. Weekly and monthly limits are linked using 52 weeks per year (about 4.33 weeks per month): monthly × 12 / 52 gives weekly, and weekly × 52 / 12 gives monthly, rounded to cents. The most recently saved applicable limit sets both views; when both cadences already have saved limits, the most recent edit of their latest effective records wins. Limits carry forward until you change them in a later period, preserving earlier budgets.

Outings keep the card charge separate from your own share. Record each friend’s repayment or forgive an amount; forgiveness becomes personal spending in the original outing period. Repayments never count as income. Subscriptions count only when you record their actual charge, with one tracked charge per billing cycle.

CSV headers are `date,name,amount` with optional `category,id`. Dates are YYYY-MM-DD; expenses use positive dollar amounts. Up to 500 rows / 250 KB are accepted. Imports go to Needs review; reimporting the same file skips saved rows. Use stable unique IDs across different statements. Credits/refunds and live bank sync are not implemented; bank linking needs a provider account first.

Alfred has `get_budget` and `propose_budget_change` in chat and MCP. His writes only prepare **one-record proposals**. Review the exact before/after in Budget → Alfred proposals and approve each yourself. Proposals expire after 24 hours and stale versions are rejected. Archived records live only in Budget → Archive, where you can restore them or confirm permanent deletion of one record. Permanent deletion requires an archived, current-version record with no remaining record or pending-proposal references; it removes the record and its proposals, retains change history for audit, and cannot be undone. Alfred cannot permanently delete records; bulk reset is unavailable. Other edits retain audited, version-checked undo. Category archives are blocked while active records use them. History shows the latest 100 changes; JSON export contains current records plus that displayed history. These safeguards cover budget tools; they do not change Alfred’s existing permissions for other app sections.

Apply migration `0017_budget.sql` through the usual migration command before deploying. It creates budget tables and category names, without importing Notion data or inserting sample expenses. Invited users receive the same schema in their private database automatically.

## Alfred command API

`POST /api/ingest/alfred` accepts questions and commands with the same tools as the in-site chat,
including adding, renaming, deleting (archiving), and restoring projects. Authenticate with the existing
`INGEST_TOKEN`. Send plain text or JSON `{"text":"..."}` (`message` also works).
Each request is independent; include enough context to identify the item. Alfred can ask for clarification
when a request is ambiguous. Questions, unsupported commands, and errors are never saved as inbox tasks.

```bash
curl -X POST "https://YOUR_SITE/api/ingest/alfred?format=text" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Rename my Robotics project to Senior Design"}'
```

Without `?format=text`, responses contain `{handled_by, reply, actions, changed}` (or `error` on failure).
This endpoint requires `OPENAI_API_KEY`; if unavailable it returns an error instead of adding a task.
The to-do API below keeps its existing inbox fallback.

## To-do API

Send a to-do from anywhere. The assistant files it (inbox, a dated task in a free slot, a calendar event, a habit…)
or carries it out ("mark the lab report done"), and its answer comes back.

```bash
curl -X POST "https://YOUR_SITE/api/ingest/todo?format=text" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -d "pick up printer ink tomorrow afternoon"
# Added "Pick up printer ink" for Sat, Oct 31 at 2:00 PM, sir.
```

- Body: plain text, or JSON `{"text": "...", "notes"?, "due_at"?: "YYYY-MM-DD[THH:MM]", "url"?, "source"?}`
  (`title`, `name` or `task` also work in place of `text`).
- `?format=text` returns just the sentence (good for a shortcut's notification); without it you get JSON
  `{handled_by, reply, actions}`. `?alfred=0` skips the assistant and saves straight to the inbox.
- Nothing is lost: if the assistant is unavailable, the text is saved to the inbox as written.
- `npm run setup` can create the token (saved to `.env`), or: `npx wrangler secret put INGEST_TOKEN`.

**Apple Shortcuts**: *Ask for Input* → *Get Contents of URL* (method POST, header `Authorization: Bearer <token>`,
JSON body `text` = Provided Input, URL ending in `?format=text`) → *Show Notification* with the result. Don't share
the shortcut file; it contains your token.

## Sessions (transcripts → your notes)

Send the transcript of a work or study session. The assistant's model writes a short session note (summary, what
changed, decisions and next steps for work; what was covered, key ideas, what's unclear and what to review for
study), labels what kind of session it was (call, interview, meeting, lecture, coding, study, research, writing,
planning or other), picks the note it belongs to, and the **Sessions** page shows it. A notes bridge on your computer then
collects the ready ones and writes them into your notes app.

```bash
curl -X POST "https://YOUR_SITE/api/ingest/transcripts?source=codex" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  --data-binary @session.txt
# {"id":"…","status":"new"}
```

- Body: plain text, or JSON `{"transcript": "...", "source"?, "title"?, "target"?, "kind"?: "work" | "study",
  "started_at"?, "ended_at"?: "YYYY-MM-DDTHH:MM"}`. In plain-text mode the same fields work as URL parameters.
  Up to 1.5 MB per transcript. You can also paste one on the Sessions page.
- It's summarized right away when it can be; anything still waiting is picked up by the bridge, the optional
  cron in `wrangler.example.jsonc`, or **Retry** on the Sessions page. Needs `OPENAI_API_KEY`.
- The model never copies passwords, keys or tokens into the summary. The full transcript is always kept and
  handed to the bridge along with the summary.

**Bridge API** (same `INGEST_TOKEN`):

| Request | Does |
| --- | --- |
| `PUT /api/ingest/transcripts/targets` | `{"targets": [{"name", "kind"?, "hint"?}], "rules"?: "..."}`: the notes a session can belong to, and extra rules for the model |
| `GET /api/ingest/transcripts?status=ready` | Summaries waiting to be saved (`status` takes a comma list: new, summarizing, ready, filed, error, dismissed) |
| `GET /api/ingest/transcripts/:id` | One session with its transcript |
| `POST /api/ingest/transcripts/:id/summarize` | Summarize one that is waiting, and return it |
| `POST /api/ingest/transcripts/:id/filed` | `{"path"?}`: it was saved to your notes |

## MCP server (your context for any AI)

`/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server, so Claude, ChatGPT, Cursor, Codex and
other AI apps can look you up instead of you re-explaining yourself. It runs as you (the owner) and offers:

- **Your notes vault** (a read-only copy the notes bridge keeps up to date): `whoami` (your "About Me" note plus
  the current time), `search_notes`, `read_note`, `list_notes`, `recent_sessions`, and `related_notes`, which
  follows `[[links]]` both ways (what a note links to, and every note that links to it).
- **Your dashboard**: overview, tasks, schedule, free time, projects, habits, wishlist, garage, recipes, places to
  eat. Dashboard writes are `create_task` and `log_session` (sends the conversation to Sessions, above). Managed
  project briefs and task handoffs can also be updated through the context tools below; original notes cannot be edited or deleted.

Connect it two ways:

- **Connector UIs** (claude.ai, the Claude apps, ChatGPT): add a custom connector with the URL
  `https://YOUR_SITE/mcp`. You sign in to your site and click Allow. This needs a KV namespace for OAuth:
  `npx wrangler kv namespace create OAUTH_KV`, then add it to `wrangler.jsonc` (see `wrangler.example.jsonc`).
- **Tools that take a header**: `npx wrangler secret put MCP_TOKEN` (any long random string), then for example
  `claude mcp add --transport http batcave https://YOUR_SITE/mcp --header "Authorization: Bearer $MCP_TOKEN"`.

**Vault copy.** A notes bridge (for example a script on your Mac that reads your Obsidian vault) keeps it current
with the `INGEST_TOKEN`:

| Request | Does |
| --- | --- |
| `GET /api/ingest/vault` | `{"hashes": {path: hash}}`, so the bridge sends only what changed |
| `PUT /api/ingest/vault` | `{"notes": [{"path", "title", "folder"?, "tags"?, "updated_at"?, "hash"?, "body"}], "keep"?: [paths]}`: saves the notes (up to 500 per request, 200 KB each); with `keep`, removes every note not listed |

**Alfred remembers.** When you mention something lasting about yourself in chat (school, work, goals,
preferences, people), Alfred saves it. Your facts wait in a queue until the notes bridge writes them into your notes
app (`GET /api/ingest/memories`, then `POST /api/ingest/memories/filed` with `{"ids": [...]}`). Friends have no
bridge: each friend's vault lives in their own database and is built entirely from what they tell Alfred. Ask
Alfred "what do you know about me?" to see it, or "forget …" to remove a fact. The MCP server stays owner-only.

Put a note titled **About Me** in the vault (who you are, what you're working on, how you like answers): `whoami`
returns up to 4,000 characters of it. For project work the server tells AI clients to resume the relevant project or task first; personal background is fetched only when needed. Whatever is in the vault copy is readable by the
apps you connect, so leave out what you wouldn't tell them.

### Project bookmarks, task handoffs, and Agent Graph

For continuing work, call `resume_project` or `resume_task` with an existing note's title/path. Each task gets its
own `session_id`; reuse it on subsequent MCP calls. A connector's `Mcp-Session-Id` header supplies a fallback
identity, but resuming a different task returns a separate session so simultaneous chats do not share one trail.

- `resume_project`: short shared brief and up to 10 task starting points.
- `resume_task`: one task bookmark/handoff and its revision. Supply `since_revision` to get an unchanged response without repeating its content.
- `save_project_brief`: bounded shared brief (1,500 characters) and `entry_note` bookmark.
- `save_handoff`: bounded task handoff (3,000 characters), next action (500), and bookmark. `entry_note` may include `#Heading`.
- Both saves require `expected_revision` (0 creates, later saves must match the last revision read) and a session identity. A stale save is rejected so the client can resume and merge.

`read_note` returns up to 4,000 characters by default (maximum 12,000), with `section`, `offset`, `next_offset`,
and `truncated` fields. Search defaults to five snippets, maximum ten; recent sessions defaults to five,
maximum ten. Oversized tool results return a valid JSON budget message rather than broken, truncated JSON.

The contexts are stored separately from the read-only vault mirror. A bridge retrieves
`GET /api/ingest/contexts`, writes each context beside the existing project note in an `Agent Context/` folder,
and acknowledges `POST /api/ingest/contexts/filed` with `{id, revision}` only after the write succeeds.
These routes require `INGEST_TOKEN`. The supplied bridge accepts only its own `type: agent-context` notes
with matching identity and content hash, preserves manual edits, checks path containment, rejects symlinks,
and writes atomically. Run only one context-writing bridge for a synced vault. New project notes remain
owner-managed; new tasks can be created for any existing typed project/course/area note.

The owner-only live viewer uses:

| Endpoint | Authentication / result |
| --- | --- |
| `GET /api/agent-graph` | Owner login or `MCP_TOKEN`; latest 200 activity events and up to 500 bookmark metadata records |
| `GET /api/agent-graph/stream` | WebSocket; first frame `{type: "authenticate", token: MCP_TOKEN}`; no events before authentication |

The stream requires the `GRAPH_HUB` Durable Object binding and its class migration from `wrangler.example.jsonc`.
Apply D1 migration `0015_agent_graph.sql` before deploying the updated Worker. These tables are owner-only and
are intentionally not installed in friends' databases. The WebSocket closes on invalid/expired authentication;
key rotation stops delivery to already connected viewers. Activity retains the latest 2,000 events, including
agent, task, note paths, and operation timestamps, with no note bodies or raw tool arguments. `save_requested`
means queued; `file_saved` is emitted only after the bridge acknowledges. Graph metadata is delivered directly
to the viewer and does not enter an AI conversation.

The companion Obsidian **Agent Graph** plugin ([source and installation](integrations/obsidian-agent-graph/README.md)) renders the local vault's resolved links and note metadata. It
shows separate agent markers/trails, bookmark markers, a task/project filter, recent activity, and clickable
notes. A session's last successful read or confirmed write determines its marker; search results are highlighted
without pretending that every hit was read. Only MCP calls through this server are instrumented. Local file
reads, private model reasoning, and Alfred's separate in-app tool loop are not shown.

## Google Calendar (two-way)

Optional. Without it, the week view shows the weekly schedule stored in the `events` table (or a read-only
calendar feed: `npx wrangler secret put GCAL_ICS_URL` with your calendar's secret iCal address).

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the **Google Calendar API**.
2. **OAuth consent screen**: External. Add your email as a test user, add the scopes
   `.../auth/calendar.events` and `.../auth/calendar.calendarlist.readonly`, and set the privacy policy URL to
   `https://YOUR_SITE/privacy` (the app serves it). Then **Publish app** → In production, so the sign-in doesn't
   expire after 7 days. You don't need Google's verification for your own account; you'll just see an
   "unverified app" warning once (Advanced → continue).
3. **Credentials** → Create OAuth client ID → Web application → authorized redirect URI
   `https://YOUR_SITE/api/google/callback`.
4. Save the client id and secret:
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
5. On the dashboard's week view, click **Connect Google Calendar**. **Calendars** picks which calendars show;
   **Disconnect** revokes access.

The refresh token is stored encrypted in D1 (AES-GCM, key derived from `SESSION_SECRET`). Repeating events are
edited one occurrence at a time.

## Inviting friends

Friends can get their own Batcave on your install. Each one has a separate, private database (a Cloudflare
Durable Object), so nobody sees anyone else's data. Your own data stays in D1.

1. **Settings → Friends → New invite code.** The sign-up link (`https://YOUR_SITE/signup?code=…`) is copied for
   you. Send it to your friend. Each code works once.
2. They pick a first name, email and password. Their time zone comes from their browser, and they can change
   it, their name and their password under **Settings → Profile**.
3. Settings → Friends lists everyone with how much space they use. **Reset password** gives you a new password
   to send them, and **Delete** removes an invite nobody has used yet.

Things to know:

- You sign in with your usual password. The email box takes any name that isn't a friend's email.
- Friends share your `OPENAI_API_KEY` (the assistant has no usage limit) and your Google OAuth app. They connect
  their own Google Calendar. While the app is unverified, Google shows them the "unverified app" warning and
  allows at most 100 people.
- The to-do API, the calendar feed (`GCAL_ICS_URL`) and the transcript cron are only for you.
- The sign-up page has a **Preview** tab. Its button opens `/demo`, a look-only copy of the app filled with the
  example data in `examples/demo.sql` (refilled once a day so the dates stay current). Nothing can be saved there,
  and the assistant and Google sign-in are off.

## Import from Notion (optional)

`scripts/import-notion.mjs` pulls tasks, projects, an inbox, a garage and a wishlist from Notion
databases. Copy `scripts/notion.config.example.json` to `scripts/notion.config.json`, fill in your data source ids,
and check the property names at the top of each section match yours. Then:

```bash
NOTION_TOKEN=ntn_xxx npm run import:notion
npx wrangler d1 execute batcave --remote --file seed/notion-import.sql
```

## Local development

```bash
npm run db:migrate:local
npm run db:examples:local                # optional sample data
npx wrangler dev --var DEV_BYPASS:1      # skips the login locally
# or: npm run set-password -- --local && npm run dev
```

Put local-only secrets (like `OPENAI_API_KEY`) in `.dev.vars`.

## Updating

```bash
git pull
npm install
npm run db:migrate   # new tables/columns, if any
npm run deploy
```

## Security

- Your password and each friend's are stored as PBKDF2-SHA256 hashes. Sessions are signed HttpOnly cookies
  (30 days), and an IP is locked out after 8 wrong passwords or invite codes in 15 minutes. Until your password
  is set, every page stays locked and nobody can sign up.
- Cross-site writes are refused. The only public paths are `/login`, `/signup` (which needs an unused invite
  code), `/demo` (the read-only preview), `/privacy`, the icons and app manifest, the to-do API (which needs `INGEST_TOKEN`),
  and the MCP server with its OAuth endpoints (`/mcp` needs `MCP_TOKEN` or an OAuth token you approved while signed in).
- Change the password with `npm run set-password` (or `-- --generate` for a random passphrase saved to
  `.site-password`). Changing it signs out every device.

## Project layout

```
src/worker.js      API routes, login, to-do API, wake-up times, habits
src/chat.js        The assistant: OpenAI Responses API tool loop
src/agent-graph.js Owner-only activity stream and managed project/task contexts
src/mcp.js         MCP server for outside AI apps, its OAuth, and the notes-vault copy
src/google.js      Google Calendar OAuth + two-way sync
src/calendar.js    Weekly schedule expansion + iCal parsing
src/auth.js        Password check, session cookie, lockout, login page
src/config.js      Your settings (from wrangler.jsonc vars)
public/            The app (vanilla JS + CSS, no build step)
migrations/        D1 schema
scripts/           setup, set-password, Notion import
examples/          Sample data for a new install
```

## License

[MIT](LICENSE). Make it yours.

### Eating Out business photos

In a Google Maps Platform project with billing enabled, enable **Places API (New)** and **Street View Static API**. Create an API key restricted to those APIs, then save it as a Worker secret (not in source code):

```sh
npx wrangler secret put GOOGLE_MAPS_API_KEY
```

The cards enable photos once the secret is available. Local development can use the same variable in `.dev.vars`. Existing calendar OAuth credentials do not enable Maps photos. Provider usage can incur Google Maps Platform charges.

### Create new Obsidian notes

The owner's Alfred chat and MCP offer `create_note(title, folder, content)` and
`note_status(request_id)`. Creation uses an existing regular vault folder discovered
through note search. Existing titles/files, system folders, sessions and daily notes
are protected. Notes are queued until the Mac confirms a successful file write;
`status: saved` is an acknowledgement, not a promise that a queued request succeeded.
A failed request reports its error; use a new title to resolve a filename conflict.

Apply owner D1 migration `0016_note_requests.sql` before deploying. Run the companion
writer on the Mac with the existing bridge credentials in `~/.config/batcave-bridge.env`:

```sh
python3 scripts/notes-bridge.py --vault '/Users/hasatic/Documents/Bat Vault'
```

Schedule this command alongside the existing bridge (for example every minute with
launchd). The original bridge continues mirroring notes on its normal schedule.
The companion imports its HTTP/config helpers without modifying vault `.tools/` files.
It writes a complete temporary file and exclusively links it into place, never
replacing a destination. Exact retries are acknowledged; manual edits are preserved.
Keep the Mac available for saves. No remote database is inserted into the local vault.

Verification: `python3 scripts/test-notes-bridge.py` and `npm test`.
