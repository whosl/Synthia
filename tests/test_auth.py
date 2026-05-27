"""Phase 5.5(d) — explicit API token authentication coverage."""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient

from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod
from edagent_vivado.web import auth as auth_mod
from edagent_vivado.web.app import create_app


@pytest.fixture()
def _isolated_db(tmp_path, monkeypatch):
    monkeypatch.delenv("VIVADO_REMOTE_HOST", raising=False)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "auth.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()


# --- auth_enabled() unit-level behaviour -------------------------------------


def test_auth_enabled_default_is_true_in_production(monkeypatch):
    monkeypatch.delenv("SYNTHIA_AUTH_TEST_MODE", raising=False)
    monkeypatch.delenv("EDAGENT_DISABLE_API_AUTH", raising=False)
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    assert auth_mod.auth_enabled() is True


def test_auth_disabled_when_test_mode_env_set(monkeypatch):
    monkeypatch.setenv("SYNTHIA_AUTH_TEST_MODE", "1")
    assert auth_mod.auth_enabled() is False


def test_auth_disabled_when_production_kill_switch_set(monkeypatch):
    monkeypatch.delenv("SYNTHIA_AUTH_TEST_MODE", raising=False)
    monkeypatch.setenv("EDAGENT_DISABLE_API_AUTH", "true")
    assert auth_mod.auth_enabled() is False


def test_pytest_current_test_alone_does_not_disable_auth(monkeypatch):
    """Regression: the legacy PYTEST_CURRENT_TEST heuristic was removed."""
    monkeypatch.delenv("SYNTHIA_AUTH_TEST_MODE", raising=False)
    monkeypatch.delenv("EDAGENT_DISABLE_API_AUTH", raising=False)
    monkeypatch.setenv("PYTEST_CURRENT_TEST", "tests/test_auth.py::xyz")
    assert auth_mod.auth_enabled() is True


# --- public-path bypass list ------------------------------------------------


def test_is_public_path_health_and_assets():
    assert auth_mod.is_public_path("/api/health")
    assert auth_mod.is_public_path("/health")
    assert auth_mod.is_public_path("/assets/main.js")
    assert auth_mod.is_public_path("/")  # SPA shell
    assert not auth_mod.is_public_path("/api/runs")
    assert not auth_mod.is_public_path("/api/projects/x")


# --- end-to-end middleware tests --------------------------------------------


_PROTECTED_PATH = "/api/v1/runs"


def test_public_path_open_even_when_auth_required(enable_auth, _isolated_db):
    """SPA shell (``/``) is a public path and must bypass the token check."""
    client = TestClient(create_app())
    r = client.get("/")
    assert r.status_code == 200
    # ensure middleware did NOT swap a 401 in
    assert "invalid or missing token" not in r.text.lower()


def test_protected_endpoint_rejects_request_without_token(enable_auth, _isolated_db):
    client = TestClient(create_app())
    r = client.get(_PROTECTED_PATH)
    assert r.status_code == 401
    body = r.json()
    assert "invalid or missing token" in str(body).lower()


def test_protected_endpoint_accepts_bearer_token(enable_auth, _isolated_db):
    client = TestClient(create_app())
    r = client.get(
        _PROTECTED_PATH,
        headers={"Authorization": f"Bearer {enable_auth}"},
    )
    assert r.status_code == 200


def test_protected_endpoint_accepts_query_token(enable_auth, _isolated_db):
    client = TestClient(create_app())
    r = client.get(f"{_PROTECTED_PATH}?token={enable_auth}")
    assert r.status_code == 200


def test_protected_endpoint_rejects_wrong_token(enable_auth, _isolated_db):
    client = TestClient(create_app())
    r = client.get(
        _PROTECTED_PATH,
        headers={"Authorization": "Bearer not-the-real-token"},
    )
    assert r.status_code == 401


def test_test_mode_middleware_bypass(_isolated_db, monkeypatch):
    """Inside SYNTHIA_AUTH_TEST_MODE, the middleware lets everything through."""
    monkeypatch.setenv("SYNTHIA_AUTH_TEST_MODE", "1")
    auth_mod.reset_token_cache()
    client = TestClient(create_app())
    r = client.get(_PROTECTED_PATH)
    assert r.status_code == 200, r.text
