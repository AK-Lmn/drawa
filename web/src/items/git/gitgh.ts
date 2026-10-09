// A repo's GitHub strip in the Git window: the pull request for its branch (through gh), with its review and checks,
// or a form to open one. One per repo: the project's own sits at the top of the window, a nested repo's in its group.

import { who } from '../../lib/agents';
import { api, q } from '../../lib/api';
import { button, confirmBox, iconButton, make } from '../../lib/dom';
import { checksDot, type GhState, ghPost, REVIEW, sendLabel, sendToClaude, stateOf, tallyChecks } from '../github/gh';
import { GH_ICON, openGitHub } from '../github/github';
import { writeWith } from './gitrepo';

export interface Strip {
  el: HTMLElement;
  refresh(): Promise<void>;
  /** The Git window's 15-second tick while the strip is in view: GitHub is asked every minute, every 15s while the
   *  branch's checks are still running (they settle on their own). */
  tick(): void;
  /** Asked at once if it never was: the strip just came into view. */
  wake(): void;
}

/** The strip for repo `dir` ('' the project's own). `pushed` runs after a pull request was created (its push changes
 *  the repo's git status). */
export function ghStrip(dir: string, pushed: () => void): Strip {
  const strip = make('div', 'ghstrip'),
    form = make('form', 'ghform');
  form.hidden = true;
  let last = '',
    st: GhState | undefined,
    ask = 0,
    ticks = 0,
    asked = false;
  /** Does the branch's pull request have checks still running? */
  const pending = () => !!st?.pr?.checks.some(c => c.state === 'pending');
  /** Open the GitHub window at this repo (and at a pull request or tab, when given). */
  const open = (at: Parameters<typeof openGitHub>[0] = {}) => openGitHub({ ...at, repo: dir });

  /** Ask GitHub about the branch's pull request and draw the strip; a slower, older answer doesn't overwrite a newer
   *  one. */
  async function refresh() {
    asked = true;
    if (!strip.childElementCount) strip.replaceChildren(make('p', 'ghnote', 'Checking GitHub…'));
    const mine = ++ask; // a slow answer to an older ask must not replace a newer one
    const got = await api<GhState>(`gh?repo=${q(dir)}`).catch(
      e => ({ ok: false, error: (e as Error).message }) as GhState,
    );
    if (mine !== ask) return;
    const sig = JSON.stringify(got);
    if (sig === last) return;
    last = sig;
    st = got;
    draw(got);
  }

  /** Draw the strip: the branch's pull request with its review and checks state, or a way to open one. */
  function draw(st: GhState) {
    strip.dataset.state = st.ok ? (st.pr ? stateOf(st.pr) : 'none') : 'off';
    if (!st.ok)
      return strip.replaceChildren(make('p', 'ghnote', (st.error ?? '').split('\n')[0] || 'GitHub is not available.'));
    const openBtn = iconButton(GH_ICON, `Pull requests and issues of ${st.repo}`, () => open());
    const pr = st.pr;
    if (!pr) {
      const line = make('div', 'ghline');
      const featureBranch = st.branch && st.branch !== st.default;
      line.append(openBtn, make('span', 'ghti', featureBranch ? `No pull request for ${st.branch}` : st.repo!));
      if (featureBranch)
        line.append(
          button(form.hidden ? 'Create pull request' : 'Cancel', '', () => {
            form.hidden = !form.hidden;
            if (!form.hidden) buildForm(st);
            draw(st);
          }),
        );
      else form.hidden = true;
      // you switched branches with the form open: it now opens a pull request for the new one (Create pushes HEAD)
      const note = form.querySelector('.gout');
      if (note && form.dataset.branch && form.dataset.branch !== st.branch)
        note.textContent = `The branch is now ${st.branch}: this pull request will be for it.`;
      return strip.replaceChildren(line, form);
    }
    form.hidden = true;
    const t = tallyChecks(pr.checks),
      line = make('div', 'ghline'),
      title = make('button', 'ghti');
    title.append(make('span', 'ghn', `#${pr.number}`), ' ', pr.title);
    title.title = `Open pull request #${pr.number}`;
    title.onclick = () => open({ tab: 'pr', n: pr.number });
    const badge = make('span', 'ghstate', stateOf(pr));
    badge.dataset.state = stateOf(pr);
    line.append(openBtn, title, badge);
    const facts = make('div', 'ghline ghsub');
    if (REVIEW[pr.review]) facts.append(make('span', '', REVIEW[pr.review]));
    if (pr.checks.length) {
      const sum = make('button', 'ghsum'); // the list, with logs, is the GitHub window's Checks tab
      sum.title = 'Show the checks';
      sum.append(
        checksDot(t.state),
        [t.pass && `${t.pass} passed`, t.fail && `${t.fail} failed`, t.pending && `${t.pending} running`]
          .filter(Boolean)
          .join(', '),
      );
      sum.onclick = () => open({ tab: 'pr', n: pr.number, sub: 'checks' });
      facts.append(sum);
    }
    facts.append(
      make('span', 'spacer'),
      button(sendLabel(), 'ai', () => sendToClaude('pr', pr.number, pr.title, dir)),
    );
    if (t.fail)
      facts.append(button('Send failing checks', 'ai', () => sendToClaude('checks', pr.number, pr.title, dir)));
    strip.replaceChildren(line, facts);
  }

  /** The Create pull request form: title, description (Claude can draft both), base branch, draft. Kept across
   *  refreshes while it's open, so a background refresh never eats what you typed. */
  function buildForm(at: GhState) {
    form.dataset.branch = at.branch ?? '';
    if (form.childElementCount) return;
    const title = make('input'),
      body = make('textarea'),
      base = make('input'),
      draft = make('input'),
      row = make('div', 'row'),
      out = make('p', 'gout');
    Object.assign(title, { placeholder: 'Title', required: true });
    title.setAttribute('aria-label', 'Pull request title');
    body.rows = 5;
    body.placeholder = 'Description (Markdown)';
    body.setAttribute('aria-label', 'Pull request description');
    base.value = at.default ?? 'main';
    base.setAttribute('aria-label', 'Base branch');
    draft.type = 'checkbox';
    for (const f of [title, body, base]) f.addEventListener('keydown', e => e.stopPropagation());
    const baseLbl = make('label', 'ghbase'),
      draftLbl = make('label', 'ghdraft');
    baseLbl.append('into ', base);
    draftLbl.append(draft, ' Draft');
    const { box: writeBox } = writeWith(
      async (write, agent) => {
        const label = write.textContent;
        write.disabled = true;
        write.textContent = 'Writing…';
        const r = await ghPost({ op: 'draft', repo: dir, base: base.value.trim(), backend: agent });
        write.disabled = false;
        write.textContent = label;
        if (r.title) {
          title.value = r.title;
          body.value = r.body ?? '';
          out.textContent = '';
        } else out.textContent = r.error ?? `${who(agent)} could not write it.`;
      },
      n => `${n} reads the commits and diff against the base branch and drafts a title and description`,
    );
    const create = button('Create pull request', 'primary', () => form.requestSubmit());
    create.type = 'submit';
    row.append(writeBox, baseLbl, draftLbl, create);
    form.append(title, body, row, out);
    form.onsubmit = async e => {
      e.preventDefault();
      const b = base.value.trim(),
        branch = st?.branch ?? 'this branch';
      if (!title.value.trim()) return title.focus();
      if (
        !(await confirmBox(
          'Create the pull request?',
          `Pushes ${branch} to origin and opens a pull request into ${b} on ${st?.repo}. Everyone with access to the repository can see it.`,
          'Create pull request',
        ))
      )
        return;
      create.disabled = true;
      out.textContent = 'Pushing and creating…';
      const r = await ghPost({
        op: 'create',
        repo: dir,
        title: title.value,
        body: body.value,
        base: b,
        draft: draft.checked,
      });
      create.disabled = false;
      out.textContent = r.out ?? '';
      out.classList.toggle('bad', !r.ok);
      if (r.ok) {
        form.replaceChildren();
        form.hidden = true;
        last = '';
        refresh();
        pushed();
      }
    };
  }

  return {
    el: strip,
    refresh,
    tick: () => {
      if (!asked || pending() || ++ticks % 4 === 0) refresh();
    },
    wake: () => {
      if (!asked) refresh();
    },
  };
}
