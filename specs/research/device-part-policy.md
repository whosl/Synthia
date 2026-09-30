# 器件（part）策略设计笔记：自由项目不锁器件

- 日期：2026-09-30；来源：T3 jpegencode 160T 对照实验（p29/p30）的复盘讨论
- 状态：设计共识（用户裁决），未排期实现

## 原则（用户原话归纳）

**器件锁死是「基准样例协议」的要求，不是平台法。** 目前推样例期把 part 固定死，
是为了盲测证据链（任务书冻结、全部 job 对同一 descriptor 负责）；但自由项目
（free-form project）理论上应当可以随便改器件——换器件探索、原型迭代、
板卡迁移都是正常用户行为，不该被平台拦住。

## 现状：器件活在三层，只有一层用户可见可改

| 层 | 现状 | 问题 |
|---|---|---|
| 任务书（task descriptor） | 创建时带 `part`，explicit-start 后随 descriptorHash 冻结 | 自由项目也被连带冻结 |
| job 的 `part` 字段 | 每次提交自带 | 事实上已是逐单机制，只是被 worker 挡住 |
| worker 绑定 | 66 机 `vivado_part` 单值，全平台一个槽 | 全局串行切换；漂移即 FORMAL_BINDING_MISMATCH（p30 job-41de643a、p28 会话各中过一次）；切器件是操作者 SSH 级动作 |

净效应：用户在产品内没有任何改器件的路径；每个「同源异器件」实验都要操作者
手工克隆项目 + staging（p29/p30 即此产物，约 5 分钟/次）。

## 目标设计

1. **worker 多器件绑定**：`vivado_part` 从单值改为**列表**（或 `any` 模式），
   按 job.part 路由/校验。消除全局单槽与 FORMAL_BINDING_MISMATCH 整类问题。
2. **任务 part 分级**：
   - **基准类任务**（benchmark/blind-test）：维持现状——descriptor 冻结、
     part 不可改。这是实验方法论的组成部分，不是缺陷。
   - **自由类任务**：`part` 是**可编辑的项目元数据**（idle 态可改，running 回合
     不改）；job 仍逐单带 part，默认取项目当前值。descriptorHash 只冻结任务书
     文本，不含 part（或自由类改 part 时按新 part 重算哈希并留变更事件）。
3. **产品面**：项目设置里暴露器件编辑 + 「克隆到器件 X」一等操作（源集+TB+约束
   打包带过去），替代手工 staging。

## 治理边界（改器件不等于放开口子）

- 用户/项目主可改自由项目的 part；agent 仍只能逐单提交 part 且必须在 worker
  绑定列表内——worker 绑定是**运维资源边界**（licence/机时），不是实验控制。
- 基准类项目即使操作者也不能免冻结改器件：要换器件就克隆新项目（p29/p30
  模式），保证每个项目时间线对应一份考卷。

## 实现落点（排期时展开）

- `connector/server.bundle.mjs`：worker 侧 part 校验改列表匹配
- `core/src/api/handlers.ts` / task-proxy：自由类任务 part 可变 + 变更事件
- web：项目设置器件编辑 + 克隆到器件操作
- 迁移：现有 p17-p30 全部按基准类语义保留，不受影响
