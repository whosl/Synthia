"""Shared pytest fixtures."""

from __future__ import annotations

import os

import pytest


@pytest.fixture(autouse=True)
def _reset_vivado_execution_approval():
    """Prevent phase-4 integration tests from leaking auto-approve into HITL tests."""
    yield
    from edagent_vivado.harness.execution_approval import set_vivado_execution_approval

    set_vivado_execution_approval(False)


@pytest.fixture(autouse=True)
def _synthia_auth_test_mode(monkeypatch):
    """Phase 5.5: tests run with the explicit SYNTHIA_AUTH_TEST_MODE flag.

    Previously, ``auth_enabled()`` silently bypassed auth whenever
    ``PYTEST_CURRENT_TEST`` was set; that masked auth bugs and meant CI never
    actually exercised the token middleware. We now make the bypass explicit
    so any test that wants to verify the middleware can opt out via the
    ``enable_auth`` fixture below.
    """
    monkeypatch.setenv("SYNTHIA_AUTH_TEST_MODE", "1")
    # also drop any cached token so subsequent enable_auth picks up a fresh one
    from edagent_vivado.web import auth as _auth

    _auth.reset_token_cache()
    yield
    _auth.reset_token_cache()


@pytest.fixture
def enable_auth(monkeypatch, tmp_path):
    """Opt-in fixture: run the token middleware as production would.

    Sets a deterministic token and points the on-disk token file at ``tmp_path``
    so we don't trample the user's real ``~/.synthia/token``.

    Yields the token string for the test to use.
    """
    monkeypatch.delenv("SYNTHIA_AUTH_TEST_MODE", raising=False)
    monkeypatch.delenv("EDAGENT_DISABLE_API_AUTH", raising=False)
    token = "test-token-deterministic-0123456789"
    monkeypatch.setenv("SYNTHIA_API_TOKEN", token)

    from edagent_vivado.web import auth as _auth

    monkeypatch.setattr(_auth, "_TOKEN_FILE", tmp_path / "synthia_token")
    _auth.reset_token_cache()
    try:
        yield token
    finally:
        _auth.reset_token_cache()
