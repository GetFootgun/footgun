#!/bin/bash
# Footgun SessionStart hook. Checked against the Claude Code docs on 2026-10-20:
#   https://code.claude.com/docs/en/hooks (docs.claude.com/en/docs/claude-code/hooks redirects here)
#   https://code.claude.com/docs/en/plugins-reference (the plugin manifest reference)
#   https://code.claude.com/docs/en/settings-reference#pluginconfigs
# - SessionStart output: JSON {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}.
#   Plain-text stdout from a SessionStart hook is also added to Claude's context.
# - Plugin hooks live in hooks/hooks.json, with the event map wrapped in a top-level "hooks" key
#   (optional "description"). Matchers for SessionStart: startup, resume, clear, compact, fork.
# - ${CLAUDE_PLUGIN_ROOT} is the plugin's installed directory, substituted in the hook command and
#   also exported to the hook process. Hooks run in the session's current directory;
#   CLAUDE_PROJECT_DIR (also exported) is the project root, so it is preferred over $PWD.
# - userConfig values reach a hook as environment variables CLAUDE_PLUGIN_OPTION_<KEY>, KEY uppercased
#   (auto_context -> CLAUDE_PLUGIN_OPTION_AUTO_CONTEXT). A shell-form hook command that references
#   ${user_config.*} fails instead of running, so this script reads the environment variables.
# - Default command hook timeout is 600 s; hooks.json sets 15 (context mode stops itself at 8 s).
# This script never writes to stderr and always exits 0, so it cannot disturb the session.

exec 2>/dev/null
[ "$CLAUDE_PLUGIN_OPTION_AUTO_CONTEXT" = "true" ] || exit 0
# Sharing is on only when share_learnings is exactly "true"; anything else (unset, empty, unrendered) means off.
share=false
[ "$CLAUDE_PLUGIN_OPTION_SHARE_LEARNINGS" = "true" ] && share=true

root="${CLAUDE_PROJECT_DIR:-$PWD}"
major="$(node -p 'process.versions.node.split(".")[0]')"
case "$major" in ''|*[!0-9]*) major=0 ;; esac

if [ "$major" -lt 20 ]; then
  # Anonymous count of sessions without a usable Node: no paths, names or code. Skipped when share_learnings is false
  # or curl is absent. Runs in the background with short timeouts and discarded output, so it cannot slow or disturb the session.
  if [ "$share" = "true" ] && command -v curl >/dev/null; then
    ( curl -s -o /dev/null --connect-timeout 1 --max-time 2 -X POST -H 'content-type: application/json' \
        -d '{"kind":"hook","nodeFound":false,"counts":{"breaks":0,"willBreak":0,"silent":0,"cost":0}}' \
        "${FOOTGUN_URL:-https://getfootgun.com}/api/v1/ping" ) >/dev/null 2>&1 &
  fi
  # Tell the user once per project, keyed like the scanner's state file: sha256(absolute root), first 16 hex.
  if command -v shasum >/dev/null; then hash="$(printf '%s' "$root" | shasum -a 256)"
  elif command -v sha256sum >/dev/null; then hash="$(printf '%s' "$root" | sha256sum)"
  else exit 0
  fi
  hash="${hash:0:16}"
  dir="$HOME/.footgun/projects"
  marker="$dir/$hash.node-notice"
  [ -e "$marker" ] && exit 0
  mkdir -p -m 700 "$HOME/.footgun" "$dir" && : > "$marker" || exit 0
  echo "Footgun automatic context needs Node 20 or later: https://nodejs.org"
  exit 0
fi

[ -n "$CLAUDE_PLUGIN_OPTION_API_KEY" ] && export FOOTGUN_API_KEY="$CLAUDE_PLUGIN_OPTION_API_KEY"
export FOOTGUN_SHARE="$share"
node "$CLAUDE_PLUGIN_ROOT/scanner/bin/footgun.mjs" context "$root"
exit 0
