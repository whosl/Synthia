# EdAgent-Vivado

**Vivado RTL Debug Agent** — 基于 Python + LangChain + LangGraph 的 Xilinx Vivado RTL 调试智能体。
支持远程 Vivado 执行、终端风格 Web UI、流式 Tool Call 可视化、Markdown 渲染、55 条错误知识库。

> **版本:** v0.2.0 — 终端 UI + 远程 SSH Vivado + Multi-Agent + 流式渲染

**在线体验:** https://edagent.wenzhuolin.xyz/term

---

## 目录

- [项目目标](#项目目标)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [架构概览](#架构概览)
- [模块详解](#模块详解)
  - [Manifest 系统](#a-manifest-系统)
  - [Workspace 管理器](#b-workspace-管理器)
  - [Command Runner](#c-command-runner)
  - [Vivado Runner](#d-vivado-runner)
  - [Tcl 模板引擎](#e-tcl-模板引擎)
  - [Vivado Log Parser](#f-vivado-log-parser)
  - [Timing / Utilization Parser](#g-timing--utilization-parser)
  - [Error Case KB](#h-error-case-kb)
  - [LangChain Agent](#i-langchain-agent)
  - [CLI 命令行](#j-cli-命令行)
- [LangSmith Tracing](#langsmith-tracing)
- [Mock Vivado 模式](#mock-vivado-模式)
- [接入真实 Vivado](#接入真实-vivado)
- [运行测试](#运行测试)
- [项目结构](#项目结构)
- [当前限制](#当前限制)
- [路线图](#路线图)

---

## 项目目标

1. **受控执行** — agent 不能裸执行任意 shell，所有 Vivado 命令通过 allowlist 过滤
2. **结构化解析** — Vivado 日志、时序报告、利用率报告都有对应的 parser
3. **可追溯** — 每次运行创建时间戳工作目录，记录 manifest、artifacts、agent notes
4. **可插拔 LLM** — 通过 `ANTHROPIC_BASE_URL` 支持 Claude 官方接口或智谱 GLM 等兼容接口
5. **离线可开发** — 无 Vivado 环境时自动进入 mock 模式，生成仿真数据
6. **工程化** — 类型标注完整、logging 统一、测试覆盖核心路径

---

## 快速开始

### 1. 安装

```bash
cd edagent-vivado

# pip
pip install -e .[dev]
```

### 2. 配置 LLM

```bash
# Anthropic Claude
export ANTHROPIC_API_KEY=sk-ant-...

# 或智谱 GLM (Anthropic 兼容接口)
export ANTHROPIC_API_KEY=9ed5b817366148b6ac1f1f4cd6abd884.TtwwE7Otq4nxkMiJ
export ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
export EDAGENT_MODEL=GLM-5-turbo
```

或复制 `.env.example` 为 `.env` 填入后：

```bash
# .env 会被 python-dotenv 自动加载（后续版本）
# 当前版本请直接 export
```

### 3. 复制示例项目

```bash
edagent init-example
# 或指定路径
edagent init-example ./my_project
```

### 4. 运行诊断

```bash
# 解析 Vivado 日志并匹配 error KB
edagent diagnose-log examples/uart_demo/logs/sample_vivado_error.log

# 运行综合（mock 模式，不需要 Vivado）
edagent run-synth examples/uart_demo/eda.yaml
```

### 5. 启动 Agent

```bash
edagent ask examples/uart_demo/eda.yaml "为什么综合失败了？"
```

---

## 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | agent 模式必需 | — | Anthropic API key 或 GLM auth token |
| `ANTHROPIC_BASE_URL` | 否 | — | 自定义 API base URL（用于 GLM 等兼容接口） |
| `EDAGENT_MODEL` | 否 | `claude-sonnet-4-20250514` | 模型名 |
| `LANGSMITH_TRACING` | 否 | — | 设为 `true` 启用 LangSmith |
| `LANGSMITH_API_KEY` | 否 | — | LangSmith API key |
| `LANGSMITH_PROJECT` | 否 | — | LangSmith 项目名 |
| `VIVADO_PATH` | 否 | 自动查找 | `vivado` 二进制路径 |

---

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                         CLI (Typer)                      │
│  init-example │ diagnose-log │ run-synth │ ask           │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│                     Agent (LangChain)                    │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐ │
│  │  Model   │  │ Prompts  │  │ Tools (7 个)            │ │
│  │ Claude   │  │ System   │  │ - parse_vivado_log      │ │
│  │ / GLM    │  │ 提示词   │  │ - parse_timing          │ │
│  └──────────┘  └──────────┘  │ - parse_utilization     │ │
│                              │ - match_error_cases     │ │
│                              │ - read_file / grep      │ │
│                              │ - run_vivado_synth      │ │
│                              └────────────────────────┘ │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│                    Harness (受控层)                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐ │
│  │ Manifest │ │Workspace │ │Command   │ │ Vivado     │ │
│  │ (Pydantic│ │(目录管理) │ │Runner    │ │ Runner     │ │
│  │ eda.yaml)│ │          │ │(allowlist)│ │(mock/real) │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────────┘ │
│  ┌──────────┐ ┌────────────┐                            │
│  │ Tcl      │ │ Artifact   │                            │
│  │ Templates│ │ Store      │                            │
│  └──────────┘ └────────────┘                            │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│              Parsers & Knowledge Base                    │
│  ┌──────────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ Vivado Log   │ │Timing    │ │Utilization│ │Error   │ │
│  │ Parser       │ │Parser    │ │Parser    │ │Case KB │ │
│  └──────────────┘ └──────────┘ └──────────┘ └────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## 模块详解

### A. Manifest 系统

**文件:** `src/edagent_vivado/harness/manifest.py`

基于 Pydantic v2 的 `eda.yaml` 项目描述文件解析器。

**支持字段:**

| 字段 | 类型 | 说明 |
|---|---|---|
| `project.name` | str | 项目名 |
| `project.vivado_version` | str | Vivado 版本 |
| `project.part` | str | 器件型号，如 `xc7a50tfgg484-2` |
| `project.top` | str | 顶层模块名 |
| `project.flow` | str | 流程模式（`non_project` / `project`） |
| `sources.rtl` | list[str] | RTL 文件列表 |
| `sources.tb` | list[str] | Testbench 文件列表 |
| `sources.include_dirs` | list[str] | 包含目录 |
| `constraints.xdc` | list[str] | XDC 约束文件列表 |
| `runs.synth.enabled` | bool | 启用综合 |
| `runs.impl.enabled` | bool | 启用实现 |
| `qor_targets.wns_min` | float | WNS 最低要求 |
| `qor_targets.require_drc_clean` | bool | DRC 必须 clean |

**API:**

```python
from edagent_vivado.harness.manifest import Manifest

manifest = Manifest.load("examples/uart_demo/eda.yaml")
manifest.name()           # "uart_demo"
manifest.top()            # "uart_top"
manifest.part()           # "xc7a50tfgg484-2"
manifest.rtl_paths()      # [Path(".../uart_top.v")]
manifest.xdc_paths()      # [Path(".../top.xdc")]
```

---

### B. Workspace 管理器

**文件:** `src/edagent_vivado/harness/workspace.py`

每次运行创建 `runs/<timestamp>_<task_name>/` 目录，包含：

```
workspace/
├── input_manifest.yaml    # 输入的 manifest 副本
├── src/                   # 复制的源文件
├── scripts/               # 生成的 Tcl 脚本
├── reports/               # 报告输出
├── checkpoints/           # DCP 检查点
├── artifacts/             # 结构化结果 (JSON)
└── agent_notes/           # Agent 工作笔记
```

**API:**

```python
ws = Workspace(base_dir=".", task_name="synth")
ws.copy_sources(manifest)
ws.write_manifest(manifest)
ws.script_path("synth.tcl")
ws.report_path("timing.rpt")
ws.artifact_path("result.json")
ws.write_json(data, "summary")
```

---

### C. Command Runner

**文件:** `src/edagent_vivado/harness/command_runner.py`

受控命令执行器 - agent 不能裸执行任意 shell。

**Allowlist（白名单命令）:**

```
vivado, xvlog, xvhdl, xelab, xsim,
python, python3, verilator, slang,
verible-verilog-format, verible-verilog-lint,
head, tail, cat, wc, echo, ls, stat, which,
md5sum, sha256sum
```

**被拦截的危险模式（12 条）：**

| 模式 | 示例 |
|---|---|
| `rm -rf` | `rm -rf /` |
| `sudo` | `sudo vivado` |
| `curl \| bash` | `curl http://x.sh \| bash` |
| `wget -O- \| sh` | `wget ... -O- \| sh` |
| `dd of=` | `dd if=/dev/zero of=/dev/sda` |
| `> /dev/*` | `> /dev/null` |
| `chmod 777` | `chmod 777 /etc/passwd` |
| `chown` | `chown root:root /etc` |
| fork bomb | `:(){ :\|:& };:` |

**返回的 `CommandResult` 结构：**

```python
@dataclass
class CommandResult:
    command: str          # 原始命令
    cwd: str              # 工作目录
    return_code: int      # 返回码
    stdout_path: str      # stdout 文件路径
    stderr_path: str      # stderr 文件路径
    elapsed_sec: float    # 耗时
    timed_out: bool       # 是否超时
    error: str | None     # 错误信息
```

**使用方式:**

```python
runner = CommandRunner(workspace_root="/tmp/ws")
result = runner.run("vivado -mode batch -source run.tcl", timeout=7200)
if result.return_code != 0:
    print(f"Failed: {result.error}")
```

---

### D. Vivado Runner

**文件:** `src/edagent_vivado/harness/vivado_runner.py`

Vivado 运行器的核心职责：

1. **自动检测 Vivado** — 搜索 PATH 和常见安装路径
2. **Mock 自动降级** — 找不到 Vivado 时自动切换 mock 模式
3. **受控执行** — 通过 CommandRunner 执行，不直接 subprocess

**API:**

```python
runner = VivadoRunner(workspace=ws, manifest=manifest)
result = runner.run_synth()  # 返回 dict
result2 = runner.run_impl()  # 需要先 run_synth
```

**返回结构:**

```python
{
    "step": "synth",
    "success": True,
    "return_code": 0,
    "log": "/path/to/vivado_synth.log",
    "elapsed_sec": 42.5,
    "timed_out": False,
    "mock": False,          # True 表示 mock 模式
}
```

---

### E. Tcl 模板引擎

**文件:** `src/edagent_vivado/harness/tcl_templates.py`

自动从 Manifest 生成 Vivado Tcl 脚本。

**`generate_synth_tcl(manifest, workspace_root)` 生成：**

```tcl
read_verilog {/path/to/uart_top.v}
read_xdc {/path/to/top.xdc}
synth_design -top uart_top -part xc7a50tfgg484-2
write_checkpoint -force {checkpoints/post_synth.dcp}
report_timing_summary -file {reports/post_synth_timing_summary.rpt}
report_utilization -file {reports/post_synth_utilization.rpt}
report_drc -file {reports/post_synth_drc.rpt}
exit
```

**`generate_impl_tcl(manifest, workspace_root)` 生成：**

```tcl
open_checkpoint {checkpoints/post_synth.dcp}
opt_design
place_design
write_checkpoint -force {checkpoints/post_place.dcp}
route_design
write_checkpoint -force {checkpoints/post_route.dcp}
report_timing_summary -file {reports/post_impl_timing_summary.rpt}
report_utilization -file {reports/post_impl_utilization.rpt}
report_drc -file {reports/post_impl_drc.rpt}
exit
```

---

### F. Vivado Log Parser

**文件:** `src/edagent_vivado/parsers/vivado_log_parser.py`

**功能：**

- 提取 `ERROR` / `CRITICAL WARNING` / `WARNING`
- 提取消息 ID 如 `[Synth 8-439]`, `[Common 17-69]`, `[Place 30-574]`
- 生成去重的 `top_error_signatures`
- 支持 `[Synth8-439]` → `[Synth 8-439]` 格式归一化

**返回的 `VivadoLogSummary`：**

```python
@dataclass
class VivadoLogSummary:
    error_count: int               # ERROR 数量
    critical_warning_count: int    # CRITICAL WARNING 数量
    warning_count: int             # WARNING 数量
    messages: list[LogMessage]     # 详细消息列表
    top_error_signatures: list[str]  # 去重错误签名
```

**示例输出：**

```python
summary = load_and_parse("vivado.log")
# summary.error_count = 2
# summary.top_error_signatures = [
#   "[Synth 8-439] Module 'echo_handler' not found...",
#   "[Common 17-69] Command 'synth_design' failed"
# ]
```

---

### G. Timing / Utilization Parser

**文件:**
- `src/edagent_vivado/parsers/timing_parser.py`
- `src/edagent_vivado/parsers/utilization_parser.py`

**TimingSummary 字段:**

| 字段 | 来源 | 说明 |
|---|---|---|
| `wns` | `WNS` / `Worst Negative Slack` | 最差负时序余量 |
| `tns` | `TNS` / `Total Negative Slack` | 总负时序余量 |
| `whs` | `WHS` / `Worst Hold Slack` | 最差保持时间余量 |
| `ths` | `THS` / `Total Hold Slack` | 总保持时间余量 |

**UtilizationSummary 字段:**

| 字段 | 来源 | 说明 |
|---|---|---|
| `lut` | `Slice LUTs` / `LUT` | LUT 使用量 |
| `ff` | `Slice Registers` / `FF` / `Register` | 寄存器使用量 |
| `bram` | `Block RAM Tile` / `BRAM` | BRAM 使用量 |
| `dsp` | `DSPs` / `DSP48E1` | DSP 使用量 |

**容错设计：** 两个 parser 在解析失败时返回 `None` 而不是抛出异常。

---

### H. Error Case KB

**文件:**
- `src/edagent_vivado/kb/error_cases.yaml` — 知识库数据
- `src/edagent_vivado/kb/error_case_loader.py` — 加载器

**内置错误模式（7 条）：**

| 模式 | 分类 | 示例 |
|---|---|---|
| `[Synth 8-439]` | missing_module_or_bad_compile_order | 模块未找到 |
| `[Common 17-69]` | vivado_command_failed | 命令失败 |
| `[Opt 30-58]` | placement_constraint_conflict | Pblock 冲突 |
| `[Place 30-574]` | placement_congestion | 布局拥塞 |
| `[Route 35-*]` | routing_congestion_or_delay | 布线拥塞 |
| `[Timing 38-*]` | timing_violation | 时序违例 |
| `DRC violation` | drc_violation | DRC 违例 |

每条模式包含：
- `pattern`: 正则匹配式
- `category`: 分类标记
- `likely_causes`: 可能原因列表
- `suggested_actions`: 建议动作列表

**API:**

```python
from edagent_vivado.kb.error_case_loader import load_cases, match_cases

cases = load_cases()
matches = match_cases(["[Synth 8-439] Module 'xxx' not found"])
for case, sig in matches:
    print(case.category)       # "missing_module_or_bad_compile_order"
    print(case.likely_causes)  # ["RTL 文件没有加入 sources", ...]
```

---

### I. LangChain Agent

**文件:**
- `src/edagent_vivado/agent/model.py` — LLM 初始化
- `src/edagent_vivado/agent/prompts.py` — 系统提示词
- `src/edagent_vivado/agent/graph.py` — Agent 图构建

**技术栈:**

- `langchain.agents.create_agent`（LangChain 1.3+ 推荐写法，非过时的 `initialize_agent`）
- `langchain_anthropic.ChatAnthropic`
- LangGraph CompiledStateGraph（`create_agent` 内部使用）
- LangSmith tracing（通过环境变量自动启用）

**注册工具（7 个）：**

| 工具 | 函数 | 说明 |
|---|---|---|
| `read_file_tool` | `read_file(path)` | 读取任意文件内容 |
| `grep_tool` | `grep(pattern, root)` | 在项目文件中搜索模式 |
| `parse_vivado_log_tool` | `parse_log(log_path)` | 解析 Vivado 日志 |
| `parse_timing_tool` | `parse_timing(report_path)` | 解析时序报告 |
| `parse_utilization_tool` | `parse_utilization(report_path)` | 解析利用率报告 |
| `match_error_cases_tool` | `match_cases(error_signatures)` | 匹配 error KB |
| `run_vivado_synth_tool` | `run_synth(manifest_path)` | 运行综合 |

**系统提示词强调：**

- 每次诊断必须输出：现象 → 证据 → 可能根因 → 建议动作 → 下一步验证
- 禁止编造 Vivado 运行结果
- 禁止建议大规模重构
- 基于 log/report/manifest 证据回答

**使用方式：**

```python
from edagent_vivado.agent.graph import create_agent, invoke_agent

agent = create_agent()
response = invoke_agent(agent, "为什么综合失败了？")
print(response)
```

**LLM 兼容性：**

通过 `ANTHROPIC_BASE_URL` 环境变量，可切换到任何兼容 Anthropic API 的接口：

```bash
# 智谱 GLM-5-turbo
export ANTHROPIC_API_KEY=9ed5b817366148b6ac1f1f4cd6abd884.TtwwE7Otq4nxkMiJ
export ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
export EDAGENT_MODEL=GLM-5-turbo
```

已验证：GLM-5-turbo 可正常完成 agent smoke test（工具调用 + 日志分析）。

---

### J. CLI 命令行

**文件:** `src/edagent_vivado/cli.py`

基于 Typer 的 4 个命令：

#### `edagent init-example [target_dir]`

复制 `examples/uart_demo` 示例项目到指定目录。

```bash
edagent init-example ./my_project
# 创建 ./my_project/uart_demo/ 包含 eda.yaml / rtl / constrs / logs
```

#### `edagent diagnose-log <log_path>`

解析 Vivado 日志并输出诊断报告。

```bash
edagent diagnose-log examples/uart_demo/logs/sample_vivado_error.log
```

输出包含：
- 错误/严重警告/警告 统计
- 去重的 error signatures
- KB 匹配结果（分类、可能原因、建议动作）

#### `edagent run-synth <manifest_path>`

运行综合（或 mock 综合）。

```bash
edagent run-synth examples/uart_demo/eda.yaml
```

流程：
1. 创建时间戳 workspace
2. 复制源文件和 manifest
3. 生成 Tcl 脚本
4. 执行 Vivado（或 mock）
5. 输出 JSON summary 到 artifacts/

#### `edagent ask <manifest_path> "<question>"`

启动 LangChain agent。

```bash
edagent ask examples/uart_demo/eda.yaml "为什么综合失败了？"
```

agent 会自主调用工具读取 log、报告、manifest，给出诊断报告。

---

## LangSmith Tracing

```bash
export LANGSMITH_TRACING=true
export LANGSMITH_API_KEY=lsv2_...
export LANGSMITH_PROJECT=edagent-vivado
```

未设置 `LANGSMITH_API_KEY` 时 tracing 自动静默禁用，不会崩溃。

---

## Mock Vivado 模式

当系统找不到 `vivado` 时，`VivadoRunner` 自动进入 mock 模式：

**Mock 综合生成的文件：**

```
workspace/
├── checkpoints/post_synth.dcp          # "MOCK CHECKPOINT"
├── reports/post_synth_timing_summary.rpt  # WNS=0.123, TNS=0.000
├── reports/post_synth_utilization.rpt     # LUT: 1234, FF: 567
├── reports/post_synth_drc.rpt             # No violations
└── vivado_synth.log                       # 模拟 log
```

**Mock 实现生成的文件：**

```
workspace/
├── checkpoints/post_place.dcp
├── checkpoints/post_route.dcp
├── reports/post_impl_timing_summary.rpt   # WNS=0.089
├── reports/post_impl_utilization.rpt      # LUT: 1300, FF: 600
├── reports/post_impl_drc.rpt
└── vivado_impl.log
```

所有 mock 返回码为 0（成功）并记录 `"mock": True`。

---

## 接入真实 Vivado

```bash
# 方式 1: PATH 中存在 vivado
which vivado  # /opt/Xilinx/Vivado/2022.1/bin/vivado

# 方式 2: 设置环境变量
export VIVADO_PATH=/opt/Xilinx/Vivado/2022.1/bin/vivado

# 方式 3: 远程服务器
# 目前 VivadoRunner 是本地执行，远程需自行扩展
```

`CommandRunner` allowlist 已包含 `vivado`。也可以将 `vivado` 完整路径传入：

```python
runner = VivadoRunner(
    workspace=ws,
    manifest=manifest,
    vivado_path="/opt/Xilinx/Vivado/2022.1/bin/vivado",
)
```

---

## 运行测试

```bash
# 全部测试（agent smoke 需要 ANTHROPIC_API_KEY）
python -m pytest

# 只跑非 agent 测试
python -m pytest -k "not agent_smoke"

# 详细输出
python -m pytest -v

# 指定文件
python -m pytest tests/test_command_runner.py -v
python -m pytest tests/test_vivado_log_parser.py -v
python -m pytest tests/test_manifest.py -v

# agent smoke（需 API key）
python -m pytest tests/test_agent_smoke.py -v
```

**测试覆盖：**

| 测试文件 | Tests | 覆盖内容 |
|---|---|---|
| `test_manifest.py` | 7 | YAML 加载、sources、constraints、runs、默认值、tb_paths、IP |
| `test_vivado_log_parser.py` | 7 | 错误计数、message ID 提取、空日志、file I/O |
| `test_command_runner.py` | 12 | allowlist 验证、12 种危险模式拦截、错误返回 |
| `test_agent_smoke.py` | 5 | LLM 创建、工具调用、agent 诊断（需 API key） |
| `test_parsers.py` | 8 | Timing 解析（正负值、格式）、Utilization 解析 |
| `test_qor_checker.py` | 6 | WNS/TNS/DRC/Utilization QoR 检查 |
| `test_mock_failure.py` | 7 | 5 种 mock 失败场景 + 成功场景 |
| `test_error_kb.py` | 10 | 50+ 模式加载、8 类错误匹配 |
| `test_batch_and_diff.py` | 5 | Batch 并行/串行、报告输出、Run diff |
| `test_integration.py` | 7 | Workspace、Runner、Simulation、Log parser 集成 |

---

## 项目结构

```
edagent-vivado/
├── pyproject.toml                     # 项目配置和依赖
├── README.md                          # 本文档
├── .env.example                       # 环境变量模板
├── .env                               # 环境变量（已配置 GLM-5-turbo）
├── configs/                           # YAML 工具配置
│   ├── default.yaml                   # 默认配置
│   └── vivado_2020_2.yaml             # Vivado 2020.2 配置
├── examples/uart_demo/                # 示例项目
│   ├── eda.yaml                       # 项目 manifest
│   ├── rtl/uart_top.v                 # RTL（含缺失模块引用）
│   ├── constrs/top.xdc                # 管脚约束
│   └── logs/sample_vivado_error.log   # 示例错误日志
├── src/edagent_vivado/                # 主代码
│   ├── __init__.py                    # 版本信息
│   ├── cli.py                         # Typer CLI (4 个命令)
│   ├── config.py                      # YAML + env 配置加载
│   ├── agent/                         # LangChain 智能体
│   │   ├── __init__.py
│   │   ├── graph.py                   # Agent 图 + 工具绑定
│   │   ├── model.py                   # LLM 初始化 (ChatAnthropic)
│   │   └── prompts.py                 # 系统提示词
│   ├── harness/                       # 受控执行层
│   │   ├── __init__.py
│   │   ├── manifest.py                # Pydantic eda.yaml 模型
│   │   ├── workspace.py               # 时间戳工作目录管理
│   │   ├── command_runner.py          # Allowlist 命令执行器
│   │   ├── vivado_runner.py           # Vivado / Mock 运行器
│   │   ├── tcl_templates.py           # Tcl 脚本生成器
│   │   └── artifact_store.py          # JSON/文本持久化
│   ├── parsers/                       # 解析器
│   │   ├── __init__.py
│   │   ├── vivado_log_parser.py       # Vivado 日志解析
│   │   ├── timing_parser.py           # 时序报告解析
│   │   └── utilization_parser.py      # 利用率报告解析
│   ├── tools/                         # LangChain 工具
│   │   ├── __init__.py
│   │   ├── file_tools.py              # read_file / grep
│   │   ├── vivado_tools.py            # run_vivado_synth
│   │   └── report_tools.py            # parse_log / timing / utilization / match_cases
│   └── kb/                            # 知识库
│       ├── __init__.py
│       ├── error_cases.yaml           # 7 条错误模式
│       └── error_case_loader.py       # 加载 / 匹配引擎
└── tests/                             # 测试
    ├── __init__.py
    ├── test_manifest.py               # Manifest 测试
    ├── test_vivado_log_parser.py      # Log parser 测试
    ├── test_command_runner.py         # Command runner 测试
    └── test_agent_smoke.py            # Agent smoke 测试
```

---

## 当前限制

- **无多轮自主修复** — agent 当前可以诊断和建议，但 auto-fix 需要用户确认
- **Mock 报告精简** — 刚刚够解析，不模拟真实数据分布
- **Web 仪表盘基础** — 运行历史和基本 API，UCI 交互待完善
- **无增量综合** — 每次从头运行（Vivado incremental 待接入）
- **远程执行需 SSH 密钥** — paramiko 可选依赖

---

## 路线图

| 版本 | 计划 |
|---|---|
| **v0.2** ✅ | 多 agent 编排（supervisor + synthesis/timing/constraint 专家）|
| **v0.3** ✅ | Vivado project 模式、IP 集成（XCI 管理）、仿真、远程 SSH、diff 对比 |
| **v0.4** ✅ | 50+ Error KB、批量运行、CI/CD、Web 仪表盘、patch 审批 |
| **v0.5** | 增量综合、真实 mock 数据生成器、property-based testing |
| **v1.0** | 生产就绪：完善 error KB、完整文档、性能基准、安全审计 |

---

## v0.2.0 新功能

### 多 Agent 架构
- **Supervisor agent** — 自动路由问题到综合/时序/约束专家
- **Synthesis specialist** — 专注综合错误诊断
- **Timing specialist** — 专注时序收敛分析
- **Constraint specialist** — 专注 XDC 约束问题
- 命令: `edagent ask-multi`

### Mock 失败注入
- 5 种失败场景: `synth_8_439`, `timing_violation`, `place_30_574`, `drc_violation`, `route_35`
- 命令: `edagent run-synth --mock-fail synth_8_439`

### Vivado 深度集成
- **Project 模式** — `run-synth-project` / `run-impl-project`
- **Simulation** — `run-sim` 调用 xvlog/xelab/xsim
- **IP 管理** — IpManager 处理 XCI 生成
- **Synthesis 策略** — `--directive` / `--retiming`
- **Run 对比** — `diff_runs()` 对比两次运行

### 远程执行
- RemoteVivadoRunner — SSH 到远程服务器运行 Vivado
- 支持: `ssh root@192.168.31.150 -i key`

### 批量运行
- BatchRunner — 并行/串行跑多个 manifest
- 自动收集 WNS/TNS/LUT/FF 对比
- 命令: `edagent batch --strategies Default,AreaOptimized`

### 50+ Error KB
- 覆盖: Synth / Place / Route / Timing / DRC / IP / Simulation / Methodology

### Web 仪表盘
- FastAPI 后端，运行历史和结果浏览
- 命令: `edagent web`
- API: `/api/runs`, `/api/health`

### Streaming & Memory
- Agent 响应逐 token 流式输出
- LangGraph MemorySaver 多轮对话持久化
- 命令: `edagent ask --stream --thread my-session`

### Patch 审批
- Agent 可以 propose 和 apply 文件修改
- `edagent approve --on` 启用自动应用
- `propose_patch_tool` / `create_file_tool`

---

## License

MIT
