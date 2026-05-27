"""Run a BenchmarkSuite — Phase 10."""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from edagent_vivado.benchmarks.metric_extractor import classify_error, extract_metrics, is_success
from edagent_vivado.benchmarks.models import CaseState, SuiteConfig, SuiteState
from edagent_vivado.benchmarks.suite_store import case_update, suite_get, suite_update
from edagent_vivado.repository.store import project_get, run_get
from edagent_vivado.runs.orchestrator import cancel_run, create_run, start_run
from edagent_vivado.runs.state_machine import is_terminal

logger = logging.getLogger(__name__)


def execute_suite(suite_id: str, *, session_id: str = "") -> dict[str, Any]:
    suite = suite_get(suite_id)
    if not suite:
        raise ValueError(f"suite not found: {suite_id}")

    config_dict = suite.get("config", {})
    cfg = SuiteConfig(
        **{k: v for k, v in config_dict.items() if k in SuiteConfig.__dataclass_fields__}
    )

    cases = suite["cases"]
    if not cases:
        suite_update(suite_id, state=SuiteState.COMPLETED.value, completed_at=_now_ms())
        return suite_get(suite_id) or {}

    suite_update(suite_id, state=SuiteState.RUNNING.value, started_at=_now_ms())

    completed = 0
    failed = 0
    project_id = str(suite.get("project_id") or "")

    for case in cases:
        current = suite_get(suite_id) or {}
        if current.get("state") == SuiteState.CANCELLED.value:
            case_update(
                case["id"],
                state=CaseState.CANCELLED.value,
                error="suite cancelled",
                completed_at=_now_ms(),
            )
            continue

        if case["state"] in (
            CaseState.SUCCESS.value,
            CaseState.FAILED.value,
            CaseState.SKIPPED.value,
            CaseState.CANCELLED.value,
        ):
            if case["state"] == CaseState.SUCCESS.value:
                completed += 1
            elif case["state"] == CaseState.FAILED.value:
                failed += 1
            continue

        if cfg.abort_on_n_failures > 0 and failed >= cfg.abort_on_n_failures:
            case_update(
                case["id"],
                state=CaseState.SKIPPED.value,
                error=f"aborted after {failed} failures",
                completed_at=_now_ms(),
            )
            continue

        case_id = case["id"]
        case_update(case_id, state=CaseState.RUNNING.value, started_at=_now_ms())
        t0 = _now_ms()

        try:
            inputs = _resolve_case_inputs(case, project_id)
            run_id = _create_run_for_case(
                case,
                inputs=inputs,
                session_id=session_id,
            )
            case_update(case_id, run_id=run_id)
            _wait_for_run(run_id, timeout_s=cfg.timeout_per_case_s)

            run = run_get(run_id) or {}
            metrics = extract_metrics(run_id)
            success = is_success(run, metrics, case.get("expected") or {})
            started = int(run.get("started_at") or t0)
            finished = int(run.get("completed_at") or _now_ms())
            elapsed_ms = max(0, finished - started)

            if success:
                metrics["success"] = True
                case_update(
                    case_id,
                    state=CaseState.SUCCESS.value,
                    metrics=metrics,
                    elapsed_ms=elapsed_ms,
                    completed_at=_now_ms(),
                )
                completed += 1
            else:
                metrics["success"] = False
                category = classify_error(run, metrics)
                case_update(
                    case_id,
                    state=CaseState.FAILED.value,
                    metrics=metrics,
                    error_category=category,
                    error=run.get("error", "") or run.get("error_message", "") or f"category: {category}",
                    elapsed_ms=elapsed_ms,
                    completed_at=_now_ms(),
                )
                failed += 1
                if not cfg.continue_on_failure:
                    break
        except Exception as exc:
            logger.exception("case %s failed unexpectedly", case_id)
            case_update(
                case_id,
                state=CaseState.FAILED.value,
                error=str(exc),
                error_category="executor_error",
                completed_at=_now_ms(),
            )
            failed += 1
            if not cfg.continue_on_failure:
                break

    final_state = SuiteState.COMPLETED.value
    if failed > 0 and completed > 0:
        final_state = SuiteState.PARTIAL.value

    suite_update(
        suite_id,
        state=final_state,
        completed_cases=completed,
        failed_cases=failed,
        completed_at=_now_ms(),
    )
    return suite_get(suite_id) or {}


def execute_suite_async(suite_id: str, *, session_id: str = "") -> threading.Thread:
    def _run() -> None:
        try:
            execute_suite(suite_id, session_id=session_id)
        except Exception:
            logger.exception("suite %s execution crashed", suite_id)
            suite_update(suite_id, state=SuiteState.PARTIAL.value, completed_at=_now_ms())

    t = threading.Thread(target=_run, daemon=True, name=f"bench-{suite_id[:8]}")
    t.start()
    return t


def _resolve_case_inputs(case: dict, project_id: str) -> dict[str, Any]:
    inputs = dict(case.get("inputs") or {})
    proj = project_get(project_id) or {}
    if not inputs.get("manifest_path"):
        inputs["manifest_path"] = proj.get("manifest_path") or ""
    return inputs


def _create_run_for_case(
    case: dict,
    *,
    inputs: dict[str, Any],
    session_id: str = "",
) -> str:
    flow_name = case["flow_name"]
    run_id = create_run(
        flow_name=flow_name,
        session_id=session_id,
        task_id="",
        inputs=inputs,
    )
    start_run(
        run_id,
        flow_name=flow_name,
        inputs=inputs,
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
    try:
        cancel_run(run_id)
    except Exception:
        pass


def _now_ms() -> int:
    return int(time.time() * 1000)
