# RTL 生成交接文档

## Read First

- `doc/rtl/notes.md`
- RTL sources under `rtl/`

## Optional Next Stages

- Generate TB source: optional, use when the user asks for TestBench or verification code.
- Compile check: optional, use when the user asks to check syntax or compile.
- Simulation run: optional, use when TB exists and the user explicitly asks to run simulation.
- VCD waveform: not available — VCD/波形导出不在当前 `simulate` 强类型契约内，post-mvp 未启用；不得作为下一步建议或承诺波形产物。
- XDC generation: optional, use when the user asks for board constraints and `doc/hw/extracted_facts.json` 硬件事实已确认（partial/needs_input 时 fpga-xdc-gen 只产出缺失文档，不生成主约束）。

## Inputs To Pass

- `doc/rtl/notes.md`
- RTL file list and top module name (if known)
- Any prior ToolRun evidence references (Core 登记的 EvidenceManifest 条目哈希；不含可执行命令)

## Open Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |

## Stop Conditions For Next Skill

- If an interface/contract mismatch is found, stop and route back to `fpga-architecture` / `fpga-register-spec` / `fpga-behavior-and-wave-plan` as appropriate.
