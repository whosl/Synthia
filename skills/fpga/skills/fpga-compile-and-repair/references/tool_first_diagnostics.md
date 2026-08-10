# Tool-First Diagnostics

## Evidence To Preserve

- Observed Worker command（evidence only：引用 Core 登记的 ToolRun 记录字段；仅作历史执行证据，**不可复制执行、不可由 Skill/UI 触发**）
- working directory（Worker 执行上下文快照，仅证据用途）
- tool path and version if available
- stdout/stderr（引用 EvidenceManifest 条目 SHA-256）
- file list and include dirs
- macros/defines

以上证据必须能回指 Core 登记的 ToolRun/EvidenceManifest；不记录、不复述任何可直接执行的 shell 指令。

## Classification

| Class | Examples | Preferred action |
| --- | --- | --- |
| Syntax | missing semicolon, malformed port | minimal local edit |
| Name binding | undeclared signal, missing package | read nearby code and add/import correct declaration |
| Interface | port mismatch, width mismatch | compare contract and instantiation |
| Elaboration | parameter issue, generate issue | inspect parameter values and conditional branches |
| Simulation-only | delay/event in RTL path | move to TB or guard with synthesis directive if appropriate |
| Environment | missing include/IP/library | fix command or ask for dependency |
