# FPGA 文件上下文规则

| 属性 | 内容 |
|---|---|
| 规则编号 | SYNTHIA-FPGA-RULE-20 |
| 版本/状态 | v0.1 / candidate |
| 适用对象 | 触达 HDL/约束/仿真相关文件（`**/*.{v,vh,sv}`、`**/*.xdc`、`**/tb/**`、`**/sim/**`）的任务 |

当任务上下文已触达 HDL/约束/仿真相关文件时，按以下规则增强执行稳定性：

1. 请求涉及修改 RTL：优先 `fpga-rtl-build`；编译检查失败再转 `fpga-compile-and-repair`。
2. 请求涉及编译/语法问题：优先 `fpga-compile-and-repair`，以 Connector 返回的工具证据为准。
3. 请求只涉及生成 TB 源码：`fpga-tb-write`。
4. 任何结论必须可回指到候选工作区文件路径、EvidenceManifest 条目（含 SHA-256）或 ToolRun 记录；缺少证据就明确指出需要的输入，而不是臆测。
5. 文件引用一律使用候选工作区相对路径；证据引用使用 Core 登记的 Artifact/Evidence ID，不使用运行节点本地绝对路径。
