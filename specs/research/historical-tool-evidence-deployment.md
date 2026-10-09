# 历史运行指标修复部署回执

用户授权“重新部署一下”后，2026-10-09 11:54（Asia/Shanghai）切换正式部署，11:56:48 完成生产验收。

- 应用代码：`65c43b6a6c2a0ef6523c1aa8da39b94692e79de9`；运行目录 `/data3/dev/synthia-golden`，从 `57c51f0` 前进到该提交，保留未跟踪的运行目录和 Web 发布软链接。
- 公网站点 `https://synthia.wenzhuolin.xyz` 首页、`release.json` 和入口 JS/CSS 均返回 200。公网入口资产逐字节匹配新发布目录；公网 p11 `tool-summary` 通过鉴权返回修复后的历史指标。
- Web 独立发布目录 `/data3/dev/synthia-web-releases/history-evidence-65c43b6-20261009-115059`，构建与应用同为 `65c43b6`，原发布目录保留，可切回。
- Core PID `1958 → 1251697`，Web PID `1964 → 1251788`。Runtime PID 保持 `1159570`，未重启；运行的 Runtime 代码版本仍为部署前的 `57c51f0`。
- 66 机沿用现有 Node `D:\softwares\Nodejs\node.exe` 和计划任务 `synthia-worker`，未替换原启动器、mTLS/PFX 或器件策略。Worker PID `57052 → 41924`；部署前确认零在途作业、无 Vivado/xsim/xvlog/xelab 进程、无 Runtime running 回合。
- Canonical Worker bundle 与 Windows 实际运行 bundle 为 70,789 字节，SHA-256 `4bef8d340de434f787f2ed801fea76ec7b8efc42023624e25c5533b7f9e3dcd8`。Worker 配置与 Core Connector 配置中的 build hash 同步。Windows Node 语法检查通过。
- mTLS register/heartbeat/discovery 全部 200，9 项 capabilities，状态 `ready`，`capability_drift=false`。
- Worker watchdog 在切换期间暂停，完成后恢复 enabled。历史 registry 未改写，部署前后 SHA-256 均为 `925f977703d2d8792c8906db16b4ec035f258a26d2ea9aa427f309e08cf6c18e`。

## 生产数据验收

| 项目 | 累计作业 | 历史 WNS（ns） | LUT | FF | BRAM | DSP |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| p11 | 11 | 4.249 | 628 | 810 | 5 | 0 |
| p13 | 17 | 1.348 | 4,930 | 2,270 | 0 | 0 |
| p28 | 90 | 0.591 | 12,896 | 7,232 | 1.5 | 64 |

三个项目的 summary、jobs 列表、证据清单以及 `sta.rpt`/`resources.rpt` 原文均返回 200。六份原文按实际 UTF-8 字节重新计算 SHA-256，均匹配 Core 冻结清单与 API 返回值；报告器件均为原运行的 `7k70tfbv676-1`。p11/p13 已淘汰 Worker 索引的旧报告可经 Core 恢复读取；p28 选择最新成功布局布线报告，WNS 为 0.591，未误用较旧作业的 0.658 缓存。

历史报告仍为 `unattributed`，无配置 epoch 回填；三个项目当前 timing/resources 仍为空、四阶段为 `never`、`validationState=pending`。历史展示未改变当前配置通过判定，也未提交新的 FPGA 作业。

23 个 Runtime 会话的 ID、项目和状态逐项保持一致。68 个 Runtime 状态/会话文件部署前后逐字节 SHA-256 一致。p31/p32 仍为 `awaiting_user`；项目详情、tasks、jobs、tool-summary 八项 API 均返回 200。Core 的任务状态/更新时间与作业状态统计部署前后相同；旧 p4 queued 任务未被改动。

## 备份与回滚材料

Linux 私有备份 `/home/wenzhuolin/.synthia/backups/history-evidence-20261009-115059`：59,906,869 字节 PostgreSQL custom dump、Core Connector 原配置、systemd units、Runtime 会话和文件哈希、原 release 元数据、部署前后任务/作业状态以及生产验收 JSON。配置与备份包含私有材料，不纳入仓库。

Windows 备份 `D:\synthia-worker\deployments\history-evidence-20261009-115059`：原 bundle、配置、启动器、watchdog、原 registry、新 bundle 和切换记录。原 Web 发布 `/data3/dev/synthia-web-releases/platform-ablation-42cf5fa` 保留。

本次无数据库迁移；历史时序首次读取只使用既有缓存机制写入 `tool_timing_metrics`，未修改原作业证据或会话。
