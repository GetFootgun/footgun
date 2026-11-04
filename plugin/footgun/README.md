# Footgun

Footgun gives Claude a registry of dated, verified traps in third-party APIs, platforms and AI coding tools: the exact error you see, the cause, the fix, and the date it was last checked against official sources. With the plugin installed, Claude looks up known traps before it writes code against a service such as Stripe, Supabase, Vercel or GitHub Actions, and searches them when a call fails, so it avoids changes made after its training data.

## What it adds

- **MCP server** (`footgun`, at `https://getfootgun.com/api/mcp`) with four tools: `lookup_traps` (traps for a provider), `search_traps` (traps matching an error message), `file_trap` (report a new trap, reviewed before it is published) and `confirm_trap` (confirm or dispute a trap; needs an API key).
- **Skill** (`footgun`) that tells Claude when to call those tools.
- **Command** `/footgun:scan`, which scans the current project for known traps and offers fixes.
- **Session note**: at the start of a session, a hook scans the project's package files on your machine and adds a short note of the traps that apply to its exact package versions.
- **Failed-command search**: when a shell command fails, a hook searches known traps with the error text and shows a strong match next to the error. It also tells Claude to stop when the same command keeps failing the same way.
- **Footgun Keys MCP server** (`footgun-keys`), which runs `npx -y @getfootgun/keys mcp` on your machine. Its tools are `keys_list`, `keys_write_env`, `keys_request`, `keys_check`, `keys_guides` and `keys_sync_env` (compare a project's env vars with Vercel or Railway and push the missing ones). It needs the Footgun Keys helper, set up once with `npx @getfootgun/keys setup` (on Windows, `npx.cmd @getfootgun/keys setup`), and the Footgun Keys Chrome extension.

## Settings

- `api_key` (optional): a Footgun API key from https://getfootgun.com/account. Needed to confirm traps and to keep private traps. Stored as a sensitive value.
- `auto_context` (default on): the session note. Set to false to turn the hook off.
- `auto_search` (default on): the failed-command search. Set to false to send nothing; the repeated-failure warning still works, on your machine only.
- `share_learnings` (default on): anonymous filings and the anonymous usage count described below. Set to false to send neither.

## What it runs, stores and sends

- **Runs** `bash hooks/session-start.sh` at session start, which runs `node scanner/bin/footgun.mjs` from this plugin. The scanner reads package manifests and lockfiles (such as `package.json`, `package-lock.json`, `pyproject.toml` and `requirements.txt`) and GitHub Actions workflow files in the project folder, then matches the rules' patterns against the project's files, skipping folders such as `node_modules`, `.git` and anything in `.gitignore`. All of this happens on your machine. The session note needs Node 20 or later and stops itself after 8 seconds. `/footgun:scan` runs the same scanner.
- **Runs** `bash hooks/tool-failure.sh` when a Bash or PowerShell command fails, which runs `node scanner/bin/footgun.mjs failure`. It is silent, always lets the session carry on, and stops itself after 5 seconds.
- **Fetches** the public detection rules from `https://getfootgun.com/api/v1/rules`, sending your API key only if you set one.
- **Stores** a cached copy of the rules, a small per-project state file and, for the failed-command search, a per-session record of which errors were searched in `~/.footgun` on your machine (files readable only by you; session records are deleted after two days).
- **Sends**, when `share_learnings` is on, one anonymous usage count per session to `https://getfootgun.com/api/v1/ping`: the kind of run, whether Node was found, and how many traps matched at each severity. Never file paths, package names or code. `/footgun:scan` never sends it.
- **Sends**, when `auto_search` is on and a command fails, the last 2,000 characters of its error text to `https://getfootgun.com/api/v1/search`, with known secret formats, your project and home folders, other file paths and URL paths and queries removed first. Never the command itself or your code. Each error is sent at most once per session.
- **Footgun Keys** keeps key values in your Mac's Keychain or Windows Credential Manager and in the env files you choose. The `footgun-keys` server checks your plan and loads guides from `https://getfootgun.com` with your Footgun API key; key values are never sent to Footgun. `keys_sync_env` sends values only to Vercel's or Railway's own API, and only when asked to apply changes.
- **MCP calls** go to `https://getfootgun.com/api/mcp` with the provider name, task description or error text Claude passes to the tool. Known key and secret formats are redacted from error text before matching. With `share_learnings` on, `file_trap` without an API key files an anonymous trap for review.
- Your source code never leaves your machine. Nothing is sent to any other host, apart from Vercel or Railway when you ask `keys_sync_env` to push variables there.

Privacy policy: https://getfootgun.com/privacy. Docs: https://getfootgun.com/docs. Support: hello@getfootgun.com.

## License

MIT
