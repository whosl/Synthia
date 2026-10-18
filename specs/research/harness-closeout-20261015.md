# T3 harness 收尾批次 W-1–W-10

按任务要求沿用 `20261015` 文件名；实际开发、验证日期为 **2026-10-18（Asia/Shanghai）**。开发目录为 platform-ops worktree，起始版本 `9cc7011`。本批没有修改 `/data3/dev/synthia-golden`、重启服务、访问生产数据库、向 p31–p38 发消息或编辑其会话文件。

## 状态与问题矩阵

T3 jpeg/usb/msp430/fpganes（p27–p38）已收官。执行期证据由操作者提供；本批用独立合成作业和会话验证修复，不重放基准会话。

| 任务 / 台账 | 问题与证据 | 修法 / 主要源码 | 验证 | 生效条件 |
|---|---|---|---|---|
| W-1 / H39（H25） | p38 4+ job 的 stdout 在 Worker 重启后不可读；registry 只有状态/manifest | `connector/worker.ts` 将终态证据和绑定元数据封存到独立 evidence_root；原子发布，SHA-256/大小校验，缺 registry 时按 jobId 恢复 | 删除 workspace/registry 后两次冷启动仍可读取正文和分页；快照残留 running 也恢复终态；跨项目/缺件/篡改/符号链接拒绝；取消路径回归 | 更新并重启 Worker；持久 evidence_root 必须保留 |
| W-2 / H40 | 看门狗重启遗留 4/10/5 个 Worker 实例，争端口 | 新增 `deploy/supervise/worker-watchdog-66.ps1`，按端口 mutex 串行启动，按已知绝对 bundle 路径和 node/bun 名称清理孤儿实例，持锁等待前台 launcher 退出 | Bun 检查源契约及清场先于启动；本机无 PowerShell，未运行 Windows 进程操作 | 更新 schtasks action / IgnoreNew；66 机现场验收由操作者安排 |
| W-3 / H41 | p35/p37 加项目需双侧重启 | Core `connector-adapter.ts`、Worker `project-scope.ts` 每请求读取 project_scope，撤权先于幂等缓存返回，Core scope 改变清除 client 缓存 | 增加/撤销项目、坏 JSON、缺失文件、connector_id 变化、恢复配置；拒绝继续使用旧授权 | 首次更新 Core + Worker 并重启；后续 scope 修改无需重启 |
| W-4 / H42 | 4 MiB VCD 限制过早截断 p32/p38 长仿真 | `connector/vivado.ts` 默认 16 MiB，config/env 可配 1..64 MiB，非法值启动失败 | 默认/环境/配置优先级、越界拒绝、实际生成 Tcl；source/bundle 行为一致 | 更新并重启 Worker |
| W-5 / H43 | p38 SCENE 11 和末尾指标被普通 PASS 窗口挤掉 | `connector/log-digest.ts` 新增独立 `judging` 通道，最多 256 行、保首尾、报告 total/truncated | 60 行普通 PASS 后场景/指标仍保留；大量关键行溢出可见；source/bundle 一致 | 更新并重启 Worker |
| W-6 / H44 | validate 漏编译错误，直到 simulate elaborate 才发现 | `connector/vivado.ts` 的 validate_sources 调用配置 Vivado 同目录 xvlog；保语言模式、源顺序与 include 路径；不调用 xelab | mock compiler 成功/失败、stdout/digest 留证；本地 tclsh 执行生成脚本，双平台命令/带空格路径/失败状态传播；source/bundle 一致 | 更新并重启 Worker；66 机真实 xvlog smoke 待窗口 |
| W-7 / H45 | p32/p37 internal error 恢复失败没有根因 | `runtime/error-diagnostic.ts`、`runtime/server.ts` 记录 stack/cause 到 stderr 和恢复失败 endedReason | 完整 HTTP 合成 Project Agent 恢复失败后，落盘原因含文件调用位置和嵌套 cause；长/循环/非 Error 异常测试 | 更新并重启 Runtime |
| W-8 / H46 | `._agent-*.json` 被当成会话读取，H13 复发 | `runtime/agent-state.ts` / `runtime/free-agent.ts` 在枚举、加载和追加注记入口忽略 `._` 前缀 | resource fork 跳过；有效会话照常加载；真实 JSON 损坏仍报错 | 更新并重启 Runtime；无需删除文件 |
| W-9 | 四e/四f 仍记“未部署” | 台账修正为 57c51f0 于 2026-10-14 14:30 CST 已部署；新增 H39–H46、更新 H25 | Git 验证 `57c51f0` 是 `940c199` 祖先；保留开发阶段测试历史 | 文档，无重启 |
| W-10 | 缺统一收尾说明 | 本文记录矩阵、限制与窗口验收条件 | 文档交叉引用、diff 检查 | 文档，无重启 |

## 持久证据的范围

Worker 配置现有 `evidence_root` 用于本批普通作业证据。未显式指定时，WorkerRuntime 使用 workspace_root 的兄弟目录 `<workspace名>-evidence`。正式部署应选独立持久目录，不能放在被清理的 job workspace 内。

每个新完成作业以 `<evidence_root>/<jobId>/job.json` 和 `output/<证据名>` 保存终态、project/classification 绑定、完整 manifest 及文件。先在同卷 `.seal-*` 目录校验和写入，再 rename 发布；内存 manifest 只在发布后可见。registry 改为串行原子替换，仍仅保存最近 512 项；超出索引的终态作业也能按 jobId 加载。封存完成但 registry 尚未更新的崩溃窗口同样可恢复。

已有历史作业仍可从原 workspace 读取；已封存目录存在时不回退，以免掩盖证据丢失/损坏。不能恢复部署前已经被删除的文件；本批没有扫描或迁移生产旧证据。非终态作业重启仍标记 lost 并走既有补偿，不自动重跑。H32 的过程输出捕获 **5 MiB** 上限保留，证据仍限制 **单项 64 MiB / 每 job 总量 128 MiB / 64 项**。本批不新增自动清理证据策略，保留区容量由运维管理。

## 配置及判卷边界

- VCD 优先级：Worker `vcd_limit_mb` > 环境变量 `SYNTHIA_VCD_LIMIT_MB` > 默认 16。整数单位为 MiB，范围 1..64，空值/非整数/越界拒绝，修改后需重启 Worker。VCD 超限后仍是受控截断，不改变 TB 判定语义。
- scope 只重读 `project_scope`，保 connector_id 一致；损坏或丢失配置即拒绝请求。双侧配置应原子替换，更新时遵守现有配置权限与发布身份约束。TLS、endpoint、part/toolchain、active_config_sha256 仍按启动时身份固定，修改这些字段仍走原发布协议。
- 新 `logDigest.judging` 保留 DIGEST、TB PASS、SCENE、FRAME、PIXEL、SPRITE0、LINE_RATE_MBPS、GOODPUT_MBPS、DROPPED_PKTS、CYCLES_PER_PIXEL。每行沿用 400 字符上限；超过 256 行保留前 128/后 128 并显式标记截断。原 counts/performance/失败判断不变，完整日志仍通过 evidence 分页获取。
- xvlog 解析 .v/.sv（含对应 mediaType），保持输入编译顺序；.vh/.svh 只进入 include 查找目录，不作为独立编译单元；只有头文件的请求报 NO_COMPILABLE_SOURCES。生成脚本打印 compile phase 和编译输出，异常保留 CHILDSTATUS。未执行 xelab、综合或仿真；跨模块解析/elaboration 才能发现的问题仍由后续阶段负责。实际耗时及 Vivado 2021.1 Windows 行为需现场 smoke 确认。
- Runtime 单条异常诊断最多 8192 字符、最多 5 层 cause，循环检测；正常用户错误文案沿用原有消息。旧 endedReason 不追溯重写。`._` 文件仅忽略，不删除。

## 本地验证结果

| 检查 | 结果 |
|---|---|
| 受影响 Bun 套件，8 文件 | **168 pass / 0 fail** |
| 根目录 `env -u DATABASE_URL bun test`，144 文件 | **1619 pass / 410 skip / 0 fail** |
| `bun run check` | 通过，含 Core 类型、未定义标识符、GJB 文档检查 |
| `bunx tsc --noEmit -p runtime/tsconfig.json` | 通过 |
| `node --check connector/server.bundle.mjs` | 通过 |
| 同源码两次 Bun Node/ESM/minify 构建并 cmp | 字节一致 |

受影响套件：`connector/{worker,log-digest,vivado,worker-watchdog,worker-bundle}.test.ts`、`runtime/{closeout,server}.test.ts`、`core/tests/connector-scope-reload.test.ts`。测试使用合成 ID 和临时目录。

canonical `connector/server.bundle.mjs` 已随 TS 源码更新，SHA-256：`2163fc4e08cf802e52cfd679db348d4c7bd1b22e4a5ac665930c69d574e6f7f3`。这是本地构建，无正式 release/Gate 签发。410 项跳过主要涉及未配置的 PostgreSQL 集成环境；不将这些项目计为通过。Windows 看门狗仅做 Bun 源契约校验；Tcl 命令测试用 stub，无真实 Vivado 调用，66 机真实编译和互斥清场尚未验证。

## 部署窗口交接

本批不执行以下步骤；操作者安排窗口后按现有发布/验证协议完成：

1. 保留生产证据、配置、Runtime 状态和当前可回滚 release；按原流程签发/校验新 bundle 和相关 manifest/hash，确认 evidence_root 在持久盘且不在 job 清理目录。
2. 更新 Core 与 Runtime；更新 Worker 源码构建产物并重启 Worker。无需数据库迁移或前端构建。后续 project_scope 增删只需双侧原子更新配置。
3. 将 `synthia-worker` Scheduled Task 的 action 指向新 PowerShell supervisor，提供实际 Launcher/ConfigPath，保留 launcher 的既有身份/日志目录环境，设置 MultipleInstancesPolicy=IgnoreNew。无需扩大 PowerShell 执行权限。
4. 在 66 机用独立 smoke job 检查：连续/并发启动只留一个 Worker；孤儿 Worker 可清理、无关进程占端口则拒绝；作业终态后重启 Worker 仍可取 stdout/分页；scope 加入与撤销立即生效；VCD 默认 16 MiB；validate 的有效 HDL 成功、明确语法错误失败且不运行 xelab；digest 含末尾 SCENE/指标。无需向 p31–p38 发消息。

## 留待操作者裁决

不在本批实施：Worker 从 160T 切回 70T、删除 p33、模型看门狗从 30min 回 15min、H27 用户证据 UI、H34 矩阵平台强制。未变更现有 part 配置、看门狗阈值、基准会话或冻结域语义。

台账：[bench-lib-t2-harness-ledger.md](bench-lib-t2-harness-ledger.md)，四g / H39–H46。
