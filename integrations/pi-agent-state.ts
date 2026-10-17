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
  // pi settles between a run and the tools it asked for, so an end waits to see whether anything follows it: a
  // later report, tool call, another settle, or the session ending cancels that wait.
  let pendingEnd: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(pendingEnd);
    pendingEnd = undefined;
  };

  // What the file already holds is not written again, since a tool call reports the state its run is already in.
  // Nothing written yet is not the same as a report taken away: a session that starts has to clear what an older
  // run left behind.
  let written: string | undefined;
  const report = (state?: AgentState) => {
    cancel();
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

  // Only the session someone is looking at: a subagent runs headless and shares this environment. A session's
  // start and the events of its runs ask this rather than remembering an answer, since an extension pi picks up
  // after a session began never sees its start.
  const shown = (ctx) => ctx?.mode === 'tui';
  // A session that starts has nothing running in it yet, unless pi is only reloading while a run goes on.
  pi.on('session_start', (_event, ctx) => {
    if (!shown(ctx)) return;
    report(ctx?.isIdle?.() === false ? 'working' : undefined);
  });
  // A run that starts and a run whose tools have started are one report: the session is working.
  const working = (_event, ctx) => {
    if (!shown(ctx)) return;
    report('working');
  };
  pi.on('agent_start', working);
  pi.on('tool_call', working);
  pi.on('agent_settled', (_event, ctx) => {
    if (!shown(ctx) || ctx?.isIdle?.() !== true) return;
    cancel();
    // The tools start a moment after the settle, so this window is long enough for them to show up.
    pendingEnd = setTimeout(() => report('finished'), 600);
  });
  // pi is going away, so a session takes back the report it wrote, and leaves one another session in that
  // workspace may own.
  pi.on('session_shutdown', () => {
    cancel();
    if (written !== undefined) report();
  });
}
