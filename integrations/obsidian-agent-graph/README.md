# Agent Graph

An Obsidian view of actual Batcave MCP note reads, project/task bookmarks, and confirmed vault writes.
The graph uses Obsidian's local resolved links. Live activity comes from the authenticated Batcave WebSocket,
with a bounded snapshot for reconnects. The layout follows the Data terminal direction (seed 199649694),
keeps Obsidian's fonts and surfaces, and uses Bat Vault gold for bookmarks and identity colors for agents.
The screen answers: which notes is each agent using for this task?

## Build and test

Run `node build.mjs`, `node --test test_plugin.mjs`, and `python3 test_bridge.py` in this folder.
The build has no package dependencies. `dist/` contains the three installable files.
Bridge tests locate the installed bridge in `BAT_VAULT` (default `~/Documents/Bat Vault`).
Bridge tests use temporary vaults; they never write to the real project notes.

## Install

1. Deploy the matching Batcave backend after applying `0015_agent_graph.sql`; include `GRAPH_HUB` and its Durable Object class migration in Wrangler configuration.
2. Copy `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` into `<vault>/.obsidian/plugins/bat-vault-agent-graph/`.
3. Enable **Agent Graph** in Obsidian's Community plugins. Run **Agent Graph: Open Agent Graph** from the command palette.
4. Click **Connect**, enter your Batcave address and the existing MCP connection key in the plugin's password field. Do not paste credentials into chat or notes.

Only the server address is saved. The connection key remains in memory until Obsidian closes or you run
**Disconnect from Batcave**. Reconnect after an Obsidian restart. HTTPS is required except on localhost.

The Mac bridge contains the `file_contexts` implementation. Its rulebook section 9 permits only generated
sidecar notes under each project's `Agent Context/` folder. Manual edits to generated notes cause a content-hash
conflict: the bridge preserves those edits and leaves the newer revision queued for review. Other computers
can read synced files, but only one bridge should write contexts.

## Using it

An AI starts with `resume_project` or `resume_task` and keeps that task's returned `session_id`. It can read a
note heading through `read_note`, follow links, and save a handoff using its expected revision. Resume again
before merging a revision conflict. Each active task has its own bookmark and session trail.

The graph displays up to 400 notes at once, prioritizing bookmarks and recently visited notes. Project/task
filters narrow to the relevant notes and their immediate neighbors. Use zoom buttons, mouse wheel, or arrow
keys to explore. Click a note or its activity-row link to open it. Click an agent to emphasize its trail.
The layout adapts to narrow panes and respects reduced-motion preferences.

Events are actual tool operations. Search hits are not represented as reads. Saves stay queued until the bridge
confirms the file. The display cannot see agents that read files directly, private reasoning, or Alfred's
separate in-app tool loop. Sessions without usable identity are labeled **Unidentified MCP client**.

## Validation

The browser harness used sample notes against an isolated local Worker and D1 database. It exercised real MCP
calls, authenticated WebSocket delivery, independent task identities, handoff queueing, the actual Python bridge,
and the resulting file-saved event. No sample activity is included in the plugin package.
