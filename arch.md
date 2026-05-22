# EdAgent-Vivado Architecture

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Language | Python 3.11+ | All backend |
| LLM Framework | LangChain + LangGraph | Agent creation, tool binding, streaming events |
| LLM Backend | langchain-anthropic -> GLM-5-turbo | Via Anthropic-compatible API (Zhipu) |
| Web Backend | FastAPI + uvicorn | HTTP API + SSE streaming |
| Frontend | Plain HTML/CSS/JS (single-file) | Terminal-style chat UI, zero build |
| Data Models | Pydantic v2 | Manifest, config |
| CLI | Typer + Rich | Command-line tools |
| Package Mgmt | pip + pyproject.toml | Dependencies and entry points |
| Remote Exec | SSH (OpenSSH) + subprocess | Remote Vivado |
| Testing | pytest | 95 test cases |

---

## Architecture Overview

```
Browser                   Python Backend                  Remote Linux
──────                    ──────────────                  ────────────

┌──────────┐   SSE/HTTP   ┌──────────────┐    SSH     ┌──────────────┐
│ terminal │◄────────────►│  FastAPI      │◄──────────►│ Vivado 2022.1│
│  HTML    │              │              │  scp/ssh   │  xilinx@150  │
│  /term   │              │  /api/terminal/chat        │              │
└──────────┘              │  /api/terminal/approve     └──────────────┘
                          │  /api/health
                          │  /api/runs
                          │  /term (HTML page)
                          │
                          │  ┌──────────────────┐
                          │  │  LangGraph Agent  │
                          │  │  ┌────┐┌────┐┌──┐│
                          │  │  │ LLM││Tool││St││
                          │  │  │GLM5││ x7 ││rm││
                          │  │  └────┘└────┘└──┘│
                          │  └──────────────────┘
                          │           │
                          │  ┌────────┼────────┐
                          │  │  Harness Layer   │
                          │  │ ┌──────┐┌──────┐│
                          │  │ │Vivado││Comma│││
                          │  │ │Runner││Runner│││
                          │  │ └──────┘└──────┘│
                          │  │ ┌──────┐┌──────┐│
                          │  │ │Manife││Worksp│││
                          │  │ │st    ││ace   │││
                          │  │ └──────┘└──────┘│
                          │  └─────────────────┘
                          │           │
                          │  ┌────────┼────────┐
                          │  │   Parsers        │
                          │  │ ┌──────┐┌──────┐│
                          │  │ │Log   ││Timing│││
                          │  │ │Parser││Parser│││
                          │  │ └──────┘└──────┘│
                          │  │ ┌──────┐┌──────┐│
                          │  │ │Util  ││QoR   ││
                          │  │ │Parser││Check ││
                          │  │ └──────┘└──────┘│
                          │  └─────────────────┘
                          │           │
                          │  ┌────────┼────────┐
                          │  │  KB Error Cases  │
                          │  │ 55 patterns YAML │
                          │  │ + matching engine│
                          │  └─────────────────┘
```

---

## Component Details

### 1. Agent Layer (`agent/`)

| File | Role |
|---|---|
| `model.py` | LLM init, reads `.env` for key/url/model, LangSmith tracing |
| `graph.py` | Single agent entry: `create_agent()` + `invoke_agent()` + `stream_agent()`, 7 tools, Checkpointer for session persistence |
| `supervisor.py` | Multi-agent orchestration: Supervisor routes to synthesis/timing/constraint sub-agents |
| `specialists.py` | Three specialist system prompts + dedicated tool sets |
| `prompts.py` | Single agent system prompt (diagnosis framework: observed -> evidence -> root cause -> suggested actions -> next verification) |

### 2. Agent Tools (`tools/`)

| Tool | Function |
|---|---|
| `read_file_tool` | Read files (log, report, manifest, RTL) |
| `grep_tool` | Search patterns in project directory |
| `parse_vivado_log_tool` | Parse Vivado logs, extract ERROR/WARNING/message IDs |
| `parse_timing_tool` | Parse timing reports, extract WNS/TNS/WHS/THS |
| `parse_utilization_tool` | Parse utilization reports, extract LUT/FF/BRAM/DSP |
| `match_error_cases_tool` | Match error KB, return category + causes + actions |
| `run_vivado_synth_tool` | Execute synthesis (remote/local/mock auto-select) |
| `propose_patch_tool` | Propose/apply code changes, user approval required |
| `create_file_tool` | Create new files, user approval required |

### 3. Harness Layer (`harness/`)

| Module | Function |
|---|---|
| `manifest.py` | Pydantic v2 `eda.yaml` parser: project/sources/constraints/runs/qor/ip/remote |
| `workspace.py` | Create `runs/<timestamp>_<task>/` dirs, manage reports/checkpoints/scripts/artifacts |
| `command_runner.py` | Whitelisted command execution, blocks rm/sudo/curl_pipe, timeout control |
| `vivado_runner.py` | Three-mode Vivado execution: remote SSH -> local -> mock; 5 failure scenarios |
| `tcl_templates.py` | Generate synth/impl Tcl scripts from Manifest (non_project + project mode) |
| `qor_checker.py` | QoR gate: check WNS/TNS/DRC against manifest targets |
| `remote_runner.py` | Standalone SSH remote Vivado executor |
| `run_diff.py` | Compare two runs' timing/utilization, auto-mark improvements/regressions |

### 4. Parsers (`parsers/`)

| Module | Input | Output |
|---|---|---|
| `vivado_log_parser.py` | Vivado log text | `VivadoLogSummary` (error_count, top_error_signatures, messages) |
| `timing_parser.py` | Timing report | `TimingSummary` (WNS, TNS, WHS, THS) |
| `utilization_parser.py` | Utilization report | `UtilizationSummary` (LUT, FF, BRAM, DSP) |

All fault-tolerant: return None on parse failure, never raise.

### 5. Knowledge Base (`kb/`)

| File | Content |
|---|---|
| `error_cases.yaml` | 55 Vivado error patterns, each with regex + category + likely_causes + suggested_actions |
| `error_case_loader.py` | Load YAML as `ErrorCase` objects, `match_cases()` by signature |

Covers: synthesis / implementation / timing / constraint / DRC / IP / simulation.

### 6. Web Frontend (`web/`)

| File | Function |
|---|---|
| `app.py` | FastAPI factory, assembles routes |
| `terminal.py` | Core: SSE streaming chat endpoint + terminal-style HTML page with Markdown renderer |
| `dashboard.py` | Legacy dashboard API (runs, health, chat) |
| `hapi_bridge.py` | HAPI frontend compatibility layer (deprecated) |

**Terminal UI rendering pipeline:**
1. `agent.astream_events()` captures `on_tool_start`/`on_tool_end`/`on_chat_model_stream`
2. Events dispatched as SSE: `reasoning` / `response` / `tool_start` / `tool_end`
3. Browser `fetch()` -> ReadableStream -> SSE parse -> `handle()`
4. `tool_start`: creates collapsible Tool block + spinner + timer
5. `response`: silently accumulates buffer, no DOM rendering during streaming
6. `tool_start` (new tool): flush previous response buffer as Markdown
7. `done`: final response buffer rendered as Markdown
8. `renderMarkdown()`: custom pure-JS Markdown-to-HTML renderer

### 7. CLI (`cli.py`)

12 Typer commands:

```
edagent init-example        edagent ask                 edagent approve
edagent diagnose-log        edagent ask-multi           edagent web
edagent run-synth           edagent run-impl            edagent run-sim
edagent batch               edagent run-synth-project   edagent run-impl-project
```

### 8. Configuration

| File | Purpose |
|---|---|
| `.env` | Auto-loaded (python-dotenv): API key/URL/model/remote Vivado config |
| `configs/default.yaml` | Vivado toolchain defaults |
| `configs/vivado_2020_2.yaml` | Vivado 2020.2 specific config |
| `examples/uart_demo/eda.yaml` | Example project manifest |
| `examples/uart_full/eda.yaml` | Full UART project manifest |

### 9. Remote Execution Chain

```
edagent run-synth
  -> VivadoRunner (detects VIVADO_REMOTE_HOST)
    -> _remote_run():
      1. Tcl path rewrite (Windows absolute -> Linux relative)
      2. SCP upload RTL/XDC/Tcl to remote
      3. SSH execute: source settings64 && vivado -mode batch
      4. SCP download log to local
    -> Return structured result
```

Remote: `root@192.168.31.150`, Vivado 2022.1, SSH key `E:/dev/id_192.168.31.150`.

### 10. Project Structure

```
edagent-vivado/
├── pyproject.toml
├── .env / .env.example
├── README.md / arch.md
├── configs/
│   ├── default.yaml
│   └── vivado_2020_2.yaml
├── examples/
│   ├── uart_demo/
│   │   ├── eda.yaml
│   │   ├── rtl/uart_top.v
│   │   ├── constrs/top.xdc
│   │   └── logs/sample_vivado_error.log
│   └── uart_full/
│       ├── eda.yaml
│       ├── rtl/uart_{top,rx,tx}.v
│       └── constrs/arty.xdc
├── src/edagent_vivado/
│   ├── __init__.py
│   ├── cli.py
│   ├── config.py
│   ├── agent/
│   │   ├── model.py / graph.py / prompts.py
│   │   ├── supervisor.py / specialists.py
│   ├── harness/
│   │   ├── manifest.py / workspace.py / command_runner.py
│   │   ├── vivado_runner.py / tcl_templates.py
│   │   ├── qor_checker.py / run_diff.py / remote_runner.py
│   ├── parsers/
│   │   ├── vivado_log_parser.py / timing_parser.py / utilization_parser.py
│   ├── tools/
│   │   ├── file_tools.py / vivado_tools.py / report_tools.py / patch_tools.py
│   ├── kb/
│   │   ├── error_cases.yaml / error_case_loader.py
│   └── web/
│       ├── app.py / terminal.py / dashboard.py / hapi_bridge.py
├── .github/workflows/ci.yml
└── tests/ (95 tests)
```
