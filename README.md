# Footgun

Your AI agent knows how the API works. Footgun tells it how it breaks.

Footgun is a dated, verified registry of the traps that docs leave out: silent deprecations, quiet limits, settings that save but do nothing. Your coding agent checks it before it writes the code. Browse every trap at [getfootgun.com](https://getfootgun.com).

## Does it help?

On 17 coding tasks that touch recent API changes, run 5 times each, Claude Code got the code right on the first try 82% of the time with Footgun and 52% without, at 18% lower cost per working result. On older APIs the model already knows, it made no difference. The method and full results are at [getfootgun.com/benchmark](https://getfootgun.com/benchmark).

## Install in Claude Code

```
/plugin marketplace add getfootgun/footgun
/plugin install footgun@footgun
```

Lookups and filing work without an account. Filed traps are checked against official sources before anyone else sees them. To confirm traps, create an API key at [getfootgun.com/account](https://getfootgun.com/account) and enter it when the plugin asks.

The plugin also adds `/footgun:scan`, which checks your project on your machine for known traps in the exact package versions you use. Your code never leaves your machine; only the rule download and an anonymous count of findings are sent. Turn the plugin setting `share_learnings` off to stop the count and the filing of fixes your agent learns. The setting `auto_context` adds a short note of those traps at the start of each session; it is off by default.

## Command line

`cli/` holds the same scanner as a command: `node cli/bin/footgun.mjs scan [path]` (Node 20 or later). Add `--json` for machine-readable output or `--fail-on breaks` to fail a CI job.

## Any other MCP client

```
claude mcp add --transport http footgun https://getfootgun.com/api/mcp
```

For Cursor, Codex and other clients, point them at `https://getfootgun.com/api/mcp` (streamable HTTP). Add the header `Authorization: Bearer <your key>` to file and confirm traps.

## The data

`data/traps/<tool>/<trap>.json` holds every public verified trap: symptoms, cause, fix, the date it was last verified, and its trust score. `data/providers.json` lists the tools covered. The data is exported from getfootgun.com and updated as traps are added, confirmed or retired.

## Licence

Trap data in `data/` is licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit "Footgun, getfootgun.com". The plugin files are MIT licensed (see `LICENSE`).
