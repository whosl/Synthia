"""Safely apply / revert PatchProposals — Phase 7."""

from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass
from pathlib import Path

from edagent_vivado.harness.file_patch_policy import PatchPathError, _ensure_under_root
from edagent_vivado.patches.proposal import PatchChange, PatchProposal, PatchState, compute_sha256

logger = logging.getLogger(__name__)


@dataclass
class ApplyResult:
    success: bool
    applied_paths: list[str]
    backup_dir: str
    error: str = ""


@dataclass
class RevertResult:
    success: bool
    restored_paths: list[str]
    error: str = ""


class PatchApplyError(Exception):
    pass


def apply_proposal(
    proposal: PatchProposal,
    project_root: str | Path,
    *,
    dry_run: bool = False,
) -> ApplyResult:
    if proposal.state not in (PatchState.APPROVED.value, PatchState.APPROVED):
        raise PatchApplyError(f"cannot apply proposal in state {proposal.state}")

    root = Path(project_root).resolve()
    backup_dir = root / ".synthia" / "patch_backups" / proposal.id
    backup_dir.mkdir(parents=True, exist_ok=True)

    applied: list[tuple[Path, Path | None]] = []

    try:
        for ch in proposal.changes:
            try:
                target = _ensure_under_root(Path(ch.path), root)
            except PatchPathError as exc:
                raise PatchApplyError(f"refused: {exc}") from exc

            backup_path: Path | None = None
            if target.exists() and ch.action in ("modify", "delete"):
                current = (
                    compute_sha256(target.read_bytes())
                    if ch.is_binary
                    else compute_sha256(target.read_text(encoding="utf-8", errors="replace"))
                )
                if ch.before_sha256 and current != ch.before_sha256:
                    raise PatchApplyError(
                        f"sha256 mismatch on {ch.path}: expected {ch.before_sha256[:8]}, "
                        f"got {current[:8]}"
                    )
                try:
                    rel = target.relative_to(root)
                except ValueError:
                    rel = Path(ch.path)
                backup_path = backup_dir / rel
                backup_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, backup_path)

            if dry_run:
                applied.append((target, backup_path))
                continue

            if ch.action == "delete":
                target.unlink()
            elif ch.action == "create":
                if target.exists():
                    raise PatchApplyError(f"refused: file exists for create: {ch.path}")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(ch.after_text, encoding="utf-8")
            elif ch.action == "modify":
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(ch.after_text, encoding="utf-8")
            else:
                raise PatchApplyError(f"unknown action: {ch.action}")

            if ch.after_sha256 and target.exists():
                produced = (
                    compute_sha256(target.read_bytes())
                    if ch.is_binary
                    else compute_sha256(target.read_text(encoding="utf-8", errors="replace"))
                )
                if produced != ch.after_sha256:
                    raise PatchApplyError(
                        f"sha256 mismatch after write on {ch.path}: expected {ch.after_sha256[:8]}"
                    )

            applied.append((target, backup_path))

        return ApplyResult(
            success=True,
            applied_paths=[str(t) for t, _ in applied],
            backup_dir=str(backup_dir),
        )

    except Exception as exc:
        logger.exception("apply failed; rolling back %d changes", len(applied))
        for target, backup in reversed(applied):
            try:
                if backup and backup.exists():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(backup, target)
                elif target.exists() and backup is None:
                    target.unlink(missing_ok=True)
            except Exception:
                logger.exception("rollback failed for %s", target)
        return ApplyResult(
            success=False,
            applied_paths=[],
            backup_dir=str(backup_dir),
            error=str(exc),
        )


def revert_proposal(proposal: PatchProposal, project_root: str | Path) -> RevertResult:
    root = Path(project_root).resolve()
    backup_dir = root / ".synthia" / "patch_backups" / proposal.id
    if not backup_dir.exists():
        return RevertResult(success=False, restored_paths=[], error=f"backup dir not found: {backup_dir}")

    restored: list[str] = []

    for ch in proposal.changes:
        try:
            target = _ensure_under_root(Path(ch.path), root)
        except PatchPathError as exc:
            logger.warning("skipping revert of %s: %s", ch.path, exc)
            continue
        try:
            rel = target.relative_to(root)
        except ValueError:
            rel = Path(ch.path)
        backup = backup_dir / rel

        if ch.action == "create":
            if target.exists():
                target.unlink()
                restored.append(str(target))
        elif ch.action in ("modify", "delete"):
            if backup.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(backup, target)
                restored.append(str(target))

    return RevertResult(success=True, restored_paths=restored)
