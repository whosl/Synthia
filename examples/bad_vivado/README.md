# Bad Vivado 测试工程

故意包含典型 EDA 错误的示例工程，用于验证 Agent 诊断、ProblemCollector、KB 候选生成等能力。

| 目录 | 错误类型 | 预期 Vivado 现象 |
|------|----------|------------------|
| `01_syntax_error` | Verilog 语法错误 | `ERROR: [Synth 8-2716]` 等语法/解析失败 |
| `02_wrong_top` | `eda.yaml` 的 top 与 RTL 模块名不一致 | `ERROR: [Synth 8-439]` top 模块找不到 |
| `03_missing_source` | manifest 引用不存在的 RTL 文件 | 读源文件失败 / 模块缺失 |
| `04_bad_constraint` | XDC 约束了不存在的端口 | `CRITICAL WARNING` / DRC 相关 |
| `05_width_mismatch` | 位宽不匹配赋值 | `ERROR: [Synth 8-524]` 等 |
| `06_mock_synth_fail` | RTL 正常；用于 **Mock** 合成失败场景 | 见下方 `test.mock_fail` |

## 用法

在 Terminal 里让 Agent 对某个工程跑综合，例如：

```text
请对 examples/bad_vivado/01_syntax_error/eda.yaml 运行 Vivado 综合并分析错误
```

manifest 路径（绝对或相对仓库根）：

- `examples/bad_vivado/01_syntax_error/eda.yaml`
- `examples/bad_vivado/02_wrong_top/eda.yaml`
- …

## 无 Vivado / Mock 模式

若本机没有 `vivado`，Runner 会进入 **MOCK** 模式，默认合成**成功**，看不到真实 RTL 错误。

对 `06_mock_synth_fail` 或在任意 `eda.yaml` 里设置：

```yaml
test:
  mock_fail: synth_8_439   # 或 timing_violation / place_30_574 / drc_violation / route_35
```

也可设置环境变量：`export EDAGENT_MOCK_FAIL=synth_8_439`

可选场景（见 `vivado_runner.MOCK_FAILURE_SCENARIOS`）：

- `synth_8_439` — 模块找不到（合成失败）
- `timing_violation` — 时序违例（合成成功但 WNS 负）
- `place_30_574` — 布局失败
- `drc_violation` — DRC 不干净
- `route_35` — 布线失败

## 预置失败日志

每个工程下的 `logs/expected_synth.log` 为**典型错误日志片段**，可供 `parse_vivado_log_tool` 离线测试，无需跑 Vivado。
