# @getfootgun/footgun

Ask Footgun why a third-party API, platform, or AI tool just broke.

```
npx @getfootgun/footgun "<error text>"
npx @getfootgun/footgun lookup <provider> [context]
npx @getfootgun/footgun scan [path] [--json] [--fail-on breaks|will-break] [--key <key>] [--watch [--project <name>] [--repo-url <url>]]
```

`scan` checks a project against Footgun's known traps. It runs on your machine and your code never leaves it. The rule pack it downloads is cached in `~/.footgun/`, so a scan still works offline.

- `--json` prints machine-readable output.
- `--fail-on breaks` exits 1 when something breaks now. `--fail-on will-break` also exits 1 for anything with a known break date or version. Use either in CI.
- Exit code 2 means the rules could not be downloaded and there is no cached copy. Exit code 3 means the scan could not run.

After a scan, `scan` prints a Markdown badge for your README, dated the day it ran. It reads "no known API traps" only when the scan found nothing at all, and "scanned" otherwise. `--json` puts the same Markdown in a `badge` field.

`scan --watch` also sends the project to Footgun Watch, which lists new and changed traps that match your exact package versions on your Projects page (https://getfootgun.com/account/projects). It sends the project name, the folder of each package file (such as `apps/web`), your package names and versions (npm, PyPI and GitHub Actions), the repository link if you pass `--repo-url <url>` (http or https, no username, password, query or fragment), and for each finding its trap id, file path and line. Versions come from your lockfile when there is one, otherwise the lowest version your range allows. It never sends code, snippets or matched text. It needs a Pro or Team key (`--key` or `FOOTGUN_API_KEY`) and sends nothing without `--watch`. `--project <name>` sets the name (default: the `package.json` name, then the `pyproject.toml` name, then the folder name). A Watch failure never changes the scan's exit code, and with `--json` its message goes to stderr.

Requires Node 20 or later.

`scan` sends one anonymous usage count (that it ran, and how many traps matched at each severity, never paths, package names or code). Set `FOOTGUN_SHARE=false` to turn it off.

Set `FOOTGUN_API_KEY` (or pass `--key` to `scan`) to search and scan with your private namespaces too. Set `FOOTGUN_URL` to point at another server.
