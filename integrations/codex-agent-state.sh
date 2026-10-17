#!/bin/sh
# What a codex session tells the window it runs in, so a workspace row can show whether the agent in it is
# working, or finished and not read yet. The terminal-agent plugin names the file to write in
# WANGCAI_AGENT_STATE, on the machine the session runs on, and puts what it reads there on that workspace's
# row. A machine reports two states; the app's third, idle, is what it draws for a row with no report.
#
# That plugin installs this file into ~/.codex and registers it in ~/.codex/hooks.json for three of codex's
# events. Codex only runs a hook it has recorded trust for, so the plugin writes that trust into
# ~/.codex/config.toml too, which saves the confirmation codex would otherwise ask for once.
#
#   wangcai-agent-state.sh working   a prompt was submitted
#   wangcai-agent-state.sh finished  the turn is over
#   wangcai-agent-state.sh clear     a session started, with nothing running in it yet
set -eu

action="${1:-}"

# Codex writes the hook's JSON payload to stdin; nothing here reads it, and it must not wait on the write.
cat >/dev/null 2>&1 || true

[ -n "${WANGCAI_AGENT_STATE:-}" ] || exit 0

case "$action" in
  working | finished) printf '%s\n' "$action" > "$WANGCAI_AGENT_STATE" 2>/dev/null || true ;;
  clear) rm -f "$WANGCAI_AGENT_STATE" 2>/dev/null || true ;;
esac
