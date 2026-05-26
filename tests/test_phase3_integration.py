"""Phase 3 API integration — xpr import, scan, health."""

from __future__ import annotations

import importlib
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod
from edagent_vivado.web.app import create_app

FIXTURE = Path(__file__).parent / "fixtures" / "xpr" / "valid_uart.xpr"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("VIVADO_REMOTE_HOST", raising=False)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "p3.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return TestClient(create_app())


def test_import_xpr_endpoint(client, tmp_path):
    dst_dir = tmp_path / "uart_demo"
    dst_dir.mkdir()
    dst = dst_dir / "valid_uart.xpr"
    shutil.copy(FIXTURE, dst)
    rtl_dir = dst_dir / "rtl"
    rtl_dir.mkdir()
    for fn in ("uart_top.v", "uart_tx.v", "uart_rx.v"):
        (rtl_dir / fn).write_text(f"module {fn[:-2]}; endmodule\n", encoding="utf-8")
    (dst_dir / "constraints").mkdir(exist_ok=True)
    (dst_dir / "constraints" / "top.xdc").write_text("# clk\n", encoding="utf-8")

    resp = client.post(
        "/api/v1/projects/import-xpr",
        json={"xpr_path": str(dst).replace("\\", "/")},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "project_id" in data
    assert Path(data["manifest_path"]).is_file()


def test_scan_endpoint(client):
    demo = Path("examples/uart_demo")
    if not demo.is_dir():
        pytest.skip("examples/uart_demo missing")
    resp = client.post(
        "/api/v1/projects/scan",
        json={"root_path": str(demo).replace("\\", "/")},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["is_likely_fpga_project"]


def test_health_after_import(client, tmp_path):
    dst_dir = tmp_path / "health_demo"
    dst_dir.mkdir()
    dst = dst_dir / "valid_uart.xpr"
    shutil.copy(FIXTURE, dst)
    (dst_dir / "rtl").mkdir()
    (dst_dir / "rtl" / "uart_top.v").write_text("module uart_top; endmodule\n", encoding="utf-8")

    imp = client.post("/api/v1/projects/import-xpr", json={"xpr_path": str(dst).replace("\\", "/")})
    assert imp.status_code == 200
    pid = imp.json()["project_id"]

    health = client.get(f"/api/v1/projects/{pid}/health")
    assert health.status_code == 200
    assert health.json()["status"] in ("in_sync", "no_xpr")
