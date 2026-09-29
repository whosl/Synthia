# 自进化主页累计提效

`GET /api/v1/evolution/overview` 增加可选的 `efficiency` 投影，schema 保持 `evolution-overview.v1`。旧 Core 未返回该字段时，Web 显示统计暂不可用，不把缺失解释成零。

- 范围：全部历史技能版本，含已归档和已禁用技能。单技能概览也按全部版本累计，主页进一步跨技能汇总。
- 每次 application 仅按 primary 归因计一次；supporting 不重复计数。采用该版本最新且未被 supersede 的评价。
- 只比较当前评价为 success 且源任务和复用时长都为正、完整的调用。失败、待评价、证据不足和缺失时长不产生省时估算。
- 源任务：技能 v1 蒸馏源 episode 所在任务，从任务开始到 episode 封存的事件序列。
- 复用：application 的 start/end event sequence 范围。
- 两侧均按相邻事件时间差求和，每个正间隔最多计 600 秒；不按原始跨日墙钟时间计量。
- `baseline_total_ms` 为每次可比成功调用对应的源任务时长之和；`applied_total_ms` 为这些调用的实际活跃时长之和。
- `net_saved_ms = baseline_total_ms - applied_total_ms`，保留负值。更慢的成功调用会扣减总收益。
- `speedup = baseline_total_ms / applied_total_ms`，不是各技能倍率的算术平均。
- `compared_applications / successful_applications` 表示成功调用中的可比覆盖率；`compared_skills` 表示有可比调用的技能数量。
- 无可比调用时 measurement_state 为 unknown，时长、净省时和倍率均为 null。

主页明确标注“估算”，提供总时长对比图和可展开口径。此指标是相对源任务探索过程的观测对比，并不是相同任务的因果对照实验，也不等同于人工工时、端到端交付提速或系统运行成本节省。

查询只返回汇总事实，沿用 overview 的访问控制，不返回任务内容或项目身份。列表分页与技能搜索不会改变总数。

## 单技能累计效果

`learned-skill-summary.v1` 的 `metrics` 按 `skill_id` 聚合全部历史版本，新增 `metrics_scope: "all_versions"`。列表、详情和搜索使用相同口径，切换、重铸或撤下当前版本不会重置历史统计。可用性与质量状态仍属于当前版本。

- 只统计 primary 应用，每条应用采用实际使用版本最新且未被 supersede 的评价；supporting 不重复归因。
- 解决率 = 成功数 /（成功数 + 适用性失败数 + 执行失败数）；待评价和证据不足不进入分母，无有效评价时保持未知。
- 中位活跃时长从全部历史版本的已评价应用重算；人工纠正数汇总已知值。提效仍以首版源轨迹为基线，对比全部版本成功应用的中位活跃时长，不平均版本解决率、中位数或倍率。
- `learned-skill-version.v1` 的 `version.metrics` 提供所选版本独立统计，`skill.metrics` 为全部版本累计。历史应用和评价的版本归属不改写，无数据迁移。
- Web 明示“全部版本累计”，版本页独立展示所选版本解决率和主用数。旧 Core 缺少 `metrics_scope` 时仍标注“当前版本统计”，缺少 `version.metrics` 时显示暂不可用。
