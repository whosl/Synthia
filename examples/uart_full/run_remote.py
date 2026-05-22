"""Run UART Echo full flow on remote Vivado via SSH.

Usage:
    python run_remote.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

# ── config ─────────────────────────────────────────────────────

HOST = "root@192.168.31.150"
IDENTITY_FILE = "E:/dev/id_192.168.31.150"
VIVADO_PATH = "/home/xilinx/vivado/Vivado/2022.1/bin/vivado"
ENV_SCRIPT = "/home/xilinx/vivado/Vivado/2022.1/settings64.sh"
REMOTE_BASE = "/tmp/edagent_uart_echo"

PROJECT_DIR = Path(__file__).parent.resolve()


def ssh_args() -> list[str]:
    return [
        "ssh", "-o", "StrictHostKeyChecking=accept-new",
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        "-i", IDENTITY_FILE, HOST,
    ]


def scp_args() -> list[str]:
    return [
        "scp", "-o", "StrictHostKeyChecking=accept-new",
        "-o", "BatchMode=yes",
        "-i", IDENTITY_FILE,
    ]


def remote_cmd(cmd: str) -> list[str]:
    full = f"source {ENV_SCRIPT} && {cmd}" if ENV_SCRIPT else cmd
    return ssh_args() + [full]


def run(cmd: list[str], timeout: int = 600) -> tuple[int, str, str]:
    """Run a local command, return (return_code, stdout, stderr)."""
    print(f"  [CMD] {' '.join(cmd)[:200]}")
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "TIMEOUT"
    except Exception as e:
        return -1, "", str(e)


# ── main flow ──────────────────────────────────────────────────


def main():
    print("=" * 60)
    print(" EdAgent-Vivado: UART Echo — Remote Vivado Flow")
    print(f" Target: {HOST}")
    print(f" Project: {PROJECT_DIR}")
    print("=" * 60)

    t_total = time.time()

    # ── Step 1: Test connection ────────────────────────────────
    print("\n[1/6] Testing SSH connectivity ...")
    rc, out, err = run(remote_cmd("echo OK && uname -a"), timeout=30)
    if rc != 0 or "OK" not in out:
        print(f"  FAILED: SSH connection error")
        print(f"  stdout: {out[:500]}")
        print(f"  stderr: {err[:500]}")
        sys.exit(1)
    print(f"  OK: {out.strip().splitlines()[0] if out.strip() else 'connected'}")

    # ── Step 2: Check Vivado ───────────────────────────────────
    print("\n[2/6] Checking Vivado on remote ...")
    rc, out, err = run(remote_cmd(f"{VIVADO_PATH} -version"), timeout=60)
    if rc != 0:
        print(f"  FAILED: Vivado not found")
        sys.exit(1)
    version_line = [l for l in out.splitlines() if "Vivado" in l]
    print(f"  Vivado: {version_line[0] if version_line else out.strip()[:100]}")

    # ── Step 3: Upload project files ───────────────────────────
    print("\n[3/6] Uploading project to remote ...")
    upload_files = []
    for f in (PROJECT_DIR / "rtl").glob("*.v"):
        upload_files.append(f)
    for f in (PROJECT_DIR / "constrs").glob("*.xdc"):
        upload_files.append(f)

    rc, _, err = run(remote_cmd(f"rm -rf {REMOTE_BASE} && mkdir -p {REMOTE_BASE}/rtl {REMOTE_BASE}/constrs {REMOTE_BASE}/reports {REMOTE_BASE}/checkpoints"), timeout=30)
    if rc != 0:
        print(f"  FAILED to create remote dir: {err}")
        sys.exit(1)

    for f in upload_files:
        rel = str(f.relative_to(PROJECT_DIR)).replace("\\", "/")
        dest = f"{HOST}:{REMOTE_BASE}/{rel}"
        rc, _, err = run(scp_args() + [str(f), dest], timeout=60)
        if rc != 0:
            print(f"  FAILED uploading {rel}: {err}")
            sys.exit(1)
        print(f"  Uploaded: {rel}")

    # ── Step 4: Generate and upload Tcl scripts ────────────────
    print("\n[4/6] Generating and uploading Tcl scripts ...")

    # Synthesis Tcl
    synth_tcl = f"""# Auto-generated edagent-vivado synthesis Tcl
puts "INFO: Starting synthesis — uart_echo"

read_verilog {{{REMOTE_BASE}/rtl/uart_rx.v}}
read_verilog {{{REMOTE_BASE}/rtl/uart_tx.v}}
read_verilog {{{REMOTE_BASE}/rtl/uart_top.v}}
read_xdc {{{REMOTE_BASE}/constrs/arty.xdc}}

synth_design -top uart_top -part xc7a35ticsg324-1L

write_checkpoint -force {{{REMOTE_BASE}/checkpoints/post_synth.dcp}}
report_timing_summary -file {{{REMOTE_BASE}/reports/post_synth_timing_summary.rpt}}
report_utilization -file {{{REMOTE_BASE}/reports/post_synth_utilization.rpt}}
report_drc -file {{{REMOTE_BASE}/reports/post_synth_drc.rpt}}

puts "INFO: Synthesis completed successfully"
exit
"""
    synth_local = PROJECT_DIR / "synth.tcl"
    synth_local.write_text(synth_tcl)
    rc, _, err = run(
        scp_args() + [str(synth_local), f"{HOST}:{REMOTE_BASE}/synth.tcl"],
        timeout=30,
    )
    synth_local.unlink()

    # Implementation Tcl
    impl_tcl = f"""# Auto-generated edagent-vivado implementation Tcl
puts "INFO: Starting implementation — uart_echo"

open_checkpoint {{{REMOTE_BASE}/checkpoints/post_synth.dcp}}

opt_design
place_design
write_checkpoint -force {{{REMOTE_BASE}/checkpoints/post_place.dcp}}
route_design
write_checkpoint -force {{{REMOTE_BASE}/checkpoints/post_route.dcp}}

report_timing_summary -file {{{REMOTE_BASE}/reports/post_impl_timing_summary.rpt}}
report_utilization -file {{{REMOTE_BASE}/reports/post_impl_utilization.rpt}}
report_drc -file {{{REMOTE_BASE}/reports/post_impl_drc.rpt}}

puts "INFO: Implementation completed successfully"
exit
"""
    impl_local = PROJECT_DIR / "impl.tcl"
    impl_local.write_text(impl_tcl)
    rc, _, err = run(
        scp_args() + [str(impl_local), f"{HOST}:{REMOTE_BASE}/impl.tcl"],
        timeout=30,
    )
    impl_local.unlink()
    print("  Tcl scripts uploaded")

    # ── Step 5: Run Vivado Synthesis & Implementation ──────────
    print("\n[5/6] Running Vivado Synthesis + Implementation on remote ...")

    t_synth = time.time()
    synth_log_remote = f"{REMOTE_BASE}/vivado_synth.log"
    rc, out, err = run(
        remote_cmd(
            f"cd {REMOTE_BASE} && "
            f"{VIVADO_PATH} -mode batch -source synth.tcl "
            f"-log {synth_log_remote}"
        ),
        timeout=600,
    )
    synth_elapsed = round(time.time() - t_synth, 1)
    synth_ok = rc == 0
    print(f"  Synthesis: {'PASS' if synth_ok else 'FAIL'} ({synth_elapsed}s)")

    impl_ok = False
    impl_elapsed = 0.0
    if synth_ok:
        t_impl = time.time()
        impl_log_remote = f"{REMOTE_BASE}/vivado_impl.log"
        rc, out, err = run(
            remote_cmd(
                f"cd {REMOTE_BASE} && "
                f"{VIVADO_PATH} -mode batch -source impl.tcl "
                f"-log {impl_log_remote}"
            ),
            timeout=600,
        )
        impl_elapsed = round(time.time() - t_impl, 1)
        impl_ok = rc == 0
        print(f"  Implementation: {'PASS' if impl_ok else 'FAIL'} ({impl_elapsed}s)")
    else:
        print("  Implementation: SKIPPED (synthesis failed)")

    # ── Step 6: Download results ───────────────────────────────
    print("\n[6/6] Downloading results ...")

    results_dir = PROJECT_DIR / "remote_results"
    results_dir.mkdir(exist_ok=True)

    for fname in [
        "vivado_synth.log",
        "vivado_impl.log",
        "reports/post_synth_timing_summary.rpt",
        "reports/post_synth_utilization.rpt",
        "reports/post_synth_drc.rpt",
        "reports/post_impl_timing_summary.rpt",
        "reports/post_impl_utilization.rpt",
        "reports/post_impl_drc.rpt",
    ]:
        local = results_dir / fname
        local.parent.mkdir(parents=True, exist_ok=True)
        rc, _, err = run(
            scp_args() + [f"{HOST}:{REMOTE_BASE}/{fname}", str(local)],
            timeout=60,
        )
        if rc == 0:
            print(f"  Downloaded: {fname}")
        else:
            if "No such file" in err or "No such file" in _get_scp_stderr(rc, err):
                print(f"  Not found: {fname}")
            else:
                print(f"  Skip: {fname}")

    # ── Parse and summarize ─────────────────────────────────────
    print("\n" + "=" * 60)
    print(" RESULTS SUMMARY")
    print("=" * 60)

    # Parse timing
    timing_path = results_dir / "reports" / "post_synth_timing_summary.rpt"
    if timing_path.exists():
        from edagent_vivado.parsers.timing_parser import parse_timing_summary
        ts = parse_timing_summary(timing_path.read_text(errors="replace"))
        if ts:
            print(f"\n  Timing (post-synth):")
            print(f"    WNS = {ts.wns} ns")
            print(f"    TNS = {ts.tns} ns")
            print(f"    WHS = {ts.whs} ns")
            print(f"    THS = {ts.ths} ns")
            qor_note = "PASS (WNS >= 0)" if (ts.wns or 0) >= 0 else "FAIL (negative WNS)"
            print(f"    QoR: {qor_note}")

    impl_timing_path = results_dir / "reports" / "post_impl_timing_summary.rpt"
    if impl_timing_path.exists():
        from edagent_vivado.parsers.timing_parser import parse_timing_summary
        its = parse_timing_summary(impl_timing_path.read_text(errors="replace"))
        if its:
            print(f"\n  Timing (post-impl):")
            print(f"    WNS = {its.wns} ns")
            print(f"    TNS = {its.tns} ns")
            print(f"    WHS = {its.whs} ns")
            print(f"    THS = {its.ths} ns")

    # Parse utilization
    util_path = results_dir / "reports" / "post_synth_utilization.rpt"
    if util_path.exists():
        from edagent_vivado.parsers.utilization_parser import parse_utilization
        us = parse_utilization(util_path.read_text(errors="replace"))
        if us:
            print(f"\n  Utilization (post-synth):")
            print(f"    LUT  = {us.lut}")
            print(f"    FF   = {us.ff}")
            print(f"    BRAM = {us.bram}")
            print(f"    DSP  = {us.dsp}")

    # Check for errors
    log_path = results_dir / "vivado_synth.log"
    if log_path.exists():
        from edagent_vivado.parsers.vivado_log_parser import parse_vivado_log
        ls = parse_vivado_log(log_path.read_text(errors="replace"))
        if ls.error_count > 0:
            print(f"\n  Synthesis Log: {ls.error_count} ERROR(s), {ls.critical_warning_count} CRITICAL WARNING(s)")
            for sig in ls.top_error_signatures[:5]:
                print(f"    - {sig}")
        else:
            print(f"\n  Synthesis Log: CLEAN (0 errors)")

    total_elapsed = round(time.time() - t_total, 1)
    print(f"\n  Total elapsed: {total_elapsed}s")
    print(f"  Remote dir: {REMOTE_BASE}")
    print(f"  Local results: {results_dir}")

    # Write JSON summary
    summary = {
        "project": "uart_echo",
        "part": "xc7a35ticsg324-1L",
        "host": HOST,
        "synth_passed": synth_ok,
        "synth_elapsed_sec": synth_elapsed,
        "impl_passed": impl_ok,
        "impl_elapsed_sec": impl_elapsed,
        "total_elapsed_sec": total_elapsed,
    }
    summary_path = results_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2))
    print(f"  Summary: {summary_path}")

    return 0 if synth_ok else 1


def _get_scp_stderr(rc: int, err: str) -> str:
    return err


if __name__ == "__main__":
    sys.exit(main())
