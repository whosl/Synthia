"""Pydantic schemas for project routes."""

from __future__ import annotations

from pydantic import BaseModel


class CreateProjectReq(BaseModel):
    name: str
    root_path: str
    manifest_path: str
    xpr_path: str = ""
    part: str | None = None
    board_part: str | None = None
    top_module: str | None = None
    target_language: str | None = None
    simulator: str | None = None
    source_globs: list[str] | None = None
    constraint_globs: list[str] | None = None
    tcl_globs: list[str] | None = None
    default_vivado_target_id: str | None = None
    metadata: dict | None = None


class CreateSessionReq(BaseModel):
    name: str = ""
    project_id: str = ""
    manifest_path: str = ""
    metadata: dict | None = None


class UpdateProjectReq(BaseModel):
    name: str | None = None
    status: str | None = None
    root_path: str | None = None
    manifest_path: str | None = None
    xpr_path: str | None = None
    part: str | None = None
    board_part: str | None = None
    top_module: str | None = None
    target_language: str | None = None
    simulator: str | None = None
    source_globs: list[str] | None = None
    constraint_globs: list[str] | None = None
    tcl_globs: list[str] | None = None
    default_vivado_target_id: str | None = None
    metadata: dict | None = None
