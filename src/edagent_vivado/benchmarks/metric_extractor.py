"""Extract benchmark metrics from a completed Run — Phase 10."""

from __future__ import annotations

import json
from typing import Any

from edagent_vivado.repository.store import artifact_list, parsed_report_list


def extract_metrics(run_id: str) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "success": False,
        "WNS": None,
        "TNS": None,
        "WHS": None,
        "THS": None,
        "LUT": None,
        "FF": None,
        "BRAM": None,
        "DSP": None,
        "IO": None,
        "BUFG": None,
        "bitstream_exists": False,
        "bitstream_size_bytes": 0,
        "drc_critical": 0,
        "drc_error": 0,
        "methodology_violations": 0,
        "error_category": "",
    }

    for r in parsed_report_list(run_id=run_id):
        rtype = (r.get("report_type") or "").lower()
        data = r.get("data") or {}
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except json.JSONDecodeError:
                data = {}
        rmetrics = r.get("metrics") or {}
        if isinstance(rmetrics, str):
            try:
                rmetrics = json.loads(rmetrics)
            except json.JSONDecodeError:
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
            metrics["methodology_violations"] = data.get(
                "violation_count", rmetrics.get("violation_count", 0)
            )
        elif rtype == "bitstream":
            metrics["bitstream_exists"] = bool(data.get("exists", rmetrics.get("exists", False)))
            metrics["bitstream_size_bytes"] = data.get("size_bytes", rmetrics.get("size_bytes", 0))

    if not metrics["bitstream_exists"]:
        for a in artifact_list(run_id=run_id):
            p = (a.get("path") or "").lower()
            if p.endswith(".bit"):
                metrics["bitstream_exists"] = True
                metrics["bitstream_size_bytes"] = a.get("size_bytes", 0) or 0
                break

    return metrics


def classify_error(run: dict, metrics: dict) -> str:
    state = run.get("state", "")
    if state in ("succeeded", "succeeded_with_warnings"):
        return ""
    if metrics.get("drc_critical", 0) > 0 or metrics.get("drc_error", 0) > 0:
        return "drc_error"
    wns = metrics.get("WNS")
    if wns is not None:
        try:
            if float(wns) < 0:
                return "timing_violation"
        except (TypeError, ValueError):
            pass
    if state == "cancelled":
        return "cancelled"
    if state == "policy_denied":
        return "policy_denied"
    err = (run.get("error") or run.get("error_message") or "").lower()
    if "synth" in err:
        return "synth_error"
    if "impl" in err or "place" in err or "route" in err:
        return "impl_error"
    if "license" in err:
        return "license_error"
    return "unknown_error"


def is_success(run: dict, metrics: dict, expected: dict) -> bool:
    if run.get("state") not in ("succeeded", "succeeded_with_warnings"):
        return False
    if expected.get("WNS_min") is not None:
        wns = metrics.get("WNS")
        if wns is None or float(wns) < float(expected["WNS_min"]):
            return False
    if expected.get("require_bitstream") and not metrics.get("bitstream_exists"):
        return False
    if expected.get("max_LUT") is not None:
        lut = metrics.get("LUT")
        if lut is None or int(lut) > int(expected["max_LUT"]):
            return False
    return True
