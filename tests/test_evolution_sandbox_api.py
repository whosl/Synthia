"""SE-PR8 API smoke: /evolution/tools/validate + tool-surface approve gate."""

from __future__ import annotations

import textwrap
import uuid

from fastapi.testclient import TestClient

from edagent_vivado.evolution import candidate_create
from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import project_create
from edagent_vivado.web.app import create_app


def _client() -> TestClient:
    init_db()
    return TestClient(create_app())


def _make_project() -> dict:
    return project_create(
        {
            "name": f"api-pr8-{uuid.uuid4().hex[:6]}",
            "status": "active",
            "root_path": ".",
            "manifest_path": "eda.yaml",
            "xpr_path": "",
            "part": "xc7a35t",
        }
    )


SAFE_SRC = textwrap.dedent("""
    from langchain_core.tools import tool

    @tool
    def summarise(text: str) -> str:
        \"\"\"Tiny summariser.\"\"\"
        return " ".join((text or "").split())[:200]
""").strip()

BAD_SRC = textwrap.dedent("""
    from langchain_core.tools import tool
    import os

    @tool
    def danger(x: str) -> str:
        return os.popen(x).read()
""").strip()


# ── validate endpoint ────────────────────────────────────


def test_validate_endpoint_accepts_safe_source():
    client = _client()
    resp = client.post(
        "/api/v1/evolution/tools/validate",
        json={"source": SAFE_SRC},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["tool_name"] == "summarise"
    assert "hash" in body


def test_validate_endpoint_rejects_dangerous_source_with_structured_reason():
    client = _client()
    resp = client.post(
        "/api/v1/evolution/tools/validate",
        json={"source": BAD_SRC},
    )
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert detail["ok"] is False
    assert "reason" in detail
    assert detail["reason"] in {"ast_whitelist", "import_denied"}


def test_validate_endpoint_name_mismatch():
    client = _client()
    resp = client.post(
        "/api/v1/evolution/tools/validate",
        json={"source": SAFE_SRC, "name": "wrong_name"},
    )
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert detail["reason"] == "name_mismatch"


# ── approve gate -----------------------------------------


def _tool_candidate(pid: str, payload: dict) -> dict:
    return candidate_create(
        surface="tool",
        title="evolved",
        rationale="r",
        project_id=pid,
        signal_source={
            "signal": "manual",
            "signal_key": f"manual-{uuid.uuid4().hex[:6]}",
            "suggested_payload": payload,
        },
        created_by="test",
    )


def test_approve_tool_without_confirm_returns_403():
    client = _client()
    pid = _make_project()
    cand = _tool_candidate(pid["id"], {
        "additional_tools": [{"name": "summarise", "source": SAFE_SRC}],
    })
    resp = client.post(
        f"/api/v1/evolution/candidates/{cand['id']}/approve",
        json={},
    )
    assert resp.status_code == 403


def test_approve_tool_with_confirm_succeeds():
    client = _client()
    pid = _make_project()
    cand = _tool_candidate(pid["id"], {
        "additional_tools": [{"name": "summarise", "source": SAFE_SRC}],
    })
    resp = client.post(
        f"/api/v1/evolution/candidates/{cand['id']}/approve",
        json={"confirm_source_reviewed": True},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["candidate"]["status"] == "approved"
    assert body["overlay_id"]


def test_approve_tool_with_unsafe_source_returns_400_even_with_confirm():
    client = _client()
    pid = _make_project()
    cand = _tool_candidate(pid["id"], {
        "additional_tools": [{"name": "danger", "source": BAD_SRC}],
    })
    resp = client.post(
        f"/api/v1/evolution/candidates/{cand['id']}/approve",
        json={"confirm_source_reviewed": True},
    )
    assert resp.status_code == 400


def test_approve_tool_via_payload_override():
    client = _client()
    pid = _make_project()
    cand = _tool_candidate(pid["id"], {})
    resp = client.post(
        f"/api/v1/evolution/candidates/{cand['id']}/approve",
        json={
            "confirm_source_reviewed": True,
            "payload": {
                "disabled": [],
                "additional_tools": [{"name": "summarise", "source": SAFE_SRC}],
            },
        },
    )
    assert resp.status_code == 200, resp.text
