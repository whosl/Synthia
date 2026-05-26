"""Render a Markdown summary of a completed Run."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from edagent_vivado.repository.store import parsed_report_list, run_get


def _fmt_ns(value: Any) -> str:
    if value is None:
        return "—"
    try:
        return f"{float(value):.3f} ns"
    except (TypeError, ValueError):
        return str(value)


def _fmt_pct(value: Any) -> str:
    if value is None:
        return "—"
    try:
        return f"{float(value):.2f}%"
    except (TypeError, ValueError):
        return str(value)


def render_run_summary(run_id: str) -> str:
    run = run_get(run_id)
    if not run:
        return f"# Run {run_id}\n\nRun not found."

    reports = parsed_report_list(run_id=run_id)

    lines: list[str] = [
        f"# Run Summary: {run.get('name') or run_id}",
        "",
        f"- **Run ID:** `{run_id}`",
        f"- **State:** {run.get('state', '?')}",
        f"- **Type:** {run.get('run_type', '?')}",
        f"- **Session:** `{run.get('session_id') or '—'}`",
        f"- **Started:** {run.get('started_at')}",
        f"- **Finished:** {run.get('finished_at')}",
        f"- **Elapsed (ms):** {run.get('elapsed_ms')}",
        "",
    ]

    if run.get("error"):
        lines += [f"> **Error:** {run['error']}", ""]

    grouped: dict[str, list[dict]] = {}
    for r in reports:
        grouped.setdefault(str(r.get("report_type") or ""), []).append(r)

    for kind in ("impl_summary", "timing_summary", "utilization", "drc", "methodology", "bitstream"):
        items = grouped.get(kind) or []
        for r in items:
            lines += _render_report(kind, r)

    other = [k for k in grouped if k not in {
        "impl_summary", "timing_summary", "utilization",
        "drc", "methodology", "bitstream",
    }]
    for kind in other:
        for r in grouped[kind]:
            lines += _render_report(kind, r)

    return "\n".join(lines).rstrip() + "\n"


def _render_report(kind: str, report: dict) -> list[str]:
    metrics = report.get("metrics") or {}
    data = report.get("data") or {}
    stage = report.get("stage") or ""
    out = [f"## {kind} ({stage})" if stage else f"## {kind}"]

    if kind == "impl_summary":
        ok = data.get("ok", metrics.get("ok"))
        out.append(f"- Overall OK: **{'YES' if ok else 'NO'}**")
        issues = data.get("issues") or []
        if issues:
            out.append("- Issues:")
            for issue in issues[:8]:
                sev = issue.get("severity", "info")
                cat = issue.get("category", "")
                msg = issue.get("message", "")
                out.append(f"  - [{sev}/{cat}] {msg}")
    elif kind == "timing_summary":
        out.append(f"- WNS: {_fmt_ns(data.get('wns'))}")
        out.append(f"- TNS: {_fmt_ns(data.get('tns'))}")
        out.append(f"- WHS: {_fmt_ns(data.get('whs'))}")
        out.append(f"- THS: {_fmt_ns(data.get('ths'))}")
        paths = data.get("critical_paths") or []
        if paths:
            out.append("- Top critical paths:")
            for p in paths[:5]:
                slack = p.get("slack_ns")
                src = p.get("source", "?")
                dst = p.get("destination", "?")
                out.append(f"  - `{src}` → `{dst}` slack {_fmt_ns(slack)}")
    elif kind == "utilization":
        out.append(f"- LUT: {_fmt_pct(data.get('lut_pct'))} (used {data.get('lut') or 0})")
        out.append(f"- FF: {_fmt_pct(data.get('ff_pct'))} (used {data.get('ff') or 0})")
        out.append(f"- BRAM: {_fmt_pct(data.get('bram_pct'))} (used {data.get('bram') or 0})")
        out.append(f"- DSP: {_fmt_pct(data.get('dsp_pct'))} (used {data.get('dsp') or 0})")
    elif kind == "drc":
        errors = data.get("errors") or []
        warnings = data.get("warnings") or []
        out.append(f"- Errors: {len(errors)}")
        out.append(f"- Warnings: {len(warnings)}")
        by_cat = data.get("by_category") or {}
        if by_cat:
            cats = ", ".join(f"{k}={v}" for k, v in by_cat.items())
            out.append(f"- By category: {cats}")
    elif kind == "methodology":
        out.append(f"- Findings: {data.get('count') or 0}")
        sev = data.get("by_severity") or {}
        if sev:
            out.append("- By severity: " + ", ".join(f"{k}={v}" for k, v in sev.items() if v))
    elif kind == "bitstream":
        out.append(f"- Bitstream found: **{'YES' if data.get('found') else 'NO'}**")
        primary = data.get("primary_bit")
        if primary:
            out.append(f"- Primary `.bit`: `{primary}`")
        files = data.get("files") or []
        if files:
            out.append(f"- Files: {len(files)}")
    else:
        out.append("```json")
        import json

        out.append(json.dumps(data, indent=2, default=str)[:2000])
        out.append("```")

    out.append("")
    return out


def write_summary_md(run_id: str, *, target_dir: str | Path | None = None) -> str:
    md = render_run_summary(run_id)
    if target_dir is None:
        try:
            from edagent_vivado.harness.run_workspace import ensure_run_workspace

            ws = ensure_run_workspace(run_id)
            root = Path(ws.root)
        except Exception:
            root = Path(".synthia") / "runs" / run_id
            root.mkdir(parents=True, exist_ok=True)
    else:
        root = Path(target_dir)
        root.mkdir(parents=True, exist_ok=True)
    target = root / "summary.md"
    target.write_text(md, encoding="utf-8")
    return str(target.resolve())
