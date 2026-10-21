# @getfootgun/footgun

Ask Footgun why a third-party API, platform, or AI tool just broke.

```
npx @getfootgun/footgun "<error text>"
npx @getfootgun/footgun lookup <provider> [context]
npx @getfootgun/footgun scan [path] [--json] [--fail-on breaks|will-break] [--key <key>]
```

`scan` checks a project against Footgun's known traps. It runs on your machine and your code never leaves it. The rule pack it downloads is cached in `~/.footgun/`, so a scan still works offline.

- `--json` prints machine-readable output.
- `--fail-on breaks` exits 1 when something breaks now. `--fail-on will-break` also exits 1 for anything with a known break date or version. Use either in CI.
- Exit code 2 means the rules could not be downloaded and there is no cached copy. Exit code 3 means the scan could not run.

Requires Node 20 or later.

`scan` sends one anonymous usage count (that it ran, and how many traps matched at each severity, never paths, package names or code). Set `FOOTGUN_SHARE=false` to turn it off.

Set `FOOTGUN_API_KEY` (or pass `--key` to `scan`) to search and scan with your private namespaces too. Set `FOOTGUN_URL` to point at another server.
