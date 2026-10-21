# Golden 版本错位恢复（2026-10-21）

用户确认“帮我恢复一下”后，于 **2026-10-21 11:49:53 CST** 完成 Web 切换。正式入口为 https://synthia.wenzhuolin.xyz 。

## 故障证据

Golden reflog 显示，2026-10-20 12:42:05 部署目录从 `16477f0` 切到 `FETCH_HEAD`，实际为 2026-09-25 的 `e3db375`。该 FETCH_HEAD 来自本地 platform-ops 仓库的 `platform-ops-golden` 分支，分支引用未跟上已经部署的版本。Web 同一分钟退出并自动重启；Core/Runtime 仍是 10 月 18 日的进程，自进化后台仍是 10 月 13 日的进程。

切换前 `web/dist` 指向 `presentation-layout-61981a7-20261016`，公网入口 `index-BzDR1T7D.js` 与该目录完全相同，10 月 20 日 `da117f0` 的归档 Side Agent 恢复入口尚未发布。`/release.json` 缺失，请求被 SPA fallback 当成首页返回。由此形成旧磁盘代码、原后端进程、独立前端构建三者错位。

## 恢复版本和方式

- 发布提交：**1260b8d4c1a91d6ee2b72988c3ec5e38cab6ebf6**，整合当前 platform-ops `d0bf08e` 与演示/布局分支 `61981a7`，包含归档 Side Agent 恢复入口 `da117f0`。
- 与 10 月 18 日运行基线 `16477f0` 对比，`core/`、`runtime/`、`connector/`、`scripts/`、`skills/` 无差异。Core、Runtime 和自进化后台保持进程；只重启 Web，无 Worker 操作。
- Golden 目录使用审核后的完整 SHA checkout；本地发布来源 `platform-ops-golden` 以 compare-and-swap 从 `e3db375` 更新至 `1260b8d`。后续发布必须核对确定 SHA，不能把任意 FETCH_HEAD 当发布目标。
- 新静态发布目录：`/data3/dev/synthia-web-releases/recovery-1260b8d-20261021-114817`。构建使用 `bun run build:golden`，历史材料、Side Agent、正式交付、自进化四个前端开关均开启，无 mock。
- 保留 10 月 16 日演示页、JPEG 对照及 iframe 布局；加入 10 月 20 日 Side Agent 归档恢复入口。
- `web/dist` 软链接原子切换。旧发布目录保留，另外保留 35 个旧 hash 资源文件，使已打开页面的延迟加载不因切换变成 404。
- 恢复真实 JSON `release.json`，分别标记应用/Web 发布提交与已加载 Core/Runtime 基线，明确只有 Web 重启。

| 服务 | 切换前 PID | 切换后 PID | 处置 |
|---|---:|---:|---|
| Core :5130 | 3963032 | 3963032 | 保持 |
| Runtime :8791 | 3963033 | 3963033 | 保持 |
| 自进化后台 | 1902 | 1902 | 保持 |
| Web :4173 | 3726224 | 1295330 | 重启加载新发布 |
| Windows Worker | 未操作 | 未操作 | 保持现有部署 |

## 验证

- 根目录 `env -u DATABASE_URL bun test`：**1619 pass / 410 skip / 0 fail**，144 文件；数据库门控项未执行，不计为通过。未将测试连接生产数据库。
- Core `bun run check`、Runtime TypeScript、Web `bun run check`、`build:golden` 均通过。此次与已验证后端基线无生产源码差异，无新增数据库迁移。
- 公网首页、`release.json`、`presentation/index.html` 均返回 200；release 正确返回 application/json、1260b8d 和四个启用开关。
- 公网 `assets/index-D3XvMK5y.js`、`assets/ProjectView-DWGK0g28.js` 逐字节匹配新发布，后者包含归档恢复入口。
- 独立浏览器上下文实测登录页和 JPEG 演示页可渲染，演示页无 console error；未在该上下文登录，内嵌项目按设计显示登录页。已登录项目功能用下述鉴权 API 和现有测试验证，不声称完整浏览器交互测试。
- Core 鉴权 GET：projects、自进化 overview、Learned Skill 列表、p28/p29 tool-summary、p31/p32 tasks 共 7 项全部 200。p28/p29 历史指标响应除 `generatedAt` 外完全相同；p31/p32 tasks 数据相同。
- 30 个 Runtime 会话均保持 awaiting_user、busy=false；86 份持久化文件 SHA-256 完全相同。数据库 33 个任务的 ID/项目/状态/更新时间和作业状态计数相同，无在途 FPGA 作业。
- 无生产数据迁移、无任务消息、无模型调用或 Vivado 新作业。未删除会话文件、证据或旧 Web release。

无 User-Agent 的 Python 探针一度被 Cloudflare 返回 403/1010；使用有明确 User-Agent 的探针及真实浏览器均成功，没有因此改动 Cloudflare、鉴权或应用配置。

## 备份与回退

私有备份：`/home/wenzhuolin/.synthia/backups/golden-recovery-20261021-114817`，包含约 80.5 MB PostgreSQL custom dump、原 systemd 配置、Runtime 状态副本及 hash、前后只读 API/数据库检查、原发布分支引用和切换元数据。备份、凭据和生产状态不纳入 Git。

如果只需回退 Web，将 `web/dist` 原子切回 `presentation-layout-61981a7-20261016`，重启 Web 即可。后端基线应使用已知运行版本 `16477f0`；`e3db375` 是本次错误切换状态，不作为正常回退目标。此次没有执行数据库写入或 schema 更改，不需要数据库回退。
