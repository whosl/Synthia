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

    def to_dict(self) -> dict:
        return {
            "root": self.root,
            "is_likely_fpga_project": self.is_likely_fpga_project,
            "xpr_files": self.xpr_files,
            "rtl_files": self.rtl_files,
            "sv_files": self.sv_files,
            "vhd_files": self.vhd_files,
            "xdc_files": self.xdc_files,
            "ip_files": self.ip_files,
            "bd_files": self.bd_files,
            "tcl_files": self.tcl_files,
            "mem_files": self.mem_files,
            "candidate_top_modules": self.candidate_top_modules,
            "detected_part": self.detected_part,
        }


_DEFAULT_EXCLUDE = {
    ".git",
    "node_modules",
    "__pycache__",
    ".synthia",
    ".edagent",
    "build",
    "dist",
    "runs",
    ".vscode",
    ".idea",
    "vivado.cache",
    "vivado.hw",
    "vivado.sim",
    ".Xil",
    "vivado.ip_user_files",
}


def scan_directory(
    root: str | Path,
    max_files: int = 10_000,
    exclude_dirs: set[str] | None = None,
) -> ScanResult:
    excl = (exclude_dirs or set()) | _DEFAULT_EXCLUDE
    root_p = Path(root).resolve()
    if not root_p.exists() or not root_p.is_dir():
        return ScanResult(root=str(root_p).replace("\\", "/"))

    result = ScanResult(root=str(root_p).replace("\\", "/"))
    count = 0

    for p in root_p.rglob("*"):
        if count >= max_files:
            break
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

    result.candidate_top_modules = guess_top_modules(result.rtl_files + result.sv_files)
    if result.xdc_files:
        result.detected_part = _detect_part_from_xdc(result.xdc_files[0])
    return result


_MODULE_RE = re.compile(r"^\s*module\s+(\w+)", re.MULTILINE)


def guess_top_modules(files: list[str], top_n: int = 5) -> list[str]:
    counter: dict[str, int] = {}
    for fp in files:
        try:
            text = Path(fp).read_text(encoding="utf-8", errors="replace")
            for m in _MODULE_RE.finditer(text):
                name = m.group(1)
                counter[name] = counter.get(name, 0) + 1
        except OSError:
            continue

    def score(name: str) -> tuple[int, int]:
        priority = 1 if any(k in name.lower() for k in ("top", "main", "wrapper")) else 0
        return (priority, counter[name])

    return sorted(counter.keys(), key=score, reverse=True)[:top_n]


def _detect_part_from_xdc(xdc_path: str) -> str:
    try:
        text = Path(xdc_path).read_text(encoding="utf-8", errors="replace")
        m = re.search(r"#\s*Part:?\s*(\S+)", text, re.IGNORECASE)
        if m:
            return m.group(1)
        m = re.search(r"#.*for\s+(xc[0-9a-z\-]+)", text, re.IGNORECASE)
        if m:
            return m.group(1)
    except OSError:
        pass
    return ""
