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

## M4-F Worker release 与 evolution-eval ledger

仓库中的 `server.bundle.mjs` 是部署输入，不得用旧 bundle、临时单次构建或源码存在差异的 bundle 覆盖正式 Worker。正式 release 只能在 clean commit 上、使用与 Windows Gate 相同且固定为 Bun `1.3.14` 的 runtime 构建：

```bash
bun connector/scripts/build-worker-release.ts --output <全新的-release-目录>
```

builder 先读取 `git status --porcelain=v1 -z --untracked-files=all` 的原始 bytes，再依据 Bun metafile 将实际 bundle inputs、lock/package/bunfig 和 release 输入复制到不可变临时 snapshot；复制前后任一 source hash 或 Git status 改变都会失败。随后只从 snapshot 连续构建两次并要求字节完全一致，扫描所有文本 release 文件中的秘密和 bundle 中的 Windows/Unix 构建机绝对路径，冻结 source、bundle、Bun runtime、配置模板、launcher 与 Windows certifier 的 SHA-256。输出的 A 层 `worker-release.manifest.json` schema 为 `synthia-worker-release-manifest.v1`；`source_state=clean|dirty` 与 `git_status_sha256` 明确 provenance，clean 状态固定为空 bytes SHA-256。A 层不含数据库 identity、endpoint 授权、epoch 或秘密。Core 的 M4-F harness 另行生成 B 层 `synthia-evolution-eval-f0-certification.v2`，引用 A 层 canonical hash，并独立绑定 active config hash、实际 remote observation、Gate 数据库、endpoint、ledger epoch、never-accepted canary、dirty release 授权、正式 Vivado attestation/full-tree/profile 与远端认证授权。只有 B 层通过时才可能打开 new-effects gate。

`--allow-dirty` 与 `--allow-non-windows` 只允许专用 M4-F Gate 或本地自动测试使用。dirty A 层必须在 B 层以 `dirty_release_authorized=true` 单独授权；正式生产 release 拒绝 dirty。A 层中 `sdk_worker_build_hash` 必须严格等于最终 `server.bundle.mjs` SHA-256；配置是 bundle 外部文件，禁止把该 hash 写入 bundle 造成自引用。

### Windows 固定 runtime 与启动边界

`start-worker-66.cmd` 的生产默认只执行绝对路径：

```text
D:\synthia-worker\runtime\bun-1.3.14\bun.exe
```

禁止 `PATH` fallback、Node fallback 或任意其他 Bun 版本。Gate staging 可以显式设置绝对的 `SYNTHIA_WORKER_ROOT`、`SYNTHIA_WORKER_BUN` 和 `SYNTHIA_WORKER_CONFIG`，因此不需要写入既有 `D:\synthia-worker`；未设置时才使用上述生产默认。`SYNTHIA_WORKER_SERVICE_IDENTITY` 与 `SYNTHIA_WORKER_LOG_ROOT` 必填；前者须与 Windows supervisor 的真实运行主体一致，后者须精确等于 active config 的 `evolution_eval_log_root`。

launcher 先检查 release 文件和 Bun 版本，再运行 `certify-m4f-windows.ps1 -Mode LaunchPreflight`。preflight 会把当前 Windows token SID 与 `SYNTHIA_WORKER_SERVICE_IDENTITY` 解析后的 SID 做精确比较，并拒绝 SYSTEM、Administrators 或任何 Administrators 直接或嵌套组成员作为 Worker service identity；嵌套组无法完整解析时 fail closed，管理员 shell 只传同名参数不能冒充服务身份。release、bundle、manifest、config、launcher、certifier、Bun、TLS、attestation 与 PFX 密码文件是只读 trust anchors：service identity 必须有精确 Read & Execute/Synchronize，但不得拥有写、删、改 ACL 或夺取所有权；service SID 也不属于祖先可信写者，因此不能借父目录 `DeleteChild` 替换只读文件。`workspace/evidence/ledger/spool/log` 是五个彼此不重叠的 mutable roots：只允许 Administrators、SYSTEM 与 service identity，service identity 获得精确 Modify/Synchronize 以完成 create/write/fsync/atomic rename/delete；mutable root 本身用专用 ACL 验证，祖先仍按 immutable replacement boundary 验证。launcher 在 mutable log root 被证明可信前不会向任何文件写日志；所有早期失败均在 stderr 输出稳定的 `SYNTHIA_WORKER_LAUNCH_FAILED:<CODE>`，由冻结的 supervisor 原样采集，Worker 与后续校验日志只写 config 绑定的 mutable log root，绝不写 release root。完整祖先链仍逐级拒绝 reparse point、不可信 owner，以及非可信主体对当前祖先的 `Delete`/`DeleteChild`/改 DACL/夺取所有权。certifier 同时重算 A 层 canonical hash。只有 identity、hash、local fixed NTFS、ACL 和至少 10 GiB guest free space均通过后，launcher 才复算 active config SHA-256、设置 `SYNTHIA_WORKER_CONFIG_SHA256`、读取 PFX 密码并启动 Worker。eval-enabled initialize/verify/listen 即使没有旧的 `SYNTHIA_WORKER_VERIFY_BUNDLE` 开关，也会无条件验证 active config 和实际执行 bundle bytes；config 中的声明值不能替代运行产物证明。

`ToolchainImage` 创建前将 source tree bytes + 20 GiB 按 1 MiB 向上对齐，并以同一溢出安全的值作为 host free-space 下限、New-VHD `SizeBytes`、diskpart `maximum` 和 ceremony evidence；绝不向下取整。运行期 live mapping probe 重验 host free space 至少为 attested tree bytes + 20 GiB。VHDX 内 guest 始终至少保留 10 GiB。任何 preflight 失败都不得绕过。生产 secret 只从受控存储或 `pfx-password.txt` 注入，不能出现在配置、manifest、日志或仓库中。

### 只读 Vivado image 与 attestation

Gate eval 不能直接执行可写的 `D:\Xilinx\Vivado\2021.1`。`ToolchainImage` ceremony 只在显式 `-ConfirmCreateToolchainImage`、路径参数完整且当前 token 是 SYSTEM 或已提升的 Administrators 时继续；紧接着还会拒绝 service identity 解析为 SYSTEM 或 Administrators。两道身份门都在读取或修改 backing ACL、创建工作目录、生成 source manifest 或 New-VHD 之前执行，LocalService、普通用户和 filtered administrator token 不能作为 ceremony 主体，SYSTEM/Administrators 也不能伪装成只读 Worker identity。ceremony 随后于专用且关闭继承的 backing directory 新建单一、非 differencing 的动态 VHDX；backing directory 和 VHDX 的 owner 不能是 service identity，ceremony 会先移除其既有 allow ACE，再在 parent 上授予可继承的精确 Read & Execute/Synchronize、在 VHDX 上授予精确 Read & Execute/Synchronize，并拒绝任何额外、write/delete/改 ACL 权限。新格式化 volume root 只有在盘符根、NTFS、`SynthiaVivado` 卷标以及 Format-Volume 返回的 UniqueId/serial 全部精确匹配时，才允许丢弃默认 ACL 并一次性初始化为 protected DACL：Administrators 与 SYSTEM 可继承 FullControl，service identity 可继承精确 Read & Execute/Synchronize；任何额外、重复、继承或 deny ACE 都会失败，普通已有目录不能进入该初始化路径。它再验证 host 具备 source bytes + 20 GiB、生成 source-before manifest，以不复制 source security 的 `robocopy /COPY:DAT /DCOPY:DAT` 复制，递归关闭目标 ACL 继承，并在 `V:\Vivado` 全树逐项给 `SYNTHIA_WORKER_SERVICE_IDENTITY` 添加同样的显式最小读取权限，最后验证 source-after/target manifest 完全相同及 guest 至少 10 GiB 后 detached。`ToolchainAttestation` ceremony 在打开 VHDX 前会再次验证 backing parent/VHDX 的 owner 分离和 service exact-read/no-mutation ACL，再对该既有 detached image 持有 `FileShare.Read` 长寿命 handle（拒绝并发 write/delete），生成 source 前后及只读 target 的 `synthia-vivado-full-tree-manifest.v1`，拒绝 reparse、alternate stream、case-fold/Unicode 冲突与逐项 hash 漂移；随后只读 attach，核对 pre/post file identity、disk/partition/volume/mapping、写探针、全树 protected ACL 与 service-only RX、Authenticode evidence，并运行真实 2021.1/SW 3247384/IP 3246043、part、license/minimal synth probes。它不会连接硬件。

输出的 `synthia-vivado-toolchain-attestation.v1` 最长有效 4h。active config 在 eval enabled 时必须填写 `vivado_toolchain_attestation_path` 和原始文件 `vivado_toolchain_attestation_sha256`，且 `vivado_binary` 必须指向该证明的只读 mount。launcher 与 Worker 各自重读、rehash、strict-parse；Worker discovery/preflight 回显 raw SHA 与 live mapping health，reserve/submit 同时绑定 config SHA、process UUID、toolchain SHA。query/cancel/evidence/ack/quarantine/cleanup/retention 只依赖 durable job/epoch，不因当前 attestation 过期或 mapping 漂移而停止恢复。

两种 ceremony 都要求显式确认且拒绝覆盖已有 VHDX/工作目录；它们不能替代 Gate 前由非管理员完成的 detach/remount/delete/rename/replace/mapping 负例。每次重新 attach 都必须重新生成 attestation 与 B v2；在 new effects 关闭、job/retention 收敛、Worker/Vivado 全部停止前不得 detach。

`ToolchainAttestation` 是独立长驻的 lock supervisor，不得从会随 SSH teardown 的交互式 PowerShell 启动。Gate 必须用预先冻结的 Windows Scheduled Task（或同等 managed supervisor）运行：固定管理员/SYSTEM identity、完整 PowerShell 命令与参数、working directory、禁止并行实例、失败不自动换参数重试，并保存 task definition/hash、PID、creation time/start token、stdout/stderr 路径与 restart/exit evidence。ceremony 持有生成 attestation 前打开的原始 `FileShare.Read` handle；Worker 重启只通过受 ACL 保护的 handoff 和 named pipe 重新 `PING` 同一个 PID/start token/nonce/attestation/file identity，不拥有释放权限。ACK 是 ceremony 预创建的精确文件槽：service identity 只获得 `Read|Write|Synchronize`，以满足 Worker 使用 `r+` 原地 truncate/write/fsync；该 ACE 明确不含 `Delete`、`ChangePermissions` 或 `TakeOwnership`，因此不能替换文件或改写其安全边界。supervisor 只在 ACK 恰好包含 `schema|nonce|worker_process_instance_id|vivado_toolchain_attestation_sha256`、schema 固定、nonce 与 attestation SHA 精确匹配且 process instance 为规范 UUID v4 时才 seal；额外、缺失或漂移字段全部 fail closed。

正常 Worker/service identity 可以 `PING`，但即使读取 nonce 也不能 `STOP`；pipe server 会 impersonate client，只有 SYSTEM/管理员 token 可进入 stop 分支。唯一的 detach 流程是管理员执行 `ToolchainLockStop -ConfirmToolchainDrainComplete`，并提供受保护且 hash 绑定的 `synthia-vivado-toolchain-drain-evidence.v1`：`gate_id`、`vivado_toolchain_attestation_sha256`、`new_effects_disabled=true`、`worker_listener_stopped=true`、`active_worker_processes=0`、`active_vivado_processes=0`、最后一个 `worker_process_instance_id`、`worker_pid`、按 CIM facts 计算的 `worker_start_token`、`worker_listener_port`、`accepted_effects_terminal=true`、`recovery_retention_converged=true`。stop 现场确认该 Worker PID/start token 已消失且目标 port 无 listener，再复核 lock supervisor PID/start token，等待其退出并释放原 handle，随后才 dismount 且验证 detached；Worker、launcher 或 SSH 断线均不得直接发送 STOP。

### 一次性 initialize，随后永久 reopen

M4-F 的隔离旁路固定为 `https://100.96.223.49:18443`，不得把旁路测试静默回退到现有 8443。Core 可在该精确 origin 上启用直连 mTLS；必须同时提供 `SYNTHIA_M4F_DIRECT_MTLS_AUTHORIZATION=I_AUTHORIZE_M4F_18443_DIRECT_MTLS`，以及 CA、client certificate、client private key 各自的仓库外绝对路径与预期 SHA-256（`SYNTHIA_M4F_DIRECT_MTLS_CA_PATH/CA_SHA256`、`SYNTHIA_M4F_DIRECT_MTLS_CLIENT_CERT_PATH/CLIENT_CERT_SHA256`、`SYNTHIA_M4F_DIRECT_MTLS_CLIENT_KEY_PATH/CLIENT_KEY_SHA256`）。三份 PEM 必须是当前用户所有、0600、单硬链接、非 symlink 且路径互异；Core 以同一文件句柄读取并校验 hash 后冻结 bytes，TLS 始终保持 server certificate validation，不能通过环境变量关闭。服务端证书必须包含精确的 `iPAddress SAN=100.96.223.49`；不得增加 `servername` 覆盖、hostname bypass 或关闭校验来迁就不合格证书。旁路 Connector config 的 refs 固定为 `cert://m4f-direct/trust` 与 `cert://m4f-direct/client`。缺少任一授权、hash、文件约束或 origin 精确匹配时，dispatcher host 启动失败；不会改连 Cloudflare 8443。

release 中的 `worker-66.config.template.json` 是 A 层绑定的不可变模板。先复制到隔离 staging，改成 Gate 专用且彼此不同的 `workspace_root`、`evidence_root`、`evolution_eval_ledger_root`、`evolution_eval_spool_root` 和 `evolution_eval_log_root`；这些路径必须位于 local fixed NTFS，不能是 junction、symlink 或其他 reparse point，也不能复用现有 Worker 目录。设置唯一且稳定的 deployment epoch 后执行：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File .\certify-m4f-windows.ps1 -Mode StageCeremony `
  -ReleaseRoot <release-dir> -ConfigPath <isolated-template.json> `
  -StagingRoot C:\Windows\Temp\synthia-m4f-<gate-id> -GateId <gate-id> `
  -Epoch <stable-deployment-epoch> -BunPath <absolute-bun.exe> `
  -ServiceIdentity <DOMAIN\service-user> `
  -ConfirmIsolatedStaging
```

`StagingRoot` 必须是已预先关闭继承并收紧 ACL 的 local fixed NTFS 目录；release、输入 config、ceremony 产物和五个 mutable root 必须全在其中，已有对象也必须关闭继承并通过 owner/writer 校验。`StageCeremony` 明确拒绝 `D:\synthia-worker` 及其子目录；它新建的 mutable root、ceremony 目录及 initialize/reopen config 会立即关闭继承并移除 allowlist 之外的 ACE。ceremony 只生成 staging-only 的 `worker-66.initialize.json` 和 `worker-66.reopen.json`，不会启动 Worker 或 Vivado，也不会覆盖 active config。用同一 bundle和固定 Bun 执行一次管理命令：

```powershell
$env:SYNTHIA_WORKER_VERIFY_BUNDLE = "1"
$env:SYNTHIA_WORKER_CONFIG_SHA256 = (Get-FileHash <worker-66.initialize.json> -Algorithm SHA256).Hash.ToLowerInvariant()
& <absolute-bun.exe> .\server.bundle.mjs --initialize-evolution-ledger <worker-66.initialize.json>
$env:SYNTHIA_WORKER_CONFIG_SHA256 = (Get-FileHash <worker-66.reopen.json> -Algorithm SHA256).Hash.ToLowerInvariant()
& <absolute-bun.exe> .\server.bundle.mjs --verify-evolution-ledger <worker-66.reopen.json>
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File .\certify-m4f-windows.ps1 -Mode PostInitialize `
  -ReleaseRoot <release-dir> -ConfigPath <worker-66.reopen.json> `
  -StagingRoot C:\Windows\Temp\synthia-m4f-<gate-id> -GateId <gate-id> `
  -BunPath <absolute-bun.exe> -ServiceIdentity <DOMAIN\service-user>
```

`PostInitialize` 验证 `ledger.json`、epoch 和 `facts/heads/indexes` 布局。通过后归档 initialize config，并以原子 rename 将 reopen config 晋升为 active config。普通服务永远只能使用 `evolution_eval_ledger_mode: "reopen"`；Worker 会拒绝以 `initialize` 模式监听。第二次 initialize、错误 epoch、空/损坏 root 都是阻断项。ledger 一旦有 accepted/effect fact，epoch 永远不得改变，不能重新 initialize、删除 ledger/spool 或恢复旧快照。

### 运行、保留、备份与回滚

- Worker/Core 重启或 submit/response 丢失后，必须使用原 job ID、idempotency key、dispatch hash 和同一 epoch query-first；不能 blind redispatch。无法证明 process 已停止时只能进入 `unknown_effect`，不能继续产生新 effect。
- `cancel` 必须由 Windows Job guardian 停止整棵进程树。进程和 ledger 不能证明安全时 fail closed。
- Core freeze 并发送 valid ack 后，Connector 才能正常清理 output；`corrupt_ack` 先进入不可读 quarantine，并须在 24h 内删除。所有 terminal raw output 最迟保留 7d；logical cleanup receipt 可能晚于 physical purge，`physical_deleted` 是独立单调事实。
- 一致备份前先优雅停止 Worker，并同时备份 ledger 与 spool。不得只备份其中之一；不得在运行中复制出一个看似一致的 snapshot。
- 回滚先关闭 Core new-effects 与 self-evolution rollout，但 recovery/retention duty 应继续完成。保留 ledger、spool 和 epoch；旧 bundle 不得打开当前 ledger。若只能回到旧 generic Worker，必须保持 eval disabled，直到能 reopen 原 epoch 的已认证 bundle 恢复。
- rollback、cleanup 或运维脚本不得反转、删除或伪造 acceptance、terminal、evidence、ack、quarantine、expired、cleanup 等事实。

Windows supervisor/service 由部署环境管理，不由 release 脚本静默安装。其固定合同是：运行主体必须等于 `SYNTHIA_WORKER_SERVICE_IDENTITY`；working directory/root、Bun、config 都使用上述绝对路径；非零退出只能在重新通过 `preflight-only` 后按同一 epoch/reopen config 重启；preflight/hash/ACL 错误不得自动重试。计划停止前先关闭 new effects、等待 active eval job 收敛并保留 recovery/retention-only，然后由 supervisor 发出正常 stop，等待进程退出后才备份 ledger+spool。Gate 证据至少保存 supervisor identity、PID、启动时间、exit code/restart count、`start-worker-66.cmd preflight-only` 输出、stop 前后进程列表与 reopen/query-first 结果；不得用强杀后的“目录仍存在”冒充优雅停止。

M4-F 的 Mac→66 直连版本化部署由
`connector/scripts/m4f-direct-deployment-orchestrator.ts` 编排，完整受审合同见
`connector/M4F-DIRECT-DEPLOYMENT-ORCHESTRATOR.md`。该入口默认只生成本地 plan；
没有绑定 config/plan/source/remote-program 四层 hash 的精确 confirmation 时不会触网。
它只面向 Gate-root 下的新 18443 release，显式保护旧 8443 PID/计划任务和
`D:\synthia-worker`，上传失败后不重试、不清理。PFX、密码和对应 secret hash
均不得进入 plan、日志或 evidence。该部署记录只关闭隔离 F0 编排，不替代 canary、
B v2、真实 Vivado 或最终 Gate F 认证。

`implement(generate_trial_bitstream=true)` 可以在 eval 隔离区生成试验 `.bit`，但它必须同时标记 `artifact_classification=experimental/evolution_eval` 与 `usage_classification=evolution_eval_only`。禁止把它写回项目、作为 formal/gate/baseline/release/delivery/publish/download 输入，禁止连接或下载到硬件；不得启动 `hw_server`/`vivado_lab`，也不得执行 `open_hw`、`connect_hw_server`、`open_hw_target`、`program_hw*` 或 `write_cfgmem`。

以上只完成 F0 发布基础，不能据此宣称 M4-F Gate PASS。Windows 实际 bundle 入口、mTLS、initialize→reopen 跨进程、remote query canary、真实 Vivado 四项 operation、恢复/retention、真实墙钟 2h cutoff 和全部正式/hardware selector 仍必须按 `specs/self-evolution-m4f-development-plan-v1.md` 单独执行并保存三事实面证据。

## 本地开发/部署

开发阶段可把 bundle 输出到临时目录做静态 smoke；不要直接覆盖 tracked bundle。最终 tracked bundle 必须与 release builder 的双构建结果逐字节一致。

66 部署目录：

```text
D:\synthia-worker\
├── server.bundle.mjs
├── worker-release.manifest.json
├── worker-66.config.template.json
├── worker-66.config.json
├── start-worker-66.cmd
├── certify-m4f-windows.ps1
├── runtime\bun-1.3.14\bun.exe
├── evolution-ledger\
├── evolution-spool\
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
