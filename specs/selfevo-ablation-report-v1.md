# Self-Evolution 消融实验报告 v1

日期：2026-09-15 ｜ 分支：`ablation/selfevo-minimal`（519ab6e + 后续修复）｜ 基线：`integrate/selfevo-all` @ 394f7a4

## 动机

自进化线在 golden 栈真实运行 3 天（62 episodes、3 skills、10 evaluations），期间 M4-F
认证评测线（0029-0034）零业务流量：19+ 张 `evolution_eval_*` 表除 `evolution_eval_run`
（curator 预算副产物）外全部 0 行。用户裁决：全拆认证评测，保留学习内核，上生产。

## 删除面（-118,105 行）

| 层 | 删除内容 |
|---|---|
| Core API | evolution-eval/canary handlers、dispatcher 服务、connector port、sealed-input、xdc-scan、canary bootstrap、domain/evolution-eval、2 个 eval feature flags、eval 路由 |
| Connector | evolution-eval.ts、ledger、/evolution-eval/* 路由、EvolutionEvalWorker、sealed-workspace、全部 m4f-direct/ceremony 脚本 |
| Runtime | evolution-eval-client、evaluator、claim 的 eval_recovery/eval_input 字段、evaluator lane |
| 脚本/测试 | certify CLI、E2E runner+deterministic service、全部 eval/m4f 测试 |
| DB | 0035 迁移 DROP 25 张 eval 表 + 存活表上的 eval 触发器 + 全部 %evolution_eval% 函数；schema.sql 快照 4294 行缩减并重定基线 |

## 保留面（内核 100% 完好）

learning episodes、distiller/curator workers、learned skill + 版本 + 生命周期状态机、
skill applications、scheduler、model adapter、learned-skill 工具、EvolutionView、
以及 golden 线全部产品功能（web/权限卡/压缩/会话恢复）。

## 验证

1. `bun run check` 全绿（names 双绿 + tsc core 0 错）；runtime tsc 剩 4 条与消融无关的历史错
2. 测试：root 1782 / web 535 全过 0 fail（dead tests 已随机制删除）
3. 生产克隆演练：0035 应用后 eval 表 25→0，学习数据逐表核对零损（62/3/10/11/14）
4. fresh-install 路径：25 个 migration 全过，0 eval 表
5. **生产内核回归（消融后栈上）**：S1 场景全链真实跑通——新 episode 封存 → apply →
   close → curator 评估落库（第 10 条 evaluation），workers 在消融后二进制上正常循环

## 部署

- 生产库 0035 已应用（迁移前后 schema_migrations 证据已交 platform-ops）
- golden 树 detached @ 消融头（含 serve.ts launcher 修复 + driver 幂等键修复）
- 三服务 + evolution workers 重启，self_evolution_rollout=enabled，全 200
- platform-ops 做全栈验证与会话恢复（skipAll 重设）

## 遗留

- schema.sql 中 6 处 `evolution_eval` 字符串字面量属于 0033 分类 CHECK 的数据值（不影响）
- run_class 枚举值 'evolution_eval' 保留（PG 枚举值不可删，无行使用）
- L3 二期候选：dry_run、supersedes 链、supporting attach、scope_change remediation
