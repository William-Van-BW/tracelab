# Recording traces

**English** · [中文](../zh/04-recording-traces.md)

The trace is what this method produces. A verdict can be questioned and
overturned — but only a complete trace gives the questioning anything to stand
on.

## Two ways in

| Route | When | What you get |
| --- | --- | --- |
| **Automatic import** | the agent left a session log on this machine | full prompts, thinking, tool calls and results, reviewable step by step |
| **Manual recording** | only the UI is visible, or the log is a degraded source | the semantic steps the operator observed, with provenance stated honestly |

Most benchmark runs use both: import for the skeleton, then add by hand what
only the UI showed.

## Automatic import

*Import agent log* scans seven modular adapters:

| Agent | Source | Note |
| --- | --- | --- |
| ChatGPT / Codex | Codex rollout JSONL; ChatGPT `conversations.json` export | full source |
| Claude Desktop | `conversations.json` export preferred, else diagnostic logs | full with an export, otherwise degraded |
| WorkBuddy | project session JSONL | full source |
| Trae | persistent `ai-agent*_stdout.log`, keyed by native session ID | **partial**: thinking text is never written to disk |
| Qoder (international) | `%APPDATA%\QoderWork\data\agents.db` | full source, falls back to project JSONL |
| QoderWorkCN | the China build of the same product, different root | shares one agent profile with the international build |
| DuMate | `opencode.db` | full source |

SQLite adapters copy the database and its WAL to a temporary read-only snapshot
first — **the agent's own data is never modified**.

Each import records the source path, SHA-256, native event count, merged event
count, completeness and warnings. Tool calls and results are merged by call ID
and consecutive reasoning is collapsed, so there is less to tidy by hand.

### Picking the right session

Sessions are grouped by agent, newest first. **Do not go by title** — many
agents only ever generate "New chat". In order of reliability:

1. Last-updated time, matched against when you actually ran it
2. The project or workspace name in the source path
3. The native session ID, which you can cross-check in the agent's own database
4. The completeness flag: prefer `full`; `summary`, `partial` and `unknown` are
   approximations

After saving, the page jumps to manual recording. **Check the first turn's
prompt, the agent, the Case and the turn count immediately** — that is the last
confirmation. If it does not match, do not write it into the corpus; go back to
the agent's app and find out which session it was.

A native session keeps a stable Run ID, so importing it again updates the same
Run instead of creating a duplicate.

## Manual recording

Create one step per semantic action, and state provenance honestly:

- **`kind`** — `reasoning`, `tool_or_action`, `command_execution`, `skill_load`,
  `skill_call`, `mcp_discovery`, `web_search`, `browser_action`, `approval`,
  `file_operation`, `observation`, `assistant_response`, or a custom type.
- **`observation_basis`** — where this record's evidence came from:
  `native_protocol`, `agent_ui`, `system_ui`, `operator_inference`,
  `imported_log`, `unknown`.
- **`certainty`** — `exact` / `approximate` / `inferred` / `unknown`.
- **`operator_note`** — any limitation that affects interpretation, e.g. "only a
  UI summary was visible; tool arguments unavailable".

**The most common mistake is recording a UI summary as a protocol fact.** A
label reading "MCP tools" does not prove a standard MCP call happened. Record
`tool_or_action` + `agent_ui` + `approximate` and do not invent precise
arguments. This is not sloppiness — it is what later lets anyone tell which
conclusions rest on solid evidence.

## Evidence steps

Directory sampling, screenshots and uploads all land in the trace as evidence
steps of the current turn.

A directory snapshot stores the **complete absolute state**. The earliest one in
a Run is the stable baseline, and every later sample yields a cumulative diff
against it; deleting a later snapshot never moves the baseline.

**Record failed captures too** — as a step, with the reason (permission denied,
deployment already destroyed, screenshot tool error). Omitting them silently
lets a later reader assume everything was fine.

## Validation

```bash
python tools/validate_run.py <run-directory>
```

Checks structure and cross-references; with `jsonschema` installed it validates
every document against the [AETF schema](../../spec/agent-eval-trace.schema.json).
`spec/examples/example-run/` is a complete valid package and
`spec/templates/manual-run-template/` is a blank one.
