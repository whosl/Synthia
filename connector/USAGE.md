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

当前 Cloudflare 公网边缘 TLS 已启用，origin 到 66 的 mTLS 已启用；但 Cloudflare Access/service-token 身份层尚未配置。因此公网入口不能视为 Core 到 Worker 的端到端 mTLS，不能把它用于 formal、gate_check 或任何敏感项目正式运行。

正式接入前应至少完成一项：

1. 为 `connect.wenzhuolin.xyz` 配置 Cloudflare Access service-token/application；或
2. 让 Core 使用专用身份代理，并在 Worker 前置层验证 Core 身份；或
3. 只在内网/VPN 中使用 66 的直接 mTLS 地址。

不要把 client PFX、私钥、PFX 密码或 CA 私钥提交到 GitHub。当前证书只存在 66 和 NAS 的受控目录。

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
curl --cert <client-cert.pem> --key <client-key.pem> --cacert <worker-ca.pem> \\
  -X POST https://connect.wenzhuolin.xyz/discover \\
  -H 'Content-Type: application/json' \\
  -d @discover-envelope.json
```

`/discover` 返回的能力版本为 `vivado-batch-1`。当前能力：

```text
discover_toolchain
query_parts
validate_sources
simulate
synthesize
report_drc
report_sta
report_resources
```

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

真实 66 主机已完成：

- Vivado discovery
- `get_parts` 查询
- Synthesis license checkout
- XSim 编译/展开/运行
- 最小综合
- DRC、STA、资源报告
- DCP 生成

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
