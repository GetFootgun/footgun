# Footgun

Footgun gives Claude a registry of dated, verified traps in third-party APIs, platforms and AI coding tools: the exact error you see, the cause, the fix, and the date it was last checked against official sources. With the plugin installed, Claude looks up known traps before it writes code against a service such as Stripe, Supabase, Vercel or GitHub Actions, and searches them when a call fails, so it avoids changes made after its training data.

## What it adds

- **MCP server** (`footgun`, at `https://getfootgun.com/api/mcp`) with four tools: `lookup_traps` (traps for a provider), `search_traps` (traps matching an error message), `file_trap` (report a new trap, reviewed before it is published) and `confirm_trap` (confirm or dispute a trap; needs an API key).
- **Skill** (`footgun`) that tells Claude when to call those tools.
- **Command** `/footgun:scan`, which scans the current project for known traps and offers fixes.
- **Session note**: at the start of a session, a hook scans the project's package files on your machine and adds a short note of the traps that apply to its exact package versions.

## Settings

- `api_key` (optional): a Footgun API key from https://getfootgun.com/account. Needed to confirm traps and to keep private traps. Stored as a sensitive value.
- `auto_context` (default on): the session note. Set to false to turn the hook off.
- `share_learnings` (default on): anonymous filings and the anonymous usage count described below. Set to false to send neither.

## What it runs, stores and sends

- **Runs** `bash hooks/session-start.sh` at session start, which runs `node scanner/bin/footgun.mjs` from this plugin. The scanner reads package manifests and lockfiles (such as `package.json`, `package-lock.json`, `pyproject.toml` and `requirements.txt`) and GitHub Actions workflow files in the project folder, then matches the rules' patterns against the project's files, skipping folders such as `node_modules`, `.git` and anything in `.gitignore`. All of this happens on your machine. The session note needs Node 20 or later and stops itself after 8 seconds. `/footgun:scan` runs the same scanner.
- **Fetches** the public detection rules from `https://getfootgun.com/api/v1/rules`, sending your API key only if you set one.
- **Stores** a cached copy of the rules and a small per-project state file in `~/.footgun` on your machine (files readable only by you).
- **Sends**, when `share_learnings` is on, one anonymous usage count per session to `https://getfootgun.com/api/v1/ping`: the kind of run, whether Node was found, and how many traps matched at each severity. Never file paths, package names or code. `/footgun:scan` never sends it.
- **MCP calls** go to `https://getfootgun.com/api/mcp` with the provider name, task description or error text Claude passes to the tool. Known key and secret formats are redacted from error text before matching. With `share_learnings` on, `file_trap` without an API key files an anonymous trap for review.
- Your source code never leaves your machine. Nothing is sent to any other host.

Privacy policy: https://getfootgun.com/privacy. Docs: https://getfootgun.com/docs. Support: hello@getfootgun.com.

## License

MIT
