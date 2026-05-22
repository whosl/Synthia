"""IP Manager — handle Xilinx IP (XCI) generation and integration."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from edagent_vivado.harness.command_runner import CommandRunner
from edagent_vivado.harness.manifest import Manifest

logger = logging.getLogger(__name__)


class IpManager:
    """Manage Xilinx IP cores referenced in a manifest.

    Handles IP generation (XCI files), output product discovery, and
    integration into the Vivado flow.
    """

    def __init__(
        self,
        workspace_root: Path,
        manifest: Manifest,
        vivado_path: str | None = None,
    ) -> None:
        self._root = workspace_root
        self._manifest = manifest
        self._vivado_path = vivado_path

    def generate_all(self) -> dict[str, Any]:
        """Generate all IP declared in the manifest's ``ip`` section.

        Returns a dict mapping IP name to generation status.
        """
        results: dict[str, Any] = {}
        ip_list = self._manifest.ip
        if not ip_list:
            return {"status": "no_ip_declared", "results": {}}

        ip_dir = self._root / "ip"
        ip_dir.mkdir(parents=True, exist_ok=True)

        for entry in ip_list:
            name = entry.name
            logger.info("Generating IP: %s", name)
            results[name] = self._generate_one(entry, ip_dir)

        return {"status": "done", "results": results}

    def _generate_one(self, entry, ip_dir: Path) -> dict[str, Any]:
        """Generate a single IP core."""
        name = entry.name
        xci_path = self._find_xci(entry)
        if not xci_path:
            return {"status": "skipped", "error": f"XCI not found for {name}"}

        runner = CommandRunner(
            workspace_root=self._root,
            vivado_path=self._vivado_path,
        )

        # Generate output products
        tcl = (
            f"open_project {{{self._root}}}\n"
            f"add_files {{{xci_path}}}\n"
            f"generate_target {{instantiation_template}} [get_files {{{xci_path}}}]\n"
            f"generate_target all [get_files {{{xci_path}}}]\n"
            f"export_ip_user_files -of_objects [get_files {{{xci_path}}}]\n"
            f"exit\n"
        )
        tcl_path = ip_dir / f"gen_{name}.tcl"
        tcl_path.write_text(tcl)

        cmd = f"vivado -mode batch -source {tcl_path} -log {ip_dir / f'gen_{name}.log'}"
        result = runner.run(cmd, timeout=1800, log_label=f"ip_gen_{name}")

        return {
            "status": "success" if result.return_code == 0 else "failed",
            "return_code": result.return_code,
            "log": result.stdout_path,
            "elapsed_sec": result.elapsed_sec,
        }

    def _find_xci(self, entry) -> str | None:
        if entry.repo_path:
            return str(entry.repo_path)
        return None

    def list_ip_products(self, ip_name: str) -> list[Path]:
        ip_dir = self._root / "ip" / ip_name
        if not ip_dir.exists():
            return []
        return sorted(ip_dir.rglob("*.xci"))
