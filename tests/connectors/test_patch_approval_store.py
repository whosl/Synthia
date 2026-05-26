"""Phase 6D — patch_proposals and approvals tables."""

import importlib

import pytest

from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "patch.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def test_approval_and_patch(store):
    approval = store.approval_create(
        "patch",
        {"file_path": "top.v", "old_text": "a", "new_text": "b"},
        session_id="s1",
        risk_level="medium",
    )
    patch = store.patch_proposal_create(
        "vivado",
        "top.v",
        "rtl_patch",
        session_id="s1",
        approval_id=approval["id"],
        diff_text="--- diff ---",
    )
    assert patch["approval_id"] == approval["id"]
    listed = store.approval_list(status="pending")
    assert len(listed) >= 1
