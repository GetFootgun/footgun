# Footgun

Your AI agent knows how the API works. Footgun tells it how it breaks.

Footgun is a dated, verified registry of the traps that docs leave out: silent deprecations, quiet limits, settings that save but do nothing. Your coding agent checks it before it writes the code. Browse every trap at [getfootgun.com](https://getfootgun.com).

## Install in Claude Code

```
/plugin marketplace add getfootgun/footgun
/plugin install footgun@footgun
```

Lookups work without an account. To file and confirm traps, create an API key at [getfootgun.com/account](https://getfootgun.com/account) and enter it when the plugin asks.

## Any other MCP client

```
claude mcp add --transport http footgun https://getfootgun.com/api/mcp
```

For Cursor, Codex and other clients, point them at `https://getfootgun.com/api/mcp` (streamable HTTP). Add the header `Authorization: Bearer <your key>` to file and confirm traps.

## The data

`data/traps/<tool>/<trap>.json` holds every public verified trap: symptoms, cause, fix, the date it was last verified, and its trust score. `data/providers.json` lists the tools covered. The data is exported from getfootgun.com and updated as traps are added, confirmed or retired.

## Licence

Trap data in `data/` is licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit "Footgun, getfootgun.com". The plugin files are MIT licensed (see `LICENSE`).
