# Guidelines for agents working on claude-ui

claude-ui is a browser canvas around the Claude Code CLI. `server.py` runs `claude` processes and serves a JSON API. `web/` is a Vite + TypeScript frontend with no framework: plain DOM modules. Read `README.md` for how to run it, and `PRODUCT.md` for the design brief. This file covers how to change the code without making it harder to change next time.

## Before you finish any change

1. `cd web && npm run build`. This runs `tsc` and the Vite build. Both must pass with no new errors.
2. Look at what you changed. For anything visible, take a screenshot in headless Chromium in **both** light and dark themes (`Emulation.setEmulatedMedia` with `prefers-color-scheme`). You can import modules straight from the dev server to set up state, e.g. `await import('/src/items/diagram.ts')`.
3. Reload the page and check that your change survives restore from the saved layout.
4. Say plainly what you verified and what you didn't.

## Architecture: where things go

```
web/src/
  main.ts      boot, toolbar, keyboard shortcuts; imports features (importing a feature registers it)
  lib/         no knowledge of the app: api, store (persistence), dom helpers, markdown, select, fonts
  canvas/      the canvas engine: view, items, window shape, graph edges, ink, references registry
  session/     session cards: card, composer, stream rendering, asks, live connection, history
  items/       one file per kind of canvas item: notes, sketch, diagram, plan
  panels/      side panels: file tree + inspector, diffs
  styles/      index.css imports tokens.css, then one stylesheet per area
```

The dependency direction is `lib` ← `canvas` ← `items` / `session` / `panels` ← `main`.
- `lib/` never imports from other folders.
- `canvas/` never imports from `items/`. It only imports *types* from `session/` and `panels/`.
- If you need to import upward, add a registry or callback in the lower layer instead (see `onDrop`, `persist`, `referable`).

Import cycles between feature modules are tolerated only when every cross-use happens inside functions, never at module top level. Don't add top-level code that reads another module's exports.

## The registries: extend by adding, not by editing

The app scales through three registration points. A new feature should plug into them rather than add special cases elsewhere.

| Need | Use | Where |
|---|---|---|
| Something on the canvas | `addItem(el, kind)` for bare nodes, or `makeWindow({...})` for windows | `canvas/canvas.ts`, `canvas/window.ts` |
| Survive a reload | `persist(key, save, load, phase)` | `lib/store.ts` |
| Referenceable with `@` or by dropping on a card | `referable(kind, { icon, label, content })` | `canvas/refs.ts` |
| Recover after the server comes back | `onReconnect(fn)` | `lib/connection.ts` |

**Adding a new kind of canvas item** should mean one new file in `items/`, an import in `main.ts`, and CSS in `styles/items.css`. The item file should:
- Build the element with `makeWindow()`, which handles the folder tab, dragging, collapsing and resizing.
- Call `persist()` for its saved state.
- Call `referable()` if Claude should be able to receive it.
- Add a `--k-<kind>` color in `tokens.css`, plus minimap and tab-glyph rules.

If you find yourself adding the new kind to a list in `canvas.ts`, the minimap, `main.ts` restore code or a CSS `:not(...)` selector, stop: that list should be a registry or a `data-kind` rule.

Rules for these registries:
- **Persistence keys are a public format.** Existing users have saved layouts in localStorage (`claude-ui:canvas:<root>`). Never rename or reshape a key without a loader that still reads the old shape.
- **Restore phases:** 0 is settings and positions, 1 is items, 2 is things that attach to items (ink). A loader may be async; the next one waits for it.
- **Item state goes in `data-state`,** not in ad-hoc classes (`busy`, `edit`, `approved`...). The minimap and CSS both key off `data-kind` + `data-state`.

## Code conventions

- **Match the surrounding code:** short functions, early returns, `make()` / `iconButton()` / `button()` from `lib/dom.ts` rather than hand-built buttons, and `confirmBox()` rather than `confirm()`. No native browser dialogs or `alert`.
- **Keep modules small.** When a file passes about 350 lines or does two jobs, split it by responsibility the way `session/` is split: card, composer, stream, asks and live are separate modules.
- **No new dependency** for what a few lines or the platform can do. Big libraries (Mermaid, Excalidraw, html-to-image) are loaded with dynamic `import()` on first use. Keep it that way.
- **Comments say why,** not what. A deliberate shortcut gets a `ponytail:` comment naming its limit and the upgrade path.
- **Loose typing only where the CLI owns the schema.** Claude's stream-json messages are `Record<string, any>`. Type everything else.
- **Don't touch the private stuff:** no hard-coded paths, and no secrets or user data in the repo.

## Styling rules

- **Themes and color schemes:**
  - `lib/theme.ts` puts light/dark on `<html data-theme>` and the chosen scheme on `data-scheme`. The inline script in `index.html` does the same before first paint, so keep its defaults in sync.
  - A scheme is 13 base colors (`--c-*`) in `styles/schemes.css`. `tokens.css` derives every UI color from them.
  - To add a scheme: one block in `schemes.css` plus one line in `SCHEMES` in `theme.ts`. Keep `--c-muted` at 4.5:1 or better against `--c-bg`.
  - Feature CSS uses only the derived tokens, never `--c-*` and never a `prefers-color-scheme` query.
  - Anything drawn with colors baked in (Mermaid, Excalidraw previews) reads `isDark()` and redraws in `onTheme()`.
- **All values come from `styles/tokens.css`:**
  - Colors: derived from the active scheme, including the code highlighting colors (`--syn-*`).
  - Radius scale: `--r-tab`, `--r-box`, `--r-ctl`.
  - z scale: `--z-float`, `--z-panel`, `--z-menu`.
  - Kind colors: `--k-*`.
  - Don't write raw colors, radii or z-index numbers in feature CSS.
- **Shape language:**
  - Windows are folders. A tab on the top-left carries the title and buttons, and a concave shoulder joins it to a nearly square body.
  - Surfaces are square-cut (`--r-box`). The tab curve is the only prominent round corner.
  - Don't bring back 8–14px rounded cards, rounded boxes nested in rounded boxes, or pills. The user has rejected these repeatedly.
- **Window states change `--edge` and `--glow` only;** `window.css` draws the outline from them. Don't restyle `.win-h` or `.win-b` per feature beyond what's in the kind's own section.
- **Color carries meaning:** read, edit, write and run are the action colors, and everything else is neutral. Mix tints with `color-mix(in oklab, …)`; oklch mixing shifts hues.
- **Input fields must look like input fields:** a visible border, a text cursor, and a clear focus state.
- **No native-looking controls:** `<select>` goes through `enhance()` from `lib/select.ts`.
- **Every animation has a `prefers-reduced-motion` fallback.** It lives at the end of `index.css`.
- **Layouts must work from phone width up.** Check at 390px.

## Performance rules

These are measured, not guessed. Reopening a 27MB transcript went from 7.6s to 0.5s, and streaming went from about 30fps to 60fps, by following them. Re-measure with a real large transcript after touching these paths.

- **Never read layout inside a loop** (`scrollHeight`, `offsetWidth`, `getBoundingClientRect`, `getComputedStyle` for sizes). Bulk work such as replaying a transcript sets `S.replaying`: `put()`, `follow()` and `renderCard()` skip their layout reads, and one final pass settles everything. `quietPings(true)` does the same for attention flashes.
- **Streaming renders incrementally.** Complete markdown blocks are rendered once; only the unfinished tail re-renders each frame (`streamText` in `session/stream.ts`). Don't go back to re-rendering the whole buffer.
- **Animations must not force layout.** Use the Web Animations API (`el.animate`), as `ping()` does, not the remove-class/`offsetWidth`/add-class trick.
- **No decorative glows or big blurred shadows** on canvas windows. They cost paint on every pan and zoom frame, and the user rejected them visually too. Show state with `--edge` and the tab's top line.
- **Long lists skip what's off-screen:** log entries use `content-visibility: auto`. Keep new per-entry elements as direct children of `.log`.
- **The server sends only what the page shows.** `clip()` in `server.py` drops images returned by tools and thinking signatures, and trims tool outputs to 20k characters. New transcript fields should be trimmed the same way.
- **Big libraries load on first use** (Mermaid, Excalidraw, html-to-image) with a dynamic `import()`.

## Server (`server.py`)

- Stdlib only (`ThreadingHTTPServer`). Keep it dependency-free.
- **Security checks are not optional:**
  - Every request checks `Host`.
  - POSTs require a matching `Origin`.
  - Every file path goes through `inside()` so it can't escape the project root.
  - Any new endpoint needs the same checks.
- One long-lived `claude -p` process per card, speaking the stream-json protocol. The page reads output from `/api/events` and answers control requests via `/api/respond`. Don't break re-attaching: a reload must pick up a running session where it left off.
- The server restarts itself when server.py changes. Test changes against a separate port rather than killing the user's running instance.

## When a request is vague

- Prefer the smallest change that fits these rules. When a request needs a new abstraction, add it as a registry in the lower layer, and move the existing cases onto it in the same change, so the codebase never has two ways of doing one thing.
- Update `README.md`'s layout section and this file whenever you add a folder, a registry, or a rule.
