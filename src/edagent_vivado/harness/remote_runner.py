"""Remote Vivado connection smoke checks (SSH, no paramiko required)."""

from __future__ import annotations

import subprocess
from typing import Any


class RemoteVivadoRunner:
    """Lightweight remote host probe used by e2e smoke tests."""

    def __init__(
        self,
        host: str,
        identity_file: str | None = None,
        remote_vivado: str = "vivado",
    ) -> None:
        self.host = host
        self._identity_file = identity_file
        self._remote_vivado = remote_vivado

    def test_connection(self) -> dict[str, Any]:
        """Return reachability metadata without raising."""
        cmd = [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=5",
            "-o",
            "StrictHostKeyChecking=no",
        ]
        if self._identity_file:
            cmd += ["-i", self._identity_file]
        cmd += [self.host, "echo", "ok"]
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=10,
                shell=False,
            )
            reachable = proc.returncode == 0
            return {
                "reachable": reachable,
                "return_code": proc.returncode,
                "stdout": proc.stdout,
                "stderr": proc.stderr,
                "error": proc.stderr.strip() if not reachable else "",
            }
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
            return {"reachable": False, "error": str(exc)}
