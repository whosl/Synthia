"""Benchmark suite API — Phase 10."""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from edagent_vivado.benchmarks.executor import execute_suite_async
from edagent_vivado.benchmarks.exporter import export_csv, export_json, export_markdown, export_zip
from edagent_vivado.benchmarks.models import BenchmarkSuite, SuiteConfig, make_case
from edagent_vivado.benchmarks.suite_store import suite_create, suite_get, suite_list, suite_update
from edagent_vivado.web.dependencies import get_identity, require_perm

router = APIRouter(prefix="/benchmarks", tags=["benchmarks"])


class CaseSpec(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    description: str = ""
    flow_name: str
    inputs: dict = Field(default_factory=dict)
    expected: dict = Field(default_factory=dict)


class CreateSuiteReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(..., min_length=1)
    description: str = ""
    project_id: str = Field(..., min_length=1)
    cases: list[CaseSpec] = Field(default_factory=list)
    config: dict = Field(default_factory=dict)


@router.post("", dependencies=[Depends(require_perm("benchmark.create", project_id_param=""))])
async def api_create_suite(req: CreateSuiteReq, identity=Depends(get_identity)):
    cfg = SuiteConfig(
        **{k: v for k, v in req.config.items() if k in SuiteConfig.__dataclass_fields__}
    )
    suite = BenchmarkSuite.new(
        name=req.name,
        description=req.description,
        project_id=req.project_id,
        config=cfg,
        created_by=identity.user.id,
    )
    suite.cases = [
        make_case(
            suite_id=suite.id,
            name=c.name,
            sequence=i,
            flow_name=c.flow_name,
            inputs=c.inputs,
            description=c.description,
            expected=c.expected,
        )
        for i, c in enumerate(req.cases)
    ]
    suite.total_cases = len(suite.cases)
    suite_create(suite)
    return suite_get(suite.id)


@router.get("", dependencies=[Depends(require_perm("benchmark.read", project_id_param=""))])
async def api_list_suites(project_id: str = "", state: str = "", limit: int = 50):
    return {"suites": suite_list(project_id=project_id, state=state, limit=limit)}


@router.get("/{suite_id}", dependencies=[Depends(require_perm("benchmark.read", project_id_param=""))])
async def api_get_suite(suite_id: str):
    s = suite_get(suite_id)
    if not s:
        raise HTTPException(404, "suite not found")
    return s


@router.post("/{suite_id}/run", dependencies=[Depends(require_perm("benchmark.run", project_id_param=""))])
async def api_run_suite(suite_id: str):
    s = suite_get(suite_id)
    if not s:
        raise HTTPException(404, "suite not found")
    if s["state"] == "running":
        raise HTTPException(409, "already running")
    suite_update(suite_id, state="queued")
    execute_suite_async(suite_id, session_id="")
    return {"ok": True, "suite_id": suite_id}


@router.post("/{suite_id}/cancel", dependencies=[Depends(require_perm("benchmark.run", project_id_param=""))])
async def api_cancel_suite(suite_id: str):
    s = suite_get(suite_id)
    if not s:
        raise HTTPException(404, "suite not found")
    suite_update(suite_id, state="cancelled")
    return {"ok": True}


@router.get(
    "/{suite_id}/export/csv",
    dependencies=[Depends(require_perm("benchmark.read", project_id_param=""))],
)
async def api_export_csv(suite_id: str):
    if not suite_get(suite_id):
        raise HTTPException(404, "suite not found")
    text = export_csv(suite_id)
    return Response(
        content=text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{suite_id}.csv"'},
    )


@router.get(
    "/{suite_id}/export/markdown",
    dependencies=[Depends(require_perm("benchmark.read", project_id_param=""))],
)
async def api_export_md(suite_id: str):
    if not suite_get(suite_id):
        raise HTTPException(404, "suite not found")
    text = export_markdown(suite_id)
    return Response(
        content=text,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{suite_id}.md"'},
    )


@router.get(
    "/{suite_id}/export/json",
    dependencies=[Depends(require_perm("benchmark.read", project_id_param=""))],
)
async def api_export_json(suite_id: str):
    if not suite_get(suite_id):
        raise HTTPException(404, "suite not found")
    return Response(content=export_json(suite_id), media_type="application/json")


@router.get(
    "/{suite_id}/export/zip",
    dependencies=[Depends(require_perm("benchmark.read", project_id_param=""))],
)
async def api_export_zip(suite_id: str):
    if not suite_get(suite_id):
        raise HTTPException(404, "suite not found")
    tmp = Path(tempfile.gettempdir()) / f"benchmark-{suite_id}.zip"
    export_zip(suite_id, str(tmp))
    return FileResponse(tmp, media_type="application/zip", filename=f"benchmark-{suite_id}.zip")
