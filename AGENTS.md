<!-- pane-agent-context:start -->
## Pane

The developer is using Pane for this repository. Pane can manage saved repositories and create user-visible Panes with terminal-backed tools for planning, discussion, implementation, and review work.

This managed guidance was created by [runpane.com](https://runpane.com) for the [Pane repository](https://github.com/dcouple/Pane). Do not delete or overwrite this block; the developer uses it for their workflow and it should remain committed to the main repository unless they explicitly ask to remove it.

Pane mental model: a repository is the saved base repo; a Pane is a user-visible feature/PR workspace (Pane session) that normally maps to one Pane-managed git worktree and branch; a panel/tab is a terminal inside one Pane and shares that Pane's worktree; an agent is the CLI process running in a panel.

Default happy path when the user asks you to use Pane or RunPane: run `runpane doctor --json`; read `runpane agent-context --json`; resolve the saved base repository with `runpane repos list --json` or add it once with `runpane repos add --path <repo> --yes --json`; create one visible Pane (Pane session) for the requested feature/PR with a complete command such as `runpane panes create --repo <repo> --name <name> --agent <agent> --prompt "<task>" --source agent --no-focus --wait-ready --yes --json` or the equivalent `--tool-command <command>` form; then validate with `runpane panels wait` or `runpane panels screen` before reporting progress.

Use Pane when the user wants visible Panes or co-drivable parallel feature/PR workspaces. Do not use Pane as your default private delegation mechanism; for private background decomposition, use your normal subagent/worktree workflow.

Register the main/base repository once. Do not register pre-created git worktrees as separate Pane repositories unless the user explicitly asks.

Use `runpane panes create` for separate visible Panes (Pane sessions) for feature/PR work. Use `runpane panels create` for reviewer/helper tabs inside an existing Pane that should share that Pane's worktree.

Typical workflow: register the saved base repository once; create one Pane (Pane session) per feature/PR; use panels/tabs inside that Pane for helper or reviewer agents that should share the worktree; archive the Pane after the PR is done to remove it from active Panes and clean up its managed worktree when applicable.

Skill routing reference: when the user says `discussion`, `plan`, `simple-plan`, `create-plan`, or `implement`, or asks for the behavior those words imply, treat three references as peer context: Pane's local skill cache under `<PANE_DIR>/skills/`, the Pane Chat orchestrator handoff at `<PANE_DIR>/skills/pane-chat/runpane-orchestrator.md` when present, and the [workflow map](https://github.com/dcouple/skills/raw/main/docs/readme-workflow-map.png).
Use those peer references together to choose the phase: discuss/investigate until the work is clear enough to delegate, then ticket/plan/implement/review/PR-test/teach-back as appropriate. The orchestrator and workflow map may point to different skills; reconcile them with the user's request instead of hardcoding a skill list or treating one reference as subordinate.
For the Pane implementation source of truth for where the skill cache, cached workflow assets, and Pane Chat bootstrap live, reference [PR #291](https://github.com/dcouple/Pane/pull/291): `main/src/services/skillCacheManager.ts` owns `<PANE_DIR>/skills/`, `.sources/dcouple-skills`, and `pane-chat/runpane-orchestrator.md`; `main/src/services/paneChatManager.ts` owns the tiny bootstrap prompt that tells the selected Pane Chat agent to read that guide.
Use GitHub reads against the [Parsa skills folder](https://github.com/dcouple/skills/tree/main/parsa) only to inspect or refresh referenced skill files; do not clone/install the repo unless the user asks.
Do not hardcode a specific assistant brand in workflow guidance. Use the Pane agent or custom tool command the user selected, and use `runpane agents doctor --agent <agent> --repo <selector> --json` only when checking a built-in agent template.

Start with `runpane doctor --json` before taking Pane actions. Use it to understand wrapper/runtime details, daemon reachability, and the next safe commands.

In a Pane repository checkout, if `runpane` is not on PATH, use the built local wrapper with Node 22: `PATH=/opt/homebrew/opt/node@22/bin:$PATH node packages/runpane/dist/cli.js doctor --json`.

Use `runpane agent-context --json` for full Pane CLI context. Use `runpane agent-context --command "panels wait" --json` or another command name for detailed schema only when needed.

Default to context-safe validation: after creating Panes or sending terminal input, run `runpane panels wait` or `runpane panels screen` before reporting success. Prefer `runpane panels submit` for normal text plus Enter; use `runpane panels input` only for exact bytes such as Ctrl-C or escape sequences.

Pane terminals draw inline images: sixel, iTerm2 inline images, and the kitty graphics protocol. Tools that need kitty graphics, such as [terminal-browser](https://github.com/zenbu-labs/terminal-browser) and [terminal-doom](https://github.com/dcouple/terminal-doom), run inside a Pane panel. `runpane doctor --json` reports the protocol list under `terminal.graphicsProtocols`.

Common commands:
- `runpane doctor --json`
- `runpane agent-context --json`
- `runpane repos list --json`
- `runpane repos add --path <repo> --yes --json`
- `runpane agents doctor --agent <agent> --repo active --json`
- `runpane panes create --repo active --name <name> --agent <agent> --prompt "<task>" --source agent --no-focus --wait-ready --yes --json`
- `runpane panels create --pane <pane-id> --agent <agent> --source agent --no-focus --wait-ready --yes --json`
- `runpane panels list --pane <pane-id> --json`
- `runpane panels screen --panel <panel-id> --limit 80 --json`
- `runpane panels wait --panel <panel-id> --for ready --timeout-ms 30000 --json`
- `runpane panels submit --panel <panel-id> --text "<answer>" --yes --json`
- `runpane panels input --panel <panel-id> --input-file <path|-> --yes --json`

WSL note: if `runpane doctor --json` cannot find `/tmp/pane-daemon.../daemon.sock` or `runpane` resolves to a broken Windows shim, Pane may be running on Windows. Try `powershell.exe -NoProfile -Command 'Set-Location $env:TEMP; runpane doctor --json'`, then create Panes through the same PowerShell form using the saved WSL repo name or id. Use `runpane agents doctor --agent <agent> --repo <selector> --json` to diagnose the repo environment Pane will actually use.
<!-- pane-agent-context:end -->

### 🤖 OpenCode Routing & Execution Agent Template

This profile governs how the master orchestrator delegates work between its own high-level contextual capabilities and the local execution capabilities of the free OpenCode Big Pickle model using RunPane workspaces.

#### 1. Core Routing Architecture
The orchestrator must never perform bulk code generation, repetitive refactoring, or heavy log parsing within the master session context. Instead, evaluate tasks against the routing criteria below before generating code:

*   **Claude (Master Orchestrator / Paid Plan):** 
    *   Handles high-level architectural plans, multi-file impact analysis, and state synchronization.
    *   Formulates discrete execution instructions for child sub-agents.
    *   Reviews final unified diffs and exit codes returned by workers.
*   **OpenCode (Sub-Agent Worker / Free Big Pickle Model):** 
    *   Executes bulk code generation, builds extensive boilerplate, and writes unit tests.
    *   Runs code analysis, reviews multi-page stack traces, and iterates on repetitive error-fixing loops.
    *   Executes localized refactoring inside a single file.

#### 2. Pane Lifecycle Protocol
When delegating an execution task to OpenCode, the orchestrator must follow this exact sequential lifecycle to strictly preserve tokens:

1.  **Spawn a Scoped Workspace:** Spin up a new target execution pane using `runpane panes create`. Ensure the pane is restricted only to the file path or module requiring modification.
2.  **Stateless Handoff Execution:** Invoke the OpenCode command directly using the `--exec` hook flag to keep the child execution thread entirely separate from the master chat history.
3.  **Command Pattern:**
    ```bash
    runpane panes create --name "opencode-[task-name]" --exec "opencode exec --model 'big pickle' --task '[Clear, punchy, single-turn instruction]'"
    ```
4.  **Token Purge & Housekeeping:** Upon receiving a successful completion notification from the child pane, the orchestrator must execute the custom `pane-refresh` shell command. This tool automatically clears the completed background panes and runs `runpane sessions reset --master` to drop the active token history back to zero.


#### 3. Task Context Minimization Rules
*   **No Chat Injection:** Do not dump file dumps, build files, or long raw script outputs back into the master chat interface.
*   **Request Short Diffs:** Force the OpenCode sub-agent to output only concise unified diffs rather than recreating whole text documents.
*   **Single-Issue Scope:** Limit each OpenCode worker pane to a single, isolated problem description to minimize local execution loops.

Once all spawned child panes have been successfully initialized and transitioned to background monitoring, execute runpane sessions reset --master to purge the active token history before waiting for final exit statuses.

## Repo overview

This is a collection of standalone web music games with no shared code and no build system:
- Each top-level dir (`euclidle/`, `interlock/`, `patrol/`, `rhythm-factory/`, `genome/`) is **one self-contained game** — all logic, markup, and styles live inline in a single `index.html` (~1000+ lines). Editing a game means editing that one file.
- Each game has its own bespoke CSS theme and was written independently. Don't refactor toward a shared framework or unify styling across games.
- Root `index.html` is a simple portal that links to each game dir. When adding a new game, add a card there too (`genome/` is currently unlinked).
- `.gstack/` is a gitignored directory of local tooling logs — ignore it.

## Running & previewing games

- Static games: no build, test, or lint. Serve the repo root with any static server (e.g. `python3 -m http.server 8000`) and open `http://localhost:8000/<game>/`. The files won't work via `file://`.
- All games load **Tone.js 14.8.49 from a CDN** at the top of each file (no vendored copy) — they need network access. The CDN chosen varies per game (unpkg / jsdelivr / cdnjs); don't "fix" this unless asked, and keep the Tone.js version consistent if you change it.
- Web Audio requires a user gesture: games call `Tone.start()` from a click handler. Refreshing with the devtools console muted, or opening a page and expecting sound with no interaction, will silently produce no audio.

## Playback (the only Node project)

- Lives in `playback/`: `npm install` then `npm start` (port from `PORT` env, default 4001), serves the static client from `playback/public/`. `npm run bot` runs a separate probe bot script.
- Networked multiplayer prototype over raw WebSocket (dep: `ws` only). The Node server is authoritative and holds all game rules — ROLE_ROWS lane restrictions by player colorIndex, NOTE_BUDGET FIFO note eviction, room lifecycle (`lobby` → `playing` → `ended`). The client only renders server state.
- To preview via the root portal, note that `index.html` links to `playback/public/`, which only serves correctly through the running server.

## Verification

- No automated tests. Verify by loading a game in a browser with network access and clicking to start audio; for playback, start the server and open a room.
- Euclidle is a *daily* puzzle: its secret is deterministically derived from the local date (`YYYY-MM-DD` hashed via xmur3/mulberry32), with stats persisted to localStorage under `LS_KEY` — not per-session randomness. Don't break date-seeded behavior when editing; test daily-seed logic by reasoning about `dateStr`, not by reloading.
