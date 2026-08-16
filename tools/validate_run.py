#!/usr/bin/env python3
"""Validate an AETF v0.1 run package without modifying it.

Uses only the Python standard library for JSON, cross-reference and hash checks.
If the optional `jsonschema` package is installed, it also applies the supplied
JSON Schema to every JSON document and JSONL event.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Iterable


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number}: invalid JSON: {exc}") from exc
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number}: event must be a JSON object")
            events.append(value)
    return events


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def iter_artifact_refs(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        if isinstance(value.get("artifact_id"), str):
            yield value
        for child in value.values():
            yield from iter_artifact_refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_artifact_refs(child)


def validate_schema(documents: list[tuple[str, Any]], schema_path: Path) -> list[str]:
    try:
        import jsonschema  # type: ignore
    except ImportError:
        return ["INFO: optional package 'jsonschema' is absent; schema checks skipped"]

    schema = load_json(schema_path)
    validator = jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker())
    messages: list[str] = []
    for label, document in documents:
        errors = sorted(validator.iter_errors(document), key=lambda item: list(item.path))
        for error in errors:
            location = "/".join(str(part) for part in error.absolute_path) or "$"
            messages.append(f"ERROR: {label}:{location}: {error.message}")
    return messages


def validate_run(run_dir: Path, schema_path: Path | None) -> list[str]:
    messages: list[str] = []
    required = ["manifest.json", "config.json", "case.json", "trajectory.jsonl"]
    for relative in required:
        if not (run_dir / relative).is_file():
            messages.append(f"ERROR: missing required file: {relative}")
    if any(message.startswith("ERROR") for message in messages):
        return messages

    manifest = load_json(run_dir / "manifest.json")
    config = load_json(run_dir / "config.json")
    case = load_json(run_dir / "case.json")
    events = load_jsonl(run_dir / "trajectory.jsonl")

    documents: list[tuple[str, Any]] = [
        ("manifest.json", manifest),
        ("config.json", config),
        ("case.json", case),
    ]
    for relative in sorted(run_dir.glob("fs/snapshots/*.json")):
        documents.append((str(relative.relative_to(run_dir)).replace("\\", "/"), load_json(relative)))
    for relative in sorted(run_dir.glob("fs/changes/*.json")):
        documents.append((str(relative.relative_to(run_dir)).replace("\\", "/"), load_json(relative)))
    for relative in sorted(run_dir.glob("evaluations/*.json")):
        documents.append((str(relative.relative_to(run_dir)).replace("\\", "/"), load_json(relative)))
    documents.extend((f"trajectory.jsonl:{index}", event) for index, event in enumerate(events, 1))

    run_id = manifest.get("run_id")
    for label, document in documents:
        if isinstance(document, dict) and document.get("run_id") not in (None, run_id):
            messages.append(f"ERROR: {label}: run_id does not match manifest")

    seen_event_ids: set[str] = set()
    seen_turn_ids: set[str] = set()
    ended_turn_ids: set[str] = set()
    seen_step_ids: set[str] = set()
    ended_step_ids: set[str] = set()
    step_to_turn: dict[str, str] = {}
    span_to_step: dict[str, str] = {}
    for expected_seq, event in enumerate(events, 1):
        if event.get("seq") != expected_seq:
            messages.append(
                f"ERROR: trajectory.jsonl:{expected_seq}: expected seq {expected_seq}, got {event.get('seq')!r}"
            )
        event_id = event.get("event_id")
        if not isinstance(event_id, str):
            messages.append(f"ERROR: trajectory.jsonl:{expected_seq}: missing event_id")
        elif event_id in seen_event_ids:
            messages.append(f"ERROR: trajectory.jsonl:{expected_seq}: duplicate event_id {event_id}")
        else:
            parent = event.get("parent_event_id")
            if parent is not None and parent not in seen_event_ids:
                messages.append(
                    f"ERROR: trajectory.jsonl:{expected_seq}: parent_event_id {parent!r} is not an earlier event"
                )
            seen_event_ids.add(event_id)

        event_type = event.get("type")
        turn_id = event.get("turn_id")
        step_id = event.get("step_id")
        if step_id is not None and turn_id is None:
            messages.append(f"ERROR: trajectory.jsonl:{expected_seq}: step_id requires turn_id")
        if event_type == "turn.started" and isinstance(turn_id, str):
            if turn_id in seen_turn_ids:
                messages.append(f"ERROR: trajectory.jsonl:{expected_seq}: duplicate turn.started for {turn_id}")
            seen_turn_ids.add(turn_id)
        elif isinstance(turn_id, str) and turn_id not in seen_turn_ids:
            messages.append(f"ERROR: trajectory.jsonl:{expected_seq}: event precedes turn.started for {turn_id}")
        if event_type == "turn.ended" and isinstance(turn_id, str):
            if turn_id in ended_turn_ids:
                messages.append(f"ERROR: trajectory.jsonl:{expected_seq}: duplicate turn.ended for {turn_id}")
            ended_turn_ids.add(turn_id)

        if event_type == "step.started" and isinstance(step_id, str) and isinstance(turn_id, str):
            if step_id in seen_step_ids:
                messages.append(f"ERROR: trajectory.jsonl:{expected_seq}: duplicate step.started for {step_id}")
            seen_step_ids.add(step_id)
            step_to_turn[step_id] = turn_id
        elif isinstance(step_id, str) and step_id not in seen_step_ids:
            messages.append(f"ERROR: trajectory.jsonl:{expected_seq}: event precedes step.started for {step_id}")
        if isinstance(step_id, str) and isinstance(turn_id, str) and step_to_turn.get(step_id, turn_id) != turn_id:
            messages.append(f"ERROR: trajectory.jsonl:{expected_seq}: step {step_id} appears in multiple turns")
        if event_type == "step.ended" and isinstance(step_id, str):
            if step_id in ended_step_ids:
                messages.append(f"ERROR: trajectory.jsonl:{expected_seq}: duplicate step.ended for {step_id}")
            ended_step_ids.add(step_id)

        span_id = event.get("span_id")
        if isinstance(span_id, str) and isinstance(step_id, str):
            previous_step = span_to_step.setdefault(span_id, step_id)
            if previous_step != step_id:
                messages.append(f"ERROR: trajectory.jsonl:{expected_seq}: span {span_id} crosses logical steps")

    for turn_id in sorted(seen_turn_ids - ended_turn_ids):
        messages.append(f"WARNING: turn has no turn.ended event: {turn_id}")
    for step_id in sorted(seen_step_ids - ended_step_ids):
        messages.append(f"WARNING: step has no step.ended event: {step_id}")

    case_turns = {item.get("case_turn_id"): item for item in case.get("turns", [])}
    expected_steps: dict[str, str] = {}
    path_ids: set[str] = set()
    assertion_ids: set[str] = set()
    for case_turn_id, case_turn in case_turns.items():
        for item in case_turn.get("expected_steps", []):
            expected_step_id = item.get("expected_step_id")
            if expected_step_id in expected_steps:
                messages.append(f"ERROR: duplicate expected_step_id in case: {expected_step_id}")
            expected_steps[expected_step_id] = case_turn_id
        turn_expected_ids = {item.get("expected_step_id") for item in case_turn.get("expected_steps", [])}
        for path in case_turn.get("acceptable_paths", []):
            path_id = path.get("path_id")
            if path_id in path_ids:
                messages.append(f"ERROR: duplicate path_id in case: {path_id}")
            path_ids.add(path_id)
            for ref in path.get("ordered_expected_step_ids", []):
                if ref not in turn_expected_ids:
                    messages.append(f"ERROR: path {path_id} references unknown expected step: {ref}")
        for assertion in case_turn.get("assertions", []):
            assertion_id = assertion.get("assertion_id")
            if assertion_id in assertion_ids:
                messages.append(f"ERROR: duplicate assertion_id in case: {assertion_id}")
            assertion_ids.add(assertion_id)
    for assertion in case.get("run_assertions", []):
        assertion_id = assertion.get("assertion_id")
        if assertion_id in assertion_ids:
            messages.append(f"ERROR: duplicate assertion_id in case: {assertion_id}")
        assertion_ids.add(assertion_id)

    observation_ids = {item.get("observation_id") for item in case.get("observation_plan", [])}
    root_ids = {item.get("root_id") for item in case.get("monitored_resources", {}).get("filesystem_roots", [])}
    required_roots = {
        item.get("root_id")
        for item in case.get("monitored_resources", {}).get("filesystem_roots", [])
        if item.get("required") is True
    }
    bound_roots = {item.get("root_id") for item in config.get("capture", {}).get("root_bindings", [])}
    for root_id in sorted(bound_roots - root_ids):
        messages.append(f"ERROR: config binds filesystem root not whitelisted by case: {root_id}")
    for root_id in sorted(required_roots - bound_roots):
        messages.append(f"ERROR: required case filesystem root has no config binding: {root_id}")

    for line_number, event in enumerate(events, 1):
        case_turn_id = event.get("case_turn_id")
        if case_turn_id is not None and case_turn_id not in case_turns:
            messages.append(f"ERROR: trajectory.jsonl:{line_number}: unknown case_turn_id {case_turn_id}")
        expected_step_id = event.get("expected_step_id")
        if expected_step_id is not None:
            if expected_step_id not in expected_steps:
                messages.append(f"ERROR: trajectory.jsonl:{line_number}: unknown expected_step_id {expected_step_id}")
            elif case_turn_id != expected_steps[expected_step_id]:
                messages.append(f"ERROR: trajectory.jsonl:{line_number}: expected step belongs to a different case turn")
        observation_id = event.get("observation_id")
        if observation_id is not None and observation_id not in observation_ids:
            messages.append(f"ERROR: trajectory.jsonl:{line_number}: unknown observation_id {observation_id}")

    for label, document in documents:
        if not label.startswith("evaluations/"):
            continue
        for verdict in document.get("verdicts", []):
            if verdict.get("assertion_id") not in assertion_ids:
                messages.append(f"ERROR: {label}: verdict references unknown assertion {verdict.get('assertion_id')}")
            if verdict.get("path_id") is not None and verdict.get("path_id") not in path_ids:
                messages.append(f"ERROR: {label}: verdict references unknown path {verdict.get('path_id')}")

    manifest_paths: set[str] = set()
    for entry in manifest.get("files", []):
        relative_text = entry.get("path")
        if not isinstance(relative_text, str):
            messages.append("ERROR: manifest file entry has no path")
            continue
        manifest_paths.add(relative_text)
        path = (run_dir / relative_text).resolve()
        try:
            path.relative_to(run_dir.resolve())
        except ValueError:
            messages.append(f"ERROR: manifest path escapes run directory: {relative_text}")
            continue
        if not path.is_file():
            messages.append(f"ERROR: manifest file is missing: {relative_text}")
            continue
        if isinstance(entry.get("size_bytes"), int) and path.stat().st_size != entry["size_bytes"]:
            messages.append(f"ERROR: size mismatch: {relative_text}")
        if isinstance(entry.get("sha256"), str) and sha256_file(path) != entry["sha256"].lower():
            messages.append(f"ERROR: SHA-256 mismatch: {relative_text}")

    artifact_ids_checked: set[str] = set()
    for label, document in documents:
        for ref in iter_artifact_refs(document):
            artifact_id = ref["artifact_id"]
            if artifact_id in artifact_ids_checked or not artifact_id.startswith("sha256:"):
                continue
            artifact_ids_checked.add(artifact_id)
            digest = artifact_id.split(":", 1)[1].lower()
            default_relative = f"artifacts/sha256/{digest[:2]}/{digest}"
            relative_text = ref.get("relative_path", default_relative)
            path = run_dir / relative_text
            if not path.is_file():
                messages.append(f"ERROR: {label}: referenced artifact missing: {relative_text}")
            elif sha256_file(path) != digest:
                messages.append(f"ERROR: {label}: artifact hash mismatch: {relative_text}")

    if manifest.get("status") == "completed":
        actual_paths = {
            str(path.relative_to(run_dir)).replace("\\", "/")
            for path in run_dir.rglob("*")
            if path.is_file() and path.name != "manifest.json"
        }
        for missing in sorted(actual_paths - manifest_paths):
            messages.append(f"WARNING: completed package has unlisted file: {missing}")

    if schema_path is not None:
        messages.extend(validate_schema(documents, schema_path))
    return messages


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate an AETF v0.1 run package")
    parser.add_argument("run_dir", type=Path)
    default_schema = Path(__file__).resolve().parent.parent / "spec" / "agent-eval-trace.schema.json"
    parser.add_argument("--schema", type=Path, default=default_schema)
    parser.add_argument("--no-schema", action="store_true", help="Skip optional jsonschema validation")
    args = parser.parse_args()

    try:
        messages = validate_run(args.run_dir.resolve(), None if args.no_schema else args.schema.resolve())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    for message in messages:
        print(message)
    errors = sum(message.startswith("ERROR") for message in messages)
    warnings = sum(message.startswith("WARNING") for message in messages)
    infos = sum(message.startswith("INFO") for message in messages)
    print(f"Checked {args.run_dir}: {errors} error(s), {warnings} warning(s), {infos} info message(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
