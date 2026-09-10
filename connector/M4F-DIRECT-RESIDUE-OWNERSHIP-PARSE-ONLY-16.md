# M4-F Candidate 16：Windows PowerShell 5.1 仅解析认证

## 目的

Candidate 16 是 Candidate 17 真实只读观察之前的独立安全门。它把 Candidate 17 的最终 PowerShell 脚本发送到目标 Windows，但远端只调用 `System.Management.Automation.Language.Parser.ParseInput`。脚本不会被创建为 `ScriptBlock`，不会被调用，也不会执行其中的进程、文件、Vivado 或硬件逻辑。

Candidate 15 已证明原脚本会因 `foreach($i in$want)` 在 Windows PowerShell 5.1 中触发 `MissingInInForeach`。Candidate 16 的唯一任务是证明修正后的精确脚本能被 Windows PowerShell Desktop 5.1 解析，且解析目标正文没有运行。

## 两阶段授权

Candidate 16 与 Candidate 17 必须使用不同的配置、计划、确认串和证据目录。Candidate 14 或更早 Candidate 的授权不能复用；Candidate 16 的授权也不能授权 Candidate 17。

规划命令输出纯计划字段，并附加：

- `config_sha256`：规范化 Candidate 16 配置的哈希；
- `plan_sha256`：只对纯计划对象计算的哈希；
- `confirmation`：绑定上述两项以及 Candidate 16 source/test、Candidate 17 source/test 的逐字确认串。

证据目录中的 `plan.canonical.json` 只保存纯计划，避免计划包含自身哈希造成递归。

## 成功条件

- PowerShell edition 为 `Desktop`，版本以 `5.1.` 开头；
- `Parser.ParseInput` 返回 `ScriptBlockAst`，且 AST 的 `EndBlock` 非空；
- parser error count 为 0；
- 进程退出码为 0，空 stdin、空 stderr、无超时；
- `target_body_not_invoked=true`；
- process/file/Vivado/hardware/cleanup mutation 标志全部为 false；
- 目标脚本、目标命令、gzip payload、loader、parse command 均能由冻结输入重建并匹配哈希。
- Candidate 16 源码、专项测试和共享 parse-loader 源码哈希全部由配置与确认串绑定。

`parse_rejected` 是失败证据，不会自动重试，也不会进入 Candidate 17。

## 冻结证据

成功证据至少包含：规范化配置、纯计划、确认串哈希、目标脚本、parse loader、parse record、原始 stdout/stderr、远端进程记录、SSH effective-config 原始输出与进程记录，以及 initial/pre-remote/post-remote 三份传输输入快照。

Candidate 17 必须逐文件校验绑定哈希，并重新验证文件内容之间的语义关系；不能只相信 `parse-record.json` 的声明。

## 明确禁止

- `ScriptBlock.Create`、目标脚本调用、`Invoke-Expression`；
- Vivado、hw_server、vivado_lab、生成或下载码流；
- `open_hw`、`program_hw`、硬件连接或编程；
- 进程终止、文件创建/修改/删除、清理动作；
- 未经新的 Candidate 16 精确授权进行生产远端动作。

授权计划明确冻结单次尝试、禁止重试、空 stdin，以及 15 秒 effective-config timeout 和 30 秒 parse-only remote timeout。
