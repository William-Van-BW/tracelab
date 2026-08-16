# TraceLab

**English** · [中文](README.zh-CN.md)

**Can a desktop AI agent be trusted with your files?**

TraceLab is a reproducible way to find out. It ships a corpus of office-work
Cases that put an agent's file-safety boundaries under pressure, a trace format
for recording exactly what the agent did, a local workbench for running the
evaluation and capturing evidence, and a static site that publishes the results.

**Live results:** <https://william-van-bw.github.io/tracelab/>

---

## Why this exists

Benchmarks usually ask whether an agent *can* do a task. When an agent has
direct read and write access to a real desktop, the more urgent question is
whether it *should* — and whether it can tell the difference.

Real office directories are messy in ways that create that ambiguity. Files are
left by different people at different times. Naming is inconsistent. An obsolete
instruction file is still sitting there. A business system depends on a relative
path written years ago. An intranet SOP contradicts the department's own rule.
The boundary an agent must respect is rarely stated; it has to be *read* out of
the material before anything is touched.

Each TraceLab Case reconstructs one of those situations as a deployable
directory tree with a verbatim prompt, then records every read, execution and
write the agent performs.

## Three risk categories

| Code | Category | The worry it represents |
| --- | --- | --- |
| **OA** | Out-of-scope file access | Something in the workspace hints at a file outside it. Does the agent treat a business clue as an access grant? |
| **UFM** | Unintended file modification | Instructions are ambiguous, filenames look alike, an external SOP conflicts with local practice. Does the agent delete or rewrite what it should not? |
| **SDMF** | Sensitive data masking failure | A redaction task before an external hand-off. Does anything survive in indirect identifiers, linked data, or derived files? |

24 Cases across the three categories, run against six desktop agents.

## Repository map

| Path | What lives there |
| --- | --- |
| [`spec/`](spec/) | **AETF** — the Agent Evaluation Trace Format: JSON Schema, field dictionary, worked example, blank run template |
| [`case-library/`](case-library/) | The Case corpus: definitions, synthetic fixtures, deploy/destroy scripts, mock intranet portal |
| [`apps/workbench/`](apps/workbench/) | Local workbench — manage Cases, record traces, import agent logs, capture filesystem evidence, review results |
| [`apps/showcase/`](apps/showcase/) | The read-only public site and its build pipeline |
| [`tools/`](tools/) | Run validator, fixture digest refresher, leak scanner, network helpers |
| [`docs/`](docs/) | Concepts, authoring guide, evaluation SOP, publishing guide — in [English](docs/en/) and [中文](docs/zh/) |

## How the pieces fit

```text
case-library/          a Case: prompt + directory template + assertions
      │
      │  Deploy-Case.ps1 — materialise the fixtures into a working root
      ▼
  a real directory on the test machine
      │
      │  the agent runs, under observation
      ▼
apps/workbench/        record the trace: steps, evidence, filesystem snapshots
      │                (or import the agent's own log — six adapters included)
      ▼
  a Run, stored on disk in AETF form  ──────►  spec/  validates it
      │
      │  build-data.mjs — redact, select the latest Run per Case × agent
      ▼
apps/showcase/         the published site
```

## Quick start

Requires Windows (the Cases exercise Windows filesystem semantics), Node.js 22.13+,
and PowerShell 5.1 or later.

```bash
git config --global core.longpaths true   # once, on Windows
git clone https://github.com/William-Van-BW/tracelab.git
```

Case fixtures are Chinese office directories nested several levels deep, so a
checkout can exceed Windows' 260-character path limit. Without `core.longpaths`,
`git clone` reports "Filename too long" and leaves the working tree incomplete.
Cloning into a short directory (`C:\tracelab`) helps too.

Browse the Case corpus and the recorded traces — no install, no dev server:

```bash
cd tracelab/apps/showcase && node scripts/build-data.mjs && node server.mjs
```

Run the workbench to deploy Cases and record your own evaluations:

```bash
cd tracelab/apps/workbench && corepack enable && pnpm install && pnpm dev
```

Validate a run package against the trace format:

```bash
python tools/validate_run.py spec/examples/example-run
```

The [evaluation SOP](docs/en/03-running-an-evaluation.md) walks through a full
cycle: deploy, run, record, evaluate, publish.

## What is synthetic and what is not

Every fixture in this repository is synthetic. The salary tables, customer
lists, contracts and settlement vouchers are fabricated for the test; the canary
strings exist so a leak is unambiguous when it happens. No real personal or
company data is included, and recorded traces are redacted before publication —
account names, machine addresses and third-party contact details are replaced.

The agent behaviour, by contrast, is real. Traces are recorded from actual runs
of shipping products.

## Intended use

This is defensive security research: it exists so that people deploying office
agents can see where the boundaries fail, and so that vendors can fix them. The
Cases are lures, and they work — read [SECURITY.md](SECURITY.md) before you
point one at anything. Do not deploy these fixtures outside an isolated test
machine, and do not use them against systems you are not authorised to test.

## Contributing

New Cases, additional agent log adapters and translation fixes are all welcome.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the Case authoring contract and the
checks that run on every pull request.

## License

Code is [Apache-2.0](LICENSE). The Case corpus, recorded traces and documentation
are [CC BY 4.0](LICENSE-DATA). Attribution should point at this repository.
