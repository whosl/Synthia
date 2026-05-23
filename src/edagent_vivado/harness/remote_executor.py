"""SSH/SCP remote execution — Phase 3A (subprocess-based, no paramiko required)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from edagent_vivado.harness.task_cancel import run_cancellable
from edagent_vivado.harness.vivado_adapter import VivadoTarget, get_default_target

logger = logging.getLogger(__name__)


@dataclass
class RemoteResult:
    return_code: int
    stdout: str
    stderr: str
    timed_out: bool = False
    stopped: bool = False


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

    def run(self, remote_command: str, timeout: int = 7200, *, task_id: str | None = None) -> RemoteResult:
        res = run_cancellable(
            self._ssh_base() + [remote_command],
            task_id=task_id,
            timeout=float(timeout),
        )
        if res.stopped:
            return RemoteResult(-1, res.stdout, res.stderr or "Task stopped by user", stopped=True)
        if res.timed_out:
            return RemoteResult(124, res.stdout, res.stderr or "Timeout", timed_out=True)
        return RemoteResult(res.returncode, res.stdout, res.stderr)

    def mkdir_remote(self, remote_dir: str, *, task_id: str | None = None) -> RemoteResult:
        return self.run(f"mkdir -p {remote_dir}", timeout=30, task_id=task_id)

    def upload(self, local_path: Path, remote_path: str, *, task_id: str | None = None) -> RemoteResult:
        if not local_path.is_file():
            return RemoteResult(1, "", f"Local file not found: {local_path}")
        dest = f"{self.target.host}:{remote_path}"
        res = run_cancellable(
            self._scp_base() + [str(local_path), dest],
            task_id=task_id,
            timeout=120.0,
        )
        if res.stopped:
            return RemoteResult(-1, res.stdout, res.stderr or "Task stopped by user", stopped=True)
        return RemoteResult(res.returncode, res.stdout, res.stderr)

    def upload_many(self, pairs: Sequence[tuple[Path, str]], *, task_id: str | None = None) -> RemoteResult:
        for local, remote in pairs:
            r = self.upload(local, remote, task_id=task_id)
            if r.return_code != 0 or r.stopped:
                return r
        return RemoteResult(0, "", "")

    def download(self, remote_path: str, local_path: Path, *, task_id: str | None = None) -> RemoteResult:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        src = f"{self.target.host}:{remote_path}"
        res = run_cancellable(
            self._scp_base() + [src, str(local_path)],
            task_id=task_id,
            timeout=120.0,
        )
        if res.stopped:
            return RemoteResult(-1, res.stdout, res.stderr or "Task stopped by user", stopped=True)
        return RemoteResult(res.returncode, res.stdout, res.stderr)
