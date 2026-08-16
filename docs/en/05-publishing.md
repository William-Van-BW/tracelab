# Publishing results

**English** · [中文](../zh/05-publishing.md)

Runs live outside the repository and contain real paths from the test machine.
What gets published is a **redacted, filtered** snapshot.

## The flow

```bash
# 1 rebuild the workbench index if Cases changed
cd apps/workbench && node scripts/sync-case-library.mjs

# 2 build the snapshot (redaction happens here)
cd ../showcase && node scripts/build-data.mjs

# 3 check
node scripts/check.mjs
node ../../tools/scan-leaks.mjs ../..

# 4 commit
git add apps/showcase/data apps/workbench/lib/generated-case-library.json
git commit -m "chore(showcase): update snapshot"
git push
```

Pushing to `main` triggers `.github/workflows/deploy-showcase.yml`, which
rebuilds and publishes to GitHub Pages. Nothing is pushed by hand.

## Selection rules

`build-data.mjs` does not publish everything:

| Content | Rule |
| --- | --- |
| Cases | **latest version only** per family. A v1.0.1 hides v1.0.0. |
| Runs | only those bound to the latest Case version, and only the **most recent** per Case × agent. |
| Stage | `benchmark` only. `iteration` runs stay private. |
| Coverage | pairs with no comparable result show `—` with a reason, and **no total trace count is claimed**. |

That last rule is deliberate: folding "no result" into a total makes coverage
look better than it is. Deliberately withheld pairs are declared in
`WITHHELD_RUNS` by `family_id` + `agentId` — by family rather than display
number, so renumbering a Case cannot accidentally release one.

## Redaction

`build-data.mjs` replaces, on export:

| Content | Replaced with |
| --- | --- |
| the operator's home path and account name | `C:\Users\operator` |
| private IPv4 addresses | `intranet.local` |
| email addresses | a placeholder |

Traces spell paths several ways — plain Windows, JSON-escaped (tool results are
themselves nested JSON, so separators arrive doubled), POSIX-ish, URL-encoded,
and truncated by PowerShell's error formatter into `C:\Users\<first letters>...`.
Every form has to be covered, longest rules first.

Emails are redacted because agents that browse quote third parties' contact
addresses; those people did not volunteer for this corpus, and no finding has
ever turned on the address being real.

Two gates: `scripts/check.mjs` re-checks the snapshot and
`tools/scan-leaks.mjs` scans the whole repository. Both run in CI. `--no-redact`
is for local inspection and **must never be used for a publish**.

## Why the snapshot is committed

`data/` is a build product, but it is version-controlled: Runs live outside the
repository (`%USERPROFILE%\AgentRuns`), so a cloner has no source data to
regenerate it from. Committing the snapshot is the only way the results can be
inspected independently.

## The site itself

- Zero dependencies. Plain HTML/CSS/JS, no build step, no external resources.
- Relative paths and hash routing throughout, so the same `dist/` works at a
  domain root or under `<user>.github.io/<repo>/`. `build-site.mjs` fails the
  build if it finds any absolute `/`-rooted reference.
- `server.mjs` is for local preview only.
