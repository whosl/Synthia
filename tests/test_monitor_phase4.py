"""Phase 4: monitor overview and retention cleanup."""

from __future__ import annotations

import importlib
import time

from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


def _fresh_store(tmp_path, monkeypatch, name: str):
    db_path = tmp_path / name
    monkeypatch.setenv("EDAGENT_DB_PATH", str(db_path))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def test_monitor_overview_empty(tmp_path, monkeypatch):
    store = _fresh_store(tmp_path, monkeypatch, "test.db")
    overview = store.monitor_overview(days=7)
    assert overview["days"] == 7
    assert overview["run_count"] == 0
    assert overview["tool_calls"]["total"] == 0
    assert overview["token_series"] == []


def test_monitor_overview_aggregates(tmp_path, monkeypatch):
    store = _fresh_store(tmp_path, monkeypatch, "test2.db")
    sess = store.session_create(name="m")
    run = store.run_create("task", "t1", session_id=sess["id"])
    store.toolcall_create(run["id"], "vivado_run", session_id=sess["id"])
    tc = store.toolcall_create(run["id"], "bad_tool", session_id=sess["id"])
    store.toolcall_update(tc["id"], state="error", error="boom")
    store.usage_create(
        run["id"], "glm-test", session_id=sess["id"],
        input_tokens=100, output_tokens=50, total_tokens=150,
    )
    overview = store.monitor_overview(days=14)
    assert overview["run_count"] >= 1
    assert overview["tool_calls"]["total"] >= 2
    assert overview["tool_calls"]["errors"] >= 1
    assert overview["usage_totals"]["input_tokens"] >= 100
    assert len(overview["by_model"]) >= 1


def test_monitor_retention_cleanup_dry_run(tmp_path, monkeypatch):
    store = _fresh_store(tmp_path, monkeypatch, "test3.db")
    db = db_mod.get_db()
    old = int(time.time()) - 200 * 86400
    db.execute(
        "INSERT INTO events(id,session_id,seq,event_type,created_at,payload_json,visibility) VALUES(?,?,?,?,?,?,?)",
        ("e1", "s1", 1, "test.old", old, "{}", "public"),
    )
    db.commit()
    result = store.monitor_retention_cleanup(retention_days=90, dry_run=True)
    assert result["dry_run"] is True
    assert result["deleted"]["events"] >= 1
    row = db.execute("SELECT COUNT(*) AS c FROM events WHERE id='e1'").fetchone()
    assert int(row["c"]) == 1
