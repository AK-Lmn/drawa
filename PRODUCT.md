# Product

## Register

product

## Users
A single developer driving Claude Code from a browser tab on their own machine, usually beside an editor and terminal. They run several Claude sessions at once, watch what Claude changes in their files, and come back to earlier sessions.

## Product Purpose
A local web front end for the Claude Code CLI: streaming chat per session, live diffs of every edit, a file tree and viewer for the working folder, and resumable session history. Success means the user trusts what Claude did at a glance and never needs the terminal to follow along.

## Brand Personality
Spatial, alive, exact. The workspace is a canvas where you watch Claude's work spread across the codebase: sessions are cards, files are nodes, actions are edges. It should feel like an instrument you fly, not a form you fill in. "Calm and generic" was tried and rejected as lacking creativity.

## Anti-references
- claude.ai: no beige/terracotta palette, no bubble-chat look.
- VS Code: no gray IDE chrome, activity bars or blue status bar.
- Generic SaaS dashboards: no rounded card grids, pastel gradients or template feel.
- Hacker cliché: no green-on-black terminal, no neon.

## Design Principles
- The work is the map: what Claude read, edited and ran is drawn as a graph, not buried in a transcript.
- Content over chrome: Claude's words, diffs and code get the space and the contrast; controls stay quiet until needed.
- Show what changed: edits, tool calls and costs are visible and inspectable, never hidden behind prose.
- Calm under load: several streaming sessions at once must stay legible, with state (running, failed, blocked) readable at a glance.
- Keyboard-close: common actions are one key or one click away.

## Accessibility & Inclusion
WCAG 2.2 AA contrast in both light and dark themes, visible focus rings, reduced-motion alternatives for every animation, and state carried by text or shape as well as color.
