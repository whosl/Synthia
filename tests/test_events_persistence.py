from edagent_vivado.repository.db import get_db
from edagent_vivado.repository.store import event_create, events_after_seq


def _clear_session(sid: str) -> None:
    db = get_db()
    db.execute("DELETE FROM events WHERE session_id = ?", (sid,))
    db.commit()


def test_event_seq_monotonic():
    sid = "test_session_phase4"
    _clear_session(sid)

    e1 = event_create(sid, "test.a", {"v": 1})
    e2 = event_create(sid, "test.b", {"v": 2})
    e3 = event_create(sid, "test.c", {"v": 3})

    assert e1["seq"] == 1
    assert e2["seq"] == 2
    assert e3["seq"] == 3


def test_events_after_seq():
    sid = "test_session_phase4_after"
    _clear_session(sid)

    for i in range(5):
        event_create(sid, f"test.{i}", {"i": i})

    rest = events_after_seq(sid, after_seq=2)
    assert len(rest) == 3
    assert [e["seq"] for e in rest] == [3, 4, 5]
