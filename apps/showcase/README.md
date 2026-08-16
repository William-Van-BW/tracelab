# TraceLab Showcase

**English** · [中文](README.zh-CN.md)

The public, read-only site: TraceLab's **Case designs** and **recorded traces**.
No editing, no accounts, no writes.

It is fully decoupled from `apps/workbench/` — the site serves **its own copy**
of the data, so continuing to edit Cases and record Runs never disturbs what is
already published.

## Quick start

```bash
node scripts/build-data.mjs && node server.mjs
```

Listens on `8000`, moving to the next free port if that is taken (up to 25
attempts). `PORT=9000` picks a port; `HOST=127.0.0.1` restricts it to this
machine (the default `0.0.0.0` is reachable from the LAN).

Zero dependencies — no `npm install`, Node 18+ is enough.

## What gets published

| Content | Rule |
| --- | --- |
| Cases | **latest version only** per family (a v1.0.1 hides v1.0.0) |
| Runs | only traces bound to the latest Case version, and only the **most recent** run per Case × agent |
| Stage | `benchmark` runs only; iteration runs stay private |
| Coverage | a Case × agent pair with no comparable result shows `—` with the reason, and no total trace count is claimed |

The wording behind each blank is `COVERAGE_NOTE` in `scripts/build-data.mjs`,
shipped with the snapshot so the matrix legend and the Case page always agree.
Deliberately withheld combinations are declared in `WITHHELD_RUNS` by
`family_id` + `agentId` — by family rather than display number, so renumbering a
Case cannot accidentally release one. Today every blank is Claude Desktop on the
five intranet Cases: its safety policy refuses to reach intranet services.

## Layout

```text
apps/showcase/
├─ scripts/
│  ├─ build-data.mjs   builds data/ — the only place that reads workbench data
│  ├─ build-site.mjs   assembles dist/ for a static host
│  └─ check.mjs        data integrity + server smoke tests
├─ public/             the front end: plain HTML/CSS/JS, no build step, no CDN
├─ data/               generated: snapshot.json + cases/ + runs/
└─ server.mjs          zero-dependency static server
```

## Data sources and redaction

`build-data.mjs` reads exactly two things, read-only:

1. `../workbench/lib/generated-case-library.json` — the Case index. **After
   editing `case-library/`, run `node scripts/sync-case-library.mjs` in
   `apps/workbench/` first**, or the site publishes stale content.
2. The Run directory — resolved from `runsRoot`/`workingRoot` in
   `../../case-library/aetf-workbench.json`, overridable with
   `SHOWCASE_RUNS_ROOT`. If it is missing, only Case data is generated.

Export replaces the operator's home path and account name with
`C:\Users\operator`, private IPv4 addresses with `intranet.local`, and email
addresses an agent picked up while browsing with a placeholder. Traces spell
paths several ways — plain, JSON-escaped, POSIX-ish, URL-encoded, truncated by
PowerShell's error formatter — and each form is covered. `scripts/check.mjs` and
`tools/scan-leaks.mjs` verify the result. `--no-redact` exists for local
inspection and must never be used for a publish.

Case material itself (amounts, names, IDs, canary markers) is synthetic by
design.

## Robustness

- **Never touches disk per request.** `data/` and `public/` are read into memory
  and pre-compressed (brotli + gzip) at startup; a request path is never used in
  a filesystem lookup, so traversal has nothing to traverse.
- **Caching.** Data files carry a build fingerprint `?v=` with
  `Cache-Control: immutable` + ETag; `version.json` always revalidates, so a
  rebuild reaches clients immediately.
- **Read-only.** `GET`/`HEAD` only, everything else is 405. CSP allows same
  origin only, no inline scripts, no framing.
- **Survives bad requests.** Uncaught exceptions are logged and the process
  keeps serving; `SIGINT`/`SIGTERM` shut down gracefully.
- **Health check** at `GET /healthz`.

## Verification

```bash
node scripts/check.mjs
```

28 checks: snapshot cross-references, one version per family, all five read-out
fields present, one trace per Case × agent, no redaction leftovers — plus
compression, 304, 404, 405, path traversal, 120 concurrent requests, 40
keep-alive requests, and a malformed request.

## Deployment

Live at <https://william-van-bw.github.io/tracelab/>.

Deployment is automatic: pushing to `main` with changes under `case-library/`,
`apps/showcase/` or `apps/workbench/lib/` triggers
`.github/workflows/deploy-showcase.yml`, which rebuilds and publishes to GitHub
Pages. Nothing is pushed by hand.

To produce the same artefact locally:

```bash
node scripts/build-data.mjs && node scripts/build-site.mjs
```

`build-site.mjs` clears and rebuilds `dist/` (gitignored). Every page uses
relative paths and hash routing, so the same `dist/` works at a domain root or
under `user.github.io/<repo>/` with no rebuild and no server rewrite rules; the
build fails if it finds any absolute `/`-rooted reference. `.nojekyll` and
`404.html` are included. `server.mjs` is for local preview only — a static host
provides its own compression and cache headers.

`data/` is a build product but **is committed**: Runs live outside the
repository (`%USERPROFILE%\AgentRuns`), so no one else could regenerate it.
