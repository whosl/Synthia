"""Phase 10 — benchmark REST API."""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient

from edagent_vivado.repository import db as db_mod
from edagent_vivado.web.app import create_app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("VIVADO_REMOTE_HOST", raising=False)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "bench_api.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    monkeypatch.setenv("SYNTHIA_AUTH_TEST_MODE", "1")
    importlib.reload(db_mod)
    db_mod.close_db()
    db_mod.init_db()
    return TestClient(create_app())


def test_create_and_get_suite(client):
    r = client.post(
        "/api/v1/benchmarks",
        json={
            "name": "api-suite",
            "project_id": "proj-1",
            "cases": [
                {
                    "name": "case-a",
                    "flow_name": "vivado_synth_only",
                    "inputs": {},
                }
            ],
        },
    )
    assert r.status_code == 200
    suite = r.json()
    assert suite["name"] == "api-suite"
    assert len(suite["cases"]) == 1

    r2 = client.get(f"/api/v1/benchmarks/{suite['id']}")
    assert r2.status_code == 200
    assert r2.json()["cases"][0]["name"] == "case-a"


def test_list_suites(client):
    client.post(
        "/api/v1/benchmarks",
        json={"name": "s1", "project_id": "p1", "cases": []},
    )
    r = client.get("/api/v1/benchmarks")
    assert r.status_code == 200
    assert len(r.json()["suites"]) >= 1
