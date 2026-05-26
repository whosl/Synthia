# Synthia Phase 5 开发手册：报告 / 产物面板 + Parser 完善

> **前置条件：** Phase 0/1/2/3/4 完成（特别是 RunOrchestrator + DB events）  
> **目标：** Vivado 关键报告全部入库结构化数据；前端有 Reports / Artifacts 面板；trend 对比可用  
> **预估工期：** 全职 7 天；vibe coding 2 周  
> **关键约束：** 不破坏 mock 模式；前端套 Phase 0 已落地的 Cursor + Claude 设计 token

---

## 0. 设计目标

### 0.1 当前 parser 现状

| 文件 | 现状 | Phase 5 目标 |
|------|------|--------------|
| `parsers/timing_parser.py` | 抽 WNS/TNS/WHS/THS 基本指标 | 加 path-level top-10 critical paths |
| `parsers/utilization_parser.py` | 抽 LUT/FF/BRAM/DSP | 加 site type 细分、per-hierarchy 占比 |
| `connectors/vivado/parsers/drc.py` | regex 抽 severity+rule | 加规则 categorize（CDC / Timing / Synth / IO 等）|
| `connectors/vivado/parsers/methodology.py` | regex 抽 finding | 加严重度分级 + 推荐 action 模板 |
| `connectors/vivado/parsers/log_summary.py` | 套 vivado_log_parser | 加 stage 自动识别 |
| - bitstream detector | 不存在 | 新建：探测 `.bit` 文件 + meta |
| - impl_summary | 不存在 | 新建：综合 impl 阶段日志 |
| - trend 计算 | 不存在 | 新建：跨 run 数值比较 |

### 0.2 Phase 5 范围

1. 补完 5 个 parser
2. 新建 bitstream detector
3. Run reports 表加 metrics 字段（结构化数值）
4. trend API 计算最近 N 次 run 的趋势
5. 前端 Reports 面板：timing / util / drc / methodology / bitstream Tab
6. 前端 Artifacts 面板：树形 + 下载（含 sha256）
7. 前端 trend 对比图（同 manifest 下最近 5 次 run 的 WNS / LUT% 折线）

---

## 1. 任务清单

| 步骤 | 文件 | 说明 |
|------|------|------|
| 1 | `parsers/timing_parser.py` | 加 critical paths |
| 2 | `parsers/utilization_parser.py` | 加 site/hier 细分 |
| 3 | `connectors/vivado/parsers/drc.py` | 加 categorize |
| 4 | `connectors/vivado/parsers/methodology.py` | 加严重度 + suggestion |
| 5 | `connectors/vivado/parsers/impl_summary.py` | 新建 |
| 6 | `connectors/vivado/parsers/bitstream.py` | 新建 |
| 7 | DB `reports` 表加 metrics_json | migration |
| 8 | `runs/trend.py` | 新建：trend 计算 |
| 9 | `web/routes/reports.py` | trend / artifact 下载 |
| 10 | 前端 `ReportsPanel.tsx` | 新建 |
| 11 | 前端 `ArtifactsPanel.tsx` | 新建 |
| 12 | 前端 `TrendChart.tsx` | 新建 |
| 13 | Markdown summary 生成 | `runs/summary.py` |

---

## 2. 步骤 1：完善 timing_parser

### 2.1 现状

打开 `src/edagent_vivado/parsers/timing_parser.py`。已经有 WNS/TNS 等基本抽取。

### 2.2 加 critical paths

Vivado timing report 关键路径段格式：

```
Slack (VIOLATED) :        -0.342ns
  Source:                 reg_a/clk
  Destination:            reg_b/D
  Path Group:             clk
  Path Type:              Setup (Max at Slow Process Corner)
  Requirement:            5.000ns
  Data Path Delay:        5.234ns
  Logic Levels:           7
```

在 `timing_parser.py` 加：

```python
import re

PATH_BLOCK_RE = re.compile(
    r"Slack\s*\(([A-Z]+)\)\s*:\s*(-?\d+\.\d+)ns\s*"
    r"(?:.*?\n)*?"
    r"\s*Source:\s*([^\n]+?)\s*\n"
    r"\s*Destination:\s*([^\n]+?)\s*\n"
    r"\s*Path Group:\s*([^\n]+?)\s*\n"
    r"\s*Path Type:\s*([^\n]+?)\s*\n"
    r"(?:.*?Requirement:\s*(\d+\.\d+)ns\s*\n)?"
    r"(?:.*?Data Path Delay:\s*(\d+\.\d+)ns\s*\n)?"
    r"(?:.*?Logic Levels:\s*(\d+)\s*\n)?",
    re.DOTALL,
)


def parse_critical_paths(text: str, *, top_n: int = 10) -> list[dict]:
    paths = []
    for m in PATH_BLOCK_RE.finditer(text):
        status, slack, source, dest, group, ptype, req, data_delay, levels = m.groups()
        paths.append({
            "slack_ns": float(slack),
            "status": status.lower(),
            "source": source.strip(),
            "destination": dest.strip(),
            "path_group": group.strip(),
            "path_type": ptype.strip(),
            "requirement_ns": float(req) if req else None,
            "data_path_delay_ns": float(data_delay) if data_delay else None,
            "logic_levels": int(levels) if levels else None,
        })
    # 按 slack 升序（最差路径在前）
    paths.sort(key=lambda p: p["slack_ns"])
    return paths[:top_n]
```

修改 `parse_timing` 主函数（如果不存在则新建），返回 dict 加 `"critical_paths"`：

```python
def parse_timing(text: str) -> dict:
    # 既有的 WNS/TNS 抽取
    wns = _extract_wns(text)
    tns = _extract_tns(text)
    whs = _extract_whs(text)
    ths = _extract_ths(text)
    # 新加
    critical_paths = parse_critical_paths(text, top_n=10)
    
    return {
        "wns": wns,
        "tns": tns,
        "whs": whs,
        "ths": ths,
        "met_setup": wns is not None and wns >= 0,
        "met_hold": whs is not None and whs >= 0,
        "critical_paths": critical_paths,
        "violated_path_count": sum(1 for p in critical_paths if p["status"] == "violated"),
    }
```

### 2.3 测试

**新建** `tests/test_timing_parser_critical_paths.py`：

```python
TIMING_REPORT = """
...
Slack (VIOLATED) :        -0.342ns
  Source:                 my_reg_a/clk
  Destination:            my_reg_b/D
  Path Group:             clk_main
  Path Type:              Setup (Max at Slow Process Corner)
  Requirement:            5.000ns
  Data Path Delay:        5.234ns
  Logic Levels:           7

Slack (MET) :        0.123ns
  Source:                 reg_c/clk
  Destination:            reg_d/D
  Path Group:             clk_main
  Path Type:              Setup
  Requirement:            5.000ns
  Data Path Delay:        4.800ns
  Logic Levels:           4
"""


def test_critical_paths():
    from edagent_vivado.parsers.timing_parser import parse_critical_paths
    paths = parse_critical_paths(TIMING_REPORT, top_n=5)
    assert len(paths) == 2
    # 最差排前面
    assert paths[0]["slack_ns"] == -0.342
    assert paths[0]["status"] == "violated"
    assert paths[0]["source"] == "my_reg_a/clk"
    assert paths[0]["logic_levels"] == 7
```

---

## 3. 步骤 2：完善 utilization_parser

### 3.1 加 site type 细分

Vivado util report 关键段：

```
+-------------------------+------+-------+-----------+-------+
|        Site Type        | Used | Fixed | Available | Util% |
+-------------------------+------+-------+-----------+-------+
| Slice LUTs              |  423 |     0 |     53200 |  0.80 |
|   LUT as Logic          |  398 |     0 |     53200 |  0.75 |
|   LUT as Memory         |   25 |     0 |     17400 |  0.14 |
| Slice Registers         |  600 |     0 |    106400 |  0.56 |
| F7 Muxes                |    0 |     0 |     26600 |  0.00 |
+-------------------------+------+-------+-----------+-------+
```

打开 `src/edagent_vivado/parsers/utilization_parser.py`。加：

```python
import re

ROW_RE = re.compile(
    r"^\|\s*(.+?)\s*\|\s*(\d+)\s*\|\s*\d+\s*\|\s*(\d+)\s*\|\s*([\d.]+)\s*\|",
    re.MULTILINE,
)


def parse_site_table(text: str) -> dict[str, dict]:
    """Extract per-site-type usage rows."""
    rows = {}
    for m in ROW_RE.finditer(text):
        site, used, available, pct = m.groups()
        site = site.strip()
        if site.lower().startswith(("site type", "+--", "fixed")):
            continue
        rows[site] = {
            "used": int(used),
            "available": int(available),
            "util_pct": float(pct),
        }
    return rows


def parse_utilization(text: str) -> dict:
    """Main entry. Returns categorized utilization dict."""
    sites = parse_site_table(text)
    return {
        "sites": sites,
        # 兼容字段（旧代码用 lut_used 等）
        "lut_used": sites.get("Slice LUTs", {}).get("used", 0),
        "lut_pct": sites.get("Slice LUTs", {}).get("util_pct", 0.0),
        "ff_used": sites.get("Slice Registers", {}).get("used", 0),
        "ff_pct": sites.get("Slice Registers", {}).get("util_pct", 0.0),
        "bram_used": sites.get("Block RAM Tile", {}).get("used", 0),
        "bram_pct": sites.get("Block RAM Tile", {}).get("util_pct", 0.0),
        "dsp_used": sites.get("DSPs", {}).get("used", 0),
        "dsp_pct": sites.get("DSPs", {}).get("util_pct", 0.0),
        "uram_used": sites.get("URAM", {}).get("used", 0),
        "uram_pct": sites.get("URAM", {}).get("util_pct", 0.0),
    }
```

### 3.2 测试

**新建** `tests/test_utilization_parser_extended.py`：

```python
SAMPLE = """
+-------------------------+------+-------+-----------+-------+
|        Site Type        | Used | Fixed | Available | Util% |
+-------------------------+------+-------+-----------+-------+
| Slice LUTs              |  423 |     0 |     53200 |  0.80 |
| Slice Registers         |  600 |     0 |    106400 |  0.56 |
| Block RAM Tile          |    5 |     0 |       140 |  3.57 |
| DSPs                    |   10 |     0 |       220 |  4.55 |
+-------------------------+------+-------+-----------+-------+
"""


def test_parse_extended():
    from edagent_vivado.parsers.utilization_parser import parse_utilization
    data = parse_utilization(SAMPLE)
    assert data["lut_used"] == 423
    assert data["lut_pct"] == 0.80
    assert data["bram_pct"] == 3.57
    assert "Slice LUTs" in data["sites"]
```

---

## 4. 步骤 3：DRC categorize

### 4.1 加分类逻辑

打开 `src/edagent_vivado/connectors/vivado/parsers/drc.py`。

DRC rule ID 模式：
- `CLKC-*` → clocking
- `SYNTH-*` → synthesis
- `LATCH-*` → latches
- `RTSTAT-*` → router stats
- `TIMING-*` → timing
- `IO-*` → IO
- `BUFG-*` → clock buffer
- `DPOPT-*` → DSP opt

修改：

```python
CATEGORY_MAP = {
    "CLKC": "clocking",
    "TIMING": "timing",
    "SYNTH": "synthesis",
    "LATCH": "latches",
    "IO": "io",
    "BUFG": "clock_buffer",
    "DPOPT": "dsp",
    "RTSTAT": "routing",
    "PDRC": "physical",
    "REQP": "placement",
    "AVAL": "availability",
    "NSTD": "constraints",
    "UCIO": "io",
}


def _categorize_rule(rule: str) -> str:
    prefix = rule.split("-", 1)[0].upper() if "-" in rule else rule.upper()
    return CATEGORY_MAP.get(prefix, "other")


def parse_drc_report(text: str, *, stage: str = "impl") -> ParsedReport:
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    by_category: dict[str, int] = {}
    
    for m in PAT_RULE.finditer(text):
        sev = m.group("sev").lower()
        rule = m.group("rule")
        category = _categorize_rule(rule)
        by_category[category] = by_category.get(category, 0) + 1
        
        item = {
            "rule": rule,
            "category": category,
            "severity": sev,
            "message": m.group("msg").strip(),
            "objects": [],
            "suggested_action": _suggest_action(rule, category, sev),
        }
        if "error" in sev:
            errors.append(item)
        else:
            warnings.append(item)
    
    if not errors and not warnings and "no violation" in text.lower():
        return ParsedReport(
            type="drc", tool="vivado", stage=stage,
            data={"errors": [], "warnings": [], "by_category": {}, "clean": True},
        )
    return ParsedReport(
        type="drc", tool="vivado", stage=stage,
        data={
            "errors": errors, "warnings": warnings,
            "by_category": by_category,
            "clean": False,
        },
    )


def _suggest_action(rule: str, category: str, severity: str) -> str:
    # 简单建议模板，Phase 5 起步，Phase 6+ 接 KB
    if category == "timing":
        return "review timing constraints; check clock crossing"
    if category == "clocking":
        return "verify clock source / BUFG placement"
    if category == "io":
        return "review IO standards and pin assignments in XDC"
    if category == "synthesis" and "error" in severity:
        return "check RTL syntax and unsupported constructs"
    return ""


# 旧 alias 保持兼容
def parse_drc(text: str) -> dict:
    return parse_drc_report(text).data
```

### 4.2 测试

```python
def test_drc_categorize():
    from edagent_vivado.connectors.vivado.parsers.drc import parse_drc_report
    sample = """
WARNING: [Timing-100] Timing constraint not met on path foo
CRITICAL WARNING: [CLKC-25] Clock buffer issue
ERROR: [IO-3] IO standard mismatch
"""
    rep = parse_drc_report(sample)
    cats = rep.data["by_category"]
    assert cats.get("timing") == 1
    assert cats.get("clocking") == 1
    assert cats.get("io") == 1
```

---

## 5. 步骤 4：Methodology suggestion

### 5.1 加严重度 + suggestion

打开 `src/edagent_vivado/connectors/vivado/parsers/methodology.py`：

```python
SEVERITY_RANK = {
    "info": 0,
    "warning": 1,
    "critical warning": 2,
    "error": 3,
}


def parse_methodology_report(text: str, *, stage: str = "impl") -> ParsedReport:
    findings: list[dict[str, Any]] = []
    counts = {k: 0 for k in SEVERITY_RANK}
    for m in PAT_RULE.finditer(text):
        sev = m.group("sev").lower()
        rule = m.group("rule")
        counts[sev] = counts.get(sev, 0) + 1
        findings.append({
            "rule": rule,
            "severity": sev,
            "severity_rank": SEVERITY_RANK.get(sev, 0),
            "message": m.group("msg").strip(),
            "category": _categorize_method(rule),
            "suggested_action": _suggest_methodology(rule, sev),
        })
    # 按严重度降序
    findings.sort(key=lambda f: -f["severity_rank"])
    
    return ParsedReport(
        type="methodology", tool="vivado", stage=stage,
        data={
            "findings": findings,
            "count": len(findings),
            "by_severity": counts,
            "top_critical": [f for f in findings if f["severity_rank"] >= 2][:5],
        },
    )


def _categorize_method(rule: str) -> str:
    rule_u = rule.upper()
    if rule_u.startswith(("TIMING", "TIM")):
        return "timing"
    if rule_u.startswith(("CDC", "ASYNC")):
        return "cdc"
    if rule_u.startswith(("SYN", "SYNTH")):
        return "synthesis"
    if rule_u.startswith(("PHY", "PLACE", "ROUTE")):
        return "physical"
    return "other"


def _suggest_methodology(rule: str, severity: str) -> str:
    if "TIMING" in rule.upper():
        return "Review timing assertions; consider adding set_max_delay or false_path"
    if "CDC" in rule.upper():
        return "Verify CDC synchronizer logic; review async clock domain crossings"
    return ""
```

---

## 6. 步骤 5：impl_summary parser

### 6.1 新建

**新建** `src/edagent_vivado/connectors/vivado/parsers/impl_summary.py`：

```python
"""Summarize the implementation stage by combining timing + util + drc + log."""

from __future__ import annotations
from typing import Any
from edagent_vivado.connectors.base.types import ParsedReport


def build_impl_summary(
    *,
    timing_data: dict | None = None,
    util_data: dict | None = None,
    drc_data: dict | None = None,
    methodology_data: dict | None = None,
    log_data: dict | None = None,
) -> ParsedReport:
    """Compose a holistic impl-stage summary report."""
    summary: dict[str, Any] = {
        "stage": "impl",
        "ok": True,
        "issues": [],
    }
    
    # Timing
    if timing_data:
        wns = timing_data.get("wns")
        whs = timing_data.get("whs")
        summary["timing"] = {
            "wns_ns": wns,
            "tns_ns": timing_data.get("tns"),
            "whs_ns": whs,
            "ths_ns": timing_data.get("ths"),
            "met_setup": timing_data.get("met_setup", True),
            "met_hold": timing_data.get("met_hold", True),
            "violated_paths": timing_data.get("violated_path_count", 0),
        }
        if wns is not None and wns < 0:
            summary["ok"] = False
            summary["issues"].append({
                "severity": "high",
                "category": "timing",
                "message": f"Setup violated: WNS = {wns}ns",
            })
        if whs is not None and whs < 0:
            summary["ok"] = False
            summary["issues"].append({
                "severity": "high",
                "category": "timing",
                "message": f"Hold violated: WHS = {whs}ns",
            })
    
    # Utilization
    if util_data:
        summary["utilization"] = {
            "lut_pct": util_data.get("lut_pct", 0),
            "ff_pct": util_data.get("ff_pct", 0),
            "bram_pct": util_data.get("bram_pct", 0),
            "dsp_pct": util_data.get("dsp_pct", 0),
        }
        # 警告：>85% 警告，>95% 高警告
        for resource in ("lut_pct", "ff_pct", "bram_pct", "dsp_pct"):
            pct = util_data.get(resource, 0)
            if pct > 95:
                summary["issues"].append({
                    "severity": "high",
                    "category": "utilization",
                    "message": f"{resource} = {pct:.1f}% (>95%)",
                })
            elif pct > 85:
                summary["issues"].append({
                    "severity": "medium",
                    "category": "utilization",
                    "message": f"{resource} = {pct:.1f}% (>85%)",
                })
    
    # DRC
    if drc_data:
        summary["drc"] = {
            "clean": drc_data.get("clean", False),
            "error_count": len(drc_data.get("errors", [])),
            "warning_count": len(drc_data.get("warnings", [])),
            "by_category": drc_data.get("by_category", {}),
        }
        if drc_data.get("errors"):
            summary["ok"] = False
            summary["issues"].append({
                "severity": "high",
                "category": "drc",
                "message": f"{len(drc_data['errors'])} DRC errors",
            })
    
    # Methodology
    if methodology_data:
        summary["methodology"] = {
            "count": methodology_data.get("count", 0),
            "by_severity": methodology_data.get("by_severity", {}),
        }
    
    # Log
    if log_data:
        summary["log"] = {
            "error_count": log_data.get("error_count", 0),
            "critical_warning_count": log_data.get("critical_warning_count", 0),
        }
        if log_data.get("error_count", 0) > 0:
            summary["ok"] = False
    
    return ParsedReport(type="impl_summary", tool="vivado", stage="impl", data=summary)
```

---

## 7. 步骤 6：bitstream detector

### 7.1 新建

**新建** `src/edagent_vivado/connectors/vivado/parsers/bitstream.py`：

```python
"""Detect and describe bitstream files."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any
from edagent_vivado.connectors.base.types import ParsedReport


def detect_bitstream(workspace_dir: str) -> ParsedReport:
    """Find .bit files in workspace and return basic metadata."""
    root = Path(workspace_dir)
    if not root.exists():
        return ParsedReport(
            type="bitstream", tool="vivado", stage="bitstream",
            data={"found": False, "files": []},
        )
    
    bits = sorted(root.rglob("*.bit"))
    ltx = sorted(root.rglob("*.ltx"))
    bin_files = sorted(root.rglob("*.bin"))
    mcs = sorted(root.rglob("*.mcs"))
    
    files = []
    for p in bits:
        files.append(_describe_bitfile(p, "bit"))
    for p in bin_files:
        files.append(_describe_bitfile(p, "bin"))
    for p in mcs:
        files.append(_describe_bitfile(p, "mcs"))
    for p in ltx:
        files.append(_describe_bitfile(p, "ltx"))  # debug probes
    
    return ParsedReport(
        type="bitstream", tool="vivado", stage="bitstream",
        data={
            "found": bool(bits),
            "primary_bit": str(bits[0].resolve()) if bits else "",
            "files": files,
            "count": len(files),
        },
    )


def _describe_bitfile(path: Path, kind: str) -> dict[str, Any]:
    try:
        stat = path.stat()
        size = stat.st_size
        mtime = int(stat.st_mtime)
    except OSError:
        size = 0
        mtime = 0
    sha = ""
    if size > 0 and size < 100_000_000:  # 不算 >100MB 的
        try:
            h = hashlib.sha256()
            with path.open("rb") as f:
                for chunk in iter(lambda: f.read(65536), b""):
                    h.update(chunk)
            sha = h.hexdigest()
        except OSError:
            pass
    return {
        "path": str(path.resolve()).replace("\\", "/"),
        "kind": kind,
        "size_bytes": size,
        "mtime": mtime,
        "sha256": sha,
    }
```

---

## 8. 步骤 7：DB reports 表加 metrics_json

### 8.1 schema

打开 `src/edagent_vivado/repository/db.py`，找到 `reports` 表：

```sql
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    artifact_id TEXT DEFAULT '',
    report_type TEXT NOT NULL,
    tool TEXT DEFAULT '',
    stage TEXT DEFAULT '',
    data_json TEXT DEFAULT '',
    metrics_json TEXT DEFAULT '',     -- ← 新增：存数值化的指标（wns/tns/lut_pct 等）
    created_at INTEGER NOT NULL
);
```

加 migration：

```python
def _migrate_reports_metrics(db):
    cur = db.execute("PRAGMA table_info(reports)")
    cols = {row[1] for row in cur.fetchall()}
    if "metrics_json" not in cols:
        db.execute("ALTER TABLE reports ADD COLUMN metrics_json TEXT DEFAULT ''")
    db.commit()
```

### 8.2 store helper

打开 `src/edagent_vivado/repository/store.py`，找到 `report_create`，加 `metrics` 参数：

```python
def report_create(
    run_id: str, report_type: str,
    *,
    tool: str = "", stage: str = "",
    data: dict | None = None,
    metrics: dict | None = None,
    artifact_id: str = "",
) -> dict:
    import json, uuid, time
    db = get_conn()
    rid = str(uuid.uuid4())
    db.execute(
        "INSERT INTO reports (id, run_id, artifact_id, report_type, tool, stage, "
        "data_json, metrics_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (rid, run_id, artifact_id, report_type, tool, stage,
         json.dumps(data or {}, default=str),
         json.dumps(metrics or {}, default=str),
         int(time.time())),
    )
    db.commit()
    return {"id": rid, "run_id": run_id, "report_type": report_type,
            "tool": tool, "stage": stage,
            "data": data or {}, "metrics": metrics or {}}
```

### 8.3 Phase 4 orchestrator 写入时计算 metrics

修改 `runs/orchestrator.py::_parse_reports_step`：

```python
def _parse_reports_step(run: dict, *, stage: str) -> None:
    from edagent_vivado.connectors.vivado.parsers import (
        log_summary, drc, methodology, impl_summary,
    )
    from edagent_vivado.parsers.timing_parser import parse_timing
    from edagent_vivado.parsers.utilization_parser import parse_utilization
    from edagent_vivado.harness.run_workspace import run_workspace_dir
    from edagent_vivado.repository.store import report_create
    from pathlib import Path
    
    ws = run_workspace_dir(run["id"])
    if not ws:
        return
    
    # Find reports
    timing_rpts = list(Path(ws).rglob(f"*{stage}*timing*.rpt"))
    util_rpts = list(Path(ws).rglob(f"*{stage}*util*.rpt"))
    drc_rpts = list(Path(ws).rglob(f"*{stage}*drc*.rpt"))
    method_rpts = list(Path(ws).rglob(f"*{stage}*methodology*.rpt"))
    
    timing_data = None
    util_data = None
    drc_data = None
    method_data = None
    
    if timing_rpts:
        text = timing_rpts[0].read_text(encoding="utf-8", errors="replace")
        timing_data = parse_timing(text)
        report_create(
            run["id"], "timing_summary", tool="vivado", stage=stage,
            data=timing_data,
            metrics={
                "wns_ns": timing_data.get("wns"),
                "tns_ns": timing_data.get("tns"),
                "whs_ns": timing_data.get("whs"),
                "met_setup": bool(timing_data.get("met_setup", False)),
            },
        )
    if util_rpts:
        text = util_rpts[0].read_text(encoding="utf-8", errors="replace")
        util_data = parse_utilization(text)
        report_create(
            run["id"], "utilization", tool="vivado", stage=stage,
            data=util_data,
            metrics={
                "lut_pct": util_data.get("lut_pct"),
                "ff_pct": util_data.get("ff_pct"),
                "bram_pct": util_data.get("bram_pct"),
                "dsp_pct": util_data.get("dsp_pct"),
            },
        )
    if drc_rpts:
        text = drc_rpts[0].read_text(encoding="utf-8", errors="replace")
        parsed = drc.parse_drc_report(text, stage=stage)
        drc_data = parsed.data
        report_create(
            run["id"], "drc", tool="vivado", stage=stage,
            data=drc_data,
            metrics={
                "error_count": len(drc_data.get("errors", [])),
                "warning_count": len(drc_data.get("warnings", [])),
                "clean": bool(drc_data.get("clean", False)),
            },
        )
    if method_rpts:
        text = method_rpts[0].read_text(encoding="utf-8", errors="replace")
        parsed = methodology.parse_methodology_report(text, stage=stage)
        method_data = parsed.data
        report_create(
            run["id"], "methodology", tool="vivado", stage=stage,
            data=method_data,
            metrics={
                "count": method_data.get("count", 0),
                **{f"sev_{k}": v for k, v in method_data.get("by_severity", {}).items()},
            },
        )
    
    # Impl-stage holistic summary
    if stage == "impl":
        summary = impl_summary.build_impl_summary(
            timing_data=timing_data, util_data=util_data,
            drc_data=drc_data, methodology_data=method_data,
        )
        report_create(
            run["id"], "impl_summary", tool="vivado", stage=stage,
            data=summary.data,
            metrics={
                "ok": summary.data.get("ok", False),
                "issue_count": len(summary.data.get("issues", [])),
            },
        )
```

修改 `_collect_artifacts_step` 触发 bitstream detect：

```python
def _collect_artifacts_step(run: dict) -> None:
    from edagent_vivado.harness.run_workspace import run_workspace_dir
    from edagent_vivado.connectors.vivado.parsers.bitstream import detect_bitstream
    from edagent_vivado.repository.store import report_create
    from edagent_vivado.harness.artifact_store import register_artifacts_from_dir
    
    ws = run_workspace_dir(run["id"])
    if not ws:
        return
    
    # Bitstream report
    bs = detect_bitstream(str(ws))
    report_create(
        run["id"], "bitstream", tool="vivado", stage="bitstream",
        data=bs.data,
        metrics={
            "bit_found": bool(bs.data.get("found")),
            "bit_count": bs.data.get("count", 0),
        },
    )
    
    # Walk workspace, register .rpt / .bit / .dcp / .ltx as artifacts
    register_artifacts_from_dir(run["id"], str(ws))
```

---

## 9. 步骤 8：trend 计算

### 9.1 新建 `runs/trend.py`

```python
"""Compute trend metrics across runs for the same project."""

from __future__ import annotations
from typing import Any
from edagent_vivado.repository.db import get_conn


def project_trend(
    project_id: str,
    *,
    metric_keys: list[str] | None = None,
    limit: int = 10,
) -> dict[str, Any]:
    """Return last N runs' key metrics for trend visualization.
    
    metric_keys: list like ["wns_ns", "lut_pct", "drc.error_count"]
    """
    if metric_keys is None:
        metric_keys = ["wns_ns", "whs_ns", "lut_pct", "ff_pct", "bram_pct",
                       "drc_error_count", "impl_ok"]
    
    db = get_conn()
    cur = db.execute(
        "SELECT id, name, state, started_at, finished_at FROM runs "
        "WHERE project_id = ? AND state IN (?, ?, ?) "
        "ORDER BY started_at DESC LIMIT ?",
        (project_id, "succeeded", "succeeded_with_warnings", "failed", limit),
    )
    runs = cur.fetchall()
    
    series: list[dict] = []
    for row in runs:
        run_id, name, state, started_at, finished_at = row
        metrics = _aggregate_run_metrics(run_id)
        series.append({
            "run_id": run_id,
            "name": name,
            "state": state,
            "started_at": started_at,
            "metrics": metrics,
        })
    
    # 倒着按时间正序
    series.reverse()
    return {
        "project_id": project_id,
        "metric_keys": metric_keys,
        "series": series,
    }


def _aggregate_run_metrics(run_id: str) -> dict[str, Any]:
    """Combine metrics from all reports of a run."""
    import json
    db = get_conn()
    cur = db.execute(
        "SELECT report_type, stage, metrics_json FROM reports WHERE run_id = ?",
        (run_id,),
    )
    rows = cur.fetchall()
    
    metrics: dict[str, Any] = {}
    for report_type, stage, mjson in rows:
        try:
            m = json.loads(mjson or "{}")
        except json.JSONDecodeError:
            continue
        # 优先 impl 阶段的值（更接近最终结果）
        prefix = f"{report_type}_"
        for k, v in m.items():
            key = f"{prefix}{k}"
            if stage == "impl":
                metrics[key] = v  # impl 覆盖 synth
            elif key not in metrics:
                metrics[key] = v
    
    # 别名 / 提升常用
    metrics["wns_ns"] = metrics.get("timing_summary_wns_ns")
    metrics["whs_ns"] = metrics.get("timing_summary_whs_ns")
    metrics["lut_pct"] = metrics.get("utilization_lut_pct")
    metrics["ff_pct"] = metrics.get("utilization_ff_pct")
    metrics["bram_pct"] = metrics.get("utilization_bram_pct")
    metrics["dsp_pct"] = metrics.get("utilization_dsp_pct")
    metrics["drc_error_count"] = metrics.get("drc_error_count")
    metrics["impl_ok"] = metrics.get("impl_summary_ok")
    
    return metrics
```

### 9.2 改 routes/reports.py

```python
@router.get("/projects/{project_id}/trend")
async def api_project_trend(
    project_id: str,
    limit: int = Query(10, ge=1, le=50),
):
    from edagent_vivado.runs.trend import project_trend
    return project_trend(project_id, limit=limit)


@router.get("/reports/trends")
async def api_reports_trends_legacy(
    project_id: str = "",
    limit: int = 10,
):
    """Legacy alias for /projects/{id}/trend."""
    from edagent_vivado.runs.trend import project_trend
    if not project_id:
        return {"series": []}
    return project_trend(project_id, limit=limit)
```

---

## 10. 步骤 9：summary.md 生成

### 10.1 新建 `runs/summary.py`

```python
"""Render a Markdown summary for a completed run."""

from __future__ import annotations
import json
from pathlib import Path
from edagent_vivado.repository.db import get_conn


def render_run_summary(run_id: str) -> str:
    from edagent_vivado.repository.store import run_get
    
    run = run_get(run_id)
    if not run:
        return f"Run {run_id} not found."
    
    db = get_conn()
    cur = db.execute(
        "SELECT report_type, stage, data_json, metrics_json FROM reports WHERE run_id = ?",
        (run_id,),
    )
    reports = cur.fetchall()
    
    lines = [
        f"# Run Summary: {run.get('name', run_id)}",
        "",
        f"- **State:** {run.get('state', '?')}",
        f"- **Project:** {run.get('project_id', '?')}",
        f"- **Type:** {run.get('run_type', '?')}",
        f"- **Started:** {run.get('started_at')}",
        f"- **Finished:** {run.get('finished_at')}",
        "",
    ]
    
    for report_type, stage, data_json, metrics_json in reports:
        try:
            metrics = json.loads(metrics_json or "{}")
            data = json.loads(data_json or "{}")
        except json.JSONDecodeError:
            continue
        lines.append(f"## {report_type} ({stage})")
        if report_type == "timing_summary":
            lines.append(f"- WNS: {metrics.get('wns_ns')} ns")
            lines.append(f"- WHS: {metrics.get('whs_ns')} ns")
            lines.append(f"- Setup met: {metrics.get('met_setup')}")
            paths = data.get("critical_paths", [])[:3]
            if paths:
                lines.append("### Top 3 critical paths")
                for p in paths:
                    lines.append(f"- `{p['source']}` → `{p['destination']}`: {p['slack_ns']} ns")
        elif report_type == "utilization":
            lines.append(f"- LUT: {metrics.get('lut_pct'):.2f}%")
            lines.append(f"- FF: {metrics.get('ff_pct'):.2f}%")
            lines.append(f"- BRAM: {metrics.get('bram_pct'):.2f}%")
            lines.append(f"- DSP: {metrics.get('dsp_pct'):.2f}%")
        elif report_type == "drc":
            lines.append(f"- Errors: {metrics.get('error_count')}")
            lines.append(f"- Warnings: {metrics.get('warning_count')}")
            lines.append(f"- Clean: {metrics.get('clean')}")
        elif report_type == "bitstream":
            lines.append(f"- Generated: {metrics.get('bit_found')}")
            if data.get("primary_bit"):
                lines.append(f"- Path: `{data['primary_bit']}`")
        elif report_type == "impl_summary":
            lines.append(f"- Overall OK: {metrics.get('ok')}")
            for issue in data.get("issues", [])[:5]:
                lines.append(f"  - [{issue['severity']}] {issue['message']}")
        lines.append("")
    
    return "\n".join(lines)


def write_summary_md(run_id: str) -> str:
    from edagent_vivado.harness.run_workspace import ensure_run_workspace
    ws = ensure_run_workspace(run_id)
    md = render_run_summary(run_id)
    target = ws.root / "summary.md"
    target.write_text(md, encoding="utf-8")
    return str(target.resolve())
```

### 10.2 orchestrator 调用

修改 `_summarize_step`:

```python
def _summarize_step(run: dict) -> None:
    from edagent_vivado.runs.summary import write_summary_md
    write_summary_md(run["id"])
```

### 10.3 API

`routes/reports.py` 加：

```python
@router.get("/runs/{run_id}/summary.md")
async def api_run_summary_md(run_id: str):
    from edagent_vivado.runs.summary import render_run_summary
    from fastapi.responses import PlainTextResponse
    md = render_run_summary(run_id)
    return PlainTextResponse(md, media_type="text/markdown")
```

---

## 11. 步骤 10：前端 Reports 面板

### 11.1 新建组件目录

```bash
cd frontend/src
mkdir -p components/reports
```

### 11.2 ReportsPanel.tsx

**新建** `frontend/src/components/reports/ReportsPanel.tsx`：

```tsx
import { useEffect, useState } from 'react'
import { TimingPanel } from './TimingPanel'
import { UtilizationPanel } from './UtilizationPanel'
import { DRCPanel } from './DRCPanel'
import { MethodologyPanel } from './MethodologyPanel'
import { BitstreamPanel } from './BitstreamPanel'
import './ReportsPanel.css'

type ReportRow = {
  id: string
  report_type: string
  stage: string
  data: any
  metrics: any
  created_at: number
}

const TABS = [
  { id: 'impl_summary', label: 'Summary' },
  { id: 'timing_summary', label: 'Timing' },
  { id: 'utilization', label: 'Utilization' },
  { id: 'drc', label: 'DRC' },
  { id: 'methodology', label: 'Methodology' },
  { id: 'bitstream', label: 'Bitstream' },
]

export function ReportsPanel({ runId, token }: { runId: string; token: string }) {
  const [reports, setReports] = useState<ReportRow[]>([])
  const [activeTab, setActiveTab] = useState('impl_summary')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/v1/runs/${runId}/reports`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        setReports(data.reports || data || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [runId, token])

  const byType = reports.reduce((acc: Record<string, ReportRow>, r) => {
    acc[r.report_type] = r
    return acc
  }, {})

  return (
    <div className="syn-reports">
      <div className="syn-reports__tabs">
        {TABS.map(t => {
          const has = !!byType[t.id]
          return (
            <button
              key={t.id}
              className={`syn-reports__tab ${activeTab === t.id ? 'is-active' : ''} ${!has ? 'is-empty' : ''}`}
              onClick={() => setActiveTab(t.id)}
              disabled={!has}
            >
              {t.label}
              {has && byType[t.id].metrics?.error_count > 0 && (
                <span className="syn-reports__badge">{byType[t.id].metrics.error_count}</span>
              )}
            </button>
          )
        })}
      </div>
      <div className="syn-reports__body">
        {loading && <div className="syn-reports__loading">Loading reports…</div>}
        {!loading && activeTab === 'impl_summary' && byType.impl_summary && (
          <ImplSummaryPanel report={byType.impl_summary} />
        )}
        {!loading && activeTab === 'timing_summary' && byType.timing_summary && (
          <TimingPanel report={byType.timing_summary} />
        )}
        {!loading && activeTab === 'utilization' && byType.utilization && (
          <UtilizationPanel report={byType.utilization} />
        )}
        {!loading && activeTab === 'drc' && byType.drc && (
          <DRCPanel report={byType.drc} />
        )}
        {!loading && activeTab === 'methodology' && byType.methodology && (
          <MethodologyPanel report={byType.methodology} />
        )}
        {!loading && activeTab === 'bitstream' && byType.bitstream && (
          <BitstreamPanel report={byType.bitstream} />
        )}
      </div>
    </div>
  )
}


function ImplSummaryPanel({ report }: { report: ReportRow }) {
  const data = report.data
  const issues = data.issues || []
  return (
    <div>
      <div className="syn-kpi-row">
        <KPI label="Overall" value={data.ok ? 'PASS' : 'FAIL'} variant={data.ok ? 'success' : 'danger'} />
        {data.timing && (
          <KPI label="WNS" value={fmtNs(data.timing.wns_ns)} variant={data.timing.met_setup ? 'success' : 'danger'} />
        )}
        {data.utilization && (
          <KPI label="LUT" value={`${(data.utilization.lut_pct ?? 0).toFixed(1)}%`} />
        )}
        {data.drc && (
          <KPI label="DRC" value={data.drc.clean ? 'Clean' : `${data.drc.error_count}E / ${data.drc.warning_count}W`}
               variant={data.drc.clean ? 'success' : 'warning'} />
        )}
      </div>
      <h3>Issues</h3>
      {issues.length === 0 && <p>No issues detected.</p>}
      <ul className="syn-issues">
        {issues.map((it: any, i: number) => (
          <li key={i} className={`syn-issue syn-issue--${it.severity}`}>
            <span className="syn-issue__cat">{it.category}</span>
            {it.message}
          </li>
        ))}
      </ul>
    </div>
  )
}


function KPI({ label, value, variant = 'neutral' }: { label: string; value: any; variant?: string }) {
  return (
    <div className={`syn-kpi syn-kpi--${variant}`}>
      <div className="syn-kpi__label">{label}</div>
      <div className="syn-kpi__value">{value}</div>
    </div>
  )
}


function fmtNs(v: any) {
  if (v == null) return '—'
  return `${v.toFixed(3)} ns`
}
```

### 11.3 TimingPanel.tsx

**新建** `frontend/src/components/reports/TimingPanel.tsx`：

```tsx
export function TimingPanel({ report }: { report: any }) {
  const data = report.data
  const paths = data.critical_paths || []
  return (
    <div className="syn-timing">
      <table className="syn-table">
        <thead><tr><th>Metric</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>WNS</td><td>{fmt(data.wns)} ns</td></tr>
          <tr><td>TNS</td><td>{fmt(data.tns)} ns</td></tr>
          <tr><td>WHS</td><td>{fmt(data.whs)} ns</td></tr>
          <tr><td>THS</td><td>{fmt(data.ths)} ns</td></tr>
          <tr><td>Setup met</td><td>{data.met_setup ? 'Yes' : 'No'}</td></tr>
          <tr><td>Hold met</td><td>{data.met_hold ? 'Yes' : 'No'}</td></tr>
        </tbody>
      </table>
      <h3>Top critical paths</h3>
      <table className="syn-table">
        <thead><tr>
          <th>Slack</th><th>Source</th><th>Destination</th><th>Group</th><th>Levels</th>
        </tr></thead>
        <tbody>
          {paths.map((p: any, i: number) => (
            <tr key={i} className={p.status === 'violated' ? 'is-violated' : ''}>
              <td>{p.slack_ns?.toFixed(3)}</td>
              <td><code>{p.source}</code></td>
              <td><code>{p.destination}</code></td>
              <td>{p.path_group}</td>
              <td>{p.logic_levels ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function fmt(v: any) {
  if (v == null) return '—'
  return Number(v).toFixed(3)
}
```

### 11.4 类似地建其它 panel

`UtilizationPanel.tsx`、`DRCPanel.tsx`、`MethodologyPanel.tsx`、`BitstreamPanel.tsx` 都套同样模板，展示 metrics + 列表。这里简短不重复。

### 11.5 CSS

**新建** `frontend/src/components/reports/ReportsPanel.css`：

```css
.syn-reports {
  display: flex;
  flex-direction: column;
  background: var(--syn-bg-elev);
  border-radius: var(--syn-radius-md);
  border: 1px solid var(--syn-border-subtle);
  overflow: hidden;
}

.syn-reports__tabs {
  display: flex;
  gap: 2px;
  padding: 8px 8px 0;
  border-bottom: 1px solid var(--syn-border-subtle);
}

.syn-reports__tab {
  padding: 8px 14px;
  background: transparent;
  border: none;
  color: var(--syn-text-muted);
  border-radius: var(--syn-radius-sm) var(--syn-radius-sm) 0 0;
  font-size: 13px;
  cursor: pointer;
  position: relative;
}

.syn-reports__tab.is-active {
  background: var(--syn-bg);
  color: var(--syn-text);
  font-weight: 500;
}

.syn-reports__tab.is-empty {
  opacity: 0.4;
}

.syn-reports__badge {
  margin-left: 6px;
  background: var(--syn-danger);
  color: white;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
}

.syn-reports__body {
  padding: 16px;
  min-height: 240px;
}

.syn-kpi-row {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.syn-kpi {
  background: var(--syn-bg);
  padding: 12px 16px;
  border-radius: var(--syn-radius-sm);
  border: 1px solid var(--syn-border-subtle);
  min-width: 110px;
}

.syn-kpi--success { border-color: var(--syn-success); }
.syn-kpi--danger { border-color: var(--syn-danger); }
.syn-kpi--warning { border-color: var(--syn-warning); }

.syn-kpi__label {
  font-size: 11px;
  text-transform: uppercase;
  color: var(--syn-text-muted);
  letter-spacing: 0.5px;
}

.syn-kpi__value {
  font-size: 22px;
  font-weight: 500;
  font-family: var(--syn-font-mono);
  margin-top: 2px;
}

.syn-issues { list-style: none; padding: 0; }
.syn-issue {
  padding: 6px 8px;
  margin-bottom: 4px;
  border-radius: var(--syn-radius-sm);
  border-left: 3px solid var(--syn-border-subtle);
}
.syn-issue--high { border-left-color: var(--syn-danger); background: rgba(229, 80, 80, 0.05); }
.syn-issue--medium { border-left-color: var(--syn-warning); background: rgba(229, 168, 80, 0.05); }
.syn-issue--low { border-left-color: var(--syn-text-muted); }
.syn-issue__cat {
  display: inline-block;
  font-size: 10px;
  text-transform: uppercase;
  background: var(--syn-bg-elev);
  padding: 1px 6px;
  border-radius: 4px;
  margin-right: 6px;
  color: var(--syn-text-muted);
}

.syn-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.syn-table th, .syn-table td {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid var(--syn-border-subtle);
}

.syn-table tr.is-violated td { color: var(--syn-danger); }
.syn-table code {
  font-family: var(--syn-font-mono);
  font-size: 11px;
}
```

---

## 12. 步骤 11：Artifacts 面板

### 12.1 ArtifactsPanel.tsx

**新建** `frontend/src/components/artifacts/ArtifactsPanel.tsx`：

```tsx
import { useEffect, useState } from 'react'
import './ArtifactsPanel.css'

type Artifact = {
  id: string
  path: string
  artifact_type: string
  size_bytes: number
  sha256: string
  mime_type?: string
}

export function ArtifactsPanel({ runId, token }: { runId: string; token: string }) {
  const [arts, setArts] = useState<Artifact[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/v1/runs/${runId}/artifacts`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => {
        setArts(d.artifacts || d || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [runId, token])

  const grouped = arts.reduce((acc: Record<string, Artifact[]>, a) => {
    const type = a.artifact_type || 'other'
    if (!acc[type]) acc[type] = []
    acc[type].push(a)
    return acc
  }, {})

  return (
    <div className="syn-artifacts">
      {loading && <p>Loading artifacts…</p>}
      {Object.entries(grouped).map(([type, items]) => (
        <div key={type} className="syn-artifacts__group">
          <h3>{type}</h3>
          <ul>
            {items.map(a => (
              <li key={a.id}>
                <span className="syn-artifacts__path">{a.path}</span>
                <span className="syn-artifacts__size">{fmtBytes(a.size_bytes)}</span>
                <a
                  className="syn-artifacts__dl"
                  href={`/api/v1/artifacts/${a.id}/download`}
                  download
                  onClick={e => {
                    // attach token via fetch then create blob; simplified here for clarity
                    e.preventDefault()
                    fetch(`/api/v1/artifacts/${a.id}/download`, {
                      headers: { Authorization: `Bearer ${token}` },
                    })
                      .then(r => r.blob())
                      .then(blob => {
                        const url = URL.createObjectURL(blob)
                        const link = document.createElement('a')
                        link.href = url
                        link.download = a.path.split('/').pop() || 'artifact'
                        link.click()
                        URL.revokeObjectURL(url)
                      })
                  }}
                >Download</a>
                {a.sha256 && (
                  <span className="syn-artifacts__sha" title="sha256">{a.sha256.slice(0, 8)}…</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="syn-artifacts__actions">
        <a
          className="syn-button"
          href={`/api/v1/runs/${runId}/artifacts/zip`}
          onClick={e => { /* same auth-aware download */ }}
        >Download all (zip)</a>
      </div>
    </div>
  )
}


function fmtBytes(n: number) {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
```

### 12.2 Zip 下载后端

`routes/artifacts.py`：

```python
@router.get("/runs/{run_id}/artifacts/zip")
async def api_artifacts_zip(run_id: str):
    import io, zipfile
    from fastapi.responses import StreamingResponse
    from edagent_vivado.repository.store import artifacts_for_run
    
    arts = artifacts_for_run(run_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for a in arts:
            p = a["path"]
            from pathlib import Path
            if Path(p).exists():
                zf.write(p, arcname=Path(p).name)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="run_{run_id}.zip"'},
    )
```

---

## 13. 步骤 12：TrendChart

### 13.1 用最简单方案

避免引入 chart 依赖，先用纯 SVG 折线。

**新建** `frontend/src/components/reports/TrendChart.tsx`：

```tsx
import { useEffect, useState } from 'react'
import './TrendChart.css'

type Point = { run_id: string; name: string; state: string; started_at: number; metrics: any }

export function TrendChart({ projectId, token }: { projectId: string; token: string }) {
  const [series, setSeries] = useState<Point[]>([])
  const [selectedMetric, setSelectedMetric] = useState('wns_ns')

  useEffect(() => {
    fetch(`/api/v1/projects/${projectId}/trend?limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => setSeries(d.series || []))
  }, [projectId, token])

  const metricOptions = [
    { id: 'wns_ns', label: 'WNS (ns)' },
    { id: 'lut_pct', label: 'LUT %' },
    { id: 'ff_pct', label: 'FF %' },
    { id: 'drc_error_count', label: 'DRC errors' },
  ]

  const data = series.map(p => p.metrics?.[selectedMetric]).filter((v: any) => v != null)
  if (data.length === 0) {
    return <div className="syn-trend syn-trend--empty">No data for {selectedMetric}</div>
  }
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1
  const W = 480
  const H = 120
  const pad = 24
  const xs = (i: number) => pad + (i * (W - 2 * pad)) / Math.max(1, data.length - 1)
  const ys = (v: number) => pad + (H - 2 * pad) * (1 - (v - min) / range)

  const points = data.map((v: number, i: number) => `${xs(i)},${ys(v)}`).join(' ')

  return (
    <div className="syn-trend">
      <div className="syn-trend__controls">
        <select value={selectedMetric} onChange={e => setSelectedMetric(e.target.value)}>
          {metricOptions.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </div>
      <svg width={W} height={H}>
        <polyline points={points} fill="none" stroke="var(--syn-accent)" strokeWidth="2" />
        {data.map((v: number, i: number) => (
          <circle key={i} cx={xs(i)} cy={ys(v)} r="3" fill="var(--syn-accent)" />
        ))}
      </svg>
      <div className="syn-trend__legend">
        <span>min: {min.toFixed(3)}</span>
        <span>max: {max.toFixed(3)}</span>
        <span>n={data.length}</span>
      </div>
    </div>
  )
}
```

---

## 14. 收尾验证

### 14.1 测试

```bash
python -m pytest -k "not agent_smoke" -q --tb=line
# 新增的 parser 测试应全绿
```

### 14.2 端到端 smoke

```bash
# 1. 跑一个完整 mock run
curl -X POST -H "Content-Type: application/json" -H "Authorization: Bearer test123" \
  -d '{"run_type":"vivado_full_flow","manifest_path":"examples/uart_demo/eda.yaml","session_id":"s_demo","auto_start":true}' \
  http://127.0.0.1:8484/api/v1/projects/test_proj/runs

# 2. 拿 run_id 后查 reports
RID="..."
curl -H "Authorization: Bearer test123" \
  http://127.0.0.1:8484/api/v1/runs/$RID/reports | python -m json.tool

# 3. 查 summary.md
curl -H "Authorization: Bearer test123" \
  http://127.0.0.1:8484/api/v1/runs/$RID/summary.md

# 4. 查 trend
curl -H "Authorization: Bearer test123" \
  http://127.0.0.1:8484/api/v1/projects/test_proj/trend?limit=10 | python -m json.tool

# 5. 下 zip
curl -H "Authorization: Bearer test123" \
  http://127.0.0.1:8484/api/v1/runs/$RID/artifacts/zip -o /tmp/run.zip
unzip -l /tmp/run.zip
```

### 14.3 前端 smoke

```bash
cd frontend && npm run dev
# 浏览器打开 http://127.0.0.1:5173
# 进入一个 run 详情页：
#   - Reports 面板能看到 Summary / Timing / Utilization / DRC / Bitstream tab
#   - Artifacts 面板列出文件，能下载
#   - Trend 图能切换 metric 显示
```

### 14.4 commit

```bash
git add -A
git commit -m "Phase 5: complete reports + artifacts pipeline

Parsers:
- timing_parser: extract top-N critical paths (source/dest/group/levels)
- utilization_parser: per-site-type table + percentages
- drc parser: category classification + suggested actions
- methodology parser: severity rank + by-category
- new: impl_summary parser (combines timing/util/drc/log into holistic report)
- new: bitstream detector (.bit/.ltx/.mcs with sha256)

DB & runtime:
- reports table: add metrics_json column + migration
- runs/trend.py: aggregate per-run metrics, return time series
- runs/summary.py: render Markdown summary per run
- orchestrator._parse_reports_step: persist all parsers + metrics
- orchestrator._collect_artifacts_step: bitstream detect + workspace walk

API:
- GET /projects/{id}/trend
- GET /runs/{id}/summary.md
- GET /runs/{id}/artifacts/zip

Frontend:
- ReportsPanel + Timing/Utilization/DRC/Methodology/Bitstream/ImplSummary panels
- ArtifactsPanel with token-aware download
- TrendChart (pure SVG, no deps)
- design tokens applied (Cursor + Claude palette)
"
```

---

## 15. 附录

### 15.1 常见坑

**A. Vivado report 格式版本差异**：不同 Vivado 版本（2019.x vs 2023.x）report 格式略有差异。Phase 5 用 regex 尽量宽松，但 fixtures 测的是 2023.x 样本。

**B. critical path 多行 wrap**：路径名很长会被 wrap 到多行。`PATH_BLOCK_RE` 已用 `re.DOTALL`，但要小心 `Source:` 后面跟续行的情况。补一个 fixture 测试。

**C. metrics_json 与 data_json 重复**：`metrics_json` 只存数值化关键指标用于 trend；`data_json` 是完整结构。trend 查询只读 metrics_json 避免 N+1 JSON 解析。

**D. zip 下载大文件**：`StreamingResponse` 接 BytesIO 会全在内存。如果 artifact 很大，改 spool 到临时文件 + `FileResponse`。v1.0 接受全内存版本（artifact 通常 < 50MB 总和）。

**E. Trend metric key 漂移**：metrics_json 里 key 是 `report_type_field`，前端写死了 `wns_ns` / `lut_pct` 等。Phase 5 在 `runs/trend.py::_aggregate_run_metrics` 末尾做了别名映射，前端 key 稳定。

**F. EventSource auth 仍未解决**：Phase 4 已经讨论。Phase 5 reports 是 polling，没有 SSE 依赖。

### 15.2 耗时

| 步骤 | 估时 |
|------|------|
| 1. timing critical paths | 0.5d |
| 2. utilization sites | 0.3d |
| 3. drc categorize | 0.3d |
| 4. methodology severity | 0.3d |
| 5. impl_summary | 0.5d |
| 6. bitstream detector | 0.3d |
| 7. DB metrics_json + migration | 0.3d |
| 8. trend.py | 0.5d |
| 9. routes/reports.py 更新 | 0.5d |
| 10. ReportsPanel + 子 panel × 5 | 1.5d |
| 11. ArtifactsPanel + zip | 0.5d |
| 12. TrendChart | 0.5d |
| 13. summary.py | 0.3d |
| 14. 收尾验证 | 0.5d |

**总计：** 全职 6 天；vibe coding 2 周。

### 15.3 Phase 6 衔接

Phase 5 报告 + 产物 + trend 之后，Phase 6 开始系统性应用 Cursor + Claude 设计：
- 把 ReportsPanel 嵌入新的三栏 AppShell
- 加 RunTimeline 沉浸式视图
- ToolCallBlock 折叠/展开样式精修
- Approval Card / Diff Viewer 细化

Phase 5 已经引入了 KPI / 表格 / SVG 折线 三类基础组件，可以作为 Phase 6 进一步抽象成设计系统组件库的起点。
