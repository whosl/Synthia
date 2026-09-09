# Project Agent + 临时 Run / Side Agent 发布验证记录

- 适用切片：`implementation-plan-v1.md` 的 P3 主 Agent 生命周期修正
- 记录日期：2026-08-26
- 状态：真实本地栈可手动验收；模型成功回复和生产 Vivado 执行仍需环境恢复后补验
- 非目标：自动启动 goal、自动推进 G0～G4、删除历史 Run/Side 事实、把探索结果自动采纳到正式主线

## 1. 已实现的产品语义

每个 Project 只有一个稳定的 Project Agent。它拥有项目主对话，单轮模型或网络失败只结束当前轮，Agent 回到 `awaiting_user`，不会把整条主线变成一次性失败任务。Runtime 重启时，中断的 Project Agent 轮次同样回到可继续对话状态，并记录可见的中断说明。

正式工程执行与主对话分离：

- `agent_role=project`：每项目唯一的持久对话，不进入自动工程 loop；
- `agent_role=run`：有边界的正式工程 Run，只有它能恢复或推进受治理流程；
- `agent_role=side`：绑定 Project Agent 的临时探索任务，只能使用隔离工作区和 `exploratory` 运行类别，不能提门、建里程碑或启动 formal run。

Web 右侧 Agent 窗格固定显示“主线”和 `＋`。`＋` 打开 Side Agent 创建表单，要求探索目标和精确写入路径；Side Agent 标签上的 `×` 只把窗格归档到本浏览器，不取消、不删除 Core 任务、事件、结果或工作区事实。正式流程入口仍独立显示为“正式流程 G0”。

## 2. 真实数据链路

本切片没有为生产页建立 fixture-only 成功路径：

```text
Web Agent 窗格
  → Core /projects/:id/tasks 与 /events
    → PostgreSQL agent_task / task_conversation_event
      → Runtime register → bind → start/message
        → 模型与受 Core 约束的工具
          → Connector（Vivado 由 connect.wenzhuolin.xyz 的真实配置提供）
```

`0012_project_agents.sql` 为 `agent_task` 增加 `agent_role`，约束 main 只能是 project/run、side 只能是 side，并用部分唯一索引保证每项目只有一个 Project Agent。旧 main 数据按历史 Run 保留，不静默升级成 Project Agent。

Project Agent 的用户消息、Agent 文本、工具调用/结果和取消事件由 Core 持久化。Web 通过 `/tasks/:id/events` 增量投影，因此刷新和 Runtime 重启后仍能恢复多轮对话；`.runs/` 只承担 Runtime 恢复材料，不是唯一事实源。

## 3. 本轮自动验证

| 检查 | 结果 | 说明 |
|---|---|---|
| Runtime 回归 | `104 pass / 0 fail` | `runtime/server.test.ts` 60 项、`runtime/free-agent.test.ts` 44 项；覆盖 Project Agent 单轮失败、旧 callback 失败清理、重启恢复及 Run/Side fail-closed |
| Core PostgreSQL/API | `82 pass / 0 fail / 842 assertions` | 在专用临时数据库运行 `api-side-tasks`、`api-run`、`postgres-contract`；覆盖 role/index、Project Agent 生命周期、Side 隔离、abort 幂等与 Connector 参数，随后删除该临时库 |
| Web 全量 | `437 pass / 0 fail / 2038 assertions` | `bun run check`、`bun run build` 同样为零退出；生产构建仅保留既有 large-chunk 提示 |
| Runtime TypeScript | **非零，20 条历史诊断** | 与 P4 固定基线一致；不能记为“类型检查通过”，本切片相关回归测试通过 |
| 补丁卫生 | 通过 | `git diff --check` 零输出；`.claude/`、`.edagent/` 未纳入本切片 |

核心回归命令：

```sh
bun test runtime/server.test.ts runtime/free-agent.test.ts
bun test core/tests/postgres-contract.test.ts
bunx tsc --noEmit -p runtime/tsconfig.json

cd web
bun test
bun run check
bun run build
```

数据库行为测试只能指向专用、可销毁的 fresh database。不得把 `DATABASE_URL` 指向本地 UI、共享或生产数据库后运行会 truncate/drop 的测试。

## 4. 真实浏览器验证

真实目标：`http://127.0.0.1:5180/projects/p1`，由真实 Web、Core `127.0.0.1:5130`、Runtime `127.0.0.1:8790` 和 PostgreSQL 提供数据；不是 `dev:mock`。

| 场景 | 证据 | 结果 |
|---|---|---|
| Project Agent 稳定身份 | 刷新和 Runtime 重启后 URL 仍绑定同一 Project Agent，Core 状态为 `awaiting_user` 且 `finished_at=null` | 通过 |
| 持久化多轮对话 | 刷新后仍显示多条 user/assistant 事件和模型错误回复 | 通过 |
| 正式流程隔离 | 页面始终显示“正式流程 G0”；Core `currentGate=G0`、`completed=false` | 通过 |
| Side Agent 入口 | `＋` 展示探索目标、精确写路径、父 Project Agent 和“创建隔离副本” | 通过 |
| 窗格归档 | 已归档 Side Agent 刷新后仍隐藏；Core 任务事实保留 | 通过 |
| 桌面 1280×720 | document/body 无横向溢出，主线、历史、composer 与正式入口可见 | 通过 |
| 390×844 | 打开移动端对话栏后主线、`＋`、历史与 composer 可操作；scroll width 为 390 | 通过 |
| 320×720 | 同上；长历史和错误文本不撑宽页面，scroll width 为 320 | 通过 |
| console/network | 本轮无 warning/error；117 个响应无 4xx/5xx 或 loading failure；主 stream 只建立一次，无重复 reconnect loop | 通过 |

旧验收 Side Agent 通过 Core 的正常 abort 路径收敛为 `cancelled/discarded`；任务、事件和工作区事实均未删除。Runtime 已去掉临时的 15 秒/零重试/无 fallback 覆盖并按默认模型超时、重试和 fallback 配置重启；Project Agent 随后恢复为 `awaiting_user`。

## 5. 已知限制与必须补验项

### 5.1 模型入口当前不可达

真实模型流当前会连接失败或在收不到首字节时超时。因此本轮真实验证证明了“错误可见、同一 Project Agent 可继续、刷新后错误保留、G0 不推进”，但没有证明一次成功的模型文本回复。模型入口恢复后必须用同一 Project Agent 再发一轮，确认成功文本、流式状态和后续轮次均正常。

### 5.2 Vivado 未在本切片中执行

Core 保留指向 `connect.wenzhuolin.xyz` 的真实 Connector 配置，但本切片按产品语义没有启动正式 Run，也没有推进 G0，所以没有触发 Vivado。模型/Connector 可用后，应另建 Side Agent 验证 exploratory 结果、diff 和人工采纳，再从独立“正式流程”入口验证受治理的 Vivado Run。不能用“Connector 已配置”替代“Vivado 已执行”的证据。

### 5.3 当前 p1 数据库不是完整恢复证据

验收期间曾有 PostgreSQL 行为测试被错误指向本地 UI 数据库并清理了 `p1` 的数据库事实。项目、工程 profile、G0 实例和所需 service 角色已恢复；磁盘工作区与 Git 历史一直保留。但历史 artifact/task 数据库事实没有完整重建，所以当前文件树会显示“未登记”。

因此：

- 不得声称当前数据库无损恢复；
- 不得把“未登记”误判为磁盘文件丢失；
- 后续数据库测试必须使用独立 disposable database；
- 正式发布前仍需按 P5 做完整备份/恢复 round-trip。

## 6. 手动验收入口

服务保持运行：Web `127.0.0.1:5180`、Core `127.0.0.1:5130`、Runtime `127.0.0.1:8790`。从项目 `p1` 打开工作台即可验证；不要使用 `dev:mock`，不要通过旧 Run URL 判断 Project Agent 身份。

验收时应分别观察 Project Agent、Run、Side Agent 三种角色，不把右侧窗格切换等同于正式流程切换。完整人工步骤见本次交付回复中的验证清单。
