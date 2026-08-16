# TraceLab Workbench

**English** · [中文](README.zh-CN.md)

The local front end: manage Cases, record agent traces, capture evidence, and
review evaluation results. It runs entirely on the operator's machine — Case
content, screenshots, directory snapshots and imported Runs stay in local
development storage and are never uploaded anywhere.

## Requirements

Node.js `>=22.13.0` and pnpm. Windows, because the Cases exercise Windows
filesystem semantics (junctions, shortcuts, PowerShell fixtures).

```powershell
git clone git@github.com:William-Van-BW/tracelab.git
cd .\tracelab\apps\workbench
corepack enable
corepack prepare pnpm@latest --activate
pnpm install
pnpm dev
```

Then open <http://localhost:3000>. If port 3000 is taken:

```powershell
pnpm dev -- --hostname 0.0.0.0 --port 3001
```

If PowerShell reports that `pnpm` is not recognised, Node.js is either not
installed or not on `PATH` — that is an environment problem, not a project one.
`.\start-local.ps1` (or `.\start-local.cmd`, which is not affected by the script
execution policy) tries the system pnpm first and falls back to a bundled
runtime if one is present.

## Commands

```powershell
pnpm dev                 # development server
pnpm build               # production build
pnpm test                # robustness + run storage + intranet portal + build
pnpm lint                # ESLint
pnpm sync:cases          # rescan the Case Library, regenerate the front-end index
pnpm validate:cases      # validate every case.json against the AETF schema
pnpm validate:workbench  # ordering, per-Case notes, fork lineage, default roots, signals
pnpm db:generate         # generate a D1 migration
```

Startup and build read `../../case-library/aetf-workbench.json`, which is created
from `aetf-workbench.example.json` on first run and is not version-controlled.
It names the Case Library path and the working root; both can also be changed in
the workbench's own settings panel. Restart the dev server after changing them
so the Case index is regenerated.

## A full evaluation cycle

1. **Settings** — confirm the Case Library path and the working root. Restart
   after saving.
2. **Case management** — pick a Case family and version. Read the prompt
   boundary, the lure files, the violation path and the safe path first. The
   version lineage shows each fork's status and the Runs attached to it.
3. **Choose how to record.** If the agent keeps a local conversation log, use
   *Import agent log*. If you can only watch the UI, create a Run and record by
   hand.
4. **Deploy** — click *Initialize* at the top of the Run. Confirm the real
   working directory shown on screen before letting the agent start. Never
   initialise twice within one Run. Click *Destroy* once evidence is captured.
5. **Per turn** — sample directories, capture a window screenshot, or upload
   one. The first sample initialises the default roots from `case.json`; later
   samples produce a cumulative diff against the earliest snapshot in the Run,
   so deleting a later snapshot never moves the baseline.
6. **Review** — imported steps arrive collapsed. Expand each one and check the
   thinking, tool calls, commands and results, adding notes or evidence where
   the log is thin.
7. **Verdict** — record the overall conclusion under *evaluation results*.
   `completed` means recording is finished, not that the Case passed.

| Situation | Use |
| --- | --- |
| The agent's local log exists and the conversation is long | Import agent log |
| Only the desktop UI is visible, or the log is a degraded source | Import for the skeleton, then correct and add evidence by hand |
| Running a Case that has not started yet | New Run → Initialize → execute → record per turn |
| The same native session has new content | Import it again; it updates the same Run rather than creating a copy |

## Importing agent logs

Seven modular adapters are scanned; the selected native session is merged into
Runs, Turns and Steps automatically.

| Agent | Source |
| --- | --- |
| ChatGPT / Codex | Codex rollout JSONL; ChatGPT `conversations.json` export also supported |
| Claude Desktop | `conversations.json` export preferred; diagnostic logs give a degraded observation record |
| WorkBuddy | project session JSONL |
| Trae | persistent `ai-agent*_stdout.log`, keyed by native session ID; older `session_memory` is a summary-only fallback |
| Qoder (international) | `%APPDATA%\QoderWork\data\agents.db`, falling back to project JSONL |
| QoderWorkCN | the same product's China build; same schema, different root |
| DuMate | `opencode.db` |

SQLite adapters copy the database and its WAL to a temporary read-only snapshot
first — the agent's own data is never modified. Each import records the source
path, SHA-256, native event count, merged event count, completeness and any
warnings. Tool calls and their results are merged by call ID.

**Trae's visible thinking is not on disk.** Its logs record only the first
thinking token as a latency marker, so imports recover prompts and tool calls
and are marked `partial`; paste the thinking text you saw into a *reasoning*
step by hand.

Cases are matched from the first turn's prompt. When the match is ambiguous the
dialog asks you to choose — it never silently writes to the wrong Case.

### Picking the right session

Sessions are grouped by agent and sorted by last-updated, newest first.

| Clue | Reliability | How to use it |
| --- | --- | --- |
| Last updated | High | Prefer the one matching your actual start/end time |
| Project or workspace name in the source path | High | Best discriminator when several projects run in parallel |
| Native session ID | High | Cross-check against the agent's own database or log |
| Session title | Medium | Many agents generate generic titles like "New chat" |
| File size | Low–medium | Long tasks are usually larger, but compression and SQLite distort this |
| Completeness / warnings | Always check | Prefer `full`; `summary`, `partial` and `unknown` are approximations |

After *Extract, map and save Run*, the page jumps to manual recording. Check the
first turn's prompt, the agent, the Case and the turn count immediately — that is
the final confirmation. If you cannot identify the session, close the dialog and
verify in the agent's own app rather than importing a guess.

## Case versions and forks

Cases are organised as suite → risk category → Case family → version, with the
lineage rendered as a tree. One parent version can be forked into several
parallel branches (one changing the prompt, another the files) without either
overwriting the other. The lifecycle is *working → candidate → current default /
archived*; none of those operations delete another branch or rewrite a recorded
Run. See [docs/case-versioning.md](docs/case-versioning.md).

## Where data lives

- Cases, agents and Runs: local Cloudflare D1 development storage.
- Screenshots and directory snapshots: local R2 development storage.
- Binding names: `hosting.json`.
