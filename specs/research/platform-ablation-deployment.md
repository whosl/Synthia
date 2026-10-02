# 平台消融版本部署回执

2026-10-02 07:55:39（Asia/Shanghai），按用户“重新部署，然后通知指定 agent 可以继续推 T3”的指令完成部署。

- 代码版本：`42cf5faff7589feb449cb22404b263e0c5a4b8f6`；运行目录：`/data3/dev/synthia-golden`。包含 H35/H36/H37、H34、H20，以及删除 937 行生产 TypeScript 的消融结果。
- 已重启并检查 Core（5130）、Runtime（8791）、Windows 66 机 Worker（8443）和 evolution workers。Web（4173）保持原进程、原前端资产；release.json 单独记录后端提交和原 web 提交 `eea5cc42c7ca104e6a3da40f434ed4448f9945aa`。
- Worker canonical bundle 为 69,408 字节。仓库/实际运行文件、Worker 注册配置、Core Connector 配置三处 build hash 一致：`15c430a29177b3fb44c3820ba48cc8cf557121cee8a87fd193693e03d169514c`。
- 实际 Windows 启动器、mTLS/PFX、Vivado 路径沿用现有配置。Worker part policy 保持 `xc7k160tffg676-1`；此次部署没有改变器件策略。

## 验证结果

- 部署前对相同 Windows Node 环境运行 6 项隔离执行检查：stdout/stderr、5 MiB UTF-8 截断、超时子进程清理、主动取消子进程清理、预取消不启动、H34 goodput 独立失败判定，全部通过。此项为执行预检，不冒充已退休 M4F 的正式 release certification。
- 部署后 18 项 HTTP 检查全部 200：Core projects，p31/p32/p33 各自详情/tasks/jobs/tool-summary，evolution overview，Runtime tasks，站点 release.json，以及真实 VCD 连续两页。站点首页另检查为 200。
- 直接 mTLS register/heartbeat/discovery 成功；9 项 capabilities，客户端 `ready`，`capability_drift=false`；实际配置 SHA-256 `c866948e517bac9f9b34199a83206a19b3b2d8d637e499faedc5b2bfb0cac925` 与 discovery 一致。
- H37 实测：p31 的 `job-acc013a2-0dfc-468e-860b-0ea3cd3e4fc2`，waveform.vcd 共 4,194,529 字节；offset=0/limit=512 与 offset=512/limit=512 连续读取成功，nextOffset=512，整文件 hash 保持一致。
- 23 个 Runtime 会话全部恢复，agent ID 与状态逐项保持一致；p31 `task-d142e3f722e8d8845a122e399a2c639f`、p32 `task-6bd05f30e7b5ce642095d915d97293f6` 仍为 `awaiting_user`。部署没有向会话发消息或运行新的 FPGA job。
- Worker 216 个历史作业索引保留。两个 application `app_189a9157-c97f-44f9-ab23-a377dccea796`、`app_ae7e49b8-7d00-44a4-89c6-5f0a2e9597a2` 在窗口前已为 `pending_evaluation`，窗口后逐项一致；本次没有关闭或变更它们。

## 备份与回滚证据

Linux 私有备份：`/home/wenzhuolin/.synthia/backups/platform-ablation-20261002-074102`，含生产 PostgreSQL dump、会话状态、旧 Connector 配置、systemd unit 备份、`deployment.json` 和 `live-health.json`。配置/备份含敏感信息，不纳入仓库。

Windows 备份：`D:\synthia-worker\deployments\platform-ablation-20261002-073646`，含旧 bundle、配置、启动器、216 项 jobs-registry 备份与部署回执。Worker watchdog 已恢复启用。

本回执记录已完成的部署；[消融报告](platform-predeploy-ablation.md) 和 [harness 开发报告](platform-harness-batch-20261002.md) 中“未部署”描述属于此前开发阶段，最新状态以本回执及 harness 台账四d 为准。
