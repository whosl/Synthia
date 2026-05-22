"""Terminal-style chat frontend — single-file, no build step."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, StreamingResponse
import json, os as _os, asyncio
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator

router = APIRouter()

# ── Patch approval toggle ────────────────────────────────────

from edagent_vivado.tools.patch_tools import set_patch_approval, is_patch_approved

@router.get("/api/terminal/approve")
async def get_approve_status():
    return {"approved": is_patch_approved()}

@router.post("/api/terminal/approve")
async def toggle_approve(body: dict):
    approved = body.get("approved", not is_patch_approved())
    set_patch_approval(approved)
    return {"approved": is_patch_approved()}

# ── Chat ─────────────────────────────────────────────────────

@router.post("/api/terminal/chat")
async def terminal_chat(req: Request):
    body = await req.json()
    question = body.get("question", "")
    manifest_path = body.get("manifest_path", "")

    if not _os.environ.get("ANTHROPIC_API_KEY"):
        return StreamingResponse(
            _sse_error("ANTHROPIC_API_KEY not set."),
            media_type="text/event-stream",
        )

    prompt = question
    if manifest_path:
        p = Path(manifest_path)
        if p.exists():
            from edagent_vivado.harness.manifest import Manifest
            m = Manifest.load(p)
            prompt = f"Project: {m.name()} | Top: {m.top()} | Part: {m.part()}\nRTL: {m.sources.rtl}\n\nQuestion: {question}"

    thread_id = f"term_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    return StreamingResponse(
        _stream_agent(prompt, thread_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


async def _stream_agent(prompt: str, thread_id: str) -> AsyncIterator[str]:
    from edagent_vivado.agent.graph import create_agent
    from langchain_core.messages import HumanMessage

    def sse(event: str, data: dict | str) -> str:
        p = json.dumps(data, ensure_ascii=False) if isinstance(data, dict) else data
        return f"event: {event}\ndata: {p}\n\n"

    try:
        agent = create_agent()
        config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 100}
        yield sse("status", "thinking")

        tool_count = 0
        seen_first_tool = False
        reasoning_buffer = ""
        response_buffer = ""

        async for event in agent.astream_events(
            {"messages": [HumanMessage(content=prompt)]},
            config=config, version="v2",
        ):
            kind = event["event"]

            # ── Tool start ──
            if kind == "on_tool_start":
                # Flush pending text before showing tool
                if reasoning_buffer:
                    yield sse("reasoning", {"text": reasoning_buffer})
                    reasoning_buffer = ""
                if response_buffer:
                    yield sse("response", {"text": response_buffer})
                    response_buffer = ""

                tool_count += 1
                seen_first_tool = True
                name = event["name"]
                args = event["data"].get("input", {})
                args_str = json.dumps(args, ensure_ascii=False)[:500]
                yield sse("tool_start", {"name": name, "args": args_str, "state": "begin"})
                yield sse("status", f"calling_{name}")

            # ── Tool done ──
            elif kind == "on_tool_end":
                output = str(event["data"].get("output", ""))[:2000]
                yield sse("tool_end", {"name": event["name"], "result": output, "state": "done"})

            # ── LLM tokens ──
            elif kind == "on_chat_model_stream":
                chunk = event["data"].get("chunk", {})
                if hasattr(chunk, "tool_calls") and chunk.tool_calls:
                    continue
                if hasattr(chunk, "content") and chunk.content:
                    c = chunk.content
                    # Check for explicit reasoning_content
                    reasoning = ""
                    if hasattr(chunk, "additional_kwargs") and chunk.additional_kwargs:
                        reasoning = chunk.additional_kwargs.get("reasoning_content", "")

                    text = ""
                    if isinstance(c, str):
                        text = c
                    elif isinstance(c, list):
                        text = "".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")

                    if reasoning:
                        if response_buffer:
                            yield sse("response", {"text": response_buffer})
                            response_buffer = ""
                        reasoning_buffer += reasoning
                        yield sse("reasoning", {"text": reasoning_buffer})
                    elif text:
                        if not seen_first_tool:
                            if response_buffer:
                                yield sse("response", {"text": response_buffer})
                                response_buffer = ""
                            reasoning_buffer += text
                            yield sse("reasoning", {"text": reasoning_buffer})
                        else:
                            if reasoning_buffer:
                                yield sse("reasoning", {"text": reasoning_buffer})
                                reasoning_buffer = ""
                            response_buffer += text
                            yield sse("response", {"text": response_buffer})

        # Final flush
        if reasoning_buffer:
            yield sse("reasoning", {"text": reasoning_buffer})
        if response_buffer:
            yield sse("response", {"text": response_buffer})
        yield sse("status", f"done_{tool_count}_tools")
    except Exception as e:
        yield sse("error", str(e))


async def _sse_error(msg: str) -> AsyncIterator[str]:
    yield f"event: error\ndata: {json.dumps(msg)}\n\n"


@router.get("/term", response_class=HTMLResponse)
async def terminal_page():
    return TERMINAL_HTML


TERMINAL_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>EdAgent Terminal</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{height:100%}
body{background:#0d1117;color:#c9d1d9;font-family:'Cascadia Code','Fira Code','JetBrains Mono','Consolas',monospace;
  height:100%;height:100dvh;display:flex;flex-direction:column;overflow:hidden;padding-bottom:env(safe-area-inset-bottom,0)}
#header{background:#161b22;border-bottom:1px solid #30363d;padding:8px 12px;display:flex;align-items:center;gap:8px;flex-shrink:0}
#header .dot{width:10px;height:10px;min-width:10px;border-radius:50%}
#header .dot.r{background:#ff5f56}.dot.y{background:#ffbd2e}.dot.g{background:#27ca40}
#header .title{color:#8b949e;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#output{flex:1;overflow-y:auto;padding:10px 12px;font-size:13px;line-height:1.5;-webkit-overflow-scrolling:touch}
.agent-line{white-space:pre-wrap;word-break:break-word}
.user-line{color:#58a6ff;margin:4px 0}
.tool{color:#d2991d;margin:4px 0;padding:6px 10px;background:#1a1f2b;border-left:2px solid #d2991d;border-radius:2px;font-size:12px}
.tool .name{font-weight:bold}.tool .args{color:#8b949e;font-size:11px;max-height:80px;overflow-y:auto}
.tool .result{color:#7ee787;font-size:11px;margin-top:4px;max-height:150px;overflow-y:auto;border-top:1px solid #21262d;padding-top:4px}
.tool .state{font-size:10px;color:#6e7681;margin-left:4px}
.reasoning-block{color:#8b949e;margin:4px 0;padding:6px 10px;background:#0d1117;border-left:2px solid #6e7681;border-radius:2px;font-size:12px;font-style:italic}
.reasoning-block .state{font-size:10px;color:#484f58;margin-bottom:2px}
.response-block{color:#c9d1d9;margin:4px 0}
.spinner-sm{display:inline-block;width:10px;height:10px;border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:s .6s linear infinite}
.status-icon{display:inline-block;width:14px;height:14px;text-align:center;line-height:14px;font-size:12px}
.dim{color:#6e7681;font-size:12px}
#input-line{display:flex;align-items:center;padding:6px 12px;background:#161b22;border-top:1px solid #30363d;flex-shrink:0;z-index:10}
#input-line .prompt{color:#58a6ff;margin-right:8px;white-space:nowrap;font-size:13px;flex-shrink:0}
#input-line input{flex:1;min-width:0;background:transparent;border:none;color:#c9d1d9;font-family:inherit;font-size:16px;outline:none;caret-color:#58a6ff}
#input-line input::placeholder{color:#484f58}
.spinner{display:inline-block;width:8px;height:8px;border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:s .6s linear infinite;margin-right:6px;vertical-align:middle}
@keyframes s{to{transform:rotate(360deg)}}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#0d1117}::-webkit-scrollbar-thumb{background:#30363d;border-radius:2px}
/* Markdown */
.md-code{border:1px solid #30363d;border-radius:4px;margin:6px 0;overflow-x:auto;background:#161b22}
.md-code .lang{color:#6e7681;font-size:10px;padding:2px 10px;font-style:italic}
.md-code pre{margin:0;padding:8px 10px;font-size:12px;line-height:1.35;white-space:pre;overflow-x:auto;color:#c9d1d9}
.md-code-inline{background:#1c2128;color:#d2a8ff;padding:1px 5px;border-radius:3px;font-size:.95em;white-space:nowrap}
.md-h1{color:#7ee787;font-size:15px;font-weight:bold;margin:8px 0 4px;border-bottom:1px solid #21262d;padding-bottom:3px}
.md-h2{color:#7ee787;font-size:14px;font-weight:bold;margin:6px 0 3px}
.md-h3{color:#7ee787;font-size:13px;font-weight:bold;margin:4px 0 2px}
.md-bold{font-weight:bold;color:#f0f6fc}
.md-italic{font-style:italic}
.md-table{border-collapse:collapse;margin:6px 0;font-size:12px}
.md-table td,.md-table th{border:1px solid #30363d;padding:3px 8px;text-align:left}
.md-table th{background:#161b22;font-weight:bold;color:#f0f6fc}
.md-table tr:nth-child(even){background:#0d1117}
.md-hr{border:none;border-top:1px solid #30363d;margin:8px 0}
.md-link{color:#58a6ff}
.md-blockquote{border-left:3px solid #30363d;padding:2px 10px;margin:4px 0;color:#8b949e}
</style>
</head>
<body>
<div id="header">
  <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
  <span class="title">edagent-vivado</span>
  <label id="approve-toggle" style="margin-left:auto;display:flex;align-items:center;gap:4px;cursor:pointer;font-size:11px;color:#6e7681;user-select:none">
    <input type="checkbox" id="approve-cb" style="accent-color:#58a6ff;cursor:pointer" onchange="toggleApprove(this.checked)">
    approve patches
  </label>
  <span id="status-line" style="color:#484f58;font-size:12px"></span>
</div>
<div id="output"></div>
<div id="input-line">
  <span class="prompt">eda&gt;</span>
  <input id="q" placeholder="Ask about synthesis, timing, constraints..." autofocus autocomplete="off" />
</div>
<script>
var out=document.getElementById('output'), inp=document.getElementById('q');
var statusLine=document.getElementById('status-line');
var currentTool=null, currentReasoning=null, currentResponse=null, agentBuffer='';
// Elapsed time tracker
var activeTimers=[];
setInterval(function(){var n=Date.now();for(var i=0;i<activeTimers.length;i++){var t=activeTimers[i];if(t._timerEl){t._timerEl.textContent=fmtTime(n-t._start);}}},1000);
function fmtTime(ms){var s=Math.floor(ms/1000);if(s<60)return s+'s';var m=Math.floor(s/60);return m+'m'+(s%60)+'s';}
function startTimer(el){el._start=Date.now();el._timerEl=el.querySelector('.timer');activeTimers.push(el);}
function stopTimer(el){if(el._timerEl)el._timerEl.textContent='';for(var i=0;i<activeTimers.length;i++){if(activeTimers[i]===el){activeTimers.splice(i,1);break;}}}
var rafPending=null, rafEl=null, rafContent=null, rafMode='', lastMdRender='';

function append(cls,html){var d=document.createElement('div');d.className=cls;d.innerHTML=html;out.appendChild(d);out.scrollTop=out.scrollHeight;return d}

function scheduleRender(el, content, mode){
  // mode: 'esc'=escape then set, 'html'=raw innerHTML, 'md'=renderMarkdown then set
  // Only keep the latest pending render per element
  rafEl=el; rafContent=content; rafMode=mode;
  if(!rafPending){ rafPending=requestAnimationFrame(doRender); }
}

function doRender(){
  if(rafEl){
    if(rafMode==='esc'){ rafEl.innerHTML=esc(rafContent); }
    else if(rafMode==='html'){ rafEl.innerHTML=rafContent; }
    else if(rafMode==='md'){
      if(rafContent!==lastMdRender){
        rafEl.innerHTML=renderMarkdown(rafContent);
        lastMdRender=rafContent;
      }
    }
    rafEl=null; rafContent=null; rafMode='';
  }
  out.scrollTop=out.scrollHeight;
  rafPending=null;
}

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

function renderMarkdown(text){
  // Escape HTML, then apply Markdown rules
  var lines=text.split('\n');
  var result=[];
  var inCode=false, codeLang='', codeLines=[];
  var inTable=false, tableRows=[];

  function flushCode(){
    if(codeLines.length){
      var langTag=codeLang?'<div class="lang">'+esc(codeLang)+'</div>':'';
      result.push('<div class="md-code">'+langTag+'<pre>'+codeLines.map(esc).join('\n')+'</pre></div>');
      codeLines=[]; codeLang='';
    }
  }

  function flushTable(){
    if(tableRows.length>=2){
      var h='<table class="md-table">';
      for(var i=0;i<tableRows.length;i++){
        h+='<tr>';
        var cells=tableRows[i].split('|').filter(function(c){return c.trim()!==''});
        for(var j=0;j<cells.length;j++){
          h+=(i===0?'<th>':'<td>')+renderInline(cells[j].trim())+(i===0?'</th>':'</td>');
        }
        h+='</tr>';
      }
      h+='</table>';
      result.push(h);
    }
    tableRows=[]; inTable=false;
  }

  function renderInline(txt){
    // Bold
    txt=txt.replace(/\*\*(.+?)\*\*/g,'<span class="md-bold">$1</span>');
    // Italic
    txt=txt.replace(/\*(.+?)\*/g,'<span class="md-italic">$1</span>');
    // Inline code
    txt=txt.replace(/`(.+?)`/g,'<code class="md-code-inline">$1</code>');
    // Links
    txt=txt.replace(/\[(.+?)\]\((.+?)\)/g,'<a class="md-link" href="$2">$1</a>');
    return txt;
  }

  for(var i=0;i<lines.length;i++){
    var line=lines[i];
    var trimmed=line.trim();

    // Code fences
    if(trimmed.startsWith('```')){
      if(inCode){ flushCode(); inCode=false; }
      else{ inCode=true; codeLang=trimmed.slice(3); }
      continue;
    }
    if(inCode){ codeLines.push(line); continue; }

    // Table detection
    if(trimmed.startsWith('|') && trimmed.endsWith('|')){
      if(trimmed.match(/^\|[\s\-:]+\|$/)){ continue; } // separator row
      if(!inTable){ inTable=true; tableRows=[]; }
      tableRows.push(trimmed);
      if(i+1>=lines.length || !lines[i+1].trim().startsWith('|')){ flushTable(); }
      continue;
    }
    flushTable();

    // Headings
    if(/^#{1,3}\s/.test(trimmed)){
      var h=trimmed.match(/^(#{1,3})\s(.+)/);
      if(h){
        var lvl=h[1].length;
        result.push('<div class="md-h'+lvl+'">'+renderInline(h[2])+'</div>');
      }
      continue;
    }

    // Horizontal rule
    if(/^-{3,}$/.test(trimmed)){ result.push('<div class="md-hr"></div>'); continue; }

    // Blockquote
    if(trimmed.startsWith('> ')){
      result.push('<div class="md-blockquote">'+renderInline(trimmed.slice(2))+'</div>');
      continue;
    }

    // Unordered list
    if(/^[\-\*]\s/.test(trimmed)){
      result.push('<div style="padding-left:16px;margin:1px 0">- '+renderInline(trimmed.slice(2))+'</div>');
      continue;
    }

    // Ordered list
    if(/^\d+\.\s/.test(trimmed)){
      result.push('<div style="padding-left:16px;margin:1px 0">'+renderInline(trimmed)+'</div>');
      continue;
    }

    // Regular paragraph
    if(trimmed===''){ result.push('<br>'); }
    else{ result.push('<div>'+renderInline(trimmed)+'</div>'); }
  }

  flushCode(); flushTable();
  return result.join('');
}

function toggleApprove(on){
  fetch('/api/terminal/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({approved:on})});
}

// Init: fetch current approve state
fetch('/api/terminal/approve').then(function(r){return r.json()}).then(function(d){
  document.getElementById('approve-cb').checked=d.approved;
});

function send(){
  var q=inp.value.trim(); if(!q) return;
  inp.value=''; inp.disabled=true;

  append('user-line','<b>eda&gt;</b> '+esc(q));
  currentTool=null; currentReasoning=null; currentResponse=null; agentBuffer=''; lastMdRender='';
  statusLine.innerHTML='';

  fetch('/api/terminal/chat',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({question:q,manifest_path:''})
  }).then(function(resp){
    var reader=resp.body.getReader(), decoder=new TextDecoder(), buf='';
    (function process(){
      reader.read().then(function(r){
        if(r.done){ inp.disabled=false; inp.focus(); statusLine.textContent=''; return; }
        buf+=decoder.decode(r.value,{stream:true});
        var lines=buf.split('\n'); buf=''; var ev='';
        for(var i=0;i<lines.length;i++){
          var line=lines[i];
          if(line.startsWith('event: ')){ ev=line.slice(7).trim(); }
          else if(line.startsWith('data: ')){
            try{ handle(ev,JSON.parse(line.slice(6))); }catch(ex){ handle(ev,line.slice(6)); }
            ev='';
          }else if(line){ buf+=line+'\n'; }
        }
        process();
      }).catch(function(e){ append('dim','error: '+e); inp.disabled=false; });
    })();
  }).catch(function(e){ append('dim','fetch error: '+e); inp.disabled=false; });
}

function handle(ev,data){
  switch(ev){
    // Reasoninging block (merged, no begin/done)
    case 'reasoning':
      currentResponse=null;
      if(!currentReasoning){
        var h='<div class="reasoning-header" onclick="var b=this.parentElement.querySelector(\'.reasoning-body\');b.classList.toggle(\'collapsed\');this.querySelector(\'.arrow\').classList.toggle(\'collapsed\')">';
        h+='<span class="arrow">&#9660;</span> Reasoning <span class="icon"><span class="spinner-sm"></span> <span class="timer" style="font-size:10px;color:#484f58"></span></span></div>';
        h+='<div class="reasoning-body"></div>';
        currentReasoning=append('reasoning-block',h);
        currentReasoning._body=currentReasoning.querySelector('.reasoning-body');
        currentReasoning._icon=currentReasoning.querySelector('.icon');
        startTimer(currentReasoning);
      }
      scheduleRender(currentReasoning._body, esc(data.text||data), 'html');
      break;

    // Response block — accumulate silently, only render Markdown on done
    case 'response':
      if(currentReasoning && currentReasoning._icon){ currentReasoning._icon.innerHTML='&#10004;'; stopTimer(currentReasoning); }
      currentReasoning=null;
      if(!currentResponse){ currentResponse=append('response-block',''); agentBuffer=''; }
      agentBuffer=data.text||data;
      break;

    // Tool call block (keeps begin/done)
    case 'tool_start':
      if(currentReasoning && currentReasoning._icon){ currentReasoning._icon.innerHTML='&#10004;'; stopTimer(currentReasoning); }
      currentReasoning=null; currentResponse=null; agentBuffer='';
      var th='<div class="tool-header" onclick="var b=this.parentElement.querySelector(\'.tool-body\');b.classList.toggle(\'collapsed\');this.querySelector(\'.arrow\').classList.toggle(\'collapsed\')">';
      th+='<span class="arrow">&#9660;</span> '+esc(data.name)+' <span class="icon"><span class="spinner-sm"></span> <span class="timer" style="font-size:10px;color:#484f58"></span></span></div>';
      th+='<div class="tool-body"><div class="args">'+esc(data.args||'')+'</div></div>';
      currentTool=append('tool',th);
      currentTool._body=currentTool.querySelector('.tool-body');
      currentTool._icon=currentTool.querySelector('.icon');
      startTimer(currentTool);
      break;
    case 'tool_end':
      if(currentTool && currentTool._icon){ currentTool._icon.innerHTML='&#10004;'; stopTimer(currentTool); }
      if(currentTool && currentTool._body){
        currentTool._body.innerHTML+='<div class="result">'+esc(String(data.result||'').substring(0,1000))+'</div>';
      }
      break;

    case 'status':
      if(typeof data==='string' && data.startsWith('done')){ if(currentReasoning && currentReasoning._icon){ currentReasoning._icon.innerHTML='&#10004;'; stopTimer(currentReasoning); } if(currentResponse && agentBuffer){ scheduleRender(currentResponse, agentBuffer, 'md'); } inp.disabled=false; inp.focus(); agentBuffer=''; currentReasoning=null; currentResponse=null; }
      else if(typeof data==='string' && data.startsWith('calling_')){ statusLine.innerHTML=''; }
      else if(data==='thinking'){ statusLine.innerHTML=''; }
      break;
    case 'error':
      append('dim','ERROR: '+esc(data)); statusLine.textContent=''; inp.disabled=false; inp.focus();
      break;
  }
}

inp.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); } });
</script>
</body>
</html>"""

