"""CLI subgroup: edagent vivado — Phase 3A."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

vivado_app = typer.Typer(help="Vivado runtime: health, targets, Tcl, scripts, synth/impl/flow")
console = Console()


@vivado_app.command("health")
def vivado_health() -> None:
    """Check remote/local Vivado target connectivity."""
    from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter

    hc = VivadoRuntimeAdapter().health_check()
    table = Table(title="Vivado Health")
    for k, v in hc.items():
        table.add_row(str(k), str(v))
    console.print(table)
    if not hc.get("reachable"):
        raise typer.Exit(1)


@vivado_app.command("targets")
def vivado_targets() -> None:
    """List configured Vivado targets."""
    from edagent_vivado.harness.vivado_adapter import get_default_target
    from edagent_vivado.repository.store import vivado_target_list

    rows = vivado_target_list(enabled_only=False)
    if not rows:
        t = get_default_target()
        if t:
            console.print(json.dumps({"id": t.id, "host": t.host, "source": "env"}, indent=2))
        else:
            console.print("[yellow]No targets in DB or environment.[/]")
        return
    for row in rows:
        console.print(json.dumps(row, indent=2, default=str))


@vivado_app.command("tcl")
def vivado_tcl(
    command: str = typer.Argument(..., help="Tcl command to run in batch mode"),
    target_id: Optional[str] = typer.Option(None, "--target", "-t"),
    auto_approved: bool = typer.Option(True, "--yes", "-y", help="Skip policy approval prompt"),
) -> None:
    """Run a single Tcl command via VivadoRuntimeAdapter."""
    from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter, get_target

    adapter = VivadoRuntimeAdapter(get_target(target_id))
    policy = adapter.check_policy(command, auto_approved=auto_approved)
    if not policy.allowed:
        console.print(f"[red]Denied:[/] {policy.reason}")
        raise typer.Exit(1)
    if policy.requires_approval and not auto_approved:
        console.print(f"[yellow]Approval required:[/] {policy.reason}")
        raise typer.Exit(2)
    result = adapter.run_tcl(command, auto_approved=True)
    console.print(result.stdout[:8000] if result.stdout else "")
    if result.stderr:
        console.print(f"[dim]{result.stderr[:2000]}[/]")
    if not result.success:
        console.print(f"[red]Failed:[/] {result.error or result.exit_code}")
        raise typer.Exit(result.exit_code or 1)
    console.print(f"[green]OK[/] ({result.elapsed_sec}s)")


@vivado_app.command("script")
def vivado_script(
    path: Path = typer.Argument(..., help="Path to .tcl script"),
    target_id: Optional[str] = typer.Option(None, "--target", "-t"),
    auto_approved: bool = typer.Option(True, "--yes", "-y"),
) -> None:
    """Run a Tcl script file in batch mode."""
    from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter, get_target

    if not path.is_file():
        console.print(f"[red]Not found:[/] {path}")
        raise typer.Exit(1)
    script = path.read_text(encoding="utf-8", errors="replace")
    adapter = VivadoRuntimeAdapter(get_target(target_id))
    policy = adapter.check_script_policy(script, auto_approved=auto_approved)
    if not policy.allowed:
        console.print(f"[red]Denied:[/] {policy.reason}")
        raise typer.Exit(1)
    if policy.requires_approval and not auto_approved:
        console.print(f"[yellow]Approval required:[/] {policy.reason}")
        raise typer.Exit(2)
    result = adapter.run_script(script, auto_approved=True)
    console.print(result.stdout[:8000] if result.stdout else "")
    if not result.success:
        console.print(f"[red]Failed:[/] {result.error or result.exit_code}")
        raise typer.Exit(result.exit_code or 1)
    console.print(f"[green]OK[/] ({result.elapsed_sec}s)")


@vivado_app.command("synth")
def vivado_synth(
    manifest: Path = typer.Argument(..., help="Path to eda.yaml"),
    mock_fail: Optional[str] = typer.Option(None, "--mock-fail", help="Mock failure scenario id"),
) -> None:
    """Run synthesis from manifest."""
    import os

    if mock_fail:
        os.environ["EDAGENT_MOCK_FAIL"] = mock_fail
    from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter

    result = VivadoRuntimeAdapter().run_synthesis(str(manifest.resolve()))
    console.print(json.dumps(result, indent=2, default=str))
    if not result.get("success"):
        raise typer.Exit(1)


@vivado_app.command("impl")
def vivado_impl(
    manifest: Path = typer.Argument(..., help="Path to eda.yaml"),
    mock_fail: Optional[str] = typer.Option(None, "--mock-fail"),
) -> None:
    """Run synth + implementation from manifest."""
    import os

    if mock_fail:
        os.environ["EDAGENT_MOCK_FAIL"] = mock_fail
    from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter

    result = VivadoRuntimeAdapter().run_implementation(str(manifest.resolve()))
    console.print(json.dumps(result, indent=2, default=str))
    if not result.get("success"):
        raise typer.Exit(1)


@vivado_app.command("flow")
def vivado_flow(
    manifest: Path = typer.Argument(..., help="Path to eda.yaml"),
    mock_fail: Optional[str] = typer.Option(None, "--mock-fail"),
) -> None:
    """Alias: synth + impl (full non-project flow)."""
    vivado_impl(manifest, mock_fail=mock_fail)


@vivado_app.command("sync")
def vivado_sync(
    manifest: Path = typer.Argument(..., help="Path to eda.yaml"),
    workspace: Optional[Path] = typer.Option(None, "--workspace", "-w"),
) -> None:
    """Sync manifest sources to remote host (hash incremental)."""
    from edagent_vivado.harness.manifest import Manifest
    from edagent_vivado.harness.workspace import Workspace
    from edagent_vivado.harness.file_sync import sync_manifest_sources
    from edagent_vivado.harness.remote_executor import RemoteExecutor

    m = Manifest.load(manifest)
    ws_root = workspace or Workspace(manifest.parent, task_name="cli_sync").root
    if not workspace:
        ws = Workspace(manifest.parent, task_name="cli_sync")
        ws.copy_sources(m)
        ws_root = ws.root
    stats = sync_manifest_sources(m, ws_root, RemoteExecutor())
    console.print(json.dumps(stats, indent=2))
    if not stats.get("ok"):
        raise typer.Exit(1)
