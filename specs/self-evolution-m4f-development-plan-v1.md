# Synthia Self-Evolution M4-F 开发与认证计划 v1

状态：计划与 Vivado toolchain 信任边界已由 Reviewer 复签 PASS，P0/P1/P2=0；真实 Windows F0/F1 仍 pending
执行状态：本地 F0 foundation 与 F1 code/static 子集 PASS；真实 Windows F0、远端 F1、Vivado F2/F3 与最终 Gate F pending
Leader：主 Agent
独立评审：Reviewer Agent
开发成员：Core/Runtime Agent、Connector Agent
权威需求：`specs/self-evolution-v1.md` 附录 B、`specs/self-evolution-development-plan-v1.md` Gate F
前置基线：M4-E/E3 Core、Connector 与 B.6 均已独立签署 PASS，P0/P1/P2=0

## 0. 当前执行状态（2026-08-27）

- Reviewer 已对本计划中的 D-root 非生产补偿模型、full-tree canonical schema、toolchain attestation/B v2、每 tick authenticated live probe、new-effect TOCTOU 与漂移下 recovery/retention 语义复签 `PASS，P0=0 / P1=0 / P2=0`。受限 known-current provenance 只获批用于本专用、非生产 M4-F Gate，不代表 vendor-pristine，不得外推至生产 release、正式 FPGA 证据或硬件下载。该 PASS 只签署计划，不代表实现或真实 Windows F0/F1 已通过。
- Connector 本地 F0 foundation 已由 Reviewer 签署 `P0=0 / P1=0 / P2=0`；最终 bundle SHA-256 为 `7ac5f17715626a601d1b4685d150221c043eb3af5636a8c9a06a75cf1bbc57ee`，canonical A hash 为 `6185181b5d30cb106919124e3a9a55e59f62389bf544531cd1d69e037663767a`，raw A file SHA-256 为 `87a1b348e0c0f3e15ed323b6f4bb80c8d92d6d21cadcea8e73385010e44ad40f`。这不是 Windows F0 签署。
- Core F1 code/static 子集在修复 recovery-only 冷启动错误绑定旧 Worker UUID 后，由 Reviewer 复签 `P0=0 / P1=0 / P2=0`。Leader 独立复跑 focused `68/0`、离线全仓 `1475 pass / 618 skip / 0 fail`、Core check、Runtime tsc、F1 strict tsc 与 `git diff --check`，均通过。
- 专用 PostgreSQL 上的扩展 M4-E/E3 集合由 Leader 真实复跑为 `286 pass / 0 fail / 2161 expect() calls`；历史“296”是把 10 个无数据库匿名 skip 占位误计为测试，已在 `self-evolution-m4e-development-plan-v1.md` 更正并绑定逐文件 SHA。Web 离线门禁为 `460 pass / 0 fail`，`vue-tsc` 与生产构建通过。mock UI 预验收在 `1440×900`、`390×844`、`320×720` 均为零横向溢出、零 console warning/error；该结果不代替真实 Core/browser F4。
- 尚未在真实远端 Windows 主机上部署 Gate Worker 或启动 Vivado，尚未生成真实 Windows Gate A/B、canary、chaos、四 operation、试验 `.bit` 或真实 2h cutoff 证据。因此不得把上述本地结果表述为真实 F0/F1 或最终 Gate F PASS。
- 真实 Connector 目标是 `DESKTOP-DVFFB09`（局域网 `192.168.31.66`），而不是本机 Parallels VM。2026-08-27 只读勘察显示其 C 盘可用约 11.27 GiB、D 盘可用约 293.32 GiB，已满足本计划 10 GiB 入场门槛；正式 staging 前仍须就目标目录所在卷重新采证。
- Windows x64 Bun 1.3.14 已按官方 `SHASUMS256.txt` 验证：ZIP SHA-256 `0a0620930b6675d7ba440e81f4e0e00d3cfbe096c4b140d3fff02205e9e18922`，`bun.exe` SHA-256 `0187f68d843f825a72ada4a7eca60db896ed753759a7f8252edcd31ac1bf1b9c`。Windows PowerShell 5.1 原生 ACL 测试在修复续行语法后真实 `10/10` PASS；Windows release 双构建得到与本地一致的 bundle SHA，但因本节后述 toolchain attestation 尚未落地，该 A 只证明构建链可用，不能用于打开 new effects，最终 A 必须重建。
- 2026-09-10 版本仲裁：提交 `9c0d699`/`8bc1591` 起生产代码（release builder、F0 certifier、launcher、Windows certifier、Connector server）实际 pin Bun `1.4.1`，与本计划原记 `1.3.14` 漂移；仲裁以代码为准固定 `1.4.1`，8 个测试文件与本计划两处条目同步更新，Linux 开发机换装官方 1.4.1（`bun-linux-x64.zip` SHA-256 `74c1c3bee7cd998500c8f969cd8972355ac6a07207e94a39eece1999b56ffabf`，与官方 `SHASUMS256.txt` 一致）。Windows x64 Bun 1.4.1 亦已按官方 `SHASUMS256.txt` 验证：ZIP SHA-256 `52b1f3028b01f43d37fefdf669d034a1ee2e0d96c56bb13c393bdaf169b1af84`，解包后 `bun.exe`（86,169,176 字节）SHA-256 `696a6a0713c7d11c1fba1b1c97b626da9ffcc79f6dc9277021104891f1ac4f2e`。上一条 1.3.14 记录保留为历史事实；1.4.1 的 PowerShell ACL、Windows 双构建与远端 staging 内 executable SHA 验证尚未在真实 Windows 主机重做，不得沿用 1.3.14 时代的 Windows 侧结论。
- 真实安装 `D:\Xilinx\Vivado\2021.1` 从 D 盘继承 `Authenticated Users: Modify`，不满足 Gate 的祖先替换防护，且现有 Worker discovery 只检查 binary 可访问后回显配置声明，不能证明真实版本、patch、part 或 license。因此禁止直接用该路径签署 F0；必须先完成本计划新增的只读 toolchain image 与 attestation 链。
- 对真实主机的只读 vendor material 盘点找到 `D:\Xilinx\.xinstall\Vivado_2021.1`、2,086,152-byte `xinstall.log` 以及 Authenticode 有效的 Xilinx `xsetup.exe`/`xuninstall.exe`；`D:\Xilinx\Downloads` 未保留安装 archive，目前也未发现能对安装全树逐文件验证的 vendor checksum manifest。这些材料能补强安装来源证据，但不能单独关闭 provenance；Reviewer 已显式签署接受该受限 known-current installation snapshot，仅用于本专用、非生产 M4-F Gate，不代表 vendor-pristine，不得用于生产 release、正式 FPGA 证据或硬件下载。

## 1. 目标与边界

M4-F 不扩张 M4-E 的权限，只认证已经冻结的 `evolution_eval` 执行平面在真实 PostgreSQL、Core、Runtime、Windows Connector 和 Vivado 2021.1 上能够端到端工作、崩溃后安全恢复，并且试验 `.bit` 永远不能进入正式交付或硬件下载路径。

本阶段允许在专用 Gate 数据库、专用 Core 进程和隔离 Windows staging 中短时打开 self-evolution 与 eval execution；所有部署、发现、迁移、备份和负例预检阶段保持 rollout 关闭。不得使用生产项目、生产数据库或现有正式 Worker 目录作为 Gate workspace。

允许真实 Vivado 生成试验码流；禁止连接、下载、编程或烧写硬件。不得启动 `hw_server`、`vivado_lab`，不得执行 `open_hw`、`connect_hw_server`、`open_hw_target`、`program_hw*` 或 `write_cfgmem`。

24h quarantine 与 7d retention 不做等时长等待；其时钟/CAS/重启语义由 M4-E 冻结测试证明，M4-F 只补真实文件系统、进程、网络和重新打开 ledger 的证据。2h 总预算和 evidence cutoff 安排一次真实墙钟 2h 场景，不修改产品常量、DB deadline 或时钟来加速。

## 2. 入场项现状

1. **本地已清除，Windows 待证：** `connector/server.bundle.mjs` 已更新并通过本地双构建/hash foundation；仍须在固定 Windows Bun 上重新双构建、核部署后 hash 并实际启动入口，才能清除 F0。
2. **本地已清除，Windows 待证：** launcher 已固定 Bun 1.4.1 绝对路径并移除 Node/`PATH` fallback；仍须在真实远端 Windows 主机内验证 executable SHA、launcher fail-closed 与入口 smoke。
3. **本地已清除，Windows 待证：** config 已加入 `evolution_eval`、ledger initialize/reopen、epoch、spool 与 staging 边界；仍须在 exact staging 中完成 initialize→reopen、跨进程 query-first canary。
4. 当前集成工作树包含用户与多 Agent 的未提交修改。M4-F 不能伪称来自 clean commit；首轮认证以 Git 状态快照、冻结文件 SHA-256、bundle manifest 与部署后 hash 为可复现边界。正式发布仍另行要求 clean commit。
5. 真实主机现有 `D:\synthia-worker` Worker 正在 8443 提供服务，使用 Node 24.14.1 启动旧 bundle；该 bundle 不含 `evolution_eval`/ledger v2/process-instance attestation，配置声明 hash 与实际 bundle hash 也不一致，因此不能作为 Gate release。它必须在隔离 staging 全部预检通过前保持运行且不得被覆盖。
6. 远端管理通道固定为 Tailscale 跳板 `100.66.198.60` 到目标主机 `192.168.31.66` 的密钥 SSH 链路。首次只读连接采集并人工核对两台主机的 hostname、用户、SSH host-key fingerprint；后续命令固定 fingerprint、`IdentitiesOnly=yes`、禁用 agent forwarding 和交互式认证 fallback。跳板管理身份固定为 `Administrator`，目标管理身份固定为 `admin`；命令、UTC、脱敏参数、exit code、目标 PID/计划任务状态写入 Gate artifact。凭据、私钥内容和 Cloudflare Access secret 只存在于受管环境，不写入仓库、artifact 或日志。任一 host-key/身份漂移或管理通道失联都禁止进入 8443 接管步骤。

## 3. Rollout、环境与回滚边界

### 3.1 固定环境

- PostgreSQL：专用 `synthia-selfevo-gate-0a50` 容器/数据库，不复用生产数据。
- Windows：`DESKTOP-DVFFB09` / Windows 11 专业版，先使用 `C:\Windows\Temp\synthia-m4f-<gate-id>` staging，不覆盖 `D:\synthia-worker` 或其他既有 Worker 目录。
- Runtime：在 staging 内安装官方 Windows x64 Bun 1.4.1，使用固定绝对路径并记录 version/SHA-256；不得复用现有 Node 入口，也不得依赖 `PATH`。
- Vivado source：`D:\Xilinx\Vivado\2021.1` 仅作为待认证复制源，不直接进入 Gate trust boundary。Gate Worker只执行只读挂载的版本化 toolchain image；只接受真实探测到的 2021.1 / SW build 3247384 / IP build 3246043、part `xc7k70tfbv676-1`、license probe 与冻结 toolchain profile，漂移即阻断。
- Connector 公网路径：`https://connect.wenzhuolin.xyz` → Cloudflare Access → NAS origin proxy/mTLS → `DESKTOP-DVFFB09:8443`。Core 保持该 endpoint，不因远端管理拓扑修改 Connector 协议。
- Gate 产物：日志、release manifest、ledger/spool 备份和 Vivado 证据写入仓库外的专用 artifact 目录，秘密不得进入仓库或报告。

### 3.2 Vivado toolchain image 与远端证明

1. toolchain image 是单一、非 differencing 的动态 VHDX，只承载 Vivado，不承载 ledger、spool、workspace、evidence、release 或秘密。宿主 D 盘在创建前须满足“canonical source tree bytes + 20 GiB”实际余量，挂载 NTFS 卷须至少 10 GiB 可用；任一余量低于门槛立即关闭 new effects。VHDX virtual size 冻结为至少 source tree bytes + 20 GiB。
2. 复制前、复制后分别对 source 再生成同一 `synthia-vivado-full-tree-manifest.v1`。Root exact keys 为 `schema|canonicalization|entries|entry_count|file_count|total_bytes|canonical_sha256`，`canonicalization="RFC8785/JCS+NFC"`；hash preimage 是排除 `canonical_sha256` 后的 root object 之 RFC 8785/JCS UTF-8 bytes。`entries` 每项 exact keys 为 `path|type|size_bytes|sha256`：`path` 必须先 Unicode NFC，使用 `/` 分隔的 1..4096 UTF-8 bytes relative path，禁止 absolute/drive/`.`/`..`；`type` 仅可 `regular_file|directory`；文件 `size_bytes` 为 0..`Number.MAX_SAFE_INTEGER` 且 `sha256` 为 64 小写 hex，目录则固定 `size_bytes=0,sha256=null`。Entries 按 NFC path 的 UTF-8 bytes 严格升序；拒绝 case-fold/NFC 冲突、reparse/junction/symlink/unknown entry。`entry_count` 为 1..safe integer、`file_count` 为 1..`entry_count`、`total_bytes` 为 1..safe integer，三者必须与 entries 精确重算一致；mtime/ACL/root absolute path 不进入 preimage。两份 source manifest canonical bytes 必须一致，否则证明复制期间漂移并废弃 image。复制不能继承 source security；目标递归关闭继承并只允许受信管理/service identities 写。目标只读挂载后重算同一 manifest，canonical bytes 必须与稳定 source snapshot 完全一致。关键 EXE/DLL/launcher 另做 Authenticode 验证并保存 signer/status/hash；当前可写 source 不能仅凭“复制一致”冒充 vendor provenance。必须先只读搜索 vendor installer、安装清单/日志或可校验的 known-good manifest；若仍缺失，只能标为“stable full-tree snapshot + Authenticode + real probes”的 known-current installation snapshot，并要求 Reviewer 对该限制 provenance 单独显式签署后才可进入 F0。
3. 本专用、非生产 M4-F Gate 对已知 D: root 宽 ACL 采用显式补偿模型，不修改 D: root ACL，也不再把静态祖先 ACL 当作单独硬门。VHDX 仍必须放在关闭继承且去除宽泛 write/delete 权限的专用 backing directory，并逐级记录 D: root→backing directory→image owner/ACL。受保护脚本在 detached 状态先按 NTFS file identity 打开同一 image 的长寿命 read handle，share mode 只允许 read 而拒绝 write/delete；在该 handle 不释放的前提下对同一 file identity 复算 VHDX SHA-256/size，执行 read-only attach，再从已挂载 disk image 反查并匹配 pre-attach path/file identity，然后绑定 disk/partition/volume unique IDs、serial、volume GUID、mount mapping 与 `write_probe=access_denied`。该 handle 从 hash 前一直保持到 Worker/Vivado 全部停止且 recovery/retention 收敛；如 Windows API 不能在该 share mode 下 attach，则 D: 方案当场失败，必须换用无宽 ACL 的 backing volume/path。Gate 开始前以非管理员 `Authenticated Users` 真实负例证明挂载期不能 detach/remount、删除、重命名、替换 backing 或改变 mapping。若 image path 在 handle 建立前被替换，必须由 detached hash + readonly-target full-tree parity 检出；若挂载后 path/identity/mapping/read-only/space 任一漂移，定义为 DoS，同一 tick 关闭 new effects 并保留旧 mounted image 供 recovery/retention。该 D-root 例外不得用于生产 release、正式 FPGA 证据或硬件下载。
4. 生成严格 exact-key 的 `synthia-vivado-toolchain-attestation.v1`，至少绑定 gate ID、UTC validity、detached VHDX SHA/size/file identity、read-only attachment/disk/partition/volume identity、full-tree manifest canonical hash/count/bytes、真实 Vivado version/SW/IP build probe、part presence、license/最小 synth probe及其 stdout/input hash、toolchain profile hash与 canonical attestation hash。attestation 最长有效 4h，原始文件存入受保护 C staging 并记录 raw-file SHA-256。
5. toolchain profile hash 从既有 profile 语义、full-tree manifest hash、真实 version/build/part/license probe与 volume identity canonical 派生，不能继续沿用未证明的配置常量。source config更新为该派生值后重新构建最终 A；A、active config、Worker discovery和 B 必须四方一致。
6. active config 必填 `vivado_toolchain_attestation_path` 与 `vivado_toolchain_attestation_sha256`。Windows launch preflight 独立重读/rehash/strict-parse attestation并核当前 read-only mapping；Worker启动时再次重读/rehash，discovery、eval preflight、reserve/submit attestation与canary receipt均回显/绑定同一 SHA。Gate B 硬升级为 `synthia-evolution-eval-f0-certification.v2`，绑定 attestation raw SHA、canonical hash、full-tree manifest hash和profile hash；旧v1只可审计，永远不能授权new effects。
7. B 仍最长有效 15 分钟且其整个时间窗必须落在 toolchain attestation 有效窗内。Core 启动和每个 dispatcher tick 先重读 A/B/config/attestation，再对 B 的 endpoint 发起 authenticated live discovery/status probe；Worker 必须在回应该 probe 前 live recheck attestation file hash/freshness、backing handle/file identity、disk/partition/volume/mount mapping 与 read-only state，然后回显 current build/config/process-instance/toolchain-attestation/profile/ledger-epoch 与 live-mapping-health。Core 将该 observation 与 B v2 精确比对；本地重验或 live probe 任一失败/超时/漂移，都在同一 tick fail closed new effects/rollout。Reserve/submit 仍执行第二道 pre-effect TOCTOU 检查。这些失败不阻断已接受 job 的同 epoch query/cancel/evidence/ack/corrupt_ack/quarantine/cleanup/retention。18443 旁路与 8443 takeover 必须使用同一个仍有效的只读 image 与 attestation，但仍分别生成 exact active-config SHA、process instance 和 B。
8. toolchain image只有在new effects关闭、所有accepted/effect已终态且同epoch recovery/retention收敛、Worker/Vivado全部停止后才能detach。每次重新attach都要重新执行detached hash、mapping、真实probe并生成新attestation/B；不得复用旧进程身份或旧B。lock handoff ACK 必须写入 supervisor 预创建且禁止 delete/改 ACL/夺权的精确文件槽；service identity 只持有满足 `r+` 原地写入所需的 `Read|Write|Synchronize`。supervisor seal 前须校验 ACK exact keys、固定 schema、当前 nonce、UUID v4 process instance 与当前 attestation raw SHA，任一漂移不得建立 handoff。

### 3.3 Gate Worker 切换方案

1. 在 `C:\Windows\Temp\synthia-m4f-<gate-id>` 部署版本化 release，使用独立 ledger、spool、workspace、epoch、唯一 Gate project scope 与 18443 旁路端口。Windows 本机 loopback/管理通道完成 F0 双构建、入口 smoke、initialize→reopen 和无副作用负例；现有 8443 Worker 保持运行。18443 的 active-config hash、process instance 或任何认证结果不得晋升复用为公网 B。
2. 从同一个 release/reopen 配置冻结独立 8443 takeover config；它与 18443 配置使用同一个 ledger/epoch/roots，仅修改已审核的 listen/endpoint 字段并保持唯一 Gate project scope。对该 exact config 重新运行 `LaunchPreflight`、记录 raw-file SHA，且在启动后重新采集 process-instance attestation。
3. 旁路 Gate 全部通过后，保存现有 8443 Worker 的 bundle/config/launcher hash、计划任务定义/启用状态、PID/进程树和端口基线。公网认证采用维护窗口，顺序固定为：关闭所有非 Gate new submission 并排空在途请求 → 将公网入口限制为 Gate caller/project scope → 禁用旧计划任务自动拉起 → 优雅停止旧 8443 Worker并证明其 PID 树消失且 8443 无 listener → 优雅停止 18443 Gate Worker并证明其 PID 树消失、18443 无 listener、ledger/spool 无第二 opener/持有者 → 使用 takeover config 以同 epoch `reopen` 启动 Gate Worker → 证明 8443 只属于该 PID/process instance/config hash且该进程是 ledger/spool 唯一持有者 → 才允许公网 reserve → 显式重启 → 再次证明只有 post-restart process 持有该 ledger/spool → certify B → 打开 Gate new effects。18443 与 8443 Gate Worker 不得并存；任一步无法证明即回滚或保持 fail closed。
4. 接管 8443 会中断现有服务，Leader 必须在执行前报告预计影响、流量隔离方式和回滚点并取得用户明确确认。未获确认时只能完成旁路 F0，不能宣称远端 F1 或最终 Gate F PASS。
5. 公网 Gate 期间持续检查 Cloudflare/NAS/Worker access log，不得出现非 Gate project 的 submit；出现即关闭 new effects 并判该窗口证据受污染。18443 的 receipt/B 和旧 Worker process identity 永远不能替代 8443 takeover config 的 reserve→restart→certify 证据。
6. 公网 Gate 结束或失败后，先关闭 Core new-effects/self-evolution rollout，等待 recovery/retention duty 收敛，再停止 Gate Worker并证明 8443 无 listener。只有在确认旧 Worker不会读取新 ledger且不承担 M4-E recovery 时，才允许按原定义恢复/启用旧计划任务；随后核对唯一 PID/listener、原 config hash 和 access log。若已有 accepted/effect fact，必须保留新 release直到同 epoch 收尾完成。

### 3.4 Rollout 状态机

三个独立状态为：dispatcher host、new effects、self-evolution rollout；Pause 是数据库内运行时刹车。旧 `SYNTHIA_FEATURE_EVOLUTION_EVAL_EXECUTION` 不得同时代表 host 与 new effects。

| 阶段 | dispatcher host | new effects | self-evolution rollout | Pause | 允许行为 |
|---|---:|---:|---:|---:|---|
| deploy/preflight | 0 | 0 | 0 | 任意 | 无 Core dispatcher duty；只做 Connector 隔离 preflight |
| recovery/retention-only | 1 | 0 | 0 | 任意 | recover/cancel/freeze/ack/quarantine/cleanup；禁止新 dispatch effect |
| canary/full | 1 | 1 | 1 | false | 允许受控新 effect 与全部后台收尾 |
| 场景失败/结束 | 1 | 0 | 0 | true 或保持 | 禁止新 effect，等待 recovery/retention drain |
| 完全停止 | 0 | 0 | 0 | 保留安全值 | 仅在所有必须收尾 duty 已收敛后停止 host |

每次状态变化记录时间、PID、数据库、endpoint 和三门实际值。Connector discovery 与 ledger initialize/reopen canary 在 Core deploy/preflight 状态完成；真实正例只在 canary/full 窗口运行。

### 3.5 回滚

- 部署前备份旧 bundle/config/launcher 并记录 hash；新 release 使用版本目录，hash 复核后再切换。
- 一旦 ledger 存在 accepted/effect fact，禁止恢复旧 ledger 快照、换 epoch、重新 initialize 或删除 spool。
- 旧 bundle 若不能 reopen 新 ledger，只能在 `evolution_eval_enabled=false` 下恢复 generic Worker；恢复 M4-E 必须回到能 reopen 原 epoch 的新 bundle。
- DB migration、audit、outbox、ToolRun 和 evidence facts 不逆迁移、不删除、不伪造。

### 3.6 不可伪造的验收证据

- 每个 Gate 生成机器可读 JSON summary，并绑定 gate ID、UTC 时间、Git 状态快照、冻结文件 hash、bundle/config/runtime hash、数据库 identity、Connector ID/build/profile/epoch 和场景输入 hash。
- 构建、toolchain 与环境认证分成三个独立 canonical object：`synthia-worker-release-manifest.v1` 只绑定 bundle/runtime/source/config template 与 expected Worker identity，不含数据库或秘密；`synthia-vivado-toolchain-attestation.v1` 绑定只读 image/full-tree/volume/真实 probe；`synthia-evolution-eval-f0-certification.v2` 引用前两者的 canonical/raw hash，再绑定 gate/database/endpoint、exact active config、实际 remote observation、ledger epoch、never-accepted canary 与显式授权。New-effects gate 只接受 v2 第三层，A builder 不依赖数据库。旧 B v1 仅可审计，不得授权 new effects。
- A 层显式保存 `source_state: clean|dirty` 与 `git status --porcelain=v1 -z --untracked-files=all` exact bytes 的 `git_status_sha256`（clean 为空字节 hash），并从一次冻结 source snapshot 完成双构建与 source hash，不能边构建边读取 live tree。B 层另存 `dirty_release_authorized`：clean 必须 false；dirty 只可在专用 M4-F Gate 显式为 true，并且不能代替 remote certification 授权。生产 release 永久拒绝 dirty。
- Worker remote attestation 回显本进程实际读取的 `active_config_sha256` 与每次启动新生成的 `worker_process_instance_id`。Canary 分两阶段：先 reserve 并写 exclusive canonical receipt，外部编排独立记录 receipt 原始文件 SHA，再显式重启 Worker；之后 certify 必须复算并匹配该外部 expected SHA，且 query 在不同 process instance 上得到同 epoch/same binding 的 never-accepted proof。B 绑定 reservation receipt 与 post-restart instance。
- B 不能用自身布尔字段授权自身。部署环境分别注入 B 与 toolchain attestation 原始文件的 expected SHA-256；Core 启动和每个 dispatcher tick 均重读 A/B/active config/toolchain attestation，复算 raw-file/canonical/profile hash并检查 B 的 15 分钟 freshness 和 toolchain attestation 的 4 小时 freshness，然后执行 authenticated live discovery/status probe 并与 B v2 比对。缺失、失效、probe 失败或 remote build/config/instance/toolchain/mapping 漂移只关闭 new effects/rollout，不能阻断 recovery/retention duty。
- 为关闭 discovery→reserve 与 preflight→submit 间 Worker restart 或 toolchain 漂移的 TOCTOU，每个 new-effect reserve/submit 通过受控 HTTP headers 携带 B 认证的 expected active-config SHA、process instance 与 toolchain-attestation SHA；Worker 必须分别在 durable reservation 前、acceptance/Vivado 启动前本地精确比对。该 attestation 不写入 Core-issued binding/body，query/cancel/evidence/ack/corrupt_ack/quarantine/cleanup/retention recovery 也不得因旧 config/process/toolchain identity 漂移被阻断。
- 真实 job 证据必须同时来自三个独立事实面：Core PostgreSQL append-only facts/audit/outbox、Connector durable ledger/manifest、Windows 进程/Vivado output。只保存一段 console 文本不能宣告通过。
- Leader 独立复算 canonical/entry/bundle hash，并以只读 SQL 核对 ID/ordinal/state/classification/selector；Reviewer 复跑至少一组正例 trace 和全部安全 selector。
- chaos 场景记录注入点、被丢弃的响应类型、重启前后 PID/epoch/ID/hash 与执行次数；脚本不得直接修改终态 observation 或 DB 结果来制造恢复成功。
- 报告中对 secret、用户路径和跨项目内容做 redaction；原始 secret、证书、token、ledger/spool bytes 不提交 Git。

## 4. 团队 ownership 与审核节奏

| 角色 | 独占范围 | 交付 | 禁止事项 |
|---|---|---|---|
| Leader | 本计划、共享部署编排、Gate artifact 索引、最终 rollout 决策 | 冻结接口/hash，启动/停止受控环境，复跑总门禁 | 不以 Agent 自报代替证据；不覆盖用户修改 |
| Connector Agent | `connector/server.bundle.mjs`、Windows config/launcher、Connector release/preflight 脚本及 tests | 可复现 bundle、Bun launcher、initialize→reopen、Windows/Vivado 采证 | 不改 Core/Runtime/Web；不接触硬件 |
| Core/Runtime Agent | Core M4-F 认证 harness、chaos proxy 与其 tests | 真实 PG→Core→Connector 场景、DB trace/selector 断言、恢复控制 | 不改 Connector launcher/ledger；不扩大 token/scope |
| Reviewer Agent | 全范围只读 | 计划 Gate、中点审查、最终 Gate F 签署 | 不直接修改实现 |

执行节奏固定为：

```text
计划冻结与 Reviewer PASS
→ Connector/Core 两名 Owner 并行完成 F0/F1
→ Leader 初审并运行本地门禁
→ Reviewer 中点审查（P0/P1 清零）
→ Leader 启动受控 Windows/PG 环境
→ 两名 Owner 分场景执行，Leader 保存证据
→ Reviewer 复验 finding 与最终签署
```

## 5. F0 — 可复现 Connector release 与 Windows preflight

### 交付

1. 新增或完善 release 构建脚本：在与 Windows Gate 相同的 Bun runtime 上连续两次临时构建，必须 byte-identical；记录源码、lockfile、bundle size/hash 和构建器可执行文件 hash。
2. 扫描 bundle，不得含 token、证书/PFX 密码、secret 或构建机绝对路径；静态确认包含 ledger v2、retention、`physical_deleted` 与四个 eval operation。
3. `sdk_worker_build_hash` 固定为最终 bundle SHA-256，外部 config 与 Core expected endpoint 必须精确一致；不得把 hash 写回 bundle 形成自引用。
4. launcher 使用验证后的 Bun 绝对路径，不依赖 `PATH`，并 fail closed 地检查 bundle/config/hash。必须在 Windows 上实际启动生成的 bundle并访问 registration/discovery/eval query，不能以 import 成功或静态扫描代替入口测试。
5. launcher/ceremony 明确一次性 initialize、永久 reopen、优雅停止、异常退出后 reopen 与 reconciliation；普通服务重启不得再次使用 initialize。
6. Gate config 使用隔离 ledger/spool/workspace：首启 explicit `initialize`，确认 metadata/epoch 后停止；随即切到永久 `reopen` 并归档首启配置。后续配置不得保留 initialize。
7. Windows preflight 验证 staging 所在卷为 NTFS/local fixed disk、路径非 reparse/junction/symlink、目录 ACL、目标卷至少 10 GiB 可用空间、Bun/Vivado/license/part/profile、TLS/mTLS 与 baseline 进程。
8. 对 Vivado source 生成复制前/后稳定 canonical full-tree manifest，拒绝 reparse 和路径冲突；对不继承 source ACL 的 VHDX 目标递归重算每项 hash，并保存 vendor material 搜索与 Authenticode 证据。若只能证明 known-current snapshot，需 Reviewer 对限制 provenance 单独签署。
9. 创建单一非 differencing VHDX，在 detached 状态绑定 image hash/size/file identity，以 read-only attach 绑定 disk/partition/volume/mount mapping；完成写探针与非管理员 detach/remount/delete/replace/mapping 负例，并验证 host/guest 空间与全树 ACL。
10. 在该只读挂载上执行真实 Vivado version/SW build/IP build/part/license/最小 synth probe，生成严格 exact-key 的 `synthia-vivado-toolchain-attestation.v1`；验证 raw/canonical/full-tree/profile hash 以及 4 小时有效窗。Discovery 不得再把配置常量当成实测结果。
11. 由派生 toolchain profile 更新 config template 后，在固定 Windows Bun 上重建最终 A；active config/launcher/Worker 启动必须 strict-parse 并绑定 attestation path/raw SHA。Windows 上的 provisional A 不得用于授权 new effects。
12. wrong epoch、空/损坏 root 必须通过公开 query canary 显示 corrupt/unavailable 且零 Vivado effect；若 server 仅“启动成功但 ledger 降级”，health/query 证据必须显式阻断 ready。
13. 更新 `connector/USAGE.md` 与隔离部署资产，记录 eval routes、epoch/spool、initialize→reopen、retention、crash/reconcile、toolchain image/attestation、备份/回滚和 Bun launcher；不得把生产 secret 或 Gate ledger/spool 放入 Git。

### Gate F0

- 双构建 parity、部署后 bundle hash、release manifest 全部一致；
- source pre/post/readonly target full-tree manifest 完全一致，VHDX detached/attached identity、只读 mapping、ACL、写探针与非管理员负例全部通过；
- toolchain attestation 中的真实 version/SW/IP build/part/license/最小 synth probe 通过，A/config/discovery/attestation 的 profile/raw/canonical hash 一致；限制 provenance 如适用已获 Reviewer 显式签署；
- Windows 上实际 bundle 入口 smoke、initialize→reopen 跨进程 query-first、same epoch proof 通过；
- discovery 只有 `validate_sources|simulate|synthesize|implement` 广告 `evolution_eval`；
- 无秘密泄露、无 reparse/ACL/空间 blocker；P0/P1=0。

## 6. F1 — 分级 rollout、远端认证与真实 E2E harness

### 交付

1. Core dispatcher host 与“允许新 effect”拆成两个独立、默认关闭的配置：execution host 打开时可运行 recover/cancel/freeze/ack/quarantine/cleanup；只有额外 new-effects gate 为 true、self-evolution rollout 为 true 且 Pause 为 false 时才允许 dispatch 新 effect。`allowNewEffects`/`rolloutEnabled` 不得在启动代码中硬编码 true。
2. 新 effects gate 打开前，必须完成远端认证：实际 discovery 的 bundle build hash、capability map、toolchain profile/license、四项 allowlist，以及 query canary 的 ledger epoch/健康状态，都与 F0 manifest 精确一致。只有本地 Connector JSON/secret 存在不构成 ready。
3. B 必须使用 `synthia-evolution-eval-f0-certification.v2`，严格绑定 A、toolchain attestation raw/canonical/full-tree/profile hash、exact active-config SHA、post-restart process instance、canary receipt 和 ledger epoch，且有效窗不得超出 toolchain attestation 有效窗。Core 启动及每个 dispatcher tick 都必须从文件重读并复算 A/B/config/attestation，随后通过 authenticated live discovery/status 重验当前 Worker 与 mapping/read-only health；不得复用启动时的内存布尔值或接受 B v1。
4. 每个 new-effect reserve/submit 要携带 B 绑定的 expected active-config SHA、worker process instance 与 toolchain attestation SHA；Worker 分别在 durable reservation 前、acceptance/Vivado 启动前重新比对。Query/cancel/evidence/ack/corrupt_ack/quarantine/cleanup/retention 按 job 已持久化的 ledger epoch/binding 验证，不得因当前 B/config/process/toolchain identity 过期或漂移被拒绝。
5. 分级顺序固定为：route/ledger deployed（Core off）→ dispatcher recovery/retention-only → 单个 canary new effect → 两个受控 run full。任一层失败立即回到 recovery/retention-only，不中止后台收尾。
6. Core/Runtime 认证 harness 使用真实 PostgreSQL、真实 Core HTTP、进程内 Runtime Evaluator 和真实 Connector HTTP/mTLS；模型决策可以是确定性 fixture，但不能绕过 Runtime/Core route 或直接调用 Vivado adapter。
7. 使用 Core-issued snapshot/eval input、sealed workspace 与真实 dispatcher；保存 curator/application/version/eval job/tool run/connector ID、dispatch/projection/manifest hash、ledger epoch、audit/outbox 链。
8. chaos proxy 只允许以下精确场景，并对每次注入记录 `forwarded_to_connector` 与 `connector_response_observed`：
   - effect fence 已提交后，在 Connector 前 hold/drop submit，证明 no-accept recovery；
   - Connector 已 durable accepted 后 drop submit response；
   - query 延迟或断开、cancel response 丢失；
   - evidence entry stream 中断；
   - valid ack durable 后 drop response；
   - corrupt_ack/quarantine/cleanup durable 后 drop response。
   Proxy 不得修改 payload、伪造 observation、terminal、manifest 或 retention receipt。
9. 所有脚本默认 dry/preflight，只有显式 Gate 环境变量、专用数据库标记、已签 F0 v2 与 endpoint allowlist 同时匹配时才能产生新 effect。

### Gate F1

- recovery/retention-only 模式实测可收尾且绝不创建新 effect；new-effects 与 self-evolution rollout/Pause 三门组合负例通过；
- B/config/process/toolchain 分别缺失、过期、raw/canonical/profile 或 remote observation 漂移时，同一 tick 关闭 new effects/rollout；已接受 job 仍能完成 query/cancel/evidence/ack/corrupt_ack/quarantine/cleanup/retention 收尾且不依赖当前 process/config/toolchain identity；
- 每个 tick 的 authenticated live discovery/status 能发现 Worker restart、attestation 漂移以及 mapping/read-only health 失效；probe 失败或超时也在同一 tick 停止 new effects；
- reserve 与 submit 两个边界的 config/process/toolchain attestation TOCTOU 负例均在 durable acceptance/Vivado effect 前失败；
- rollout off、Pause、dry-run、混 scope、跨项目 token 均在 Connector effect 前拒绝；
- harness 不含 generic Connector credential、result ingestion 后门或 hardware route；
- 数据库清理只限专用 Gate namespace，不能 truncate/删除非 Gate 数据；
- focused tests、typecheck、`git diff --check` 通过；P0/P1=0。

## 7. F2 — 真实 Vivado 正例与产物隔离

使用已审核 HDL fixture；若 `golden/uart` 的 part/XDC 与真实目标 profile 不一致，必须先由 Reviewer 确认最小 fixture 调整，不能降低真实工程规则。

两个 Curator run 完成四项操作，任何单 run 不超过 3 job：

1. Run A：`validate_sources`、`simulate`、`synthesize`，ordinal 1..3 且严格串行；
2. Run B：`implement(generate_trial_bitstream=true)`，真实执行 synth→opt/place/route→DRC/STA→write_bitstream；
3. 每项均经 PostgreSQL→Core dispatcher→mTLS Worker→Vivado→Connector evidence→Core freeze；
4. 每项核对 deadline、process stopped、terminal state、manifest/entry bytes/hash/classification、ack/cleanup 后台收敛；
5. 项目 workspace/Git tree 前后 hash 不变，eval output 只存在于隔离 spool/Core evidence store。

`implement` 的 `.bit` 必须同时满足：

```text
artifact_classification = experimental/evolution_eval
usage_classification = evolution_eval_only
```

并逐一证明 formal/gate/baseline/release/delivery/publish/download/hardware selector 不返回该产物。缺一字段或任一 selector 可见，直接判 Gate F 失败。

## 8. F3 — 安全负例与恢复演练

### 安全负例

- exact/mixed scope、Curator/Evaluator token 互用、cross-project/ACL conceal；
- raw Tcl/command、未知 operation、Skill `.tcl/.py/.ts` 执行；
- caller bytes、Host path、project write、formal/gate/baseline/adopt/approve/publish/download 字段；
- part/profile/dispatch/projection/manifest hash 漂移与 replay 异 payload；
- hardware manager/target/device、`open_hw`、`program_hw*`、`write_cfgmem` 等字符串/字段。
- source 最多 4096 files/512 MiB、Skill 与 overlay 各 512 files/32 MiB、workspace 5120 files/576 MiB、单次 read/write 8 MiB、未 ack spool 2 GiB、evidence 128 entries/单项 64 MiB/单 job 256 MiB 的边界与越界；大容量场景优先使用 sparse/streaming 或现有确定性测试，不在磁盘不足时制造巨型临时文件。

负例必须在 acceptance/process 前拒绝；检查无新 Vivado 子进程、无 project/spool 非法字节、无权威 evidence。不得真的调用硬件接口来证明拒绝；应通过 strict parser/policy 的 pre-effect 拒绝、生成 Tcl 禁词扫描、无 `hw_server/vivado_lab` 进程和板卡断开共同证明。

### 恢复演练

1. effect fence 后 submit 未 forward，以及 accepted 后 submit response lost：Core 均以原 ID/key/hash query-first；前者仅在 `proven_never_accepted+replay_permitted` 时 same-ID submit，后者 Vivado 只启动一次；异 hash replay 拒绝；
2. Worker 在 running、terminal+pending ack、quarantine/cleanup pending 三个点重启：同 epoch reopen，无重复执行或 evidence 晋升；
3. Core 在 effect fence 后、submit response 前、evidence entry 流中断、freeze/ack/corrupt_ack/cleanup response lost 后重启：lease reclaim、same-ID replay、DB facts不重复；
4. 真实长任务 cancel：Windows Job guardian 整树停止；不能证明停止时只能 `unknown_effect`，后续 job 被 latch；
5. 真实墙钟 2h cutoff：让真实 job 先 terminal，chaos proxy 持续阻断 evidence fetch 到原始 `budget_started_at+2h`；cutoff 后再放行 bytes，Core 必须永久 `unavailable_at_deadline`、不得 freeze/评价，只能 discard/cleanup，run 可关闭且 retention duty 继续；
6. controlled corruption：仅修改 terminal 后隔离 spool 中的 evidence bytes，不修改 ledger/DB terminal fact。Core 必须写 corrupt，Connector 接收 canonical corrupt_ack 后 quarantine，Curator fail 返回 409，complete 只能 `inconclusive+no_op`；
7. unavailable 与 unknown 分别验证 Curator fail-bypass 被拒绝、complete 只能 `inconclusive+no_op`，unknown latch 禁止后续 job；
8. dispatch-vs-tombstone 覆盖 tombstone 先提交、effect fence 先提交与真实并发竞争；最多一方产生 effect，另一方 durable no-op/cancel/reconcile，不能新建 Connector ID；
9. pause/rollout off/终态 run 后禁止新 eval effect，但 recover/cancel/freeze/ack/quarantine/cleanup 仍可运行。

## 9. F4 — UI、全量回归与最终 Gate

1. Web 真实 Core 契约检查：Evolution overview、Skill/version/application/evaluation trace、Pause/Disable、rollout off 文案与动作可用性；不要求 UI 读取终态 eval evidence bytes。
2. 浏览器在桌面、390×844、320×720 检查 Evolution 页面与关键项目页，无横向溢出、console/network 应用错误或隐藏写入口。
3. 运行：

```bash
DATABASE_URL=<gate-db> bun test
bun run check
bunx tsc --noEmit -p runtime/tsconfig.json
(cd web && bun test && bun run check && bun run build)
bun build connector/server.ts --target=node --outfile <temp>/server.bundle.mjs
cmp <temp>/server.bundle.mjs connector/server.bundle.mjs
git diff --check
```

4. migration upgrade/fresh schema parity 必须通过；只读 SQL 逐边核对 ToolRun `submitted→queued→preparing→running→terminal` audit、reconcile/unknown fact、background ack/quarantine/cleanup receipt 与 outbox publication。
5. Reviewer 核对所有 M4-F artifact、命令、hash、数据库查询、Windows 进程证据和 finding→test 映射。

### Gate F 退出条件

- 四个真实 operation、3 job/serial/2h、scope/ACL/dry-run/Pause/rollout、迁移/幂等/并发与 crash recovery 全部通过；
- resource/canonical/evidence/retention 边界由 M4-E 自动测试与 M4-F 真实环境证据联合覆盖；
- response-lost/restart/cancel/unknown_effect 无 blind redispatch、无 orphan process；
- 试验 `.bit` 双分类且所有正式/hardware selector 排除；
- 无硬件连接、下载、编程或相关进程/命令；
- 全量回归与静态门禁通过，Reviewer P0/P1=0。

Gate F PASS 只表示 M4 实现和受控环境认证完成，不自动启用生产 rollout。生产启用仍需单独的发布/运维决定。

## 10. Traceability Matrix

| Requirement | F1/F2 代码证据 | F3/F4 真实证据 | 最终状态 |
|---|---|---|---|
| 可复现 Connector/Bun 部署 | release manifest、bundle parity、launcher/config tests | Windows hash、initialize→reopen canary | pending |
| 可归因的只读 Vivado toolchain | canonical full-tree manifest、VHDX/ACL/attestation strict parser、真实 probe tests | stable source pre/post/readonly target parity、detached/attached identity、Authenticode/vendor material、非管理员负例 | pending |
| 分级 rollout 与远端 ready | recovery-only/new-effects 双 gate、B v2、startup/tick rehash + authenticated live probe、new-effect attestation headers | canary A/B/config/toolchain/mapping/epoch/capability proof、TOCTOU 负例 | pending |
| 证明漂移下的 recovery/retention | per-job ledger epoch/binding；current identity 仅保护 new effects | B/config/process/toolchain 过期/漂移后已接受 job 仍收尾 | pending |
| 四 operation 与 3 job/serial/2h | Runtime/Core bounded harness | 两个 run 的 Vivado/DB/ledger trace | pending |
| scope/ACL/rollout/Pause/dry-run | route/dispatcher focused tests | pre-effect 负例与零进程证据 | pending |
| crash/restart/response lost/cancel | chaos harness、ledger tests | Core/Worker restart 与进程树证据 | pending |
| evidence freeze/retention | M4-E E3 PASS suites | real spool/freeze/ack/reopen trace | pending |
| corrupt/unavailable/unknown fail-bypass | completion/fail policy tests、chaos harness | corrupt_ack/quarantine、真实2h cutoff、unknown latch | pending |
| dispatch-vs-tombstone 与 ToolRun audit | concurrency/migration/fresh tests | 两种顺序+竞争 trace、逐边 audit SQL | pending |
| eval `.bit` 非正式产物 | B.6 PASS selectors | real `.bit` 双分类与 selector 查询 | pending |
| 禁止 hardware download | strict parser/policy tests | 无 hardware 命令/进程/设备连接 | pending |
| UI 与用户刹车 | Web tests | browser 三尺寸 + real Core contract | pending |
