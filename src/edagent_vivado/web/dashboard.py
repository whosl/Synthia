"""Dashboard routes for the EdAgent-Vivado web UI."""

from __future__ import annotations

import json
import os as _os
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

router = APIRouter()


class ChatRequest(BaseModel):
    question: str
    manifest_path: str = ""
    thread_id: str = "web"


class ChatResponse(BaseModel):
    answer: str
    thread_id: str


# ── API routes ──────────────────────────────────────────────

@router.get("/api/health")
async def health() -> dict:
    return {
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "anthropic_api_key": "set" if _os.environ.get("ANTHROPIC_API_KEY") else "MISSING",
        "anthropic_base_url": _os.environ.get("ANTHROPIC_BASE_URL", "default"),
        "model": _os.environ.get("EDAGENT_MODEL", "claude-sonnet-4-20250514"),
        "langsmith": _os.environ.get("LANGSMITH_TRACING", "false"),
    }


@router.get("/api/runs")
async def list_runs(
    limit: int = Query(50, ge=1, le=500),
    status: Optional[str] = Query(None, pattern="^(success|failed|all)$"),
) -> list[dict]:
    runs: list[dict] = []
    root = Path(_os.environ.get("EDAGENT_RUNS_ROOT", "."))
    runs_dir = root / "runs" if (root / "runs").exists() else root
    if not runs_dir.exists():
        return []
    for run_dir in sorted(runs_dir.iterdir(), reverse=True):
        if not run_dir.is_dir():
            continue
        info = _scan_run(run_dir)
        if info:
            if status and status != "all" and info.get("status") != status:
                continue
            runs.append(info)
            if len(runs) >= limit:
                break
    return runs


@router.get("/api/runs/{run_id}")
async def get_run(run_id: str) -> dict:
    root = Path(_os.environ.get("EDAGENT_RUNS_ROOT", "."))
    runs_dir = root / "runs" if (root / "runs").exists() else root
    run_path = runs_dir / run_id
    if not run_path.exists():
        raise HTTPException(status_code=404, detail="Run not found")
    info = _scan_run(run_path)
    if not info:
        raise HTTPException(status_code=404, detail="Invalid run")
    return info


@router.get("/api/runs/{run_id}/log")
async def get_run_log(run_id: str, log_type: str = Query("vivado")) -> str:
    root = Path(_os.environ.get("EDAGENT_RUNS_ROOT", "."))
    runs_dir = root / "runs" if (root / "runs").exists() else root
    run_path = runs_dir / run_id
    log_files = list(run_path.glob(f"*{log_type}*.log"))
    if not log_files:
        raise HTTPException(status_code=404, detail="Log not found")
    return log_files[0].read_text(errors="replace")[-100_000:]


@router.post("/api/chat")
async def chat(req: ChatRequest) -> ChatResponse:
    """Chat with the Vivado debug agent (blocking, returns full answer)."""
    if not _os.environ.get("ANTHROPIC_API_KEY"):
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not set")

    from edagent_vivado.agent.graph import create_agent, invoke_agent

    agent = create_agent()
    thread = req.thread_id or f"web_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    prompt = _build_prompt(req)
    answer = invoke_agent(agent, prompt, thread_id=thread)
    return ChatResponse(answer=str(answer), thread_id=thread)


@router.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    """Stream agent response via SSE with full visibility into thinking & tool calls.

    Events:
        event: status     — {"status": "thinking" | "calling_tool" | "done"}
        event: thinking   — {"text": "..."}  (model's thinking tokens)
        event: tool_start — {"name": "...", "args": {...}}
        event: tool_end   — {"name": "...", "result": "..."}
        event: text       — {"text": "..."}  (final response tokens)
        event: error      — {"message": "..."}
    """
    if not _os.environ.get("ANTHROPIC_API_KEY"):
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not set")

    prompt = _build_prompt(req)
    thread = req.thread_id or f"web_{datetime.now().strftime('%Y%m%d%H%M%S')}"

    return StreamingResponse(
        _stream_agent_events(prompt, thread),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _stream_agent_events(prompt: str, thread_id: str) -> AsyncIterator[str]:
    """Core streaming logic: runs the agent and yields SSE events."""
    from edagent_vivado.agent.graph import create_agent
    from langchain_core.messages import HumanMessage

    def _sse(event: str, data: dict | str) -> str:
        payload = json.dumps(data, ensure_ascii=False) if isinstance(data, dict) else data
        return f"event: {event}\ndata: {payload}\n\n"

    agent = create_agent()
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 1000}

    try:
        async for event in agent.astream_events(
            {"messages": [HumanMessage(content=prompt)]},
            config=config,
            version="v2",
        ):
            kind = event["event"]

            # ── Tool call starting ──
            if kind == "on_tool_start":
                tool_input = event["data"].get("input", {})
                # Sanitize: truncate long values for display
                safe_input = {}
                for k, v in (tool_input if isinstance(tool_input, dict) else {}).items():
                    s = str(v)
                    safe_input[k] = s[:300] + ("..." if len(s) > 300 else "")
                yield _sse("tool_start", {
                    "name": event["name"],
                    "args": safe_input,
                })
                yield _sse("status", {"status": "calling_tool", "tool": event["name"]})

            # ── Tool call finished ──
            elif kind == "on_tool_end":
                output = event["data"].get("output", "")
                result_str = str(output)
                # Truncate for display
                if len(result_str) > 2000:
                    result_str = result_str[:2000] + "... [truncated]"
                yield _sse("tool_end", {
                    "name": event["name"],
                    "result": result_str,
                })

            # ── LLM streaming tokens ──
            elif kind == "on_chat_model_stream":
                chunk = event["data"].get("chunk", {})
                if hasattr(chunk, "content") and chunk.content:
                    content = chunk.content
                    if isinstance(content, str) and content:
                        # Check if it's a tool call chunk (skip — handled by tool events)
                        if hasattr(chunk, "tool_calls") and chunk.tool_calls:
                            continue
                        # Check if it's a thinking/reasoning block
                        if hasattr(chunk, "additional_kwargs") and chunk.additional_kwargs:
                            reasoning = chunk.additional_kwargs.get("reasoning_content") or ""
                            if reasoning:
                                yield _sse("thinking", {"text": reasoning})
                                continue
                        # Regular text token
                        yield _sse("text", {"text": content})

        yield _sse("status", {"status": "done"})

    except Exception as e:
        yield _sse("error", {"message": str(e)})


@router.post("/api/chat/multi")
async def chat_multi(req: ChatRequest) -> ChatResponse:
    if not _os.environ.get("ANTHROPIC_API_KEY"):
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")
    from edagent_vivado.agent.supervisor import create_supervisor_agent, invoke_supervisor
    agent = create_supervisor_agent()
    thread = req.thread_id or f"web_multi_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    answer = invoke_supervisor(agent, req.question, thread_id=thread)
    return ChatResponse(answer=answer, thread_id=thread)


@router.get("/api/errors/kb")
async def get_error_kb() -> list[dict]:
    from edagent_vivado.kb.error_case_loader import load_cases
    return [
        {"pattern": c.pattern, "category": c.category,
         "likely_causes": c.likely_causes, "suggested_actions": c.suggested_actions}
        for c in load_cases()
    ]


# ── HTML pages ──────────────────────────────────────────────

@router.get("/", response_class=HTMLResponse)
async def index():
    return _page("Dashboard", """
    <h1>EdAgent-Vivado Dashboard</h1>
    <p>Vivado RTL Debug Agent v0.2.0</p>
    <nav>
        <a href="/runs">Run History</a> |
        <a href="/chat">Agent Chat</a> |
        <a href="/chat-multi">Multi-Agent Chat</a> |
        <a href="/errors">Error KB</a> |
        <a href="/docs">API Docs</a>
    </nav>
    """)

@router.get("/runs", response_class=HTMLResponse)
async def runs_page():
    return _page("Run History", """
    <h1>Run History</h1>
    <div id="runs-table">Loading...</div>
    <script>
        fetch('/api/runs?limit=50').then(r => r.json()).then(runs => {
            if (!runs.length) { document.getElementById('runs-table').innerHTML = '<p>No runs found.</p>'; return; }
            let h = '<table><tr><th>Run</th><th>Step</th><th>Status</th><th>Elapsed</th></tr>';
            runs.forEach(r => { h += `<tr><td>${r.run_id||''}</td><td>${r.step||''}</td>
                <td style="color:${r.status==='success'?'green':'red'}">${r.status||''}</td>
                <td>${r.elapsed||''}</td></tr>`; });
            h += '</table>'; document.getElementById('runs-table').innerHTML = h;
        });
    </script>""")

@router.get("/chat", response_class=HTMLResponse)
async def chat_page():
    return _chat_streaming_page("Vivado Debug Agent Chat", "/api/chat/stream")

@router.get("/chat-multi", response_class=HTMLResponse)
async def chat_multi_page():
    return _chat_streaming_page("Multi-Agent Chat", "/api/chat/multi")

@router.get("/errors", response_class=HTMLResponse)
async def errors_page():
    return _page("Error Knowledge Base", """
    <h1>Error Knowledge Base</h1>
    <div id="kb">Loading...</div>
    <script>
        fetch('/api/errors/kb').then(r => r.json()).then(cases => {
            let h = '';
            cases.forEach(c => {
                h += `<details><summary><b>${c.category}</b> — ${c.pattern}</summary>
                    <p><b>Likely causes:</b></p><ul>${c.likely_causes.map(x=>'<li>'+x+'</li>').join('')}</ul>
                    <p><b>Suggested actions:</b></p><ul>${c.suggested_actions.map(x=>'<li>'+x+'</li>').join('')}</ul>
                    </details><hr>`;
            });
            document.getElementById('kb').innerHTML = h || '<p>No patterns loaded.</p>';
        });
    </script>""")


# ── helpers ──────────────────────────────────────────────────

def _build_prompt(req: ChatRequest) -> str:
    prompt = req.question
    if req.manifest_path:
        p = Path(req.manifest_path)
        if p.exists():
            from edagent_vivado.harness.manifest import Manifest
            m = Manifest.load(p)
            prompt = f"Project: {m.name()} | Top: {m.top()} | Part: {m.part()}\nRTL: {m.sources.rtl}\n\nQuestion: {req.question}"
    return prompt


def _page(title: str, body: str) -> str:
    return f"""<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>{title}</title>
<style>
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:960px;margin:20px auto;padding:0 20px;}}
table{{border-collapse:collapse;width:100%;}}th,td{{border:1px solid #ddd;padding:8px;text-align:left;}}th{{background:#f5f5f5;}}
nav{{margin:16px 0;}}a{{color:#2563eb;}}details{{margin:8px 0;}}
.tool-call{{border:1px solid #fbbf24;border-radius:6px;margin:8px 0;overflow:hidden;}}
.tool-call-header{{background:#fef3c7;padding:6px 10px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;}}
.tool-call-body{{background:#fffbeb;padding:8px 10px;display:none;font-size:0.9em;}}
.tool-call-body.open{{display:block;}}
.tool-call-args{{white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;}}
.tool-call-result{{white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;border-top:1px solid #fbbf24;margin-top:6px;padding-top:6px;}}
.thinking-block{{color:#6b7280;font-style:italic;border-left:3px solid #d1d5db;padding:4px 10px;margin:4px 0;font-size:0.9em;}}
.status-bar{{font-size:0.8em;color:#9ca3af;margin:4px 0;}}
.spinner{{display:inline-block;width:12px;height:12px;border:2px solid #e5e7eb;border-top-color:#3b82f6;border-radius:50%;animation:spin 0.6s linear infinite;margin-right:6px;}}
@keyframes spin{{to{{transform:rotate(360deg)}}}}
</style></head><body>{body}</body></html>"""


# ── chat page builder ─────────────────────────────────────

def _chat_streaming_page(title: str, endpoint: str) -> str:
    """Build chat HTML page with SSE streaming support. Uses simple string
    building to avoid Python format-string / JS template literal conflicts."""
    return _page(title, _CHAT_CSS + _build_chat_html(title, endpoint) + _CHAT_JS % endpoint)


_CHAT_CSS = """
<style>
.tool-call{border:1px solid #fbbf24;border-radius:6px;margin:8px 0;overflow:hidden;}
.tool-call-header{background:#fef3c7;padding:6px 10px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;}
.tool-call-body{background:#fffbeb;padding:8px 10px;display:none;font-size:0.9em;}
.tool-call-body.open{display:block;}
.tool-call-args{white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;font-size:0.8em;color:#92400e;}
.tool-call-result{white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;border-top:1px solid #fbbf24;margin-top:6px;padding-top:6px;font-size:0.85em;}
.thinking-block{color:#6b7280;font-style:italic;border-left:3px solid #d1d5db;padding:4px 10px;margin:4px 0;font-size:0.9em;}
.spinner{display:inline-block;width:12px;height:12px;border:2px solid #e5e7eb;border-top-color:#3b82f6;border-radius:50%;animation:spin 0.6s linear infinite;margin-right:6px;}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
"""


def _build_chat_html(title: str, endpoint: str) -> str:
    return """
<h1>""" + title + """</h1>
<div style="max-width:900px;margin:0 auto;">
  <div id="log" style="border:1px solid #ccc;padding:12px;height:500px;
      overflow-y:scroll;margin-bottom:10px;background:#fafafa;font-size:0.95em;"></div>
  <div style="display:flex;gap:6px;margin-bottom:5px;">
    <textarea id="q" rows="2" style="flex:1;" placeholder="Ask the Vivado debug agent..."></textarea>
  </div>
  <div style="display:flex;gap:6px;margin-bottom:5px;">
    <input id="mp" style="flex:1;" placeholder="Manifest path (optional)" />
    <button id="sendbtn" style="padding:8px 16px;white-space:nowrap;cursor:pointer;">Send</button>
  </div>
  <div id="st" style="font-size:0.85em;color:#888;min-height:20px;"></div>
</div>
"""


# JavaScript: uses old-style %s for endpoint injection (single %s, no brace escaping)
_CHAT_JS = r"""
<script>
var _toolDivs = [];
var _currentThinkingBlock = null;
var _currentTextBlock = null;
var _toolCount = 0;
var _endpoint = '%s';

function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function addMsg(role, content) {
    var log = document.getElementById('log');
    var div = document.createElement('div');
    div.style.marginBottom = '8px';
    div.innerHTML = '<b>' + role + ':</b> ' + content;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
}

function addToolBlock(name, args) {
    var log = document.getElementById('log');
    _toolCount++;
    var id = 'tool-' + _toolCount;
    var argsStr = JSON.stringify(args, null, 2);
    var div = document.createElement('div');
    div.className = 'tool-call';
    div.id = id;
    div.innerHTML =
        '<div class="tool-call-header" onclick="toggleTool(\'' + id + '\')">' +
        '<span style="font-weight:600;">&#x1F527; ' + escapeHtml(name) + '</span>' +
        '<span style="color:#9ca3af;font-size:0.8em;">running...</span>' +
        '</div>' +
        '<div class="tool-call-body open">' +
        '<div style="color:#92400e;font-size:0.85em;">Args:</div>' +
        '<pre class="tool-call-args">' + escapeHtml(argsStr) + '</pre>' +
        '<div class="tool-call-result" style="color:#9ca3af;">Waiting for result...</div>' +
        '</div>';
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
}

function updateToolResult(div, result) {
    var resultDiv = div.querySelector('.tool-call-result');
    var headerSpan = div.querySelector('.tool-call-header span:last-child');
    if (resultDiv) resultDiv.textContent = result;
    if (headerSpan) { headerSpan.textContent = 'completed'; headerSpan.style.color = '#059669'; }
    document.getElementById('log').scrollTop = document.getElementById('log').scrollHeight;
}

function toggleTool(id) {
    var body = document.querySelector('#' + id + ' .tool-call-body');
    if (body) { body.classList.toggle('open'); }
}

function addThinking(text) {
    var log = document.getElementById('log');
    if (!_currentThinkingBlock) {
        _currentThinkingBlock = document.createElement('div');
        _currentThinkingBlock.className = 'thinking-block';
        _currentThinkingBlock.innerHTML = '<span style="font-size:0.8em;color:#9ca3af;">thinking...</span> ';
        log.appendChild(_currentThinkingBlock);
    }
    _currentThinkingBlock.innerHTML += escapeHtml(text);
    log.scrollTop = log.scrollHeight;
}

function appendText(text) {
    var log = document.getElementById('log');
    if (!_currentTextBlock) {
        _currentTextBlock = document.createElement('div');
        _currentTextBlock.style.marginBottom = '8px';
        _currentTextBlock.innerHTML = '<b>Agent:</b> ';
        log.appendChild(_currentTextBlock);
    }
    _currentTextBlock.innerHTML += escapeHtml(text).replace(/\n/g, '<br>');
    log.scrollTop = log.scrollHeight;
}

function send() {
    var q = document.getElementById('q').value.trim();
    var m = document.getElementById('mp').value.trim();
    if (!q) return;

    _toolDivs = [];
    _currentThinkingBlock = null;
    _currentTextBlock = null;
    _toolCount = 0;

    var statusEl = document.getElementById('st');
    statusEl.innerHTML = '<span class="spinner"></span>Connecting...';

    addMsg('You', escapeHtml(q).replace(/\n/g, '<br>'));

    var payload = JSON.stringify({question: q, manifest_path: m});

    fetch(_endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: payload})
    .then(function(response) {
        if (!response.ok) {
            return response.json().then(function(err) {
                statusEl.textContent = 'Error: ' + (err.detail || response.statusText);
            });
        }
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        function process() {
            reader.read().then(function(result) {
                if (result.done) {
                    statusEl.textContent = '';
                    _currentThinkingBlock = null;
                    _currentTextBlock = null;
                    return;
                }
                buffer += decoder.decode(result.value, {stream: true});
                var lines = buffer.split('\n');
                buffer = lines.pop() || '';
                var currentEvent = '';
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i];
                    if (line.indexOf('event: ') === 0) {
                        currentEvent = line.substring(7).trim();
                    } else if (line.indexOf('data: ') === 0) {
                        var raw = line.substring(6);
                        var data = raw;
                        try { data = JSON.parse(raw); } catch(e) {}
                        handleSSE(currentEvent, data);
                        currentEvent = '';
                    }
                }
                process();
            }).catch(function(e) {
                statusEl.textContent = 'Stream error: ' + e;
            });
        }
        process();
    }).catch(function(e) {
        statusEl.textContent = 'Network error: ' + e.message;
    });

    document.getElementById('q').value = '';
}

function handleSSE(event, data) {
    var statusEl = document.getElementById('st');
    switch(event) {
    case 'status':
        if (data.status === 'thinking') {
            statusEl.innerHTML = '<span class="spinner"></span>Thinking...';
        } else if (data.status === 'calling_tool') {
            statusEl.innerHTML = '<span class="spinner"></span>Calling: ' + escapeHtml(data.tool || '');
        } else if (data.status === 'done') {
            statusEl.textContent = '';
        }
        break;
    case 'tool_start':
        var d = addToolBlock(data.name, data.args);
        _toolDivs.push({name: data.name, div: d});
        break;
    case 'tool_end':
        for (var i = _toolDivs.length - 1; i >= 0; i--) {
            if (_toolDivs[i].name === data.name && _toolDivs[i].div) {
                updateToolResult(_toolDivs[i].div, data.result || '(no output)');
                _toolDivs.splice(i, 1);
                break;
            }
        }
        break;
    case 'thinking':
        addThinking(data.text);
        break;
    case 'text':
        _currentThinkingBlock = null;
        appendText(data.text);
        statusEl.textContent = '';
        break;
    case 'error':
        statusEl.textContent = 'Error: ' + (data.message || data);
        break;
    }
}

// Bind send button (ensures click works even if onclick attr fails)
document.addEventListener('DOMContentLoaded', function() {{
    var btn = document.getElementById('sendbtn');
    if (btn) { btn.addEventListener('click', send); }
    // Also allow Enter in textarea to send
    var ta = document.getElementById('q');
    if (ta) { ta.addEventListener('keydown', function(e) {{
        if (e.key === 'Enter' && !e.shiftKey) {{ e.preventDefault(); send(); }}
    }}); }}
}});
</script>
"""


def _scan_run(run_dir: Path) -> dict | None:
    manifest_path = run_dir / "input_manifest.yaml"
    if not manifest_path.exists():
        return None
    project_name = "unknown"
    try:
        import yaml
        m = yaml.safe_load(manifest_path.read_text()) or {}
        project_name = m.get("project", {}).get("name", "unknown")
    except Exception:
        pass
    status, step, elapsed = "unknown", "unknown", "N/A"
    artifacts = run_dir / "artifacts"
    if artifacts.exists():
        for art in sorted(artifacts.iterdir(), reverse=True):
            if art.suffix == ".json":
                try:
                    d = json.loads(art.read_text())
                    status = "success" if d.get("success") else "failed"
                    step = d.get("step", step)
                    elapsed = f"{d.get('elapsed_sec', 'N/A')}s"
                    break
                except Exception:
                    pass
    return {"run_id": run_dir.name, "project": project_name, "step": step, "status": status, "elapsed": elapsed, "path": str(run_dir)}
