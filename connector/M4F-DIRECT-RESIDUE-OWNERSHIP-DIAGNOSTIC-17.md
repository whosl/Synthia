# M4-F Candidate 17：认证后只读归属观察

## 准入条件

Candidate 17 只能在独立 Candidate 16 获得 Windows PowerShell Desktop 5.1 的 `parsed_not_invoked` 成功证据后规划或执行。其配置必须绑定 Candidate 16 配置和全部成功证据，也必须继续绑定 Candidate 15 的真实 parser 失败证据。

Candidate 17 会重新生成目标脚本、encoded command 和 Candidate 16 parse loader，逐项核对脚本/命令长度与哈希、解析结果、原始 stdout/stderr、进程状态、SSH effective config、确认串哈希和三份传输快照。任一文件或语义漂移均在第一次网络调用之前拒绝。

Candidate 17 还会从自身冻结依赖重新计算 Candidate 16 源码、Candidate 16 专项测试和共享 parse-loader 源码哈希，不能只相信 parse config 中的声明。

## 修正与只读范围

Candidate 17 对 Candidate 15 生成脚本做精确、计数受限的语法修正：

- `foreach ($i in $want)`；
- PowerShell word operators 两侧使用 ASCII 空格；
- 保留 `n=$e.Count`，它表示一次 CIM 全图快照产生的 PID-parent edges 数量；
- 目标 PID 数量仍由 `...).Count -ne 4` 单独验证。

脚本只允许一次 `Get-CimInstance Win32_Process` 快照。四次 `Get-Process` 是静态证明，不是新增远端计数宣称：配置固定四个唯一 target PID，两个 cmd PID 与 target 不相交，`$want` 以四个 target 各一次开头，`Get-Process` 只存在于 `$i -in $ids` 分支。

观察命令使用一次直连 SSH、空 stdin、单个 encoded command、单次尝试、禁止重试。它允许读取既有进程的 PID、父 PID、名称、创建时间、session、启动时间和 command-line 哈希；不允许返回或保存原始 command line。

## 明确禁止

- 终止或修改任何进程；
- 创建、修改或删除文件；
- 从观察结果推导或执行清理；
- 调用 Vivado、hw_server、vivado_lab；
- 生成、连接、下载或编程硬件；
- 复用 Candidate 16 或更早 Candidate 的授权串。

当前生成的 Candidate 17 command 为 6698 字符，低于内部 7000 和 Windows 8191 上限。

Candidate 17 的真实生产执行仍需：Candidate 16 真实成功证据、独立审核结论、新的 Candidate 17 生产配置和用户逐字授权。
