// How the canvas knows session cards: saved with the layout (open cards by transcript id, which one had focus, the
// arrows to items their agent made or edited), removable as part of a selection, and referable (dropped on another
// card's message box, a conversation goes along as context). Imported by session.ts for these registrations.
import { byIds, type Rect, savedRect } from '../../canvas/core/items';
import { fit } from '../../canvas/core/placement';
import { referable } from '../../canvas/core/refs';
import { removable } from '../../canvas/core/select';
import { itemLinks, link } from '../../canvas/graph/graph';
import { who } from '../../lib/agents';
import { api } from '../../lib/api';
import { each, persist } from '../../lib/store';
import { hasDraft } from '../composer/drafts';
import { reportOf } from '../stream/notices';
import { setEffort, setModel } from './gen';
import { loadSessions, resume, sessionPath } from './history';
import { attach } from './live';
import { setMode } from './mode';
import { renderCard } from './render';
import { cards, closeSession, cur, focus, newSession } from './session';

/* ---------- saved with the canvas: open cards (by transcript id) and which one had focus ---------- */
// A card still waiting for its first reply has no transcript id yet: it's saved by its process (cid) alone and, after a
// reload, rebuilt from the process's output from the start (live.ts reads from line 0 when n is 0). So is a new card
// with a draft in its box (drafts.ts): it has no process, and reads as such.
type SavedCard = Rect & {
  id?: string;
  title: string;
  cid?: string;
  mode?: string;
  model?: string;
  effort?: string;
  backend?: string;
}; // no backend: claude
persist(
  'cards',
  () =>
    cards
      .filter(S => S.sid || S.pending || hasDraft(S))
      .map(
        (S): SavedCard => ({
          id: S.sid ?? undefined,
          title: S.title,
          cid: S.cid,
          mode: S.mode,
          model: S.model,
          effort: S.effort,
          backend: S.backend === 'claude' ? undefined : S.backend,
          ...savedRect(S.card),
        }),
      ),
  async (list: SavedCard[], all) => {
    // every transcript is fetched at once; they're replayed in order as they arrive
    if (!Array.isArray(list)) throw new Error('not a list');
    const got = new Map(
      list
        .filter(c => c?.id)
        .map(c => {
          const p = api(sessionPath(c.id!, c.backend));
          p.catch(() => {}); // handled when its card is replayed
          return [c.id!, p] as const;
        }),
    );
    let bad: unknown; // one bad entry doesn't stop the rest; rethrown at the end so the slice is kept as saved
    for (const c of list)
      try {
        if (!c.id) {
          if (!c.cid) continue;
          const S = newSession({ rect: c, cid: c.cid, backend: c.backend ?? 'claude' });
          S.title = c.title;
          S.n = 0;
          setMode(S, c.mode ?? 'default', false);
          // layouts saved before model/effort were per card carry one global model choice (all.model); effort is new, no legacy key
          setModel(S, c.model ?? all.model ?? '');
          setEffort(S, c.effort ?? '');
          renderCard(S);
          continue;
        }
        const p = got.get(c.id);
        got.delete(c.id); // replayed cards let go of their transcript: a long restore doesn't hold every one till the end
        await resume({ ...c, id: c.id, backend: c.backend ?? 'claude' }, c, { got: p, quiet: true });
        // layouts saved before modes were per card carry one global mode (all.mode)
        const S = cards.find(s => s.sid === c.id);
        if (S) {
          setMode(S, c.mode ?? all.mode ?? 'default', false);
          setModel(S, c.model ?? all.model ?? '');
          setEffort(S, c.effort ?? '');
        }
      } catch (e) {
        bad ??= e;
      }
    attach(); // pick up sessions still running on the server (in-flight replies, background agents)
    loadSessions();
    const f = cards.find(S => S.sid === all.focus);
    if (f) focus(f);
    if (!all.view) fit(false);
    if (bad) throw bad;
  },
);
persist('focus', () => cur?.sid ?? undefined);
// a deleted selection closes cards without the × button's own confirm (its delete confirm covers them), and says what that means
removable(
  'session',
  el => {
    const S = cards.find(s => s.card === el);
    if (S) closeSession(S);
  },
  'Sessions are closed, stopping any that are working; their conversations stay in History.',
);

const STATUS: Record<string, string> = { asking: 'Needs you', busy: 'Working', done: 'Done' };
// drop a card on another card's message box: that conversation goes along as context (its recent part, as text)
referable('session', {
  icon: '◆',
  label: el => cards.find(s => s.card === el)?.title ?? 'session',
  status: el => STATUS[el.dataset.state ?? ''],
  content: (el, label) => {
    const S = cards.find(s => s.card === el);
    const lines = [...(S?.log.children ?? [])].flatMap(r => {
      if (r.matches('.me')) return [`User: ${r.textContent?.trim()}`];
      if (r.matches('.md')) return [`${who(S!.backend)}: ${r.textContent?.trim()}`];
      if (r.matches('.handoff')) return [`(${r.querySelector('summary b')?.textContent}:)\n${reportOf(r) ?? ''}`];
      if (r.matches('details.tool'))
        return [
          `(${who(S!.backend)} used ${r.querySelector('summary b')?.textContent ?? 'a tool'} ${r.querySelector('summary .arg')?.textContent ?? ''})`.replace(
            / \)$/,
            ')',
          ),
        ];
      return [];
    });
    let text = lines.join('\n\n');
    if (text.length > 30_000) text = `…(earlier part left out)\n\n${text.slice(-30_000)}`; // ponytail: the recent end is what matters most
    return {
      text: `Another ${S ? who(S.backend) : 'agent'} session on my canvas, "${label}"${S?.sid ? ` (session ${S.sid})` : ''}:\n\n${text || '(nothing yet)'}`,
    };
  },
});
// arrows to canvas items a card's Claude made or edited: after the cards and the items are back
// ones whose card or item isn't there on this load are kept and written back (tried again next load), not erased
type ItemLink = { cid: string; id: string; acts: ('made' | 'edit')[] };
let unplaced: ItemLink[] = [];
persist(
  'itemLinks',
  () => [...itemLinks(), ...unplaced],
  (list: ItemLink[]) => {
    const ids = byIds();
    unplaced = [];
    each(list, l => {
      const S = cards.find(s => s.cid === l.cid),
        el = ids.get(l.id);
      if (S && el) l.acts.forEach(a => link(S, el, a));
      else unplaced.push(l);
    });
  },
  2,
);
