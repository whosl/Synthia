"""SE-PR6 unit tests: eval-set loader, eval_runs CRUD, enqueue stub, CLI."""

from __future__ import annotations

import json
import textwrap
import uuid
from pathlib import Path

import pytest
from typer.testing import CliRunner

from edagent_vivado.cli import app as cli_app
from edagent_vivado.evolution import (
    EvalSetError,
    discover_eval_sets,
    enqueue_eval_run,
    eval_run_create,
    eval_run_get,
    eval_run_list,
    get_eval_set,
    get_eval_set_dto,
    list_eval_sets_dto,
    load_eval_set,
)
from edagent_vivado.repository.db import init_db


def _runner() -> CliRunner:
    return CliRunner()


# ── loader / discovery ----------------------------------------------------


def _write(tmp_path: Path, name: str, body: str) -> Path:
    p = tmp_path / name
    p.write_text(textwrap.dedent(body), encoding="utf-8")
    return p


def test_load_minimal_yaml(tmp_path: Path):
    _write(tmp_path, "smoke.yaml", """
        name: smoke
        cases:
          - id: alpha
            question: What is WNS?
    """)
    es = load_eval_set(tmp_path / "smoke.yaml")
    assert es.name == "smoke"
    assert len(es.cases) == 1
    assert es.cases[0].id == "alpha"


def test_load_rejects_missing_name(tmp_path: Path):
    _write(tmp_path, "broken.yaml", """
        cases:
          - id: a
            question: q
    """)
    with pytest.raises(EvalSetError):
        load_eval_set(tmp_path / "broken.yaml")


def test_load_rejects_mismatched_filename(tmp_path: Path):
    _write(tmp_path, "smoke.yaml", """
        name: not_smoke
        cases:
          - id: a
            question: q
    """)
    with pytest.raises(EvalSetError):
        load_eval_set(tmp_path / "smoke.yaml")


def test_load_rejects_duplicate_case_ids(tmp_path: Path):
    _write(tmp_path, "dup.yaml", """
        name: dup
        cases:
          - id: same
            question: a
          - id: same
            question: b
    """)
    with pytest.raises(EvalSetError):
        load_eval_set(tmp_path / "dup.yaml")


def test_load_rejects_empty_cases(tmp_path: Path):
    _write(tmp_path, "empty.yaml", """
        name: empty
        cases: []
    """)
    with pytest.raises(EvalSetError):
        load_eval_set(tmp_path / "empty.yaml")


def test_discover_skips_invalid_files(tmp_path: Path):
    _write(tmp_path, "good.yaml", """
        name: good
        cases:
          - id: a
            question: q
    """)
    _write(tmp_path, "bad.yaml", "not even close to yaml mapping ::: : :")
    found = discover_eval_sets(root=tmp_path)
    names = [s.name for s in found]
    assert "good" in names
    assert "bad" not in names


def test_get_eval_set_resolves_by_name(tmp_path: Path):
    _write(tmp_path, "smoke.yaml", """
        name: smoke
        cases:
          - id: alpha
            question: q
    """)
    es = get_eval_set("smoke", root=tmp_path)
    assert es.name == "smoke"


def test_repo_eval_sets_load_cleanly():
    """Sanity: the YAML fixtures we ship parse without errors."""
    sets = discover_eval_sets()
    names = {s.name for s in sets}
    assert "smoke" in names
    assert "vivado_synth" in names
    smoke = next(s for s in sets if s.name == "smoke")
    assert len(smoke.cases) >= 2
    for case in smoke.cases:
        assert case.question.strip()


# ── eval_runs CRUD --------------------------------------------------------


def test_eval_run_create_and_list_round_trip():
    init_db()
    row = eval_run_create(eval_set="smoke", project_id="prj-X", total_cases=3)
    assert row["state"] == "placeholder"
    fetched = eval_run_get(row["id"])
    assert fetched and fetched["id"] == row["id"]
    listed = eval_run_list(eval_set="smoke", limit=5)
    assert any(r["id"] == row["id"] for r in listed)


def test_eval_run_create_rejects_unknown_state():
    init_db()
    with pytest.raises(ValueError):
        eval_run_create(eval_set="smoke", state="bogus")


def test_eval_run_state_filter():
    init_db()
    eval_run_create(eval_set="smoke", state="placeholder")
    eval_run_create(eval_set="smoke", state="queued")
    placeholders = eval_run_list(eval_set="smoke", state="placeholder", limit=50)
    assert all(r["state"] == "placeholder" for r in placeholders)


def test_enqueue_eval_run_writes_metadata_and_emits_event():
    init_db()
    events: list[dict] = []
    def sink(session_id, event_type, payload, **kwargs):
        events.append({"type": event_type, "payload": payload})

    row = enqueue_eval_run(
        "smoke",
        project_id="prj-A",
        note="manual run",
        event_sink=sink,
    )
    assert row["state"] == "placeholder"
    assert row["runner_implemented"] is False

    fetched = eval_run_get(row["id"])
    assert fetched
    meta = fetched.get("metadata") or {}
    assert meta.get("note") == "manual run"
    assert meta.get("spec_section") == "22.6B"
    assert isinstance(meta.get("case_ids"), list)
    assert len(meta["case_ids"]) >= 2

    types = [e["type"] for e in events]
    assert "evolution.eval.queued" in types
    payload = next(e["payload"] for e in events if e["type"] == "evolution.eval.queued")
    assert payload["runner_implemented"] is False
    assert payload["eval_set"] == "smoke"


def test_enqueue_eval_run_unknown_set_raises():
    init_db()
    with pytest.raises(EvalSetError):
        enqueue_eval_run("does-not-exist")


# ── CLI -------------------------------------------------------------------


def test_cli_eval_no_args_lists_sets():
    init_db()
    result = _runner().invoke(cli_app, ["eval"])
    assert result.exit_code == 0, result.output
    assert "Available eval sets" in result.output
    assert "smoke" in result.output


def test_cli_eval_show_cases():
    result = _runner().invoke(cli_app, ["eval", "smoke", "--show-cases"])
    assert result.exit_code == 0, result.output
    assert "parse-synth-log" in result.output


def test_cli_eval_queue_smoke():
    init_db()
    result = _runner().invoke(cli_app, ["eval", "smoke", "--note", "cli-test"])
    assert result.exit_code == 0, result.output
    assert "Queued" in result.output
    assert "placeholder" in result.output
    listed = eval_run_list(eval_set="smoke", limit=5)
    assert any((r.get("metadata") or {}).get("note") == "cli-test" for r in listed)


def test_cli_eval_unknown_set_exits_nonzero():
    result = _runner().invoke(cli_app, ["eval", "nope-not-here"])
    assert result.exit_code == 1
    assert "Eval set error" in result.output


# ── DTO sanity ------------------------------------------------------------


def test_list_eval_sets_dto_shape():
    sets = list_eval_sets_dto()
    assert isinstance(sets, list)
    if sets:
        assert {"name", "description", "case_count", "path"}.issubset(sets[0].keys())


def test_get_eval_set_dto_includes_cases():
    dto = get_eval_set_dto("smoke")
    assert dto["case_count"] >= 2
    case_ids = [c["id"] for c in dto["cases"]]
    assert "parse-synth-log" in case_ids
