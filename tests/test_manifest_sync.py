import shutil
import time
from pathlib import Path

from edagent_vivado.projects.manifest_gen import manifest_from_xpr, write_internal_manifest
from edagent_vivado.projects.manifest_sync import check_sync, write_fingerprint
from edagent_vivado.projects.xpr_parser import parse_xpr

FIXTURE = Path(__file__).parent / "fixtures" / "xpr" / "valid_uart.xpr"


def test_sync_in_sync(tmp_path):
    xpr_copy = tmp_path / "valid_uart.xpr"
    shutil.copy(FIXTURE, xpr_copy)

    doc = parse_xpr(xpr_copy)
    m = manifest_from_xpr(doc)
    write_internal_manifest(tmp_path, m)
    write_fingerprint(tmp_path, xpr_copy)

    result = check_sync(tmp_path)
    assert result.status == "in_sync"


def test_sync_xpr_modified(tmp_path):
    xpr_copy = tmp_path / "valid_uart.xpr"
    shutil.copy(FIXTURE, xpr_copy)
    doc = parse_xpr(xpr_copy)
    m = manifest_from_xpr(doc)
    write_internal_manifest(tmp_path, m)
    write_fingerprint(tmp_path, xpr_copy)

    time.sleep(0.02)
    xpr_copy.write_text(xpr_copy.read_text(encoding="utf-8") + "\n<!-- modified -->\n", encoding="utf-8")

    result = check_sync(tmp_path)
    assert result.status == "xpr_modified"


def test_sync_manifest_missing(tmp_path):
    result = check_sync(tmp_path)
    assert result.status == "manifest_missing"


def test_sync_no_xpr(tmp_path):
    (tmp_path / ".synthia").mkdir()
    (tmp_path / ".synthia" / "eda.yaml").write_text("project:\n  name: scan_only\n", encoding="utf-8")
    result = check_sync(tmp_path)
    assert result.status == "no_xpr"
