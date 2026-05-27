"""Export benchmark suite results — Phase 10."""

from __future__ import annotations

import csv
import io
import json
import zipfile
from pathlib import Path
from typing import Any

from edagent_vivado.benchmarks.suite_store import suite_get
from edagent_vivado.repository.store import artifact_list

_CSV_COLS = [
    "case_name",
    "state",
    "flow_name",
    "WNS",
    "TNS",
    "WHS",
    "THS",
    "LUT",
    "FF",
    "BRAM",
    "DSP",
    "IO",
    "BUFG",
    "bitstream_exists",
    "bitstream_size_bytes",
    "drc_critical",
    "drc_error",
    "methodology_violations",
    "error_category",
    "error",
    "elapsed_ms",
    "run_id",
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
        w.writerow(
            [
                case.get("name", ""),
                case.get("state", ""),
                case.get("flow_name", ""),
                m.get("WNS"),
                m.get("TNS"),
                m.get("WHS"),
                m.get("THS"),
                m.get("LUT"),
                m.get("FF"),
                m.get("BRAM"),
                m.get("DSP"),
                m.get("IO"),
                m.get("BUFG"),
                m.get("bitstream_exists"),
                m.get("bitstream_size_bytes"),
                m.get("drc_critical"),
                m.get("drc_error"),
                m.get("methodology_violations"),
                case.get("error_category", ""),
                (case.get("error", "") or "").replace("\n", " ")[:200],
                case.get("elapsed_ms", 0),
                case.get("run_id", ""),
            ]
        )
    return buf.getvalue()


def export_markdown(suite_id: str) -> str:
    suite = suite_get(suite_id)
    if not suite:
        raise ValueError(f"suite not found: {suite_id}")

    lines: list[str] = []
    lines.append(f"# Benchmark Suite: {suite['name']}")
    lines.append("")
    lines.append(f"- **State:** {suite['state']}")
    lines.append(
        f"- **Total:** {suite['total_cases']}  ·  "
        f"**Success:** {suite['completed_cases']}  ·  "
        f"**Failed:** {suite['failed_cases']}"
    )
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
        icon = "✅" if case["state"] == "success" else ("❌" if case["state"] == "failed" else "—")
        lines.append(
            "| {seq} | {name} | {icon} {state} | {wns} | {lut} | {ff} | {bram} | {dsp} | {bit} | {t} |".format(
                seq=case.get("sequence", "?"),
                name=case.get("name", ""),
                icon=icon,
                state=case.get("state", ""),
                wns=_fmt(m.get("WNS")),
                lut=_fmt(m.get("LUT")),
                ff=_fmt(m.get("FF")),
                bram=_fmt(m.get("BRAM")),
                dsp=_fmt(m.get("DSP")),
                bit="✓" if m.get("bitstream_exists") else "✗",
                t=f"{(case.get('elapsed_ms') or 0) / 1000:.1f}s",
            )
        )

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
            for a in artifact_list(run_id=run_id):
                src = Path(a.get("path", ""))
                if not src.is_file():
                    continue
                name_lower = src.name.lower()
                if not any(name_lower.endswith(ext) for ext in (".bit", ".rpt", ".log", ".dcp")):
                    continue
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
