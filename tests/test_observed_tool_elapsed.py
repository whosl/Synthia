"""Tool elapsed_ms uses perf_counter, not second-rounded timestamps."""

from __future__ import annotations

import time

from edagent_vivado.harness.observed_tool import ObservedToolRunner


def test_observed_tool_elapsed_subsecond():
    events: list[tuple[str, dict]] = []

    def sink(_sid, etype, payload, **kwargs):
        events.append((etype, payload))

    runner = ObservedToolRunner("s1", "t1", "r1", sink)
    tcid = runner.on_tool_start("lg-1", "read_file_tool", {"path": "x"})
    time.sleep(0.05)
    runner.on_tool_end("lg-1", "read_file_tool", "ok")

    completed = [p for et, p in events if et == "tool.completed"]
    assert completed
    assert completed[0]["toolcall_id"] == tcid
    assert completed[0]["elapsed_ms"] >= 40
