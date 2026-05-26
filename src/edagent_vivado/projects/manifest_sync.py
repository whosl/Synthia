"""xpr ↔ manifest fingerprint sync check."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal


SyncStatus = Literal["in_sync", "xpr_modified", "manifest_missing", "xpr_missing", "no_xpr"]


@dataclass
class Fingerprint:
    xpr_path: str
    xpr_mtime: float
    xpr_sha256: str
    manifest_mtime: float


@dataclass
class SyncCheckResult:
    status: SyncStatus
    detail: str
    fingerprint: Fingerprint | None = None
    current_xpr_sha256: str = ""


def _sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def write_fingerprint(project_root: str | Path, xpr_path: str | Path) -> Fingerprint:
    root = Path(project_root)
    xpr = Path(xpr_path)
    if not xpr.exists():
        raise FileNotFoundError(str(xpr))

    manifest_path = root / ".synthia" / "eda.yaml"
    fp = Fingerprint(
        xpr_path=str(xpr).replace("\\", "/"),
        xpr_mtime=xpr.stat().st_mtime,
        xpr_sha256=_sha256_file(xpr),
        manifest_mtime=manifest_path.stat().st_mtime if manifest_path.exists() else 0.0,
    )
    fp_path = root / ".synthia" / ".xpr_fingerprint.json"
    fp_path.parent.mkdir(parents=True, exist_ok=True)
    fp_path.write_text(json.dumps(asdict(fp), indent=2), encoding="utf-8")
    return fp


def check_sync(project_root: str | Path) -> SyncCheckResult:
    root = Path(project_root)
    fp_path = root / ".synthia" / ".xpr_fingerprint.json"
    manifest_path = root / ".synthia" / "eda.yaml"

    if not manifest_path.exists():
        legacy = root / "eda.yaml"
        if legacy.is_file():
            return SyncCheckResult(status="no_xpr", detail="legacy manifest at root (no xpr fingerprint)")
        return SyncCheckResult(status="manifest_missing", detail=".synthia/eda.yaml not found")

    if not fp_path.exists():
        return SyncCheckResult(status="no_xpr", detail="project has no .xpr fingerprint")

    try:
        data = json.loads(fp_path.read_text(encoding="utf-8"))
        fp = Fingerprint(**data)
    except Exception as exc:
        return SyncCheckResult(status="manifest_missing", detail=f"fingerprint corrupt: {exc}")

    xpr = Path(fp.xpr_path)
    if not xpr.exists():
        return SyncCheckResult(
            status="xpr_missing",
            detail=f".xpr file not found: {fp.xpr_path}",
            fingerprint=fp,
        )

    current_sha = _sha256_file(xpr)
    if current_sha == fp.xpr_sha256:
        return SyncCheckResult(
            status="in_sync",
            detail="ok",
            fingerprint=fp,
            current_xpr_sha256=current_sha,
        )

    return SyncCheckResult(
        status="xpr_modified",
        detail=".xpr modified since last import — consider re-importing",
        fingerprint=fp,
        current_xpr_sha256=current_sha,
    )
