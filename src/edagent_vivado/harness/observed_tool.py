"""ObservedToolRunner — unified tool lifecycle, events, and problem collection."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from edagent_vivado.harness.approval_outcomes import (
    SCOPE_VIVADO_SYNTH,
    format_user_rejection,
    tool_ui_state_from_output,
)
from edagent_vivado.harness.vivado_agent_registry import vivado_tool_spec
from edagent_vivado.harness.problem_collector import collect_from_tool_output, record_problems
from edagent_vivado.harness.kb_candidate_policy import maybe_create_kb_candidate
from edagent_vivado.repository.store import toolcall_create, toolcall_get, toolcall_update


EventSink = Callable[..., Any]


@dataclass
class ObservedToolRunner:
    session_id: str
    task_id: str
    run_id: str
    event_sink: EventSink
    tool_ids: dict[str, str] = field(default_factory=dict)
    _start_perf: dict[str, float] = field(default_factory=dict, repr=False)

    def _mark_tool_start(self, tcid: str) -> tuple[int, int]:
        """Wall-clock ms for UI + perf_counter for precise elapsed_ms."""
        self._start_perf[tcid] = time.perf_counter()
        return int(time.time() * 1000)

    def _elapsed_ms(self, tcid: str, started_at_sec: int, finished_at_sec: int) -> int:
        t0 = self._start_perf.pop(tcid, None)
        if t0 is not None:
            return max(1, int((time.perf_counter() - t0) * 1000))
        return max(1, int((finished_at_sec - started_at_sec) * 1000))

    def on_tool_rejected(
        self,
        langgraph_run_id: str,
        tool_name: str,
        tool_input: dict[str, Any],
        *,
        blocked_scope: str | None = None,
    ) -> str:
        """Record a user-rejected Vivado tool without emitting tool.started (no running UI)."""
        args_str = json.dumps(tool_input, ensure_ascii=False, default=str)[:1500]
        tc = toolcall_create(
            run_id=self.run_id,
            tool_name=tool_name,
            session_id=self.session_id,
            task_id=self.task_id,
            input_summary=args_str,
        )
        tcid = tc["id"]
        key = str(langgraph_run_id or tcid)
        self.tool_ids[key] = tcid
        spec = vivado_tool_spec(tool_name)
        scope = blocked_scope or (spec.scope if spec else SCOPE_VIVADO_SYNTH)
        output = format_user_rejection(scope, tool_name=tool_name)
        ui_state = tool_ui_state_from_output(output)
        finished_at = int(time.time())
        started_at = int(tc.get("started_at") or finished_at)
        elapsed_ms = self._elapsed_ms(tcid, started_at, finished_at)
        toolcall_update(
            tcid,
            state="rejected",
            finished_at=finished_at,
            elapsed_ms=elapsed_ms,
            output_summary=output[:500],
        )
        self.event_sink(
            self.session_id,
            "tool.completed",
            {
                "tool_name": tool_name,
                "toolcall_id": tcid,
                "result": output[:500],
                "state": ui_state,
                "started_at": started_at,
                "elapsed_ms": elapsed_ms,
            },
            task_id=self.task_id,
            run_id=self.run_id,
        )
        return tcid

    def on_tool_start(self, langgraph_run_id: str, tool_name: str, tool_input: dict[str, Any]) -> str:
        args_str = json.dumps(tool_input, ensure_ascii=False, default=str)[:1500]
        tc = toolcall_create(
            run_id=self.run_id,
            tool_name=tool_name,
            session_id=self.session_id,
            task_id=self.task_id,
            input_summary=args_str,
        )
        key = str(langgraph_run_id or tc["id"])
        self.tool_ids[key] = tc["id"]
        started_at = int(tc.get("started_at") or time.time())
        started_at_ms = self._mark_tool_start(tc["id"])
        self.event_sink(
            self.session_id,
            "tool.started",
            {
                "tool_name": tool_name,
                "toolcall_id": tc["id"],
                "args": args_str,
                "started_at": started_at,
                "started_at_ms": started_at_ms,
            },
            task_id=self.task_id,
            run_id=self.run_id,
        )
        return tc["id"]

    def on_tool_end(
        self,
        langgraph_run_id: str,
        tool_name: str,
        output: str,
        *,
        blocked: bool = False,
        blocked_scope: str | None = None,
    ) -> str:
        tcid = self.tool_ids.get(str(langgraph_run_id), "")
        if blocked:
            spec = vivado_tool_spec(tool_name)
            scope = blocked_scope or (spec.scope if spec else SCOPE_VIVADO_SYNTH)
            output = format_user_rejection(scope, tool_name=tool_name)

        ui_state = tool_ui_state_from_output(output)
        finished_at = int(time.time())
        elapsed_ms: int | None = None
        started_at: int | None = None
        if tcid:
            row = toolcall_get(tcid) or {}
            started_at = int(row.get("started_at") or finished_at)
            elapsed_ms = self._elapsed_ms(tcid, started_at, finished_at)
            db_state = ui_state if ui_state in ("error", "rejected") else "completed"
            toolcall_update(
                tcid,
                state=db_state,
                finished_at=finished_at,
                elapsed_ms=elapsed_ms,
                output_summary=output[:500],
            )
        self.event_sink(
            self.session_id,
            "tool.completed",
            {
                "tool_name": tool_name,
                "toolcall_id": tcid,
                "result": output[:500],
                "state": ui_state,
                "started_at": started_at,
                "elapsed_ms": elapsed_ms,
            },
            task_id=self.task_id,
            run_id=self.run_id,
        )

        if output and ui_state == "completed" and tool_name in (
            "run_vivado_synth_tool",
            "run_vivado_impl_tool",
            "run_vivado_flow_tool",
        ):
            try:
                from edagent_vivado.connectors.vivado.persist import persist_from_tool_output

                persist_from_tool_output(
                    self.session_id,
                    self.task_id,
                    self.run_id,
                    tool_name,
                    output,
                    self.event_sink,
                )
            except Exception:
                pass

        if output and ui_state in ("completed", "error", "rejected"):
            probs = collect_from_tool_output(tool_name, output)
            if probs:
                saved = record_problems(
                    self.session_id,
                    probs,
                    task_id=self.task_id,
                    run_id=self.run_id,
                    event_sink=lambda et, pl: self.event_sink(
                        self.session_id, et, pl, task_id=self.task_id, run_id=self.run_id
                    ),
                )
                for p in saved:
                    if p.get("severity") in ("error", "critical"):
                        cand = maybe_create_kb_candidate(p)
                        if cand:
                            self.event_sink(
                                self.session_id,
                                "kb.candidate.created",
                                {"candidate_id": cand["id"], "problem_id": p.get("id"), "pattern": cand.get("pattern")},
                                task_id=self.task_id,
                                run_id=self.run_id,
                            )
        return output
