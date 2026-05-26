"""Parsed report trends API."""

import importlib
import json

import pytest

from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "trend.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def test_parsed_report_trends(store):
    run = store.run_create("task", "t1", session_id="sess1")
    store.parsed_report_create(
        run["id"],
        "vivado",
        "timing_summary",
        "post_route",
        {"wns": -0.5, "tns": -1.0},
    )
    store.parsed_report_create(
        run["id"],
        "vivado",
        "timing_summary",
        "post_route",
        {"wns": 0.1, "tns": 0.0},
    )
    points = store.parsed_report_trends("timing_summary", session_id="sess1", metric="wns")
    assert len(points) == 2
    assert points[0]["value"] == -0.5
    assert points[1]["value"] == 0.1
