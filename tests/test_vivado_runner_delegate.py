"""VivadoRunner remote path delegates to VivadoRuntimeAdapter."""

from pathlib import Path
from unittest.mock import MagicMock, patch

from edagent_vivado.harness.manifest import Manifest
from edagent_vivado.harness.vivado_runner import VivadoRunner
from edagent_vivado.harness.workspace import Workspace


def test_remote_run_delegates_to_adapter(tmp_path, monkeypatch):
    monkeypatch.setenv("VIVADO_REMOTE_HOST", "example.com")
    monkeypatch.setenv("VIVADO_REMOTE_KEY", "/tmp/key")

    manifest_yaml = tmp_path / "eda.yaml"
    manifest_yaml.write_text(
        "name: demo\n"
        "top: top\n"
        "part: xc7a35tcpg236-1\n"
        "sources:\n"
        "  rtl: [rtl/top.v]\n"
        "  xdc: []\n"
    )
    (tmp_path / "rtl").mkdir()
    (tmp_path / "rtl" / "top.v").write_text("module top(); endmodule\n")

    manifest = Manifest.load(manifest_yaml)
    ws = Workspace(base_dir=tmp_path, task_name="t1")
    ws.copy_sources(manifest)
    tcl = ws.script_path("synth.tcl")
    tcl.write_text("puts hello\n")

    runner = VivadoRunner(workspace=ws, manifest=manifest)
    assert runner._remote_cfg

    mock_adapter = MagicMock()
    mock_adapter.target.host = "example.com"
    mock_adapter.run_manifest_batch_step.return_value = {
        "step": "synth",
        "success": True,
        "remote": True,
    }

    with patch("edagent_vivado.harness.vivado_adapter.VivadoRuntimeAdapter", return_value=mock_adapter):
        with patch("edagent_vivado.harness.vivado_adapter.get_default_target"):
            out = runner._remote_run("synth", tcl)

    assert out["success"] is True
    mock_adapter.run_manifest_batch_step.assert_called_once()
