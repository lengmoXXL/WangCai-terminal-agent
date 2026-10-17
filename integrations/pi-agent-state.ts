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
  // A run that asked for tools has not finished: it ends, the tools run, and the next run reads what they
  // returned, so pi settling between them is not the end of the work.
  let tools = 0;
  // A session that starts has nothing running in it yet, whatever the run before left behind.
  pi.on('session_start', (_event, ctx) => { if (shown(ctx)) report(); });
  pi.on('agent_start', (_event, ctx) => {
    if (!shown(ctx)) return;
    tools = 0;
    report('working');
  });
  pi.on('tool_call', (_event, ctx) => {
    if (!shown(ctx)) return;
    tools += 1;
    report('working');
  });
  pi.on('agent_settled', (_event, ctx) => {
    if (shown(ctx) && ctx?.isIdle?.() === true && tools === 0) report('finished');
  });
  // pi is going away, so nothing is running in the workspace any more.
  pi.on('session_shutdown', (_event, ctx) => { if (shown(ctx)) report(); });
}
