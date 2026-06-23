from __future__ import annotations

import importlib

from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


def _store(tmp_path, monkeypatch):
    db_mod.close_db()
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "turns.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "runtime"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def _session(store):
    project = store.project_create({
        "name": "Transcript Test",
        "root_path": ".",
        "manifest_path": "eda.yaml",
        "xpr_path": "",
    })
    session = store.session_create(project_id=project["id"], name="Transcript")
    return project, session


def test_turn_projection_user_assistant_stream(tmp_path, monkeypatch):
    store = _store(tmp_path, monkeypatch)
    _project, session = _session(store)
    msg = store.message_create(session["id"], "user", "hello")
    task = store.task_create(session["id"], msg["id"])
    store.message_update(msg["id"], task_id=task["id"])

    store.event_create(
        session["id"],
        "message.user.created",
        {"message_id": msg["id"], "text": "hello", "task_id": task["id"]},
        task_id=task["id"],
    )
    store.event_create(session["id"], "task.started", {"task_id": task["id"]}, task_id=task["id"])
    store.event_create(
        session["id"],
        "assistant.stream.opened",
        {"stream_id": "s0"},
        task_id=task["id"],
    )
    store.event_create(
        session["id"],
        "message.assistant.delta",
        {"stream_id": "s0", "text": "Hel"},
        task_id=task["id"],
    )
    store.event_create(
        session["id"],
        "message.assistant.delta",
        {"stream_id": "s0", "text": "lo"},
        task_id=task["id"],
    )
    store.event_create(
        session["id"],
        "assistant.stream.completed",
        {"stream_id": "s0"},
        task_id=task["id"],
    )
    store.event_create(
        session["id"],
        "message.assistant.completed",
        {"stream_id": "s0"},
        task_id=task["id"],
    )
    store.event_create(session["id"], "task.done", {"task_id": task["id"]}, task_id=task["id"])

    transcript = store.transcript_get(session["id"])

    assert len(transcript["turns"]) == 1
    turn = transcript["turns"][0]
    assert turn["task_id"] == task["id"]
    assert turn["status"] == "done"
    assert [item["item_type"] for item in turn["items"]] == ["user", "assistant_text"]
    assert turn["items"][1]["payload"]["text"] == "Hello"
    assert turn["items"][1]["status"] == "completed"


def test_turn_projection_tool_completed_only_and_interaction_lifecycle(tmp_path, monkeypatch):
    store = _store(tmp_path, monkeypatch)
    _project, session = _session(store)
    msg = store.message_create(session["id"], "user", "run vivado")
    task = store.task_create(session["id"], msg["id"])
    store.message_update(msg["id"], task_id=task["id"])

    store.event_create(
        session["id"],
        "message.user.created",
        {"message_id": msg["id"], "text": "run vivado", "task_id": task["id"]},
        task_id=task["id"],
    )
    store.event_create(
        session["id"],
        "interaction.requested",
        {"id": "ia1", "interaction_type": "approval", "title": "Run Vivado"},
        task_id=task["id"],
    )
    store.event_create(
        session["id"],
        "interaction.approved",
        {"id": "ia1", "response": {"approved": True}},
        task_id=task["id"],
    )
    store.event_create(
        session["id"],
        "tool.completed",
        {
            "toolcall_id": "tc1",
            "tool_name": "run_vivado_synth_tool",
            "state": "rejected",
            "result": '{"edagent_outcome":"user_rejected"}',
        },
        task_id=task["id"],
    )

    items = store.transcript_get(session["id"])["turns"][0]["items"]
    interaction = next(item for item in items if item["item_type"] == "interaction")
    tool = next(item for item in items if item["item_type"] == "tool")

    assert interaction["status"] == "approved"
    assert interaction["payload"]["response"] == {"approved": True}
    assert tool["item_key"] == "tool:tc1"
    assert tool["status"] == "rejected"
    assert tool["payload"]["tool_name"] == "run_vivado_synth_tool"


def test_turn_projection_error_and_projection_failure_preserves_event(tmp_path, monkeypatch):
    store = _store(tmp_path, monkeypatch)
    _project, session = _session(store)
    msg = store.message_create(session["id"], "user", "fail")
    task = store.task_create(session["id"], msg["id"])
    store.message_update(msg["id"], task_id=task["id"])
    store.event_create(
        session["id"],
        "message.user.created",
        {"message_id": msg["id"], "text": "fail", "task_id": task["id"]},
        task_id=task["id"],
    )
    store.event_create(session["id"], "run.error", {"error": "boom"}, task_id=task["id"], run_id="r1")

    turn = store.transcript_get(session["id"])["turns"][0]
    assert turn["status"] == "error"
    assert any(item["item_type"] == "error" and item["payload"]["message"] == "boom" for item in turn["items"])

    def explode(_evt):
        raise RuntimeError("projection failed")

    monkeypatch.setattr(store, "transcript_apply_event", explode)
    evt = store.event_create(session["id"], "custom.debug", {"ok": True}, task_id=task["id"])

    assert evt["event_type"] == "custom.debug"
    assert any(row["id"] == evt["id"] for row in store.event_list(session["id"], after_seq=0))


def test_turn_rebuild_attaches_legacy_user_event_by_task_user_message_id(tmp_path, monkeypatch):
    store = _store(tmp_path, monkeypatch)
    _project, session = _session(store)
    msg = store.message_create(session["id"], "user", "legacy")
    task = store.task_create(session["id"], msg["id"])
    original_projection = store.transcript_apply_event

    def explode(_evt):
        raise RuntimeError("skip projection")

    monkeypatch.setattr(store, "transcript_apply_event", explode)
    store.event_create(
        session["id"],
        "message.user.created",
        {"message_id": msg["id"], "text": "legacy"},
    )
    store.event_create(
        session["id"],
        "tool.completed",
        {"toolcall_id": "tc1", "tool_name": "grep_tool", "result": "ok"},
        task_id=task["id"],
    )
    monkeypatch.setattr(store, "transcript_apply_event", original_projection)

    transcript = store.transcript_get(session["id"], rebuild=True)

    assert len(transcript["turns"]) == 1
    turn = transcript["turns"][0]
    assert turn["task_id"] == task["id"]
    assert [item["item_type"] for item in turn["items"]] == ["user", "tool"]


def test_turn_projection_prunes_non_explicit_empty_assistant_stream(tmp_path, monkeypatch):
    store = _store(tmp_path, monkeypatch)
    _project, session = _session(store)
    msg = store.message_create(session["id"], "user", "tool only")
    task = store.task_create(session["id"], msg["id"])
    store.message_update(msg["id"], task_id=task["id"])

    store.event_create(
        session["id"],
        "message.user.created",
        {"message_id": msg["id"], "text": "tool only", "task_id": task["id"]},
        task_id=task["id"],
    )
    store.event_create(session["id"], "assistant.stream.opened", {"stream_id": "s-empty"}, task_id=task["id"])
    store.event_create(session["id"], "assistant.stream.completed", {"stream_id": "s-empty"}, task_id=task["id"])
    explicit = store.event_create(
        session["id"],
        "message.assistant.completed",
        {"stream_id": "s-explicit", "empty": True},
        task_id=task["id"],
    )

    transcript = store.transcript_get(session["id"])
    items = transcript["turns"][0]["items"]

    assert transcript["last_event_seq"] == explicit["seq"]
    assert [item["item_key"] for item in items] == ["user:" + msg["id"], "assistant:s-explicit"]
    assert items[1]["payload"]["empty_turn"] is True
