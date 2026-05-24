import json

import pytest

from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import (
    _project_snapshot_row,
    project_create,
    session_create,
    session_delete,
    session_get,
    session_list,
)
from edagent_vivado.projects.lifecycle import project_hard_delete, project_summary
from edagent_vivado.repository.project_scope import backfill_project_ids, migrate_project_id_columns


@pytest.fixture(autouse=True)
def _db():
    init_db()
    yield


def test_project_id_backfill_on_tasks():
    db = get_db()
    migrate_project_id_columns(db)
    p = project_create({
        "name": "t-proj",
        "root_path": ".",
        "manifest_path": "eda.yaml",
        "xpr_path": "",
        "part": "xc7",
    })
    s = session_create(name="s1", project_id=p["id"])
    db.execute(
        "INSERT INTO tasks(id,session_id,state,started_at,updated_at) VALUES(?,?,?,?,?)",
        ("tasklegacy", s["id"], "created", 1, 1),
    )
    db.commit()
    stats = backfill_project_ids(db)
    row = db.execute("SELECT project_id FROM tasks WHERE id=?", ("tasklegacy",)).fetchone()
    assert row["project_id"] == p["id"]
    assert stats.get("tasks", 0) >= 1


def test_project_hard_delete_cascades_sessions():
    p = project_create({
        "name": "del-me",
        "root_path": ".",
        "manifest_path": "eda.yaml",
        "xpr_path": "",
        "part": "xc7",
    })
    s = session_create(name="gone", project_id=p["id"])
    sid = s["id"]
    out = project_hard_delete(p["id"])
    assert out["sessions_removed"] == 1
    assert session_get(sid) is None
    assert get_db().execute("SELECT id FROM projects WHERE id=?", (p["id"],)).fetchone() is None


def test_project_snapshot_includes_globs_and_mappings():
    p = project_create({
        "name": "snap",
        "root_path": ".",
        "manifest_path": "eda.yaml",
        "xpr_path": "",
        "part": "xc7",
        "target_language": "Verilog",
        "simulator": "xsim",
        "source_globs": ["rtl/**/*.v"],
        "constraint_globs": ["constraints/**/*.xdc"],
        "tcl_globs": ["scripts/**/*.tcl"],
        "default_vivado_target_id": "tgt-1",
    })
    s = session_create(name="snap-s", project_id=p["id"])
    snap = json.loads(s["project_snapshot_json"])
    assert snap["target_language"] == "Verilog"
    assert snap["source_globs"] == ["rtl/**/*.v"]
    assert snap["default_vivado_target_id"] == "tgt-1"
    assert "path_mappings" in snap
    row = _project_snapshot_row(p)
    assert row["tcl_globs"] == ["scripts/**/*.tcl"]


def test_session_list_include_archived():
    p = project_create({
        "name": "arch-list",
        "root_path": ".",
        "manifest_path": "eda.yaml",
        "xpr_path": "",
        "part": "xc7",
    })
    s = session_create(name="to-archive", project_id=p["id"])
    session_delete(s["id"], hard=False)
    active = session_list(project_id=p["id"], include_archived=False)
    all_rows = session_list(project_id=p["id"], include_archived=True)
    assert len(active) == 0
    assert any(r["id"] == s["id"] for r in all_rows)


def test_project_summary_shape():
    p = project_create({
        "name": "sum",
        "root_path": ".",
        "manifest_path": "eda.yaml",
        "xpr_path": "",
        "part": "xc7",
    })
    summary = project_summary(p["id"])
    assert summary["project"]["id"] == p["id"]
    assert "kb" in summary
    assert "vivado_health" in summary
