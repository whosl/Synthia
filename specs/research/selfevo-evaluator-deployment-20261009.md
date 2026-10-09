# Selfevo 项目自动评估角色部署回执

按用户“selfevo 又有更新，部署到 golden”的指令，2026-10-09 17:19:30（Asia/Shanghai）完成部署，运行代码 `940c19947bc4d323aa9ca3946051c965def24118`，目录 `/data3/dev/synthia-golden`。

## 更新范围

来源为 `/data3/dev/synthia/.claude/worktrees/selfevo` 的 `feat/auto-evaluator-role`，提交 `4cef89f6cdc0f5f02e9dcb8651d84f9d0bec8b32`。在现有 `b23a3ef` 部署基础上合入该新增提交；Core handler 生产源码与来源一致。

新建项目和复制为工程项目两条路径，均在项目写入的同一事务中为 `synthia-evolution-curator` 建立确定 ID 的 quality 角色：`role-evaluator-${projectId}`。新角色使后续正常整理轮次可读取该项目的可见证据，避免新项目因遗漏授权而始终获得遮蔽投影。正式后台 token 对应的服务身份已只读确认是 `synthia-evolution-curator`。

本次没有数据库迁移，没有回填旧项目角色或重写既有评估。角色分配随后续新建/复制项目生效。保留此前 selfevo 解析容错、唯一剩余技能归属、无证据评估降级、前端小数中位耗时及全部当前平台修复。

## 验证

- 隔离 PostgreSQL 16 中执行 self-evolution-api、project-model、api-slice、api-workspace、p4-project-access、self-evolution-contract：143 pass / 0 fail。
- 在来源新建项目测试之外，增加 free 创建与工程复制的相同 key/新 key 重放测试，验证每个项目仅一条 Curator role，原 owner role 保留；增加只读凭据拒绝和非法 profile 无项目/角色残留测试。project-model 使用 self-evolution rollout 未开启的既有 harness 配置，覆盖角色创建与该开关独立的行为。
- 根目录 `env -u DATABASE_URL bun run test`：1009 pass / 410 skip / 0 fail。410 项数据库门控测试未执行，不计为通过；上述相关数据库测试单独在隔离实例执行。
- `bun run check` 与 diff whitespace 检查通过。
- 本轮没有 Web、Runtime 或 Worker 源码变更，沿用已验证 golden 前端构建；没有重复 Web 构建、数据库全量回归或真实模型/Vivado 基准。

测试数据库与生产数据库完全分离，验证后已停止并删除临时 PostgreSQL。生产创建路径没有为验收额外创建测试项目。

## 部署与验收

只重启 Core，PID `2348505 → 3636995`。Runtime PID `2348653`、Web PID `3354054`、自进化后台 PID `3354033`、Worker PID `41924` 保持不变。切换前无 Runtime running 回合、在途 FPGA 作业或 running 整理/蒸馏任务。四个本机服务均 active/running，无自动重启或 Core 启动错误。

Web 使用相同资源的新发布目录 `/data3/dev/synthia-web-releases/selfevo-evaluator-940c199-golden-20261009-171824`，只调整 release 元数据和软链接。公网 release 正确记录应用/Core `940c199`、Runtime `775420d`、Web/自进化后台 `b23a3ef`；四个 golden 前端开关均启用。

公网首页、release 及资源返回 200；入口 `/assets/index-COvSNB0o.js` 与自进化导航资源 `/assets/index-DQdrJIim.js` 逐字节匹配发布目录。自进化 overview、35 个技能列表、p31/p32 tasks 与 p11/p13/p28 tool-summary 均返回 200；历史 WNS 保持 4.249/1.348/0.591 ns。完整技能列表通过现有前端解析器，原第 7 项中位数 `210982.5` 保留且解析成功。

23 个 Runtime 会话状态、68 个会话/状态文件 hash、Core 任务状态/更新时间、作业状态计数、迁移记录、项目和现有 role_assignment 均与切换前一致；p31/p32 仍 awaiting_user。Worker bundle SHA-256 仍为 `4bef8d340de434f787f2ed801fea76ec7b8efc42023624e25c5533b7f9e3dcd8`。

## 备份与回滚

私有备份 `/home/wenzhuolin/.synthia/backups/selfevo-evaluator-20261009-171824`：59,916,850 字节生产 PostgreSQL dump、服务 units、会话/scheduler 状态、前后文件 hash 和数据库状态、测试/类型检查及线上验收记录。生产状态和凭据未提交 Git。

回滚可在无在途 Core 操作的窗口停止 Core，将 Golden 切回 `b23a3ef425da4ce847ab7fc6700e0104dd7393d0`，Web 软链接切回 `/data3/dev/synthia-web-releases/selfevo-median-b23a3ef-golden-20261009-164017`，再启动 Core。其他服务不需重启；保留发布后新项目已产生的合法角色，不执行数据库回滚。
