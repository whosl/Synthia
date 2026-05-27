"""SQLite store for benchmark suites/cases — Phase 10."""

from __future__ import annotations

import json
from typing import Any

from edagent_vivado.benchmarks.models import BenchmarkCase, BenchmarkSuite, SuiteConfig
from edagent_vivado.repository.db import get_db


def suite_create(suite: BenchmarkSuite) -> str:
    db = get_db()
    cfg = suite.config.to_dict() if isinstance(suite.config, SuiteConfig) else suite.config
    db.execute(
        "INSERT INTO benchmark_suites "
        "(id, name, description, project_id, created_by, state, "
        "total_cases, config_json, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (
            suite.id,
            suite.name,
            suite.description,
            suite.project_id,
            suite.created_by,
            suite.state,
            len(suite.cases),
            json.dumps(cfg),
            suite.created_at,
        ),
    )
    for c in suite.cases:
        case_insert(c)
    db.commit()
    return suite.id


def case_insert(case: BenchmarkCase) -> None:
    db = get_db()
    db.execute(
        "INSERT INTO benchmark_cases "
        "(id, suite_id, name, description, sequence, flow_name, "
        "inputs_json, expected_json, state) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (
            case.id,
            case.suite_id,
            case.name,
            case.description,
            case.sequence,
            case.flow_name,
            json.dumps(case.inputs),
            json.dumps(case.expected),
            case.state,
        ),
    )


def suite_get(suite_id: str) -> dict | None:
    db = get_db()
    s = db.execute("SELECT * FROM benchmark_suites WHERE id=?", (suite_id,)).fetchone()
    if not s:
        return None
    d = dict(s)
    d["config"] = json.loads(d.get("config_json") or "{}")
    d["cases"] = [
        _case_row(r)
        for r in db.execute(
            "SELECT * FROM benchmark_cases WHERE suite_id=? ORDER BY sequence",
            (suite_id,),
        ).fetchall()
    ]
    return d


def suite_list(*, project_id: str = "", state: str = "", limit: int = 100) -> list[dict]:
    where: list[str] = []
    params: list[Any] = []
    if project_id:
        where.append("project_id=?")
        params.append(project_id)
    if state:
        where.append("state=?")
        params.append(state)
    sql = "SELECT * FROM benchmark_suites"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    db = get_db()
    return [dict(r) for r in db.execute(sql, params).fetchall()]


def suite_update(suite_id: str, **fields) -> None:
    if not fields:
        return
    if "config" in fields:
        cfg = fields.pop("config")
        fields["config_json"] = json.dumps(cfg.to_dict() if hasattr(cfg, "to_dict") else cfg)
    db = get_db()
    sql = "UPDATE benchmark_suites SET " + ", ".join(f"{k}=?" for k in fields) + " WHERE id=?"
    db.execute(sql, (*fields.values(), suite_id))
    db.commit()


def case_update(case_id: str, **fields) -> None:
    if not fields:
        return
    for k in ("metrics", "inputs", "expected"):
        if k in fields and isinstance(fields[k], dict):
            fields[f"{k}_json"] = json.dumps(fields.pop(k))
    db = get_db()
    sql = "UPDATE benchmark_cases SET " + ", ".join(f"{k}=?" for k in fields) + " WHERE id=?"
    db.execute(sql, (*fields.values(), case_id))
    db.commit()


def case_get(case_id: str) -> dict | None:
    db = get_db()
    r = db.execute("SELECT * FROM benchmark_cases WHERE id=?", (case_id,)).fetchone()
    return _case_row(r) if r else None


def _case_row(r) -> dict:
    d = dict(r)
    d["inputs"] = json.loads(d.get("inputs_json") or "{}")
    d["expected"] = json.loads(d.get("expected_json") or "{}")
    d["metrics"] = json.loads(d.get("metrics_json") or "{}")
    return d


def suite_aggregate_counts(suite_id: str) -> dict[str, int]:
    db = get_db()
    rows = db.execute(
        "SELECT state, COUNT(*) FROM benchmark_cases WHERE suite_id=? GROUP BY state",
        (suite_id,),
    ).fetchall()
    return {r[0]: r[1] for r in rows}
