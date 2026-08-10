# Synthia FPGA 技能包（synthia.fpga）

| 属性 | 内容 |
|---|---|
| 包 ID | `synthia.fpga` |
| Schema | `synthia.skill-pack.v1` |
| 版本/状态 | 0.1.0 / candidate |
| 清单 | `skill-pack.json`（由 Core 校验器 `validateSkillPack` 验收） |
| 上游 | SYNTHIA-ARC-001、SYNTHIA-ARC-002、Connector `vivado-batch-1` 能力契约 |

## 1. 定位

本技能包把 FPGA 工程需求到约束的各阶段改造为 Synthia 原生技能：技能只做需求理解、规划、候选生成、分析与交接；不持有批准、基线、发布、硬件写权；所有工具行为经 Core API → Connector Port → Adapter → Worker 链路，以 `vivado-batch-1` 强类型能力执行。包内不存在任意 Tcl 执行入口；自定义 Tcl 只走 `propose_tcl → static check → policy/human authorize → execute_approved_tcl` 边界（`execute_approved_tcl` 当前未启用），见 `rules/30-toolchain-and-tcl-boundary.md`。

## 2. 技能清单

| 技能 ID | 阶段 | 类别 | required_capabilities |
|---|---|---|---|
| `fpga-intake` | G1 | 需求入口分析 | 无 |
| `fpga-hw-manual-extraction` | G1 | 硬件事实分析 | 无 |
| `fpga-behavior-and-wave-plan` | G2 | 行为/波形规划 | 无 |
| `fpga-architecture` | G3 | 架构候选生成 | 无 |
| `fpga-register-spec` | G3 | 寄存器契约生成 | 无 |
| `fpga-rtl-build` | G4 | RTL 候选生成 | 无 |
| `fpga-tb-write` | G4 | TB 候选生成 | 无 |
| `fpga-compile-and-repair` | G4 | 编译检查（执行辅助） | `vivado-batch-1:validate_sources` |
| `fpga-sim-run` | G4 | 仿真运行（执行辅助） | `vivado-batch-1:simulate` |
| `fpga-xdc-gen` | G4 | 约束候选生成 | 无 |

产物状态只用 `candidate`（等待人类评审的内容）与 `diagnostic`（基于工具证据的分析记录）；任何候选/诊断都不是通过结论，批准由 Core 门禁与人类 ApprovalRecord 产生。

## 3. 未启用能力（post-mvp，禁止宣称可用）

实现（place & route）、码流生成、硬件下载/烧写、VCD/波形导出、携带 XDC 的综合验证、`execute_approved_tcl`。`synthesize`/`report_drc`/`report_sta`/`report_resources` 虽在 `vivado-batch-1` 能力表内，但当前技能包没有任何技能声明依赖；相关交接仅作预留。

## 4. 目录结构

```text
skills/fpga/
├── skill-pack.json            # 技能包清单（synthia.skill-pack.v1）
├── rules/                     # 包级规则（路由、门禁、布局、工具链/Tcl 边界、交接、失败路由、产物状态）
└── skills/<skill-id>/
    ├── SKILL.md               # 技能说明（用途/边界/输入/流程/产物/证据/失败处理/交接）
    ├── templates/             # 可复用工程模板
    ├── references/            # 工程参考（编码规则、反模式、模式目录）
    ├── checklists/            # 检查单（fpga-intake）
    └── tools/                 # 确定性候选校验/渲染辅助（仅 fpga-register-spec；由 Runtime 受控环境执行）
```

## 5. 规则索引

| 文件 | 主题 |
|---|---|
| `rules/00-skill-routing.md` | 技能路由、协议时序敏感判定、生成/编辑分界、候选质量闸门与重试 |
| `rules/10-intake-gate.md` | 需求入口门禁与快速放行条件 |
| `rules/20-file-context.md` | HDL/约束/仿真文件上下文路由 |
| `rules/25-workspace-layout.md` | 候选工作区布局与路径/数据域契约 |
| `rules/30-toolchain-and-tcl-boundary.md` | 强类型能力表、post-mvp 未启用项、Tcl 授权边界 |
| `rules/40-post-intake-handoff.md` | intake 后交接规则 |
| `rules/50-compile-fail-routing.md` | 编译失败条件路由 |
| `rules/60-artifact-status-and-evidence.md` | 产物状态、证据引用与用户可见收尾约定 |
