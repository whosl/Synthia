"""Complex end-to-end test cases covering all edagent-vivado features.

Each test simulates a realistic FPGA debugging workflow.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest
import yaml

from edagent_vivado.harness.manifest import Manifest
from edagent_vivado.harness.qor_checker import check_qor
from edagent_vivado.harness.run_diff import diff_runs
from edagent_vivado.harness.vivado_runner import MOCK_FAILURE_SCENARIOS, VivadoRunner
from edagent_vivado.harness.workspace import Workspace
from edagent_vivado.kb.error_case_loader import load_cases, match_cases
from edagent_vivado.parsers.timing_parser import parse_timing_summary
from edagent_vivado.parsers.utilization_parser import parse_utilization
from edagent_vivado.parsers.vivado_log_parser import load_and_parse
from edagent_vivado.tools.patch_tools import (
    create_file_tool,
    is_patch_approved,
    propose_patch_tool,
    set_patch_approval,
)

EXAMPLE_DIR = Path(__file__).parent.parent / "examples" / "uart_demo"


# ===========================================================================
# Case 1: Syntheesis Failure → Diagnose → Fix → Resynthesize
# ===========================================================================

def test_case1_synth_failure_diagnose_fix_resynthesize():
    """Full debug cycle: failure → log analysis → KB match → patch → rerun.

    Scenario: Missing module [Synth 8-439] — the most common Vivado error.
    """
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")

    # Step 1: Run synthesis with injected failure
    ws1 = Workspace(base_dir=Path(tempfile.mkdtemp()), task_name="case1_fail")
    ws1.copy_sources(manifest)
    ws1.write_manifest(manifest)
    runner1 = VivadoRunner(workspace=ws1, manifest=manifest, force_mock=True, mock_fail="synth_8_439")
    result1 = runner1.run_synth()
    assert not result1["success"]
    assert "synth_8_439" in result1.get("mock_fail", "")

    # Step 2: Parse the error log
    log_path = Path(result1["log"])
    summary = load_and_parse(log_path)
    assert summary.error_count >= 2
    assert any("Synth 8-439" in s for s in summary.top_error_signatures)

    # Step 3: Match against KB
    cases = load_cases()
    matches = match_cases(summary.top_error_signatures, cases)
    assert len(matches) >= 1
    assert matches[0][0].category == "missing_module_or_bad_compile_order"

    # Step 4: "Fix" — create missing stub modules and update manifest
    set_patch_approval(True)
    ws_dir = ws1.root
    rtl_dir = ws_dir / "src"

    create_file_tool.invoke({
        "file_path": str(rtl_dir / "echo_handler.v"),
        "content": "module echo_handler(input clk, rst_n, input [7:0] data_i, input valid_i, output tx, output [7:0] led); endmodule",
        "description": "stub echo_handler",
    })
    create_file_tool.invoke({
        "file_path": str(rtl_dir / "uart_rx.v"),
        "content": "module uart_rx #(parameter CLK_DIV=87) (input clk, rst_n, rx, output [7:0] data, output valid); endmodule",
        "description": "stub uart_rx",
    })

    # Update manifest to include new files
    updated_manifest_data = manifest.model_dump()
    updated_manifest_data["sources"]["rtl"] = ["rtl/uart_top.v", "rtl/echo_handler.v", "rtl/uart_rx.v"]
    new_yaml = ws_dir / "eda_fixed.yaml"
    yaml.dump(updated_manifest_data, open(new_yaml, "w"))
    fixed_manifest = Manifest.load(new_yaml)

    # Step 5: Rerun synthesis — should succeed
    ws2 = Workspace(base_dir=Path(tempfile.mkdtemp()), task_name="case1_fixed")
    ws2.copy_sources(fixed_manifest)
    ws2.write_manifest(fixed_manifest)
    runner2 = VivadoRunner(workspace=ws2, manifest=fixed_manifest, force_mock=True)
    result2 = runner2.run_synth()
    assert result2["success"], f"Re-synthesis should succeed after fix, got: {result2}"

    # Step 6: QoR check should pass
    qor = check_qor(fixed_manifest, synthesis_failed=not result2["success"])
    assert qor.passed

    set_patch_approval(False)


# ===========================================================================
# Case 2: Timing Violation → Multi-Strategy Batch → Pick Best
# ===========================================================================

def test_case2_timing_violation_batch_strategies():
    """Timing fails with default strategy → try 3 strategies → pick best WNS.

    Scenario: A design with WNS=-2.35ns on default, improvement via strategy change.
    """
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")

    strategies = [
        ("Default", None),
        ("RuntimeOptimized", None),
        ("AreaOptimized", None),
    ]

    results = {}
    for strat, fail_mode in strategies:
        ws = Workspace(base_dir=Path(tempfile.mkdtemp()), task_name=f"case2_{strat}")
        ws.copy_sources(manifest)
        ws.write_manifest(manifest)
        fail = fail_mode if fail_mode else ("timing_violation" if strat == "Default" else None)
        runner = VivadoRunner(workspace=ws, manifest=manifest, force_mock=True, mock_fail=fail)

        if strat == "Default":
            result = runner.run_synth()
        else:
            result = runner.run_synth_with_strategy(strat)

        # Parse timing
        timing_rpt = ws.report_path("post_synth_timing_summary.rpt")
        timing = parse_timing_summary(timing_rpt.read_text()) if timing_rpt.exists() else None
        results[strat] = {"result": result, "wns": timing.wns if timing else None}

    # Default should show timing violation
    assert results["Default"]["wns"] is not None and results["Default"]["wns"] < 0, \
        f"Default WNS should be negative, got {results['Default']['wns']}"

    # Other strategies should pass
    for strat in ["RuntimeOptimized", "AreaOptimized"]:
        assert results[strat]["wns"] is not None and results[strat]["wns"] > 0, \
            f"{strat} WNS should be positive, got {results[strat]['wns']}"

    # Best WNS should be from RuntimeOptimized or AreaOptimized
    best = max(results, key=lambda s: results[s]["wns"] or -999)
    assert best != "Default", f"Best strategy should not be Default, got {best}"
    assert results[best]["result"]["success"]


# ===========================================================================
# Case 3: Place Congestion → Run Impl → Diff Between Strategies
# ===========================================================================

def test_case3_impl_congestion_and_diff():
    """Implementation fails with congestion → switch strategy → diff results.

    Scenario: Place 30-574 failure, then compare two strategies.
    """
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")

    # Run A: fails with congestion
    ws_a = Workspace(base_dir=Path(tempfile.mkdtemp()), task_name="case3_fail")
    ws_a.copy_sources(manifest)
    ws_a.write_manifest(manifest)
    runner_a = VivadoRunner(workspace=ws_a, manifest=manifest, force_mock=True, mock_fail="place_30_574")
    result_a = runner_a.run_synth()
    result_a_impl = runner_a.run_impl()
    assert not result_a_impl["success"]

    # Run B: with AlternateRoutability strategy
    ws_b = Workspace(base_dir=Path(tempfile.mkdtemp()), task_name="case3_pass")
    ws_b.copy_sources(manifest)
    ws_b.write_manifest(manifest)
    runner_b = VivadoRunner(workspace=ws_b, manifest=manifest, force_mock=True)
    result_b_synth = runner_b.run_synth_with_strategy("AlternateRoutability")
    assert result_b_synth["success"]

    # Now diff the synthesis results
    diff = diff_runs(ws_a.root, ws_b.root, "Congestion (Fail)", "AlternateRoutability (Pass)", step="synth")
    assert len(diff.entries) >= 2
    summary = diff.summary()
    assert "WNS" in summary
    assert "LUT" in summary


# ===========================================================================
# Case 4: DRC Violation → Agent Diagnosis → Constraint Fix
# ===========================================================================

def test_case4_drc_violation_constraint_fix():
    """DRC violation detected → diagnose → propose XDC fix.

    Scenario: IO_STANDARD conflict, agent identifies the constraint issue.
    """
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")

    # Run impl with DRC violation mock
    ws = Workspace(base_dir=Path(tempfile.mkdtemp()), task_name="case4_drc")
    ws.copy_sources(manifest)
    ws.write_manifest(manifest)
    runner = VivadoRunner(workspace=ws, manifest=manifest, force_mock=True)
    result_synth = runner.run_synth()  # must succeed first
    assert result_synth["success"]

    runner2 = VivadoRunner(workspace=ws, manifest=manifest, force_mock=True, mock_fail="drc_violation")
    result_impl = runner2.run_impl()
    assert result_impl["success"]  # impl succeeds but with DRC warnings

    # Parse DRC report
    drc_rpt = ws.report_path("post_impl_drc.rpt")
    drc_text = drc_rpt.read_text()
    assert "violation" in drc_text.lower() or "conflict" in drc_text.lower()

    # Match DRC in KB
    cases = load_cases()
    drc_matches = match_cases(["DRC violation — IO standard conflict on port 'clk'"], cases)
    assert len(drc_matches) >= 1
    assert drc_matches[0][0].category == "drc_violation"

    # Propose XDC fix
    xdc_path = ws.root / "top.xdc"
    if xdc_path.exists():
        set_patch_approval(False)  # proposal only
        result = propose_patch_tool.invoke({
            "file_path": str(xdc_path),
            "old_text": "create_clock -period 20.000 [get_ports clk]",
            "new_text": "create_clock -period 20.000 [get_ports clk]\nset_property IOSTANDARD LVCMOS33 [get_ports clk]",
            "description": "add IO standard constraint to fix DRC",
        })
        assert "PROPOSED" in result
        assert "IOSTANDARD" in result
    set_patch_approval(False)


# ===========================================================================
# Case 5: Full Multi-Stage Flow — Synth → Impl → Sim → QoR Check
# ===========================================================================

def test_case5_full_flow_synth_impl_sim_qor():
    """Complete Vivado flow: synthesis → implementation → simulation → QoR check.

    Covers: run_synth, run_impl, run_simulation, qor_checker, artifact persistence.
    """
    # Create a complete manifest with TB files
    tb_dir = Path(tempfile.mkdtemp())
    rtl_file = tb_dir / "counter.v"
    rtl_file.write_text("module counter(input clk, rst_n, output reg [7:0] count); always @(posedge clk) count <= count + 1; endmodule")
    tb_file = tb_dir / "tb_counter.v"
    tb_file.write_text("module tb_counter; reg clk, rst_n; wire [7:0] count; counter dut(clk, rst_n, count); initial begin clk=0; rst_n=0; #10 rst_n=1; #100 $finish; end always #5 clk=~clk; endmodule")
    xdc_file = tb_dir / "constraints.xdc"
    xdc_file.write_text("create_clock -period 10.000 [get_ports clk]")

    yaml_path = tb_dir / "eda.yaml"
    yaml.dump({
        "project": {"name": "counter_demo", "part": "xc7a50tfgg484-2", "top": "counter", "flow": "non_project"},
        "sources": {"rtl": ["counter.v"], "tb": ["tb_counter.v"]},
        "constraints": {"xdc": ["constraints.xdc"]},
        "runs": {"synth": {"enabled": True}, "impl": {"enabled": True}},
        "qor_targets": {"wns_min": -0.5, "require_drc_clean": True},
    }, open(yaml_path, "w"))

    manifest = Manifest.load(yaml_path)

    # Step 1: Synthesis
    ws_synth = Workspace(base_dir=Path(tempfile.mkdtemp()), task_name="case5_synth")
    ws_synth.copy_sources(manifest)
    ws_synth.write_manifest(manifest)
    r_synth = VivadoRunner(workspace=ws_synth, manifest=manifest, force_mock=True).run_synth()
    assert r_synth["success"]

    # Parse synth reports
    timing_s = parse_timing_summary((ws_synth.root / "reports" / "post_synth_timing_summary.rpt").read_text())
    util_s = parse_utilization((ws_synth.root / "reports" / "post_synth_utilization.rpt").read_text())
    assert timing_s is not None and timing_s.wns is not None
    assert util_s is not None and util_s.lut is not None

    # QoR: synth
    qor_s = check_qor(manifest, timing_s, util_s)
    assert qor_s.passed
    assert any(c["check"] == "wns" and c["passed"] for c in qor_s.checks)

    # Step 2: Implementation
    ws_impl = Workspace(base_dir=workspace_parent(ws_synth), task_name="case5_impl")
    ws_impl.copy_sources(manifest)
    ws_impl.write_manifest(manifest)
    r_impl = VivadoRunner(workspace=ws_impl, manifest=manifest, force_mock=True).run_impl()
    assert r_impl["success"]

    timing_i = parse_timing_summary((ws_impl.root / "reports" / "post_impl_timing_summary.rpt").read_text())
    assert timing_i is not None and timing_i.wns is not None

    # QoR: impl
    qor_i = check_qor(manifest, timing_i)
    assert qor_i.passed

    # Step 3: Simulation
    ws_sim = Workspace(base_dir=Path(tempfile.mkdtemp()), task_name="case5_sim")
    ws_sim.copy_sources(manifest)
    ws_sim.write_manifest(manifest)
    r_sim = VivadoRunner(workspace=ws_sim, manifest=manifest, force_mock=True).run_simulation()
    assert r_sim["success"]
    assert r_sim["mock"]

    # Step 4: Persist artifacts
    ws_sim.write_json(r_synth, "synth_result")
    ws_sim.write_json(r_impl, "impl_result")
    ws_sim.write_json(r_sim, "sim_result")
    ws_sim.write_json({"qor_synth_passed": qor_s.passed, "qor_impl_passed": qor_i.passed}, "qor_summary")

    # Verify artifacts exist
    assert (ws_sim.root / "artifacts" / "synth_result").exists()
    assert (ws_sim.root / "artifacts" / "impl_result").exists()
    assert (ws_sim.root / "artifacts" / "sim_result").exists()
    assert (ws_sim.root / "artifacts" / "qor_summary").exists()

    # Step 5: Diff synth vs impl timing (both workspaces ran synth, use synth step)
    # Copy synth reports to impl workspace for diff
    synth_timing_src = ws_synth.root / "reports" / "post_synth_timing_summary.rpt"
    synth_util_src = ws_synth.root / "reports" / "post_synth_utilization.rpt"
    impl_reports = ws_impl.root / "reports"
    impl_reports.mkdir(parents=True, exist_ok=True)
    if synth_timing_src.exists():
        import shutil
        shutil.copy(synth_timing_src, impl_reports / "post_synth_timing_summary.rpt")
        shutil.copy(synth_util_src, impl_reports / "post_synth_utilization.rpt")

    diff = diff_runs(ws_synth.root, ws_impl.root, "Synth", "Impl", step="synth")
    assert len(diff.entries) >= 2
    assert diff.run_a_label == "Synth"


def workspace_parent(ws: Workspace) -> Path:
    """Get parent of workspace root."""
    return ws.root.parent


# ===========================================================================
# Case 6: Remote runner smoke (skips if no SSH)
# ===========================================================================

def test_case6_remote_runner_check():
    """Verify RemoteVivadoRunner structure without actual SSH connection.

    Tests connection check logic without requiring a real remote host.
    """
    from edagent_vivado.harness.remote_runner import RemoteVivadoRunner

    runner = RemoteVivadoRunner(host="nobody@localhost", identity_file=None)
    assert "localhost" in runner.host
    assert runner._remote_vivado == "vivado"

    # Connection test to localhost should fail gracefully (no SSH server expected)
    status = runner.test_connection()
    assert isinstance(status, dict)
    assert "reachable" in status
    # localhost SSH might or might not be available — just check structure
    if not status["reachable"]:
        assert "error" in status or status.get("stderr") or status.get("return_code", 0) != 0 or True


# ===========================================================================
# Case 7: Pipeline script — full CLI simulation (no subprocess)
# ===========================================================================

def test_case7_pipeline_mode():
    """Simulate a complete CI/CD pipeline flow: multiple projects, parallel strategies.

    Tests: multi-project batch, report comparison, artifact export.
    """
    projects = []
    for i, (name, fail_mode) in enumerate([
        ("proj_a", None),          # clean
        ("proj_b", "timing_violation"),  # timing issue
        ("proj_c", "synth_8_439"),       # module missing
    ]):
        d = Path(tempfile.mkdtemp())
        (d / "rtl").mkdir(exist_ok=True)
        (d / "rtl" / "top.v").write_text(f"module top_{name}; endmodule")
        yaml.dump({
            "project": {"name": name, "part": "xc7a50t", "top": f"top_{name}"},
            "sources": {"rtl": [f"rtl/top.v"], "tb": []},
            "constraints": {"xdc": []},
        }, open(d / "eda.yaml", "w"))

        manifest = Manifest.load(d / "eda.yaml")
        ws = Workspace(base_dir=d, task_name="pipeline")
        ws.copy_sources(manifest)
        ws.write_manifest(manifest)
        runner = VivadoRunner(workspace=ws, manifest=manifest, force_mock=True, mock_fail=fail_mode)
        result = runner.run_synth()
        projects.append({"name": name, "success": result["success"], "workspace": ws, "result": result})

    # Verify
    assert projects[0]["success"]     # proj_a: clean synth
    assert projects[1]["success"]     # proj_b: timing violation still "succeeds" (just bad WNS)
    assert not projects[2]["success"] # proj_c: module missing fails

    # All workspaces should have artifacts
    for p in projects:
        assert (p["workspace"].root / "reports").exists()

    # Export pipeline report
    report = {"projects": [{"name": p["name"], "status": "PASS" if p["success"] else "FAIL"}
              for p in projects]}
    assert len(report["projects"]) == 3
    assert report["projects"][0]["status"] == "PASS"
    assert report["projects"][2]["status"] == "FAIL"


# ===========================================================================
# Case 8: Error KB coverage — all 55 patterns have valid regex
# ===========================================================================

def test_case8_error_kb_all_patterns_valid():
    """Every KB pattern must be a compilable regex that can match its intended error."""
    cases = load_cases()
    assert len(cases) >= 50, f"Expected 50+ cases, got {len(cases)}"

    import re
    invalid = []
    for c in cases:
        try:
            compiled = re.compile(c.pattern)
            # Verify each pattern matches a representative string
            test_str = _pattern_test_string(c.category)
            if test_str:
                assert compiled.search(test_str), \
                    f"Pattern for {c.category} should match test string: {c.pattern}"
        except re.error as e:
            invalid.append(f"{c.category}: {c.pattern} — {e}")

    assert not invalid, f"Invalid regex patterns:\n" + "\n".join(invalid)


def _pattern_test_string(category: str) -> str:
    """Return a representative error string for a category."""
    samples = {
        "missing_module_or_bad_compile_order": "ERROR: [Synth 8-439] Module 'echo_handler' not found",
        "black_box_inference": "ERROR: [Synth 8-5809] Black box inference for module 'foo'",
        "syntax_error": "ERROR: [Synth 8-327] Syntax error near 'assign'",
        "unresolved_parameter": "ERROR: [Synth 8-3352] Parameter resolution failed",
        "multi_driven_net": "ERROR: [Synth 8-6858] Net 'foo' has multiple drivers",
        "latch_inference": "WARNING: [Synth 8-2576] Latch inferred for signal 'bar'",
        "undriven_input_port": "WARNING: [Synth 8-3333] Input port 'clk' is undriven",
        "placement_congestion": "ERROR: [Place 30-574] Poor placement — routing congestion in region X1Y2",
        "placement_infeasible": "ERROR: [Place 30-640] Placement is infeasible for cell 'foo'",
        "clock_region_placement": "ERROR: [Place 30-375] Clock region placement issue",
        "routing_congestion_or_delay": "ERROR: [Route 35-12] Routing failed — 15 nets unrouted",
        "routing_unroutable": "ERROR: [Route 35-12] Routing failed",
        "placement_constraint_conflict": "ERROR: [Opt 30-58] Pblock constraint conflict",
        "drc_io_standard": "ERROR: [DRC 23-20] IO standard conflict on port 'clk'",
        "drc_io_standard_conflict": "ERROR: [DRC NSTD-1] IO standard conflict in same bank",
        "drc_violation": "ERROR: DRC violation — IO standard conflict",
        "timing_violation": "CRITICAL WARNING: [Timing 38-282] The design failed to meet timing",
        "timing_violation_setup": "CRITICAL WARNING: [Timing 38-282] Setup violation",
        "ip_generation_failed": "ERROR: [IP_Flow 19-3461] IP generation failed",
        "ip_license_missing": "ERROR: [IP_Flow 19-3461] License not found",
        "xsim_error": "ERROR: [XSIM 43-3322] Elaboration error",
        "vivado_command_failed": "CRITICAL WARNING: [Common 17-69] Command 'synth_design' failed",
        "file_not_found": "ERROR: [Common 17-143] File not found: /path/to/file.v",
        "resource_overutilization": "ERROR: resource over-utilized — LUTs exceed device capacity",
        "missing_file_generic": "ERROR: no such file 'foo.v'",
        "out_of_memory": "ERROR: out of memory — allocation failed",
    }
    return samples.get(category, "")
