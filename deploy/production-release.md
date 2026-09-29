# 正式站点部署

正式站点 `https://synthia.wenzhuolin.xyz` 使用本机 Bun 服务，平台沙箱是独立的可选部署目标。

## 2026-09-29 Selfevo 复用更新整合

将 selfevo 提交 `92e66e3` 的六个文件增量合入加载优化版本 `351fbf0`，保留主线的项目活动排序、VCD 大文件查看、加载骨架、平台兼容和 Connector 修复。新能力包括 Runtime 技能检索引导、技能搜索的关键词与 trigram 混合召回、蒸馏复用提示词，以及管理员人工泛化派生版本接口和维护脚本。

原更新的人工泛化接口与数据库版本来源约束冲突，会返回 500。补充 `0038_learned_skill_manual_version`：允许有父版本且明确由 human 创建的无自动任务来源版本；自动版本仍必须保留蒸馏/整理来源。保留权限、扫描隔离、固定技能保护和 CAS 校验，测试覆盖成功、拒绝和隔离路径。新装 schema 同步搜索索引及版本来源约束。

- 迁移：`0037_learned_skill_trgm_search` 新增三个 GIN 索引；`0038` 修订来源约束，不改写现有技能版本。
- 中文 trigram 依赖 Unicode 字符分类，正式库 `zh_CN.UTF-8` 已验证；隔离测试使用 `C.UTF-8`。
- Core 自进化/项目接口/项目模型与权限 54 项通过；Runtime 服务/worker 回归 122 项、客户端/调度/工具回归 81 项通过。
- Core、Runtime、Web 类型检查及正式 Web 构建通过。正式库备份恢复后两次执行迁移成功，新 Core/Runtime 启动、34 个项目、24 个技能和提效概览读取通过。
- 部署前备份：`~/.synthia/backups/selfevo-merge-20260929/`。代码回滚使用统一主线 `351fbf0`，不要回到旧 selfevo 分支；新增索引与人工版本来源约束可保留，避免破坏已产生的人工版本。
- 维护脚本随代码发布，本次不批量执行技能泛化，不发起额外 FPGA 运行或模型任务。

## 2026-09-29 页面加载优化与占位

HTML 内置启动骨架，保留到首个路由准备完成；页面切换显示加载提示，失败时提供重新加载。项目工作区等待身份数据期间显示三栏骨架；新建项目表单按需下载，并提供加载占位、取消和失败提示。启动骨架支持浅色/深色、窄屏及减少动画偏好。

常用项目列表进入初始入口，减少脚本加载的依赖往返。详情请求使用四个持续工作的并发槽，单个慢项目不再阻塞整批；继续保留活动快照顺序、独立错误和离页停止调度。

- Web 593 项测试、类型检查、正式构建通过。
- Chrome 人为阻塞入口脚本、列表 API、路由模块、项目 API，验证占位及成功后的移除；表单按需下载和路由模块失败提示通过，无正常流程 JavaScript 异常。
- 本机冷缓存、150 ms 延迟、250 KB/s 下载，旧版/新版各三轮中位数：首次可见内容 1216 → 524 ms（新版为骨架），项目卡片 1406 → 1028 ms，全部详情 3553 → 2768 ms。此结果为受控对比，不承诺公网固定耗时。
- 仅更新 Web 源码和静态产物，无数据库迁移、依赖或后端行为变化。

## 2026-09-29 项目列表活动排序修复

项目列表曾先按创建时间展示，逐个加载详情后再按任务/审批时间排序，导致卡片跳位。Core 列表接口现在返回 `last_activity_at` 并确定完整顺序，前端在一次加载期间保留该顺序和时间。新快照仅在刷新时采用；兼容旧 Core 时保持其返回顺序。活动计算口径见 `specs/project-model-contract-v1.md`。

无数据库迁移或依赖变化，发布范围是 Core 和 Web，保留 Runtime、Connector 和执行中的状态。

- Web 592 项测试、Core/Web 类型检查、正式 Web 构建通过。
- 独立临时 PostgreSQL：接口回归 19 项、项目模型与权限回归 21 项通过。
- 使用正式库备份的隔离副本和真实 Chrome：34 个项目，首次加载、手动刷新、窗口 focus 刷新共三次列表请求，详情补齐没有改变卡片顺序或活动时间，无 API 失败或 JavaScript 异常。

## 当前运行布局

- 代码目录：`/data3/dev/synthia-golden`，发布时将 `release/webui-v-astrys` 快进到已验证的 `main`。
- 用户级 systemd：`synthia-core`、`synthia-runtime`、`synthia-web`、`synthia-evolution-workers`。
- Core：`127.0.0.1:5130`；Runtime：`8791`；Web：Vite preview `4173`。
- 数据库连接、模型凭证和服务令牌沿用 systemd 配置与现有受控环境文件，不写入仓库或发布包。
- 项目 Git 工作区：`~/.synthia/workspaces`；Runtime 恢复状态：发布目录的 `runtime/.runs`；自进化调度状态：发布目录的 `.runs`。
- Vivado 仍通过现有 Worker 66 Connector；独立 `vivado-mcp` 不接入正式工程的治理链路。

## 发布步骤

1. 在独立 worktree 合并并检查 `main`。仅在专用临时 PostgreSQL 实例执行数据库测试。
2. 对正式库做一致性 `pg_dump -Fc`，备份项目工作区、Runtime 状态、systemd 单元和旧版 `web/dist`。备份目录必须限制为当前用户访问。
3. 将数据库备份恢复到独立临时库，启动新 Core/Runtime，检查项目、任务、运行历史及自进化读取。
4. `main`、`platform-golden` 和本机发布分支采用同一已验证提交。不要把旧分支整个 `web/` 覆盖回来。
5. 在新源码目录运行根目录 `bun install --frozen-lockfile`，Web 目录同样安装固定依赖，然后 `bun run check && bun run build:golden`。正式站点不用 `VITE_PLATFORM_PREVIEW=1`。
6. 确认 Runtime 没有正在执行的任务，暂停自进化 workers 和 Runtime，随后更新 Core、前端产物和依赖；保留凭证、数据库、项目工作区和运行状态。本次统一版本没有新增数据库迁移。
7. 重启 Core、Runtime、Web、自进化 workers，验证 systemd 状态、带鉴权 API、公开站点及浏览器项目/自进化页面。
8. 保留旧提交和备份以回滚代码、依赖和前端；本次无 schema 变更，代码回滚不需要恢复数据库。

## 2026-09-28 整合验证记录

合入最新 golden/发布线、平台兼容层、独立 Vivado MCP 和文件服务源码。旧 UI 回退分支、已废弃的 M4F 消融草稿以及本机未登记的 FPGA 草稿不作为发布输入。

Connector H32 原先只修改 bundle；本次把 5 MiB 输出/证据上限、Windows 进程树终止补回 TypeScript，再从源码构建 bundle。截断输出明确失败，不能从保留的 PASS 推导正式成功。新增真实子进程输出上限和证据字节数回归。

- Core `bun run check`、Runtime TypeScript、Web TypeScript、MCP TypeScript 通过。
- Web：589 pass；MCP：35 pass。
- 最后源码下 Runtime/Connector 针对性回归：268 pass。
- 独立临时库中 API/权限/自进化/提效/资源回归：73 pass，0 fail（`--timeout 30000`）。
- 全量 Core/Runtime/Connector：1230 pass，17 fail。没有将全量结果记为通过。
- 未修改的 `main`（6430703）已复现正式流程 fixture、旧 M4F 数据库测试、能力令牌状态码、旧任务提交事务断言和 fresh schema parity 失败。自进化套件的默认 5 秒 hook 超时在独立回归中通过。历史 M4F 测试另外可发生清理 hook 超时。

已知失败涉及：旧 fixture 未填写当前 Project Agent 角色/输入 manifest 字段；M4F 消融后仍引用已删除表和 trigger；能力令牌拒绝预期 401、实际 403；任务提交已改为事务提交后派发，而旧测试仍要求失败回滚；fresh schema 与完整迁移链遗留差异。此次没有通过放宽业务权限或修改生产 schema 来消除这些失败。

平台 Node bundle 和全功能 Web 已构建。独立 Node 沙箱继续使用 `deploy/platform`；本次发布目标是上述本机正式站点。


## 本次上线结果

2026-09-28，统一业务代码 `27e4c05` 已在本机正式站点上线；随后部署了 Worker 启动身份校验修复 `911a545`。`main`、`platform-golden`、本机发布分支采用相同代码，远程 `main` 和 `platform-golden` 已推送。

- 四个 systemd 服务运行正常，19 个 Runtime Agent 均恢复为 `awaiting_user`。
- 正式库备份恢复到临时 PostgreSQL 后，使用现有管理员身份读取项目、任务、历史、自进化接口成功，新 Runtime 独立端口启动成功。
- 真实 Chrome 检查项目列表、自进化页和 p27 工作台，无 JavaScript 异常；站点版本、项目列表、自进化概览、任务、运行历史、资源摘要六个请求均为 200。
- p27 有 8 个历史任务证据请求在发布前后均为 404，未作为本次新增问题或通过项。
- Core、Runtime、Connector 均无 TypeScript 诊断；最终 Connector 回归 76 pass。
- Worker 66（8443）确认无活动 Vivado/XSim 进程后更新，注册/心跳/发现均 200；Vivado 2021.1、license available。
- Worker bundle SHA-256：`cff06e379acfd2b35ea6ad66354b5aebcbc47e3cccaf7c20e3e3b52ff1d0f0dc`，服务端与本机 Connector 构建元数据已同步。
- 没有发起新的正式 FPGA Run、生成正式码流或执行上板；执行端验收范围为启动、协议和发现。
- 本机回滚备份：`~/.synthia/backups/unified-main-20260928/`；包含正式库 dump、项目工作区、Runtime 状态、旧前端、服务配置、测试日志和前后浏览器截图。
- Windows 执行端备份：`D:/synthia-worker/backup-unified-20260928/`；含旧 bundle、配置和 jobs registry。
- 平台沙箱包：整合 worktree 下 `dist/synthia-platform-20260928.tar.gz`，已按最终源码重新构建；本次未部署 Daytona。
