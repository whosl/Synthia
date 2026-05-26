from pathlib import Path

from edagent_vivado.projects.xpr_parser import _classify_file, parse_xpr

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "xpr"


def test_parse_valid_uart():
    doc = parse_xpr(FIXTURE_DIR / "valid_uart.xpr")
    assert doc.name == "valid_uart"
    assert doc.part == "xc7a50tfgg484-2"
    assert doc.top_module == "uart_top"
    assert doc.target_language == "Verilog"
    assert len(doc.rtl_files) == 3
    assert len(doc.xdc_files) == 1
    assert len(doc.tb_files) == 1
    assert doc.warnings == []


def test_parse_missing_part_warns():
    doc = parse_xpr(FIXTURE_DIR / "missing_part.xpr")
    assert doc.part == ""
    assert any("part" in w.lower() for w in doc.warnings)


def test_classify_file():
    assert _classify_file("foo.v") == "rtl"
    assert _classify_file("foo.SV") == "rtl"
    assert _classify_file("foo.xdc") == "xdc"
    assert _classify_file("foo.xci") == "ip"
    assert _classify_file("foo.bd") == "bd"
    assert _classify_file("foo.txt") == "other"


def test_ip_and_bd_classified():
    doc = parse_xpr(FIXTURE_DIR / "has_ip.xpr")
    assert len(doc.ip_files) >= 1

    doc2 = parse_xpr(FIXTURE_DIR / "has_bd.xpr")
    assert len(doc2.bd_files) >= 1


def test_path_expansion():
    doc = parse_xpr(FIXTURE_DIR / "valid_uart.xpr")
    rtl = doc.rtl_files[0]
    assert "$PPRDIR" not in rtl.abs_path
    assert rtl.abs_path.replace("\\", "/").endswith("/rtl/uart_top.v")
