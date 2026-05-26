"""CommandRunner — controlled shell execution with allowlist."""

from __future__ import annotations

import logging
import os
import re
import shlex
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

logger = logging.getLogger(__name__)

# ── allowlist ─────────────────────────────────────────────────

ALLOWED_COMMANDS: set[str] = {
    "vivado",
    "xvlog",
    "xvhdl",
    "xelab",
    "xsim",
    "python",
    "python3",
    "verilator",
    "slang",
    "verible-verilog-format",
    "verible-verilog-lint",
    "head",
    "tail",
    "cat",
    "wc",
    "echo",
    "ls",
    "stat",
    "which",
    "md5sum",
    "sha256sum",
}

BLOCKED_PATTERNS: list[re.Pattern] = [
    re.compile(r"\brm\s+-rf\b"),
    re.compile(r"\bsudo\b"),
    re.compile(r"\bcurl\s+\S*\s*\|"),
    re.compile(r"\bwget\s+\S*\s*-O\s*-\s*\|"),
    re.compile(r"\bdd\s+.*of="),
    re.compile(r">\s*/dev/(null|zero|random|urandom)"),
    re.compile(r":\(\)\s*\{"),
    re.compile(r"\bchmod\s+777\b"),
    re.compile(r"\bchown\b"),
]


# ── result type ───────────────────────────────────────────────


@dataclass
class CommandResult:
    command: str
    cwd: str
    return_code: int = -1
    stdout_path: str = ""
    stderr_path: str = ""
    elapsed_sec: float = 0.0
    timed_out: bool = False
    error: str | None = None


# ── runner ────────────────────────────────────────────────────


class CommandRunner:
    """Run shell commands under an allowlist (argv-based, no shell interpretation)."""

    def __init__(
        self,
        workspace_root: str | Path | None = None,
        timeout: int = 3600,
        vivado_path: str | None = None,
    ) -> None:
        self.workspace_root = Path(workspace_root) if workspace_root else Path.cwd()
        self.timeout = timeout
        self._vivado_path = vivado_path

    def _resolve_argv(self, argv: list[str]) -> list[str]:
        if self._vivado_path and argv and Path(argv[0]).name == "vivado":
            return [str(self._vivado_path), *argv[1:]]
        return argv

    def _check_argv(self, argv: list[str]) -> bool:
        if not argv:
            return False

        base_name = Path(argv[0]).name
        if base_name not in ALLOWED_COMMANDS and not base_name.endswith("vivado"):
            logger.warning("Command not in allowlist: %s", base_name)
            return False

        if base_name in ("python", "python3"):
            for arg in argv[1:]:
                if arg == "-c":
                    logger.warning("python -c is forbidden via CommandRunner")
                    return False

        joined = " ".join(argv)
        for pat in BLOCKED_PATTERNS:
            if pat.search(joined):
                logger.warning("Blocked pattern matched: %s", pat.pattern)
                return False
        return True

    def check_allowed(self, command: str) -> bool:
        """Return True if command is allowed, False if blocked."""
        cmd = command.strip()
        if not cmd:
            return False
        try:
            argv = shlex.split(cmd, posix=(os.name != "nt"))
        except ValueError:
            return False
        return self._check_argv(argv)

    def run(
        self,
        command: str | Sequence[str],
        cwd: str | Path | None = None,
        timeout: int | None = None,
        env: dict[str, str] | None = None,
        log_label: str = "",
    ) -> CommandResult:
        """Execute a command if it passes the allowlist."""
        if isinstance(command, str):
            try:
                argv = shlex.split(command, posix=(os.name != "nt"))
            except ValueError as exc:
                return CommandResult(
                    command=command,
                    cwd=str(cwd or self.workspace_root),
                    return_code=-1,
                    error=f"Failed to parse command: {exc}",
                )
        else:
            argv = list(command)

        cmd_display = command if isinstance(command, str) else " ".join(argv)

        if not argv:
            return CommandResult(command=cmd_display, cwd="", return_code=-1, error="empty command")

        if not self._check_argv(argv):
            return CommandResult(
                command=cmd_display,
                cwd=str(cwd or self.workspace_root),
                return_code=-1,
                error=f"Command rejected by allowlist: {argv[0]}",
            )

        effective_cwd = Path(cwd).resolve() if cwd else self.workspace_root.resolve()
        ws_root = self.workspace_root.resolve()
        try:
            effective_cwd.relative_to(ws_root)
        except ValueError:
            return CommandResult(
                command=cmd_display,
                cwd=str(effective_cwd),
                return_code=-1,
                error=f"cwd outside workspace_root: {effective_cwd}",
            )

        effective_cwd.mkdir(parents=True, exist_ok=True)
        label = log_label or (argv[0] if argv else "cmd")
        resolved_argv = self._resolve_argv(argv)

        stdout_path = effective_cwd / f"_{label.replace('/', '_')}_stdout.log"
        stderr_path = effective_cwd / f"_{label.replace('/', '_')}_stderr.log"

        t0 = time.time()
        try:
            with open(stdout_path, "w") as so, open(stderr_path, "w") as se:
                proc = subprocess.run(
                    resolved_argv,
                    shell=False,
                    cwd=effective_cwd,
                    stdout=so,
                    stderr=se,
                    timeout=timeout or self.timeout,
                    env=env or None,
                )
            elapsed = time.time() - t0
            return CommandResult(
                command=cmd_display,
                cwd=str(effective_cwd),
                return_code=proc.returncode,
                stdout_path=str(stdout_path),
                stderr_path=str(stderr_path),
                elapsed_sec=round(elapsed, 2),
                timed_out=False,
            )
        except subprocess.TimeoutExpired:
            elapsed = time.time() - t0
            logger.warning("Command timed out after %ss: %s", timeout or self.timeout, cmd_display[:80])
            return CommandResult(
                command=cmd_display,
                cwd=str(effective_cwd),
                return_code=-1,
                stdout_path=str(stdout_path),
                stderr_path=str(stderr_path),
                elapsed_sec=round(elapsed, 2),
                timed_out=True,
                error="Timeout expired",
            )
        except FileNotFoundError as e:
            return CommandResult(
                command=cmd_display,
                cwd=str(effective_cwd),
                return_code=-1,
                error=f"Executable not found: {e}",
            )
