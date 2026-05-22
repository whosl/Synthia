"""CommandRunner — controlled shell execution with allowlist."""

from __future__ import annotations

import logging
import re
import shlex
import shutil
import subprocess
import time
from dataclasses import dataclass, field
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
    """Run shell commands under an allowlist."""

    def __init__(
        self,
        workspace_root: str | Path | None = None,
        timeout: int = 3600,
        vivado_path: str | None = None,
    ) -> None:
        self.workspace_root = Path(workspace_root) if workspace_root else Path.cwd()
        self.timeout = timeout
        self._vivado_path = vivado_path

    def _resolve_command(self, command: str) -> str:
        """Substitute configured paths for known tools."""
        if self._vivado_path and command.strip().startswith("vivado"):
            # replace first 'vivado' token with full path
            return re.sub(r"^vivado", shlex.quote(str(self._vivado_path)), command)
        return command

    def check_allowed(self, command: str) -> bool:
        """Return True if command is allowed, False if blocked."""
        cmd = command.strip()
        if not cmd:
            return False

        # extract base command
        base = shlex.split(cmd)[0] if shlex.split(cmd) else ""
        base = base.strip().split("/")[-1]  # handle paths

        # check blocked patterns first
        for pat in BLOCKED_PATTERNS:
            if pat.search(cmd):
                logger.warning("Blocked pattern matched: %s in %r", pat.pattern, cmd[:80])
                return False

        # check allowlist
        if base in ALLOWED_COMMANDS:
            return True

        # 'vivado' could be a full path — check endswith
        if base.endswith("vivado") and "vivado" in ALLOWED_COMMANDS:
            return True

        logger.warning("Command not in allowlist: %s", base)
        return False

    def run(
        self,
        command: str,
        cwd: str | Path | None = None,
        timeout: int | None = None,
        env: dict[str, str] | None = None,
        log_label: str = "",
    ) -> CommandResult:
        """Execute a command if it passes the allowlist."""
        if not self.check_allowed(command):
            return CommandResult(
                command=command,
                cwd=str(cwd or self.workspace_root),
                return_code=-1,
                error=f"Command rejected by allowlist: {command[:120]}",
            )

        effective_cwd = Path(cwd) if cwd else self.workspace_root
        effective_cwd.mkdir(parents=True, exist_ok=True)
        label = log_label or command[:60]
        resolved = self._resolve_command(command)

        stdout_path = effective_cwd / f"_{label.replace('/', '_')}_stdout.log"
        stderr_path = effective_cwd / f"_{label.replace('/', '_')}_stderr.log"

        t0 = time.time()
        try:
            with open(stdout_path, "w") as so, open(stderr_path, "w") as se:
                proc = subprocess.run(
                    resolved,
                    shell=True,
                    cwd=effective_cwd,
                    stdout=so,
                    stderr=se,
                    timeout=timeout or self.timeout,
                    env=env or None,
                )
            elapsed = time.time() - t0
            return CommandResult(
                command=command,
                cwd=str(effective_cwd),
                return_code=proc.returncode,
                stdout_path=str(stdout_path),
                stderr_path=str(stderr_path),
                elapsed_sec=round(elapsed, 2),
                timed_out=False,
            )
        except subprocess.TimeoutExpired:
            elapsed = time.time() - t0
            logger.warning("Command timed out after %ss: %s", timeout or self.timeout, command[:80])
            return CommandResult(
                command=command,
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
                command=command,
                cwd=str(effective_cwd),
                return_code=-1,
                error=f"Executable not found: {e}",
            )
