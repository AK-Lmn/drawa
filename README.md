# Drawa

A browser front end for Claude Code, laid out as a canvas: each session is a card, the files Claude reads or edits are listed in a Files window wired to it (colored by action), and the commands it runs collect in a commands window. Click a file for its diffs from every session and the file itself (with markdown and Mermaid preview). Sessions stream in parallel, resume from history, and the whole layout survives a reload.

## Install

Needs [Claude Code](https://claude.com/claude-code) (`claude`) on `PATH` — `drawa` refuses to start without it. `git` and `gh` (the [GitHub CLI](https://cli.github.com)) are optional: without them the Git and GitHub windows don't work, but everything else does.

**Quick install (macOS, Linux):**

```sh
curl -fsSL https://raw.githubusercontent.com/probablysamir/claude-ui/main/install.sh | sh
```

Fetches the right [release binary](https://github.com/probablysamir/claude-ui/releases/latest) (no Go or Node needed) for your OS/architecture and puts it on `PATH`. See [INSTALL.md](INSTALL.md) for manual per-platform steps, updating, uninstalling, and troubleshooting (there's no Windows build — `internal/procx/procx.go` kills a subprocess's whole process group with POSIX-only syscalls).

**Or build from source:**

```sh
cd web && npm install && npm run build   # once, and after UI changes
go build -o drawa .
```

Or run straight off the source tree without a persistent binary: `go run . [project-folder]`. This is also the only way to get the self-rebuild-on-change behavior described below — a downloaded release binary skips it (its UI is embedded, and it has no source tree to rebuild from).

## Use

```sh
drawa                  # opens the current folder, like `code .`
drawa .                # the same, spelled out
drawa ~/some/project   # or any other folder
```

Opens http://127.0.0.1:8765 in your browser. Claude works in whichever folder you passed (or the current one). Two env vars:

- `DRAWA_PORT` — use a different port (default `8765`), e.g. to run two projects at once.
- `CLAUDE_CONFIG_DIR` — point at a different Claude Code config/credentials/sessions directory than the default `~/.claude`, e.g. to keep a separate login or set of installed skills for this tool: `CLAUDE_CONFIG_DIR=$HOME/.claude-work drawa .`

When run from source (`go run .` or a binary you built yourself, not a downloaded release), the server also rebuilds and restarts itself whenever a `.go` file changes (needs the Go toolchain on `PATH`; a build that fails to compile keeps the old server running).

## Develop the UI

```sh
cd web && DRAWA_ROOT=/path/to/project npm run dev
```

Open http://localhost:5173 for hot reload. This also starts the Go server via `go run` (skipped if one is already running on port 8765). `npm run check` type-checks.

## Layout

- `main.go`: the entry point (arg parsing, the self-restart loop, `main()`). `internal/`, one file per responsibility (`go test ./...` covers GitHub check merging, session/transcript loading, the canvas MCP endpoint and the multiplexed event stream): `config.go` (paths, constants, `Inside()`), `procx.go` (running `git`/`gh`/`claude` subprocesses), `gitx.go`, `github.go` + `detail.go` + `ops.go` (state/lists, single PR/issue reads, write operations), `filesx.go` (the file tree and `@` search), `images.go`, `sessions.go` (transcript loading, `Clip`/`Trimmed`), `canvastools.go` (the `Tools` schema Claude sees), `live.go` + `meta.go` (the `Live` type: one long-running `claude` process per card), `webassets/` (the built UI embedded for standalone release binaries, empty in a normal checkout), and `server/` (`handler.go` routing, `events.go` the `/api/events` stream, `mcp.go` the canvas MCP server, `shell.go` the `!` shell command, `cardops.go` send/respond/mode/canvas/interrupt/close). Serves `web/dist` (falling back to `webassets` when it's absent) and the file/session/git/GitHub API.
- `web/src/`, by feature:
  - `main.ts`: boot, toolbar, shortcuts.
  - `lib/`: `api.ts` (server calls), `store.ts` (saved layout: each feature `persist()`s its own slice), `dom.ts`, `markdown.ts`, `select.ts` (custom dropdowns), `fonts.ts`, `blobs.ts` (IndexedDB for binary data such as canvas images).
  - `canvas/`: `canvas.ts` (pan/zoom, items, dragging, minimap), `window.ts` (the shared folder-tab window: drag, collapse, resize), `graph.ts` (edges, each session's Files and commands windows, files pinned from the tree), `ink.ts` (draw mode), `shapes.ts` (rectangle, ellipse, diamond and line; moving and resizing drawn shapes and text), `refs.ts` (what can be @-referenced: each kind registers with `referable()`), `tools.ts` (Claude's canvas tools: list, read, create, update and link items, served over MCP by the Go server), `links.ts` (arrows you or Claude draw between items), `snapshot.ts` (a picture of a window with its ink, for Claude), `find.ts` (Ctrl+K window search), `dock.ts` (pin to the sidebar, or stick to the screen), `fullview.ts` (a window filling the screen), `select.ts` (selecting several items: drag on empty canvas in Select mode, or double-tap and drag / Shift+drag in either mode, Shift/Ctrl+click a tab; drag them together, arrow keys nudge, Delete removes them), `mode.ts` (Select and Hand modes; Space held is a temporary hand).
  - `session/`: `session.ts` (cards), `composer.ts` (message box, / and @ menu, reference chips), `stream.ts` (rendering Claude's output), `asks.ts` (permission prompts, questions), `live.ts` (send, stream connection), `history.ts`.
  - `items/`: `notes.ts`, `doc.ts` (the Scratchpad: a Markdown window rendered with code blocks, Mermaid and callouts, double-click or the pencil to edit; S or the toolbar, or Claude's canvas_create kind "doc"), `sketch.ts` (Whiteboard: an Excalidraw window; no longer created, existing ones still load), `diagram.ts` (Mermaid + zoom), `plan.ts` (plan review), `snippet.ts` (plus `pinmarks.ts`: pinned text stays highlighted where it came from; click it to jump to the snippet), `git.ts`, `image.ts` (pictures: paste or drop them on the canvas, or Claude puts a screenshot there), `agent.ts` (a window per sub-agent: its work as it happens, a box to message it through its session; it leaves the canvas when the agent finishes, and the card's Agent row reopens it), `github.ts` (pull requests and issues through the `gh` CLI; Shift+G) with `gh.ts` (their data, and sending a PR, its failing checks, its reviews or an issue to Claude).
  - `panels/`: `files.ts` (tree, inspector), `diff.ts`.
  - `styles/`: `index.css` imports `tokens.css` (colors, radius and z scales) then one file per area.
- A new kind of canvas item is one file in `items/`: build it with `makeWindow()` (or `addItem()` for a bare node), then call `persist()` to save it and `referable()` if messages can reference it.

Each card is a live Claude process on the server: you can type any time (messages queue while Claude or its agents work), `/` opens skills and slash commands, the toolbar picks the model and permission mode, and sub-agent activity streams inside its Agent row. Diagrams can be dragged out of a reply onto the canvas; **Draw** inks and writes text over anything (pen, text, arrows between items, eraser), **Scratchpad** opens a Markdown window with code, Mermaid diagrams and callouts.

Shortcuts (Excalidraw's, where we have the tool; not while typing):
- Canvas: `V` or `1` select, `H` hand (or hold `Space` to pan), `Shift+1` fit all, `Shift+2` zoom to the selection, `Shift+0` zoom 100%, `F` fit.
- Draw: `D` toggles Draw mode; `P`/`7` pen, `A`/`5` arrow between items, `E`/`0` eraser, `T`/`8` text (outside Draw mode `T` makes a note), `R`/`2` rectangle, `3` diamond, `O`/`4` ellipse, `L`/`6` line (`Shift`: square, circle, 45°), `Ctrl+Z` undo a stroke, `Esc` stop.
- Drawn objects: in Select mode, click a shape's outline or your text to pick it, drag to move, drag a corner to resize a shape, arrow keys nudge, `Delete` removes, `Esc` lets go.
- Selection: `Ctrl/Cmd+A` select all, arrow keys nudge (`Shift`: 10px), `Delete` removes, `Esc` clears.
- Items: `N` new session, `C` / `Shift+C` next / previous session (`Enter` to type in it), `T` sticky note, `S` scratchpad, `9` insert a picture, `G` Git, `Shift+G` GitHub, `Shift+H` history & files, `Ctrl+K` find a window.

Drag the background to select (Select mode) or pan (Hand mode); the middle button and the wheel always pan; Ctrl/Cmd+scroll or pinch zooms. Phones start in Hand mode.
- `PRODUCT.md`: design direction.
The server accepts requests only from its own page (and the Vite dev server) on localhost, and file access is limited to the project folder.
