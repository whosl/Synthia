from pathlib import Path

import pytest

from edagent_vivado.projects.validate import ProjectValidationError, validate_project_paths


def test_validate_uart_full_non_project(tmp_path):
    root = Path(__file__).resolve().parents[1] / "examples" / "uart_full"
    if not root.is_dir():
        pytest.skip("examples/uart_full missing")
    out = validate_project_paths(
        root_path=str(root),
        manifest_path=str(root / "eda.yaml"),
        xpr_path="",
        cwd=root.parents[1],
    )
    assert out["part"]
    assert out["top_module"] == "uart_top"
