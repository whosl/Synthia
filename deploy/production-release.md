# 正式站点部署

正式站点 `https://synthia.wenzhuolin.xyz` 使用本机 Bun 服务，平台沙箱是独立的可选部署目标。

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
