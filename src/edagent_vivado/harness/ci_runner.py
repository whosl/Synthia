"""CI/CD runner — generate GitHub Actions / GitLab CI compatible summary output."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from edagent_vivado.harness.manifest import Manifest
from edagent_vivado.harness.vivado_runner import VivadoRunner, check_qor
from edagent_vivado.harness.workspace import Workspace
from edagent_vivado.parsers.timing_parser import parse_timing_summary
from edagent_vivado.parsers.utilization_parser import parse_utilization
from edagent_vivado.parsers.vivado_log_parser import parse_vivado_log


def run_ci_check(manifest_path: str | Path) -> dict[str, Any]:
    """Run a CI-style check: synthesis + QoR validation.

    Designed to be called from GitHub Actions / GitLab CI scripts.
    Exits with code 1 on failure for CI pipeline integration.

    Args:
        manifest_path: Path to eda.yaml manifest.

    Returns:
        Dict with pass/fail status suitable for JSON output.
    """
    manifest = Manifest.load(manifest_path)
    ws = Workspace(base_dir=Path(manifest_path).parent, task_name="ci_check")

    runner = VivadoRunner(workspace=ws, manifest=manifest)

    # Run synthesis
    synth_result = runner.run_synth()

    # Run implementation if enabled
    impl_result = None
    if manifest.runs.impl.enabled:
        impl_result = runner.run_impl()

    # Check QoR
    qor_checks = synth_result.get("qor", {})
    all_pass = synth_result.get("success", False) and qor_checks.get("all_pass", True)

    if impl_result:
        qor_impl = impl_result.get("qor", {})
        all_pass = all_pass and impl_result.get("success", False) and qor_impl.get("all_pass", True)

    summary = {
        "project": manifest.name(),
        "top": manifest.top(),
        "part": manifest.part(),
        "timestamp": ws.root.name.split("_")[0] + "_" + ws.root.name.split("_")[1] if "_" in ws.root.name else "",
        "passed": all_pass,
        "synth": {
            "success": synth_result.get("success", False),
            "elapsed_sec": synth_result.get("elapsed_sec", 0),
            "mock": synth_result.get("mock", False),
        },
        "implementation": {
            "success": impl_result.get("success") if impl_result else None,
            "elapsed_sec": impl_result.get("elapsed_sec") if impl_result else None,
        } if impl_result else None,
        "qor": qor_checks,
        "workspace": str(ws.root),
    }

    # Generate GitHub Actions step summary if running in GHA
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        _write_gha_summary(summary)

    # Generate GitLab CI report artifact
    ws.write_json(summary, "ci_summary")

    return summary


def _write_gha_summary(summary: dict[str, Any]) -> None:
    """Write a GitHub Actions job summary."""
    gha_path = os.environ.get("GITHUB_STEP_SUMMARY", "")
    if not gha_path:
        return

    passed = summary["passed"]
    icon = "✅" if passed else "❌"

    lines = [
        f"# {icon} EdAgent-Vivado CI: {summary['project']}",
        "",
        f"| Field | Value |",
        f"|-------|-------|",
        f"| Project | {summary['project']} |",
        f"| Top | {summary['top']} |",
        f"| Part | {summary['part']} |",
        f"| Overall | {'PASS' if passed else 'FAIL'} |",
        f"| Synthesis | {'PASS' if summary['synth']['success'] else 'FAIL'} ({summary['synth']['elapsed_sec']}s) |",
    ]
    if summary.get("implementation"):
        lines.append(
            f"| Implementation | {'PASS' if summary['implementation']['success'] else 'FAIL'} "
            f"({summary['implementation']['elapsed_sec']}s) |"
        )

    lines.append("")
    lines.append(f"Workspace: `{summary['workspace']}`")

    try:
        with open(gha_path, "a") as f:
            f.write("\n".join(lines))
    except Exception:
        pass
