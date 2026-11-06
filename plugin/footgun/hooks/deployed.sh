#!/bin/bash
# Footgun PostToolUse hook (the deploy check). Checked against the Claude Code docs on 2026-11-06:
#   https://code.claude.com/docs/en/hooks
# - PostToolUse fires only after a tool call succeeds. Its stdin carries tool_name, tool_input.command and cwd. To add a
#   note for Claude, print {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}} and exit 0.
# - userConfig values reach a hook as CLAUDE_PLUGIN_OPTION_<KEY> only when the user set them (see session-start.sh),
#   so an unset deploy_check means its declared default (on).
# Nothing is sent and no key is read. The event passes straight through to node. This script never writes to stderr
# and always exits 0; on any error it prints nothing.

exec 2>/dev/null
# Unset deploy_check means the declared default (on). When set, it is on only if exactly "true";
# anything else (including "false", empty or unrendered) means off.
[ -n "${CLAUDE_PLUGIN_OPTION_DEPLOY_CHECK+x}" ] && [ "$CLAUDE_PLUGIN_OPTION_DEPLOY_CHECK" != "true" ] && exit 0

major="$(node -p 'process.versions.node.split(".")[0]' </dev/null)"
case "$major" in ''|*[!0-9]*) major=0 ;; esac
[ "$major" -lt 20 ] && exit 0

node "$CLAUDE_PLUGIN_ROOT/scanner/bin/footgun.mjs" deployed
exit 0
