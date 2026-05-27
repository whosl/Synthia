"""HW target detection via Vivado Hardware Manager — Phase 12."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import NamedTuple

from edagent_vivado.hardware.models import HardwareTarget
from edagent_vivado.hardware.target_registry import (
    target_create,
    target_get_by_serial,
    target_list,
    target_mark_seen,
    target_update,
)

logger = logging.getLogger(__name__)


class DetectedDevice(NamedTuple):
    target: str
    device: str
    part: str


_TCL_DETECT = r"""
open_hw_manager
if {[catch {connect_hw_server -url {tcp::3121} -quiet} err]} {
    puts "CONNECT_ERROR: $err"
    exit 1
}
puts "TARGETS_BEGIN"
set targets [get_hw_targets]
foreach t $targets {
    puts "TARGET: $t"
    if {[catch {open_hw_target $t -quiet} err]} {
        puts "  TARGET_OPEN_ERROR: $err"
        continue
    }
    foreach d [get_hw_devices] {
        set part [get_property PART $d]
        puts "  DEVICE: $d part=$part"
    }
    close_hw_target -quiet
}
puts "TARGETS_END"
disconnect_hw_server
close_hw_manager
exit 0
"""


def detect_targets(
    *,
    vivado_path: str = "vivado",
    xvc_url: str = "tcp::3121",
    timeout_s: int = 60,
) -> list[DetectedDevice]:
    """Run vivado -mode batch with detect script. Returns list of detected devices."""
    if os.environ.get("SYNTHIA_HW_MOCK_DETECT"):
        return _mock_detect_devices()

    tcl = _TCL_DETECT
    if xvc_url and xvc_url != "tcp::3121":
        tcl = tcl.replace("tcp::3121", xvc_url)

    with tempfile.NamedTemporaryFile("w", suffix=".tcl", delete=False) as f:
        f.write(tcl)
        tcl_path = f.name

    try:
        cmd = [vivado_path, "-mode", "batch", "-nojournal", "-nolog", "-source", tcl_path]
        logger.info("running: %s", " ".join(cmd))
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
        output = (proc.stdout or "") + "\n" + (proc.stderr or "")
        return _parse_detect_output(output)
    except subprocess.TimeoutExpired:
        logger.error("vivado detect timed out after %ds", timeout_s)
        return []
    except FileNotFoundError:
        logger.warning("vivado not found at %s", vivado_path)
        return []
    finally:
        try:
            Path(tcl_path).unlink()
        except OSError:
            pass


def _mock_detect_devices() -> list[DetectedDevice]:
    raw = os.environ.get("SYNTHIA_HW_MOCK_TARGETS", "")
    if raw:
        try:
            items = json.loads(raw)
            return [
                DetectedDevice(
                    target=d["target"],
                    device=d.get("device", d["target"]),
                    part=d["part"],
                )
                for d in items
            ]
        except (json.JSONDecodeError, KeyError, TypeError):
            logger.warning("invalid SYNTHIA_HW_MOCK_TARGETS JSON")
    return [
        DetectedDevice(
            target="Mock/Xilinx/0",
            device="xc7a50t_0",
            part="xc7a50tfgg484-2",
        ),
    ]


def _parse_detect_output(output: str) -> list[DetectedDevice]:
    """Parse the lines from the Tcl script."""
    devices: list[DetectedDevice] = []
    in_targets = False
    current_target = ""
    for line in output.splitlines():
        line = line.strip()
        if line == "TARGETS_BEGIN":
            in_targets = True
            continue
        if line == "TARGETS_END":
            in_targets = False
            continue
        if not in_targets:
            continue
        if line.startswith("TARGET:"):
            current_target = line[7:].strip()
            continue
        m = re.match(r"DEVICE:\s+(\S+)\s+part=(\S+)", line)
        if m and current_target:
            devices.append(
                DetectedDevice(
                    target=current_target,
                    device=m.group(1),
                    part=m.group(2),
                )
            )
    return devices


def sync_detected_to_registry(
    detected: list[DetectedDevice], *, host: str = "",
) -> dict[str, int]:
    """Update DB: create new targets, mark existing as seen, mark missing as offline."""
    stats = {"created": 0, "seen": 0, "offline": 0}
    seen_serials = set()

    for d in detected:
        seen_serials.add(d.target)
        existing = target_get_by_serial(d.target)
        if existing:
            target_mark_seen(existing["id"])
            if existing.get("part") != d.part:
                target_update(existing["id"], part=d.part)
            stats["seen"] += 1
        else:
            t = HardwareTarget.new(
                name=f"{d.part} ({d.target.split('/')[-1]})",
                serial=d.target,
                part=d.part,
                host=host,
            )
            target_create(t)
            stats["created"] += 1

    for t in target_list():
        if t["state"] in ("retired", "offline"):
            continue
        if t["serial"] not in seen_serials:
            target_update(t["id"], state="offline")
            stats["offline"] += 1

    return stats
