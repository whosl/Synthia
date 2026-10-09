# Remediation 唯一剩余技能归属修复部署

2026-10-09，按用户指令“继续把 fix/remediation-assign-by-elimination 纳入”，将来源提交 `ae37a3c36f86a94a16804866365ccc6353c09020` 合入当前部署基线 `775420d`。最终部署代码为 `9e76726849da77b72eafd9a72aefae948140058f`；2026-10-09 15:11:25（Asia/Shanghai）完成 Golden 切换。

## 修复与验证

Curator 输出中若恰有一个 remediation 省略 `skill_id`，且其余条目明确归属后恰好剩一个 claim 内技能，则通过排除法补齐该 ID。多条缺失、显式错误 ID、重复归属、不完整条目和 null ID 继续拒绝。版本 ID 与 control revision 仍从 claim 取得，Core 继续负责 CAS 与审计。

来源生产代码在 `runtime/evolution-workers.ts` 中逐字节一致。本次另外增加测试，验证三技能乱序输出下首条 patch 的唯一归属及 claim CAS 值，并覆盖五类拒绝路径；保留来源的两技能测试及此前自进化容错测试。

- 自进化 workers/client/service/scheduler/model adapter：139 pass / 0 fail。
- Runtime `bunx tsc --noEmit -p runtime/tsconfig.json`：通过。
- 根目录 `env -u DATABASE_URL bun run test`：1005 pass / 407 skip / 0 fail；407 项数据库门控测试未执行，不计为通过。本次没有数据库、Core、Web 或 Connector 代码变更，未重跑数据库全量或 Web 构建。

## 部署与验收

运行目录 `/data3/dev/synthia-golden` 从 `775420d` 切换至 `9e76726`，只重启 `synthia-evolution-workers`，PID `2348714 → 2696650`。Core PID `2348505`、Runtime PID `2348653`、Web PID `2348736` 和 Worker PID `41924` 保持不变。切换前无运行中的蒸馏/整理任务；四个本机服务均 active/running，自动重启计数为 0，启动日志没有模块/语法/启动失败。

本次没有修改模型参数、数据库迁移、权限、前端开关或器件策略。Web 使用已有 golden 构建产物，新发布目录为 `/data3/dev/synthia-web-releases/remediation-9e76726-golden-20261009-151036`，只更新 release 元数据并切换软链接。公网 `release.json` 返回 200，应用和自进化后台提交为 `9e76726`，Core/Runtime/Web 提交仍准确记录为 `775420d`，四个 golden 前端开关均启用。

验收确认：

- 23 个 Runtime 会话状态相同，68 个会话/状态文件 hash 相同；p31/p32 仍为 awaiting_user。
- Core 任务 ID/状态/更新时间、作业状态计数及迁移记录与切换前一致。
- 自进化 overview、35 个 Learned Skill、p31/p32 tasks 和 p11/p13/p28 tool-summary 均返回 200。三个项目历史 WNS 保持 4.249/1.348/0.591 ns。
- Worker 继续运行原 bundle，SHA-256 为 `4bef8d340de434f787f2ed801fea76ec7b8efc42023624e25c5533b7f9e3dcd8`。

本次没有手动重新入队失败 curator run、启动模型推理或提交 Vivado 作业；修复已由新后台进程加载，后续正常整理轮次使用新解析规则。

## 备份与回滚

私有备份 `/home/wenzhuolin/.synthia/backups/remediation-elimination-20261009-151036` 包含 59,907,643 字节生产数据库 dump、原服务 units、会话和 scheduler 状态、前后 hash/状态、测试及验收记录。凭据和生产状态未纳入 Git。

如需回滚，在自进化任务空闲时停止后台，将 Golden 代码切回 `775420d`、Web 软链接切回 `/data3/dev/synthia-web-releases/selfevo-775420d-golden-20261009-141106`，再启动后台；其余服务无需重启，无需回滚数据库。
