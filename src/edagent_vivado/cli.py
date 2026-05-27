"""CLI — Typer-based command-line interface for edagent-vivado."""

from __future__ import annotations

import json
import logging
import os as _os
import shutil
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

from edagent_vivado.harness.manifest import Manifest
from edagent_vivado.harness.qor_checker import check_qor
from edagent_vivado.harness.vivado_runner import MOCK_FAILURE_SCENARIOS, VivadoRunner
from edagent_vivado.harness.workspace import Workspace
from edagent_vivado.kb.error_case_loader import load_cases, match_cases
from edagent_vivado.parsers.timing_parser import load_timing
from edagent_vivado.parsers.utilization_parser import load_utilization
from edagent_vivado.parsers.vivado_log_parser import load_and_parse

app = typer.Typer(help="Synthia — FPGA/EDA Agent Workbench (Vivado RTL debugging)")
console = Console()
logger = logging.getLogger("edagent_vivado")

from edagent_vivado.cli_vivado import vivado_app  # noqa: E402

app.add_typer(vivado_app, name="vivado")

logging.basicConfig(level=logging.WARNING, format="%(levelname)s | %(message)s")


def _safe_print(text: str, **kwargs) -> None:
    """Print text safely on Windows, stripping chars that can't be encoded.

    Falls back to plain print() to avoid Rich's GBK encoding crashes on CJK terminals.
    """
    try:
        console.print(text, markup=False, highlight=False)
    except (UnicodeEncodeError, UnicodeDecodeError):
        # Strip characters outside the Windows code page
        safe = text.encode("gbk", errors="replace").decode("gbk", errors="replace")
        print(safe)


# ── helpers ──────────────────────────────────────────────────


def _ensure_langsmith() -> None:
    """Enable LangSmith if environment is configured."""
    if _os.environ.get("LANGSMITH_TRACING", "").lower() in ("true", "1"):
        _os.environ.setdefault("LANGCHAIN_TRACING_V2", "true")
        if _os.environ.get("LANGSMITH_API_KEY"):
            _os.environ.setdefault("LANGCHAIN_API_KEY", _os.environ["LANGSMITH_API_KEY"])
        if _os.environ.get("LANGSMITH_PROJECT"):
            _os.environ.setdefault("LANGCHAIN_PROJECT", _os.environ["LANGSMITH_PROJECT"])


def _print_qor_table(qor_result) -> None:
    """Print QoR check results as a Rich table."""
    table = Table(title="QoR Check Results")
    table.add_column("Check", style="cyan")
    table.add_column("Result", style="bold")
    table.add_column("Detail")

    for c in qor_result.checks:
        if c.get("skipped"):
            icon = "[dim]SKIP[/]"
        elif c["passed"]:
            icon = "[green]PASS[/]"
        else:
            icon = "[red]FAIL[/]"
        table.add_row(c["check"], icon, c["detail"])

    console.print(table)


# ── commands ──────────────────────────────────────────────────


@app.command()
def init_example(
    target_dir: str = typer.Argument(".", help="Target directory for the example"),
) -> None:
    """Copy the uart_demo example to a target directory."""
    src = Path(__file__).parent.parent.parent / "examples" / "uart_demo"
    dst = Path(target_dir) / "uart_demo"

    if not src.exists():
        console.print("[red]ERROR:[/] Example not found at expected path.")
        raise typer.Exit(1)

    if dst.exists():
        console.print(f"[yellow]Target {dst} already exists. Overwrite?[/]")
        confirm = typer.confirm("Continue?")
        if not confirm:
            raise typer.Abort()
        shutil.rmtree(dst)

    shutil.copytree(src, dst)
    console.print(f"[green]Example copied to {dst}[/]")


@app.command()
def diagnose_log(
    log_path: str = typer.Argument(..., help="Path to a Vivado log file"),
    kb_path: Optional[str] = typer.Option(None, "--kb", help="Custom error KB YAML path"),
) -> None:
    """Parse a Vivado log, match against the error KB, and print a Markdown diagnosis."""
    p = Path(log_path)
    if not p.exists():
        console.print(f"[red]ERROR:[/] File not found: {log_path}")
        raise typer.Exit(1)

    summary = load_and_parse(p)
    cases = load_cases(kb_path)
    matches = match_cases(summary.top_error_signatures, cases)

    lines = [
        f"# Log Diagnosis: {p.name}",
        "",
        f"**File:** `{p.resolve()}`",
        "",
        "---",
        "## Overview",
        "",
        f"| Metric | Count |",
        f"|--------|-------|",
        f"| ERROR | {summary.error_count} |",
        f"| CRITICAL WARNING | {summary.critical_warning_count} |",
        f"| WARNING | {summary.warning_count} |",
        "",
    ]

    if summary.top_error_signatures:
        lines.append("## Error Signatures")
        lines.append("")
        for sig in summary.top_error_signatures[:10]:
            lines.append(f"1. `{sig}`")
        lines.append("")

    if matches:
        lines.append("## Knowledge Base Matches")
        lines.append("")
        for case, sig in matches:
            lines.append(f"### {case.category}")
            lines.append(f"**Matched:** `{sig}`")
            lines.append("")
            lines.append("**Likely causes:**")
            for c in case.likely_causes:
                lines.append(f"- {c}")
            lines.append("")
            lines.append("**Suggested actions:**")
            for a in case.suggested_actions:
                lines.append(f"- {a}")
            lines.append("")
    else:
        lines.append("## Knowledge Base")
        lines.append("")
        lines.append("No matching error cases found.")
        lines.append("")

    _safe_print("\n".join(lines))


def _connector_cli_run(
    capability_id: str,
    manifest_path: str,
    *,
    inputs: dict | None = None,
) -> dict:
    import json as _json

    from edagent_vivado.agent.run_capability import run_connector_capability
    from edagent_vivado.connectors import ensure_connectors

    ensure_connectors()
    raw = run_connector_capability(
        "vivado",
        capability_id,
        manifest_path=manifest_path,
        inputs={"manifest_path": manifest_path, **(inputs or {})},
    )
    try:
        return _json.loads(raw)
    except _json.JSONDecodeError:
        return {"success": False, "error": raw, "edagent_outcome": "execution_failed"}


@app.command()
def run_synth(
    manifest_path: str = typer.Argument(..., help="Path to eda.yaml manifest"),
    mock_fail: Optional[str] = typer.Option(
        None, "--mock-fail",
        help=f"Mock failure scenario: {', '.join(MOCK_FAILURE_SCENARIOS)}",
    ),
    directive: Optional[str] = typer.Option(
        None, "--directive",
        help="Synthesis strategy directive (e.g. RuntimeOptimized, AreaOptimized)",
    ),
    retiming: bool = typer.Option(False, "--retiming", help="Enable retiming in synth_design"),
) -> None:
    """Run Vivado synthesis (or mock) for a project manifest."""
    p = Path(manifest_path)
    if not p.exists():
        console.print(f"[red]ERROR:[/] Manifest not found: {manifest_path}")
        raise typer.Exit(1)

    if not directive and not retiming and not mock_fail:
        result = _connector_cli_run("run_synthesis", str(p))
        console.print(f"\n[green]Synthesis {'succeeded' if result.get('success') else 'FAILED'}[/]")
        console.print(f"  Outcome: {result.get('edagent_outcome', '')}")
        if result.get("error"):
            console.print(f"  Error: {result['error']}")
        if not result.get("success"):
            raise typer.Exit(1)
        return

    manifest = Manifest.load(p)
    console.print(f"[blue]Project:[/] {manifest.name()}")
    console.print(f"[blue]Top:[/] {manifest.top()}  [blue]Part:[/] {manifest.part()}")

    ws = Workspace(base_dir=p.parent, task_name="synth")
    ws.copy_sources(manifest)
    ws.write_manifest(manifest)
    console.print(f"[blue]Workspace:[/] {ws.root}")

    runner = VivadoRunner(workspace=ws, manifest=manifest, mock_fail=mock_fail)
    if runner.is_mock:
        msg = "[yellow]MOCK MODE: Vivado not found — using mock data[/]"
        if mock_fail:
            msg += f" [yellow](scenario: {mock_fail})[/]"
        console.print(msg)

    if directive or retiming:
        result = runner.run_synth_with_strategy(directive or "Default", retiming=retiming)
    else:
        result = runner.run_synth()

    summary_path = ws.write_json(result, "synth_result")

    console.print(f"\n[green]Synthesis {'succeeded' if result['success'] else 'FAILED'}[/]")
    console.print(f"  Return code: {result['return_code']}")
    console.print(f"  Elapsed: {result['elapsed_sec']}s")
    console.print(f"  Mock: {result.get('mock', False)}")
    console.print(f"[blue]Summary:[/] {summary_path}")

    # Auto-parse reports
    _parse_and_report(ws, manifest, result, step="synth")


@app.command()
def run_impl(
    manifest_path: str = typer.Argument(..., help="Path to eda.yaml manifest"),
    mock_fail: Optional[str] = typer.Option(None, "--mock-fail", help="Mock failure scenario"),
) -> None:
    """Run Vivado implementation (or mock) for a project manifest."""
    p = Path(manifest_path)
    if not p.exists():
        console.print(f"[red]ERROR:[/] Manifest not found: {manifest_path}")
        raise typer.Exit(1)

    if not mock_fail:
        result = _connector_cli_run(
            "run_implementation",
            str(p),
            inputs={"run_synth_first": True},
        )
        console.print(f"\n[green]Implementation {'succeeded' if result.get('success') else 'FAILED'}[/]")
        console.print(f"  Outcome: {result.get('edagent_outcome', '')}")
        if result.get("error"):
            console.print(f"  Error: {result['error']}")
        if not result.get("success"):
            raise typer.Exit(1)
        return

    manifest = Manifest.load(p)
    console.print(f"[blue]Project:[/] {manifest.name()}")

    if not manifest.runs.impl.enabled:
        console.print("[yellow]WARNING:[/] impl.enabled is false in manifest — running anyway[/]")

    ws = Workspace(base_dir=p.parent, task_name="impl")
    ws.copy_sources(manifest)
    ws.write_manifest(manifest)
    console.print(f"[blue]Workspace:[/] {ws.root}")

    runner = VivadoRunner(workspace=ws, manifest=manifest, mock_fail=mock_fail)
    if runner.is_mock:
        msg = "[yellow]MOCK MODE: Vivado not found — using mock data[/]"
        if mock_fail:
            msg += f" [yellow](scenario: {mock_fail})[/]"
        console.print(msg)

    result = runner.run_impl()
    ws.write_json(result, "impl_result")

    console.print(f"\n[green]Implementation {'succeeded' if result['success'] else 'FAILED'}[/]")
    console.print(f"  Return code: {result['return_code']}")
    console.print(f"  Elapsed: {result['elapsed_sec']}s")
    console.print(f"  Mock: {result.get('mock', False)}")

    _parse_and_report(ws, manifest, result, step="impl")


@app.command()
def run_sim(
    manifest_path: str = typer.Argument(..., help="Path to eda.yaml manifest"),
    tb_top: Optional[str] = typer.Option(None, "--tb-top", help="Testbench top module name"),
) -> None:
    """Run behavioral simulation (or mock) for a project manifest."""
    p = Path(manifest_path)
    if not p.exists():
        console.print(f"[red]ERROR:[/] Manifest not found: {manifest_path}")
        raise typer.Exit(1)

    manifest = Manifest.load(p)
    if not manifest.sources.tb:
        console.print("[red]ERROR:[/] No testbench sources in manifest")
        raise typer.Exit(1)

    console.print(f"[blue]Project:[/] {manifest.name()}")
    console.print(f"[blue]TB top:[/] {tb_top or f'{manifest.top()}_tb'}")

    ws = Workspace(base_dir=p.parent, task_name="sim")
    ws.copy_sources(manifest)
    ws.write_manifest(manifest)

    runner = VivadoRunner(workspace=ws, manifest=manifest)
    result = runner.run_simulation(tb_top)
    ws.write_json(result, "sim_result")

    console.print(f"\n[green]Simulation {'succeeded' if result['success'] else 'FAILED'}[/]")


@app.command()
def ask(
    manifest_path: str = typer.Argument(..., help="Path to eda.yaml manifest"),
    question: str = typer.Argument(..., help="Your question for the debug agent"),
    stream: bool = typer.Option(True, "--stream/--no-stream", help="Stream agent output token-by-token"),
    thread_id: Optional[str] = typer.Option(None, "--thread", help="Conversation thread ID for multi-turn"),
    mock_fail: Optional[str] = typer.Option(None, "--mock-fail", help="Mock failure scenario for synthesis"),
) -> None:
    """Ask the Vivado debug agent a question about a project."""
    _ensure_langsmith()

    p = Path(manifest_path)
    if not p.exists():
        console.print(f"[red]ERROR:[/] Manifest not found: {manifest_path}")
        raise typer.Exit(1)

    if not _os.environ.get("ANTHROPIC_API_KEY"):
        console.print("[red]ERROR:[/] ANTHROPIC_API_KEY not set. Agent mode requires an API key.")
        console.print("Set it via environment variable or .env file.")
        raise typer.Exit(1)

    from edagent_vivado.agent.graph import create_agent, invoke_agent, stream_agent

    agent = create_agent()
    manifest = Manifest.load(p)

    full_prompt = f"""Project: {manifest.name()}
Top module: {manifest.top()}
Part: {manifest.part()}
Vivado version: {manifest.vivado_version()}
Flow: {manifest.flow()}
RTL files: {manifest.sources.rtl}
XDC files: {manifest.constraints.xdc}
TB files: {manifest.sources.tb}
IP cores: {[ip.name for ip in manifest.ip]}
Manifest path: {Path(manifest_path).resolve()}

Question: {question}"""

    tid = thread_id or f"{manifest.name()}_{manifest.top()}"

    if stream:
        console.print("[blue]Agent streaming (Ctrl+C to stop)...[/]\n")
        try:
            for token in stream_agent(agent, full_prompt, thread_id=tid):
                console.print(token, end="", markup=False, highlight=False)
            console.print()
        except KeyboardInterrupt:
            console.print("\n[yellow]Stream interrupted.[/]")
    else:
        console.print("[blue]Running agent (this may take a moment)...[/]\n")
        result = invoke_agent(agent, full_prompt, thread_id=tid)
        _safe_print(result)


@app.command()
def batch(
    manifest_path: str = typer.Argument(..., help="Path to eda.yaml manifest"),
    strategies: Optional[str] = typer.Option(
        None, "--strategies",
        help="Comma-separated list of synthesis directives to try",
    ),
) -> None:
    """Run synthesis with multiple strategies and compare results."""
    p = Path(manifest_path)
    if not p.exists():
        console.print(f"[red]ERROR:[/] Manifest not found: {manifest_path}")
        raise typer.Exit(1)

    manifest = Manifest.load(p)
    strat_list = [s.strip() for s in strategies.split(",")] if strategies else ["Default"]

    results_table = Table(title=f"Batch Synthesis — {manifest.name()}")
    results_table.add_column("Strategy", style="cyan")
    results_table.add_column("WNS", style="bold")
    results_table.add_column("TNS")
    results_table.add_column("LUT")
    results_table.add_column("FF")
    results_table.add_column("Status")

    for strat in strat_list:
        console.print(f"[blue]Running:[/] {strat}")
        ws = Workspace(base_dir=p.parent, task_name=f"batch_{strat}")
        ws.copy_sources(manifest)
        ws.write_manifest(manifest)

        runner = VivadoRunner(workspace=ws, manifest=manifest, force_mock=True)
        result = runner.run_synth_with_strategy(directive=strat) if strat != "Default" else runner.run_synth()

        # Parse timing/utilization
        timing = load_timing(ws.report_path("post_synth_timing_summary.rpt"))
        util = load_utilization(ws.report_path("post_synth_utilization.rpt"))

        wns_str = f"{timing.wns:.3f}" if timing and timing.wns is not None else "N/A"
        tns_str = f"{timing.tns:.3f}" if timing and timing.tns is not None else "N/A"
        lut_str = str(util.lut) if util and util.lut is not None else "N/A"
        ff_str = str(util.ff) if util and util.ff is not None else "N/A"
        status = "[green]OK[/]" if result["success"] else "[red]FAIL[/]"

        results_table.add_row(strat, wns_str, tns_str, lut_str, ff_str, status)

    console.print(results_table)


def _parse_and_report(ws: Workspace, manifest: Manifest, result: dict, step: str) -> None:
    """Auto-parse timing, utilization, and run QoR check after synth/impl."""
    prefix = f"post_{step}"

    # Parse reports
    timing = load_timing(ws.report_path(f"{prefix}_timing_summary.rpt"))
    util = load_utilization(ws.report_path(f"{prefix}_utilization.rpt"))

    console.print("")
    if timing:
        console.print(f"[bold]Timing:[/] WNS={timing.wns}, TNS={timing.tns}, WHS={timing.whs}, THS={timing.ths}")
    else:
        console.print("[dim]Timing summary not available[/]")

    if util:
        console.print(f"[bold]Utilization:[/] LUT={util.lut}, FF={util.ff}, BRAM={util.bram}, DSP={util.dsp}")
    else:
        console.print("[dim]Utilization summary not available[/]")

    # QoR check
    console.print("")
    synthesis_failed = not result.get("success", True)
    qor = check_qor(manifest, timing, util, drc_clean=result.get("drc_clean"), synthesis_failed=synthesis_failed)
    _print_qor_table(qor)

    # Save structured QoR
    ws.write_json({
        "timing": {"wns": timing.wns, "tns": timing.tns, "whs": timing.whs, "ths": timing.ths} if timing else None,
        "utilization": {"lut": util.lut, "ff": util.ff, "bram": util.bram, "dsp": util.dsp} if util else None,
        "qor_passed": qor.passed,
        "qor_checks": qor.checks,
    }, f"{step}_qor")


@app.command()
def ask_multi(
    manifest_path: str = typer.Argument(..., help="Path to eda.yaml manifest"),
    question: str = typer.Argument(..., help="Your question for the debug agent"),
    thread_id: Optional[str] = typer.Option(None, "--thread", help="Conversation thread ID"),
) -> None:
    """Ask the multi-agent supervisor — routes to synthesis/timing/constraint specialists."""
    _ensure_langsmith()

    p = Path(manifest_path)
    if not p.exists():
        console.print(f"[red]ERROR:[/] Manifest not found: {manifest_path}")
        raise typer.Exit(1)

    if not _os.environ.get("ANTHROPIC_API_KEY"):
        console.print("[red]ERROR:[/] ANTHROPIC_API_KEY not set.")
        raise typer.Exit(1)

    from edagent_vivado.agent.supervisor import create_supervisor_agent, invoke_supervisor

    manifest = Manifest.load(p)
    agent = create_supervisor_agent()

    full_prompt = f"""Project: {manifest.name()} | Top: {manifest.top()} | Part: {manifest.part()}
RTL: {manifest.sources.rtl}
XDC: {manifest.constraints.xdc}

Question: {question}"""

    console.print("[blue]Multi-agent supervisor analyzing question...[/]")
    result = invoke_supervisor(agent, full_prompt, thread_id=thread_id or "default")
    _safe_print(result)


@app.command()
def approve(
    enable: bool = typer.Option(True, "--on/--off", help="Enable or disable patch auto-apply"),
) -> None:
    """Enable or disable automatic patch application by the agent."""
    from edagent_vivado.tools.patch_tools import set_patch_approval

    set_patch_approval(enable)
    state = "ENABLED" if enable else "DISABLED"
    console.print(f"[green]Patch auto-approval: {state}[/]")
    console.print(
        "[dim]When enabled, propose_patch_tool and create_file_tool will apply changes immediately.[/]"
    )


@app.command()
def web(
    host: str = typer.Option("127.0.0.1", "--host", help="Bind address"),
    port: int = typer.Option(8484, "--port", help="Listen port"),
) -> None:
    """Start the terminal-style web dashboard."""
    if host not in ("127.0.0.1", "localhost", "::1"):
        tok = _os.environ.get("SYNTHIA_API_TOKEN", "").strip()
        if not tok or len(tok) < 16:
            console.print(
                "[red]ERROR:[/] binding to non-localhost requires SYNTHIA_API_TOKEN (>=16 chars).\n"
                "       Example: export SYNTHIA_API_TOKEN=$(openssl rand -hex 32)"
            )
            raise typer.Exit(2)
    try:
        import uvicorn
        from edagent_vivado.web.app import create_app
        from edagent_vivado.web.auth import ensure_token

        app_obj = create_app()
        if host in ("127.0.0.1", "localhost", "::1"):
            tok = ensure_token()
            console.print(f"[dim]API token:[/] ~/.synthia/token (len={len(tok)})")
        console.print(f"[green]Synthia Workbench[/]")
        console.print(f"  Terminal UI: http://{host}:{port}/term")
        console.print(f"  API Health:  http://{host}:{port}/api/health")
        uvicorn.run(app_obj, host=host, port=port, log_level="info")
    except ImportError:
        console.print("[red]ERROR:[/] FastAPI and uvicorn required. Install with: pip install fastapi uvicorn")
        raise typer.Exit(1)


@app.command()
def eval(
    name: str = typer.Argument("", help="Eval set name (omit to list available sets)"),
    project_id: str = typer.Option("", "--project-id", help="Tag the queued run with a project id"),
    overlay_id: str = typer.Option("", "--overlay-id", help="Tag the queued run with an overlay id"),
    note: str = typer.Option("", "--note", help="Free-form audit string"),
    status: str = typer.Option("", "--status", help="Filter the listing by run state"),
    limit: int = typer.Option(20, "--limit", help="Max rows to show when listing"),
    show_cases: bool = typer.Option(False, "--show-cases", help="Print the case list for the set"),
) -> None:
    """Queue an A/B eval run (SE-PR6 placeholder — runner lands later).

    Examples:

      edagent eval                                 # list available eval sets
      edagent eval smoke                           # queue smoke as placeholder
      edagent eval smoke --project-id <id>         # tag with a project
      edagent eval smoke --show-cases              # print smoke's cases
      edagent eval --status placeholder            # list queued runs
    """
    from edagent_vivado.evolution import (
        EvalSetError,
        enqueue_eval_run,
        eval_run_list,
        get_eval_set_dto,
        list_eval_sets_dto,
    )

    name = (name or "").strip()
    status = (status or "").strip()

    # No name + no status filter ⇒ show the eval set library + recent runs.
    if not name:
        sets = list_eval_sets_dto()
        console.print("[bold]Available eval sets[/]")
        if not sets:
            console.print("  [dim](no YAML files under tests/eval_set/)[/]")
        for s in sets:
            console.print(
                f"  [cyan]{s['name']}[/] · {s['case_count']} case(s) · {s['path']}"
            )
            if s["description"]:
                console.print(f"    [dim]{s['description'].splitlines()[0]}[/]")
        rows = eval_run_list(state=status or None, limit=limit)
        if rows:
            console.print(f"\n[bold]Recent eval runs[/] (state filter: {status or 'any'})")
            for r in rows:
                console.print(
                    f"  [magenta]{r['id']}[/] · [yellow]{r['state']}[/] · "
                    f"{r['eval_set']} · cases={r.get('total_cases')}"
                )
        console.print(
            "\n[dim]SE-PR6 ships placeholders only — the runner that drives cases "
            "through the agent loop is not yet implemented (SPEC §22.6B).[/]"
        )
        return

    if show_cases:
        try:
            dto = get_eval_set_dto(name)
        except EvalSetError as exc:
            console.print(f"[red]Eval set error:[/] {exc}")
            raise typer.Exit(1)
        console.print(f"[bold]{dto['name']}[/] · {dto['case_count']} case(s)")
        if dto["description"]:
            console.print(f"[dim]{dto['description']}[/]")
        for case in dto["cases"]:
            console.print(f"\n  [cyan]{case['id']}[/]")
            for line in case["question"].splitlines():
                console.print(f"    [dim]>[/] {line}")
            if case.get("expected"):
                console.print(f"    [dim]expected:[/] {case['expected']}")
        return

    try:
        row = enqueue_eval_run(
            name,
            project_id=project_id or None,
            overlay_id=overlay_id or None,
            note=note,
        )
    except EvalSetError as exc:
        console.print(f"[red]Eval set error:[/] {exc}")
        raise typer.Exit(1)
    console.print(f"[green]Queued[/] eval_run [magenta]{row['id']}[/]")
    console.print(f"  eval_set: {row['eval_set']}")
    console.print(f"  state:    {row['state']} (runner_implemented={row.get('runner_implemented')})")
    console.print(f"  cases:    {row.get('total_cases')}")
    if project_id:
        console.print(f"  project:  {project_id}")
    console.print(
        "[dim]The row sits in eval_runs.state='placeholder' until the runner "
        "ships. Inspect via GET /api/v1/evolution/eval/runs.[/]"
    )


bench_app = typer.Typer(help="Benchmark suites (Phase 10)")
app.add_typer(bench_app, name="benchmark")


@bench_app.command("run")
def cli_bench_run(
    suite_file: Path = typer.Argument(..., help="JSON file describing the suite"),
    project_id: str = typer.Option(..., "--project-id", "-p"),
):
    """Run a benchmark suite from a JSON description file."""
    from edagent_vivado.benchmarks.executor import execute_suite
    from edagent_vivado.benchmarks.models import BenchmarkSuite, SuiteConfig, make_case
    from edagent_vivado.benchmarks.suite_store import suite_create
    from edagent_vivado.repository.db import init_db

    init_db()
    spec = json.loads(suite_file.read_text(encoding="utf-8"))
    cfg = SuiteConfig(
        **{k: v for k, v in spec.get("config", {}).items() if k in SuiteConfig.__dataclass_fields__}
    )
    suite = BenchmarkSuite.new(
        name=spec.get("name", suite_file.stem),
        description=spec.get("description", ""),
        project_id=project_id,
        config=cfg,
    )
    suite.cases = [
        make_case(
            suite_id=suite.id,
            name=c["name"],
            sequence=i,
            flow_name=c.get("flow_name", "vivado_synth_only"),
            inputs=c.get("inputs", {}),
            expected=c.get("expected", {}),
            description=c.get("description", ""),
        )
        for i, c in enumerate(spec.get("cases", []))
    ]
    suite.total_cases = len(suite.cases)
    suite_create(suite)
    console.print(f"[green]Created[/] suite {suite.id} ({len(suite.cases)} cases)")
    console.print("Running…")
    result = execute_suite(suite.id)
    console.print(f"Suite finished: {result.get('state', '')}")
    console.print(f"  Success: {result.get('completed_cases', 0)}/{result.get('total_cases', 0)}")
    console.print(f"  Failed:  {result.get('failed_cases', 0)}")
    console.print("Export:")
    console.print(f"  edagent benchmark export {suite.id} --csv")
    console.print(f"  edagent benchmark export {suite.id} --md")


@bench_app.command("export")
def cli_bench_export(
    suite_id: str,
    csv_out: bool = typer.Option(False, "--csv"),
    md_out: bool = typer.Option(False, "--md"),
    json_out: bool = typer.Option(False, "--json"),
    zip_out: Optional[Path] = typer.Option(None, "--zip"),
):
    from edagent_vivado.benchmarks.exporter import export_csv, export_json, export_markdown, export_zip
    from edagent_vivado.repository.db import init_db

    init_db()
    if csv_out:
        typer.echo(export_csv(suite_id))
    if md_out:
        typer.echo(export_markdown(suite_id))
    if json_out:
        typer.echo(export_json(suite_id))
    if zip_out:
        p = export_zip(suite_id, str(zip_out))
        typer.echo(f"wrote {p}")


@bench_app.command("list")
def cli_bench_list(project: str = typer.Option("", "--project")):
    from edagent_vivado.benchmarks.suite_store import suite_list
    from edagent_vivado.repository.db import init_db

    init_db()
    for s in suite_list(project_id=project, limit=50):
        console.print(
            f"  {s['id'][:8]} {s['name']:30s} {s['state']:12s} "
            f"{s.get('completed_cases', 0)}/{s.get('total_cases', 0)}"
        )


admin_app = typer.Typer(help="RBAC user administration (Phase 8)")
app.add_typer(admin_app, name="admin")


@admin_app.command("create-user")
def cli_create_user(
    username: str,
    role: str = typer.Option("viewer", "--role", "-r"),
    display: str = typer.Option("", "--display-name"),
    service: bool = typer.Option(False, "--service-account"),
):
    """Create a user; prints API token (shown once)."""
    from edagent_vivado.repository.db import init_db
    from edagent_vivado.auth.identity import create_user

    init_db()
    u = create_user(
        username=username,
        display_name=display,
        global_role=role,
        is_service_account=service,
    )
    console.print(f"[green]Created[/] user {username} ({role})")
    console.print(f"API token: [bold]{u['api_token']}[/]")
    console.print("[dim]Save this token now; it cannot be retrieved later.[/]")


@admin_app.command("list-users")
def cli_list_users():
    from edagent_vivado.repository.db import init_db
    from edagent_vivado.auth.identity import list_users

    init_db()
    for u in list_users():
        active = "✓" if u.get("is_active") else "✗"
        console.print(f"  {active} {u['username']:20s} {u.get('global_role', ''):15s} {u.get('display_name', '')}")


@admin_app.command("rotate-token")
def cli_rotate_token(user_id: str):
    import secrets
    from edagent_vivado.repository.db import get_db, init_db

    init_db()
    new_tok = secrets.token_urlsafe(32)
    get_db().execute("UPDATE users SET api_token=? WHERE id=?", (new_tok, user_id))
    get_db().commit()
    console.print(f"new token: {new_tok}")


@admin_app.command("add-member")
def cli_add_member(project_id: str, user_id: str, role_name: str):
    from edagent_vivado.repository.db import init_db
    from edagent_vivado.auth.identity import add_project_member

    init_db()
    add_project_member(project_id, user_id, role_name)
    console.print(f"added {user_id} as {role_name} on {project_id}")


if __name__ == "__main__":
    app()
