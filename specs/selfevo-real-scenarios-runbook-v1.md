# Self-Evolution 真实场景驱动手册 v1（golden 栈部署后执行）

目标：通过真实用户消息（真实 GLM agent + 真实 Vivado validate/simulate @8443）在
golden 栈（synthia_real_ui@55432）产出 4 组自进化真实足迹。

## 前置（部署完成时已就绪）

- Core 5130（SYNTHIA_FEATURE_SELF_EVOLUTION=1），Runtime 8791（同 flag + GLM）
- evolution workers 宿主运行中：`SYNTHIA_CORE_URL=http://127.0.0.1:5130 \
  SYNTHIA_EVOLUTION_DISTILLER_TOKEN=… SYNTHIA_EVOLUTION_CURATOR_TOKEN=… \
  SYNTHIA_MODEL_URL=https://open.bigmodel.cn/api/anthropic SYNTHIA_MODEL_API=anthropic-messages \
  SYNTHIA_MODEL_NAME=glm-5.3-flash SYNTHIA_MODEL_KEY=… bun run scripts/run-evolution-workers.ts`
- distiller/curator token：bootstrap 如缺则用 `core/scripts/bootstrap-self-evolution-gate.ts`
  同机制补发（golden DB 上只能走一次性 bootstrap，勿重复）
- 观察面板：web 4173 /evolution（EvolutionView）；DB 直查见文末

## 协议（runtime 直达，与 runtime/server.test.ts 真实编码一致）

```
POST {RUNTIME}/tasks            {project_id, process_instance_id, task, mode:"agent",
                                 task_id, task_kind:"main", execution_intent:"project_agent",
                                 authorization_scope:{schema:"task-scope.v1", workspace:"project",
                                   read_paths/write_paths:[rtl/tb/doc/prj]**,
                                   run_classes:[exploratory,gate_check,formal], …}}
POST {RUNTIME}/tasks/:id/start           → 200
POST {RUNTIME}/tasks/:id/message {text}  → 用户后续消息（人工修正场景用）
GET  {RUNTIME}/tasks/:id                 → status: awaiting_user/completed/failed…
```
用户消息本质 = task 文本 + /message 跟进。每轮到 awaiting_user 时 runtime 自动封存
learning episode（turn 边界），agent 循环内自动搜索/应用 learned skill。

## 场景

材料：golden/uart、golden/bench-lib 参考源（拷贝小模块文本进消息/task 工作区写入请求）。
一律 target_part=xc7k70tfbv676-1。Vivado 仅 validate_sources + simulate（禁硬件流）。

### S1 习得成功（create → applied → active_observed）
1. 同类任务 ×3：「用 Vivado validate 检查 <uart_tx_fifo 源码>，修复所有语法/综合问题并回报」
2. 等 distiller（GLM）从 3 个 episode 提炼技能（轮询 learned_skill 表）
3. 第 4 个同类任务（不同模块、同方法）→ agent 搜索命中并应用 skill → application 落库
4. curator 定期调度评估 → success → active_observed
预期足迹：learning_episode×N、distillation_run(create)、learned_skill+version(active_unproven→…)、
skill_application、curator_run+evaluations(success)、lifecycle create_version_activated/quality_evaluated

### S2 失败 + 人工修正（patch）
1. 任务带确定性 HDL 错误（如位宽截断/缺端口）→ validate 真实失败
2. /message 发明确人工修正指示（「把 data_width 改为 8 并补齐 fifo 满标志逻辑」）
3. agent 修复成功 → episode 含人工修正证据
4. distiller 规则允许：失败 episode 在「explicit human correction」证据下可 patch 既有技能
预期：S1 技能 version+1（patch）、application、curator 评估

### S3 失败降级（execution_failure → degraded → quarantined）
1. 构造技能应用必然失败的任务（技能方法依赖 sim，但任务环境只给 validate 语义；
   或注入固定缺陷源码使 Vivado 真实报错）
2. 连续 ≥3 次应用失败（真实工具错误码进证据）
3. curator 评估 execution_failure → degraded；继续失败 → quarantined（含阴性冻结语义：
   后续 agent 搜索不再命中）
预期：applications(failed)×3、evaluations(execution_failure)、lifecycle state degraded/quarantined

### S4 证据不足（needs_review）
1. 一次应用证据不全（任务中途 cancel / 工具超时无定论输出）
2. curator 置信度 <0.7 → inconclusive → needs_review
预期：evaluations(inconclusive)、state needs_review

## 验证 SQL（synthia_real_ui@55432）

```sql
SELECT id,slug,availability_state FROM learned_skill ORDER BY created_at;
SELECT skill_id,version_id,quality_state,created_at FROM learned_skill_version ORDER BY created_at;
SELECT state,count(*) FROM distillation_run GROUP BY 1;
SELECT application_id,skill_version_id,outcome FROM skill_application ORDER BY created_at;
SELECT id,state,outcome,confidence_decile FROM curator_evaluation ORDER BY created_at;
SELECT event_type,count(*) FROM learned_skill_lifecycle_event GROUP BY 1 ORDER BY 1;
SELECT count(*) FROM learning_episode;
```

## 红线

- 绝不 hw_server/program_hw/任何硬件流；8443 仅 validate_sources/simulate
- 不动 golden 线其余功能面；场景项目独立 project（selfevo-s1…s4），跑完留证据不清理
- GLM key / token 只进进程 env，不落盘不进仓
