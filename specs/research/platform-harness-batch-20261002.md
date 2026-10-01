# 平台 harness 修复交付（2026-10-02）

实现位于 platform-ops worktree，尚未部署。生产 `/data3/dev/synthia-golden`、Core :5130、Runtime :8791、Worker 66机 :8443 未重启；p31/p32 会话及真实 application 状态未写入。

| 项目 | 修法 | 窗口内更新服务 |
| --- | --- | --- |
| H35 | 文本数组不再按 ID 校验，close 缺省引用为 []，保留 0 并报具体错误字段；保留生产 apply 的 skill_id 解析/defaults | Runtime |
| H36 | 只在模型 pending 期间监测会话落盘空闲，超时 abort+注记+一次重试，用户取消/工具执行/旧流回调均正确处理 | Runtime |
| H37 | offset/limit 分页贯通工具/Core/Worker，大小/范围/整文件 hash/页 hash/续读参数齐全 | Core、Runtime、Worker |
| H34 | 四项性能指标进入 digest，丢包/低 goodput/高 cycles_per_pixel 独立覆盖 TB PASS | Worker |
| H20 | task create 接受 permission_skip_all，Core 注入 actor/time 审计，注册时持久化，idle/恢复可用，红线硬拦 | Core、Runtime |

`SYNTHIA_MODEL_WATCHDOG_MINUTES`：默认 `15`；`0` 禁用；正数可含小数。只统计挂起模型请求期间距最近成功会话落盘的时间，流式上游活动本身不等于会话落盘。

`POST /api/v1/projects/:projectId/tasks` 例：`{"task":"执行基准","permission_skip_all":true}`。客户端提供的审计字段不会成为真实归属；Core 使用已认证调用者和服务器时间。初始策略是创建事实，同键重放保留原策略；修改现有会话策略仍走既有权限 API。

`synthia_job_evidence` 例：`{"job_id":"job-…","name":"waveform.vcd","offset":0,"limit":65536}`。offset/limit 按 UTF-16 字符计，不是字节。默认 65536，最大 262144；返回 `range.totalChars`、`range.nextOffset`、`sizeBytes`、`next_read`。复制 next_read 可连续读取，直到 null。sha256 指完整文件，Worker 另返回并校验每页 content_sha256。二进制继续引用 URI/hash，不进入模型。

H34 使用当前模板要求：USB GOODPUT ≥11.5Mbps、DROPPED_PKTS=0；JPEG 0<CYCLES_PER_PIXEL≤1。LINE_RATE_MBPS 正值为观测数据。默认阈值冻结于 `BENCH_PERFORMANCE_REQUIREMENTS`；digest API 第三个参数可指定不同 scenario 的要求。只有明确打印这些约定指标行的日志参与独立性能判断。

仓库 bundle 从本次源码连续构建两次、字节完全一致，并验证源/bundle 均在 TB PASS/$finish/exit=0 但 goodput=11.0 时失败。H32 5MiB 输出捕获与 H33 compile-order 先发现模块再设 top 的旧 bundle 补丁已回流源码。本地产物使用 Bun 1.4.1 / Node ESM；此交付不宣称完成正式 release manifest 或 Windows Gate。正式部署窗口须沿既有 release/certification 流程构建、校验身份与配置，不能把本地开发构建冒充已认证 release。

本批不新增迁移；此前工作区的 device-part-policy / 0039 改动保留，应按其自己的部署说明处理，不能因本批无迁移而忽略。

验证完成：

- 受影响 Core 单元 / Runtime / Connector：`bun test` 指定 20 个测试文件，**388 pass / 0 fail**。涵盖 close 真实参数形态、模型看门狗与传输取消、分页/Unicode/损坏/项目隔离、digest 独立判定、初始权限与红线、canonical bundle 一致性。
- 独立 PostgreSQL Core 集成：`DATABASE_URL=postgresql://wenzhuolin@127.0.0.1:55439/synthia_harness_20261002 bun test core/tests/api-run.test.ts core/tests/api-tasks.test.ts core/tests/api-side-tasks.test.ts`，**106 pass / 1 fail**。H20/H37 新测试全部通过。
- 唯一集成失败为既有 `task Runtime capability is disjoint from generic Core routes`：组合/扩展 Runtime token 的状态码断言期待 401、当前接口返回 403。用 **未修改 HEAD 的 git archive** 与独立 baseline 数据库重复同一测试，得到相同 401/403 失败（基线测试位置 `core/tests/api-side-tasks.test.ts:1128`），确认不是本批引入；没有为掩盖基线问题改写该测试。
- `bun run check` **通过**（undefined names / GJB 文档检查 / Core TypeScript）。单独 Runtime TypeScript 仍有 4 条既有错误：connector/vivado.ts toolchain narrowing、两个 connector 的 result status string 类型、probe-anthropic tool result 类型；本批没有新增诊断。
- `git diff --check` 与 `node --check connector/server.bundle.mjs` 通过。两次本地构建及仓库 bundle SHA-256 均为 `7fb50dc112500cc6c2c6b93248961f594eb6d37a0d4a87676efe8ac522e1c9ed`。

日志均位于 `/tmp/synthia-harness-*`：`all-unit-final.log`、`core-final.log`、`auth-baseline.log`、`check-final.log`、`runtime-release-types.log`。日志/数据库不属于部署物。
