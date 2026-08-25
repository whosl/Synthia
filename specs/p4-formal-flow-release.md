# P4 精简正式流程、证据与交付发布验证手册

- 适用范围：[`implementation-plan-v1.md`](./implementation-plan-v1.md) 的 P4 第一条 G0～G4 正式工程闭环
- 权威契约：[`p4-formal-flow-contract-v1.md`](./p4-formal-flow-contract-v1.md)
- 当前状态：**本地最终候选已收敛，可开始 P3+P4 合并上手验收**；P4 范围内的 blocker/high 已修复并有正反回归，但这不等于 P5/P6、生产 Connector/Vivado 或真实板卡验收已经完成
- 证据日期：2026-08-25；本文中的通过记录来自 `codex/self-evo` 最终候选，拆分提交后仍以第 6 节命令在最终提交上复跑为准

## 1. 当前判定与剩余外部验收

P4 已有一条可运行的候选主路径：版本化 `process-profile.v1` 驱动 G0～G4，Core 保存 readiness、工作版本、evaluation、正式输入、冻结证据、码流分类和密封 release；Runtime 等待人工确认后编排四项正式 Job；Connector 校验输入/工具链绑定并返回完整证据；Web 展示准备、确认、运行、G4、release 和变更请求。

此前记录的 3 项 blocker 和 3 项 high 已全部收敛：

1. P4 资源读取统一先解析项目可见性；未知或跨项目资源以 404 fail-closed，不能借资源 ID 探测其他项目事实。
2. formal approval 在确认事务中把每个输入复制到 `formal_input_content`，按项目、SHA-256 和 size 绑定 immutable bytes；后续 Job、证据冻结和 release 只消费这份 Core-managed 内容，源 artifact 改写不会改变已确认输入。
3. G1～G3 改为读取受管 revision bytes 和 immutable snapshot facts 的结构化语义 evaluator，覆盖需求/来源/接口/验收/风险、验证映射，以及架构/寄存器/时钟复位/CDC/约束策略；缺项、跨项目、未冻结或 hash 漂移均失败。
4. G0 对 discovery 缺失、异常、漂移、空 hash 和非法 hash 全部形成不可确认的 hard fail；只有与项目绑定一致的 SHA-256 profile 才能 ready。
5. feature-off 矩阵覆盖所有 P4 读写入口；formal Job GET 在关闭时不会调用 Connector、轮询状态或更新数据库。
6. 正式输入拒绝 cache、秘密、私钥、证书、symlink、submodule 和不可移植/歧义路径，相关内容不能进入 input、Job 或 release。

安全审查也已封存并逐项修复。Scan ID 为 `244764e9-d5fe-4ae8-a013-69f7146eedd8`，原始扫描快照是 `6facea7d50a24b57eaa59eba299f290ff0fbedbc`，覆盖 `65/65`，原报告结果为 `1 critical / 4 high / 2 medium`。报告位于 `/private/var/folders/rv/5_lp5d250tq7rwyn8rx0zt200000gn/T/codex-security-scans-pNW6yp/synthia/6facea7d50a24b57eaa59eba299f290ff0fbedbc_20260824T163352Z_sp9gty9_/report.md`，SARIF 位于同目录 `exports/results.sarif`。报告明确针对原始快照，并提示扫描期间工作树变化；本候选没有伪造“重扫为零”，而是对报告中的 toolchain 可执行文件替换、XDC Tcl 注入、Worker endpoint scope、跨 scope Job 访问、Runtime task confused deputy、证据资源耗尽和 Windows 路径别名七项逐项加固并回归。`.claude/**` 与 `.edagent/**` 不在扫描覆盖中，也不进入提交。

当前剩余项属于外部或人工验收，而不是可由本地 fixture 自动证明的 P4 blocker：

- 普通浏览器/操作系统下载目录中的 Blob 文件名、字节数和 SHA-256 仍需人工复核。
- 目标生产 Connector 与真实 Vivado 环境需要单独 smoke；现有三段 HTTP E2E 的执行器是确定性 fixture。
- 真实 FPGA 上板、JTAG/烧写与硬件在环不在 P4 软件闭环范围内。

## 2. 已实现范围

### 2.1 Core 与 PostgreSQL

- `GJB_REF_V1` 由同一份 G0～G4 profile、活动、hard check 和 B0/B1/B2 映射驱动；G5～G9 不进入现代流程。
- `0010_process_gate_checks.sql` 建立 profile、readiness、gate evaluation/item、正式输入绑定、ToolRun v1 绑定、冻结 evidence manifest/entry 和 baseline 换代约束。
- `0011_delivery_release.sql` 建立工作版本、trial/formal bitstream、密封 release/item、change request，以及不可变/唯一/复合项目关系的数据库 guard。
- G0 readiness 区分“已诚实记录”和“约束完整”：约束不完整仍可确认 G0，但正式输入预览 fail-closed，非正式运行只能形成 trial。
- 正式 Job 只接受 `formal_input_approval_id` 的最小请求，拒绝客户端同时自报 sources、constraints、part、baseline 或 input hash；四项 operation 必须绑定相同 input、snapshot、B1、工具链和身份。
- evidence freeze 会复制并重算 Connector 返回的完整证据，使用 Core parser 生成 verdict；首次冻结后禁止覆盖，内容/manifest 分歧返回冲突。
- G4 evaluation 生成 sealed projection；approve 在一个事务中建立 approval、ApprovedGateResult、B2、release/items、work-version 完成和 outbox，重复 approve 不建立第二个 release。
- release、release item、frozen evidence、bitstream classification 和 approval 均按 append-only 事实处理；发布后修改通过 change request 和新工作版本表达。

### 2.2 Runtime

- Runtime 从 Core 读取并严格验证 profile/hash，不再自行维护另一条阶段链。
- G0 未确认时不进入工程执行；G1～G3 走现代 submission/evaluation/submit 路径，不回退 legacy approve。
- 正式输入未确认时保存等待状态且不启动 Job；确认后按 `validate_sources → simulate → synthesize → implement` 编排四项同 input formal Job。
- Job intent、job ID、idempotency key 和阶段进度可持久化恢复；同进程响应丢失或 Runtime 恢复时重新附着既有 Job，不重复 operation。
- 四项证据冻结完成后，Runtime 驱动 G4 evaluation/submit，等待 human approval，再读取并校验 release、manifest、B2 和确认 provenance。
- Runtime 使用专用 task token 提交绑定 main task 的正式运行；缺 token、side task、其他 Runtime、跨项目或响应绑定漂移均 fail-closed。

### 2.3 Connector

- 远程 envelope 和 Worker HTTP 路径逐项核对 job/project/operation/run class/input hash/toolchain hash。
- evidence content 支持 binary-safe base64 和显式 `complete=true`；完整证据会复核 name、sha256、size，truncated/corrupt 内容不能冻结为正式证据。
- Vivado adapter 对 DRC Error、负 slack、显式 timing-not-met、缺报告、无确定 PASS、仿真 Fatal 和 runner timeout/lost 等情况 fail-closed。
- `implement` 在同一会话完成 synth/opt/place/route、DRC/STA/资源报告、DCP 和 bitstream；约束和受控 fileset 在执行前校验。

### 2.4 Web

- 工程项目从 Core profile/state 渲染 G0～G4，不再显示 15 节点硬编码阶段。
- “正式流程与交付”面板支持 readiness 准备/人工确认、正式输入逐文件预览/确认、Runtime 四任务进度、G4 hard checks、trial/formal 标签、release/manifest/item、变更请求和撤回。
- 所有 P4 写请求携带稳定幂等键；重试沿用冻结 body，G4 approval 同时携带 evaluation、projection、release 和 B2 身份。
- 下载前客户端按 manifest 重新计算字节 SHA-256；文本和二进制内容分别按 UTF-8/base64 无损还原。
- 窄屏布局在 390×844 和 320×720 下保持面板、操作按钮和 release item 在 viewport 内。

## 3. 契约追踪状态

下表描述的是 **当前分支最终候选**，不是已部署能力：

| 契约范围 | 当前实现与证据 | 状态 | 边界或后续项 |
|---|---|---|---|
| 迁移与 profile | 0010/0011、fresh schema、G0～G4 profile/hash、升级与 schema 等价已有测试 | complete | 生产迁移仍需按部署方备份/变更窗口执行 |
| G0 readiness | 配置、工作区、来源、三类约束、discovery 绑定和人工确认均有正反测试 | complete | 板卡可按 profile 保持 `missing`，不与三类约束完整度混为一谈 |
| G1～G3 | immutable revision bytes、snapshot facts、结构化语义 evaluator、顺序与 B0/B1 已覆盖 | complete | 新流程版本若扩展字段需另行版本化契约 |
| 正式输入 | preview/confirm、Core-managed immutable bytes、身份/B1/toolchain/hash 绑定与源漂移反例均通过 | complete | Blob 下载落盘仍需人工复核，不影响服务端不可变性结论 |
| Formal Job 与恢复 | 四项同 input、Core-issued task ID、稳定 intent、响应丢失重附着已有真实 HTTP 证据 | complete | 跨 Connector 进程重启持久化属于 P6 |
| Evidence/DRC/时序 | 完整字节复核、数量/总量限制、parser verdict、divergence、trial/formal 分类已有正反测试 | complete | 目标生产 Vivado smoke 仍是环境侧验收 |
| G4 与 delivery | sealed projection、原子 B2+release、append-only、重复 approve、CR 换代/撤回已覆盖 | complete | 浏览器已走 withdraw；CR→第二 release 由 API/数据库测试覆盖 |
| 身份与隔离 | human confirm、main Runtime、task token、项目可见性和跨 scope 404 已有反例 | complete | 多租户组织策略扩展不在 P4 范围内 |
| Web 主路径 | mock 桌面/390/320 已走通，单测、类型与构建通过 | complete | 与部署环境联合手验属于合并/发布验收 |
| 开关与回滚 | Core/Web 默认关闭；feature-off 全矩阵无 Connector/DB 副作用；事实保留 | complete | Web 开关变化仍需重新构建 |

## 4. 开关、身份与部署配置

### 4.1 默认关闭的双层开关

Core 是权威写开关，严格接受 `1|true|0|false`；未配置等同关闭，其他值阻止启动：

```sh
export SYNTHIA_FEATURE_FORMAL_DELIVERY=1
```

Web 是构建时开关，只有精确字符串 `1` 开启；改变后必须重新构建：

```sh
export VITE_FEATURE_FORMAL_DELIVERY=1
```

Runtime 没有独立 P4 feature flag。它依靠 Core 开关、Core-owned task/work-version/profile 状态和专用 task token fail-closed。不要部署不存在的 Runtime P4 开关。

Web 的 `dev:mock` 会显式开启该 Web 开关，只用于交互验收，不代表 Core 能力已开启。

### 4.2 身份与 token

迁移后可用 bootstrap 创建 human、普通 Core service 和 task Runtime 三类身份：

```sh
DATABASE_URL='<postgres-url>' bun run core/scripts/bootstrap-admin.ts
```

明文 token 只显示一次，必须立即进入受管 secret storage，不能写入仓库、日志或本文。Runtime 至少配置：

```sh
export SYNTHIA_RUNTIME_MODE=core
export SYNTHIA_CORE_URL='http://127.0.0.1:8787'
export SYNTHIA_CORE_TOKEN='<SERVICE_TOKEN>'
export SYNTHIA_TASK_RUNTIME_TOKEN='<TASK_RUNTIME_TOKEN>'
```

- `SYNTHIA_CORE_TOKEN` 用于普通 Core 读写；`SYNTHIA_TASK_RUNTIME_TOKEN` 必须属于绑定 Runtime actor，scope 精确为单元素 `{core:task-runtime}`。
- 两枚 token 不能合并或互换。human confirmation/approval 只从 bearer identity 和项目角色解析，不接受 body 自报 actor。
- `SYNTHIA_RUNTIME_ACTOR_ID` 默认 `synthia-runtime`，必须与 task token 的 service uid 和 formal approval 绑定的 main task actor 一致。

### 4.3 Core、Connector 与 Worker

Core 最小候选配置：

```sh
export DATABASE_URL='<postgres-url>'
export SYNTHIA_FEATURE_FORMAL_DELIVERY=1
export SYNTHIA_RUNTIME_URL='http://127.0.0.1:8790'
export SYNTHIA_RUNTIME_ACTOR_ID='synthia-runtime'
export SYNTHIA_CONNECTOR_CONFIG='<controlled-connector-config.json>'
export SYNTHIA_CF_ACCESS_CLIENT_ID='<secret-storage-reference-value>'
export SYNTHIA_CF_ACCESS_CLIENT_SECRET='<secret-storage-reference-value>'
bun run core/scripts/serve.ts
```

Worker 通过 `SYNTHIA_WORKER_CONFIG` 指向受控配置，配置内的 target part、toolchain profile hash、project/classification scope 和能力版本必须与 Core discovery 一致。生产证书、PFX 密码、Access token 和 `.env` 不得提交。缺 Connector 配置时 Core 会启动，但 formal Job 返回 capability unavailable；这不能作为 G0 ready 的工具链绑定。

Worker bundle 在最终候选上重建：

```sh
bun build connector/server.ts --target=node --outfile connector/server.bundle.mjs
```

## 5. 迁移、兼容与回滚

### 5.1 发布迁移

1. 保持 Core/Web P4 开关关闭，停止 Runtime 发起新的 formal/G4 写入。
2. 对目标数据库做部署方规定的备份；P4 自身不宣告完整备份/恢复能力。
3. 顺序应用全部编号迁移，确认 `0010_process_gate_checks` 和 `0011_delivery_release` 进入 `schema_migrations`：

```sh
DATABASE_URL='<postgres-url>' bun run core/src/db/client.ts
```

4. 验证 fresh install 的 `schema.sql` 与编号迁移边界一致；既有 GJB_REF_V1 项目只获得 initial work version，不能自动 ready、批准门、建立 baseline 或 release。
5. 部署能读取新旧事实的 Core、Runtime、Web 和 Connector bundle，先在开关关闭状态完成 profile、只读兼容和 exploratory smoke。
6. 只有第 6 节一次性验收全部通过后才打开 Core 开关，并以启用 Web 开关的构建替换前端。

旧 formal ToolRun 和旧 evidence 保持 legacy 可读，但不能升级为 P4 formal evidence/bitstream/release；旧 G0～G9 与 B3/B4 只保留兼容读取，GJB_REF_V1 新写只接受 G0～G4。

### 5.2 最短回滚

1. 先关闭 Web 构建开关并重新构建，隐藏正式确认、批准、release 和 change request 写入口。
2. 停止 Runtime 正式编排和 formal Job 状态轮询，再关闭 Core 开关，以得到清晰、可审计的回滚边界；feature-off 路由本身已验证不会调用 Connector 或写数据库。
3. 将 Core `SYNTHIA_FEATURE_FORMAL_DELIVERY=0` 并重启，阻止新的 readiness、evaluation、formal input、formal Job、evidence freeze、G4、release 和 change request 写入。
4. 如需回退二进制，恢复上一版 Core/Runtime/Web/Connector；保留 0010/0011 新表、冻结证据、trial/formal 分类、baseline supersession、release、change request、审计和 outbox。
5. 验证旧 exploratory Job、自由项目和历史事实读取仍可用，记录最后成功的 work version、job、evaluation、release 和 correlation ID。

禁止逆向迁移、删除/修改密封事实、把 trial 改为 formal、重写 manifest、复活 superseded baseline 或用 legacy G4 路径伪造成功。

## 6. 最终候选一次性验收

以下步骤应在同一个最终候选提交上按顺序执行；第 7 节记录了本候选的实际结果。PostgreSQL 行为测试会 `DROP public schema`，必须使用专用一次性数据库，绝不能指向开发、共享或生产库。

### 6.1 Fresh PostgreSQL 与真实 HTTP

为 destructive PostgreSQL 行为测试和 HTTP E2E 分别准备独立数据库：

```sh
DATABASE_URL='<postgres-admin-url>' bun run core/scripts/make-test-db.ts synthia_p4_pg_accept
DATABASE_URL='<postgres-admin-url>' bun run core/scripts/make-test-db.ts synthia_p4_http_accept

# 会 DROP public schema，只能使用 synthia_p4_pg_accept
DATABASE_URL='<synthia_p4_pg_accept-url>' \
  bun test core/tests/p4-postgres-behavior.test.ts

# Runtime client → Core HTTP → Connector Worker HTTP；Vivado 执行为确定性 fixture
DATABASE_URL='<synthia_p4_http_accept-url>' \
  bun test core/tests/p4-http-e2e.test.ts
```

另用 fresh database 跑 Core P4/API/schema 定点和全 Core：

```sh
DATABASE_URL='<fresh-p4-core-url>' bun test \
  core/tests/api-p4-formal-flow.test.ts \
  core/tests/p4-formal-flow-service.test.ts \
  core/tests/process-profile.test.ts \
  core/tests/postgres-contract.test.ts

DATABASE_URL='<fresh-p4-core-url>' bun test core/tests
```

必须观察：0009→0011 不自动产生治理成功；跨 work-version/project 引用被拒；并发 formal operation 只有一个赢家；证据分歧不覆盖；G4 失败不留下半套 B2/release/items/outbox；same-key 重放只有一个 Connector execution 和一个 release。

### 6.2 仓库、Runtime、Connector 与 Web

```sh
bun test
bun run check:names
bun run check

bun test \
  runtime/formal-flow.test.ts \
  runtime/loop-p4.test.ts \
  runtime/process-execution.test.ts \
  runtime/process-profile.test.ts \
  runtime/governance-client.test.ts
bunx tsc --noEmit -p runtime/tsconfig.json

bun test connector
bunx tsc --noEmit --target ES2022 --module ES2022 \
  --moduleResolution bundler --strict --skipLibCheck \
  --noUncheckedIndexedAccess --allowImportingTsExtensions \
  --types bun connector/*.ts
bun build connector/server.ts --target=node --outfile connector/server.bundle.mjs

(cd web && bun test && bun run check && bun run build)
git diff --check
```

Core 与 Runtime `tsc` 当前仍返回非零，不能写成“通过”。固定基线分别是 16 和 20 条历史诊断；最终记录必须保存基线数、当前数、逐文件差异和 P4 文件新增数。只有证明 P4 无新增且既有债务没有恶化，才可按基线放行。`bun run check:names` 是独立的零退出门禁，不能代替这两个类型检查结论。

### 6.3 浏览器一次走完

1. 打开 GJB_REF_V1 工程项目，确认阶段轨只有 G0～G4，项目、main task 和 URL 不因打开正式面板而切换。
2. 建立约束不完整但如实记录的 readiness：G0 可人工确认，formal preview 必须被明确阻断；exploratory bitstream 只能标为 trial。
3. 建立器件和 pin/electrical/clock 三类约束完整的新 readiness，并由 human 确认；板卡若非 profile 的硬要求可以保持 `missing`。按顺序完成 G1～G3，逐项检查 Core evaluation 的语义明细和 B0/B1。
4. 预览正式输入，逐文件核对 path、role、revision、size、SHA-256、B1、target part 和 toolchain hash；确认后修改任一事实都必须使旧 approval 失效。
5. 确认 Runtime 自动执行四项 formal operation，四项 job 的 input hash、approval、snapshot、toolchain 和执行身份完全一致；Web 不提供绕过 Runtime 的人工重复提交按钮。
6. 检查每项 raw evidence、Core parser verdict、DRC `errorCount=0`、timing met/clock coverage 和唯一 formal bitstream；缺项、unknown、partial、corrupt 或 trial 均不能通过 G4。
7. 批准 G4 一次，确认原子得到 B2、completed work version 和一个 sealed release；刷新并重放相同批准，不能出现第二个 B2/release/outbox。
8. 打开 release，逐项核对 manifest 和必需 category。手工下载 manifest、文本 item 和 formal bitstream，在操作系统下载目录计算 SHA-256，并与 sealed manifest 比对。
9. 发起 change request，确认旧 release 保持只读、新 work version 从 impact gate 开始；API/数据库测试至少完成一次 CR→第二 release，浏览器另走一次 withdraw 并确认旧 release 恢复为 current。
10. 在桌面、390×844、320×720 重走关键动作；检查 document/body/panel 无横向溢出，按钮可触达，console/network 无应用错误、重复写请求或未解释的 4xx/5xx。

Web 使用 `URL.createObjectURL(new Blob(...))` 和 `<a download>` 触发下载。Codex in-app Browser 工具目前不能可靠暴露 Blob download 事件或下载目录文件，所以第 8 步不能仅凭该工具宣告通过：现有单测已覆盖字节解码和 hash 复核，但最终验收仍需人在普通浏览器/操作系统下载目录检查文件名、字节数和 SHA-256。这是 Browser 自动化工具限制，不是放宽产品下载契约。

## 7. 最终候选已完成验证证据

下表记录 2026-08-25 最终候选的结果；提交后按相同命令复跑，若计数变化应以最终提交结果更新本文或合并说明：

| 检查 | 当前证据 | 当前判定 |
|---|---|---|
| Fresh PostgreSQL 全 Core | `478 pass / 0 fail / 3052 assertions` | P1～P4 Core、迁移、API、隔离与失败路径通过 |
| 仓库根测试 | `1065 pass / 339 skip / 0 fail` | 无数据库环境的默认根门禁通过；数据库项由 fresh Core 单独覆盖 |
| PostgreSQL P4 行为 | `10 pass / 0 fail` | 迁移、并发、immutable bytes、原子性和 append-only 定点通过 |
| 真实 transport HTTP | `7 pass / 0 fail` | Runtime client→Core HTTP→Connector Worker HTTP 通过；Vivado 为确定性 fixture |
| Core P4/API/schema 定点 | `31 pass / 0 fail / 431 assertions` | profile、语义门、正式输入、G4/release 和 schema 契约通过 |
| Runtime 全量 | `375 pass / 0 fail / 1624 assertions` | profile、等待/恢复、task 绑定、四任务和 release 校验通过 |
| Connector 全量 | `115 pass / 0 fail / 445 assertions` | scope、toolchain、路径/XDC、evidence 限额和 Vivado fail-closed 通过 |
| Connector 独立 TypeScript | 独立 `tsc` 命令零诊断退出 | 通过；没有 Connector-specific 新诊断 |
| Connector bundle parity | 临时重建产物与 `connector/server.bundle.mjs` 字节级 `cmp` 相同 | 通过 |
| Web 全量 | `435 pass / 0 fail / 2028 assertions` | API、严格 parser、mock、正式交付和 UI 行为通过 |
| Web type/build | `vue-tsc --noEmit` 与 Vite build 通过 | 通过；build 仅有大 chunk warning |
| Undefined names | Core、Runtime 均无未定义标识符 | 通过 |
| Core TypeScript | 固定基线仍为 16 条历史诊断 | **命令非零**；P4 未新增，不能记为通过 |
| Runtime TypeScript | 固定基线仍为 20 条历史诊断 | **命令非零**；P4 未新增，不能记为通过 |
| 浏览器桌面 | mock 完整 G0→G4、四任务、B2、9-item v1 release、CR/withdraw 和恢复通过 | mock 交互通过 |
| 浏览器 390×844 | document/body/panel/scroll 均为 390 px，仅隐藏 tooltip 几何越界 | 通过；隐藏元素不构成可见 overflow |
| 浏览器 320×720 | document/body/panel/scroll 均为 320 px；v1 9 items 与已撤回 CR 可访问 | 通过；无可见 overflow，console 无 warning/error |
| 工作树卫生 | `git diff --check` 通过；`.claude/`、`.edagent/` 未纳入范围 | 通过 |

真实 HTTP 测试还覆盖：Connector 接受后响应丢失时两次 HTTP submit 只执行一次；证据字节篡改与 manifest divergence；generic/combined/其他 Runtime/side-shaped/cross-project token 拒绝；B1 漂移；toolchain discovery 漂移；约束不完整仅 trial 且 formal preview fail-closed。

窄屏有一项非阻断交互尾差：390 px 打开对话浮层时顶栏按钮位于浮层后，需要点击左侧 backdrop 关闭；关闭路径可用，未阻断正式流程。

## 8. 非目标与已知限制

以下内容不由 P4 成功状态暗示为已经完成：

- P5 的完整备份、恢复、恢复演练和灾难恢复承诺。
- P6 的 Connector 组织级注册/租约/进程取消、跨 Connector 重启的持久化幂等和长期运行硬化；P4 当前只证明同进程/响应丢失重附着。
- 真实 FPGA 上板、JTAG 编程、烧写和硬件在环验收。release item 的浏览器“下载”只是取回密封文件，不等于板卡下载/编程。
- G5～G9、B3/B4 的现代流程扩展；它们只保留 legacy 读取兼容。
- 把旧 formal run、旧 evidence 或 trial bitstream 自动升级为 P4 正式事实。
- 当前真实 HTTP E2E 使用真实三段 HTTP 和生产协议 adapter，但 Vivado 执行器是确定性 fixture；它证明协议、治理和故障语义，不替代目标生产 Connector/Vivado 环境的单独 smoke。
- Codex in-app Browser 对 Blob 下载事件/下载文件不可观察；最终文件下载必须人工复核，见 §6.3。

Core 与 Runtime 尚有既有 TypeScript 类型债。当前固定基线分别是 16 和 20 条诊断，P4 文件没有新增，但两个命令仍非零；任何后续候选都必须用相同 TypeScript 版本和命令与固定基线逐项比较，不能写成“类型检查通过”或只比较总数。

## 9. 可开始合并验收的时点

当前候选已满足开始 P3+P4 合并上手验收的本地软件门槛：此前 3 项 blocker/3 项 high 和安全报告七项均有修复与回归；fresh PostgreSQL、真实三段 HTTP、全 Core/Runtime/Connector/Web、bundle parity、桌面与双窄屏主路径已经执行；Core/Runtime 16/20 条历史类型债被如实保留；首版 release、重复 G4、CR 换代和 withdraw 均有自动或浏览器证据；提交范围明确排除 `.claude/`、`.edagent/`、秘密、证书和运行状态。

因此可以邀请用户开始合并上手验收，但合并/发布说明必须继续列出三项未由自动化证明的环境侧检查：

- 在普通浏览器和操作系统下载目录人工核对 manifest、文本 item、formal bitstream 的文件名、字节数和 SHA-256。
- 在目标生产 Connector/Vivado 环境运行单独 smoke，确认受控 binary、part、profile、证书与 endpoint scope 配置。
- 若本次交付目标包含真实硬件，再单独完成板卡识别、JTAG/烧写与硬件在环；P4 软件 release 的“下载”不代表已上板。

完成这些外部项之前，可以称为“P3+P4 合并验收候选”，不能称为“生产环境或真实板卡已验收”。
