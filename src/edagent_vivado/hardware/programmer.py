"""Bitstream programming — Phase 12."""

from __future__ import annotations

import hashlib
import logging
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import NamedTuple

from edagent_vivado.hardware.models import ProgramJob, ProgramJobState
from edagent_vivado.hardware.target_registry import target_get, target_update

logger = logging.getLogger(__name__)


class ProgramResult(NamedTuple):
    success: bool
    log_path: str
    error: str = ""
    elapsed_ms: int = 0


_TCL_PROGRAM = r"""
open_hw_manager
connect_hw_server -url {<<XVC_URL>>}
open_hw_target {<<TARGET>>}
set_property PROGRAM.FILE {<<BIT_PATH>>} [current_hw_device]
program_hw_devices -force
close_hw_target -quiet
disconnect_hw_server
close_hw_manager
exit 0
"""


def program_target(
    job: ProgramJob,
    *,
    vivado_path: str = "vivado",
    xvc_url: str = "tcp::3121",
    timeout_s: int = 900,
    log_dir: str | None = None,
) -> ProgramResult:
    """Program a target. Returns success/failure + log path."""
    if job.state not in (
        ProgramJobState.APPROVED.value,
        ProgramJobState.PROGRAMMING.value,
    ):
        return ProgramResult(False, "", f"job not ready to program (was {job.state})")

    bit = Path(job.bitstream_path)
    if not bit.exists():
        return ProgramResult(False, "", f"bitstream not found: {bit}")

    actual = sha256_file(bit)
    if actual != job.bitstream_sha256:
        return ProgramResult(
            False,
            "",
            f"sha256 mismatch: expected {job.bitstream_sha256[:8]}, got {actual[:8]}",
        )

    target = target_get(job.target_id)
    if not target:
        return ProgramResult(False, "", "target not found")

    serial = target["serial"]
    xvc = target.get("xvc_url") or xvc_url

    target_update(job.target_id, state="busy")

    log_path = Path(log_dir or tempfile.gettempdir()) / f"program-{job.id}.log"

    if os.environ.get("SYNTHIA_HW_MOCK_PROGRAM") or vivado_path == "mock":
        return _mock_program(job, log_path, serial)

    tcl = (
        _TCL_PROGRAM.replace("<<XVC_URL>>", xvc)
        .replace("<<TARGET>>", serial.replace("\\", "/"))
        .replace("<<BIT_PATH>>", str(bit).replace("\\", "/"))
    )

    with tempfile.NamedTemporaryFile("w", suffix=".tcl", delete=False) as f:
        f.write(tcl)
        tcl_path = f.name

    started = time.time()
    try:
        cmd = [
            vivado_path,
            "-mode",
            "batch",
            "-nojournal",
            "-log",
            str(log_path),
            "-source",
            tcl_path,
        ]
        logger.info("programming: %s", " ".join(cmd))
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
        elapsed_ms = int((time.time() - started) * 1000)

        success = proc.returncode == 0

        try:
            log_content = log_path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            log_content = ""

        if "ERROR:" in log_content and "Programming" in log_content:
            success = False
        if "Programming failed" in log_content:
            success = False

        err = ""
        if not success:
            err = _extract_error(log_content) or f"vivado exit code {proc.returncode}"

        return ProgramResult(
            success=success,
            log_path=str(log_path),
            error=err,
            elapsed_ms=elapsed_ms,
        )
    except subprocess.TimeoutExpired:
        return ProgramResult(
            False,
            str(log_path),
            f"timeout after {timeout_s}s",
            elapsed_ms=int((time.time() - started) * 1000),
        )
    except FileNotFoundError:
        return ProgramResult(False, str(log_path), f"vivado not found: {vivado_path}")
    finally:
        try:
            Path(tcl_path).unlink()
        except OSError:
            pass
        target_update(job.target_id, state="available")


def _mock_program(job: ProgramJob, log_path: Path, serial: str) -> ProgramResult:
    started = time.time()
    try:
        log_path.write_text(
            f"MOCK PROGRAM OK\nserial={serial}\nbit={job.bitstream_path}\n",
            encoding="utf-8",
        )
        elapsed_ms = int((time.time() - started) * 1000)
        return ProgramResult(True, str(log_path), elapsed_ms=elapsed_ms)
    finally:
        target_update(job.target_id, state="available")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _extract_error(log: str) -> str:
    for line in log.splitlines():
        if "ERROR:" in line or "CRITICAL WARNING:" in line:
            return line.strip()[:300]
    return ""
