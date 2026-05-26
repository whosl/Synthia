from pathlib import Path

from edagent_vivado.projects.scanner import guess_top_modules, scan_directory

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "xpr"


def test_scan_fixture_dir():
    result = scan_directory(str(FIXTURE_DIR))
    assert result.is_likely_fpga_project
    assert result.xpr_files
    assert result.rtl_files
    assert "uart_top" in guess_top_modules(result.rtl_files + result.sv_files)


def test_scan_empty_dir(tmp_path):
    result = scan_directory(str(tmp_path))
    assert not result.is_likely_fpga_project
