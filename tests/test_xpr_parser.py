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


def test_parse_project_mode_with_psrcdir():
    """Vivado GUI project-mode xpr uses $PSRCDIR — must resolve via *.srcs glob."""
    fix = FIXTURE_DIR / "project_mode" / "myproj.xpr"
    doc = parse_xpr(fix)

    assert doc.top_module == "top"
    assert doc.part == "xc7a50tfgg484-2"

    rtl = doc.rtl_files
    xdc = doc.xdc_files
    assert len(rtl) == 1
    assert len(xdc) == 1

    assert "$PSRCDIR" not in rtl[0].abs_path
    assert "$PSRCDIR" not in xdc[0].abs_path
    assert Path(rtl[0].abs_path).exists(), f"missing rtl: {rtl[0].abs_path}"
    assert Path(xdc[0].abs_path).exists(), f"missing xdc: {xdc[0].abs_path}"


def test_psrcdir_fallback_when_no_srcs_dir(tmp_path):
    """When no <proj>.srcs dir exists, $PSRCDIR falls back to project_dir itself."""
    from edagent_vivado.projects.xpr_parser import parse_xpr as _parse_xpr

    xpr = tmp_path / "noproj.xpr"
    xpr.write_text(
        """<?xml version='1.0'?>
<Project Version='7'>
  <Configuration><Option Name='Part' Val='xc7'/></Configuration>
  <FileSets><FileSet Name='sources_1' Type='DesignSrcs'>
    <File Path='$PSRCDIR/dangling.v'/>
  </FileSet></FileSets>
</Project>""",
        encoding="utf-8",
    )

    doc = _parse_xpr(str(xpr))
    assert doc.name == "noproj"
    rtl = doc.rtl_files
    assert len(rtl) == 1
    assert "$PSRCDIR" not in rtl[0].abs_path
    # Expansion fell back to project_dir; resolved path now lives there
    assert rtl[0].abs_path.endswith("/dangling.v")


def test_prundir_resolves_to_runs_dir():
    from edagent_vivado.projects.xpr_parser import _find_runs_dir

    pd = str(FIXTURE_DIR / "project_mode")
    runs = _find_runs_dir(pd)
    assert runs.endswith("/myproj.runs"), runs
