"""Tests for Manifest (eda.yaml) loading."""

from pathlib import Path

import pytest

from edagent_vivado.harness.manifest import Manifest

EXAMPLE_DIR = Path(__file__).parent.parent / "examples" / "uart_demo"


def test_manifest_loads_yaml():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    assert manifest.name() == "uart_demo"
    assert manifest.top() == "uart_top"
    assert manifest.part() == "xc7a50tfgg484-2"
    assert manifest.vivado_version() == "2020.2"
    assert manifest.flow() == "non_project"


def test_manifest_sources():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    paths = manifest.rtl_paths()
    assert len(paths) == 1
    assert "uart_top" in paths[0].name


def test_manifest_constraints():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    xdcs = manifest.xdc_paths()
    assert len(xdcs) == 1
    assert xdcs[0].suffix == ".xdc"


def test_manifest_runs():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    assert manifest.runs.synth.enabled is True
    assert manifest.runs.impl.enabled is False


def test_manifest_defaults():
    """Empty YAML should produce defaults."""
    import tempfile, yaml
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        yaml.dump({"project": {"name": "test"}}, f)
        path = f.name
    try:
        m = Manifest.load(path)
        assert m.name() == "test"
        assert m.top() == "top"  # default
        assert m.part() == ""  # default
    finally:
        Path(path).unlink()


def test_manifest_tb_paths():
    """tb_paths should resolve testbench file paths."""
    import tempfile, yaml
    tb_dir = Path(tempfile.mkdtemp())
    tb_file = tb_dir / "tb_top.v"
    tb_file.write_text("module tb_top; endmodule")
    yaml_path = tb_dir / "eda.yaml"
    yaml.dump({"project": {"name": "test", "part": "xc7a50t", "top": "top"},
               "sources": {"rtl": [], "tb": ["tb_top.v"]},
               "constraints": {"xdc": []}}, yaml_path.open("w"))
    try:
        m = Manifest.load(yaml_path)
        paths = m.tb_paths()
        assert len(paths) == 1
        assert paths[0].name == "tb_top.v"
    finally:
        import shutil
        shutil.rmtree(tb_dir)


def test_manifest_ip_support():
    """Manifest should parse ip entries."""
    import tempfile, yaml
    data = {
        "project": {"name": "ip_test", "part": "xc7a50t", "top": "top"},
        "sources": {"rtl": [], "tb": []},
        "constraints": {"xdc": []},
        "ip": [{"name": "clk_wiz_0", "vendor": "xilinx.com", "library": "ip", "version": "6.0"}],
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        yaml.dump(data, f)
        path = f.name
    try:
        m = Manifest.load(path)
        assert len(m.ip) == 1
        assert m.ip[0].name == "clk_wiz_0"
        assert m.ip[0].vendor == "xilinx.com"
    finally:
        Path(path).unlink()


def test_manifest_base_dir():
    """base_dir property should return the directory of the yaml."""
    m = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    assert m.base_dir == EXAMPLE_DIR.resolve()
