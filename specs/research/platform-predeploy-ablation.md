# Core / Runtime / Worker 部署前消融实验

> 后续状态：2026-10-02 07:55 CST 已按用户指令部署 `42cf5fa`；下文保留此前开发/测试阶段记录。部署验证与备份见 [platform-ablation-deployment.md](platform-ablation-deployment.md)。

本轮以 `6fc0d73` 为源码基线，在 platform-ops worktree 保留已合入的 H35/H36/H37、H34、H20 修复，删除已退出调用链的实现并精简 Worker 实际执行路径。净减少 **937 行生产 TypeScript / 36,867 字节源码**，Worker canonical bundle 减少 **7,290 字节（9.5%）**。生产部署、服务进程、p31/p32 会话及真实 application 均未改动。

机器可读记录见 [platform-predeploy-ablation.json](platform-predeploy-ablation.json)，可复跑的请求/结果对照见 [platform-predeploy-ablation-probe.ts](platform-predeploy-ablation-probe.ts)。

## 1. 实验方法与计数范围

1. 用 `git archive 6fc0d73` 建立临时基线，复用本地依赖；生产源码保持原样。
2. 扫描 Core / Runtime / Worker 的模块消费者和仓库内调用点，并核对此前 selfevo 消融记录；无消费者的入口须同时确认所属业务链已退休。
3. 基线与候选使用相同的两项测试夹具修正及新增真实进程测试。双方执行 root `bun run test` 和隔离 PostgreSQL 回归，跳过项单列。
4. 分别移除 Core 权限、Runtime 模型看门狗、Worker 吞吐 verdict，作为临时负对照；这些改动只存在于 `/tmp` 副本。
5. 对两份源码运行相同假 Connector / 模型配置 / 假 Vivado 请求，逐层比较完整调用与结果对象；两版复用同一临时目录，避免目录名影响证据 hash。
6. Worker bundle 从源码连续构建两次，比较字节，验证 Node 语法、无副作用 import 及源码/bundle 行为一致。

下表统计 `core/src`、`runtime`、`connector` 中非 `*.test.ts` / `*.d.ts` 的 TypeScript；含空行。测试、实验探针、报告和生成 bundle 不计入生产源码行数。

| 层 | 基线源码行数 | 候选源码行数 | 净删除 | 源码字节减少 |
|---|---:|---:|---:|---:|
| Core | 27,739 | 27,460 | 279 | 8,564 |
| Runtime | 25,553 | 25,189 | 364 | 10,736 |
| Worker | 2,973 | 2,679 | 294 | 17,567 |
| 合计 | 56,265 | 55,328 | **937** | **36,867** |

bundle：`76,698 → 69,408` 字节；候选 SHA-256：`15c430a29177b3fb44c3820ba48cc8cf557121cee8a87fd193693e03d169514c`。

## 2. 保留的删减

### Core

- 删除 `domain/evolution-eval-dispatcher.ts` 与 `services/evolution-eval-dispatcher-host.ts`。它们是已退休 M4-F 评测流程的 dispatcher / host，当前入口、测试、脚本均无消费者。
- 从 `api/connector-adapter.ts` 删除无人调用的 M4-F TLS 文件读取/绑定类型、常量、旧入口参数与过期注释。当前 direct HTTPS / mTLS 仍使用 Connector HTTP transport 的证书读取及验证；项目隔离、lease 重连、capability drift、正式审批投影均保留。
- 历史数据库迁移保留，避免破坏新库初始化及已部署库的迁移记录。

### Runtime

- 把 `pi-responses-model.ts` 收敛为 `runtime-model.ts`：只保留仍在使用的 Chat Completions / Anthropic Messages 选择器、工厂和模型接口；更新 Runtime 与开发脚本的 imports。
- 删除已停用的 Responses wire 转换、usage/context/payload 助手及其过期测试夹具。工厂继续明确拒绝 `SYNTHIA_MODEL_API=responses`，新增 Anthropic 工厂选型回归。
- 删除无消费者的 `InMemorySkillLoader` 子类。保留真实 SkillLoader、两个在用模型传输、学习流程、模型看门狗及工具权限。

### Worker

- 删除无人调用的 `executeEvolutionEval`、专用请求验证/类型、sealed workspace 分支、runner 覆盖参数和第二套 `createVivadoProcessGuardian`。
- 将常规执行直接保留在 `execute`，去掉仅为旧入口存在的 wrapper 和重复请求验证。普通入口对历史 `evolution_eval` run class 的拒绝及 wire 枚举仍保留。
- 删除无人消费的进程身份采集、`onProcessStarted` 回调和相关结构，避免每次普通 job 启动读取 `/proc` 或额外启动 PowerShell/CIM / Unix 同步命令。
- 保留实际使用的 Unix 进程组清理、Windows `KILL_ON_JOB_CLOSE` Job guardian、5 MiB UTF-8 捕获、compile-order 修正、证据封存、H34 独立性能判定。
- `server.bundle.mjs` 已由本轮 canonical 源码重建。

## 3. 不删除的保护：负对照结果

| 层 | 临时消融 | 检出的后果 | 失败测试数 | 处置 |
|---|---|---|---:|---|
| Core | 移除 tool summary 的 `requireProjectReadable` | 未授权读取得到成功响应，授权先于读证据的断言失败 | 1 | 保留 |
| Runtime | 将 `watchModelRequest` 换成裸模型调用 | 忽略 signal 的挂起请求不恢复，回归在 500ms 上界超时 | 1 | 保留 |
| Worker | 去掉 `digest.performance.failed` 优先判定 | `GOODPUT_MBPS 11.0`、`DROPPED_PKTS 2`、`CYCLES_PER_PIXEL 45` 均在 TB PASS/$finish/exit=0 下误判成功 | 3 | 保留 |

实际 Windows Job guardian 的源码块、`log-digest.ts`、`output-capture.ts`、`free-agent.ts`、`model-watchdog.ts`、学习工具/客户端、证据 range 域逻辑、任务 handler 与鉴权源码均与基线逐字节相同。上述负对照未进入候选或 bundle。

## 4. 回归结果与夹具修正

| 验证 | 基线 | 候选 |
|---|---|---|
| root `bun run test`（未设置 DATABASE_URL） | 965 pass / 400 skip / 0 fail | 965 pass / 400 skip / 0 fail |
| Core / PostgreSQL 三个 API slice | 87 pass / 0 fail | 87 pass / 0 fail |
| 真实进程 runner 新增测试 | 5 pass / 0 fail | 5 pass / 0 fail |
| 完整请求/结果 trace | Core 7 / Runtime 9 / Worker 18 | 34 组与基线完全相同 |
| `bun run check` | 整条 check 未单独复跑；Core tsc 通过 | 通过 |
| `bunx tsc --noEmit -p runtime/tsconfig.json` | 4 项历史类型错误 | 通过 |
| canonical bundle | 原基线产物 | 两次构建字节相同；Node 语法/import/行为校验通过 |

400 个跳过项是未设置数据库连接的门控测试，不计为通过。PostgreSQL 回归显式指定 `127.0.0.1:55439` 的独立临时数据库，运行 `api-run.test.ts`、`self-evolution-api.test.ts`、`api-side-tasks.test.ts`；未连接生产数据库。

基线首次 root 测试的两项失败来自 `resource-summary.test.ts` 仍按旧 SQL 夹具执行：缺少 `project_type/config_epoch` 查询返回值，参数期望未包含 epoch/chain。首次 DB 对照也复现旧 task capability 测试预期 401 / 实际 403；当前 `authenticate` 及 `self-evolution-contract.test.ts` 已统一规定伴随 scope 的能力 token 必须返回 `403 / EVOLUTION_SCOPE_FORBIDDEN`。本轮仅修正这两处测试夹具/断言，在双方使用相同修正，鉴权源码保持原样，越权及无副作用断言保留。

此外删除 Worker evidence manifest 的不可达 part fallback，收窄共享 job status 返回类型，并修正手动 Anthropic probe 的工具返回结构，解决基线的 4 项类型错误；共享状态映射的运行行为未改。双份 DB 测试并发时曾触发默认 5 秒清理 hook 超时，最终 DB 验证使用 `--timeout 30000`，未更改服务超时、模型看门狗或正式任务策略。

## 5. 复跑

从仓库根运行，基线目录由 `git archive 6fc0d73` 解出并链接当前 `node_modules`：

```bash
bun specs/research/platform-predeploy-ablation-probe.ts /path/to/baseline /tmp/ablation-trace.json
env -u DATABASE_URL bun run test
bun test connector/vivado-process.test.ts connector/worker-bundle.test.ts
bun run check
bunx tsc --noEmit -p runtime/tsconfig.json
DATABASE_URL='postgresql://wenzhuolin@127.0.0.1:55439/<isolated-test-db>' bun test --timeout 30000 core/tests/api-run.test.ts core/tests/self-evolution-api.test.ts core/tests/api-side-tasks.test.ts
bun build connector/server.ts --target=node --format=esm --minify --outfile /tmp/worker-a.mjs
bun build connector/server.ts --target=node --format=esm --minify --outfile /tmp/worker-b.mjs
cmp /tmp/worker-a.mjs /tmp/worker-b.mjs
node --check connector/server.bundle.mjs
```

## 6. 部署窗口与实验边界

本轮只交付 worktree 代码、测试、实验记录及 canonical 本地构建。生效需要之后在用户安排的窗口更新 **Core + Runtime + Worker**；无新增数据库迁移。未重启服务、未部署、未改 p31/p32、未关闭两个真实 open application。

真实进程测试在本机 Unix 路径使用隔离的假 Vivado 可执行文件，覆盖 stdout/stderr、成功/失败、5 MiB UTF-8 截断、预取消不启动，以及超时/取消清理忽略 SIGTERM 的后代进程。未在 66 机执行 Windows 实机回归或 Vivado 基准。本地 bundle 使用 Bun 1.4.1 / Node ESM；正式窗口仍须遵循既有 release / Windows Gate 的固定工具链及认证流程。

源码和 bundle 体积下降是本轮测得的结果；没有测量生产延迟、正式 Vivado 吞吐或网页加载时间，不把本地测试耗时差解释为线上性能收益。
