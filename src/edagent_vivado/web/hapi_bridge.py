"""HAPI-compatible API bridge — serves the HAPI frontend backed by EdAgent."""

from __future__ import annotations
import json, os as _os, time, uuid, asyncio, threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse, Response

router = APIRouter()

SESSION_STORE: dict[str, dict] = {}
MESSAGE_STORE: dict[str, list[dict]] = {}
SSE_SUBSCRIBERS: dict[str, asyncio.Queue] = {}
SEQ_COUNTERS: dict[str, int] = {}

def _now_ms() -> int: return int(time.time() * 1000)
def _new_id() -> str: return uuid.uuid4().hex[:12]
def _fake_token() -> str: return "edagent-token-" + _new_id()

def _broadcast(event: dict) -> None:
    for q in list(SSE_SUBSCRIBERS.values()):
        try: q.put_nowait(event)
        except asyncio.QueueFull: pass

# -- Auth --
@router.post("/api/auth")
async def auth(body: dict) -> dict:
    return {"token": _fake_token(), "user": {"id": 1, "username": "edagent", "firstName": "EDA", "lastName": "Agent"}}

# -- Sessions --
@router.get("/api/sessions")
async def list_sessions() -> dict:
    now = _now_ms()
    sessions = []
    for sid, s in SESSION_STORE.items():
        sessions.append({"id": sid, "active": s.get("active", True), "thinking": s.get("thinking", False),
            "activeAt": s.get("activeAt", now), "updatedAt": s.get("updatedAt", now),
            "metadata": s.get("metadata"), "todoProgress": None, "pendingRequestsCount": 0,
            "model": _os.environ.get("EDAGENT_MODEL", "claude-sonnet-4-20250514"), "effort": None})
    return {"sessions": sessions}

@router.post("/api/sessions")
async def create_session(body: dict | None = None) -> dict:
    sid = _new_id(); now = _now_ms()
    name = (body or {}).get("name", "EdAgent Session")
    SESSION_STORE[sid] = {"id": sid, "namespace": "default", "seq": 0, "createdAt": now,
        "updatedAt": now, "active": True, "activeAt": now,
        "metadata": {"path": str(Path.cwd()), "host": "localhost", "name": name, "os": "windows", "version": "0.2.0"},
        "metadataVersion": 1, "agentState": None, "agentStateVersion": 0, "thinking": False, "thinkingAt": 0,
        "permissionMode": "default",
        "model": _os.environ.get("EDAGENT_MODEL", "claude-sonnet-4-20250514"),
        "modelReasoningEffort": None, "effort": None}
    MESSAGE_STORE[sid] = []; SEQ_COUNTERS[sid] = 0
    _broadcast({"type": "session-added", "sessionId": sid})
    return {"session": SESSION_STORE[sid]}

@router.get("/api/sessions/{session_id}")
async def get_session(session_id: str) -> dict:
    if session_id not in SESSION_STORE: raise HTTPException(status_code=404)
    return {"session": SESSION_STORE[session_id]}

@router.patch("/api/sessions/{session_id}")
async def rename_session(session_id: str, body: dict) -> dict:
    s = SESSION_STORE.get(session_id)
    if not s: raise HTTPException(status_code=404)
    if "name" in body and s.get("metadata"): s["metadata"]["name"] = body["name"]
    s["updatedAt"] = _now_ms()
    return {"session": s}

@router.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> Response:
    SESSION_STORE.pop(session_id, None); MESSAGE_STORE.pop(session_id, None); SEQ_COUNTERS.pop(session_id, None)
    _broadcast({"type": "session-removed", "sessionId": session_id})
    return Response(status_code=204)

# -- Messages --
@router.get("/api/sessions/{session_id}/messages")
async def get_messages(session_id: str, beforeSeq: Optional[int] = Query(None),
    beforeAt: Optional[int] = Query(None), byPosition: int = Query(0), limit: int = Query(50)) -> dict:
    messages = MESSAGE_STORE.get(session_id, [])
    if beforeAt is not None or beforeSeq is not None:
        cutoff = beforeAt or beforeSeq or 0
        messages = [m for m in messages if m.get("createdAt", 0) < cutoff]
    messages = messages[-limit:]
    return {"messages": messages, "page": {"limit": limit, "beforeSeq": beforeSeq,
        "nextBeforeSeq": messages[0]["seq"] if messages else None,
        "nextBeforeAt": messages[0]["createdAt"] if messages else None, "hasMore": False}}

@router.post("/api/sessions/{session_id}/messages")
async def send_message(session_id: str, body: dict, req: Request) -> Response:
    text = body.get("text", ""); local_id = body.get("localId")
    if not text: return Response(status_code=204)
    if session_id not in SESSION_STORE:
        await create_session({"name": f"Chat {session_id[:8]}"})
    s = SESSION_STORE.get(session_id)
    if not s: raise HTTPException(status_code=404)
    s["thinking"] = True; s["thinkingAt"] = _now_ms(); s["updatedAt"] = _now_ms()
    seq = SEQ_COUNTERS.get(session_id, 0) + 1; SEQ_COUNTERS[session_id] = seq
    user_msg = {"id": _new_id(), "seq": seq, "localId": local_id,
        "content": {"role": "user", "content": [{"type": "text", "text": text}]},
        "createdAt": _now_ms(), "status": "sent"}
    MESSAGE_STORE.setdefault(session_id, []).append(user_msg)
    _broadcast({"type": "message-received", "sessionId": session_id, "message": user_msg})
    _broadcast({"type": "session-updated", "sessionId": session_id})
    threading.Thread(target=_agent_worker, args=(session_id, text), daemon=True).start()
    return Response(status_code=202)

@router.post("/api/sessions/{session_id}/abort")
async def abort_session(session_id: str) -> Response:
    s = SESSION_STORE.get(session_id)
    if s: s["thinking"] = False; s["updatedAt"] = _now_ms(); _broadcast({"type": "session-updated", "sessionId": session_id})
    return Response(status_code=204)

# -- SSE Events --
@router.get("/api/machines")
async def list_machines() -> dict:
    return {"machines": []}

@router.get("/api/events")
async def events(req: Request, token: str = Query(""), sessionId: str = Query(""),
    visibility: str = Query("visible"), all: str = Query("false")):
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    SSE_SUBSCRIBERS[token] = queue
    async def _stream():
        try:
            yield _sse_raw({"type": "heartbeat", "data": {"timestamp": _now_ms()}})
            for sid in SESSION_STORE:
                yield _sse_raw({"type": "session-added", "sessionId": sid})
            while True:
                if await req.is_disconnected(): break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                    yield _sse_raw(event)
                except asyncio.TimeoutError:
                    yield _sse_raw({"type": "heartbeat", "data": {"timestamp": _now_ms()}})
        except asyncio.CancelledError: pass
        finally: SSE_SUBSCRIBERS.pop(token, None)
    return StreamingResponse(_stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})

# -- Agent worker --
def _agent_worker(session_id: str, question: str) -> None:
    from edagent_vivado.agent.graph import create_agent
    from langchain_core.messages import HumanMessage

    async def _run():
        agent = create_agent(); config = {"configurable": {"thread_id": session_id}, "recursion_limit": 1000}
        assistant_msg_id = _new_id(); assistant_parts = []; text_buffer = ""
        pending_tools: dict[str, dict] = {}
        async for event in agent.astream_events({"messages": [HumanMessage(content=question)]}, config=config, version="v2"):
            kind = event["event"]
            if kind == "on_tool_start":
                tool_data = {"name": event["name"], "args": event["data"].get("input", {}), "id": _new_id(), "startTime": _now_ms()}
                pending_tools[event.get("run_id", _new_id())] = tool_data
                if text_buffer.strip(): assistant_parts.append({"type": "text", "text": text_buffer.strip()}); text_buffer = ""
                assistant_parts.append({"type": "tool-call", "toolCallId": tool_data["id"], "toolName": event["name"], "args": tool_data["args"]})
                _push_partial(session_id, assistant_msg_id, list(assistant_parts)); _update_session(session_id, True)
            elif kind == "on_tool_end":
                run_id = event.get("run_id", "")
                if run_id in pending_tools:
                    tool_info = pending_tools.pop(run_id)
                    for p in assistant_parts:
                        if p.get("toolCallId") == tool_info["id"]: p["result"] = str(event["data"].get("output", ""))[:5000]; break
                _push_partial(session_id, assistant_msg_id, list(assistant_parts))
            elif kind == "on_chat_model_stream":
                chunk = event["data"].get("chunk", {})
                if hasattr(chunk, "content") and chunk.content:
                    content = chunk.content
                    if isinstance(content, str) and content:
                        if hasattr(chunk, "tool_calls") and chunk.tool_calls: continue
                        if hasattr(chunk, "additional_kwargs") and chunk.additional_kwargs:
                            reasoning = chunk.additional_kwargs.get("reasoning_content") or ""
                            if reasoning:
                                existing = [p for p in assistant_parts if p.get("type") == "reasoning"]
                                if existing: existing[0]["text"] = existing[0].get("text","") + reasoning
                                else: assistant_parts.append({"type": "reasoning", "text": reasoning})
                                _push_partial(session_id, assistant_msg_id, list(assistant_parts))
                                continue
                        text_buffer += content
        if text_buffer.strip(): assistant_parts.append({"type": "text", "text": text_buffer.strip()})
        seq = SEQ_COUNTERS.get(session_id, 0) + 1; SEQ_COUNTERS[session_id] = seq
        final_msg = {"id": assistant_msg_id, "seq": seq, "localId": None,
            "content": {"role": "assistant", "content": assistant_parts,
            "meta": {"model": _os.environ.get("EDAGENT_MODEL", "")}},
            "createdAt": _now_ms(), "status": "sent"}
        MESSAGE_STORE.setdefault(session_id, []).append(final_msg)
        _broadcast({"type": "message-received", "sessionId": session_id, "message": final_msg})

    try:
        asyncio.run(_run())
    except Exception as e:
        error_msg = {"id": _new_id(), "seq": SEQ_COUNTERS.get(session_id, 0) + 1, "localId": None,
            "content": {"role": "assistant", "content": [{"type": "text", "text": f"Error: {e}"}]},
            "createdAt": _now_ms(), "status": "failed"}
        MESSAGE_STORE.setdefault(session_id, []).append(error_msg)
        _broadcast({"type": "message-received", "sessionId": session_id, "message": error_msg})
    finally:
        _update_session(session_id, False)

def _push_partial(session_id: str, msg_id: str, parts: list[dict]) -> None:
    msg = {"id": msg_id, "seq": None, "localId": None, "content": {"role": "assistant", "content": parts},
        "createdAt": _now_ms(), "status": "sent"}
    _broadcast({"type": "message-received", "sessionId": session_id, "message": msg})

def _update_session(session_id: str, thinking: bool) -> None:
    s = SESSION_STORE.get(session_id)
    if s: s["thinking"] = thinking; s["thinkingAt"] = _now_ms() if thinking else s.get("thinkingAt", 0); s["updatedAt"] = _now_ms(); _broadcast({"type": "session-updated", "sessionId": session_id})

def _sse_raw(data: dict) -> str:
    payload = json.dumps(data, ensure_ascii=False, default=str)
    return f"data: {payload}\n\n"
