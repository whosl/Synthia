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
from edagent_vivado.repository.store import toolcall_create, toolcall_update


EventSink = Callable[..., Any]


@dataclass
class ObservedToolRunner:
    session_id: str
    task_id: str
    run_id: str
    event_sink: EventSink
    tool_ids: dict[str, str] = field(default_factory=dict)

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
        self.event_sink(
            self.session_id,
            "tool.started",
            {"tool_name": tool_name, "toolcall_id": tc["id"], "args": args_str},
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
        if tcid:
            toolcall_update(
                tcid,
                state="completed" if ui_state != "error" else "error",
                finished_at=int(time.time()),
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
            },
            task_id=self.task_id,
            run_id=self.run_id,
        )

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
