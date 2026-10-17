// What a pi session tells the window it runs in, so a workspace row can show whether the agent in it is
// working, or finished and not read yet. The terminal-agent plugin names the file to write in
// WANGCAI_AGENT_STATE, on the machine the session runs on, and puts what it reads there on that workspace's
// row. A machine reports two states; the app's third, idle, is what it draws for a row with no report.
//
// The plugin installs this file into pi's extensions directory on every machine it connects to, and a session
// it did not open carries no such variable: this then does nothing.
//
// Installed, the file sits outside this repository, where no tsconfig covers it and `pi` resolves to no types:
// the errors it reports are ones nobody here can fix, so the copy pi loads is left unchecked.
// @ts-nocheck

import { rmSync, writeFileSync } from 'node:fs';

const statePath = process.env.WANGCAI_AGENT_STATE;

type AgentState = 'working' | 'finished';

export default function (pi) {
  if (!statePath) return;
  // A report is a word in that file, and no report is no file at all. What the file already holds is not
  // written again, since a tool call reports the state its run is already in.
  let written: string | undefined;
  const report = (state?: AgentState) => {
    const next = state ?? '';
    if (next === written) return;
    written = next;
    try {
      if (state === undefined) rmSync(statePath, { force: true });
      else writeFileSync(statePath, `${state}\n`);
    } catch {
      // A report the machine will not take is a row without a state, not a session that failed.
    }
  };

  // Only the session someone is looking at: a subagent runs headless and shares this environment. Each event is
  // asked, because an extension pi picks up after a session began never sees that session's start.
  const shown = (ctx) => ctx?.mode === 'tui';
  // pi settles between a run and the tools it asked for, so an end is only reported when nothing follows it: a
  // run that carries on cancels the wait, and one that is over lets it stand.
  let soon: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (soon !== undefined) clearTimeout(soon);
    soon = undefined;
  };
  // A session that starts has nothing running in it yet, unless pi is only reloading while a run goes on.
  pi.on('session_start', (_event, ctx) => {
    if (!shown(ctx)) return;
    report(ctx?.isIdle?.() === false ? 'working' : undefined);
  });
  pi.on('agent_start', (_event, ctx) => {
    if (!shown(ctx)) return;
    cancel();
    report('working');
  });
  pi.on('tool_call', (_event, ctx) => {
    if (!shown(ctx)) return;
    cancel();
    report('working');
  });
  pi.on('agent_settled', (_event, ctx) => {
    if (!shown(ctx) || ctx?.isIdle?.() !== true) return;
    cancel();
    soon = setTimeout(() => {
      soon = undefined;
      report('finished');
    }, 600);
  });
  // pi is going away, so nothing is running in the workspace any more: a session takes back what it wrote, and
  // leaves a report another session in that workspace may own. The context of an ending session is not asked,
  // since it need not say which session it was.
  pi.on('session_shutdown', () => {
    cancel();
    if (written !== undefined) report();
  });
}
