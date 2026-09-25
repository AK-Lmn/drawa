# Claude UI

A browser front end for Claude Code, laid out as a canvas: each session is a card, the files Claude reads or edits are listed in a Files window wired to it (colored by action), and the commands it runs collect in a commands window. Click a file for its diffs from every session and the file itself (with markdown and Mermaid preview). Sessions stream in parallel, resume from history, and the whole layout survives a reload.

## Use

```sh
cd web && npm install && npm run build   # once, and after UI changes
CLAUDE_CONFIG_DIR=$HOME/.claude-work python3 ~/personalproj/claude-ui/server.py [project-folder]
```

Open http://127.0.0.1:8765. Claude works in `project-folder` (default: the current folder). The server restarts itself when `server.py` changes.

## Develop the UI

```sh
cd web && CLAUDE_UI_ROOT=/path/to/project npm run dev
```

Open http://localhost:5173 for hot reload. This also starts `server.py` (skipped if it is already running on port 8765). `npm run check` type-checks.

## Layout

- `server.py`: stdlib HTTP server (`test_server.py`: its checks for GitHub check merging and the canvas MCP endpoint). Serves `web/dist`, the file/session API, and `/ask`, which streams `claude -p` output.
- `web/src/`, by feature:
  - `main.ts`: boot, toolbar, shortcuts.
  - `lib/`: `api.ts` (server calls), `store.ts` (saved layout: each feature `persist()`s its own slice), `dom.ts`, `markdown.ts`, `select.ts` (custom dropdowns), `fonts.ts`, `blobs.ts` (IndexedDB for binary data such as canvas images).
  - `canvas/`: `canvas.ts` (pan/zoom, items, dragging, minimap), `window.ts` (the shared folder-tab window: drag, collapse, resize), `graph.ts` (edges, each session's Files and commands windows, files pinned from the tree), `ink.ts` (draw mode), `refs.ts` (what can be @-referenced: each kind registers with `referable()`), `tools.ts` (Claude's canvas tools: list, read, create, update and link items, served over MCP by `server.py`), `links.ts` (arrows you or Claude draw between items), `snapshot.ts` (a picture of a window with its ink, for Claude), `find.ts` (Ctrl+K window search), `dock.ts` (pin to the sidebar, or stick to the screen), `fullview.ts` (a window filling the screen), `select.ts` (selecting several items: drag on empty canvas in Select mode, or double-tap and drag / Shift+drag in either mode, Shift/Ctrl+click a tab; drag them together, arrow keys nudge, Delete removes them), `mode.ts` (Select and Hand modes; Space held is a temporary hand).
  - `session/`: `session.ts` (cards), `composer.ts` (message box, / and @ menu, reference chips), `stream.ts` (rendering Claude's output), `asks.ts` (permission prompts, questions), `live.ts` (send, stream connection), `history.ts`.
  - `items/`: `notes.ts`, `sketch.ts` (Whiteboard: an Excalidraw window; its kind is still `sketch` in saved layouts), `diagram.ts` (Mermaid + zoom), `plan.ts` (plan review), `snippet.ts` (plus `pinmarks.ts`: pinned text stays highlighted where it came from; click it to jump to the snippet), `git.ts`, `image.ts` (pictures: paste or drop them on the canvas, or Claude puts a screenshot there), `github.ts` (pull requests and issues through the `gh` CLI; Shift+G) with `gh.ts` (their data, and sending a PR, its failing checks, its reviews or an issue to Claude).
  - `panels/`: `files.ts` (tree, inspector), `diff.ts`.
  - `styles/`: `index.css` imports `tokens.css` (colors, radius and z scales) then one file per area.
- A new kind of canvas item is one file in `items/`: build it with `makeWindow()` (or `addItem()` for a bare node), then call `persist()` to save it and `referable()` if messages can reference it.

Each card is a live Claude process on the server: you can type any time (messages queue while Claude or its agents work), `/` opens skills and slash commands, the toolbar picks the model and permission mode, and sub-agent activity streams inside its Agent row. Diagrams can be dragged out of a reply onto the canvas; **Draw** inks and writes text over anything (pen, text, arrows between items, eraser), **Whiteboard** opens an Excalidraw window.

Shortcuts (Excalidraw's, where we have the tool; not while typing):
- Canvas: `V` or `1` select, `H` hand (or hold `Space` to pan), `Shift+1` fit all, `Shift+2` zoom to the selection, `Shift+0` zoom 100%, `F` fit.
- Draw: `D` toggles Draw mode; `P`/`7` pen, `A`/`5` arrow between items, `E`/`0` eraser, `T`/`8` text (outside Draw mode `T` makes a note), `Ctrl+Z` undo a stroke, `Esc` stop.
- Selection: `Ctrl/Cmd+A` select all, arrow keys nudge (`Shift`: 10px), `Delete` removes, `Esc` clears.
- Items: `N` new session, `S` whiteboard, `9` insert a picture, `G` Git, `Shift+G` GitHub, `Shift+H` history & files, `Ctrl+K` find a window.

Drag the background to select (Select mode) or pan (Hand mode); the middle button and the wheel always pan; Ctrl/Cmd+scroll or pinch zooms. Phones start in Hand mode.
- `PRODUCT.md`: design direction.
The server accepts requests only from its own page (and the Vite dev server) on localhost, and file access is limited to the project folder.
