"""Vivado Runtime Adapter — SPEC §9A: unified execution layer for all Vivado operations."""

from __future__ import annotations

import logging
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from edagent_vivado.harness.tcl_policy import PolicyResult, check_tcl_policy, check_tcl_script
from edagent_vivado.repository.store import (
    vivado_target_get,
    vivado_target_list,
)

logger = logging.getLogger(__name__)


@dataclass
class VivadoResult:
    success: bool
    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""
    log_path: str | None = None
    elapsed_sec: float = 0.0
    target_id: str = ""
    command_type: str = ""
    error: str | None = None
    artifacts: list[str] = field(default_factory=list)


@dataclass
class VivadoTarget:
    id: str
    name: str
    target_type: str
    host: str = ""
    ssh_key_path: str = ""
    vivado_path: str = "vivado"
    settings_path: str = ""
    remote_work_root: str = "/tmp/edagent_remote"
    vivado_version: str = ""
    is_default: bool = False
    enabled: bool = True

    @classmethod
    def from_db(cls, row: dict) -> VivadoTarget:
        return cls(
            id=row["id"], name=row["name"], target_type=row["target_type"],
            host=row.get("host") or "", ssh_key_path=row.get("ssh_key_path") or "",
            vivado_path=row.get("vivado_path") or "vivado",
            settings_path=row.get("settings_path") or "",
            remote_work_root=row.get("remote_work_root") or "/tmp/edagent_remote",
            vivado_version=row.get("vivado_version") or "",
            is_default=bool(row.get("is_default")), enabled=bool(row.get("enabled", 1)),
        )

    @classmethod
    def from_env(cls) -> VivadoTarget | None:
        host = os.environ.get("VIVADO_REMOTE_HOST", "")
        if not host:
            return None
        return cls(
            id="default-remote", name="default-remote", target_type="remote_ssh",
            host=host, ssh_key_path=os.environ.get("VIVADO_REMOTE_KEY", ""),
            vivado_path=os.environ.get("VIVADO_REMOTE_PATH", "vivado"),
            settings_path=os.environ.get("VIVADO_REMOTE_ENV", ""),
            remote_work_root=os.environ.get("VIVADO_REMOTE_WORK", "/tmp/edagent_remote"),
        )


def get_default_target() -> VivadoTarget | None:
    targets = vivado_target_list()
    for t in targets:
        if t.get("is_default"):
            return VivadoTarget.from_db(t)
    if targets:
        return VivadoTarget.from_db(targets[0])
    return VivadoTarget.from_env()


def get_target(target_id: str | None = None) -> VivadoTarget | None:
    if target_id:
        row = vivado_target_get(target_id)
        if row:
            return VivadoTarget.from_db(row)
    return get_default_target()


class VivadoRuntimeAdapter:
    """Unified entry point for all Vivado execution."""

    def __init__(self, target: VivadoTarget | None = None):
        self._target = target or get_default_target()

    @property
    def target(self) -> VivadoTarget | None:
        return self._target

    def check_policy(self, command: str, auto_approved: bool = False) -> PolicyResult:
        return check_tcl_policy(command, auto_approved=auto_approved)

    def check_script_policy(self, script: str, auto_approved: bool = False) -> PolicyResult:
        return check_tcl_script(script, auto_approved=auto_approved)

    def run_tcl(self, command: str, auto_approved: bool = False, timeout: int = 600) -> VivadoResult:
        """Execute a single Tcl command via batch mode."""
        policy = self.check_policy(command, auto_approved=auto_approved)
        if not policy.allowed:
            return VivadoResult(success=False, error=f"Policy denied: {policy.reason}", command_type="raw_tcl")
        if policy.requires_approval:
            return VivadoResult(success=False, error=f"Approval required: {policy.reason}", command_type="raw_tcl")

        if not self._target:
            return VivadoResult(success=False, error="No Vivado target configured", command_type="raw_tcl")

        if self._target.target_type == "local":
            return self._run_local_tcl(command, timeout)
        return self._run_remote_tcl(command, timeout)

    def run_script(self, script: str, auto_approved: bool = False, timeout: int = 3600) -> VivadoResult:
        """Execute a Tcl script via batch mode."""
        policy = self.check_script_policy(script, auto_approved=auto_approved)
        if not policy.allowed:
            return VivadoResult(success=False, error=f"Policy denied: {policy.reason}", command_type="script")
        if policy.requires_approval:
            return VivadoResult(success=False, error=f"Approval required: {policy.reason}", command_type="script")

        if not self._target:
            return VivadoResult(success=False, error="No Vivado target configured", command_type="script")

        if self._target.target_type == "local":
            return self._run_local_script(script, timeout)
        return self._run_remote_script(script, timeout)

    def health_check(self) -> dict[str, Any]:
        """Check target connectivity and Vivado availability."""
        if not self._target:
            return {"ok": False, "error": "No target configured"}

        result: dict[str, Any] = {
            "target_id": self._target.id,
            "target_type": self._target.target_type,
            "host": self._target.host,
            "vivado_path": self._target.vivado_path,
            "reachable": False,
            "version": None,
        }

        if self._target.target_type == "local":
            import shutil
            result["reachable"] = shutil.which(self._target.vivado_path) is not None
            return result

        if not self._target.host:
            result["error"] = "No host configured"
            return result

        ssh_base = self._ssh_base()
        try:
            p = subprocess.run(ssh_base + ["echo OK"], capture_output=True, text=True, timeout=15)
            result["reachable"] = "OK" in p.stdout
        except (subprocess.TimeoutExpired, OSError) as e:
            result["error"] = str(e)
            return result

        if result["reachable"] and self._target.settings_path:
            try:
                cmd = f"source {self._target.settings_path} 2>/dev/null && {self._target.vivado_path} -version 2>&1 | head -2"
                p = subprocess.run(ssh_base + [cmd], capture_output=True, text=True, timeout=20)
                for line in p.stdout.splitlines():
                    if "Vivado v" in line or "vivado" in line.lower():
                        result["version"] = line.strip()
                        break
            except (subprocess.TimeoutExpired, OSError):
                pass

        return result

    def _ssh_base(self) -> list[str]:
        cmd = ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10"]
        if self._target and self._target.ssh_key_path:
            cmd += ["-i", self._target.ssh_key_path]
        if self._target:
            cmd.append(self._target.host)
        return cmd

    def _run_local_tcl(self, command: str, timeout: int) -> VivadoResult:
        t0 = time.time()
        script_content = f"{command}\nexit\n"
        import tempfile
        with tempfile.NamedTemporaryFile(mode="w", suffix=".tcl", delete=False) as f:
            f.write(script_content)
            script_path = f.name
        try:
            p = subprocess.run(
                [self._target.vivado_path, "-mode", "batch", "-source", script_path],
                capture_output=True, text=True, timeout=timeout,
            )
            return VivadoResult(
                success=p.returncode == 0, exit_code=p.returncode,
                stdout=p.stdout, stderr=p.stderr,
                elapsed_sec=round(time.time() - t0, 2),
                target_id=self._target.id, command_type="raw_tcl",
            )
        except subprocess.TimeoutExpired:
            return VivadoResult(success=False, error="Timeout", elapsed_sec=round(time.time() - t0, 2),
                                target_id=self._target.id, command_type="raw_tcl")
        finally:
            os.unlink(script_path)

    def _run_local_script(self, script: str, timeout: int) -> VivadoResult:
        t0 = time.time()
        import tempfile
        with tempfile.NamedTemporaryFile(mode="w", suffix=".tcl", delete=False) as f:
            f.write(script)
            script_path = f.name
        try:
            p = subprocess.run(
                [self._target.vivado_path, "-mode", "batch", "-source", script_path],
                capture_output=True, text=True, timeout=timeout,
            )
            return VivadoResult(
                success=p.returncode == 0, exit_code=p.returncode,
                stdout=p.stdout, stderr=p.stderr,
                elapsed_sec=round(time.time() - t0, 2),
                target_id=self._target.id, command_type="script",
            )
        except subprocess.TimeoutExpired:
            return VivadoResult(success=False, error="Timeout", elapsed_sec=round(time.time() - t0, 2),
                                target_id=self._target.id, command_type="script")
        finally:
            os.unlink(script_path)

    def _run_remote_tcl(self, command: str, timeout: int) -> VivadoResult:
        t0 = time.time()
        ssh = self._ssh_base()
        env_cmd = f"source {self._target.settings_path} 2>/dev/null && " if self._target.settings_path else ""
        full_cmd = f'{env_cmd}{self._target.vivado_path} -mode batch -nojournal -nolog -tclargs <<EOF\n{command}\nexit\nEOF'
        try:
            p = subprocess.run(ssh + [full_cmd], capture_output=True, text=True, timeout=timeout)
            return VivadoResult(
                success=p.returncode == 0, exit_code=p.returncode,
                stdout=p.stdout, stderr=p.stderr,
                elapsed_sec=round(time.time() - t0, 2),
                target_id=self._target.id, command_type="raw_tcl",
            )
        except subprocess.TimeoutExpired:
            return VivadoResult(success=False, error="Timeout", elapsed_sec=round(time.time() - t0, 2),
                                target_id=self._target.id, command_type="raw_tcl")
        except OSError as e:
            return VivadoResult(success=False, error=str(e), target_id=self._target.id, command_type="raw_tcl")

    def _run_remote_script(self, script: str, timeout: int) -> VivadoResult:
        t0 = time.time()
        ssh = self._ssh_base()
        scp_base = ["scp", "-o", "StrictHostKeyChecking=no"]
        if self._target.ssh_key_path:
            scp_base += ["-i", self._target.ssh_key_path]

        remote_script = f"{self._target.remote_work_root}/tmp_script_{int(time.time())}.tcl"
        import tempfile
        with tempfile.NamedTemporaryFile(mode="w", suffix=".tcl", delete=False) as f:
            f.write(script)
            local_path = f.name
        try:
            subprocess.run(ssh + [f"mkdir -p {self._target.remote_work_root}"], capture_output=True, timeout=15)
            subprocess.run(scp_base + [local_path, f"{self._target.host}:{remote_script}"], capture_output=True, timeout=30)
            env_cmd = f"source {self._target.settings_path} 2>/dev/null && " if self._target.settings_path else ""
            p = subprocess.run(
                ssh + [f"{env_cmd}{self._target.vivado_path} -mode batch -source {remote_script}"],
                capture_output=True, text=True, timeout=timeout,
            )
            subprocess.run(ssh + [f"rm -f {remote_script}"], capture_output=True, timeout=10)
            return VivadoResult(
                success=p.returncode == 0, exit_code=p.returncode,
                stdout=p.stdout, stderr=p.stderr,
                elapsed_sec=round(time.time() - t0, 2),
                target_id=self._target.id, command_type="script",
            )
        except subprocess.TimeoutExpired:
            return VivadoResult(success=False, error="Timeout", elapsed_sec=round(time.time() - t0, 2),
                                target_id=self._target.id, command_type="script")
        except OSError as e:
            return VivadoResult(success=False, error=str(e), target_id=self._target.id, command_type="script")
        finally:
            os.unlink(local_path)
