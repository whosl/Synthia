"""Phase 10 — benchmark suite store, export, metric extractor."""

from __future__ import annotations

import importlib

import pytest

from edagent_vivado.benchmarks.exporter import export_csv, export_markdown
from edagent_vivado.benchmarks.models import BenchmarkSuite, make_case
from edagent_vivado.benchmarks.suite_store import case_update, suite_create, suite_get
from edagent_vivado.repository import db as db_mod


@pytest.fixture()
def bench_db(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "bench.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    db_mod.close_db()
    db_mod.init_db()
    yield
    db_mod.close_db()


def test_suite_create_and_get(bench_db):
    s = BenchmarkSuite.new(name="test", project_id="p1")
    s.cases = [
        make_case(suite_id=s.id, name="c1", sequence=0, flow_name="vivado_synth_only", inputs={}),
        make_case(suite_id=s.id, name="c2", sequence=1, flow_name="vivado_synth_only", inputs={"strategy": "x"}),
    ]
    s.total_cases = 2
    suite_create(s)

    g = suite_get(s.id)
    assert g is not None
    assert g["name"] == "test"
    assert len(g["cases"]) == 2
    assert g["cases"][0]["name"] == "c1"


def test_case_metrics_update(bench_db):
    s = BenchmarkSuite.new(name="m", project_id="p1")
    s.cases = [make_case(suite_id=s.id, name="c", sequence=0, flow_name="x", inputs={})]
    s.total_cases = 1
    suite_create(s)
    cid = s.cases[0].id

    case_update(cid, state="success", metrics={"WNS": 1.234, "LUT": 1000})

    g = suite_get(s.id)
    assert g is not None
    c = g["cases"][0]
    assert c["state"] == "success"
    assert c["metrics"]["WNS"] == 1.234
    assert c["metrics"]["LUT"] == 1000


def test_export_csv(bench_db):
    s = BenchmarkSuite.new(name="csv-test", project_id="p1")
    s.cases = [make_case(suite_id=s.id, name="c1", sequence=0, flow_name="x", inputs={})]
    s.total_cases = 1
    suite_create(s)
    case_update(
        s.cases[0].id,
        state="success",
        metrics={"WNS": 1.5, "LUT": 100, "bitstream_exists": True},
    )

    csv = export_csv(s.id)
    assert "c1" in csv
    assert "1.5" in csv


def test_export_markdown(bench_db):
    s = BenchmarkSuite.new(name="md-test", project_id="p1")
    s.cases = [
        make_case(suite_id=s.id, name="ok", sequence=0, flow_name="x", inputs={}),
        make_case(suite_id=s.id, name="bad", sequence=1, flow_name="x", inputs={}),
    ]
    s.total_cases = 2
    suite_create(s)
    case_update(s.cases[0].id, state="success", metrics={"WNS": 1.0})
    case_update(
        s.cases[1].id,
        state="failed",
        error_category="timing_violation",
        error="WNS = -0.5",
        metrics={"WNS": -0.5},
    )

    md = export_markdown(s.id)
    assert "md-test" in md
    assert "ok" in md and "bad" in md
    assert "timing_violation" in md


def test_extract_metrics(bench_db, monkeypatch):
    from edagent_vivado.benchmarks.metric_extractor import extract_metrics

    def fake_reports(run_id, **kw):
        return [
            {"report_type": "timing", "data": {"WNS": 1.2, "TNS": -3.4}, "metrics": {}},
            {
                "report_type": "utilization",
                "data": {"summary": {"LUT": 500, "FF": 1000}},
                "metrics": {},
            },
            {"report_type": "bitstream", "data": {"exists": True, "size_bytes": 1024}, "metrics": {}},
        ]

    monkeypatch.setattr(
        "edagent_vivado.benchmarks.metric_extractor.parsed_report_list",
        fake_reports,
    )
    monkeypatch.setattr(
        "edagent_vivado.benchmarks.metric_extractor.artifact_list",
        lambda run_id="", **kw: [],
    )

    m = extract_metrics("r1")
    assert m["WNS"] == 1.2
    assert m["LUT"] == 500
    assert m["bitstream_exists"]
