"""VivadoRunner — controlled Vivado execution with mock fallback + remote SSH."""

from __future__ import annotations

import logging
import os, shutil, time, subprocess
from pathlib import Path
from typing import Any

from edagent_vivado.harness.command_runner import CommandRunner
from edagent_vivado.harness.manifest import Manifest
from edagent_vivado.harness.tcl_templates import generate_impl_tcl, generate_synth_tcl
from edagent_vivado.harness.workspace import Workspace

logger = logging.getLogger(__name__)

MOCK_FAILURE_SCENARIOS = {
    "synth_8_439": {"step": "synth", "success": False, "return_code": 1,
        "errors": ["ERROR: [Synth 8-439] Module 'echo_handler' not found", "ERROR: [Synth 8-439] Module 'uart_rx' not found"],
        "critical_warnings": ["CRITICAL WARNING: [Common 17-69] Command 'synth_design' failed"], "wns": None, "lut": None},
    "timing_violation": {"step": "synth", "success": True, "return_code": 0, "errors": [],
        "critical_warnings": ["CRITICAL WARNING: [Timing 38-282] The design failed to meet timing"], "wns": -2.35, "tns": -48.2, "lut": 1234, "ff": 567},
    "place_30_574": {"step": "impl", "success": False, "return_code": 1,
        "errors": ["ERROR: [Place 30-574] Poor placement — routing congestion in region X1Y2"], "wns": None, "lut": 45000, "ff": 120000},
    "drc_violation": {"step": "impl", "success": True, "return_code": 0, "drc_clean": False,
        "critical_warnings": ["CRITICAL WARNING: DRC violation — IO standard conflict on port 'clk'"], "wns": 0.100, "lut": 800},
    "route_35": {"step": "impl", "success": False, "return_code": 2,
        "errors": ["ERROR: [Route 35-12] Routing failed — 15 nets unrouted"], "wns": -1.8, "lut": 3200},
}

def _find_vivado() -> str | None:
    vivado = shutil.which("vivado")
    if vivado: return vivado
    from glob import glob
    for p in ["/opt/Xilinx/Vivado/*/bin/vivado", "/tools/Xilinx/Vivado/*/bin/vivado", "/home/*/Xilinx/Vivado/*/bin/vivado"]:
        m = sorted(glob(p))
        if m: return m[-1]
    return None

def _remote_config() -> dict | None:
    host = os.environ.get("VIVADO_REMOTE_HOST", "")
    if host:
        return {"host": host, "key": os.environ.get("VIVADO_REMOTE_KEY", ""),
            "vivado_path": os.environ.get("VIVADO_REMOTE_PATH", "vivado"),
            "env_script": os.environ.get("VIVADO_REMOTE_ENV", ""),
            "work_dir": os.environ.get("VIVADO_REMOTE_WORK", "/tmp/edagent_remote")}
    return None

class VivadoRunner:
    def __init__(self, workspace: Workspace, manifest: Manifest, vivado_path: str | None = None,
                 force_mock: bool = False, mock_fail: str | None = None) -> None:
        self._workspace = workspace; self._manifest = manifest; self._mock_fail = mock_fail; self._remote_cfg = None
        if force_mock: self._mock = True; self._vivado_path = None; self._remote_cfg = None
        else:
            self._remote_cfg = _remote_config()
            if self._remote_cfg:
                self._mock = False; self._vivado_path = self._remote_cfg["vivado_path"]
                logger.info("Remote Vivado: %s", self._remote_cfg["host"])
            else:
                self._vivado_path = vivado_path or _find_vivado(); self._mock = self._vivado_path is None
        if self._mock:
            if self._mock_fail and self._mock_fail in MOCK_FAILURE_SCENARIOS:
                logger.info("MOCK + fail: %s", self._mock_fail)
            else: logger.info("MOCK mode")

    @property
    def is_mock(self) -> bool: return self._mock
    @property
    def mock_fail(self) -> str | None: return self._mock_fail

    def run_synth(self) -> dict[str, Any]:
        tcl = generate_synth_tcl(self._manifest, self._workspace.root)
        tcl_path = self._workspace.script_path("synth.tcl"); tcl_path.write_text(tcl)
        if self._remote_cfg: result = self._remote_run("synth", tcl_path)
        elif self._mock: result = self._mock_synth(tcl_path)
        else:
            runner = CommandRunner(workspace_root=self._workspace.root, vivado_path=self._vivado_path)
            cr = runner.run(f"vivado -mode batch -source {tcl_path} -log {self._workspace.root / 'vivado_synth.log'}", timeout=7200, log_label="vivado_synth")
            result = {"step": "synth", "success": cr.return_code == 0, "return_code": cr.return_code, "log": cr.stdout_path, "stderr": cr.stderr_path, "elapsed_sec": cr.elapsed_sec, "timed_out": cr.timed_out, "mock": False}
        return result

    def run_impl(self) -> dict[str, Any]:
        tcl = generate_impl_tcl(self._manifest, self._workspace.root)
        tcl_path = self._workspace.script_path("impl.tcl"); tcl_path.write_text(tcl)
        if self._remote_cfg: result = self._remote_run("impl", tcl_path)
        elif self._mock: result = self._mock_impl(tcl_path)
        else:
            runner = CommandRunner(workspace_root=self._workspace.root, vivado_path=self._vivado_path)
            cr = runner.run(f"vivado -mode batch -source {tcl_path} -log {self._workspace.root / 'vivado_impl.log'}", timeout=7200, log_label="vivado_impl")
            result = {"step": "impl", "success": cr.return_code == 0, "return_code": cr.return_code, "log": cr.stdout_path, "stderr": cr.stderr_path, "elapsed_sec": cr.elapsed_sec, "timed_out": cr.timed_out, "mock": False}
        return result

    def run_synth_with_strategy(self, directive: str, retiming: bool = False) -> dict[str, Any]:
        tcl = generate_synth_tcl(self._manifest, self._workspace.root, directive=directive, retiming=retiming)
        tcl_path = self._workspace.script_path(f"synth_{directive}.tcl"); tcl_path.write_text(tcl)
        if self._mock: result = self._mock_synth(tcl_path, directive=directive)
        else:
            runner = CommandRunner(workspace_root=self._workspace.root, vivado_path=self._vivado_path)
            cr = runner.run(f"vivado -mode batch -source {tcl_path} -log {self._workspace.root / 'vivado_synth.log'}", timeout=7200, log_label=f"vivado_synth_{directive}")
            result = {"step": "synth", "success": cr.return_code == 0, "return_code": cr.return_code, "strategy": directive, "retiming": retiming, "log": cr.stdout_path, "elapsed_sec": cr.elapsed_sec, "timed_out": cr.timed_out, "mock": False}
        return result

    def run_simulation(self, tb_top: str | None = None) -> dict[str, Any]:
        top = tb_top or f"{self._manifest.top()}_tb"
        if not self._manifest.sources.tb: return {"step": "sim", "success": False, "error": "No testbench sources"}
        if self._mock: return self._mock_simulation(top)
        runner = CommandRunner(workspace_root=self._workspace.root, vivado_path=self._vivado_path)
        rtl_args = " ".join(str(r) for r in self._manifest.rtl_paths())
        tb_args = " ".join(str(t) for t in self._manifest.tb_paths())
        cr = runner.run(f"xvlog --sv {rtl_args} {tb_args}", timeout=600, log_label="xvlog")
        if cr.return_code != 0: return {"step": "sim", "success": False, "error": "xvlog failed", "log": cr.stdout_path}
        cr = runner.run(f"xelab {top} -snapshot {top}_snapshot", timeout=600, log_label="xelab")
        if cr.return_code != 0: return {"step": "sim", "success": False, "error": "xelab failed", "log": cr.stdout_path}
        cr = runner.run(f"xsim {top}_snapshot --runall", timeout=3600, log_label="xsim")
        return {"step": "sim", "success": cr.return_code == 0, "return_code": cr.return_code, "log": cr.stdout_path, "elapsed_sec": cr.elapsed_sec}

    def _remote_run(self, step: str, tcl_path: Path) -> dict[str, Any]:
        cfg = self._remote_cfg
        if not cfg: return {"step": step, "success": False, "error": "No remote config"}
        t0 = time.time(); remote_dir = f"{cfg['work_dir']}/{self._workspace.root.name}"
        host = cfg["host"]; vivado = cfg["vivado_path"]; env = cfg["env_script"]
        ssh = ["ssh", "-i", cfg["key"], "-o", "StrictHostKeyChecking=no", host]
        scp = ["scp", "-i", cfg["key"], "-o", "StrictHostKeyChecking=no"]
        tcl_text = tcl_path.read_text(errors="replace")
        for rp in self._manifest.rtl_paths():
            tcl_text = tcl_text.replace(str(rp), f"src/{rp.name}").replace(str(rp).replace("\\", "/"), f"src/{rp.name}")
        for xp in self._manifest.xdc_paths():
            tcl_text = tcl_text.replace(str(xp), f"src/{xp.name}").replace(str(xp).replace("\\", "/"), f"src/{xp.name}")
        tcl_path.write_text(tcl_text)
        try:
            subprocess.run(ssh + [f"mkdir -p {remote_dir}/src {remote_dir}/scripts {remote_dir}/reports {remote_dir}/checkpoints"], capture_output=True, timeout=15)
            subprocess.run(scp + [str(tcl_path), f"{host}:{remote_dir}/scripts/{step}.tcl"], capture_output=True, timeout=30)
            ws_src = self._workspace.root / "src"
            if ws_src.exists() and any(ws_src.iterdir()):
                subprocess.run(scp + ["-r", str(ws_src) + "/*", f"{host}:{remote_dir}/src/"], capture_output=True, timeout=60)
            for rp in self._manifest.rtl_paths():
                if rp.exists() and rp.parent.resolve() != ws_src.resolve():
                    subprocess.run(scp + [str(rp), f"{host}:{remote_dir}/src/{rp.name}"], capture_output=True, timeout=30)
            for xp in self._manifest.xdc_paths():
                if xp.exists() and xp.parent.resolve() != ws_src.resolve():
                    subprocess.run(scp + [str(xp), f"{host}:{remote_dir}/src/{xp.name}"], capture_output=True, timeout=30)
            cmd = f"cd {remote_dir} && source {env} && {vivado} -mode batch -source scripts/{step}.tcl -log vivado_{step}.log"
            proc = subprocess.run(ssh + [cmd], capture_output=True, text=True, timeout=7200)
            for fname in [f"vivado_{step}.log"]:
                subprocess.run(scp + [f"{host}:{remote_dir}/{fname}", str(self._workspace.root / fname)], capture_output=True, timeout=60)
            elapsed = round(time.time() - t0, 2)
            return {"step": step, "success": proc.returncode == 0, "return_code": proc.returncode, "log": str(self._workspace.root / f"vivado_{step}.log"), "elapsed_sec": elapsed, "timed_out": False, "remote": True, "host": host}
        except subprocess.TimeoutExpired: return {"step": step, "success": False, "error": "Timeout", "remote": True}
        except Exception as e: return {"step": step, "success": False, "error": str(e), "remote": True}

    def _mock_synth(self, tcl_path: Path, directive: str = "") -> dict[str, Any]:
        scenario = MOCK_FAILURE_SCENARIOS.get(self._mock_fail or "")
        reports = self._workspace.root / "reports"; ckpt = self._workspace.root / "checkpoints"
        reports.mkdir(parents=True, exist_ok=True); ckpt.mkdir(parents=True, exist_ok=True)
        if scenario and scenario["step"] == "synth": return self._mock_from_scenario(scenario, ckpt, reports, "synth")
        mods = {"Default": (0.123, 1234, 567), "RuntimeOptimized": (0.156, 1190, 550), "AreaOptimized": (0.098, 1010, 480), "AlternateRoutability": (0.210, 1280, 590)}
        wns, lut, ff = mods.get(directive, mods["Default"])
        (ckpt / "post_synth.dcp").write_text("MOCK CHECKPOINT")
        (reports / "post_synth_timing_summary.rpt").write_text(f"=== MOCK TIMING ===\nWNS={wns:.3f}\nTNS=0.000\nWHS=0.045\nTHS=0.000\n")
        (reports / "post_synth_utilization.rpt").write_text(f"=== MOCK UTIL ===\nSlice LUTs: {lut}\nSlice Registers: {ff}\nBRAM: 2\nDSP: 0\n")
        (reports / "post_synth_drc.rpt").write_text("=== MOCK DRC ===\nNo violations.\n")
        log_path = self._workspace.root / "vivado_synth.log"
        log_path.write_text(f"****** Vivado v2022.1 ******\nINFO: [Synth 8-256] Done synthesis (directive: {directive})\nINFO: Synthesis completed\n")
        return {"step": "synth", "success": True, "return_code": 0, "log": str(log_path), "elapsed_sec": 0.42, "timed_out": False, "mock": True}

    def _mock_impl(self, tcl_path: Path) -> dict[str, Any]:
        scenario = MOCK_FAILURE_SCENARIOS.get(self._mock_fail or "")
        reports = self._workspace.root / "reports"; ckpt = self._workspace.root / "checkpoints"
        reports.mkdir(parents=True, exist_ok=True); ckpt.mkdir(parents=True, exist_ok=True)
        if scenario and scenario["step"] == "impl": return self._mock_from_scenario(scenario, ckpt, reports, "impl")
        (ckpt / "post_place.dcp").write_text("MOCK"); (ckpt / "post_route.dcp").write_text("MOCK")
        (reports / "post_impl_timing_summary.rpt").write_text("WNS=0.089\nTNS=0.000\nWHS=0.032\nTHS=0.000\n")
        (reports / "post_impl_utilization.rpt").write_text("LUT: 1300\nFF: 600\nBRAM: 2\nDSP: 0\n")
        (reports / "post_impl_drc.rpt").write_text("No violations.\n")
        (self._workspace.root / "vivado_impl.log").write_text("INFO: Implementation completed\n")
        return {"step": "impl", "success": True, "return_code": 0, "log": str(self._workspace.root / "vivado_impl.log"), "elapsed_sec": 0.63, "timed_out": False, "mock": True}

    def _mock_from_scenario(self, s: dict, ckpt: Path, reports: Path, step: str) -> dict[str, Any]:
        (ckpt / f"post_{'synth' if step == 'synth' else 'route'}.dcp").write_text("MOCK")
        timing = [f"WNS={s['wns']:.3f}" if s.get('wns') is not None else "WNS=N/A", f"TNS={s.get('tns', 0):.3f}", "WHS=0.045", "THS=0.000"]
        (reports / f"post_{step}_timing_summary.rpt").write_text("\n".join(timing))
        util = [f"Slice LUTs: {s.get('lut','N/A')}" if s.get('lut') is not None else "", f"Slice Registers: {s.get('ff','N/A')}" if s.get('ff') is not None else ""]
        (reports / f"post_{step}_utilization.rpt").write_text("\n".join(u for u in util if u))
        drc = "No violations." if s.get("drc_clean", True) else "DRC violations: IO_STANDARD conflict"
        (reports / f"post_{step}_drc.rpt").write_text(drc)
        log_path = self._workspace.root / f"vivado_{step}.log"
        log_lines = [f"****** Vivado v2022.1 ******", f"INFO: Starting {step}"]
        log_lines.extend(s.get("errors", [])); log_lines.extend(s.get("critical_warnings", []))
        log_lines.append(f"{step.capitalize()} {'completed' if s['success'] else 'failed'}")
        log_path.write_text("\n".join(log_lines))
        return {"step": step, "success": s["success"], "return_code": s["return_code"], "log": str(log_path), "elapsed_sec": 0.42, "timed_out": False, "mock": True, "mock_fail": self._mock_fail}

    def _mock_simulation(self, top: str) -> dict[str, Any]:
        (self._workspace.root / "xsim.log").write_text(f"PASS: {top} completed\n")
        return {"step": "sim", "success": True, "return_code": 0, "log": str(self._workspace.root / "xsim.log"), "elapsed_sec": 1.2, "mock": True}
