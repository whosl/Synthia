# Synthia Vivado Connector 使用说明

## 当前部署

```text
Endpoint: https://connect.wenzhuolin.xyz
Worker: vivado-66-xc7k70t
Host: DESKTOP-DVFFB09 / 192.168.31.66
Vivado: 2021.1 (SW Build 3247384)
Part: xc7k70tfbv676-1
Protocol: connector.remote.v1
Transport: direct_https

Project scope: p1
Classification scope: internal
```

66 上的 Worker 实际监听 `0.0.0.0:8443`。Cloudflare Tunnel 入口经 NAS 的 `synthia-origin-proxy` 转发，proxy 使用受控 client certificate 对 66 的 Worker 做 HTTPS/mTLS 回源。

## 重要安全边界

当前 Cloudflare 公网边缘 TLS、Cloudflare Access Service Auth 和 NAS 到 66 的 origin mTLS 均已启用。未携带 Service Token 的请求会在 Cloudflare 边缘返回 `403 Forbidden`，不会到达 Worker。

Access 应用：

```text
Application: Synthia Core Service Auth
Hostname: connect.wenzhuolin.xyz
Team: cool-surf-f1be
AUD tag: a1c0073d22df53d3a65282de2600f52bdd2b32611a719eb2b0c4ef6451b50f34
```

调用方必须从受控密钥存储读取 Service Token，并只通过 HTTPS headers 发送。仓库、日志、envelope 和普通配置中不得出现 token 值。

推荐环境变量名（仅由部署环境注入，不提交 `.env`）：

```text
SYNTHIA_CF_ACCESS_CLIENT_ID
SYNTHIA_CF_ACCESS_CLIENT_SECRET
```

请求 headers：

```text
CF-Access-Client-Id: <从受控密钥存储读取>
CF-Access-Client-Secret: <从受控密钥存储读取>
```

当前 Service Token 由用户决定继续用于调试，但 2026-08-07 的真实 `/registration` 与 `/discover` 请求仍被 Cloudflare Access 返回 `403`；它不得被视为已授权或正式可用。代码和文档只允许保存引用，不保存明文。


## Envelope

所有请求均为 `POST`，`Content-Type: application/json`，并且必须包含完整的 `connector.remote.v1` envelope：

```json
{
  "schema_version": "connector.remote.v1",
  "correlation_id": "corr-example-001",
  "idempotency_key": "idem-example-001",
  "actor": { "actor_type": "service", "actor_id": "synthia-core" },
  "project_id": "p1",
  "classification": "internal",
  "capability_version": "connector.remote.v1",
  "payload": {}
}
```

## Discovery

```bash
export SYNTHIA_CF_ACCESS_CLIENT_ID='<从受控密钥存储读取>'
export SYNTHIA_CF_ACCESS_CLIENT_SECRET='<从受控密钥存储读取>'
curl \
  -X POST https://connect.wenzhuolin.xyz/discover \
  -H 'Content-Type: application/json' \
  -H "CF-Access-Client-Id: ${SYNTHIA_CF_ACCESS_CLIENT_ID}" \
  -H "CF-Access-Client-Secret: ${SYNTHIA_CF_ACCESS_CLIENT_SECRET}" \
  --data-binary @discover-envelope.json
```

公网 Cloudflare 入口使用 Cloudflare/系统公共 CA 验证边缘证书，**不要**使用 Worker origin CA，也不要在公网请求上附加仅供内网直连 Worker 的 origin client certificate。只有内网直连 `192.168.31.66:8443` 时，才使用 Worker CA、client certificate 和 client key。

当前验收状态：Cloudflare Access Service Token 认证、`/registration → /heartbeat → /discover → exploratory Job → status/evidence` 全链路已在真实 66 主机验证通过。Worker 仅当 `ready` 且能力无漂移时接受任务；`formal`/`gate_check` 仍需完整审批上下文。

`/discover` 返回的能力版本为 `vivado-batch-1`。当前能力：

```text
discover_toolchain
query_parts
validate_sources
simulate
synthesize
implement
report_drc
report_sta
report_resources
```

`implement` 为单会话全链路：`synth_design → opt_design → place_design → route_design → DRC/STA/资源报告 → synth.dcp/routed.dcp → write_bitstream`，支持可选 XDC 约束（`.xdc`，写入 Job workspace 后在综合前 `read_xdc`）。输出 `synthia.bit`、两级 DCP 与三份报告。注意：无引脚约束的设计会在 `write_bitstream` 的 DRC（NSTD-1/UCIO-1）处按预期失败；smoke 场景须在 XDC 中显式降级该两项检查，真实工程必须提供完整引脚约束。

## 生命周期调用顺序

```text
POST /registration
POST /heartbeat
POST /discover
POST /jobs/submit
POST /jobs/status
POST /jobs/cancel
POST /jobs/evidence
```

只有 `ready` Worker 才允许正式的 `gate_check`/`formal` 提交。Worker 会拒绝未知项目、未知分类、未知 capability、能力版本漂移和不完整审批上下文。

## Job 提交

`/jobs/submit` 的 `payload` 形态：

```json
{
  "request": {
    "jobId": "job-example-001",
    "idempotencyKey": "job-example-001",
    "projectId": "p1",
    "operation": "synthesize",
    "runClass": "exploratory",
    "input": "<immutable-input-manifest-sha256>",
    "correlationId": "corr-job-example-001",
    "parameters": {
      "operation": "synthesize",
      "jobId": "job-example-001",
      "projectId": "p1",
      "runClass": "exploratory",
      "sources": [
        { "path": "top.v", "content": "module top; endmodule\n" }
      ],
      "top": "top",
      "part": "xc7k70tfbv676-1"
    }
  }
}
```

真实工程中 `parameters.sources` 应改为已登记的 immutable input manifest 引用，不能直接接受任意服务器本地路径。当前 adapter 会生成独立 Job workspace、固定 Tcl、日志/报告 Evidence 引用和 SHA-256。

## 当前真实验证

真实 66 主机（Vivado 2021.1 / patch 3247384 / xc7k70tfbv676-1）已完成：

- Vivado discovery、license available、8+1 项能力无漂移
- `validate_sources`：真实成功（`verify-validate-001`）
- `simulate`：XSim 真实仿真成功，含 `$fatal` 强断言 XOR 真值表验证（`verify-sim-002`、`verify-sim-fatal-002`）
- `synthesize`：真实综合成功（`verify-synth-003`）
- `implement`：`synth_design → opt/place/route → DRC/STA/资源报告 → 两级 DCP → write_bitstream` 全链路真实成功，`synthia.bit` 3,011,437 字节（`verify-implement-003`）；无约束设计在 `write_bitstream` DRC 处按预期 fail-closed（`verify-implement-002`）
- 失败路径：Worker 保留 `errorCode`、`worker-result.json` 与 SHA-256 EvidenceManifest

项目候选 `xc7vx690tffg1761-2` 不在 66 的 Vivado 2021.1 安装中；当前真实 profile 使用 `xc7k70tfbv676-1`。

## 本地开发/部署

本地构建 Worker bundle：

```bash
bun build connector/server.ts --target=node --outfile connector/server.bundle.mjs
```

66 部署目录：

```text
D:\synthia-worker\
├── server.bundle.mjs
├── worker-66.config.json
├── start-worker-66.cmd
├── workspaces\
└── evidence\
```

生产密钥文件不在仓库中：

```text
server.pfx
client.pfx
client-ca.cer
pfx-password.txt
```
