"""SSH/SCP remote execution — Phase 3A (subprocess-based, no paramiko required)."""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from edagent_vivado.harness.vivado_adapter import VivadoTarget, get_default_target

logger = logging.getLogger(__name__)


@dataclass
class RemoteResult:
    return_code: int
    stdout: str
    stderr: str
    timed_out: bool = False


class RemoteExecutor:
    """Run commands and copy files on a remote Vivado host via ssh/scp."""

    def __init__(self, target: VivadoTarget | None = None) -> None:
        self.target = target or get_default_target()
        if not self.target or not self.target.host:
            raise ValueError("No remote Vivado target configured (set VIVADO_REMOTE_HOST)")

    def _ssh_base(self) -> list[str]:
        cmd = ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=15"]
        if self.target and self.target.ssh_key_path:
            cmd += ["-i", self.target.ssh_key_path]
        if self.target and self.target.ssh_port:
            cmd += ["-p", str(self.target.ssh_port)]
        cmd.append(self.target.host)
        return cmd

    def _scp_base(self) -> list[str]:
        cmd = ["scp", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=15"]
        if self.target and self.target.ssh_key_path:
            cmd += ["-i", self.target.ssh_key_path]
        if self.target and self.target.ssh_port:
            cmd += ["-P", str(self.target.ssh_port)]
        return cmd

    def run(self, remote_command: str, timeout: int = 7200) -> RemoteResult:
        try:
            proc = subprocess.run(
                self._ssh_base() + [remote_command],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            return RemoteResult(proc.returncode, proc.stdout, proc.stderr)
        except subprocess.TimeoutExpired as e:
            return RemoteResult(124, e.stdout or "", e.stderr or "", timed_out=True)
        except OSError as e:
            return RemoteResult(255, "", str(e))

    def mkdir_remote(self, remote_dir: str) -> RemoteResult:
        return self.run(f"mkdir -p {remote_dir}")

    def upload(self, local_path: Path, remote_path: str) -> RemoteResult:
        if not local_path.is_file():
            return RemoteResult(1, "", f"Local file not found: {local_path}")
        dest = f"{self.target.host}:{remote_path}"
        try:
            proc = subprocess.run(
                self._scp_base() + [str(local_path), dest],
                capture_output=True,
                text=True,
                timeout=120,
            )
            return RemoteResult(proc.returncode, proc.stdout, proc.stderr)
        except OSError as e:
            return RemoteResult(255, "", str(e))

    def upload_many(self, pairs: Sequence[tuple[Path, str]]) -> RemoteResult:
        for local, remote in pairs:
            r = self.upload(local, remote)
            if r.return_code != 0:
                return r
        return RemoteResult(0, "", "")

    def download(self, remote_path: str, local_path: Path) -> RemoteResult:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        src = f"{self.target.host}:{remote_path}"
        try:
            proc = subprocess.run(
                self._scp_base() + [src, str(local_path)],
                capture_output=True,
                text=True,
                timeout=120,
            )
            return RemoteResult(proc.returncode, proc.stdout, proc.stderr)
        except OSError as e:
            return RemoteResult(255, "", str(e))
