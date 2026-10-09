# Selfevo 更新整合与 Golden 部署回执

用户授权“selfevo 那边有更新，你部署到 golden 上”后，2026-10-09 14:24:01（Asia/Shanghai）完成最终切换。

## 发布版本与范围

- 最终应用提交：`775420d4725a726fc4a62486c80b62f56f964c3b`，运行目录 `/data3/dev/synthia-golden`。
- 整合来源：`/data3/dev/synthia/.claude/worktrees/selfevo`，分支 `fix/close-evidence-autocollect`，HEAD `d9afb60dd9a542f2078db5decfd88bc0fdffa9bb`。
- 从当前部署代码 `65c43b6` 保留现有功能，再逐项合入 selfevo 的 17 个相关提交（`3fabca7` 至 `d9afb60`）；没有用旧分支整体覆盖部署目录。整合后 Core 自进化 handler、Runtime curator/claim client 及 Web 自进化数据接口与来源分支一致。
- 保留项目配置 epoch/器件绑定、H35 零值与数组校验、H36 模型看门狗、H37 证据分页、H38 输出续跑及静默结束修复、历史时序/资源展示、Worker 吞吐判定及此前消融结果。
- Web 发布目录：`/data3/dev/synthia-web-releases/selfevo-775420d-golden-20261009-141106`。使用 `bun run build:golden`；自进化、历史材料、探索任务、正式交付四个前端开关均为 true。

本次补齐的能力包括：中文 bigram/trigram 技能检索、任务中的技能发现提示、泛化蒸馏纪律、带审计的人工派生技能版本、跨全部版本累计统计、apply 事件语义核验、close 窗口证据自动收集、管理员重新入队、评审叶节点 supersedes 校验、评审证据摘录，以及 curator 输出容错和 Core CAS 决策。

合并冲突同时保留了当前的配置绑定提示与新增技能发现提示；`learned_skill_apply` 保留 H35 的数组长度约束。新装 schema 同步重新入队状态转换。新增测试验证 claim 摘录兼容旧 Core、拒绝畸形摘录，以及 patch/scope_change 的相同容错规则。

维护脚本 `scripts/regeneralize-skills.ts` 的旧 `pi-responses-model.ts` 引用已改为当前 `runtime-model.ts`。真实进程启动检查确认 imports 可解析，缺少管理员凭据时在任何模型/API 调用前明确拒绝。本次没有执行批量泛化或提交新的 FPGA/模型任务。

## 服务与数据库

| 服务 | 部署前 PID | 最终 PID | 状态 |
| --- | ---: | ---: | --- |
| Core :5130 | 1251697 | 2348505 | active/running |
| Runtime :8791 | 1159570 | 2348653 | active/running |
| 自进化后台 | 1962 | 2348714 | active/running |
| Web :4173 | 1602228 | 2348736 | active/running |
| Windows Worker :8443 | 41924 | 41924 | 保持运行 |

初次切换 `068627a` 后，验收发现维护脚本仍引用消融时删除的模块，补正并完成上述最终发布。每次切换前均确认没有 Runtime running 回合、在途 FPGA 作业或 running 蒸馏/整理任务。

生产数据库原已应用 `0037_learned_skill_trgm_search`、`0038_learned_skill_manual_version`、`0039_application_requeue_transition` 和 `0039_project_configuration_epochs`。迁移 runner 按完整文件名识别版本，两项 0039 分别保留；本次无待应用迁移，没有重写现有技能、application 或任务状态。正式 runner 检查 30 个编号迁移成功。

生产 dump 为 59,907,609 字节。已在独立临时 PostgreSQL 16 中恢复，并运行正式迁移器成功；所有数据库测试使用隔离实例，没有将测试 harness 连接生产库。验证完成后已停止并删除临时实例及恢复副本。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| Core 自进化契约/API、历史证据 HTTP、项目配置 | 48 pass / 0 fail |
| Runtime 技能工具、curator/claim、server、free-agent、watchdog、Anthropic | 218 pass / 0 fail |
| 模型工厂与自进化模型适配器 | 25 pass / 0 fail |
| Web 全量 | 594 pass / 0 fail |
| root `bun run test`，不设置 DATABASE_URL | 1002 pass / 407 skip / 0 fail |
| root `bun test --timeout 30000`，隔离 PostgreSQL | 1938 pass / 14 fail |
| Core `bun run check`、Runtime tsc、Web check | 通过 |
| `bun run build:golden` | 通过 |

数据库全量回归的 14 个失败项与此前记录的基线逐项相同，没有新增失败。它们分布在已退休 evolution-eval schema/路径测试、import 权限期望、旧证据触发器与 P4 formal/migration/HTTP 测试；不能将这些失败或未设置数据库时的 skip 记为通过。维护脚本的最后一行 import 修正另经真实启动检查和模型工厂/适配器测试验证。

正式验收：

- 公网 `https://synthia.wenzhuolin.xyz` 首页和 `release.json` 返回 200；release 中应用/Core/Runtime/Web/自进化后台提交均为最终版本。
- 公网入口 `/assets/index-DpvVSG4q.js` 与新发布目录逐字节相同，SHA-256 为 `6d78e0aeb34096b9b93cc144f988098a3f6b48032fc802f824c69312d5f066ea`。自进化导航所在 `/assets/index-DAdZkgiI.js` 也逐字节匹配。导航资源与入口分别校验，未把入口脚本中缺少中文明文误判为入口消失。
- 最终公网资源复测中，部分 HTTP/2 连接在收到部分内容后超时；使用 DNS 返回的另一地址 `172.67.194.110`、HTTP/1.1 和压缩完整读取两份资源，各约 0.65 秒并匹配上述 hash。本机原文件一直正常；该观测不用于声称部署改善了页面加载速度，也不据此确定网络超时根因。
- Core 自进化 overview、35 个 Learned Skill、详情与 p31/p32 任务接口均返回 200；技能列表及详情 `metrics_scope=all_versions`。p31 的只读中文检索“波形 读回 恒零”返回 10 个候选。
- p11/p13/p28 的累计作业分别为 11/17/90，历史 WNS 分别为 4.249/1.348/0.591 ns；LUT/FF/BRAM/DSP 与此前部署一致。六份 `sta.rpt`/`resources.rpt` 原文读取均为 200，UTF-8 SHA-256 匹配冻结清单。
- 23 个 Runtime 会话仍为 `awaiting_user`，包括 p31/p32；68 个状态/会话文件部署前后 SHA-256 完全相同，Core 任务 ID/状态/更新时间也完全相同。
- Worker PID、bundle、配置与历史 registry 保持一致。bundle SHA-256：`4bef8d340de434f787f2ed801fea76ec7b8efc42023624e25c5533b7f9e3dcd8`；registry SHA-256：`925f977703d2d8792c8906db16b4ec035f258a26d2ea9aa427f309e08cf6c18e`。

验收采用实际 API、文件 hash、服务状态与公网资源检查，没有执行真实模型推理或新的 Vivado 基准，也没有将这些检查描述为浏览器渲染测试。

## 备份与回滚

私有备份目录：`/home/wenzhuolin/.synthia/backups/selfevo-golden-20261009-141106`。包含生产 dump、units/dropins、Connector 配置、Runtime 会话及 hash、部署前后状态、迁移恢复日志、测试日志与生产验收 JSON；凭据及生产状态不纳入 Git。

原应用提交 `65c43b6a6c2a0ef6523c1aa8da39b94692e79de9` 与 Web 发布 `/data3/dev/synthia-web-releases/history-evidence-65c43b6-golden-20261009-124233` 保留。需要回滚时，在无活跃任务的窗口切回该代码和 Web 软链接，再启动 Core/Runtime/自进化后台/Web；数据库已有 selfevo 迁移继续保留，不删除新版本或审计记录。
