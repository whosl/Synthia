"""Compose a holistic implementation-stage summary from per-report data."""

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
    bitstream_data: dict | None = None,
    stage: str = "impl",
) -> ParsedReport:
    """Combine timing/util/drc/log/bitstream sub-reports into a single summary report."""
    summary: dict[str, Any] = {
        "stage": stage,
        "ok": True,
        "issues": [],
    }

    if timing_data:
        wns = timing_data.get("wns")
        whs = timing_data.get("whs")
        summary["timing"] = {
            "wns_ns": wns,
            "tns_ns": timing_data.get("tns"),
            "whs_ns": whs,
            "ths_ns": timing_data.get("ths"),
            "met_setup": _coerce_met(timing_data, "met_setup", wns),
            "met_hold": _coerce_met(timing_data, "met_hold", whs),
            "violated_paths": int(timing_data.get("violated_path_count") or 0),
        }
        if isinstance(wns, (int, float)) and wns < 0:
            summary["ok"] = False
            summary["issues"].append({
                "severity": "high",
                "category": "timing",
                "message": f"Setup violated: WNS = {wns:.3f} ns",
            })
        if isinstance(whs, (int, float)) and whs < 0:
            summary["ok"] = False
            summary["issues"].append({
                "severity": "high",
                "category": "timing",
                "message": f"Hold violated: WHS = {whs:.3f} ns",
            })

    if util_data:
        summary["utilization"] = {
            "lut_pct": util_data.get("lut_pct"),
            "ff_pct": util_data.get("ff_pct"),
            "bram_pct": util_data.get("bram_pct"),
            "dsp_pct": util_data.get("dsp_pct"),
            "uram_pct": util_data.get("uram_pct"),
        }
        for label in ("lut_pct", "ff_pct", "bram_pct", "dsp_pct", "uram_pct"):
            pct = util_data.get(label)
            if not isinstance(pct, (int, float)):
                continue
            if pct > 95:
                summary["issues"].append({
                    "severity": "high",
                    "category": "utilization",
                    "message": f"{label} = {pct:.1f}% (>95%)",
                })
            elif pct > 85:
                summary["issues"].append({
                    "severity": "medium",
                    "category": "utilization",
                    "message": f"{label} = {pct:.1f}% (>85%)",
                })

    if drc_data:
        errors = drc_data.get("errors") or []
        warnings = drc_data.get("warnings") or []
        summary["drc"] = {
            "clean": bool(drc_data.get("clean")),
            "error_count": len(errors),
            "warning_count": len(warnings),
            "by_category": dict(drc_data.get("by_category") or {}),
        }
        if errors:
            summary["ok"] = False
            summary["issues"].append({
                "severity": "high",
                "category": "drc",
                "message": f"{len(errors)} DRC errors",
            })

    if methodology_data:
        summary["methodology"] = {
            "count": int(methodology_data.get("count") or 0),
            "by_severity": dict(methodology_data.get("by_severity") or {}),
        }
        crits = methodology_data.get("by_severity", {}).get("critical warning", 0)
        if crits:
            summary["issues"].append({
                "severity": "medium",
                "category": "methodology",
                "message": f"{crits} critical methodology warnings",
            })

    if log_data:
        errors = int(log_data.get("error_count") or 0)
        critw = int(log_data.get("critical_warning_count") or 0)
        summary["log"] = {
            "error_count": errors,
            "critical_warning_count": critw,
        }
        if errors > 0:
            summary["ok"] = False

    if bitstream_data:
        summary["bitstream"] = {
            "found": bool(bitstream_data.get("found")),
            "count": int(bitstream_data.get("count") or 0),
            "primary_bit": str(bitstream_data.get("primary_bit") or ""),
        }

    return ParsedReport(type="impl_summary", tool="vivado", stage=stage, data=summary)


def _coerce_met(data: dict, key: str, slack: Any) -> bool:
    raw = data.get(key)
    if isinstance(raw, bool):
        return raw
    if isinstance(slack, (int, float)):
        return slack >= 0
    return True
