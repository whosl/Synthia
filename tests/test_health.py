"""Phase 11 — health endpoints."""

from __future__ import annotations

import importlib

from fastapi.testclient import TestClient

from edagent_vivado.web.app import create_app


def test_health_endpoints(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "h.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    monkeypatch.setenv("SYNTHIA_AUTH_TEST_MODE", "1")

    from edagent_vivado.repository import db as db_mod

    importlib.reload(db_mod)
    db_mod.close_db()

    client = TestClient(create_app())
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True

    r2 = client.get("/health/readiness")
    assert r2.status_code == 200

    r3 = client.get("/health/full")
    assert r3.status_code == 200
    assert "checks" in r3.json()
