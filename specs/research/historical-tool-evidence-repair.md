# 历史运行指标与报告读取修复

2026-10-09，在 platform-ops worktree 开发与验证。用户随后授权重新部署，代码 `65c43b6` 已于当日 11:54 切换到正式站点，11:56 完成生产验收；详见 [部署回执](historical-tool-evidence-deployment.md)。开发阶段未重启生产服务，部署阶段只重启 Core、Web、Worker，Runtime 和 p31/p32 会话保持原状态。

## 复现与根因

生产只读检查发现 760 条 `tool_run` 仍在，其中 312 条成功；历史作业均没有 `config_epoch` 和 `validation_chain_hash`。自由项目的当前配置过滤正确地排除了这些旧作业，但原页面仅显示当前摘要，因此把历史时序、资源以及运行次数一起隐藏了。

Core 保存的清单包含 51 份 `sta.rpt` 与 96 份 `resources.rpt`。Worker 的重启快照只保留最近 512 个作业；超出快照的历史文件仍可能存在，但内容端点此前先要求内存中有作业与项目绑定，于是返回 `JOB_NOT_FOUND`。p11、p13 的报告文件仍存在，大小与 SHA-256 均匹配 Core 持久化清单；p28 的报告仍可正常读取。

## 修复行为

- 当前 `stages`、`validationState`、码流判定继续使用配置 epoch、验证链和依赖顺序；不回填旧作业归属，不让改回配置复活旧验证。
- `tool-summary.history` 提供全项目累计运行次数、成功/失败次数。当前配置缺少指标时，提供最近一次成功报告的历史时序、资源、原作业及日期；资源容量取自原报告器件。
- 工程全景与顶栏展示历史指标并标明历史归属，提供原运行记录/STA 原文入口。当前配置未运行时明确显示“当前配置尚未运行”。兼容历史清单的对象和数组形态。
- 终态报告清单优先读 Core 的持久化记录；Worker 不在线或索引已淘汰也不影响清单展示。
- 内容读取仅在 Worker 返回 `JOB_NOT_FOUND` 时，由 Core 从已归属该项目的终态作业清单取出条目，通过内部 `archived_entry` 协议重试。HTTP 用户不能提供恢复条目。
- Worker 仅允许可信 Core 服务 `synthia-core` 使用该通道，仍检查 endpoint 项目与分类范围。已知作业的原项目/分类绑定不能被覆盖；仅作业和绑定都不存在时允许恢复读取。
- Worker 只读固定的 `<workspace_root>/<jobId>/output/<name>`，拒绝额外 URI、路径穿越、符号链接、不合法大小及不匹配的 SHA-256。完整文件与分页继续走已有的完整性校验。此过程不恢复运行状态、不写 registry、不触发工具执行。

协议为可选扩展，无数据库迁移。Canonical Worker 源码和 `connector/server.bundle.mjs` 同轮更新；bundle 70,789 字节，SHA-256 `4bef8d340de434f787f2ed801fea76ec7b8efc42023624e25c5533b7f9e3dcd8`。

## 验证

所有数据库测试使用本机临时 PostgreSQL 16 实例，未使用生产数据库执行测试。

- 受影响测试：100 通过、0 失败，覆盖 Core 作业 API、配置 epoch、历史清单、资源摘要、真实 Core HTTP → RemoteConnectorAdapter → RemoteConnectorClient → Worker HTTP 链路、Worker 内容/分页/边界校验以及 canonical bundle。
- 新回归验证：旧 NULL epoch 作业与新失败报告并存时，选取最新成功报告而非较旧缓存；变更器件后历史指标仍可读，当前四阶段与码流仍待验证；文件篡改被拒绝；跨项目、跨分类、未列入清单、符号链接均拒绝；恢复读取不创建或执行作业。
- Web：592 通过、0 失败；`vue-tsc` 与 Vite 构建通过。构建仍有原有 Monaco 大 chunk 提示。
- `bun run check`、Runtime TypeScript 检查、Node bundle 语法检查、`git diff --check` 通过。
- 保存的 p28 真实报告解析结果：WNS 0.591 ns、TNS 0、WHS 0.042 ns，LUT 12,896、FF 7,232、BRAM 1.5、DSP 64；容量来自报告中的 `7k70tfbv676-1`，不套用项目当前器件。
- 根目录全量 `bun test`（含隔离数据库与 Web）：1,924 通过、14 失败。随后在修改前 `57c51f0` 的独立 checkout 与独立测试数据库复跑失败的 6 个文件，复现完全相同的 14 项失败；对失败集合做程序化比较一致。本次没有新增这些失败。新增真实历史报告 HTTP 用例另行通过，计入上述受影响的 100 项。

已有失败分布：evolution-eval 迁移一致性/已退休表函数 3 项，导入权限 1 项，旧 evidence authority trigger fixture 1 项，正式流程输入清单绑定 1 项，P4 schema/migration parity 1 项，P4 HTTP 正式任务绑定/输入清单 7 项。本批不修改这些独立治理行为或历史测试预期。

## 生效窗口

需要更新 Worker canonical bundle、Core 代码和 Web 构建；Runtime 无改动，无需重启。窗口内先更新 Worker，再更新 Core 与 Web，并同步现有 Worker/Core 部署配置中的 bundle build hash。保留旧 registry、workspace 和 Core 数据，按原部署协议备份、校验及切换。

部署后已检查 p11/p13/p28 的历史 summary、报告清单与原文，冻结 SHA-256、原器件/作业归属均一致；当前验证未被历史报告提升。生产恢复结果与备份路径以部署回执为准。
