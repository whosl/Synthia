"""Pydantic schemas for project routes."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


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


class ImportXprReq(BaseModel):
    model_config = ConfigDict(extra="ignore")

    xpr_path: str = Field(..., min_length=1)
    auto_register: bool = True


class ScanProjectReq(BaseModel):
    model_config = ConfigDict(extra="ignore")

    root_path: str = Field(..., min_length=1)


class WizardCreateReq(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str = Field(..., min_length=1)
    location: str = Field(..., min_length=1)
    part: str = ""
    board_part: str = ""
    top_module: str = ""
    target_language: str = "verilog"
    rtl_sources: list[str] = Field(default_factory=list)
    xdc_sources: list[str] = Field(default_factory=list)
    tb_sources: list[str] = Field(default_factory=list)
    ip_sources: list[str] = Field(default_factory=list)
    bd_sources: list[str] = Field(default_factory=list)
    copy_sources: bool = True


class ProjectHealthResponse(BaseModel):
    project_id: str
    status: str
    detail: str
    last_check_at: int


class ScanResponse(BaseModel):
    root: str
    is_likely_fpga_project: bool
    xpr_files: list[str] = Field(default_factory=list)
    rtl_files: list[str] = Field(default_factory=list)
    sv_files: list[str] = Field(default_factory=list)
    vhd_files: list[str] = Field(default_factory=list)
    xdc_files: list[str] = Field(default_factory=list)
    ip_files: list[str] = Field(default_factory=list)
    bd_files: list[str] = Field(default_factory=list)
    candidate_top_modules: list[str] = Field(default_factory=list)
    detected_part: str = ""


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
