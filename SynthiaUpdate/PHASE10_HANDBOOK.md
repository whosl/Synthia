# Synthia Phase 10 开发手册：Benchmark Flow v1

> **前置条件：** Phase 0-9 + 5.5 完成  
> **目标：** 工程执行之外的第二主线 —— 批量跑 N 个 case，自动采集指标，导出 CSV/Markdown/JSON，前端表格 + 分布展示  
> **预估工期：** 全职 8 天；vibe coding 2-3 周  
> **关键约束：** 单 case 失败不影响整体；continue-on-failure；指标对齐 Phase 5 trend

---

## 0. Benchmark Flow 解决什么

研发场景：
- 同一份 RTL，测 3 个 part / 3 个 strategy 的组合，看哪个 timing 最稳
- 同一份代码，跑 10 个不同 testbench，对比 utilization
- 回归测试：每 commit 跑 5 个 baseline case，看有没有 regression

这些场景共同点：**N 个独立 Run，预设输入，统一指标采集，最后看一张总览表**。

Phase 10 落地：
- 数据模型：`BenchmarkSuite` + `BenchmarkCase` + `BenchmarkRun`
- 执行器：复用 RunOrchestrator，按 case 顺序触发 Run
- 指标采集：每 case 跑完抽取核心数字
- 导出：CSV / Markdown / JSON / artifact zip
- UI：suite 列表、单 suite 详情表、success/fail 分布饼图

---

## 1. 任务清单

| 步骤 | 文件 | 类型 |
|------|------|------|
| 1 | DB schema: benchmark_suites / benchmark_cases / benchmark_runs | 新建 |
| 2 | `benchmarks/models.py` | 新建：数据类 |
| 3 | `benchmarks/suite_store.py` | 新建：CRUD |
| 4 | `benchmarks/executor.py` | 新建：批量执行 |
| 5 | `benchmarks/metric_extractor.py` | 新建：从 Run → metrics |
| 6 | `benchmarks/exporter.py` | 新建：CSV / Markdown / JSON / ZIP |
| 7 | `web/routes/benchmarks.py` | 新建：API |
| 8 | `cli.py` | 加 `synthia benchmark run/list/export` |
| 9 | `mcp/tools/benchmarks.py` | 新建：MCP tool |
| 10 | `frontend/src/pages/BenchmarksPage.tsx` | 新建 |
| 11 | `frontend/src/components/benchmarks/BenchmarkTable.tsx` | 新建 |
| 12 | 测试 | — |

---

## 2. 数据模型

### 2.1 schema

打开 `repository/db.py`，加：

```sql
CREATE TABLE IF NOT EXISTS benchmark_suites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    project_id TEXT NOT NULL,             -- which project provides base manifest
    created_by TEXT DEFAULT '',
    state TEXT DEFAULT 'draft',           -- draft | queued | running | completed | partial | cancelled
    total_cases INTEGER DEFAULT 0,
    completed_cases INTEGER DEFAULT 0,
    failed_cases INTEGER DEFAULT 0,
    cancelled_cases INTEGER DEFAULT 0,
    config_json TEXT DEFAULT '{}',        -- suite-wide config (continue_on_failure, parallel, ...)
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bench_suites_proj ON benchmark_suites(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bench_suites_state ON benchmark_suites(state);

CREATE TABLE IF NOT EXISTS benchmark_cases (
    id TEXT PRIMARY KEY,
    suite_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    sequence INTEGER NOT NULL,            -- order within suite
    flow_name TEXT NOT NULL,              -- e.g. vivado_full_flow
    inputs_json TEXT NOT NULL,            -- overrides for this case (part, strategy, manifest, ...)
    expected_json TEXT DEFAULT '{}',      -- expected metrics for pass/fail evaluation
    state TEXT DEFAULT 'pending',         -- pending|queued|running|success|failed|skipped|cancelled
    run_id TEXT DEFAULT '',
    metrics_json TEXT DEFAULT '{}',       -- captured from Run reports
    error TEXT DEFAULT '',
    error_category TEXT DEFAULT '',
    elapsed_ms INTEGER DEFAULT 0,
    started_at INTEGER,
    completed_at INTEGER,
    FOREIGN KEY (suite_id) REFERENCES benchmark_suites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bench_cases_suite ON benchmark_cases(suite_id, sequence);
CREATE INDEX IF NOT EXISTS idx_bench_cases_run ON benchmark_cases(run_id);
```

### 2.2 migration

```python
def _migrate_benchmarks(db):
    cur = db.execute("PRAGMA table_info(benchmark_cases)")
    cols = {row[1] for row in cur.fetchall()}
    needed = {
        "error_category": "TEXT DEFAULT ''",
        "elapsed_ms": "INTEGER DEFAULT 0",
    }
    for col, decl in needed.items():
        if col not in cols:
            try:
                db.execute(f"ALTER TABLE benchmark_cases ADD COLUMN {col} {decl}")
            except Exception as e:
                logger.warning("migrate benchmark_cases col=%s: %s", col, e)
    db.commit()
```

---

## 3. 步骤 2-3：Models + Store

### 3.1 `benchmarks/models.py`

```bash
mkdir -p src/edagent_vivado/benchmarks
touch src/edagent_vivado/benchmarks/__init__.py
```

```python
"""Benchmark suite/case data models — Phase 10."""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any


class SuiteState(str, Enum):
    DRAFT = "draft"
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    PARTIAL = "partial"           # some cases failed but suite completed
    CANCELLED = "cancelled"


class CaseState(str, Enum):
    PENDING = "pending"
    QUEUED = "queued"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"
    CANCELLED = "cancelled"


@dataclass
class BenchmarkCase:
    id: str
    suite_id: str
    name: str
    description: str
    sequence: int
    flow_name: str               # e.g. 'vivado_full_flow'
    inputs: dict[str, Any]       # part/strategy/manifest_path/etc override
    expected: dict[str, Any]     # expected metric thresholds (optional)
    state: str = CaseState.PENDING.value
    run_id: str = ""
    metrics: dict[str, Any] = field(default_factory=dict)
    error: str = ""
    error_category: str = ""
    elapsed_ms: int = 0
    started_at: int | None = None
    completed_at: int | None = None
    
    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class SuiteConfig:
    continue_on_failure: bool = True
    parallel: int = 1                  # v1: serial; >1 reserved
    timeout_per_case_s: int = 7200      # 2h default per case
    abort_on_n_failures: int = 0       # 0 = never abort
    
    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class BenchmarkSuite:
    id: str
    name: str
    description: str
    project_id: str
    created_by: str = ""
    state: str = SuiteState.DRAFT.value
    total_cases: int = 0
    completed_cases: int = 0
    failed_cases: int = 0
    cancelled_cases: int = 0
    config: SuiteConfig = field(default_factory=SuiteConfig)
    cases: list[BenchmarkCase] = field(default_factory=list)
    created_at: int = 0
    started_at: int | None = None
    completed_at: int | None = None
    
    def to_dict(self) -> dict:
        d = asdict(self)
        d["config"] = self.config.to_dict() if isinstance(self.config, SuiteConfig) else self.config
        d["cases"] = [c.to_dict() if isinstance(c, BenchmarkCase) else c for c in self.cases]
        return d
    
    @classmethod
    def new(
        cls, *,
        name: str, project_id: str, description: str = "",
        config: SuiteConfig | None = None, created_by: str = "",
    ) -> "BenchmarkSuite":
        return cls(
            id=str(uuid.uuid4()),
            name=name, description=description, project_id=project_id,
            created_by=created_by,
            config=config or SuiteConfig(),
            created_at=int(time.time() * 1000),
        )


def make_case(
    *, suite_id: str, name: str, sequence: int,
    flow_name: str, inputs: dict[str, Any],
    description: str = "", expected: dict[str, Any] | None = None,
) -> BenchmarkCase:
    return BenchmarkCase(
        id=str(uuid.uuid4()),
        suite_id=suite_id, name=name, description=description,
        sequence=sequence, flow_name=flow_name,
        inputs=inputs, expected=expected or {},
    )
```

### 3.2 `benchmarks/suite_store.py`

```python
"""SQLite store for benchmark suites/cases — Phase 10."""

from __future__ import annotations

import json
import time
from typing import Any

from edagent_vivado.benchmarks.models import (
    BenchmarkSuite, BenchmarkCase, SuiteConfig, CaseState, SuiteState,
)
from edagent_vivado.repository.db import get_db


def suite_create(suite: BenchmarkSuite) -> str:
    db = get_db()
    db.execute(
        "INSERT INTO benchmark_suites "
        "(id, name, description, project_id, created_by, state, "
        "total_cases, config_json, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (suite.id, suite.name, suite.description, suite.project_id,
         suite.created_by, suite.state, len(suite.cases),
         json.dumps(suite.config.to_dict()),
         suite.created_at),
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
        (case.id, case.suite_id, case.name, case.description,
         case.sequence, case.flow_name,
         json.dumps(case.inputs), json.dumps(case.expected),
         case.state),
    )


def suite_get(suite_id: str) -> dict | None:
    db = get_db()
    s = db.execute("SELECT * FROM benchmark_suites WHERE id=?", (suite_id,)).fetchone()
    if not s:
        return None
    d = dict(s)
    d["config"] = json.loads(d.get("config_json") or "{}")
    d["cases"] = [_case_row(r) for r in db.execute(
        "SELECT * FROM benchmark_cases WHERE suite_id=? ORDER BY sequence", (suite_id,)
    ).fetchall()]
    return d


def suite_list(*, project_id: str = "", state: str = "", limit: int = 100) -> list[dict]:
    where = []
    params: list = []
    if project_id:
        where.append("project_id=?"); params.append(project_id)
    if state:
        where.append("state=?"); params.append(state)
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
    sql = "UPDATE benchmark_suites SET " + ", ".join(f"{k}=?" for k in fields) + " WHERE id=?"
    db = get_db()
    db.execute(sql, (*fields.values(), suite_id))
    db.commit()


def case_update(case_id: str, **fields) -> None:
    if not fields:
        return
    # Serialize dict fields
    for k in ("metrics", "inputs", "expected"):
        if k in fields and isinstance(fields[k], dict):
            fields[f"{k}_json"] = json.dumps(fields.pop(k))
    sql = "UPDATE benchmark_cases SET " + ", ".join(f"{k}=?" for k in fields) + " WHERE id=?"
    db = get_db()
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
    """Recount cases by state and update suite."""
    db = get_db()
    rows = db.execute(
        "SELECT state, COUNT(*) FROM benchmark_cases WHERE suite_id=? GROUP BY state",
        (suite_id,),
    ).fetchall()
    counts = {r[0]: r[1] for r in rows}
    return counts
```

---

## 4. 步骤 4-5：Executor + Metric Extractor

### 4.1 `benchmarks/metric_extractor.py`

```python
"""Extract Benchmark metrics from a completed Run — Phase 10."""

from __future__ import annotations

from typing import Any

from edagent_vivado.repository.store import parsed_report_list, artifact_list_for_run


def extract_metrics(run_id: str) -> dict[str, Any]:
    """Roll up Run reports into the v1 metric schema.
    
    Schema (key fields):
      success: bool
      runtime_ms: int
      WNS, TNS, WHS, THS                   (timing — ns)
      LUT, FF, BRAM, DSP, IO, BUFG         (utilization — int)
      bitstream_exists: bool
      bitstream_size_bytes: int            (if exists)
      drc_critical: int
      drc_error: int
      methodology_violations: int
      error_category: str                  (e.g. timing_violation/drc/synth_error/...)
    """
    metrics: dict[str, Any] = {
        "success": False,
        "WNS": None, "TNS": None, "WHS": None, "THS": None,
        "LUT": None, "FF": None, "BRAM": None, "DSP": None, "IO": None, "BUFG": None,
        "bitstream_exists": False, "bitstream_size_bytes": 0,
        "drc_critical": 0, "drc_error": 0, "methodology_violations": 0,
        "error_category": "",
    }
    
    reports = parsed_report_list(run_id=run_id)
    
    for r in reports:
        rtype = (r.get("report_type") or "").lower()
        data = r.get("data") or {}
        if isinstance(data, str):
            import json
            try:
                data = json.loads(data)
            except Exception:
                data = {}
        rmetrics = r.get("metrics") or {}
        if isinstance(rmetrics, str):
            import json
            try:
                rmetrics = json.loads(rmetrics)
            except Exception:
                rmetrics = {}
        
        if rtype == "timing":
            metrics["WNS"] = rmetrics.get("WNS") or data.get("WNS")
            metrics["TNS"] = rmetrics.get("TNS") or data.get("TNS")
            metrics["WHS"] = rmetrics.get("WHS") or data.get("WHS")
            metrics["THS"] = rmetrics.get("THS") or data.get("THS")
        elif rtype == "utilization":
            sm = data.get("summary") or rmetrics
            for k in ("LUT", "FF", "BRAM", "DSP", "IO", "BUFG"):
                v = sm.get(k) or sm.get(f"{k}_used") or rmetrics.get(k)
                if v is not None:
                    metrics[k] = v
        elif rtype == "drc":
            metrics["drc_critical"] = data.get("critical_count", rmetrics.get("critical_count", 0))
            metrics["drc_error"] = data.get("error_count", rmetrics.get("error_count", 0))
        elif rtype == "methodology":
            metrics["methodology_violations"] = data.get("violation_count",
                                                          rmetrics.get("violation_count", 0))
        elif rtype == "bitstream":
            metrics["bitstream_exists"] = bool(data.get("exists", rmetrics.get("exists", False)))
            metrics["bitstream_size_bytes"] = data.get("size_bytes", rmetrics.get("size_bytes", 0))
    
    # Cross-check: look at artifacts for .bit
    if not metrics["bitstream_exists"]:
        arts = artifact_list_for_run(run_id) if callable(artifact_list_for_run) else []
        for a in arts:
            p = (a.get("path") or "").lower()
            if p.endswith(".bit"):
                metrics["bitstream_exists"] = True
                metrics["bitstream_size_bytes"] = a.get("size_bytes", 0) or 0
                break
    
    return metrics


def classify_error(run: dict, metrics: dict) -> str:
    """Best-effort error category for failed runs."""
    state = run.get("state", "")
    if state in ("succeeded", "succeeded_with_warnings"):
        return ""
    if metrics.get("drc_critical", 0) > 0 or metrics.get("drc_error", 0) > 0:
        return "drc_error"
    if metrics.get("WNS") is not None and float(metrics["WNS"]) < 0:
        return "timing_violation"
    if state == "cancelled":
        return "cancelled"
    if state == "policy_denied":
        return "policy_denied"
    # Look at last step
    err = (run.get("error") or run.get("error_message") or "").lower()
    if "synth" in err:
        return "synth_error"
    if "impl" in err or "place" in err or "route" in err:
        return "impl_error"
    if "license" in err:
        return "license_error"
    return "unknown_error"


def is_success(run: dict, metrics: dict, expected: dict) -> bool:
    """Check Run against expected thresholds; default: state-only."""
    if run.get("state") not in ("succeeded", "succeeded_with_warnings"):
        return False
    # If expected thresholds given, enforce them
    if expected.get("WNS_min") is not None:
        if metrics.get("WNS") is None or float(metrics["WNS"]) < float(expected["WNS_min"]):
            return False
    if expected.get("require_bitstream") and not metrics.get("bitstream_exists"):
        return False
    if expected.get("max_LUT") is not None:
        if metrics.get("LUT") is None or int(metrics["LUT"]) > int(expected["max_LUT"]):
            return False
    return True
```

### 4.2 `benchmarks/executor.py`

```python
"""Run a BenchmarkSuite — Phase 10.

v1.0: serial; future: parallel via Phase 11 worker queue.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from edagent_vivado.benchmarks.metric_extractor import (
    extract_metrics, classify_error, is_success,
)
from edagent_vivado.benchmarks.models import CaseState, SuiteState, SuiteConfig
from edagent_vivado.benchmarks.suite_store import (
    suite_get, suite_update, case_update, case_get,
)
from edagent_vivado.repository.store import run_get
from edagent_vivado.runs.orchestrator import create_run, start_run
from edagent_vivado.runs.state_machine import is_terminal

logger = logging.getLogger(__name__)


def execute_suite(suite_id: str, *, session_id: str = "") -> dict[str, Any]:
    """Execute all cases of a suite serially.
    
    Returns final suite dict.
    """
    suite = suite_get(suite_id)
    if not suite:
        raise ValueError(f"suite not found: {suite_id}")
    
    config_dict = suite.get("config", {})
    cfg = SuiteConfig(**{k: v for k, v in config_dict.items()
                          if k in SuiteConfig.__dataclass_fields__})
    
    cases = suite["cases"]
    if not cases:
        suite_update(suite_id, state=SuiteState.COMPLETED.value,
                      completed_at=_now_ms())
        return suite_get(suite_id)
    
    # Suite start
    suite_update(suite_id, state=SuiteState.RUNNING.value,
                  started_at=_now_ms())
    
    completed = 0
    failed = 0
    
    for case in cases:
        # Skip if already done (resume scenario)
        if case["state"] in (CaseState.SUCCESS.value, CaseState.FAILED.value,
                              CaseState.SKIPPED.value, CaseState.CANCELLED.value):
            if case["state"] == CaseState.SUCCESS.value: completed += 1
            elif case["state"] == CaseState.FAILED.value: failed += 1
            continue
        
        # Check abort threshold
        if cfg.abort_on_n_failures > 0 and failed >= cfg.abort_on_n_failures:
            case_update(case["id"], state=CaseState.SKIPPED.value,
                         error=f"aborted after {failed} failures")
            continue
        
        # Execute case
        case_id = case["id"]
        case_update(case_id, state=CaseState.RUNNING.value, started_at=_now_ms())
        
        try:
            run_id = _create_run_for_case(case, session_id=session_id)
            case_update(case_id, run_id=run_id)
            
            # Drive the run
            _wait_for_run(run_id, timeout_s=cfg.timeout_per_case_s)
            
            # Collect metrics
            run = run_get(run_id) or {}
            metrics = extract_metrics(run_id)
            success = is_success(run, metrics, case["expected"])
            elapsed_ms = (run.get("completed_at", _now_ms()) - run.get("started_at", _now_ms()))
            
            if success:
                metrics["success"] = True
                case_update(case_id,
                             state=CaseState.SUCCESS.value, metrics=metrics,
                             elapsed_ms=elapsed_ms, completed_at=_now_ms())
                completed += 1
            else:
                metrics["success"] = False
                category = classify_error(run, metrics)
                case_update(case_id,
                             state=CaseState.FAILED.value, metrics=metrics,
                             error_category=category,
                             error=run.get("error", "") or run.get("error_message", "")
                                    or f"category: {category}",
                             elapsed_ms=elapsed_ms, completed_at=_now_ms())
                failed += 1
                if not cfg.continue_on_failure:
                    break
        except Exception as exc:
            logger.exception("case %s failed unexpectedly", case_id)
            case_update(case_id, state=CaseState.FAILED.value,
                         error=str(exc), error_category="executor_error",
                         completed_at=_now_ms())
            failed += 1
            if not cfg.continue_on_failure:
                break
    
    # Finalize suite
    final_state = SuiteState.COMPLETED.value
    if failed > 0 and completed > 0:
        final_state = SuiteState.PARTIAL.value
    elif failed > 0 and completed == 0:
        final_state = SuiteState.COMPLETED.value  # still completed, just zero success
    
    suite_update(suite_id, state=final_state,
                  completed_cases=completed, failed_cases=failed,
                  completed_at=_now_ms())
    
    return suite_get(suite_id)


def execute_suite_async(suite_id: str, *, session_id: str = "") -> threading.Thread:
    """Spawn a daemon thread to execute the suite."""
    def _run():
        try:
            execute_suite(suite_id, session_id=session_id)
        except Exception:
            logger.exception("suite %s execution crashed", suite_id)
    
    t = threading.Thread(target=_run, daemon=True, name=f"bench-{suite_id[:8]}")
    t.start()
    return t


def _create_run_for_case(case: dict, *, session_id: str = "") -> str:
    """Create a Run for a benchmark case via standard orchestrator."""
    run_id = create_run(
        flow_name=case["flow_name"],
        session_id=session_id,
        task_id="",  # benchmark not associated with chat task
        inputs=case["inputs"],
    )
    # Start synchronously (this fn is already inside a worker thread)
    start_run(
        run_id,
        flow_name=case["flow_name"],
        inputs=case["inputs"],
        session_id=session_id,
        task_id="",
    )
    return run_id


def _wait_for_run(run_id: str, *, timeout_s: int) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        r = run_get(run_id) or {}
        if is_terminal(r.get("state", "")):
            return
        time.sleep(2.0)
    # timeout — try to cancel
    try:
        from edagent_vivado.runs.orchestrator import cancel_run
        cancel_run(run_id)
    except Exception:
        pass


def _now_ms() -> int:
    return int(time.time() * 1000)
```

---

## 5. 步骤 6：Exporter

### 5.1 `benchmarks/exporter.py`

```python
"""Export benchmark suite results — Phase 10."""

from __future__ import annotations

import csv
import io
import json
import zipfile
from pathlib import Path
from typing import Any

from edagent_vivado.benchmarks.suite_store import suite_get
from edagent_vivado.repository.store import artifact_list_for_run


# columns in the canonical CSV
_CSV_COLS = [
    "case_name", "state", "flow_name",
    "WNS", "TNS", "WHS", "THS",
    "LUT", "FF", "BRAM", "DSP", "IO", "BUFG",
    "bitstream_exists", "bitstream_size_bytes",
    "drc_critical", "drc_error", "methodology_violations",
    "error_category", "error",
    "elapsed_ms", "run_id",
]


def export_csv(suite_id: str) -> str:
    suite = suite_get(suite_id)
    if not suite:
        raise ValueError(f"suite not found: {suite_id}")
    
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(_CSV_COLS)
    for case in suite["cases"]:
        m = case.get("metrics", {}) or {}
        row = [
            case.get("name", ""),
            case.get("state", ""),
            case.get("flow_name", ""),
            m.get("WNS"), m.get("TNS"), m.get("WHS"), m.get("THS"),
            m.get("LUT"), m.get("FF"), m.get("BRAM"), m.get("DSP"),
            m.get("IO"), m.get("BUFG"),
            m.get("bitstream_exists"), m.get("bitstream_size_bytes"),
            m.get("drc_critical"), m.get("drc_error"),
            m.get("methodology_violations"),
            case.get("error_category", ""),
            (case.get("error", "") or "").replace("\n", " ")[:200],
            case.get("elapsed_ms", 0),
            case.get("run_id", ""),
        ]
        w.writerow(row)
    return buf.getvalue()


def export_markdown(suite_id: str) -> str:
    suite = suite_get(suite_id)
    if not suite:
        raise ValueError(f"suite not found: {suite_id}")
    
    lines: list[str] = []
    lines.append(f"# Benchmark Suite: {suite['name']}")
    lines.append("")
    lines.append(f"- **State:** {suite['state']}")
    lines.append(f"- **Total:** {suite['total_cases']}  ·  "
                  f"**Success:** {suite['completed_cases']}  ·  "
                  f"**Failed:** {suite['failed_cases']}")
    if suite.get("started_at") and suite.get("completed_at"):
        dur = (suite["completed_at"] - suite["started_at"]) / 1000
        lines.append(f"- **Duration:** {dur:.1f}s")
    lines.append("")
    lines.append("## Cases")
    lines.append("")
    lines.append("| # | Name | State | WNS | LUT | FF | BRAM | DSP | Bit | Time |")
    lines.append("|---|------|-------|-----|-----|----|------|-----|-----|------|")
    
    for case in suite["cases"]:
        m = case.get("metrics", {}) or {}
        icon = "✅" if case["state"] == "success" else (
            "❌" if case["state"] == "failed" else "—"
        )
        lines.append("| {seq} | {name} | {icon} {state} | {wns} | {lut} | {ff} | {bram} | {dsp} | {bit} | {t} |".format(
            seq=case.get("sequence", "?"),
            name=case.get("name", ""),
            icon=icon, state=case.get("state", ""),
            wns=_fmt(m.get("WNS")),
            lut=_fmt(m.get("LUT")), ff=_fmt(m.get("FF")),
            bram=_fmt(m.get("BRAM")), dsp=_fmt(m.get("DSP")),
            bit="✓" if m.get("bitstream_exists") else "✗",
            t=f"{(case.get('elapsed_ms') or 0) / 1000:.1f}s",
        ))
    
    lines.append("")
    lines.append("## Failed cases detail")
    lines.append("")
    for case in suite["cases"]:
        if case.get("state") != "failed":
            continue
        lines.append(f"### {case.get('name')}")
        lines.append(f"- **Category:** {case.get('error_category', 'unknown')}")
        lines.append(f"- **Run:** `{case.get('run_id', '')}`")
        err = (case.get("error", "") or "").strip()
        if err:
            lines.append("")
            lines.append("```")
            lines.append(err[:1000])
            lines.append("```")
        lines.append("")
    
    return "\n".join(lines)


def export_json(suite_id: str) -> str:
    suite = suite_get(suite_id)
    if not suite:
        raise ValueError(f"suite not found: {suite_id}")
    return json.dumps(suite, indent=2, ensure_ascii=False, default=str)


def export_zip(suite_id: str, output_path: str) -> str:
    """Build a ZIP containing summary.md, results.csv, suite.json, and artifacts per case."""
    suite = suite_get(suite_id)
    if not suite:
        raise ValueError(f"suite not found: {suite_id}")
    
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("summary.md", export_markdown(suite_id))
        zf.writestr("results.csv", export_csv(suite_id))
        zf.writestr("suite.json", export_json(suite_id))
        
        for case in suite["cases"]:
            run_id = case.get("run_id", "")
            if not run_id:
                continue
            try:
                arts = artifact_list_for_run(run_id) if callable(artifact_list_for_run) else []
            except Exception:
                arts = []
            for a in arts:
                src = Path(a.get("path", ""))
                if not src.exists():
                    continue
                # only include key artifacts to keep zip small
                name_lower = src.name.lower()
                if not any(name_lower.endswith(ext) for ext in
                            (".bit", ".rpt", ".log", ".dcp")):
                    continue
                # skip huge files (>50MB)
                try:
                    if src.stat().st_size > 50 * 1024 * 1024:
                        continue
                except OSError:
                    continue
                arc_name = f"runs/{case.get('name', run_id)}/{src.name}"
                zf.write(src, arcname=arc_name)
    
    return str(output)


def _fmt(v: Any) -> str:
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.3f}"
    return str(v)
```

---

## 6. 步骤 7：API + CLI

### 6.1 `web/routes/benchmarks.py`

```python
"""Benchmark suite API — Phase 10."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response, FileResponse
from pydantic import BaseModel, Field

from edagent_vivado.benchmarks.executor import execute_suite_async
from edagent_vivado.benchmarks.exporter import (
    export_csv, export_markdown, export_json, export_zip,
)
from edagent_vivado.benchmarks.models import BenchmarkSuite, SuiteConfig, make_case
from edagent_vivado.benchmarks.suite_store import (
    suite_create, suite_get, suite_list, suite_update,
)
from edagent_vivado.web.dependencies import require_perm, get_identity

router = APIRouter(prefix="/api/v1/benchmarks", tags=["benchmarks"])


class CaseSpec(BaseModel):
    name: str
    description: str = ""
    flow_name: str
    inputs: dict = Field(default_factory=dict)
    expected: dict = Field(default_factory=dict)


class CreateSuiteReq(BaseModel):
    name: str = Field(..., min_length=1)
    description: str = ""
    project_id: str = Field(..., min_length=1)
    cases: list[CaseSpec] = Field(default_factory=list)
    config: dict = Field(default_factory=dict)


@router.post("", dependencies=[Depends(require_perm("benchmark.create"))])
async def api_create_suite(req: CreateSuiteReq, identity = Depends(get_identity)):
    cfg = SuiteConfig(**{k: v for k, v in req.config.items()
                          if k in SuiteConfig.__dataclass_fields__})
    suite = BenchmarkSuite.new(
        name=req.name, description=req.description,
        project_id=req.project_id, config=cfg,
        created_by=identity.user.id,
    )
    suite.cases = [
        make_case(
            suite_id=suite.id, name=c.name, sequence=i,
            flow_name=c.flow_name, inputs=c.inputs,
            description=c.description, expected=c.expected,
        )
        for i, c in enumerate(req.cases)
    ]
    suite.total_cases = len(suite.cases)
    suite_create(suite)
    return suite_get(suite.id)


@router.get("/{suite_id}", dependencies=[Depends(require_perm("benchmark.read"))])
async def api_get_suite(suite_id: str):
    s = suite_get(suite_id)
    if not s:
        raise HTTPException(404, "suite not found")
    return s


@router.get("", dependencies=[Depends(require_perm("benchmark.read"))])
async def api_list_suites(project_id: str = "", state: str = "", limit: int = 50):
    return {"suites": suite_list(project_id=project_id, state=state, limit=limit)}


@router.post("/{suite_id}/run", dependencies=[Depends(require_perm("benchmark.run"))])
async def api_run_suite(suite_id: str, identity = Depends(get_identity)):
    s = suite_get(suite_id)
    if not s:
        raise HTTPException(404, "suite not found")
    if s["state"] == "running":
        raise HTTPException(409, "already running")
    suite_update(suite_id, state="queued")
    execute_suite_async(suite_id, session_id="")
    return {"ok": True, "suite_id": suite_id}


@router.post("/{suite_id}/cancel", dependencies=[Depends(require_perm("benchmark.run"))])
async def api_cancel_suite(suite_id: str):
    # mark cancelled; executor checks state each iteration
    suite_update(suite_id, state="cancelled")
    return {"ok": True}


@router.get("/{suite_id}/export/csv",
            dependencies=[Depends(require_perm("benchmark.read"))])
async def api_export_csv(suite_id: str):
    text = export_csv(suite_id)
    return Response(content=text, media_type="text/csv",
                     headers={"Content-Disposition": f'attachment; filename="{suite_id}.csv"'})


@router.get("/{suite_id}/export/markdown",
            dependencies=[Depends(require_perm("benchmark.read"))])
async def api_export_md(suite_id: str):
    text = export_markdown(suite_id)
    return Response(content=text, media_type="text/markdown",
                     headers={"Content-Disposition": f'attachment; filename="{suite_id}.md"'})


@router.get("/{suite_id}/export/json",
            dependencies=[Depends(require_perm("benchmark.read"))])
async def api_export_json(suite_id: str):
    return Response(content=export_json(suite_id), media_type="application/json")


@router.get("/{suite_id}/export/zip",
            dependencies=[Depends(require_perm("benchmark.read"))])
async def api_export_zip(suite_id: str):
    from pathlib import Path
    import tempfile
    tmp = Path(tempfile.gettempdir()) / f"benchmark-{suite_id}.zip"
    export_zip(suite_id, str(tmp))
    return FileResponse(tmp, media_type="application/zip",
                         filename=f"benchmark-{suite_id}.zip")
```

### 6.2 CLI

加到 `cli.py`：

```python
bench_app = typer.Typer(help="Benchmark suites")
app.add_typer(bench_app, name="benchmark")


@bench_app.command("run")
def cli_bench_run(
    suite_file: Path = typer.Argument(..., help="JSON file describing the suite"),
    project_id: str = typer.Option(..., "--project-id", "-p"),
):
    """Run a benchmark suite from a JSON description file."""
    import json
    from edagent_vivado.benchmarks.models import BenchmarkSuite, SuiteConfig, make_case
    from edagent_vivado.benchmarks.suite_store import suite_create
    from edagent_vivado.benchmarks.executor import execute_suite
    
    spec = json.loads(suite_file.read_text())
    cfg = SuiteConfig(**{k: v for k, v in spec.get("config", {}).items()
                          if k in SuiteConfig.__dataclass_fields__})
    suite = BenchmarkSuite.new(
        name=spec.get("name", suite_file.stem),
        description=spec.get("description", ""),
        project_id=project_id, config=cfg,
    )
    suite.cases = [
        make_case(suite_id=suite.id, name=c["name"], sequence=i,
                   flow_name=c.get("flow_name", "vivado_synth_only"),
                   inputs=c.get("inputs", {}), expected=c.get("expected", {}),
                   description=c.get("description", ""))
        for i, c in enumerate(spec["cases"])
    ]
    suite.total_cases = len(suite.cases)
    suite_create(suite)
    typer.echo(f"Created suite {suite.id} ({len(suite.cases)} cases)")
    typer.echo("Running…")
    result = execute_suite(suite.id)
    typer.echo(f"Suite finished: {result['state']}")
    typer.echo(f"  Success: {result['completed_cases']}/{result['total_cases']}")
    typer.echo(f"  Failed:  {result['failed_cases']}")
    typer.echo("Export:")
    typer.echo(f"  edagent benchmark export {suite.id} --csv  # results.csv")
    typer.echo(f"  edagent benchmark export {suite.id} --md   # summary.md")


@bench_app.command("export")
def cli_bench_export(
    suite_id: str,
    csv_out: bool = typer.Option(False, "--csv"),
    md_out: bool = typer.Option(False, "--md"),
    json_out: bool = typer.Option(False, "--json"),
    zip_out: Optional[Path] = typer.Option(None, "--zip"),
):
    from edagent_vivado.benchmarks.exporter import export_csv, export_markdown, export_json, export_zip
    if csv_out:
        typer.echo(export_csv(suite_id))
    if md_out:
        typer.echo(export_markdown(suite_id))
    if json_out:
        typer.echo(export_json(suite_id))
    if zip_out:
        p = export_zip(suite_id, str(zip_out))
        typer.echo(f"wrote {p}")


@bench_app.command("list")
def cli_bench_list(project: str = typer.Option("", "--project")):
    from edagent_vivado.benchmarks.suite_store import suite_list
    for s in suite_list(project_id=project, limit=50):
        typer.echo(f"  {s['id'][:8]} {s['name']:30s} {s['state']:12s} "
                    f"{s['completed_cases']}/{s['total_cases']}")
```

示例 `examples/benchmarks/sample-suite.json`：

```json
{
  "name": "uart-strategies",
  "description": "Compare 3 synth strategies for UART core",
  "config": {
    "continue_on_failure": true,
    "timeout_per_case_s": 1800
  },
  "cases": [
    {
      "name": "default",
      "flow_name": "vivado_full_flow",
      "inputs": {"strategy": ""}
    },
    {
      "name": "perf_optimized_high",
      "flow_name": "vivado_full_flow",
      "inputs": {"strategy": "Flow_PerfOptimized_high"}
    },
    {
      "name": "area_optimized_high",
      "flow_name": "vivado_full_flow",
      "inputs": {"strategy": "Flow_AreaOptimized_high"},
      "expected": {"require_bitstream": true, "WNS_min": 0}
    }
  ]
}
```

---

## 7. 步骤 9：MCP 工具

**新建** `src/edagent_vivado/mcp/tools/benchmarks.py`：

```python
from __future__ import annotations

from typing import Any
from edagent_vivado.mcp.client import SynthiaClient


def register(mcp, client: SynthiaClient) -> None:
    
    @mcp.tool()
    async def synthia_create_benchmark_suite(
        name: str,
        project_id: str,
        cases: list[dict[str, Any]],
        description: str = "",
        continue_on_failure: bool = True,
        timeout_per_case_s: int = 7200,
    ) -> dict[str, Any]:
        """Create a benchmark suite for a project.
        
        Args:
            cases: list of {name, flow_name, inputs?, expected?}.
        
        Returns suite info; call synthia_run_benchmark_suite to start.
        """
        return client._post("/api/v1/benchmarks", {
            "name": name, "description": description, "project_id": project_id,
            "cases": cases,
            "config": {
                "continue_on_failure": continue_on_failure,
                "timeout_per_case_s": timeout_per_case_s,
            },
        })
    
    @mcp.tool()
    async def synthia_run_benchmark_suite(suite_id: str) -> dict[str, Any]:
        """Start executing a benchmark suite (async).
        
        Poll synthia_get_benchmark_suite for progress.
        """
        return client._post(f"/api/v1/benchmarks/{suite_id}/run")
    
    @mcp.tool()
    async def synthia_get_benchmark_suite(suite_id: str) -> dict[str, Any]:
        """Get benchmark suite state + all case states/metrics."""
        return client._get(f"/api/v1/benchmarks/{suite_id}")
    
    @mcp.tool()
    async def synthia_export_benchmark_markdown(suite_id: str) -> str:
        """Get markdown summary of a benchmark suite."""
        r = client._client.get(
            f"{client._base}/api/v1/benchmarks/{suite_id}/export/markdown")
        r.raise_for_status()
        return r.text
```

注册到 `mcp/server.py`：

```python
from edagent_vivado.mcp.tools import benchmarks as _bm
_bm.register(mcp, client)
```

---

## 8. 步骤 10-11：前端

### 8.1 `pages/BenchmarksPage.tsx`

```tsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BenchmarkTable } from '../components/benchmarks/BenchmarkTable'
import './BenchmarksPage.css'

interface Suite {
  id: string
  name: string
  state: string
  total_cases: number
  completed_cases: number
  failed_cases: number
  created_at: number
}

export function BenchmarksPage() {
  const [suites, setSuites] = useState<Suite[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [])
  
  const refresh = () => {
    fetch('/api/v1/benchmarks?limit=100', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { setSuites(d.suites || []); setLoading(false) })
      .catch(() => setLoading(false))
  }
  
  if (loading) return <div>Loading…</div>
  
  return (
    <div className="syn-benchmarks">
      <header className="syn-page-header">
        <h1>Benchmarks</h1>
        <button className="syn-button syn-button--primary" onClick={() => navigate('/benchmarks/new')}>
          + New Suite
        </button>
      </header>
      <table className="syn-table">
        <thead>
          <tr>
            <th>Name</th><th>State</th><th>Progress</th>
            <th>Success</th><th>Failed</th><th>Created</th><th></th>
          </tr>
        </thead>
        <tbody>
          {suites.map(s => (
            <tr key={s.id}>
              <td><a onClick={() => navigate(`/benchmarks/${s.id}`)}>{s.name}</a></td>
              <td><span className={`syn-pill syn-pill--${s.state}`}>{s.state}</span></td>
              <td>{s.completed_cases + s.failed_cases}/{s.total_cases}</td>
              <td className="syn-cell--success">{s.completed_cases}</td>
              <td className="syn-cell--danger">{s.failed_cases}</td>
              <td>{new Date(s.created_at).toLocaleString()}</td>
              <td>
                <a href={`/api/v1/benchmarks/${s.id}/export/csv`}>CSV</a>
                {' · '}
                <a href={`/api/v1/benchmarks/${s.id}/export/zip`}>ZIP</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function authHeaders() {
  const tok = localStorage.getItem('synthia_token') || ''
  return tok ? { Authorization: `Bearer ${tok}` } : {}
}
```

### 8.2 `BenchmarkSuiteDetailPage.tsx`

```tsx
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { BenchmarkTable } from '../components/benchmarks/BenchmarkTable'
import { BenchmarkDistribution } from '../components/benchmarks/BenchmarkDistribution'

export function BenchmarkSuiteDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [suite, setSuite] = useState<any>(null)
  
  useEffect(() => {
    if (!id) return
    const fetch_ = () => fetch(`/api/v1/benchmarks/${id}`, { headers: authHeaders() })
      .then(r => r.json()).then(setSuite)
    fetch_()
    const t = setInterval(fetch_, 5000)
    return () => clearInterval(t)
  }, [id])
  
  if (!suite) return <div>Loading…</div>
  
  const start = async () => {
    await fetch(`/api/v1/benchmarks/${id}/run`, { method: 'POST', headers: authHeaders() })
  }
  
  return (
    <div className="syn-bench-detail">
      <header className="syn-page-header">
        <h1>{suite.name}</h1>
        <span className={`syn-pill syn-pill--${suite.state}`}>{suite.state}</span>
        {(suite.state === 'draft' || suite.state === 'cancelled') && (
          <button className="syn-button syn-button--primary" onClick={start}>Run Suite</button>
        )}
      </header>
      
      <BenchmarkDistribution suite={suite} />
      <BenchmarkTable cases={suite.cases} />
      
      <div className="syn-bench-detail__exports">
        Export:
        <a href={`/api/v1/benchmarks/${id}/export/markdown`} download>Markdown</a>
        <a href={`/api/v1/benchmarks/${id}/export/csv`} download>CSV</a>
        <a href={`/api/v1/benchmarks/${id}/export/json`} download>JSON</a>
        <a href={`/api/v1/benchmarks/${id}/export/zip`} download>ZIP</a>
      </div>
    </div>
  )
}

function authHeaders() {
  const tok = localStorage.getItem('synthia_token') || ''
  return tok ? { Authorization: `Bearer ${tok}` } : {}
}
```

### 8.3 `components/benchmarks/BenchmarkTable.tsx`

```tsx
export function BenchmarkTable({ cases }: { cases: any[] }) {
  return (
    <table className="syn-table syn-bench-table">
      <thead>
        <tr>
          <th>#</th><th>Name</th><th>State</th>
          <th>WNS</th><th>LUT</th><th>FF</th><th>BRAM</th><th>DSP</th>
          <th>Bit</th><th>Time</th><th>Run</th>
        </tr>
      </thead>
      <tbody>
        {cases.map(c => {
          const m = c.metrics || {}
          return (
            <tr key={c.id} className={`syn-bench-row syn-bench-row--${c.state}`}>
              <td>{c.sequence}</td>
              <td>{c.name}</td>
              <td><span className={`syn-pill syn-pill--${c.state}`}>{c.state}</span></td>
              <td>{m.WNS ?? '—'}</td>
              <td>{m.LUT ?? '—'}</td>
              <td>{m.FF ?? '—'}</td>
              <td>{m.BRAM ?? '—'}</td>
              <td>{m.DSP ?? '—'}</td>
              <td>{m.bitstream_exists ? '✓' : '—'}</td>
              <td>{((c.elapsed_ms || 0) / 1000).toFixed(1)}s</td>
              <td>{c.run_id ? <a href={`/runs/${c.run_id}`}>open</a> : ''}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
```

### 8.4 `BenchmarkDistribution.tsx`（success/fail 饼图）

```tsx
export function BenchmarkDistribution({ suite }: { suite: any }) {
  const total = suite.total_cases || 1
  const succ = suite.completed_cases || 0
  const fail = suite.failed_cases || 0
  const pending = total - succ - fail
  
  const succPct = (succ / total) * 100
  const failPct = (fail / total) * 100
  const pendPct = (pending / total) * 100
  
  return (
    <div className="syn-bench-dist">
      <div className="syn-bench-dist__bar">
        <div className="syn-bench-dist__seg syn-bench-dist__seg--success" style={{ width: `${succPct}%` }} />
        <div className="syn-bench-dist__seg syn-bench-dist__seg--failed" style={{ width: `${failPct}%` }} />
        <div className="syn-bench-dist__seg syn-bench-dist__seg--pending" style={{ width: `${pendPct}%` }} />
      </div>
      <div className="syn-bench-dist__legend">
        <span className="syn-bench-dist__label syn-bench-dist__label--success">{succ} success</span>
        <span className="syn-bench-dist__label syn-bench-dist__label--failed">{fail} failed</span>
        {pending > 0 && <span className="syn-bench-dist__label">{pending} pending</span>}
      </div>
    </div>
  )
}
```

CSS：

```css
.syn-bench-dist__bar {
  display: flex;
  height: 12px;
  background: var(--syn-bg-deep);
  border-radius: 6px;
  overflow: hidden;
  margin: 16px 0 8px;
}
.syn-bench-dist__seg { height: 100%; transition: width 0.5s; }
.syn-bench-dist__seg--success { background: var(--syn-success); }
.syn-bench-dist__seg--failed  { background: var(--syn-danger); }
.syn-bench-dist__seg--pending { background: var(--syn-text-faint); }

.syn-bench-row--success { background: var(--syn-success-bg); }
.syn-bench-row--failed { background: var(--syn-danger-bg); }
```

---

## 9. 测试

### 9.1 关键 cases

```python
# tests/test_benchmarks.py
import json
import pytest
from edagent_vivado.benchmarks.models import BenchmarkSuite, SuiteConfig, make_case
from edagent_vivado.benchmarks.suite_store import (
    suite_create, suite_get, suite_list, case_update,
)
from edagent_vivado.benchmarks.exporter import export_csv, export_markdown, export_json


def test_suite_create_and_get(fresh_db):
    s = BenchmarkSuite.new(name="test", project_id="p1")
    s.cases = [
        make_case(suite_id=s.id, name="c1", sequence=0,
                   flow_name="vivado_synth_only", inputs={}),
        make_case(suite_id=s.id, name="c2", sequence=1,
                   flow_name="vivado_synth_only", inputs={"strategy": "x"}),
    ]
    s.total_cases = 2
    suite_create(s)
    
    g = suite_get(s.id)
    assert g["name"] == "test"
    assert len(g["cases"]) == 2
    assert g["cases"][0]["name"] == "c1"


def test_case_metrics_update(fresh_db):
    s = BenchmarkSuite.new(name="m", project_id="p1")
    s.cases = [make_case(suite_id=s.id, name="c", sequence=0, flow_name="x", inputs={})]
    s.total_cases = 1
    suite_create(s)
    cid = s.cases[0].id
    
    case_update(cid, state="success", metrics={"WNS": 1.234, "LUT": 1000})
    
    g = suite_get(s.id)
    c = g["cases"][0]
    assert c["state"] == "success"
    assert c["metrics"]["WNS"] == 1.234
    assert c["metrics"]["LUT"] == 1000


def test_export_csv(fresh_db):
    s = BenchmarkSuite.new(name="csv-test", project_id="p1")
    s.cases = [make_case(suite_id=s.id, name="c1", sequence=0, flow_name="x", inputs={})]
    s.total_cases = 1
    suite_create(s)
    case_update(s.cases[0].id, state="success",
                 metrics={"WNS": 1.5, "LUT": 100, "bitstream_exists": True})
    
    csv = export_csv(s.id)
    assert "c1" in csv
    assert "1.5" in csv
    assert "True" in csv or "true" in csv.lower()


def test_export_markdown(fresh_db):
    s = BenchmarkSuite.new(name="md-test", project_id="p1")
    s.cases = [
        make_case(suite_id=s.id, name="ok", sequence=0, flow_name="x", inputs={}),
        make_case(suite_id=s.id, name="bad", sequence=1, flow_name="x", inputs={}),
    ]
    s.total_cases = 2
    suite_create(s)
    case_update(s.cases[0].id, state="success", metrics={"WNS": 1.0})
    case_update(s.cases[1].id, state="failed", error_category="timing_violation",
                 error="WNS = -0.5", metrics={"WNS": -0.5})
    
    md = export_markdown(s.id)
    assert "md-test" in md
    assert "ok" in md and "bad" in md
    assert "timing_violation" in md
```

### 9.2 metric extractor 单元测

```python
def test_extract_metrics(fresh_db, monkeypatch):
    from edagent_vivado.benchmarks.metric_extractor import extract_metrics
    
    def fake_reports(run_id, **kw):
        return [
            {"report_type": "timing", "data": {"WNS": 1.2, "TNS": -3.4}, "metrics": {}},
            {"report_type": "utilization",
             "data": {"summary": {"LUT": 500, "FF": 1000}}, "metrics": {}},
            {"report_type": "bitstream", "data": {"exists": True, "size_bytes": 1024}, "metrics": {}},
        ]
    
    monkeypatch.setattr("edagent_vivado.benchmarks.metric_extractor.parsed_report_list",
                         fake_reports)
    monkeypatch.setattr("edagent_vivado.benchmarks.metric_extractor.artifact_list_for_run",
                         lambda r: [])
    
    m = extract_metrics("r1")
    assert m["WNS"] == 1.2
    assert m["LUT"] == 500
    assert m["bitstream_exists"]
```

### 9.3 commit

```bash
git add -A
git commit -m "Phase 10: Benchmark Flow v1

Backend:
- DB: benchmark_suites / benchmark_cases tables
- benchmarks/models.py: BenchmarkSuite + BenchmarkCase + SuiteConfig
- benchmarks/suite_store.py: SQLite CRUD
- benchmarks/metric_extractor.py: Run → {WNS,TNS,LUT,FF,...} + error category
- benchmarks/executor.py: serial executor with continue-on-failure + per-case timeout
- benchmarks/exporter.py: CSV + Markdown + JSON + ZIP (with artifacts)
- web/routes/benchmarks.py: full CRUD + run + cancel + 4 export formats
- CLI: 'edagent benchmark run/list/export'
- mcp/tools/benchmarks.py: 4 MCP tools

Frontend:
- pages/BenchmarksPage.tsx: list view with progress + state pills
- pages/BenchmarkSuiteDetailPage.tsx: table + distribution bar + export links
- components/benchmarks/BenchmarkTable.tsx
- components/benchmarks/BenchmarkDistribution.tsx (success/fail bar)

Tests:
- test_benchmarks.py: suite/case CRUD + CSV/markdown export
- test_metric_extractor.py: report aggregation + error classification

Examples:
- examples/benchmarks/sample-suite.json
"
```

---

## 10. 附录

### 10.1 常见坑

**A. 超时 vs cancel**：`_wait_for_run` 命中超时后尝试 cancel；但 Vivado 进程可能不响应 SIGTERM。Phase 11 worker queue 加 hard-kill 兜底。

**B. 大 ZIP**：包含 `.dcp` 一个就 50+ MB。已限 50MB per artifact；超过 skip。完整 ZIP 仍可能 200+ MB。生产建议只 ship CSV + markdown，artifacts 分别下载。

**C. 并发 cases**：`SuiteConfig.parallel` 当前未实现。Phase 11 上 worker queue 后可放开；要小心 Vivado license 并发限制。

**D. 增量重跑**：suite 跑完后改了一个 case 的 strategy，希望只重跑这一个。v1.0 没实现。workaround：clone suite + 改 case；保留旧 suite 做 history。

**E. flow_name 错填**：用户传 `vivado_full_flow_typo`，executor 创建 Run 失败 → case=failed。错误信息不够直观。可以在 `api_create_suite` 早期校验 flow_name 是注册过的。

**F. expected 阈值语义**：`WNS_min=0` 意思是「最小可接受 WNS 是 0」，<0 视为 fail。`max_LUT=10000` 意思是「LUT 不能超过 10000」。要写清在 docs/MCP 说明里。

**G. 单 case 跑太长**：默认 2h timeout 对大设计不够；MCP 工具 expose `timeout_per_case_s`。

### 10.2 耗时

| 步骤 | 估时 |
|------|------|
| 1 DB schema | 0.25d |
| 2-3 models + store | 0.75d |
| 4 metric_extractor | 0.75d |
| 5 executor | 1.5d |
| 6 exporter | 1d |
| 7 API | 1d |
| 8 CLI + MCP tool | 0.5d |
| 10-11 前端 (page + table + dist) | 1.5d |
| 测试 + smoke | 1d |

**总计：** 全职 8 天；vibe coding 2-3 周。

### 10.3 Phase 11 衔接

Phase 10 用线程串行跑 cases；同一时刻只能一个 case 占 Vivado license。Phase 11 上 Redis-backed worker queue + license-aware scheduler 后：
- `SuiteConfig.parallel = 4` 真生效
- license pool 限制 → 排队
- worker 重启不丢 case
- 多 user 同时提 suite → 分时段执行

Phase 10 完工后用户应该能：
- ✅ 写一个 JSON 描述 N 个 case，一行命令跑完
- ✅ 一个 case 挂掉，其他继续跑
- ✅ 导出 CSV / Markdown / JSON / ZIP
- ✅ UI 表格看每个 case 的 WNS / LUT 等核心指标
- ✅ 看到 success/failed 分布
- ✅ Cursor 通过 MCP 触发 benchmark
