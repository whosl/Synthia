from edagent_vivado.harness.register_artifact import register_artifact
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod
import importlib


def test_register_artifact_sha256(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "art.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()

    f = tmp_path / "demo.bit"
    f.write_bytes(b"bitstream-bytes")

    rec = register_artifact(
        run_id="run1",
        artifact_type="bitstream",
        path=str(f),
    )
    assert rec["sha256"]
    assert len(rec["sha256"]) == 64
    assert rec["size_bytes"] == len(b"bitstream-bytes")

    got = store_mod.artifact_get(rec["id"])
    assert got
    assert got["sha256"] == rec["sha256"]
