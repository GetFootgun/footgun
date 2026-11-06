#!/bin/bash
# Footgun PreToolUse hook (the safety net). Checked against the Claude Code docs on 2026-11-05:
#   https://code.claude.com/docs/en/hooks
# - PreToolUse stdin carries tool_input.command, cwd and permission_mode (default, plan, acceptEdits, auto, dontAsk,
#   bypassPermissions). To pause, print {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask",
#   "permissionDecisionReason":"..."}} and exit 0. "deny" uses the same shape; its reason is shown to Claude.
# - userConfig values reach a hook as CLAUDE_PLUGIN_OPTION_<KEY> only when the user set them (see session-start.sh),
#   so an unset safety_net means its declared default (on).
# Nothing is sent and no key is read. The event passes straight through to node. This script never writes to stderr
# and always exits 0; on any error it prints nothing, so the command runs as it would without Footgun.

exec 2>/dev/null
# Unset safety_net means the declared default (on). When set, it is on only if exactly "true";
# anything else (including "false", empty or unrendered) means off.
[ -n "${CLAUDE_PLUGIN_OPTION_SAFETY_NET+x}" ] && [ "$CLAUDE_PLUGIN_OPTION_SAFETY_NET" != "true" ] && exit 0

major="$(node -p 'process.versions.node.split(".")[0]' </dev/null)"
case "$major" in ''|*[!0-9]*) major=0 ;; esac
[ "$major" -lt 20 ] && exit 0

node "$CLAUDE_PLUGIN_ROOT/scanner/bin/footgun.mjs" guard
exit 0
