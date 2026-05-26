"""Vivado .xpr (XML) parser — Phase 3."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class XprFile:
    path: str
    abs_path: str = ""
    file_type: str = "unknown"


@dataclass
class XprFileSet:
    name: str
    type_: str
    files: list[XprFile] = field(default_factory=list)


@dataclass
class XprDocument:
    xpr_path: str
    project_dir: str
    name: str
    part: str = ""
    board_part: str = ""
    top_module: str = ""
    target_language: str = ""
    vivado_version: str = ""
    filesets: list[XprFileSet] = field(default_factory=list)
    raw_options: dict[str, str] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

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


def _expand_path(raw: str, project_dir: str) -> str:
    p = raw.replace("$PPRDIR", project_dir).replace("$PRUNDIR", project_dir + "/runs")
    return str(Path(p)).replace("\\", "/")


def parse_xpr(xpr_path: str | Path) -> XprDocument:
    """Parse a Vivado .xpr file into a structured document."""
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

    version = root.attrib.get("Version", "")
    minor = root.attrib.get("Minor", "")
    if version:
        doc.vivado_version = f"{version}.{minor}" if minor else version

    for opt in root.iter("Option"):
        name = opt.attrib.get("Name", "")
        val = opt.attrib.get("Val", "")
        if not name:
            continue
        doc.raw_options[name] = val
        if name == "Part":
            doc.part = val
        elif name == "BoardPart":
            doc.board_part = val
        elif name == "TopModule":
            doc.top_module = val
        elif name == "TargetLanguage":
            doc.target_language = val

    for fs_node in root.iter("FileSet"):
        fs = XprFileSet(
            name=fs_node.attrib.get("Name", ""),
            type_=fs_node.attrib.get("Type", ""),
        )
        for f_node in fs_node.iter("File"):
            raw = f_node.attrib.get("Path", "")
            if not raw:
                continue
            fs.files.append(
                XprFile(
                    path=raw,
                    abs_path=_expand_path(raw, project_dir),
                    file_type=_classify_file(raw),
                )
            )
        doc.filesets.append(fs)

    if not doc.part:
        doc.warnings.append("part not declared in xpr")
    if not doc.top_module:
        doc.warnings.append("top_module not declared in xpr")
    if not doc.rtl_files:
        doc.warnings.append("no RTL files found")

    return doc
