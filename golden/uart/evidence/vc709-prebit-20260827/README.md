# VC709 预码流探索性验证证据

本目录记录 2026-08-27 通过独立 mTLS Connector `vivado-66-vc709` 在真实 Vivado 2021.1（SW build 3247384，IP build 3246043）上执行的候选验证。目标 part 固定为 `xc7vx690tffg1761-2`，工具链 profile SHA-256 为 `dffba16f6b8ba5b71a7fe7c732690231b1e58e78a3b2a4824a2512aa6fc788bc`。

## 运行结果

| 作业 | Job ID | 结果 | 关键证据 |
|---|---|---|---|
| part 查询 | `vc709-query-r2-20260827` | succeeded | 精确返回 `xc7vx690tffg1761-2` |
| 源码校验 | `vc709-validate-r3-20260827` | succeeded | `validate.result.json` |
| 9600 XSim | `vc709-sim-9600-r2-20260827` | succeeded | 10/10 自检用例 PASS |
| 115200 XSim | `vc709-sim-115200-r3-20260827` | succeeded | 10/10 自检用例 PASS |
| 综合 | `vc709-synth-r3-20260827` | succeeded | 资源报告与输入清单 |
| 预码流实现 | `vc709-implement-prebit-r3-20260827` | succeeded | methodology/CDC/DRC/STA/资源、两级 DCP |

最终实现结果为：methodology 0 违规；DRC 0 违规；CDC 仅 1 条 `CDC-3 Info`，确认 UART RX 使用两级 `ASYNC_REG` 同步器；STA WNS 7.630 ns、WHS 0.093 ns、TNS/THS 均为 0；55 LUT、62 FF、0 BRAM、0 DSP。

## 预码流边界

本次 `implement` 显式使用 `stopBeforeBitstream=true`。结构化结果记录 `bitstreamGenerated=false`，运行 Tcl 不含 `write_bitstream`，证据清单及本目录均无 `.bit` 文件。

未入库的远端可重建检查点：

- `synth.dcp`：413576 字节，SHA-256 `0cd96e737b61747efa982aa29c873aa1d9c9a7bc87823c9a4db09ca78e74f2b4`
- `routed.dcp`：458114 字节，SHA-256 `09535eeeddab100b4c5b498e918e05e783be849f51c860f59e71f611abf0c790`

这些结果属于 exploratory/candidate 证据，不代表门审、批准、基线、发布、板测或交付结论。实物确认仍需板卡、仪器、已批准码流和授权角色执行。
