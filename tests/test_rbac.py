"""Phase 8 — RBAC integration tests."""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient

from edagent_vivado.auth.identity import create_user
from edagent_vivado.auth.audit import list_audits
from edagent_vivado.web.app import create_app


@pytest.fixture()
def auth_client(enable_auth):
    return TestClient(create_app()), enable_auth


def _make_user(role: str) -> dict:
    return create_user(username=f"u_{role}_{role[:4]}", global_role=role)


def test_viewer_cannot_create_project(auth_client, tmp_path):
    client, admin_tok = auth_client
    viewer = _make_user("viewer")
    manifest = tmp_path / "eda.yaml"
    manifest.write_text("name: t\nproject:\n  flow: non_project\n", encoding="utf-8")
    r = client.post(
        "/api/v1/projects",
        headers={"Authorization": f"Bearer {viewer['api_token']}"},
        json={"name": "t", "root_path": str(tmp_path), "manifest_path": str(manifest)},
    )
    assert r.status_code == 403


def test_admin_can_list_users(auth_client):
    client, admin_tok = auth_client
    r = client.get("/api/v1/admin/users", headers={"Authorization": f"Bearer {admin_tok}"})
    assert r.status_code == 200


def test_audit_log_on_project_create(auth_client, tmp_path):
    client, admin_tok = auth_client
    manifest = tmp_path / "eda.yaml"
    manifest.write_text(
        "name: tx\nproject:\n  flow: non_project\n",
        encoding="utf-8",
    )
    r = client.post(
        "/api/v1/projects",
        headers={"Authorization": f"Bearer {admin_tok}"},
        json={
            "name": "tx",
            "root_path": str(tmp_path),
            "manifest_path": str(manifest),
            "part": "xc7a35tcpg236-1",
        },
    )
    assert r.status_code == 200, r.text
    logs = list_audits(action="project.create", limit=10)
    assert any(l["resource_type"] == "project" for l in logs)


def test_audit_denied_recorded(auth_client):
    client, _admin_tok = auth_client
    viewer = _make_user("viewer")
    client.post(
        "/api/v1/admin/users",
        headers={"Authorization": f"Bearer {viewer['api_token']}"},
        json={"username": "evil", "global_role": "admin"},
    )
    denies = list_audits(action="auth.denied", limit=20)
    assert len(denies) > 0


def test_me_endpoint(auth_client):
    client, admin_tok = auth_client
    r = client.get("/api/v1/me", headers={"Authorization": f"Bearer {admin_tok}"})
    assert r.status_code == 200
    assert r.json()["user"]["global_role"] == "admin"
