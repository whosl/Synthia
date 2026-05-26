from pathlib import Path

from edagent_vivado.projects.wizard import WizardInput, create_project

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "xpr"


def test_wizard_creates_manifest(tmp_path):
    rtl = FIXTURE_DIR / "rtl" / "uart_top.v"
    wi = WizardInput(
        name="wiz_demo",
        location=str(tmp_path),
        part="xc7a50tfgg484-2",
        top_module="uart_top",
        rtl_sources=[str(rtl)],
        copy_sources=True,
    )
    result = create_project(wi)
    assert result.manifest_path.is_file()
    assert (result.project_root / "rtl" / "uart_top.v").is_file()
