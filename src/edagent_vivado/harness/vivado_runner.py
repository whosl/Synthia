"""VivadoRunner — controlled Vivado execution with mock fallback + remote SSH.
# nolint: skip-file
"""
from __future__ import annotations
import logging, os, shutil, time, subprocess
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
        "errors": ["ERROR: [Place 30-574] Poor placement"], "wns": None, "lut": 45000, "ff": 120000},
    "drc_violation": {"step": "impl", "success": True, "return_code": 0, "drc_clean": False,
        "critical_warnings": ["CRITICAL WARNING: DRC violation"], "wns": 0.100, "lut": 800},
    "route_35": {"step": "impl", "success": False, "return_code": 2,
        "errors": ["ERROR: [Route 35-12] Routing failed"], "wns": -1.8, "lut": 3200},
}

def _find_vivado() -> str | None:
    v = shutil.which("vivado")
    if v: return v
    from glob import glob
    for p in ["/opt/Xilinx/Vivado/*/bin/vivado", "/tools/Xilinx/Vivado/*/bin/vivado", "/home/*/Xilinx/Vivado/*/bin/vivado"]:
        m = sorted(glob(p))
        if m: return m[-1]
    return None

def _remote_config() -> dict | None:
    h = os.environ.get("VIVADO_REMOTE_HOST", "")
    if h:
        port = os.environ.get("VIVADO_REMOTE_PORT", "")
        return {
            "host": h,
            "key": os.environ.get("VIVADO_REMOTE_KEY", ""),
            "vivado_path": os.environ.get("VIVADO_REMOTE_PATH", "vivado"),
            "env_script": os.environ.get("VIVADO_REMOTE_ENV", ""),
            "work_dir": os.environ.get("VIVADO_REMOTE_WORK", "/tmp/edagent_remote"),
            "port": port,
        }
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
            logger.info("MOCK mode%s", " + fail: " + self._mock_fail if self._mock_fail and self._mock_fail in MOCK_FAILURE_SCENARIOS else "")

    @property
    def is_mock(self) -> bool: return self._mock
    @property
    def mock_fail(self) -> str | None: return self._mock_fail

    def run_synth(self) -> dict[str, Any]:
        tcl = generate_synth_tcl(self._manifest, self._workspace.root)
        p = self._workspace.script_path("synth.tcl"); p.write_text(tcl)
        if self._remote_cfg: return self._remote_run("synth", p)
        if self._mock: return self._mock_synth(p)
        cr = CommandRunner(workspace_root=self._workspace.root, vivado_path=self._vivado_path).run(
            f"vivado -mode batch -source {p} -log {self._workspace.root / 'vivado_synth.log'}", timeout=7200, log_label="vivado_synth")
        return {"step": "synth", "success": cr.return_code == 0, "return_code": cr.return_code, "log": cr.stdout_path, "elapsed_sec": cr.elapsed_sec, "timed_out": cr.timed_out, "mock": False}

    def run_impl(self) -> dict[str, Any]:
        tcl = generate_impl_tcl(self._manifest, self._workspace.root)
        p = self._workspace.script_path("impl.tcl"); p.write_text(tcl)
        if self._remote_cfg: return self._remote_run("impl", p)
        if self._mock: return self._mock_impl(p)
        cr = CommandRunner(workspace_root=self._workspace.root, vivado_path=self._vivado_path).run(
            f"vivado -mode batch -source {p} -log {self._workspace.root / 'vivado_impl.log'}", timeout=7200, log_label="vivado_impl")
        return {"step": "impl", "success": cr.return_code == 0, "return_code": cr.return_code, "log": cr.stdout_path, "elapsed_sec": cr.elapsed_sec, "timed_out": cr.timed_out, "mock": False}

    def run_synth_with_strategy(self, directive: str, retiming: bool = False) -> dict[str, Any]:
        tcl = generate_synth_tcl(self._manifest, self._workspace.root, directive=directive, retiming=retiming)
        p = self._workspace.script_path(f"synth_{directive}.tcl"); p.write_text(tcl)
        if self._mock: return self._mock_synth(p, directive=directive)
        cr = CommandRunner(workspace_root=self._workspace.root, vivado_path=self._vivado_path).run(
            f"vivado -mode batch -source {p} -log {self._workspace.root / 'vivado_synth.log'}", timeout=7200, log_label=f"vivado_synth_{directive}")
        return {"step": "synth", "success": cr.return_code == 0, "return_code": cr.return_code, "strategy": directive, "log": cr.stdout_path, "elapsed_sec": cr.elapsed_sec, "timed_out": cr.timed_out, "mock": False}

    def run_simulation(self, tb_top: str | None = None) -> dict[str, Any]:
        top = tb_top or f"{self._manifest.top()}_tb"
        if not self._manifest.sources.tb: return {"step": "sim", "success": False, "error": "No testbench sources"}
        if self._mock: return self._mock_simulation(top)
        r = CommandRunner(workspace_root=self._workspace.root, vivado_path=self._vivado_path)
        rtl = " ".join(str(x) for x in self._manifest.rtl_paths())
        tb = " ".join(str(x) for x in self._manifest.tb_paths())
        for cmd, label in [(f"xvlog --sv {rtl} {tb}", "xvlog"), (f"xelab {top} -snapshot {top}_snapshot", "xelab"), (f"xsim {top}_snapshot --runall", "xsim")]:
            cr = r.run(cmd, timeout=3600 if label == "xsim" else 600, log_label=label)
            if cr.return_code != 0: return {"step": "sim", "success": False, "error": f"{label} failed", "log": cr.stdout_path}
        return {"step": "sim", "success": True, "log": cr.stdout_path, "elapsed_sec": cr.elapsed_sec}

    def _remote_run(self, step: str, tcl_path: Path) -> dict[str, Any]:
        cfg = self._remote_cfg
        if not cfg: return {"step": step, "success": False, "error": "No remote config"}
        t0 = time.time(); rd = f"{cfg['work_dir']}/{self._workspace.root.name}"
        h = cfg["host"]; v = cfg["vivado_path"]; e = cfg["env_script"]
        port = cfg.get("port", "")
        ssh = ["ssh", "-i", cfg["key"], "-o", "StrictHostKeyChecking=no"]
        if port: ssh += ["-p", str(port)]
        ssh.append(h)
        scp = ["scp", "-i", cfg["key"], "-o", "StrictHostKeyChecking=no"]
        if port: scp += ["-P", str(port)]
        tc = tcl_path.read_text(errors="replace")
        for rp in self._manifest.rtl_paths(): tc = tc.replace(str(rp), f"src/{rp.name}").replace(str(rp).replace("\\", "/"), f"src/{rp.name}")
        for xp in self._manifest.xdc_paths(): tc = tc.replace(str(xp), f"src/{xp.name}").replace(str(xp).replace("\\", "/"), f"src/{xp.name}")
        tcl_path.write_text(tc)
        try:
            subprocess.run(ssh + [f"mkdir -p {rd}/src {rd}/scripts {rd}/reports {rd}/checkpoints"], capture_output=True, timeout=15)
            subprocess.run(scp + [str(tcl_path), f"{h}:{rd}/scripts/{step}.tcl"], capture_output=True, timeout=30)
            ws = self._workspace.root / "src"
            if ws.exists() and any(ws.iterdir()): subprocess.run(scp + ["-r", str(ws) + "/*", f"{h}:{rd}/src/"], capture_output=True, timeout=60)
            for rp in self._manifest.rtl_paths():
                if rp.exists() and rp.parent.resolve() != ws.resolve(): subprocess.run(scp + [str(rp), f"{h}:{rd}/src/{rp.name}"], capture_output=True, timeout=30)
            for xp in self._manifest.xdc_paths():
                if xp.exists() and xp.parent.resolve() != ws.resolve(): subprocess.run(scp + [str(xp), f"{h}:{rd}/src/{xp.name}"], capture_output=True, timeout=30)
            cmd = f"cd {rd} && source {e} && {v} -mode batch -source scripts/{step}.tcl -log vivado_{step}.log"
            proc = subprocess.run(ssh + [cmd], capture_output=True, text=True, timeout=7200)
            for fn in [f"vivado_{step}.log"]: subprocess.run(scp + [f"{h}:{rd}/{fn}", str(self._workspace.root / fn)], capture_output=True, timeout=60)
            out = {
                "step": step,
                "success": proc.returncode == 0,
                "return_code": proc.returncode,
                "log": str(self._workspace.root / f"vivado_{step}.log"),
                "elapsed_sec": round(time.time() - t0, 2),
                "timed_out": False,
                "remote": True,
                "mock": False,
                "host": h,
            }
            if proc.returncode != 0:
                out["error"] = (proc.stderr or proc.stdout or f"Remote {step} failed").strip()[:2000]
            return out
        except subprocess.TimeoutExpired: return {"step": step, "success": False, "error": "Timeout", "remote": True}
        except Exception as ex: return {"step": step, "success": False, "error": str(ex), "remote": True}

    def _mock_synth(self, tcl_path: Path, directive: str = "") -> dict[str, Any]:
        s = MOCK_FAILURE_SCENARIOS.get(self._mock_fail or "")
        rp = self._workspace.root / "reports"; ck = self._workspace.root / "checkpoints"
        rp.mkdir(parents=True, exist_ok=True); ck.mkdir(parents=True, exist_ok=True)
        if s and s["step"] == "synth": return self._mock_do(s, ck, rp, "synth")
        mod = {"Default": (0.123, 1234, 567), "RuntimeOptimized": (0.156, 1190, 550), "AreaOptimized": (0.098, 1010, 480), "AlternateRoutability": (0.210, 1280, 590)}.get(directive, (0.123, 1234, 567))
        w, l, f = mod
        (ck / "post_synth.dcp").write_text("MOCK")
        (rp / "post_synth_timing_summary.rpt").write_text(f"WNS={w:.3f}\nTNS=0.000\nWHS=0.045\nTHS=0.000\n")
        (rp / "post_synth_utilization.rpt").write_text(f"Slice LUTs: {l}\nSlice Registers: {f}\nBRAM: 2\nDSP: 0\n")
        (rp / "post_synth_drc.rpt").write_text("No violations.\n")
        lg = self._workspace.root / "vivado_synth.log"
        lg.write_text(f"****** Vivado v2022.1 ******\nINFO: Synthesis done (directive: {directive})\n")
        return {"step": "synth", "success": True, "return_code": 0, "log": str(lg), "elapsed_sec": 0.42, "timed_out": False, "mock": True}

    def _mock_impl(self, tcl_path: Path) -> dict[str, Any]:
        s = MOCK_FAILURE_SCENARIOS.get(self._mock_fail or "")
        rp = self._workspace.root / "reports"; ck = self._workspace.root / "checkpoints"
        rp.mkdir(parents=True, exist_ok=True); ck.mkdir(parents=True, exist_ok=True)
        if s and s["step"] == "impl": return self._mock_do(s, ck, rp, "impl")
        (ck / "post_place.dcp").write_text("MOCK"); (ck / "post_route.dcp").write_text("MOCK")
        (rp / "post_impl_timing_summary.rpt").write_text("WNS=0.089\nTNS=0.000\nWHS=0.032\nTHS=0.000\n")
        (rp / "post_impl_utilization.rpt").write_text("LUT: 1300\nFF: 600\nBRAM: 2\nDSP: 0\n")
        (rp / "post_impl_drc.rpt").write_text("No violations.\n")
        (self._workspace.root / "vivado_impl.log").write_text("INFO: Implementation done\n")
        return {"step": "impl", "success": True, "return_code": 0, "log": str(self._workspace.root / "vivado_impl.log"), "elapsed_sec": 0.63, "timed_out": False, "mock": True}

    def _mock_do(self, s: dict, ck: Path, rp: Path, step: str) -> dict[str, Any]:
        (ck / f"post_{'synth' if step == 'synth' else 'route'}.dcp").write_text("MOCK")
        t = [f"WNS={s['wns']:.3f}" if s.get('wns') is not None else "WNS=N/A", f"TNS={s.get('tns', 0):.3f}", "WHS=0.045", "THS=0.000"]
        (rp / f"post_{step}_timing_summary.rpt").write_text("\n".join(t))
        u = [x for x in [f"Slice LUTs: {s['lut']}" if s.get('lut') is not None else "", f"Slice Registers: {s.get('ff','')}" if s.get('ff') is not None else ""] if x]
        (rp / f"post_{step}_utilization.rpt").write_text("\n".join(u) if u else "N/A")
        (rp / f"post_{step}_drc.rpt").write_text("No violations." if s.get("drc_clean", True) else "DRC violation")
        lg = self._workspace.root / f"vivado_{step}.log"
        ll = [f"****** Vivado v2022.1 ******", f"INFO: Starting {step}"] + s.get("errors", []) + s.get("critical_warnings", [])
        ll.append(f"{step.capitalize()} {'completed' if s['success'] else 'failed'}")
        lg.write_text("\n".join(ll))
        return {"step": step, "success": s["success"], "return_code": s["return_code"], "log": str(lg), "elapsed_sec": 0.42, "timed_out": False, "mock": True, "mock_fail": self._mock_fail}

    def _mock_simulation(self, top: str) -> dict[str, Any]:
        (self._workspace.root / "xsim.log").write_text(f"PASS: {top}\n")
        return {"step": "sim", "success": True, "return_code": 0, "log": str(self._workspace.root / "xsim.log"), "elapsed_sec": 1.2, "mock": True}
