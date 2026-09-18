# Vivado MCP 使用说明

## 当前部署（2026-09-18 实测）

```text
Host:      66（DESKTOP-DVFFB09 / 192.168.31.66，tailscale 100.96.223.49）
Endpoint:  http://192.168.31.66:8450/mcp（stateless HTTP Stream，Bearer token）
Vivado:    2021.1 (SW Build 3247384)，D:\Xilinx\Vivado\2021.1\bin\vivado.bat
Runtime:   Node v24.14.1（bundle --target=node）
常驻:      计划任务 vivado-mcp（onlogon，/RU admin）→ D:\vivado-mcp\run-mcp.cmd
Token:     生成于部署机，存 66 的 D:\vivado-mcp\token.txt（勿入仓库；本地参考副本 vivado-mcp/.deploy-token，已 gitignore）
日志:      D:\vivado-mcp\server.log；workspace 在 D:\vivado-mcp\workspaces\
验证:      run_tcl 经真 Vivado 2021.1 batch 执行成功（version -short → 2021.1，~4 s）
```

重启 66 后服务在 admin 登录时自动拉起；手动重启顺序（vault 2026-08-26 教训）：先按 PID `taskkill /F` 杀旧 node，再 `schtasks /Run /TN vivado-mcp`。

## 定位

独立 Vivado MCP 服务器：基于 [fastmcp](https://github.com/punkpeye/fastmcp)（TypeScript 版）的 HTTP Stream MCP 端点，每个请求校验 Bearer token，通过 `run_tcl` 工具执行**任意 Vivado TCL 脚本**（覆盖全部 TCL 指令），另有版本/器件查询与 workspace 产物读取等便利工具。

```text
Server:    vivado-mcp
Transport: HTTP Stream (stateless), endpoint /mcp
Auth:      Authorization: Bearer <VIVADO_MCP_TOKEN>（每请求校验，常量时间比较）
Runtime:   Bun 1.4.1（bundle 兼容 Node）
Target:    装有 Vivado 的机器（当前为 66：DESKTOP-DVFFB09，Vivado 2021.1，xc7k70tfbv676-1）
```

## 重要安全边界

- **`run_tcl` 执行任意 TCL，等价于设计上的主机代码执行**（TCL 的 `exec`、文件写、`write_bitstream` 烧录均可达）。Bearer token 是唯一安全边界，请按生产密钥对待：
  - 只通过环境变量注入，不写入仓库、日志、配置或客户端配置文件的明文示例；
  - 服务默认只绑定 `127.0.0.1`，对外开放（`VIVADO_MCP_HOST=0.0.0.0`）前必须置于 TLS 反向代理或受控网络之内。
- 本服务**刻意位于 Synthia 受治理链路之外**。Synthia 的正式 FPGA 流程仍走 Core → connector worker（Cloudflare Access + mTLS + EvidenceManifest 治理）；按 `specs/001-agent-freedom` 的边界，Synthia 内部 agent 不持有 MCP 连接，skill catalog 也拒绝 `mcp__*` 命名。本 MCP 是面向人工控制客户端的工具，不进入治理审计。
- 传输仅 HTTP Stream；stdio 无 HTTP 请求上下文、无法携带 token，本服务不提供该模式（构造性 fail-closed）。
- 启动 fail-closed：`VIVADO_MCP_TOKEN` 缺失/为空/非法时进程以稳定错误码退出（exit 2，stderr 输出 `VIVADO_MCP_LAUNCH_FAILED:<CODE>`），不会以无鉴权状态起服务。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `VIVADO_MCP_TOKEN` | （必填） | Bearer token；缺失/为空拒绝启动 |
| `VIVADO_MCP_HOST` | `127.0.0.1` | 监听地址 |
| `VIVADO_MCP_PORT` | `8450` | 监听端口 |
| `VIVADO_BINARY` | `vivado` | Vivado 可执行文件；Windows 上建议写绝对路径如 `D:/Xilinx/Vivado/2021.1/bin/vivado.bat` |
| `VIVADO_MCP_WORKSPACE_ROOT` | `./vivado-mcp-workspaces` | workspace 根目录 |
| `VIVADO_MCP_MAX_CONCURRENCY` | `1` | 并发 Vivado batch 进程上限（FIFO 排队） |
| `VIVADO_MCP_SCRIPT_MAX_BYTES` | `1048576` | 单次脚本大小上限（1 MiB） |
| `VIVADO_MCP_OUTPUT_MAX_BYTES` | `204800` | 返回 stdout/stderr 与可读文件的大小上限（200 KiB） |

启动错误码：`TOKEN_MISSING` / `TOKEN_EMPTY` / `TOKEN_TOO_LONG` / `TOKEN_INVALID` / `INVALID_HOST` / `INVALID_PORT` / `INVALID_MAX_CONCURRENCY` / `INVALID_SCRIPT_MAX_BYTES` / `INVALID_OUTPUT_MAX_BYTES` / `INVALID_VIVADO_BINARY` / `INVALID_WORKSPACE_ROOT`。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `run_tcl` | `script`，可选 `workspace`、`timeout_ms` | 在全新 `vivado -mode batch` 进程中执行任意 TCL 脚本；默认超时 30 min（上限 2 h） |
| `vivado_version` | — | `version -short` 包装，廉价连通性探测 |
| `list_parts` | 可选 `pattern` | `get_parts <glob>` 包装 |
| `list_workspace_files` | `workspace` | 列出 workspace 内全部文件与大小 |
| `read_workspace_file` | `workspace`、`path` | 读取 workspace 内文本文件（报告/日志） |

执行模型（与 connector 的 batch 约定一致）：

- 每次 `run_tcl` 是独立 batch 进程，**无进程内状态**；跨调用状态只存在于 workspace 文件中——同一 `workspace` 参数可链式操作：
  1. `run_tcl(script="synth_design ...; write_checkpoint input/synth.dcp", workspace="uart")`
  2. `run_tcl(script="open_checkpoint input/synth.dcp; opt_design ...", workspace="uart")`
- 脚本 cwd = workspace 根，`input/`、`output/` 子目录已存在；workspace 布局与 connector 相同（`run.tcl`、`output/stdout.log|stderr.log|tool.log|run-meta.json`）。
- 判定成功要求 **exit 0 且脚本跑到末尾哨兵**；Vivado batch 在 TCL 报错时也可能 exit 0，哨兵缺失即判 `failed`（`VIVADO_MCP_SENTINEL_MISSING`）。
- 返回的 stdout/stderr 超过上限时头尾截断，全量始终在 `output/*.log`。
- 超时返回 `status:"timeout"` 并按进程树强杀（复用 connector 的跨平台进程守护：Linux 进程组 / Windows Job Object，兼容 `vivado.bat`）。

## 运行

```bash
cd vivado-mcp
bun install
VIVADO_MCP_TOKEN='<从受控密钥存储读取>' bun run start
# vivado-mcp listening on http://127.0.0.1:8450/mcp (Bearer token required)
```

健康检查（无鉴权，仅回 `ok`）：

```bash
curl http://127.0.0.1:8450/health
```

MCP 调用（stateless，无需先 initialize；JSON 或 SSE 应答均可）：

```bash
curl -X POST http://127.0.0.1:8450/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer ${VIVADO_MCP_TOKEN}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_tcl","arguments":{"script":"puts [version -short]"}}}'
```

无 token 或 token 错误 → `401`。

### Claude / MCP 客户端配置

```json
{
  "mcpServers": {
    "vivado": {
      "type": "http",
      "url": "http://<host>:8450/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

注意客户端默认 MCP 超时远小于 Vivado 长任务时长；建议把流程拆成多条短 `run_tcl` 链式调用并显式传 `timeout_ms`，用 `list_workspace_files`/`read_workspace_file` 取中间产物。

## 构建 / 测试

```bash
cd vivado-mcp
bun run check   # tsc --noEmit
bun test        # 35 项测试，无需安装 Vivado（注入 fake runner）
bun run build   # dist/vivado-mcp.bundle.mjs（--target=node，单文件，可拷贝部署）
```

Windows 目标机可用 `start-vivado-mcp.cmd` 启动（env 预检 + 稳定错误码，风格同 connector 的 `start-worker-66.cmd`）。

## 与 connector 的关系

- **不是** connector worker 的代理：直接 spawn 本地 Vivado，不经 Cloudflare/mTLS/EvidenceManifest 治理链路。
- 复用 `connector/vivado.ts` 的能力：`createVivadoProcessGuardian`（进程树守护、Windows Job Object、`vivado.bat` 解析）、超时常量（默认 30 min / 上限 2 h）、workspace 与日志证据布局、`commandRunner` 注入测试模式。
- 依赖独立：`fastmcp`/`zod` 只装在本目录，仓库根 `bun.lock` 不受影响；根级 `bun test`/`check` 目标不含本目录。
