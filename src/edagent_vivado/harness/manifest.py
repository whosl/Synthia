"""Manifest — Pydantic model for eda.yaml project descriptor."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel, ConfigDict, Field


# ── nested models ────────────────────────────────────────────


class ProjectInfo(BaseModel):
    name: str = "unnamed"
    vivado_version: str = "2022.1"
    flow: str = "non_project"
    part: str = ""
    top: str = "top"


class SourceLists(BaseModel):
    rtl: list[str] = []
    tb: list[str] = []
    include_dirs: list[str] = []


class ConstraintLists(BaseModel):
    xdc: list[str] = []


class RunConfig(BaseModel):
    enabled: bool = True


class RunsConfig(BaseModel):
    synth: RunConfig = RunConfig()
    impl: RunConfig = RunConfig(enabled=False)


class QorTargets(BaseModel):
    wns_min: float = 0.0
    require_drc_clean: bool = True


class IpEntry(BaseModel):
    name: str
    vendor: str = ""
    library: str = ""
    version: str = ""
    repo_path: str = ""


class RemoteInfo(BaseModel):
    """Remote execution metadata — set automatically when running on a remote host."""

    host: str = ""
    user: str = ""
    work_dir: str = ""
    vivado_path: str = ""
    vivado_version: str = ""


class Manifest(BaseModel):
    """Top-level eda.yaml manifest."""

    project: ProjectInfo = ProjectInfo()
    sources: SourceLists = SourceLists()
    constraints: ConstraintLists = ConstraintLists()
    runs: RunsConfig = RunsConfig()
    qor_targets: QorTargets = QorTargets()
    ip: list[IpEntry] = []
    remote: RemoteInfo = RemoteInfo()
    _base_dir: Path = Path()

    model_config = ConfigDict(extra="allow")

    # ── loader ────────────────────────────────────────────────

    @classmethod
    def load(cls, path: str | Path) -> "Manifest":
        p = Path(path).resolve()
        with open(p) as f:
            data = yaml.safe_load(f) or {}
        manifest = cls.model_validate(data)
        manifest._base_dir = p.parent
        return manifest

    # ── helpers ───────────────────────────────────────────────

    def resolve_path(self, relative: str) -> Path:
        return (self._base_dir / relative).resolve()

    def rtl_paths(self) -> list[Path]:
        return [self.resolve_path(r) for r in self.sources.rtl]

    def tb_paths(self) -> list[Path]:
        return [self.resolve_path(t) for t in self.sources.tb]

    def xdc_paths(self) -> list[Path]:
        return [self.resolve_path(x) for x in self.constraints.xdc]

    @property
    def base_dir(self) -> Path:
        return self._base_dir

    def name(self) -> str:
        return self.project.name

    def top(self) -> str:
        return self.project.top

    def part(self) -> str:
        return self.project.part

    def vivado_version(self) -> str:
        return self.project.vivado_version

    def flow(self) -> str:
        return self.project.flow
