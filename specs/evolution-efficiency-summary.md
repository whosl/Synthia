# 自进化主页累计提效

`GET /api/v1/evolution/overview` 增加可选的 `efficiency` 投影，schema 保持 `evolution-overview.v1`。旧 Core 未返回该字段时，Web 显示统计暂不可用，不把缺失解释成零。

- 范围：全部历史技能版本，含已归档和已禁用技能。与当前版本的单技能指标区分。
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
