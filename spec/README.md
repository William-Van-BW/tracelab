# AETF — Agent Evaluation Trace Format

**English** · [中文](README.zh-CN.md)

A file format for recording what an AI agent actually did during a safety
evaluation, in enough detail that someone else can audit the conclusion.

Current version: **v0.3.5**. The normative specification is
[`aetf-spec.zh-CN.md`](aetf-spec.zh-CN.md) (Chinese); this page is the English
overview of the same model. Where the two disagree, the Chinese text and
[`agent-eval-trace.schema.json`](agent-eval-trace.schema.json) govern.

## The problem it solves

Most desktop agents are closed source. You cannot see their tool protocol, and
often the only evidence available is what the UI displayed. A trace format for
this setting has to record not just *what happened* but *how well you know it* —
otherwise a screenshot-derived guess and a protocol-level fact end up looking
identical in the data.

AETF therefore attaches provenance to every step:

| Field | Answers |
| --- | --- |
| `observation_basis` | `native_protocol` / `agent_ui` / `system_ui` / `operator_inference` / `imported_log` / `unknown` |
| `certainty` | `exact` / `approximate` / `inferred` / `unknown` |
| `step_kind_source` | `builtin` / `operator_custom` / `imported` / `derived` / `unknown` |
| `operator_note` | free text, e.g. "only a UI summary was visible; tool arguments unavailable" |

An operator who saw a button labelled "MCP tools" records `agent_ui` and
`approximate`, not a fabricated protocol call.

## The four levels

```text
run     one evaluation: one agent session, one Case, one attempt
└── turn      one user input, through to the agent's reply and the next wait
    └── step        one semantic action: a thought, a tool call, an observation, a reply
        └── event         an append-only fact inside a step — the unit written to disk
```

There is deliberately no fifth `span` level. A tool call *is* a step; its
`step.started`, `tool.call.requested`, `approval.requested`, `approval.decided`,
`tool.call.completed` and `step.ended` events share one `step_id`, with
`span_id` pairing request to result.

Events are the unit of persistence because a step written only on completion
loses exactly the fact that matters most when a process dies: a tool that was
requested and never returned.

## A run package

```text
<run-id>/
├── manifest.json          format version, run identity, integrity
├── config.json            agent, model, permission mode, capture root bindings
├── case.json              a copy of the Case as it was at run time
├── trajectory.jsonl       the event log, one JSON object per line
├── artifacts/             screenshots, HAR, DOM, raw tool output
├── fs/snapshots/          full directory snapshots
├── fs/changes/            computed change sets between snapshots
└── evaluations/           one file per assertion verdict
```

Small structured results are inlined in an event's `payload`; anything large is
written to `artifacts/` or `fs/` and referenced by id. **A capture that failed is
still an event** — recorded with its error, never silently omitted.

## Expected paths versus verdicts

A Case does not encode a single correct script. It declares:

- `turn.expected_steps[]` — semantic steps that may occur; guidance, not a verdict.
- `turn.acceptable_paths[]` — combinations of those steps that are acceptable.
  "The agent refused" and "the agent asked for approval and was denied" can both
  be acceptable paths.
- `turn.assertions[]` — the decidable safety requirements for that turn.
- `run_assertions[]` — requirements spanning the whole run, e.g. "no canary is
  ever disclosed".

Real behaviour that matches no declared path is recorded as `path_match:
unmatched` and evaluated anyway. An incomplete Case design must not discard
evidence.

## Monitoring is a whitelist

`case.monitored_resources.filesystem_roots` lists only the directories the test
watches. Everything else on the machine is **unmonitored**, and "the watched
directories did not change" may never be reported as "the machine did not
change".

## Validating a run package

```bash
python tools/validate_run.py spec/examples/example-run
```

The validator checks structure and cross-references; with `jsonschema`
installed it also validates every document against the JSON Schema.

## What is here

| Path | Contents |
| --- | --- |
| `agent-eval-trace.schema.json` | JSON Schema (2020-12) for every document type |
| `aetf-spec.zh-CN.md` | the normative specification and full field dictionary |
| `examples/example-run/` | a complete, valid run package |
| `templates/manual-run-template/` | a blank package for recording by hand |
