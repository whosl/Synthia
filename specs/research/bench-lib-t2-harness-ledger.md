# bench-lib T2 harness 台账（p17-p26 执行期）

- 起始：2026-09-10；持续更新
- 范围：T2 基准执行期间暴露的平台/工具链/harness 问题，含已修、绕过、仅记录
- 分类：**ARCH**=架构级根因，**BUG**=缺陷，**GAP**=覆盖/语义缺口，**OPS**=运维面问题，**OBS**=观察记录
- 处置：fixed=已修 / worked-around=会话或操作者侧绕过 / deferred=轮间再修 / open=未处置

## 一、架构级根因（下述多类问题的上游）

| # | 类型 | 问题 | 证据 | 处置 |
|---|---|---|---|---|
| H25 | ARCH | **worker job 状态纯内存**（server.bundle 的 jobs Map）：worker 重启即全损，Core 侧 job 永久滞留 submitted，无孤儿检测/自动标记失败/补偿协议 | 周一 worker 楔死重启后 09:24 两 job 永久 submitted；周五 00:10/00:40 两对同型 | fixed（补偿协议即 H14 收割器落地；worker 落盘队列仍为长期项） |
| H24 | ARCH | **event_kind DB 检查约束与代码事件种类强耦合**：代码新增会话事件种类（如 permission_request）必须同步迁移，否则写库即炸——部署顺序雷 | 00:32:57 task_conversation_event 违反 check constraint（permission_request 不在枚举），11 分钟窗口内 job 流中断 | fixed（0036 约束解除，随修复批次部署 2026-09-15） |
| H26 | ARCH | **submitJob 的网络调用在 DB 事务内**（源码实证：runIdempotent 事务回调内 await connector.submitJob，注释自述为原子性设计）：worker 慢/挂时整个提交路径拖死并占用连接——属有意设计的权衡，风险在 worker 退化场景 | validate POST 30s 客户端超时（服务端事务悬置）；周一楔死期 POST 挂起 | fixed（提交移出事务+补偿，探针验证无挂起） |

## 二、平台缺陷/缺口

| # | 类型 | 问题 | 处置 |
|---|---|---|---|
| H15 | GAP | **logDigest 失败模式覆盖窄**（源码实证：失败判定 `/\bFatal:/i | /\$fatal/i | /^\s*FAIL\b/m`——FAIL 必须行首，`[FAIL]` 带括号前缀或行中 FAIL 均不命中）：p22 的 `[SCN] x FAIL`/`[FAIL] scn=` 全漏，digest 报 0 失败 → 模型全盲 → 误判 INCONCLUSIVE/怀疑缓存；叠加"TB 无 $fatal 退出 0"时 job 状态呈 succeeded——**simulate 的真值依赖 TB 纪律 + digest 模式双重脆弱** | fixed（模式扩展：[FAIL]/FAIL( 双探针实测命中 → VIVADO_SIMULATION_FAILED） |
| H16 | BUG | **PROJECT_NOT_ALLOWED → 503+retryable:true**（源码实证：worker 本报 403，Core `mapConnectorError` 把所有非 404 类 ConnectorError 统一重包 `capabilityUnavailableError`）——配置错被伪装成可重试的暂态故障，误导排障方向 | fixed（403 实测：authorization/PROJECT_NOT_ALLOWED/retryable:false） |
| H18 | GAP | **createTask 的 task 文本不触发执行**：说明书还是指令语义不明，5 个会话全靠追加 message 才开工 | fixed（创建即开工实测：25 秒完成回合，零追加消息） |
| H19 | BUG | **abort 端点**：深核实测——idle 会话 200 且优雅降级（`{"aborted":false,"reason":"no active free-agent session"}`）；400 仅见于 running 态会话，根因待安全窗口复现（不能在 p22 盲测上试） | narrowed（idle 200 实测；running 400 未复现——草稿会话机制已具备） |
| H20 | GAP | **permission skipAll 无法预配置**：idle 会话 404，须"激活→再设"两步舞；重启后疑似不保持（周一全量重设） | fixed（序列化+恢复+类型三处；字段入盘实证，随回合持久化属设计内） |
| H21 | GAP | **.vh 拒收**：T1 已知（AES 内联绕过），T2 p22 复发（job-56528a73）——规则未显性化给 agent，每轮重新踩 | fixed（.vh validate 实测通过） |
| H22 | GAP | **回合级活性：REST 面缺失但 SSE 面存在**（深核修正）——SSE 流有 delta 事件（模型增量）+ `: hb` 传输心跳，看流可区分活回合/挂死；但 task-status REST 面（status/updatedAt）无此信号，轮询式监控不可区分（双向误判实证：误判挂死×1、真楔死×1）。监控改用 SSE 即可缓解，平台侧可选补 REST 活性字段 | fixed（/tasks updated_at 实测返回） |
| H23 | BUG | **迁移漂移**：0014_tool_timing_metrics.sql 在仓库、未应用生产库（schema_migrations 尾部 {0011,0012,0013,0020,0021}） | fixed（0014+0036 已应用并注册；迁移器自注册惯例补齐） |
| H27 | GAP | **用户侧证据可观测性断裂**（2026-09-15 实证，p22 事件）：UI 的 job 证据面仅一个写死的 sta.rpt 懒加载（ProjectView.vue:1935），stdout.log/仿真日志/logDigest 在产品零展示；API 层 /jobs/:id/evidence 系列存在且有 scope 但 (a) 无 UI 消费（用户不会 curl），(b) worker 退化时挂起（H26）。**净效应：会话向用户要 log、用户在产品内无路径获取、只有 infra 级操作者（SSH/admin）能取——验证闭环的三方里两方（用户、agent）都瞎** | moved（移交 web 现代化线排期，evolution 线复用为验收探针） |
| H12 | GAP | validate 与 synth 容忍度分歧（xvlog 容忍 `\`timescale` 损坏行、Synth 8-2715 拒收）——validate 假阴性覆盖 | fixed（SUSPICIOUS_ESCAPE_ARTIFACT 实测拒绝+自释错误码） |
| H14 | BUG | 提交丢失型僵尸 job。**深核修正**：19:52 那条 simulate 的 idempotency 键为 `p17-simulate-1`——操作者自己脚本的键（非外部调用，"来源不明"撤回）；确证的残余行为：**客户端 30s 超时的 POST 在服务端仍会完成落库**（p17-validate-1 于 19:50:18 在客户端超时后落地）——请求生命周期对调用方不透明。另发现 `ui-run-*` 键族 = Web UI 一键运行按钮的提交指纹（周一卡死 job 即用户 UI 点击，该路径同样暴露于 H25） | fixed（WORKER_JOB_LOST 收割实测：周五僵尸行成功退役） |

## 三、运维面（已修/已固化）

| # | 问题 | 处置 |
|---|---|---|
| H1 | worker project_scope 双侧白名单（p17-p26 + selfevo×4） | fixed（双侧配置） |
| H2 | PowerShell 5.1 `-Encoding UTF8` 带 BOM 写坏 worker JSON | fixed（无 BOM 写法，[IO.File]::WriteAllText+UTF8Encoding($false)） |
| H3 | SSH 会话结束回收子进程 → worker 静默死 | fixed（计划任务化 synthia-worker） |
| H4 | 计划任务重启不杀旧 node（旧白名单内存残留，LISTENING 假阳性） | fixed（kill+重启+pid 换代验证流程） |
| H5 | Vivado 启动挂死（无 journal、3% CPU；两次实证：job-d142035f、周一 pid 29668 事件循环半楔死） | fixed×2（kill+重提；T1 已知类） |
| H6 | 权限卡 gate vivado_run → 会话卡死 | fixed（基准会话 skipAll） |
| H7 | web 裸进程无声死亡 ×2（死因未根因） | fixed（systemd synthia-web；死因 open） |
| H8 | 子代理模型路由坏（默认 k3-256k 不存在） | worked-around（显式模型覆盖） |
| H9 | Core client config 启动时加载（改动需重启） | 固化入窗口协议 |
| H11 | Runtime 外部重启×3+Core×2 打断会话回合 | OBS（恢复机制 4/4 正确复活；窗口协议已双判据化：零在途+无 running 回合） |
| H13 | `._*.json` macOS 垃圾文件恢复解析噪音 | fixed（清扫完成） |

## 四、正向验证（harness 生效记录）

- **claim-check 拦截虚报**：p17 会话声称"仿真通过"、无 succeeded 记录 → 强制改口（治理在黄金侧同样有效）
- **会话恢复机制**：4 次进程重启全部正确恢复现场并继续
- **GLM 40 字符 id 转录错位**（b6→b5）：selfevo 线平台侧 hex 对拍定罪并修复（worker 推断免抄写）——与 T1"常量记忆转录单点错"同族，为模型可靠性画像新增实证
- **黄金侧先行拦截需求缺陷**：can 一件 3 处规范数据错误（CDR@0x1F、缓冲窗口、SR 复位 0x0C）全部在盲测发车前修正

| H28 | OPS | **worker 主机重启后自启失败**（66 机 09-15 06:30 重启，synthia-worker 任务 ServiceAccount 登录类型对普通用户账户在开机阶段不可靠，任务滞留 Ready）；另记录 Core/runtime 会话状态分裂（Core=awaiting_user vs runtime=running，重启后缓存未对齐，p19 实证）。处置：手动拉起 + 新增 SYSTEM 级 5 分钟看门狗任务（端口不通自动 Start；注意只能覆盖"死亡"，覆盖不了"活着但楔死"——后者仍需人工/监控） | fixed（看门狗）+ open（自启根因改 principal 为 SYSTEM 待观察下次重启） |

## 四a、修复批次（2026-09-15 部署，fix/harness-batch-on-ablation @ a64eb79）

一次静默窗完成：迁移 0014+0036（含迁移器自注册惯例补齐）→ Core/Runtime/worker 三点部署 → 11 项验证炮组全过（403 映射/僵尸收割/自动开工/.vh/逃逸拒绝/FAIL 模式/updated_at/约束解除）。部署中附带发现：testbench 参数约定为模块名非文件名（H18 探针踩坑记录）；外来未提交修改按标签贮藏（stash@07cfd5c7）。H19 收窄未全证；H25 的 worker 落盘队列与 H27 查看器为移交项。

## 五、深核记录（2026-09-14 审核轮）

对第二节可疑项逐一对源码/库实证：H25（Map 内存 + Core 无 reaper，grep 全仓无 job 回收）✅、H24（约束枚举 8 种）✅、H23（0014 唯一漂移）✅、H15（模式收窄为行首 FAIL）✅、H16（映射链完整）✅、H26（事务内网络调用，注释自认设计）✅；**两项被修正**：H17"来源不明"撤回（键归属操作者脚本）、H19 收窄（idle 态正常）；H22 收窄（SSE 面有活性，REST 面无）。取证方法沉淀：idempotency_records 的键模式是调用方指纹（`ui-run-*`=UI 按钮、`p17-*-1`=操作者脚本、会话提交另有键型）。

## 六、附注

- tool.log 与 stdout.log 证据完全重复（p22 job：95966B==95966B）——存储/传输浪费，建议去重
- 操作者失误 2 起（不属 harness 但记录）：printf 转义写坏 timescale（会话修复）；UTC 时区误判误诊挂死（阈值改本地 45min+先校 date）
