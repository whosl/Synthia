"""Phase 9 — diagnose log API."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from edagent_vivado.web.app import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    db = tmp_path / "test.db"
    monkeypatch.setenv("SYNTHIA_DB_PATH", str(db))
    monkeypatch.setenv("SYNTHIA_AUTH_TEST_MODE", "1")
    return TestClient(create_app())


def test_diagnose_log_inline(client):
    r = client.post(
        "/api/v1/diagnose/log",
        json={"log_text": "ERROR: [Synth 8-439] something failed\n"},
    )
    assert r.status_code == 200
    data = r.json()
    assert "error_count" in data
    assert "top_error_signatures" in data
    assert "summary" in data
