# Selfevo 更新与中位耗时前端契约修复部署

按用户“selfevo 那边又有更新，同步并修复 median_duration_ms 报错”的指令，2026-10-09 16:41:19（Asia/Shanghai）完成 Golden 切换。运行代码为 `b23a3ef425da4ce847ab7fc6700e0104dd7393d0`，目录 `/data3/dev/synthia-golden`。

## 页面错误根因与修复

正式 API 第 7 个技能 `lsk_23233d2d-93ee-4f63-968b-115aae78de7b` 返回 `metrics.median_duration_ms=210982.5`。Core 对偶数个整数毫秒样本取中间两个值的均值，合法中位数可带半毫秒；Web 使用 nullableInteger 校验该字段，使整份 Learned Skill 列表被拒绝。

前端将这一字段改为接受 null 或非负有限数，保留原始中位数、不取整、不改生产数据；负数、NaN、Infinity、字符串和缺失字段仍拒绝。计数、人为修正次数等字段继续要求非负整数。列表、详情和所选版本共同使用修正后的 metrics 解析器。

使用真实线上列表、出错技能详情及版本响应进行修复前后对照：旧解析器准确报 `learned skill list.items[6].metrics.median_duration_ms must be a non-negative integer`；新解析器成功解析全部 35 个技能以及详情/版本，保留 `210982.5`。部署后再次使用 Golden 内的新解析器读取线上列表，通过相同校验。

新增测试覆盖第 7 项小数中位数不会阻断 API 列表、summary/detail/version 保留小数、0/null 兼容、无效值拒绝、计数整数约束；Core 测试验证 `[210982,210983]` 的中位数保持 `210982.5`。

## Selfevo 同步

新增更新位于 `/data3/dev/synthia` 的 `fix/attributable-downgrade`，来源提交 `f0c331bae9303e7bf8f6c2ef24c6514d39fddeb2`；原 selfevo worktree 的 `fix/remediation-assign-by-elimination` 仍为已部署的 `ae37a3c`。本次合入 f0c331b，保留上一轮唯一剩余技能归属修复和所有现有 harness/配置/历史证据修复。

Curator 的 attributable outcome 若没有引用证据，自动降为 inconclusive，并在 reason 追加 `[auto-downgraded: attributable outcome cited no evidence]`。其他同轮有证据的评估继续正常提交；claim 外的证据引用仍拒绝，低置信度等校验保留，Core 继续负责治理与写入。运行生产源码 `runtime/evolution-workers.ts` 与来源提交一致。

除来源测试外，增加三个无证据 outcome 与同轮有证据 success 的隔离测试，以及 claim 外引用仍失败的测试。本次没有手动重新入队失败 run、改写已有评估或启动新的模型/Vivado 请求。

## 验证与部署

| 验证 | 结果 |
| --- | --- |
| 中位数相关 Core/Web 三文件测试 | 26 pass / 0 fail |
| 自进化 workers/client/service/scheduler/model adapter | 142 pass / 0 fail |
| Web 全量 | 597 pass / 0 fail |
| 根目录 env -u DATABASE_URL bun run test | 1009 pass / 407 skip / 0 fail |
| Core check、Runtime tsc、Web check | 通过 |
| Web bun run build:golden | 通过 |

407 项为未配置测试数据库的门控测试，本次未执行，不能计为通过。本轮没有 Core 生产代码或数据库迁移变化，未重复数据库全量回归。生产 API replay、服务状态和公网资源检查均完成；没有将这些检查描述为浏览器渲染测试。

只重启自进化后台（PID `2696650 → 3354033`）与 Web（`2348736 → 3354054`）；Core PID `2348505`、Runtime PID `2348653`、Worker PID `41924` 保持不变。切换前没有运行中的整理/蒸馏任务；四个本机服务均 active/running，无自动重启或启动错误。

Web 发布目录 `/data3/dev/synthia-web-releases/selfevo-median-b23a3ef-golden-20261009-164017`。release 正确记录 Web/自进化后台为本次提交，Core/Runtime 仍为 `775420d`；自进化、历史材料、探索任务、正式交付四个 golden 开关均启用。公网首页、release 和资源均返回 200，入口 `/assets/index-COvSNB0o.js` 以及自进化导航资源 `/assets/index-DQdrJIim.js` 与本机发布目录逐字节一致。入口 SHA-256 为 `4e730b0e20a7556ce9e3ff2592369cab673557949b8e26c20d67097999316760`。

23 个 Runtime 会话状态、68 个会话/状态文件 hash、Core 任务状态/更新时间、作业状态计数、迁移记录均与切换前一致；p31/p32 仍 awaiting_user。自进化 overview、35 个技能列表及 p31/p32 tasks 返回 200。p11/p13/p28 的历史 WNS 保持 4.249/1.348/0.591 ns。

## 备份与回滚

私有备份 `/home/wenzhuolin/.synthia/backups/selfevo-median-20261009-164017`：59,914,302 字节生产数据库 dump、服务 units、Runtime/scheduler 状态、前后 hash/数据库状态、真实 API 响应、测试及验收记录。生产状态和凭据未提交 Git。

回滚需在自进化任务空闲时停止后台和 Web，将 Golden 切回 `9e76726849da77b72eafd9a72aefae948140058f`、Web 软链接切回 `/data3/dev/synthia-web-releases/remediation-9e76726-golden-20261009-151036`，再启动两个服务；其余服务和数据库无需回滚。回滚前端也会恢复旧的小数中位数报错，应明确考虑这一限制。
