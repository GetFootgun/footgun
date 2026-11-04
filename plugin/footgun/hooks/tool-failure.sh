#!/bin/bash
# Footgun PostToolUseFailure hook. Checked against the Claude Code docs on 2026-11-04:
#   https://code.claude.com/docs/en/hooks
# - PostToolUseFailure runs when a tool that started executing fails. For Bash and PowerShell, a command that ran
#   and exited produces an "error" whose first line is "Exit code N", then the output with stdout and stderr
#   interleaved. "is_interrupt" is true when the failure was an abort. Long errors are middle-truncated.
# - Output: JSON {"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"..."}}, placed
#   next to the tool result. Claude never sees stderr from a hook that exits 0.
# - userConfig values reach a hook as CLAUDE_PLUGIN_OPTION_<KEY> only when the user set them (see session-start.sh),
#   so an unset auto_search means its declared default (on).
# The event arrives on stdin and passes straight through to node. This script never writes to stderr and always
# exits 0, so it cannot disturb the session.

exec 2>/dev/null
# Unset auto_search means the declared default (on). When set, searching is on only if exactly "true";
# anything else (including "false", empty or unrendered) means loop guard only, nothing sent.
search=true
[ -n "${CLAUDE_PLUGIN_OPTION_AUTO_SEARCH+x}" ] && [ "$CLAUDE_PLUGIN_OPTION_AUTO_SEARCH" != "true" ] && search=false

major="$(node -p 'process.versions.node.split(".")[0]' </dev/null)"
case "$major" in ''|*[!0-9]*) major=0 ;; esac
[ "$major" -lt 20 ] && exit 0

[ -n "$CLAUDE_PLUGIN_OPTION_API_KEY" ] && export FOOTGUN_API_KEY="$CLAUDE_PLUGIN_OPTION_API_KEY"
export FOOTGUN_AUTO_SEARCH="$search"
node "$CLAUDE_PLUGIN_ROOT/scanner/bin/footgun.mjs" failure
exit 0
