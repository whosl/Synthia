"""Phase 5.5(a) — per-session run scheduler."""

from __future__ import annotations

import threading
import time

import pytest

from edagent_vivado.runs.scheduler import (
    SessionBusy,
    _reset_locks_for_tests,
    is_session_busy,
    run_in_session,
    start_run_async,
)


@pytest.fixture(autouse=True)
def _isolate_scheduler():
    _reset_locks_for_tests()
    yield
    _reset_locks_for_tests()


def test_serial_within_same_session():
    """Two tasks on the same session must execute strictly serially."""
    order: list[str] = []
    t1_ready = threading.Event()

    def task_a():
        order.append("a_start")
        t1_ready.set()
        time.sleep(0.05)
        order.append("a_end")

    def task_b():
        order.append("b_start")
        time.sleep(0.01)
        order.append("b_end")

    t1 = threading.Thread(target=lambda: run_in_session("s1", task_a))
    t2 = threading.Thread(target=lambda: run_in_session("s1", task_b))
    t1.start()
    t1_ready.wait(timeout=1)
    t2.start()
    t1.join(timeout=2)
    t2.join(timeout=2)

    assert order == ["a_start", "a_end", "b_start", "b_end"]


def test_different_sessions_run_in_parallel():
    """Tasks on distinct sessions must not block one another."""
    a_started = threading.Event()
    a_unblock = threading.Event()

    def task_block_a():
        a_started.set()
        a_unblock.wait(timeout=2)

    b_completed = threading.Event()

    def task_b():
        b_completed.set()

    t1 = threading.Thread(target=lambda: run_in_session("s_a", task_block_a))
    t1.start()
    a_started.wait(timeout=1)

    t2 = threading.Thread(target=lambda: run_in_session("s_b", task_b))
    t2.start()

    assert b_completed.wait(timeout=1), "s_b was blocked by s_a unexpectedly"
    a_unblock.set()
    t1.join(timeout=2)
    t2.join(timeout=2)


def test_is_session_busy_reflects_lock_state():
    assert not is_session_busy("nope")

    started = threading.Event()
    finish = threading.Event()

    def task():
        started.set()
        finish.wait(timeout=2)

    t = threading.Thread(target=lambda: run_in_session("s_busy", task))
    t.start()
    started.wait(timeout=1)

    assert is_session_busy("s_busy")
    finish.set()
    t.join(timeout=2)
    assert not is_session_busy("s_busy")


def test_no_session_id_means_no_serialization():
    counter = [0]

    def task():
        counter[0] += 1

    run_in_session("", task)
    run_in_session("", task)
    assert counter[0] == 2


def test_timeout_raises_session_busy():
    started = threading.Event()
    finish = threading.Event()

    def task():
        started.set()
        finish.wait(timeout=2)

    t = threading.Thread(target=lambda: run_in_session("s_to", task))
    t.start()
    started.wait(timeout=1)

    with pytest.raises(SessionBusy):
        run_in_session("s_to", lambda: None, timeout=0)

    finish.set()
    t.join(timeout=2)


def test_start_run_async_serialises_in_background():
    order: list[str] = []
    second_done = threading.Event()

    def first():
        order.append("first_start")
        time.sleep(0.05)
        order.append("first_end")

    def second():
        order.append("second_start")
        order.append("second_end")
        second_done.set()

    start_run_async("s_async", first)
    time.sleep(0.005)  # ensure first acquired
    start_run_async("s_async", second)

    assert second_done.wait(timeout=2), "second task never executed"
    assert order == ["first_start", "first_end", "second_start", "second_end"]
