"""Phase 5 — reports REST API: project trend, summary.md, artifacts zip."""

from __future__ import annotations

import importlib
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod
from edagent_vivado.web.app import create_app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("VIVADO_REMOTE_HOST", raising=False)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "p5_api.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return TestClient(create_app())


def _seed(tmp_path):
    db = db_mod.get_db()
    db.execute(
        "INSERT OR IGNORE INTO projects(id,name,status,root_path,manifest_path,xpr_path,part,created_at,updated_at,metadata_json) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        ("projX", "projX", "active", ".", "eda.yaml", "", "x", 1, 1, "{}"),
    )
    db.commit()
    run = store_mod.run_create("vivado_synth_only", name="rA", session_id="s1")
    store_mod.run_update(run["id"], state="succeeded", started_at=10, finished_at=11)
    db.execute("UPDATE runs SET project_id=? WHERE id=?", ("projX", run["id"]))
    db.commit()

    store_mod.parsed_report_create(
        run["id"], "vivado", "timing_summary", "impl",
        {"wns": 0.1, "tns": 0.0, "whs": 0.05, "ths": 0.0},
        metrics={"wns_ns": 0.1, "tns_ns": 0.0, "whs_ns": 0.05, "ths_ns": 0.0},
    )
    store_mod.parsed_report_create(
        run["id"], "vivado", "utilization", "impl",
        {"lut": 100, "lut_pct": 12.5},
        metrics={"lut_pct": 12.5, "ff_pct": 5.0},
    )
    store_mod.parsed_report_create(
        run["id"], "vivado", "drc", "impl",
        {"errors": [], "warnings": [], "clean": True, "by_category": {}},
        metrics={"error_count": 0, "warning_count": 0, "clean": True},
    )
    store_mod.parsed_report_create(
        run["id"], "vivado", "impl_summary", "impl",
        {"ok": True, "issues": []},
        metrics={"ok": True, "issue_count": 0},
    )

    art_file = tmp_path / "top.bit"
    art_file.write_bytes(b"BITSTREAM-CONTENT")
    store_mod.artifact_create(
        artifact_type="bitstream",
        path=str(art_file),
        run_id=run["id"],
        size_bytes=art_file.stat().st_size,
        sha256="0" * 64,
    )
    rpt_file = tmp_path / "rep.rpt"
    rpt_file.write_text("hi", encoding="utf-8")
    store_mod.artifact_create(
        artifact_type="report",
        path=str(rpt_file),
        run_id=run["id"],
    )
    return run["id"]


def test_project_trend_returns_series(client, tmp_path):
    run_id = _seed(tmp_path)
    resp = client.get("/api/v1/projects/projX/trend?limit=5")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["project_id"] == "projX"
    assert len(body["series"]) == 1
    metrics = body["series"][0]["metrics"]
    assert metrics["wns_ns"] == 0.1
    assert metrics["lut_pct"] == 12.5
    assert metrics["impl_ok"] is True
    assert body["series"][0]["run_id"] == run_id


def test_project_trend_404_for_unknown_project(client):
    resp = client.get("/api/v1/projects/nope/trend")
    assert resp.status_code == 404


def test_run_summary_md_returns_markdown(client, tmp_path):
    run_id = _seed(tmp_path)
    resp = client.get(f"/api/v1/runs/{run_id}/summary.md")
    assert resp.status_code == 200
    assert "text/markdown" in resp.headers.get("content-type", "")
    text = resp.text
    assert "# Run Summary" in text
    assert "timing_summary" in text
    assert "impl_summary" in text


def test_run_artifacts_zip_streams_files(client, tmp_path):
    run_id = _seed(tmp_path)
    resp = client.get(f"/api/v1/runs/{run_id}/artifacts/zip")
    assert resp.status_code == 200
    assert resp.headers.get("content-type") == "application/zip"
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = zf.namelist()
    assert "top.bit" in names
    assert "rep.rpt" in names


def test_run_artifacts_zip_404_when_empty(client):
    db = db_mod.get_db()
    db.execute("INSERT OR IGNORE INTO projects(id,name,status,root_path,manifest_path,xpr_path,part,created_at,updated_at,metadata_json) "
               "VALUES('projE','projE','active','.','eda.yaml','','x',1,1,'{}')")
    db.commit()
    run = store_mod.run_create("vivado_synth_only", name="empty", session_id="s1")
    resp = client.get(f"/api/v1/runs/{run['id']}/artifacts/zip")
    assert resp.status_code == 404
