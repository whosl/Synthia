"""Tests for assistant stream ID manager."""

from edagent_vivado.harness.assistant_stream import AssistantStreamManager


def test_rotate_after_tool():
    mgr = AssistantStreamManager("task-abc")
    assert mgr.current_stream_id == "task-abc-s0"
    mgr.append_delta("hello ")
    closed, new = mgr.rotate_after_tool()
    assert closed == "task-abc-s0"
    assert new == "task-abc-s1"
    assert mgr.text_for(closed) == "hello "
    mgr.append_delta("world")
    assert mgr.text_for(new) == "world"
