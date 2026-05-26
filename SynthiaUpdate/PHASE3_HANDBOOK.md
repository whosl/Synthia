# Synthia Phase 3 开发手册：xpr-first Project Layer

> **前置：** Phase 0/1/2 已完成（API 拆分、connector 单一入口、capability stub 就位）  
> **目标：** 用户以 `.xpr` 为主操作工程，系统内部自动生成 manifest；支持 import xpr / scan 目录 / 向导新建 / fingerprint 同步检查  
> **预估工期：** 全职 12-15 天；vibe coding 3 周  
> **关键约束：** 仅做 **xpr → manifest 单向同步**，不做反向回写（已记 ADR-0001）

---

## 目录

- [0. 准备](#0-准备)
- [1. 设计概览](#1-设计概览)
- [2. 子任务 1：xpr XML 解析器](#2-子任务-1xpr-xml-解析器)
- [3. 子任务 2：scanner（目录扫描）](#3-子任务-2scanner目录扫描)
- [4. 子任务 3：manifest 生成](#4-子任务-3manifest-生成)
- [5. 子任务 4：fingerprint sync check](#5-子任务-4fingerprint-sync-check)
- [6. 子任务 5：wizard（Vivado-like 创建工程）](#6-子任务-5wizardvivado-like-创建工程)
- [7. 子任务 6：connector capability 接入](#7-子任务-6connector-capability-接入)
- [8. 子任务 7：projects API](#8-子任务-7projects-api)
- [9. 子任务 8：fixtures + 测试](#9-子任务-8fixtures--测试)
- [10. 子任务 9：前端 Project 导入页](#10-子任务-9前端-project-导入页)
- [11. 收尾](#11-收尾)

---

## 0. 准备

### 0.1 前置检查

```bash
cd E:/dev/edagent-vivado
git status   # clean
python -m pytest -k "not agent_smoke" -q --tb=no
# 期望: 0 failed
python scripts/check_phase2_compliance.py
# 期望: OK
```

### 0.2 学习 .xpr 文件格式

`.xpr` 是 Vivado 的工程文件，本质是 XML。结构示例：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Project Version="7" Minor="42" Path="uart_demo.xpr">
  <DefaultLaunch Dir="$PRUNDIR"/>
  <Configuration>
    <Option Name="Part" Val="xc7a50tfgg484-2"/>
    <Option Name="BoardPart" Val=""/>
    <Option Name="TopModule" Val="uart_top"/>
    <Option Name="TargetLanguage" Val="Verilog"/>
  </Configuration>
  <FileSets Version="1" Minor="31">
    <FileSet Name="sources_1" Type="DesignSrcs">
      <File Path="$PPRDIR/rtl/uart_top.v"/>
      <File Path="$PPRDIR/rtl/uart_tx.v"/>
      <File Path="$PPRDIR/rtl/uart_rx.v"/>
    </FileSet>
    <FileSet Name="constrs_1" Type="Constrs">
      <File Path="$PPRDIR/constraints/top.xdc"/>
    </FileSet>
    <FileSet Name="sim_1" Type="SimulationSrcs">
      <File Path="$PPRDIR/tb/uart_tb.sv"/>
    </FileSet>
  </FileSets>
  <Simulators>
    <Simulator Name="XSim" Type="xsim"/>
  </Simulators>
</Project>
```

**关键字段：**

| 字段 | xpath | 备注 |
|------|-------|------|
| Part | `/Project/Configuration/Option[@Name='Part']/@Val` | 器件型号 |
| BoardPart | `Option[@Name='BoardPart']` | 板卡（可选） |
| TopModule | `Option[@Name='TopModule']` | 顶层模块 |
| TargetLanguage | `Option[@Name='TargetLanguage']` | Verilog / VHDL |
| RTL | `FileSet[@Type='DesignSrcs']/File/@Path` | 设计文件 |
| Constraints | `FileSet[@Type='Constrs']/File/@Path` | XDC |
| Simulation | `FileSet[@Type='SimulationSrcs']/File/@Path` | Testbench |
| IP | `File[matches(@Path, '\.xci$')]` | IP cores |
| BD | `File[matches(@Path, '\.bd$')]` | Block Designs |

**路径占位符：**

- `$PPRDIR` = project parent dir（`.xpr` 所在目录）
- `$PRUNDIR` = project run dir
- 绝对路径不带占位符

---

## 1. 设计概览

### 1.1 目录结构（新增模块）

```text
src/edagent_vivado/projects/
├── __init__.py         # 已存在
├── validate.py         # 已存在
├── snapshot.py         # 已存在
├── store.py            # 已存在或新增（项目 CRUD）
├── xpr_parser.py       # ★ 新增：纯 XML 解析
├── xpr_importer.py     # ★ 新增：xpr → Project record
├── scanner.py          # ★ 新增：目录扫描
├── manifest_gen.py     # ★ 新增：生成 .synthia/eda.yaml
├── manifest_sync.py    # ★ 新增：fingerprint check
├── wizard.py           # ★ 新增：向导式新建
└── fixtures/           # ★ 新增：测试用 fixture
    ├── valid_uart.xpr
    ├── missing_rtl/
    └── has_ip.xpr
```

### 1.2 数据流

```text
import-xpr 流程:
  user:  POST /projects/import-xpr {xpr_path}
    ↓
  xpr_parser.parse_xpr(path) → XprDocument
    ↓
  xpr_importer.materialize(doc) → ProjectRecord
    ↓
  manifest_gen.write_internal_manifest(record) → .synthia/eda.yaml
    ↓
  store.project_create(record) → DB row
    ↓
  return 201 {project_id, summary}

scan 流程:
  user:  POST /projects/scan {root_path}
    ↓
  scanner.scan_directory(root) → ScanResult (xprs, rtl, xdc, ip, bd)
    ↓
  scanner.guess_top_module(rtl_files) → str | None
    ↓
  if 1 xpr found:
    xpr_parser.parse_xpr(xpr) + merge scan
  else:
    return ScanResult to UI for user confirmation
    ↓
  POST /projects/from-wizard {confirmed fields}

sync-check 流程:
  user:  GET /projects/{id}/health
    ↓
  manifest_sync.check_fingerprint(project) → SyncStatus
    ↓
  if xpr modified since import:
    return {status: 'stale', actions: ['re-import', 'ignore']}
```

### 1.3 关键决策（再次确认）

- **v1.0 只做 xpr → manifest 单向**。用户在 Vivado GUI 改了工程，**只提示，不自动反向**。
- **IP / BD 只记录路径**，不解析 `.xci` 内部参数。
- **path 在内部一律 POSIX 格式**（`/`），Windows 上展示时再 normalize。

---

## 2. 子任务 1：xpr XML 解析器

### 2.1 新建数据类型

**新建** `src/edagent_vivado/projects/xpr_parser.py`：

```python
"""Vivado .xpr (XML) parser — Phase 3.

Parses .xpr into a structured XprDocument. Does NOT touch disk beyond reading
the file. Path expansion (PPRDIR substitution) is provided as a helper.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class XprFile:
    path: str                       # 原始路径，可能含 $PPRDIR
    abs_path: str = ""              # 绝对路径（expand 后）
    file_type: str = "unknown"      # rtl | xdc | tb | ip | bd | other


@dataclass
class XprFileSet:
    name: str
    type_: str                      # DesignSrcs | Constrs | SimulationSrcs
    files: list[XprFile] = field(default_factory=list)


@dataclass
class XprDocument:
    xpr_path: str
    project_dir: str                # .xpr 所在目录
    name: str                       # .xpr 文件名（不含 .xpr）
    part: str = ""
    board_part: str = ""
    top_module: str = ""
    target_language: str = ""
    vivado_version: str = ""
    filesets: list[XprFileSet] = field(default_factory=list)
    raw_options: dict[str, str] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    # 便捷访问
    @property
    def rtl_files(self) -> list[XprFile]:
        out: list[XprFile] = []
        for fs in self.filesets:
            if fs.type_ == "DesignSrcs":
                out.extend(f for f in fs.files if f.file_type in ("rtl", "ip", "bd"))
        return out

    @property
    def xdc_files(self) -> list[XprFile]:
        out: list[XprFile] = []
        for fs in self.filesets:
            if fs.type_ == "Constrs":
                out.extend(fs.files)
        return out

    @property
    def tb_files(self) -> list[XprFile]:
        out: list[XprFile] = []
        for fs in self.filesets:
            if fs.type_ == "SimulationSrcs":
                out.extend(fs.files)
        return out

    @property
    def ip_files(self) -> list[XprFile]:
        return [f for fs in self.filesets for f in fs.files if f.file_type == "ip"]

    @property
    def bd_files(self) -> list[XprFile]:
        return [f for fs in self.filesets for f in fs.files if f.file_type == "bd"]


def _classify_file(path: str) -> str:
    p = path.lower()
    if p.endswith((".v", ".sv", ".svh", ".vh", ".vhd", ".vhdl")):
        return "rtl"
    if p.endswith(".xdc"):
        return "xdc"
    if p.endswith(".xci"):
        return "ip"
    if p.endswith(".bd"):
        return "bd"
    return "other"


def _expand_path(raw: str, project_dir: str, xpr_path: str) -> str:
    """Expand $PPRDIR placeholder. Use POSIX separators."""
    p = raw.replace("$PPRDIR", project_dir).replace("$PRUNDIR", project_dir + "/runs")
    return str(Path(p)).replace("\\", "/")


def parse_xpr(xpr_path: str | Path) -> XprDocument:
    """Parse a Vivado .xpr file into a structured document.

    Raises:
        FileNotFoundError, ET.ParseError
    """
    p = Path(xpr_path)
    if not p.exists():
        raise FileNotFoundError(f".xpr not found: {xpr_path}")

    project_dir = str(p.parent).replace("\\", "/")
    doc = XprDocument(
        xpr_path=str(p).replace("\\", "/"),
        project_dir=project_dir,
        name=p.stem,
    )

    tree = ET.parse(str(p))
    root = tree.getroot()

    # Vivado version 从根 attrs 推断
    version = root.attrib.get("Version", "")
    minor = root.attrib.get("Minor", "")
    if version:
        doc.vivado_version = f"{version}.{minor}" if minor else version

    # Configuration / Options
    for opt in root.iter("Option"):
        name = opt.attrib.get("Name", "")
        val = opt.attrib.get("Val", "")
        if name:
            doc.raw_options[name] = val
            if name == "Part": doc.part = val
            elif name == "BoardPart": doc.board_part = val
            elif name == "TopModule": doc.top_module = val
            elif name == "TargetLanguage": doc.target_language = val

    # FileSets
    for fs_node in root.iter("FileSet"):
        fs = XprFileSet(
            name=fs_node.attrib.get("Name", ""),
            type_=fs_node.attrib.get("Type", ""),
        )
        for f_node in fs_node.iter("File"):
            raw = f_node.attrib.get("Path", "")
            if not raw:
                continue
            xf = XprFile(
                path=raw,
                abs_path=_expand_path(raw, project_dir, str(p)),
                file_type=_classify_file(raw),
            )
            fs.files.append(xf)
        doc.filesets.append(fs)

    # 完整性检查
    if not doc.part:
        doc.warnings.append("part not declared in xpr")
    if not doc.top_module:
        doc.warnings.append("top_module not declared in xpr")
    if not doc.rtl_files:
        doc.warnings.append("no RTL files found")

    return doc
```

### 2.2 写测试 fixture

**新建** `tests/fixtures/xpr/valid_uart.xpr`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Project Version="7" Minor="42" Path="valid_uart.xpr">
  <Configuration>
    <Option Name="Part" Val="xc7a50tfgg484-2"/>
    <Option Name="TopModule" Val="uart_top"/>
    <Option Name="TargetLanguage" Val="Verilog"/>
    <Option Name="BoardPart" Val=""/>
  </Configuration>
  <FileSets Version="1" Minor="31">
    <FileSet Name="sources_1" Type="DesignSrcs">
      <File Path="$PPRDIR/rtl/uart_top.v"/>
      <File Path="$PPRDIR/rtl/uart_tx.v"/>
      <File Path="$PPRDIR/rtl/uart_rx.v"/>
    </FileSet>
    <FileSet Name="constrs_1" Type="Constrs">
      <File Path="$PPRDIR/constraints/top.xdc"/>
    </FileSet>
    <FileSet Name="sim_1" Type="SimulationSrcs">
      <File Path="$PPRDIR/tb/uart_tb.sv"/>
    </FileSet>
  </FileSets>
</Project>
```

类似准备：

- `tests/fixtures/xpr/missing_part.xpr` — 没有 `Option Name="Part"`
- `tests/fixtures/xpr/has_ip.xpr` — 含 `.xci`
- `tests/fixtures/xpr/has_bd.xpr` — 含 `.bd`

### 2.3 单元测试

**新建** `tests/test_xpr_parser.py`：

```python
from pathlib import Path
from edagent_vivado.projects.xpr_parser import parse_xpr, _classify_file


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "xpr"


def test_parse_valid_uart():
    doc = parse_xpr(FIXTURE_DIR / "valid_uart.xpr")
    assert doc.name == "valid_uart"
    assert doc.part == "xc7a50tfgg484-2"
    assert doc.top_module == "uart_top"
    assert doc.target_language == "Verilog"
    assert len(doc.rtl_files) == 3
    assert len(doc.xdc_files) == 1
    assert len(doc.tb_files) == 1
    assert doc.warnings == []


def test_parse_missing_part_warns():
    doc = parse_xpr(FIXTURE_DIR / "missing_part.xpr")
    assert doc.part == ""
    assert "part not declared" in " ".join(doc.warnings)


def test_classify_file():
    assert _classify_file("foo.v") == "rtl"
    assert _classify_file("foo.SV") == "rtl"
    assert _classify_file("foo.xdc") == "xdc"
    assert _classify_file("foo.xci") == "ip"
    assert _classify_file("foo.bd") == "bd"
    assert _classify_file("foo.txt") == "other"


def test_ip_and_bd_classified():
    doc = parse_xpr(FIXTURE_DIR / "has_ip.xpr")
    assert len(doc.ip_files) >= 1
    
    doc2 = parse_xpr(FIXTURE_DIR / "has_bd.xpr")
    assert len(doc2.bd_files) >= 1


def test_path_expansion():
    doc = parse_xpr(FIXTURE_DIR / "valid_uart.xpr")
    rtl = doc.rtl_files[0]
    assert "$PPRDIR" not in rtl.abs_path
    assert rtl.abs_path.endswith("/rtl/uart_top.v")
```

```bash
python -m pytest tests/test_xpr_parser.py -v
```

### 2.4 commit

```bash
git commit -am "Phase 3.1: xpr XML parser with fixtures"
```

---

## 3. 子任务 2：scanner（目录扫描）

### 3.1 新建 scanner

**新建** `src/edagent_vivado/projects/scanner.py`：

```python
"""Directory scanner — find FPGA project artifacts without an .xpr."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class ScanResult:
    root: str
    xpr_files: list[str] = field(default_factory=list)
    rtl_files: list[str] = field(default_factory=list)
    sv_files: list[str] = field(default_factory=list)
    vhd_files: list[str] = field(default_factory=list)
    xdc_files: list[str] = field(default_factory=list)
    ip_files: list[str] = field(default_factory=list)
    bd_files: list[str] = field(default_factory=list)
    tcl_files: list[str] = field(default_factory=list)
    mem_files: list[str] = field(default_factory=list)
    candidate_top_modules: list[str] = field(default_factory=list)
    detected_part: str = ""

    @property
    def is_likely_fpga_project(self) -> bool:
        return bool(self.rtl_files or self.sv_files or self.vhd_files or self.xpr_files)


_DEFAULT_EXCLUDE = {
    ".git", "node_modules", "__pycache__", ".synthia", ".edagent",
    "build", "dist", "runs", ".vscode", ".idea",
    "vivado.cache", "vivado.hw", "vivado.sim",   # Vivado 生成目录
    ".Xil", "vivado.ip_user_files",
}


def scan_directory(
    root: str | Path,
    max_files: int = 10_000,
    exclude_dirs: set[str] | None = None,
) -> ScanResult:
    """Walk `root` looking for FPGA project artifacts.

    - Skips `.git`, `__pycache__`, `node_modules`, Vivado cache directories
    - Hard caps at `max_files` files inspected
    """
    excl = (exclude_dirs or set()) | _DEFAULT_EXCLUDE
    root_p = Path(root).resolve()
    if not root_p.exists() or not root_p.is_dir():
        return ScanResult(root=str(root_p))

    result = ScanResult(root=str(root_p).replace("\\", "/"))
    count = 0

    for p in root_p.rglob("*"):
        if count >= max_files:
            break
        # 跳过排除目录
        if any(part in excl for part in p.parts):
            continue
        if not p.is_file():
            continue
        count += 1
        name = p.name.lower()
        rel = str(p).replace("\\", "/")

        if name.endswith(".xpr"):
            result.xpr_files.append(rel)
        elif name.endswith(".v"):
            result.rtl_files.append(rel)
        elif name.endswith((".sv", ".svh")):
            result.sv_files.append(rel)
        elif name.endswith((".vhd", ".vhdl")):
            result.vhd_files.append(rel)
        elif name.endswith(".xdc"):
            result.xdc_files.append(rel)
        elif name.endswith(".xci"):
            result.ip_files.append(rel)
        elif name.endswith(".bd"):
            result.bd_files.append(rel)
        elif name.endswith(".tcl"):
            result.tcl_files.append(rel)
        elif name.endswith((".mem", ".coe", ".hex")):
            result.mem_files.append(rel)

    # 推测 top module
    result.candidate_top_modules = guess_top_modules(
        result.rtl_files + result.sv_files
    )
    # 从 XDC 推测 part
    if result.xdc_files:
        result.detected_part = _detect_part_from_xdc(result.xdc_files[0])

    return result


_MODULE_RE = re.compile(r"^\s*module\s+(\w+)", re.MULTILINE)


def guess_top_modules(files: list[str], top_n: int = 5) -> list[str]:
    """Heuristic: count modules, prefer names containing 'top' or 'main'."""
    counter: dict[str, int] = {}
    for fp in files:
        try:
            text = Path(fp).read_text(encoding="utf-8", errors="replace")
            for m in _MODULE_RE.finditer(text):
                name = m.group(1)
                counter[name] = counter.get(name, 0) + 1
        except Exception:
            continue
    # 排序：优先含 'top' 'main' 关键词，再按行数
    def score(name: str) -> tuple[int, int]:
        priority = 1 if any(k in name.lower() for k in ("top", "main", "wrapper")) else 0
        return (priority, counter[name])
    return sorted(counter.keys(), key=score, reverse=True)[:top_n]


def _detect_part_from_xdc(xdc_path: str) -> str:
    """Heuristic part detection from XDC comments or property assignments."""
    try:
        text = Path(xdc_path).read_text(encoding="utf-8", errors="replace")
        # 一些 XDC 文件头有 "# Part: xc..."
        m = re.search(r"#\s*Part:?\s*(\S+)", text, re.IGNORECASE)
        if m:
            return m.group(1)
        # 或在 IO planning 注释里
        m = re.search(r"#.*for\s+(xc[0-9a-z\-]+)", text, re.IGNORECASE)
        if m:
            return m.group(1)
    except Exception:
        pass
    return ""
```

### 3.2 测试

**新建** `tests/test_scanner.py`：

```python
from pathlib import Path
from edagent_vivado.projects.scanner import scan_directory, guess_top_modules


def test_scan_uart_demo():
    result = scan_directory("examples/uart_demo")
    assert result.is_likely_fpga_project
    assert len(result.rtl_files) >= 1


def test_scan_skips_git_and_pycache(tmp_path):
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "hidden.v").write_text("module foo;")
    (tmp_path / "real.v").write_text("module bar;")
    result = scan_directory(tmp_path)
    assert any("real.v" in f for f in result.rtl_files)
    assert not any(".git" in f for f in result.rtl_files)


def test_guess_top_modules(tmp_path):
    (tmp_path / "uart_top.v").write_text("module uart_top();\nendmodule\n")
    (tmp_path / "sub.v").write_text("module sub();\nendmodule\n")
    candidates = guess_top_modules([str(tmp_path / "uart_top.v"), str(tmp_path / "sub.v")])
    assert candidates[0] == "uart_top"  # 含 "top" 优先


def test_scan_empty_dir(tmp_path):
    result = scan_directory(tmp_path)
    assert not result.is_likely_fpga_project
```

```bash
python -m pytest tests/test_scanner.py -v
```

---

## 4. 子任务 3：manifest 生成

### 4.1 新建 manifest_gen

**新建** `src/edagent_vivado/projects/manifest_gen.py`：

```python
"""Generate internal .synthia/eda.yaml from XprDocument or ScanResult."""

from __future__ import annotations

import yaml
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from edagent_vivado.projects.xpr_parser import XprDocument
from edagent_vivado.projects.scanner import ScanResult


def manifest_from_xpr(doc: XprDocument) -> dict[str, Any]:
    """Convert XprDocument into eda.yaml-compatible dict."""
    return {
        "project": {
            "name": doc.name,
            "vivado_version": doc.vivado_version or "2024.1",
            "part": doc.part,
            "board_part": doc.board_part,
            "top": doc.top_module,
            "target_language": doc.target_language.lower() if doc.target_language else "verilog",
            "flow": "project",   # xpr-imported = project mode
        },
        "sources": {
            "rtl": [f.abs_path for f in doc.rtl_files if f.file_type == "rtl"],
            "tb": [f.abs_path for f in doc.tb_files],
            "include_dirs": [],
        },
        "constraints": {
            "xdc": [f.abs_path for f in doc.xdc_files],
        },
        "ip": {
            "xci": [f.abs_path for f in doc.ip_files],
        },
        "bd": {
            "files": [f.abs_path for f in doc.bd_files],
        },
        "runs": {
            "synth": {"enabled": True},
            "impl": {"enabled": True},
        },
        "qor_targets": {
            "wns_min": 0.0,
            "require_drc_clean": True,
        },
        "_meta": {
            "imported_from_xpr": doc.xpr_path,
            "warnings": doc.warnings,
        },
    }


def manifest_from_scan(
    scan: ScanResult,
    *,
    top_module: str = "",
    part: str = "",
    name: str = "",
) -> dict[str, Any]:
    """Convert ScanResult + user choices into eda.yaml dict."""
    return {
        "project": {
            "name": name or Path(scan.root).name,
            "vivado_version": "2024.1",
            "part": part or scan.detected_part,
            "top": top_module or (scan.candidate_top_modules[0] if scan.candidate_top_modules else ""),
            "flow": "non_project",   # scan = batch mode
        },
        "sources": {
            "rtl": scan.rtl_files + scan.sv_files + scan.vhd_files,
            "tb": [],
            "include_dirs": [],
        },
        "constraints": {
            "xdc": scan.xdc_files,
        },
        "ip": {"xci": scan.ip_files},
        "bd": {"files": scan.bd_files},
        "runs": {
            "synth": {"enabled": True},
            "impl": {"enabled": False},
        },
        "_meta": {
            "imported_from_scan": scan.root,
            "candidate_top_modules": scan.candidate_top_modules,
        },
    }


def write_internal_manifest(
    project_root: str | Path,
    manifest: dict[str, Any],
) -> Path:
    """Write .synthia/eda.yaml under project_root. Returns absolute path."""
    root = Path(project_root)
    synthia_dir = root / ".synthia"
    synthia_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = synthia_dir / "eda.yaml"
    with open(manifest_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(manifest, f, sort_keys=False, allow_unicode=True)
    return manifest_path
```

### 4.2 测试

**新建** `tests/test_manifest_gen.py`：

```python
from pathlib import Path
import yaml
from edagent_vivado.projects.xpr_parser import parse_xpr
from edagent_vivado.projects.manifest_gen import (
    manifest_from_xpr,
    write_internal_manifest,
)


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "xpr"


def test_manifest_from_xpr_basic():
    doc = parse_xpr(FIXTURE_DIR / "valid_uart.xpr")
    m = manifest_from_xpr(doc)
    assert m["project"]["name"] == "valid_uart"
    assert m["project"]["top"] == "uart_top"
    assert m["project"]["part"] == "xc7a50tfgg484-2"
    assert m["project"]["flow"] == "project"
    assert len(m["sources"]["rtl"]) == 3
    assert m["_meta"]["imported_from_xpr"].endswith("valid_uart.xpr")


def test_write_internal_manifest(tmp_path):
    doc = parse_xpr(FIXTURE_DIR / "valid_uart.xpr")
    m = manifest_from_xpr(doc)
    p = write_internal_manifest(tmp_path, m)
    assert p.exists()
    assert p.parent.name == ".synthia"
    
    loaded = yaml.safe_load(p.read_text())
    assert loaded["project"]["name"] == "valid_uart"
```

---

## 5. 子任务 4：fingerprint sync check

### 5.1 设计

存储 `.xpr` 导入时的 `(mtime, sha256)` 到 `.synthia/.xpr_fingerprint.json`。每次打开项目 / 跑 run 前对比当前 `.xpr` 是否变了。

### 5.2 新建 manifest_sync

**新建** `src/edagent_vivado/projects/manifest_sync.py`：

```python
"""xpr ↔ manifest fingerprint sync check."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, asdict
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
    """Snapshot xpr state and write to .synthia/.xpr_fingerprint.json."""
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
    fp_path.write_text(json.dumps(asdict(fp), indent=2))
    return fp


def check_sync(project_root: str | Path) -> SyncCheckResult:
    """Check whether xpr changed since last import."""
    root = Path(project_root)
    fp_path = root / ".synthia" / ".xpr_fingerprint.json"
    manifest_path = root / ".synthia" / "eda.yaml"

    if not manifest_path.exists():
        return SyncCheckResult(status="manifest_missing", detail=".synthia/eda.yaml not found")

    if not fp_path.exists():
        # 没有 xpr fingerprint → 可能是 scan-imported（无 xpr）
        return SyncCheckResult(status="no_xpr", detail="project has no .xpr fingerprint")

    try:
        data = json.loads(fp_path.read_text())
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
        return SyncCheckResult(status="in_sync", detail="ok", fingerprint=fp, current_xpr_sha256=current_sha)

    return SyncCheckResult(
        status="xpr_modified",
        detail=".xpr modified since last import — consider re-importing",
        fingerprint=fp,
        current_xpr_sha256=current_sha,
    )
```

### 5.3 测试

**新建** `tests/test_manifest_sync.py`：

```python
import time
import shutil
from pathlib import Path
from edagent_vivado.projects.xpr_parser import parse_xpr
from edagent_vivado.projects.manifest_gen import manifest_from_xpr, write_internal_manifest
from edagent_vivado.projects.manifest_sync import write_fingerprint, check_sync


FIXTURE = Path(__file__).parent / "fixtures" / "xpr" / "valid_uart.xpr"


def test_sync_in_sync(tmp_path):
    xpr_copy = tmp_path / "valid_uart.xpr"
    shutil.copy(FIXTURE, xpr_copy)

    doc = parse_xpr(xpr_copy)
    m = manifest_from_xpr(doc)
    write_internal_manifest(tmp_path, m)
    write_fingerprint(tmp_path, xpr_copy)

    result = check_sync(tmp_path)
    assert result.status == "in_sync"


def test_sync_xpr_modified(tmp_path):
    xpr_copy = tmp_path / "valid_uart.xpr"
    shutil.copy(FIXTURE, xpr_copy)
    doc = parse_xpr(xpr_copy)
    m = manifest_from_xpr(doc)
    write_internal_manifest(tmp_path, m)
    write_fingerprint(tmp_path, xpr_copy)

    # 修改 xpr
    time.sleep(0.01)
    xpr_copy.write_text(xpr_copy.read_text() + "\n<!-- modified -->\n")
    
    result = check_sync(tmp_path)
    assert result.status == "xpr_modified"


def test_sync_manifest_missing(tmp_path):
    result = check_sync(tmp_path)
    assert result.status == "manifest_missing"


def test_sync_no_xpr(tmp_path):
    # 创建 manifest 但不写 fingerprint
    (tmp_path / ".synthia").mkdir()
    (tmp_path / ".synthia" / "eda.yaml").write_text("project:\n  name: scan_only\n")
    result = check_sync(tmp_path)
    assert result.status == "no_xpr"
```

---

## 6. 子任务 5：wizard（Vivado-like 创建工程）

### 6.1 设计

Wizard 接收用户提交的字段（name / location / sources / part / top / ...），生成：
1. 项目目录
2. `.synthia/eda.yaml`
3. 可选：调用 Vivado 生成 `.xpr`（Phase 3 只做骨架，真实 `.xpr` 生成留给后续）

### 6.2 新建 wizard

**新建** `src/edagent_vivado/projects/wizard.py`：

```python
"""Vivado-like project creation wizard."""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from edagent_vivado.projects.manifest_gen import write_internal_manifest


ProjectKind = Literal["rtl_project", "post_synth", "empty"]


@dataclass
class WizardInput:
    name: str
    location: str                       # 父目录，工程会放在 location/name/
    kind: ProjectKind = "rtl_project"
    part: str = ""
    board_part: str = ""
    top_module: str = ""
    target_language: str = "verilog"    # verilog | vhdl
    rtl_sources: list[str] = field(default_factory=list)
    xdc_sources: list[str] = field(default_factory=list)
    tb_sources: list[str] = field(default_factory=list)
    ip_sources: list[str] = field(default_factory=list)
    bd_sources: list[str] = field(default_factory=list)
    include_dirs: list[str] = field(default_factory=list)
    copy_sources: bool = True           # 是否复制源文件到工程目录


@dataclass
class WizardResult:
    project_root: Path
    manifest_path: Path
    xpr_path: Path | None = None
    warnings: list[str] = field(default_factory=list)


def create_project(req: WizardInput) -> WizardResult:
    """Create a new Synthia project from wizard input."""
    root = Path(req.location) / req.name
    root.mkdir(parents=True, exist_ok=False)   # 已存在会抛 FileExistsError

    # 1. 复制源文件（如果选了 copy_sources）
    warnings: list[str] = []
    if req.copy_sources:
        rtl_dir = root / "rtl"
        constr_dir = root / "constraints"
        tb_dir = root / "tb"
        ip_dir = root / "ip"
        bd_dir = root / "bd"
        for d in (rtl_dir, constr_dir, tb_dir, ip_dir, bd_dir):
            d.mkdir(exist_ok=True)

        rtl_copies = _copy_files(req.rtl_sources, rtl_dir, warnings)
        xdc_copies = _copy_files(req.xdc_sources, constr_dir, warnings)
        tb_copies = _copy_files(req.tb_sources, tb_dir, warnings)
        ip_copies = _copy_files(req.ip_sources, ip_dir, warnings)
        bd_copies = _copy_files(req.bd_sources, bd_dir, warnings)
    else:
        rtl_copies = req.rtl_sources
        xdc_copies = req.xdc_sources
        tb_copies = req.tb_sources
        ip_copies = req.ip_sources
        bd_copies = req.bd_sources

    # 2. 写 manifest
    manifest = {
        "project": {
            "name": req.name,
            "vivado_version": "2024.1",
            "part": req.part,
            "board_part": req.board_part,
            "top": req.top_module,
            "target_language": req.target_language,
            "flow": "project",
        },
        "sources": {
            "rtl": rtl_copies,
            "tb": tb_copies,
            "include_dirs": req.include_dirs,
        },
        "constraints": {"xdc": xdc_copies},
        "ip": {"xci": ip_copies},
        "bd": {"files": bd_copies},
        "runs": {
            "synth": {"enabled": True},
            "impl": {"enabled": True},
        },
        "_meta": {
            "created_by_wizard": True,
            "wizard_kind": req.kind,
        },
    }
    manifest_path = write_internal_manifest(root, manifest)

    # 3. （可选）调用 Vivado 生成 .xpr —— Phase 3 不做真实调用
    # 这里只占位；Phase 4/5 可以调 connector capability create_vivado_project
    xpr_path = None

    return WizardResult(
        project_root=root,
        manifest_path=manifest_path,
        xpr_path=xpr_path,
        warnings=warnings,
    )


def _copy_files(sources: list[str], dest_dir: Path, warnings: list[str]) -> list[str]:
    """Copy files into dest_dir, return list of new POSIX paths."""
    out: list[str] = []
    for src in sources:
        sp = Path(src)
        if not sp.exists():
            warnings.append(f"source not found, skipped: {src}")
            continue
        dst = dest_dir / sp.name
        try:
            shutil.copy2(sp, dst)
            out.append(str(dst).replace("\\", "/"))
        except Exception as exc:
            warnings.append(f"copy failed for {src}: {exc}")
    return out
```

### 6.3 测试

**新建** `tests/test_wizard.py`：

```python
from pathlib import Path
from edagent_vivado.projects.wizard import WizardInput, create_project


def test_wizard_creates_project(tmp_path):
    src = tmp_path / "my_top.v"
    src.write_text("module my_top; endmodule")

    req = WizardInput(
        name="hello_proj",
        location=str(tmp_path / "workspace"),
        rtl_sources=[str(src)],
        part="xc7a50tfgg484-2",
        top_module="my_top",
    )
    result = create_project(req)
    assert result.project_root.exists()
    assert result.manifest_path.exists()
    assert (result.project_root / "rtl" / "my_top.v").exists()


def test_wizard_fails_if_dir_exists(tmp_path):
    (tmp_path / "exists").mkdir()
    req = WizardInput(name="exists", location=str(tmp_path))
    
    import pytest
    with pytest.raises(FileExistsError):
        create_project(req)
```

---

## 7. 子任务 6：connector capability 接入

### 7.1 替换 Phase 2 的 stub

打开 `src/edagent_vivado/connectors/vivado/connector.py`，找到 Phase 2 加的 stub 实现。

把 `_capability_import_xpr` 改成：

```python
def _capability_import_xpr(self, req: ToolRunRequest) -> ToolRunResult:
    from edagent_vivado.projects.xpr_parser import parse_xpr
    from edagent_vivado.projects.manifest_gen import manifest_from_xpr, write_internal_manifest
    from edagent_vivado.projects.manifest_sync import write_fingerprint
    from edagent_vivado.connectors.base.types import Artifact
    from pathlib import Path

    xpr_path = str(req.inputs.get("xpr_path") or "")
    if not xpr_path:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="xpr_path required",
            edagent_outcome="execution_failed",
        )

    try:
        doc = parse_xpr(xpr_path)
        manifest = manifest_from_xpr(doc)
        # 把 .synthia 写到 .xpr 同目录
        project_root = Path(xpr_path).parent
        manifest_path = write_internal_manifest(project_root, manifest)
        write_fingerprint(project_root, xpr_path)

        return ToolRunResult(
            request_id=req.request_id,
            success=True,
            exit_code=0,
            edagent_outcome="execution_succeeded",
            error="",
            artifacts=[Artifact(
                artifact_id=f"manifest_{doc.name}",
                artifact_type="manifest",
                path=str(manifest_path).replace("\\", "/"),
                mime_type="application/x-yaml",
            )],
        )
    except Exception as exc:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error=f"import_xpr failed: {exc}",
            edagent_outcome="execution_failed",
        )
```

`_capability_scan_project` 改成：

```python
def _capability_scan_project(self, req: ToolRunRequest) -> ToolRunResult:
    from edagent_vivado.projects.scanner import scan_directory

    root_path = str(req.inputs.get("root_path") or "")
    if not root_path:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="root_path required",
            edagent_outcome="execution_failed",
        )

    try:
        result = scan_directory(root_path)
        # 把 ScanResult 序列化到 error 字段（hack: capability 没有 data 字段）
        # Phase 4 RunOrchestrator 引入 metadata 字段后改进
        import json
        return ToolRunResult(
            request_id=req.request_id,
            success=result.is_likely_fpga_project,
            exit_code=0 if result.is_likely_fpga_project else 1,
            edagent_outcome="execution_succeeded" if result.is_likely_fpga_project else "execution_failed",
            error=json.dumps({
                "xpr_files": result.xpr_files,
                "rtl_files": result.rtl_files,
                "sv_files": result.sv_files,
                "vhd_files": result.vhd_files,
                "xdc_files": result.xdc_files,
                "ip_files": result.ip_files,
                "bd_files": result.bd_files,
                "candidate_top_modules": result.candidate_top_modules,
                "detected_part": result.detected_part,
            }),
        )
    except Exception as exc:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error=f"scan failed: {exc}",
            edagent_outcome="execution_failed",
        )
```

`_capability_sync_xpr_manifest` 改成：

```python
def _capability_sync_xpr_manifest(self, req: ToolRunRequest) -> ToolRunResult:
    from edagent_vivado.projects.manifest_sync import check_sync
    import json

    project_root = str(req.inputs.get("project_root") or "")
    if not project_root:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="project_root required",
            edagent_outcome="execution_failed",
        )
    
    sr = check_sync(project_root)
    return ToolRunResult(
        request_id=req.request_id,
        success=sr.status in ("in_sync", "no_xpr"),
        exit_code=0 if sr.status in ("in_sync", "no_xpr") else 1,
        edagent_outcome="execution_succeeded",
        error=json.dumps({"status": sr.status, "detail": sr.detail}),
    )
```

`_capability_create_project` 走 wizard：

```python
def _capability_create_project(self, req: ToolRunRequest) -> ToolRunResult:
    from edagent_vivado.projects.wizard import WizardInput, create_project
    from edagent_vivado.connectors.base.types import Artifact

    try:
        wi = WizardInput(
            name=str(req.inputs.get("name") or ""),
            location=str(req.inputs.get("location") or ""),
            part=str(req.inputs.get("part") or ""),
            top_module=str(req.inputs.get("top_module") or ""),
            rtl_sources=list(req.inputs.get("rtl_sources") or []),
            xdc_sources=list(req.inputs.get("xdc_sources") or []),
        )
        result = create_project(wi)
        return ToolRunResult(
            request_id=req.request_id,
            success=True,
            exit_code=0,
            edagent_outcome="execution_succeeded",
            error="",
            artifacts=[Artifact(
                artifact_id=f"manifest_{wi.name}",
                artifact_type="manifest",
                path=str(result.manifest_path).replace("\\", "/"),
            )],
        )
    except Exception as exc:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error=str(exc),
            edagent_outcome="execution_failed",
        )
```

---

## 8. 子任务 7：projects API

### 8.1 schemas 扩充

打开 `src/edagent_vivado/web/schemas/projects.py`，新增：

```python
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
    status: str       # ok | xpr_modified | xpr_missing | manifest_missing | no_xpr
    detail: str
    last_check_at: int


class ScanResponse(BaseModel):
    root: str
    is_likely_fpga_project: bool
    xpr_files: list[str]
    rtl_files: list[str]
    xdc_files: list[str]
    ip_files: list[str]
    bd_files: list[str]
    candidate_top_modules: list[str]
    detected_part: str
```

### 8.2 路由扩充

打开 `src/edagent_vivado/web/routes/projects.py`，追加：

```python
from edagent_vivado.web.schemas.projects import (
    ImportXprReq, ScanProjectReq, WizardCreateReq,
    ProjectHealthResponse, ScanResponse,
)


@router.post("/projects/import-xpr", response_model=dict)
async def api_project_import_xpr(req: ImportXprReq):
    from edagent_vivado.connectors import ensure_connectors
    from edagent_vivado.agent.run_capability import run_connector_capability
    from edagent_vivado.repository.store import project_create
    from edagent_vivado.projects.xpr_parser import parse_xpr
    from pathlib import Path
    import json

    ensure_connectors()
    # 1. 跑 import_xpr capability
    out = run_connector_capability(
        "vivado", "import_xpr",
        inputs={"xpr_path": req.xpr_path},
    )
    try:
        data = json.loads(out)
    except Exception:
        raise HTTPException(500, f"import failed: {out}")
    if not data.get("success"):
        raise HTTPException(400, data.get("error", "import failed"))

    # 2. 注册到 DB
    if not req.auto_register:
        return data

    doc = parse_xpr(req.xpr_path)
    manifest_path = data["artifacts"][0]["path"] if data.get("artifacts") else ""
    proj = project_create(
        name=doc.name,
        root_path=str(Path(req.xpr_path).parent),
        manifest_path=manifest_path,
        xpr_path=req.xpr_path,
        part=doc.part,
        board_part=doc.board_part,
        top_module=doc.top_module,
    )
    return {"project_id": proj["id"], "manifest_path": manifest_path, "summary": data}


@router.post("/projects/scan", response_model=ScanResponse)
async def api_project_scan(req: ScanProjectReq):
    from edagent_vivado.connectors import ensure_connectors
    from edagent_vivado.agent.run_capability import run_connector_capability
    import json

    ensure_connectors()
    out = run_connector_capability(
        "vivado", "scan_project",
        inputs={"root_path": req.root_path},
    )
    try:
        data = json.loads(out)
        scan_data = json.loads(data.get("error") or "{}")
    except Exception:
        raise HTTPException(500, f"scan failed: {out}")

    return ScanResponse(
        root=req.root_path,
        is_likely_fpga_project=bool(scan_data.get("rtl_files") or scan_data.get("xpr_files")),
        **scan_data,
    )


@router.post("/projects/from-wizard")
async def api_project_from_wizard(req: WizardCreateReq):
    from edagent_vivado.connectors import ensure_connectors
    from edagent_vivado.agent.run_capability import run_connector_capability
    from edagent_vivado.repository.store import project_create
    import json
    from pathlib import Path

    ensure_connectors()
    out = run_connector_capability(
        "vivado", "create_vivado_project",
        inputs=req.model_dump(),
    )
    try:
        data = json.loads(out)
    except Exception:
        raise HTTPException(500, f"create failed: {out}")
    if not data.get("success"):
        raise HTTPException(400, data.get("error", "create failed"))

    manifest_path = data["artifacts"][0]["path"]
    project_root = str(Path(req.location) / req.name)
    proj = project_create(
        name=req.name,
        root_path=project_root,
        manifest_path=manifest_path,
        part=req.part,
        top_module=req.top_module,
    )
    return {"project_id": proj["id"], "manifest_path": manifest_path}


@router.get("/projects/{project_id}/health", response_model=ProjectHealthResponse)
async def api_project_health(project_id: str):
    from edagent_vivado.repository.store import project_get
    from edagent_vivado.projects.manifest_sync import check_sync
    import time

    proj = project_get(project_id)
    if not proj:
        raise HTTPException(404, "project not found")
    sr = check_sync(proj["root_path"])
    return ProjectHealthResponse(
        project_id=project_id,
        status=sr.status,
        detail=sr.detail,
        last_check_at=int(time.time()),
    )


@router.post("/projects/{project_id}/sync-xpr")
async def api_project_sync_xpr(project_id: str):
    """Re-import xpr to refresh manifest + fingerprint."""
    from edagent_vivado.repository.store import project_get
    
    proj = project_get(project_id)
    if not proj:
        raise HTTPException(404, "project not found")
    if not proj.get("xpr_path"):
        raise HTTPException(400, "project has no .xpr")
    
    return await api_project_import_xpr(ImportXprReq(xpr_path=proj["xpr_path"], auto_register=False))
```

### 8.3 验证

```bash
edagent web --port 8484 &

# 1. import-xpr smoke
curl -X POST -H "Authorization: Bearer test123" \
  -H "Content-Type: application/json" \
  -d '{"xpr_path":"tests/fixtures/xpr/valid_uart.xpr"}' \
  http://127.0.0.1:8484/api/v1/projects/import-xpr

# 2. scan smoke
curl -X POST -H "Authorization: Bearer test123" \
  -H "Content-Type: application/json" \
  -d '{"root_path":"examples/uart_demo"}' \
  http://127.0.0.1:8484/api/v1/projects/scan

# 3. health
curl -H "Authorization: Bearer test123" \
  http://127.0.0.1:8484/api/v1/projects/<id>/health
```

---

## 9. 子任务 8：fixtures + 测试

### 9.1 集成测试

**新建** `tests/test_phase3_integration.py`：

```python
from pathlib import Path
import shutil
import json
from fastapi.testclient import TestClient

# 注意：test client 在 conftest.py 里已设好；此处假设有一个 `client` fixture


def test_import_xpr_endpoint(client, tmp_path):
    # 准备 fixture 副本
    src = Path("tests/fixtures/xpr/valid_uart.xpr")
    dst_dir = tmp_path / "uart_demo"
    dst_dir.mkdir()
    dst = dst_dir / "valid_uart.xpr"
    shutil.copy(src, dst)
    # 复制对应 RTL 文件
    rtl_dir = dst_dir / "rtl"
    rtl_dir.mkdir()
    for fn in ("uart_top.v", "uart_tx.v", "uart_rx.v"):
        (rtl_dir / fn).write_text(f"module {fn[:-2]}; endmodule\n")

    resp = client.post(
        "/api/v1/projects/import-xpr",
        json={"xpr_path": str(dst)},
        headers={"Authorization": "Bearer test"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "project_id" in data
    assert Path(data["manifest_path"]).exists()


def test_scan_endpoint(client):
    resp = client.post(
        "/api/v1/projects/scan",
        json={"root_path": "examples/uart_demo"},
        headers={"Authorization": "Bearer test"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["is_likely_fpga_project"]
```

### 9.2 跑测试

```bash
python -m pytest tests/test_xpr_parser.py tests/test_scanner.py \
  tests/test_manifest_gen.py tests/test_manifest_sync.py \
  tests/test_wizard.py tests/test_phase3_integration.py -v
```

期望全绿。

---

## 10. 子任务 9：前端 Project 导入页

### 10.1 新建路由与页面

在 `frontend/src/pages/` 加 `ProjectImportPage.tsx`：

```tsx
import { useState } from 'react'
import { apiFetch } from '../api/client'
import { StatusPill } from '../components/common/StatusPill'

export default function ProjectImportPage() {
  const [mode, setMode] = useState<'xpr' | 'scan' | 'wizard'>('xpr')
  return (
    <div className="syn-page">
      <h1>Import / Create Project</h1>
      <div className="syn-tabs">
        <button onClick={() => setMode('xpr')} className={mode === 'xpr' ? 'active' : ''}>Import .xpr</button>
        <button onClick={() => setMode('scan')} className={mode === 'scan' ? 'active' : ''}>Scan Directory</button>
        <button onClick={() => setMode('wizard')} className={mode === 'wizard' ? 'active' : ''}>New Wizard</button>
      </div>
      {mode === 'xpr' && <ImportXprForm />}
      {mode === 'scan' && <ScanForm />}
      {mode === 'wizard' && <WizardForm />}
    </div>
  )
}


function ImportXprForm() {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<any>(null)

  const submit = async () => {
    setBusy(true)
    try {
      const resp = await apiFetch('/api/v1/projects/import-xpr', {
        method: 'POST',
        body: JSON.stringify({ xpr_path: path }),
      })
      setResult(await resp.json())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="syn-form">
      <label>.xpr path</label>
      <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:/projects/uart/uart.xpr" />
      <button onClick={submit} disabled={busy || !path} className="syn-btn syn-btn-primary">
        {busy ? 'Importing…' : 'Import'}
      </button>
      {result && <pre className="syn-result mono">{JSON.stringify(result, null, 2)}</pre>}
    </div>
  )
}


function ScanForm() {
  const [root, setRoot] = useState('')
  const [scanResult, setScanResult] = useState<any>(null)

  const submit = async () => {
    const resp = await apiFetch('/api/v1/projects/scan', {
      method: 'POST',
      body: JSON.stringify({ root_path: root }),
    })
    setScanResult(await resp.json())
  }

  return (
    <div className="syn-form">
      <label>Directory to scan</label>
      <input value={root} onChange={(e) => setRoot(e.target.value)} />
      <button onClick={submit} className="syn-btn syn-btn-primary">Scan</button>
      {scanResult && (
        <div className="syn-scan-result">
          <h3>Detected</h3>
          <ul>
            <li>{scanResult.xpr_files?.length || 0} .xpr files</li>
            <li>{scanResult.rtl_files?.length || 0} RTL files</li>
            <li>{scanResult.xdc_files?.length || 0} XDC files</li>
            <li>Top candidates: {scanResult.candidate_top_modules?.join(', ')}</li>
            <li>Detected part: {scanResult.detected_part || '—'}</li>
          </ul>
        </div>
      )}
    </div>
  )
}


function WizardForm() {
  // 简化版：name/location/part/top/rtl_sources 几个字段
  return <div>Wizard form (Phase 3.10) — TODO</div>
}
```

### 10.2 在 router 注册

打开 `frontend/src/app/router.tsx`，加：

```typescript
import ProjectImportPage from '../pages/ProjectImportPage'

// 在路由表里加：
{ path: '/projects/import', element: <ProjectImportPage /> },
```

在左侧导航加入口（`AppShell.tsx` 的 nav 数组里）。

### 10.3 验证

```bash
cd frontend && npm run dev
# 浏览器打开 http://127.0.0.1:5173/projects/import
# 选 Import .xpr，输入 tests/fixtures/xpr/valid_uart.xpr 测试
```

---

## 11. 收尾

### 11.1 完整测试

```bash
python -m pytest -k "not agent_smoke" -q --tb=line
# 期望: 0 failed
```

### 11.2 文档

更新 `README.md` 加一节：

```markdown
### 导入 Vivado 工程

**方式 1：导入已有 .xpr**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"xpr_path":"/path/to/proj.xpr"}' \
  http://127.0.0.1:8484/api/v1/projects/import-xpr
```

或 Web UI: `/projects/import` → Import .xpr。

**方式 2：扫描目录**

`POST /api/v1/projects/scan` with `{root_path}`，然后 `POST /projects/from-wizard` 确认。
```

更新 `futureWork.md`：

```markdown
### 6.1 ~~.xpr 双向同步~~ ← v1.1 仍待
（v1.0 单向已 Phase 3 完成）

### 6.2 ~~IP / BD 深度~~ ← v2.0 仍待  
（v1.0 仅识别路径，Phase 3 完成）
```

### 11.3 commit

```bash
git add -A
git commit -m "Phase 3: xpr-first project layer

- projects/xpr_parser.py: XML parser with file classification
- projects/scanner.py: directory scan with top-module heuristic
- projects/manifest_gen.py: xpr → eda.yaml conversion
- projects/manifest_sync.py: fingerprint-based sync check
- projects/wizard.py: Vivado-like project creation
- Vivado connector capabilities: import_xpr, scan_project, create, sync
- POST /projects/import-xpr, /scan, /from-wizard, /sync-xpr, GET /health
- Frontend ProjectImportPage with 3 import modes
- 5 test fixtures (.xpr files for valid/missing-part/has-ip/has-bd)
"
```

### 11.4 完成标志

- [ ] 6 个新模块文件存在并可 import
- [ ] 5 个新 capability 实现非 stub
- [ ] 5 个新 API 端点可用
- [ ] 至少 30 个新单元测试通过
- [ ] `pytest` 全绿
- [ ] 前端 Project Import 页可用

---

## 附录 A：常见坑

### A.1 Windows xpr 路径
Vivado on Windows 的 xpr 用 `\`，parse 时统一转 `/`。我们的 `parse_xpr` 已做。

### A.2 Vivado .xpr 不是规范 XML
极少数版本会有非标准注释。`ET.parse` 抛 `ParseError` 时给用户友好提示，让其在 Vivado 里"Save as"重存一次。

### A.3 大项目扫描慢
`scanner.scan_directory` 的 `max_files=10000` 是软上限。FPGA 工程通常 < 1000 文件，但 IP 生成物会暴增到几万。已通过 `_DEFAULT_EXCLUDE` 跳过 `vivado.cache` 等。

### A.4 `.synthia` 目录权限
默认在 `.xpr` 同目录下创建。如果用户的 xpr 放在只读位置（NFS、共享盘），会失败。Phase 3 不强解决，可加配置 `synthia_data_dir` 让用户指定备选位置。

### A.5 top_module 推测错误
当用户工程含多个 module 时，启发式可能选错。前端必须让用户在 Wizard 阶段**确认或修改** `top_module`。

---

## 附录 B：耗时估算

| 子任务 | 估时 |
|--------|------|
| 1. xpr parser | 2d |
| 2. scanner | 1d |
| 3. manifest_gen | 0.5d |
| 4. fingerprint sync | 1d |
| 5. wizard | 1.5d |
| 6. connector 接入 | 1d |
| 7. API 端点 | 1d |
| 8. fixtures + 测试 | 2d |
| 9. 前端 import 页 | 2d |
| 10. 文档 + cleanup | 0.5d |

**总计：** 全职 12-14 天；vibe coding 3 周。

---

## 附录 C：与 Phase 4 衔接

Phase 3 完成后，用户可以从前端导入工程。Phase 4 会做 RunOrchestrator —— 但**Phase 4 不依赖 Phase 3**，可并行做。它们的交集是：项目导入后，第一次 run 之前可触发 sync check。
