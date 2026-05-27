"""Phase 8 — permission matrix."""

from __future__ import annotations

import importlib

import pytest

from edagent_vivado.auth.permissions import check_permission, invalidate_perm_cache
from edagent_vivado.repository import db as db_mod


@pytest.fixture(autouse=True)
def _seed_roles(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "perm.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    db_mod.close_db()
    db_mod.init_db()
    invalidate_perm_cache()
    yield
    invalidate_perm_cache()


def test_admin_has_all():
    assert check_permission("admin", "anything.we.want")
    assert check_permission("admin", "patch.approve")


def test_viewer_read_only():
    assert check_permission("viewer", "project.read")
    assert not check_permission("viewer", "run.create")
    assert not check_permission("viewer", "patch.approve")


def test_engineer_can_create_run():
    assert check_permission("fpga_engineer", "run.create")
    assert check_permission("fpga_engineer", "patch.propose")
    assert check_permission("fpga_engineer", "patch.approve.low")
    assert not check_permission("fpga_engineer", "patch.approve")


def test_reviewer_can_audit():
    assert check_permission("reviewer", "audit.read")
    assert check_permission("reviewer", "patch.approve")
    assert not check_permission("reviewer", "run.create")


def test_project_owner_member_add():
    assert check_permission("project_owner", "project.member.add")
