"""Phase 7 — patch service + API persistence."""

from __future__ import annotations

import importlib

import pytest

from edagent_vivado.patches.service import approve_and_apply, propose_patch, reject_patch
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


@pytest.fixture
def store_db(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "p7.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.close_db()
    db_mod.init_db()
    yield store_mod
    db_mod.close_db()


def test_propose_tcl_auto_apply(store_db, tmp_path):
    proj = store_db.project_create({
        "name": "p7",
        "root_path": str(tmp_path),
        "manifest_path": "eda.yaml",
    })
    sess = store_db.session_create(project_id=proj["id"])
    tcl = tmp_path / "scripts" / "run.tcl"
    tcl.parent.mkdir(parents=True, exist_ok=True)
    tcl.write_text("puts hello\n", encoding="utf-8")
    before = tcl.read_text(encoding="utf-8")
    after = "puts world\n"

    result = propose_patch(
        session_id=sess["id"],
        project_id=proj["id"],
        title="tcl tweak",
        rationale="test auto",
        changes=[
            {
                "path": "scripts/run.tcl",
                "action": "modify",
                "before_text": before,
                "after_text": after,
            }
        ],
    )
    patch = result["patch"]
    assert patch["state"] == "applied" or patch.get("status") == "applied"
    assert "puts world" in tcl.read_text(encoding="utf-8")


def test_propose_rtl_requires_manual_approve(store_db, tmp_path):
    proj = store_db.project_create({
        "name": "p7b",
        "root_path": str(tmp_path),
        "manifest_path": "eda.yaml",
    })
    sess = store_db.session_create(project_id=proj["id"])
    v = tmp_path / "rtl" / "top.v"
    v.parent.mkdir(parents=True, exist_ok=True)
    v.write_text("wire a;\n", encoding="utf-8")
    before = v.read_text(encoding="utf-8")
    after = "wire b;\n"

    result = propose_patch(
        session_id=sess["id"],
        project_id=proj["id"],
        title="rtl fix",
        rationale="needs review",
        changes=[
            {
                "path": "rtl/top.v",
                "action": "modify",
                "before_text": before,
                "after_text": after,
            }
        ],
    )
    patch = result["patch"]
    assert patch["state"] == "proposed"
    pid = patch["id"]

    applied = approve_and_apply(pid, reviewer_id="tester", reason="looks good")
    assert applied["apply_result"]["success"]
    assert "wire b" in v.read_text(encoding="utf-8")

    audits = store_db.patch_audits_for(pid)
    assert any(a["action"] == "propose" for a in audits)
    assert any(a["action"] == "apply" for a in audits)


def test_reject_patch(store_db, tmp_path):
    proj = store_db.project_create({
        "name": "p7c",
        "root_path": str(tmp_path),
        "manifest_path": "eda.yaml",
    })
    sess = store_db.session_create(project_id=proj["id"])
    xdc = tmp_path / "top.xdc"
    xdc.write_text("set_property PACKAGE_PIN A10 [get_ports clk]\n", encoding="utf-8")

    before = xdc.read_text(encoding="utf-8")
    after = "set_property PACKAGE_PIN B10 [get_ports clk]\n"
    result = propose_patch(
        session_id=sess["id"],
        project_id=proj["id"],
        title="xdc",
        rationale="pin change",
        changes=[
            {
                "path": "top.xdc",
                "action": "modify",
                "before_text": before,
                "after_text": after,
            }
        ],
    )
    pid = result["patch"]["id"]
    out = reject_patch(pid, reviewer_id="user", reason="no")
    assert out["patch"]["state"] == "rejected"
