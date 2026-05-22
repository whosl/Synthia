"""Remote Vivado runner — execute Vivado on a remote machine via SSH."""

from __future__ import annotations

import json
import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from edagent_vivado.harness.manifest import Manifest

logger = logging.getLogger(__name__)


class RemoteVivadoRunner:
    """Execute Vivado flows on a remote server via SSH.

    Transfers source files, runs Vivado, and retrieves results.
    Uses OpenSSH's ``ssh`` and ``scp`` binaries (must be on PATH).

    Typical usage::

        runner = RemoteVivadoRunner(
            host="root@192.168.31.150",
            identity_file="/path/to/key",
            remote_vivado_path="/home/xilinx/vivado/Vivado/2022.1/bin/vivado",
            remote_env_script="/home/xilinx/vivado/Vivado/2022.1/settings64.sh",
        )
        result = runner.run_synth(manifest, local_workspace)
    """

    def __init__(
        self,
        host: str,
        identity_file: str | None = None,
        remote_vivado_path: str = "vivado",
        remote_env_script: str = "",
        remote_work_dir: str = "/tmp/edagent_remote",
        timeout: int = 7200,
    ) -> None:
        self._host = host
        self._identity_file = identity_file
        self._remote_vivado = remote_vivado_path
        self._remote_env = remote_env_script
        self._remote_work = remote_work_dir
        self._timeout = timeout

    @property
    def host(self) -> str:
        return self._host

    def _ssh_args(self) -> list[str]:
        args = ["ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes"]
        if self._identity_file:
            args += ["-i", self._identity_file]
        args.append(self._host)
        return args

    def _scp_args(self) -> list[str]:
        args = ["scp", "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes"]
        if self._identity_file:
            args += ["-i", self._identity_file]
        return args

    def _remote_cmd(self, cmd: str) -> list[str]:
        """Build an SSH command that sources the environment then runs the command."""
        full_cmd = cmd
        if self._remote_env:
            full_cmd = f"source {self._remote_env} && {cmd}"
        return self._ssh_args() + [full_cmd]

    def test_connection(self) -> dict[str, Any]:
        """Verify SSH connectivity and Vivado availability on remote."""
        try:
            result = subprocess.run(
                self._remote_cmd(f"{self._remote_vivado} -version"),
                capture_output=True, text=True, timeout=30,
            )
            return {
                "reachable": result.returncode == 0,
                "stdout": result.stdout.strip()[:500],
                "stderr": result.stderr.strip()[:500],
            }
        except Exception as e:
            return {"reachable": False, "error": str(e)}

    def run_synth(
        self,
        manifest: Manifest,
        local_workspace: Path,
    ) -> dict[str, Any]:
        """Transfer sources to remote, run synthesis, retrieve results.

        Args:
            manifest: Project manifest.
            local_workspace: Local workspace directory (must contain synth.tcl).
        """
        import time

        t0 = time.time()
        remote_run_dir = f"{self._remote_work}/synth_{int(t0)}"

        # Step 1: Create remote directory
        subprocess.run(
            self._remote_cmd(f"mkdir -p {remote_run_dir}/reports {remote_run_dir}/checkpoints"),
            capture_output=True, timeout=30,
        )

        # Step 2: Upload sources and Tcl script
        sources_dir = local_workspace / "src"
        tcl_path = local_workspace / "scripts" / "synth.tcl"

        if sources_dir.exists():
            subprocess.run(
                self._scp_args() + ["-r", str(sources_dir), f"{self._host}:{remote_run_dir}/"],
                capture_output=True, timeout=300,
            )

        if tcl_path.exists():
            subprocess.run(
                self._scp_args() + [str(tcl_path), f"{self._host}:{remote_run_dir}/synth.tcl"],
                capture_output=True, timeout=60,
            )
        else:
            return {"step": "synth", "success": False, "error": "synth.tcl not found"}

        # Upload XDC files
        for xdc in manifest.xdc_paths():
            if xdc.exists():
                subprocess.run(
                    self._scp_args() + [str(xdc), f"{self._host}:{remote_run_dir}/"],
                    capture_output=True, timeout=60,
                )

        # Step 3: Run synthesis on remote
        synth_cmd = (
            f"cd {remote_run_dir} && "
            f"{self._remote_vivado} -mode batch -source synth.tcl "
            f"-log {remote_run_dir}/vivado_synth.log"
        )
        proc = subprocess.run(
            self._remote_cmd(synth_cmd),
            capture_output=True, text=True, timeout=self._timeout,
        )

        # Step 4: Download results
        for fname in [
            "vivado_synth.log",
            "reports/post_synth_timing_summary.rpt",
            "reports/post_synth_utilization.rpt",
            "reports/post_synth_drc.rpt",
        ]:
            subprocess.run(
                self._scp_args() + [
                    f"{self._host}:{remote_run_dir}/{fname}",
                    str(local_workspace / fname),
                ],
                capture_output=True, timeout=60,
            )

        elapsed = round(time.time() - t0, 2)
        return {
            "step": "synth",
            "success": proc.returncode == 0,
            "return_code": proc.returncode,
            "elapsed_sec": elapsed,
            "remote": True,
            "host": self._host,
            "remote_dir": remote_run_dir,
            "log": str(local_workspace / "vivado_synth.log"),
        }

    def run_impl(
        self,
        manifest: Manifest,
        local_workspace: Path,
    ) -> dict[str, Any]:
        """Run implementation on remote. Requires synth checkpoint on remote."""
        import time

        t0 = time.time()
        tcl_path = local_workspace / "scripts" / "impl.tcl"
        if not tcl_path.exists():
            return {"step": "impl", "success": False, "error": "impl.tcl not found"}

        remote_run_dir = f"{self._remote_work}/synth_{int(t0 - 10)}"

        subprocess.run(
            self._scp_args() + [str(tcl_path), f"{self._host}:{remote_run_dir}/impl.tcl"],
            capture_output=True, timeout=60,
        )

        impl_cmd = (
            f"cd {remote_run_dir} && "
            f"{self._remote_vivado} -mode batch -source impl.tcl "
            f"-log {remote_run_dir}/vivado_impl.log"
        )
        proc = subprocess.run(
            self._remote_cmd(impl_cmd),
            capture_output=True, text=True, timeout=self._timeout,
        )

        for fname in [
            "vivado_impl.log",
            "reports/post_impl_timing_summary.rpt",
            "reports/post_impl_utilization.rpt",
            "reports/post_impl_drc.rpt",
        ]:
            subprocess.run(
                self._scp_args() + [
                    f"{self._host}:{remote_run_dir}/{fname}",
                    str(local_workspace / fname),
                ],
                capture_output=True, timeout=60,
            )

        elapsed = round(time.time() - t0, 2)
        return {
            "step": "impl",
            "success": proc.returncode == 0,
            "return_code": proc.returncode,
            "elapsed_sec": elapsed,
            "remote": True,
            "host": self._host,
            "remote_dir": remote_run_dir,
            "log": str(local_workspace / "vivado_impl.log"),
        }
