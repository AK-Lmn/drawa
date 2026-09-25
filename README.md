# Claude UI

A browser front end for Claude Code, laid out as a canvas: each session is a card, every file Claude reads or edits becomes a node wired to it (colored by action), and commands collect in a terminal node. Click a file node for its diffs from every session and the file itself (with markdown and Mermaid preview). Sessions stream in parallel, resume from history, and the whole layout survives a reload.

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

- `server.py`: stdlib HTTP server. Serves `web/dist`, the file/session API, and `/ask`, which streams `claude -p` output.
- `web/src/`, by feature:
  - `main.ts`: boot, toolbar, shortcuts.
  - `lib/`: `api.ts` (server calls), `store.ts` (saved layout: each feature `persist()`s its own slice), `dom.ts`, `markdown.ts`, `select.ts` (custom dropdowns), `fonts.ts`.
  - `canvas/`: `canvas.ts` (pan/zoom, items, dragging, minimap), `window.ts` (the shared folder-tab window: drag, collapse, resize), `graph.ts` (edges, each session's Files window and terminal, files pinned from the tree), `ink.ts` (draw mode), `refs.ts` (what can be @-referenced: each kind registers with `referable()`).
  - `session/`: `session.ts` (cards), `composer.ts` (message box, / and @ menu, reference chips), `stream.ts` (rendering Claude's output), `asks.ts` (permission prompts, questions), `live.ts` (send, stream connection), `history.ts`.
  - `items/`: `notes.ts`, `sketch.ts` (Excalidraw), `diagram.ts` (Mermaid + zoom), `plan.ts` (plan review).
  - `panels/`: `files.ts` (tree, inspector), `diff.ts`.
  - `styles/`: `index.css` imports `tokens.css` (colors, radius and z scales) then one file per area.
- A new kind of canvas item is one file in `items/`: build it with `makeWindow()` (or `addItem()` for a bare node), then call `persist()` to save it and `referable()` if messages can reference it.

Each card is a live Claude process on the server: you can type any time (messages queue while Claude or its agents work), `/` opens skills and slash commands, the toolbar picks the model and permission mode, and sub-agent activity streams inside its Agent row. Diagrams can be dragged out of a reply onto the canvas; **Draw** inks over everything, **Sketch** opens an Excalidraw window.

Shortcuts: `N` new session, `D` draw, `S` sketch, `F` fit, `H` history & files, `0` zoom 100%, `Esc` close panels / stop drawing. Drag the background to pan; Ctrl/Cmd+scroll or pinch to zoom.
- `PRODUCT.md`: design direction.
The server accepts requests only from its own page (and the Vite dev server) on localhost, and file access is limited to the project folder.
