from pathlib import Path

import yaml

from edagent_vivado.projects.manifest_gen import manifest_from_xpr, write_internal_manifest
from edagent_vivado.projects.xpr_parser import parse_xpr

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "xpr"


def test_manifest_from_xpr():
    doc = parse_xpr(FIXTURE_DIR / "valid_uart.xpr")
    m = manifest_from_xpr(doc)
    assert m["project"]["name"] == "valid_uart"
    assert m["project"]["top"] == "uart_top"
    assert m["project"]["part"] == "xc7a50tfgg484-2"
    assert m["project"]["flow"] == "project"
    assert len(m["sources"]["rtl"]) == 3
    assert m["_meta"]["imported_from_xpr"].endswith("valid_uart.xpr")


def test_write_internal_manifest(tmp_path):
    doc = parse_xpr(FIXTURE_DIR / "valid_uart.xpr")
    m = manifest_from_xpr(doc)
    p = write_internal_manifest(tmp_path, m)
    assert p.exists()
    assert p.parent.name == ".synthia"

    loaded = yaml.safe_load(p.read_text(encoding="utf-8"))
    assert loaded["project"]["name"] == "valid_uart"
