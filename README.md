# Footgun

Your AI agent knows how the API works. Footgun tells it how it breaks.

Footgun is a dated, verified registry of the traps that docs leave out: silent deprecations, quiet limits, settings that save but do nothing. Your coding agent checks it before it writes the code. Browse every trap at [getfootgun.com](https://getfootgun.com).

## Does it help?

On 17 coding tasks that touch recent API changes, run 5 times each, Claude Code got the code right on the first try 82% of the time with Footgun and 52% without, at 18% lower cost per working result. On older APIs the model already knows, it made no difference. The method and full results are at [getfootgun.com/benchmark](https://getfootgun.com/benchmark).

## What we found in 200 AI-built apps

89 of 200 still use GitHub Actions built for Node 20, which GitHub now runs on Node 24. 93 have at least one problem that breaks now or will break, counting only rules a person checked against real code. The method and results are at [getfootgun.com/scan](https://getfootgun.com/scan).

## Install in Claude Code

```
/plugin marketplace add getfootgun/footgun
/plugin install footgun@footgun
```

Lookups and filing work without an account. Filed traps are checked against official sources before anyone else sees them. To confirm traps, create an API key at [getfootgun.com/account](https://getfootgun.com/account) and enter it when the plugin asks.

The plugin also adds `/footgun:scan`, which checks your project on your machine for known traps in the exact package versions you use. Your code never leaves your machine; only the rule download and an anonymous count of findings are sent. Turn the plugin setting `share_learnings` off to stop the count and the filing of fixes your agent learns. The setting `auto_context` adds a short note of those traps at the start of each session. It is on by default; set it to false to turn it off.

## Command line

`cli/` holds the same scanner as a command, published on npm as `@getfootgun/footgun`: `npx @getfootgun/footgun scan [path]` (Node 20 or later). Add `--json` for machine-readable output or `--fail-on breaks` to fail a CI job.

## Any other MCP client

```
claude mcp add --transport http footgun https://getfootgun.com/api/mcp
```

For Cursor, Codex and other clients, point them at `https://getfootgun.com/api/mcp` (streamable HTTP). Add the header `Authorization: Bearer <your key>` to file and confirm traps.

## The data

`data/traps/<tool>/<trap>.json` holds every public verified trap: symptoms, cause, fix, the date it was last verified, and its trust score. `data/providers.json` lists the tools covered. The data is exported from getfootgun.com and updated as traps are added, confirmed or retired.

## Licence

Trap data in `data/` is licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit "Footgun, getfootgun.com". The plugin files are MIT licensed (see `LICENSE`).
