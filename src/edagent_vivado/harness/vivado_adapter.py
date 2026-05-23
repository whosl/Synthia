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
    ssh_port: int | None = None
    vivado_path: str = "vivado"
    settings_path: str = ""
    remote_work_root: str = "/tmp/edagent_remote"
    vivado_version: str = ""
    is_default: bool = False
    enabled: bool = True

    @classmethod
    def from_db(cls, row: dict) -> VivadoTarget:
        import json as _json
        meta = _json.loads(row.get("metadata_json") or "{}") if row.get("metadata_json") else {}
        return cls(
            id=row["id"], name=row["name"], target_type=row["target_type"],
            host=row.get("host") or "", ssh_key_path=row.get("ssh_key_path") or "",
            ssh_port=meta.get("ssh_port"),
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
        port_raw = os.environ.get("VIVADO_REMOTE_PORT", "")
        ssh_port = int(port_raw) if port_raw else None
        return cls(
            id="default-remote", name="default-remote", target_type="remote_ssh",
            host=host, ssh_key_path=os.environ.get("VIVADO_REMOTE_KEY", ""),
            ssh_port=ssh_port,
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

    def _persist_command(
        self,
        command_text: str,
        command_type: str,
        result: VivadoResult,
        *,
        session_id: str = "",
        task_id: str = "",
        run_id: str = "",
        project_id: str = "",
    ) -> str | None:
        if not self._target:
            return None
        from edagent_vivado.repository.store import vivado_command_create, vivado_command_finish

        row = vivado_command_create(
            self._target.id,
            command_text,
            command_type=command_type,
            session_id=session_id,
            task_id=task_id,
            run_id=run_id,
            project_id=project_id,
        )
        state = "completed" if result.success else "error"
        if result.error and "Policy" in (result.error or ""):
            state = "denied"
        vivado_command_finish(
            row["id"],
            state=state,
            exit_code=result.exit_code,
            elapsed_ms=int((result.elapsed_sec or 0) * 1000),
            error=result.error or "",
            parsed_summary={"command_type": command_type, "success": result.success},
        )
        return row["id"]

    def run_tcl(
        self,
        command: str,
        auto_approved: bool = False,
        timeout: int = 600,
        *,
        session_id: str = "",
        task_id: str = "",
        run_id: str = "",
        persist: bool = True,
    ) -> VivadoResult:
        """Execute a single Tcl command via batch mode."""
        policy = self.check_policy(command, auto_approved=auto_approved)
        if not policy.allowed:
            result = VivadoResult(success=False, error=f"Policy denied: {policy.reason}", command_type="raw_tcl")
            if persist:
                self._persist_command(command, "raw_tcl", result, session_id=session_id, task_id=task_id, run_id=run_id)
            return result
        if policy.requires_approval:
            result = VivadoResult(success=False, error=f"Approval required: {policy.reason}", command_type="raw_tcl")
            if persist:
                self._persist_command(command, "raw_tcl", result, session_id=session_id, task_id=task_id, run_id=run_id)
            return result

        if not self._target:
            result = VivadoResult(success=False, error="No Vivado target configured", command_type="raw_tcl")
            if persist:
                self._persist_command(command, "raw_tcl", result, session_id=session_id, task_id=task_id, run_id=run_id)
            return result

        if self._target.target_type == "local":
            result = self._run_local_tcl(command, timeout)
        else:
            result = self._run_remote_tcl(command, timeout)
        if persist:
            self._persist_command(command, "raw_tcl", result, session_id=session_id, task_id=task_id, run_id=run_id)
        return result

    def run_script(
        self,
        script: str,
        auto_approved: bool = False,
        timeout: int = 3600,
        *,
        session_id: str = "",
        task_id: str = "",
        run_id: str = "",
        persist: bool = True,
    ) -> VivadoResult:
        """Execute a Tcl script via batch mode."""
        policy = self.check_script_policy(script, auto_approved=auto_approved)
        if not policy.allowed:
            result = VivadoResult(success=False, error=f"Policy denied: {policy.reason}", command_type="script")
            if persist:
                self._persist_command(script[:500], "script", result, session_id=session_id, task_id=task_id, run_id=run_id)
            return result
        if policy.requires_approval:
            result = VivadoResult(success=False, error=f"Approval required: {policy.reason}", command_type="script")
            if persist:
                self._persist_command(script[:500], "script", result, session_id=session_id, task_id=task_id, run_id=run_id)
            return result

        if not self._target:
            result = VivadoResult(success=False, error="No Vivado target configured", command_type="script")
            if persist:
                self._persist_command(script[:500], "script", result, session_id=session_id, task_id=task_id, run_id=run_id)
            return result

        if self._target.target_type == "local":
            result = self._run_local_script(script, timeout)
        else:
            result = self._run_remote_script(script, timeout)
        if persist:
            self._persist_command(script[:500], "script", result, session_id=session_id, task_id=task_id, run_id=run_id)
        return result

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
        if self._target and self._target.ssh_port:
            cmd += ["-p", str(self._target.ssh_port)]
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
        if self._target.ssh_port:
            scp_base += ["-P", str(self._target.ssh_port)]

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

    def run_synthesis(
        self,
        manifest_path: str,
        *,
        session_id: str = "",
        task_id: str = "",
        run_id: str = "",
        persist: bool = True,
    ) -> dict[str, Any]:
        """High-level synthesis flow — unified entry used by agent tools."""
        from pathlib import Path

        from edagent_vivado.harness.manifest import Manifest
        from edagent_vivado.harness.tcl_templates import generate_synth_tcl
        from edagent_vivado.harness.vivado_runner import VivadoRunner
        from edagent_vivado.harness.workspace import Workspace
        from edagent_vivado.tools.vivado_tools import _patch_tcl_to_relative

        manifest = Manifest.load(manifest_path)
        mock_fail = os.environ.get("EDAGENT_MOCK_FAIL", "").strip() or None
        if not mock_fail and getattr(manifest, "model_extra", None):
            test_block = manifest.model_extra.get("test")
            if isinstance(test_block, dict):
                mock_fail = str(test_block.get("mock_fail") or "").strip() or None
        ws = Workspace(base_dir=Path(manifest_path).parent, task_name="agent_synth")
        ws.copy_sources(manifest)
        ws.write_manifest(manifest)

        tcl_content = generate_synth_tcl(manifest, ws.root)
        tcl_path = ws.script_path("synth.tcl")
        tcl_path.write_text(tcl_content, encoding="utf-8")
        _patch_tcl_to_relative(tcl_path, ws.root)

        runner = VivadoRunner(workspace=ws, manifest=manifest, mock_fail=mock_fail)
        if runner.is_mock:
            result = runner.run_synth()
        elif runner._remote_cfg:
            try:
                from edagent_vivado.harness.file_sync import sync_manifest_sources
                from edagent_vivado.harness.remote_executor import RemoteExecutor

                sync_manifest_sources(
                    manifest,
                    ws.root,
                    RemoteExecutor(self._target),
                    remote_work_dir=self._target.remote_work_root if self._target else None,
                )
            except Exception as exc:
                logger.warning("Remote file sync skipped: %s", exc)
            tc = tcl_path.read_text(errors="replace")
            for rp in manifest.rtl_paths():
                tc = tc.replace(str(rp), f"src/{rp.name}").replace(str(rp).replace("\\", "/"), f"src/{rp.name}")
            for xp in manifest.xdc_paths():
                tc = tc.replace(str(xp), f"src/{xp.name}").replace(str(xp).replace("\\", "/"), f"src/{xp.name}")
            tcl_path.write_text(tc)
            result = runner._remote_run("synth", tcl_path)
            if result.get("return_code") == 255 and not result.get("success"):
                result["error"] = result.get("error") or "SSH connection to remote Vivado host failed (exit 255)"
                result["mock"] = False
                result["remote"] = True
        else:
            result = runner.run_synth()
            for tf in ws.root.glob("scripts/*.tcl"):
                _patch_tcl_to_relative(tf, ws.root)
        result["workspace"] = str(ws.root)
        if persist and self._target:
            ok = bool(result.get("success"))
            synth_result = VivadoResult(
                success=ok,
                exit_code=int(result.get("return_code") or (0 if ok else 1)),
                stdout=str(result.get("log_excerpt") or result.get("stdout") or "")[:2000],
                stderr=str(result.get("error") or ""),
                elapsed_sec=float(result.get("elapsed_sec") or 0),
                target_id=self._target.id,
                command_type="synthesis",
                error=result.get("error"),
            )
            self._persist_command(
                f"synth {manifest_path}",
                "synthesis",
                synth_result,
                session_id=session_id,
                task_id=task_id,
                run_id=run_id,
                project_id=manifest.name(),
            )
        return result

    def run_implementation(
        self,
        manifest_path: str,
        *,
        session_id: str = "",
        task_id: str = "",
        run_id: str = "",
        persist: bool = True,
        run_synth_first: bool = True,
    ) -> dict[str, Any]:
        """Run implementation (opt/place/route) for a manifest workspace."""
        from pathlib import Path

        from edagent_vivado.harness.manifest import Manifest
        from edagent_vivado.harness.tcl_templates import generate_impl_tcl, generate_synth_tcl
        from edagent_vivado.harness.vivado_runner import VivadoRunner
        from edagent_vivado.harness.workspace import Workspace
        from edagent_vivado.tools.vivado_tools import _patch_tcl_to_relative

        manifest = Manifest.load(manifest_path)
        mock_fail = os.environ.get("EDAGENT_MOCK_FAIL", "").strip() or None
        if not mock_fail and getattr(manifest, "model_extra", None):
            test_block = manifest.model_extra.get("test")
            if isinstance(test_block, dict):
                mock_fail = str(test_block.get("mock_fail") or "").strip() or None

        ws = Workspace(base_dir=Path(manifest_path).parent, task_name="agent_impl")
        ws.copy_sources(manifest)
        ws.write_manifest(manifest)

        synth_path = ws.script_path("synth.tcl")
        synth_path.write_text(generate_synth_tcl(manifest, ws.root), encoding="utf-8")
        _patch_tcl_to_relative(synth_path, ws.root)

        impl_path = ws.script_path("impl.tcl")
        impl_path.write_text(generate_impl_tcl(manifest, ws.root), encoding="utf-8")
        _patch_tcl_to_relative(impl_path, ws.root)

        runner = VivadoRunner(workspace=ws, manifest=manifest, mock_fail=mock_fail)
        results: dict[str, Any] = {"workspace": str(ws.root)}

        if run_synth_first:
            if runner.is_mock:
                synth_result = runner.run_synth()
            elif runner._remote_cfg:
                tc = synth_path.read_text(errors="replace")
                for rp in manifest.rtl_paths():
                    tc = tc.replace(str(rp), f"src/{rp.name}").replace(str(rp).replace("\\", "/"), f"src/{rp.name}")
                for xp in manifest.xdc_paths():
                    tc = tc.replace(str(xp), f"src/{xp.name}").replace(str(xp).replace("\\", "/"), f"src/{xp.name}")
                synth_path.write_text(tc)
                synth_result = runner._remote_run("synth", synth_path)
            else:
                synth_result = runner.run_synth()
            results["synth"] = synth_result
            if not synth_result.get("success"):
                results.update(synth_result)
                results["success"] = False
                return results

        if runner.is_mock:
            impl_result = runner.run_impl()
        elif runner._remote_cfg:
            impl_result = runner._remote_run("impl", impl_path)
        else:
            impl_result = runner.run_impl()
        results.update(impl_result)
        results["workspace"] = str(ws.root)

        if persist and self._target:
            ok = bool(results.get("success"))
            impl_vr = VivadoResult(
                success=ok,
                exit_code=int(results.get("return_code") or (0 if ok else 1)),
                stdout=str(results.get("log") or "")[:2000],
                stderr=str(results.get("error") or ""),
                elapsed_sec=float(results.get("elapsed_sec") or 0),
                target_id=self._target.id,
                command_type="implementation",
                error=results.get("error"),
            )
            self._persist_command(
                f"impl {manifest_path}",
                "implementation",
                impl_vr,
                session_id=session_id,
                task_id=task_id,
                run_id=run_id,
                project_id=manifest.name(),
            )
        return results
