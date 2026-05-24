import json

import pytest

from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import project_create, session_create, session_get
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
