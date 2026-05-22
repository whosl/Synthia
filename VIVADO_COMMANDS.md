# Vivado Command Support Matrix

> 本文档是 `SPEC.md` 的配套维护文档，用于按 EdAgent-Vivado 的 Vivado Runtime Adapter 分层列出长期需要支持的 Vivado 命令能力。实现 Vivado 工具、Tcl 模板、Agent tool、CLI、API、监控解析时，应同步参考本文档。

## 1. 分层原则

Vivado 命令支持分为 6 层：

| Level | 名称 | 目标 |
|---|---|---|
| L0 | Runtime / Environment | Vivado 环境、版本、license、路径、工作目录、进程管理 |
| L1 | Raw Tcl / Tcl 基础命令 | 执行 Tcl、查询状态、变量、文件、消息等基础能力 |
| L2 | Design I/O | 读入 RTL/XDC/IP/网表/Checkpoint，写出 DCP/报告/bitstream |
| L3 | Core Flow | synth / opt / place / route / bitstream / sim 等核心流程 |
| L4 | Reports / Analysis | timing、utilization、power、DRC、methodology、clock、CDC 等报告 |
| L5 | Project / IP / Advanced | project mode、IP、BD、incremental、debug、constraints、QoR 优化 |

所有命令最终必须通过 `Vivado Runtime Adapter` 执行，并纳入：

- `TclPolicy`
- approval
- artifact 保存
- SSE log streaming
- problem collection
- monitor run/toolcall
- context summary

---

## 2. 支持状态标记

| 标记 | 含义 |
|---|---|
| Required | 长期必须支持 |
| Template | 应提供安全模板，Agent 填参数 |
| RawAllowed | 可通过 raw Tcl 执行，但需 policy/approval |
| Dangerous | 默认需要审批或禁止 |
| Query | 可作为轻量查询命令 |
| Parse | 输出应被 parser/monitor 解析 |
| Artifact | 输出必须保存 artifact |

---

## 3. L0 Runtime / Environment

### 3.1 Target / Environment

| 命令/能力 | 支持级别 | 备注 |
|---|---:|---|
| `vivado -version` | Required, Query | health check |
| `vivado -mode batch -source <script>` | Required | batch 主入口 |
| `vivado -mode tcl` | Required | long-lived Tcl session |
| `source <settings64.sh>` | Required | remote/local 环境初始化 |
| SSH connectivity check | Required | remote target |
| Vivado path existence check | Required | `/home/xilinx/.../vivado` |
| settings path existence check | Required | `settings64.sh` |
| remote workdir writable check | Required | `/tmp/edagent_remote` |
| license availability check | Required | 尽力检测 |
| process PID tracking | Required | stop/kill |
| stdout/stderr/log capture | Required, Artifact | SSE + artifact |

### 3.2 当前默认 Remote Target

```text
host: root@192.168.31.150
ssh_key: E:/dev/id_192.168.31.150
vivado_path: /home/xilinx/vivado/Vivado/2022.1/bin/vivado
settings_path: /home/xilinx/vivado/Vivado/2022.1/settings64.sh
remote_work_root: /tmp/edagent_remote
```

---

## 4. L1 Raw Tcl / 基础 Tcl 命令

### 4.1 Tcl Session / 基础查询

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `help` | Query |
| `version` | Query |
| `pwd` | Query |
| `cd` | RawAllowed | 需限制到工作目录 |
| `set` | RawAllowed |
| `puts` | RawAllowed |
| `get_param` | Query |
| `set_param` | RawAllowed | 重要参数应审批 |
| `current_project` | Query |
| `current_design` | Query |
| `current_instance` | Query |
| `list_property` | Query |
| `get_property` | Query |
| `set_property` | RawAllowed, Template | 对设计对象/约束常用 |
| `reset_property` | RawAllowed |

### 4.2 Tcl 文件/系统命令安全分级

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `glob` | RawAllowed | 限制工作目录 |
| `file exists` | Query |
| `file normalize` | Query |
| `file mkdir` | RawAllowed | 限制工作目录 |
| `open` | RawAllowed | 禁止 pipe form `open "|..."` |
| `read` | RawAllowed |
| `close` | RawAllowed |
| `file copy` | RawAllowed | 限制工作目录 |
| `file delete` | Dangerous | 默认审批 |
| `file rename` | Dangerous | 默认审批 |
| `exec` | Dangerous | 默认禁止或审批 |
| shell escape / pipe | Dangerous | 默认禁止 |

---

## 5. L2 Design I/O

### 5.1 Read Commands

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `read_verilog` | Required, Template |
| `read_vhdl` | Required, Template |
| `read_systemverilog` | Required, Template | 如版本支持 |
| `read_xdc` | Required, Template |
| `read_edif` | Required |
| `read_edifact` | RawAllowed |
| `read_checkpoint` | Required, Template |
| `read_ip` | Required |
| `read_bd` | Required |
| `read_mem` | RawAllowed |
| `read_saif` | RawAllowed | power analysis |
| `read_sdf` | RawAllowed | sim/timing |

### 5.2 Write Commands

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `write_checkpoint` | Required, Artifact |
| `write_bitstream` | Required, Template, Artifact |
| `write_verilog` | Required, Artifact |
| `write_vhdl` | RawAllowed, Artifact |
| `write_xdc` | Required, Artifact |
| `write_sdf` | RawAllowed, Artifact |
| `write_saif` | RawAllowed, Artifact |
| `write_edif` | RawAllowed, Artifact |
| `write_cfgmem` | RawAllowed, Artifact |
| `write_debug_probes` | RawAllowed, Artifact |
| `write_hw_platform` | RawAllowed, Artifact |

---

## 6. L3 Core Flow

### 6.1 Non-Project Flow

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `synth_design` | Required, Template, Parse |
| `opt_design` | Required, Template |
| `power_opt_design` | Template |
| `place_design` | Required, Template |
| `phys_opt_design` | Template |
| `route_design` | Required, Template |
| `write_bitstream` | Required, Template, Artifact |

### 6.2 Project Flow

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `create_project` | Required, Template |
| `open_project` | Required, Template |
| `close_project` | Required |
| `save_project_as` | RawAllowed |
| `add_files` | Required, Template |
| `remove_files` | RawAllowed |
| `import_files` | Required |
| `update_compile_order` | Required |
| `set_property top` | Required, Template |
| `launch_runs` | Required, Template |
| `wait_on_run` | Required |
| `reset_run` | RawAllowed, Dangerous | 容易删除已有结果，需审批 |
| `open_run` | Required |
| `current_run` | Query |

### 6.3 Simulation

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `launch_simulation` | Required, Template |
| `run all` | Required |
| `restart` | RawAllowed |
| `close_sim` | RawAllowed |
| `xsim` related Tcl | RawAllowed |
| `add_wave` | RawAllowed |
| `log_wave` | RawAllowed |

---

## 7. L4 Reports / Analysis

### 7.1 Timing

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `report_timing_summary` | Required, Template, Parse, Artifact |
| `report_timing` | Required, Template, Parse, Artifact |
| `report_clock_interaction` | Required, Parse, Artifact |
| `report_clocks` | Required, Parse |
| `report_exceptions` | Required, Parse |
| `report_clock_networks` | Required, Parse |
| `check_timing` | Required, Parse |
| `report_datasheet` | RawAllowed, Artifact |

### 7.2 Utilization / Power / QoR

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `report_utilization` | Required, Parse, Artifact |
| `report_power` | Required, Parse, Artifact |
| `report_qor_summary` | Required, Parse, Artifact |
| `report_qor_suggestions` | Required, Parse, Artifact |
| `report_design_analysis` | Required, Parse, Artifact |
| `report_high_fanout_nets` | Template, Parse |
| `report_control_sets` | Template, Parse |

### 7.3 DRC / Methodology / Messages

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `report_drc` | Required, Parse, Artifact |
| `report_methodology` | Required, Parse, Artifact |
| `report_cdc` | Required, Parse, Artifact |
| `report_io` | Required, Parse |
| `report_messages` | Required, Parse |
| `get_messages` | Query, Parse |
| `reset_msg_config` | RawAllowed |
| `set_msg_config` | RawAllowed, Template |

### 7.4 Object Queries

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `get_ports` | Query |
| `get_pins` | Query |
| `get_cells` | Query |
| `get_nets` | Query |
| `get_clocks` | Query |
| `get_files` | Query |
| `get_runs` | Query |
| `get_projects` | Query |
| `get_ips` | Query |
| `get_bd_cells` | Query |
| `all_clocks` | Query |
| `all_inputs` | Query |
| `all_outputs` | Query |
| `all_registers` | Query |
| `filter` | Query |

---

## 8. L5 Project / IP / Advanced

### 8.1 Constraints

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `create_clock` | Required, Template |
| `create_generated_clock` | Required, Template |
| `set_clock_groups` | Required, Template |
| `set_false_path` | Required, Template |
| `set_multicycle_path` | Required, Template |
| `set_input_delay` | Required, Template |
| `set_output_delay` | Required, Template |
| `set_max_delay` | Required, Template |
| `set_min_delay` | Required, Template |
| `set_case_analysis` | Template |
| `set_load` | RawAllowed |
| `set_driving_cell` | RawAllowed |
| `set_property PACKAGE_PIN` | Required, Template |
| `set_property IOSTANDARD` | Required, Template |

### 8.2 IP

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `create_ip` | Required, Template |
| `set_property -dict ... [get_ips]` | Required, Template |
| `generate_target` | Required, Template |
| `synth_ip` | Required |
| `export_ip_user_files` | Template |
| `upgrade_ip` | RawAllowed |
| `report_ip_status` | Required, Parse |
| `get_ips` | Query |

### 8.3 Block Design

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `create_bd_design` | Required |
| `open_bd_design` | Required |
| `save_bd_design` | Required |
| `create_bd_cell` | Template |
| `connect_bd_net` | Template |
| `connect_bd_intf_net` | Template |
| `assign_bd_address` | Template |
| `validate_bd_design` | Required, Parse |
| `generate_target all [get_files *.bd]` | Required |
| `make_wrapper` | Required |

### 8.4 Incremental / Checkpoint / QoR

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `read_checkpoint -incremental` | Template |
| `write_checkpoint -force` | Required, Artifact |
| `report_incremental_reuse` | Template, Parse |
| `report_qor_suggestions` | Required, Parse |
| `write_qor_suggestions` | Template, Artifact |
| `read_qor_suggestions` | Template |

### 8.5 Debug / ILA

| 命令 | 支持级别 | 备注 |
|---|---:|---|
| `create_debug_core` | RawAllowed, Template |
| `connect_debug_port` | RawAllowed, Template |
| `set_property C_DATA_DEPTH` | RawAllowed |
| `write_debug_probes` | Artifact |
| `open_hw_manager` | Dangerous | 硬件连接需审批 |
| `connect_hw_server` | Dangerous |
| `open_hw_target` | Dangerous |
| `program_hw_devices` | Dangerous | 默认审批 |

---

## 9. Tcl Policy 分级

### 9.1 默认允许

默认允许：

- 纯查询命令。
- 报告生成命令。
- read/write 到受控 workspace。
- 模板化 flow。

### 9.2 需要审批

默认需要 approval：

- raw Tcl。
- `exec`。
- `file delete`。
- `file rename`。
- `reset_run`。
- `program_hw_devices`。
- 写入 workspace 外部路径。
- 覆盖已有 project/checkpoint/bitstream。
- hardware manager 相关命令。

### 9.3 默认禁止或强审批

默认禁止或强审批：

- shell pipe：`open "|..."`
- `rm -rf`
- 修改系统路径。
- 操作 `/`, `/home`, `/root`, Windows 系统目录等非 workspace 路径。
- 网络/硬件烧录命令，除非用户明确允许。

---

## 10. Agent Tool 映射

| Agent Tool | 覆盖命令层 |
|---|---|
| `vivado_run_tcl` | L1-L5 raw Tcl |
| `vivado_run_script` | L1-L5 script |
| `vivado_run_flow` | L3-L5 template flow |
| `vivado_query` | L1/L4 query |
| `vivado_open_project` | L3 project |
| `vivado_create_project` | L3 project |
| `vivado_health` | L0 |
| `vivado_list_targets` | L0 |

---

## 11. Flow Templates

### 11.1 Required Templates

必须维护模板：

- `non_project_synth.tcl`
- `non_project_impl.tcl`
- `project_synth.tcl`
- `project_impl.tcl`
- `simulation.tcl`
- `bitstream.tcl`
- `report_timing.tcl`
- `report_utilization.tcl`
- `report_power.tcl`
- `report_drc.tcl`
- `report_methodology.tcl`
- `ip_generate.tcl`
- `bd_validate_generate.tcl`

### 11.2 Template 输入

模板参数至少包括：

- project name
- top module
- part
- rtl files
- xdc files
- include dirs
- defines
- Verilog/SystemVerilog/VHDL mode
- run directory
- report directory
- strategy/directive
- retiming
- flatten hierarchy
- max threads

---

## 12. Parser / Monitor 要求

以下输出必须解析：

| 输出 | Parser 目标 |
|---|---|
| `vivado.log` | error/warning/critical warning/message ID |
| `report_timing_summary` | WNS/TNS/WHS/THS、violations |
| `report_timing` | worst paths、slack、clock pair |
| `report_utilization` | LUT/FF/BRAM/DSP |
| `report_power` | total/static/dynamic power |
| `report_drc` | DRC violations |
| `report_methodology` | methodology violations |
| `report_qor_summary` | QoR metrics |
| `report_qor_suggestions` | suggestions |
| `report_ip_status` | IP locked/outdated/errors |
| `validate_bd_design` | BD issues |

所有 parser 结果必须进入：

- `problems`
- `runs`
- `tool_calls`
- `artifacts`
- `events`
- session context summary
- KB candidate workflow if failed

---

## 13. CLI 覆盖

长期 CLI：

```bash
edagent vivado health
edagent vivado targets
edagent vivado tcl
edagent vivado script
edagent vivado session
edagent run-synth
edagent run-impl
edagent run-sim
```

所有 CLI 命令必须使用同一个 Vivado Runtime Adapter。

---

## 14. 维护规则

新增 Vivado 命令支持时，必须同步更新：

1. 本文档命令矩阵。
2. TclPolicy allowlist/denylist。
3. Agent tool schema。
4. API schema。
5. Parser/monitor requirements。
6. React UI 展示需求。
7. 测试用例。

---

## 15. 实现优先级建议

### P0

- remote health
- batch script
- `read_verilog`
- `read_vhdl`
- `read_xdc`
- `synth_design`
- `report_timing_summary`
- `report_utilization`
- `report_drc`
- log parser
- stop/kill

### P1

- project mode
- `launch_runs`
- `wait_on_run`
- `opt_design`
- `place_design`
- `route_design`
- `write_bitstream`
- report power/methodology/qor
- FileSync hash incremental
- PathMapper

### P2

- long-lived Tcl session
- IP generation
- BD generation
- simulation
- incremental checkpoint
- advanced constraints

### P3

- hardware manager
- program device
- debug cores
- advanced QoR automation
- multi-target scheduling
