# VC709 corrected-constraint direct-run evidence

This directory is the current exploratory/candidate Vivado evidence for the
GOLDEN-UART VC709 target after correcting SYSCLK to the official
`DIFF_SSTL15` I/O standard. It was produced on 2026-08-28 through the newly
frozen Mac -> 66 direct transport. No 140 jump-host authentication or evidence
is used by this package.

## Bound target and input

- Connector: `vivado-66-vc709`
- Tool: Vivado 2021.1 build 3247384 / IP build 3246043
- Toolchain profile SHA-256: `dffba16f6b8ba5b71a7fe7c732690231b1e58e78a3b2a4824a2512aa6fc788bc`
- Part: `xc7vx690tffg1761-2`
- Top: `uart_board_top`
- Corrected XDC SHA-256: `69ff446877b535cf1301db74e1a699dc1fca6d71e3603776b5fe141ea3dd051e`
- Transport target: `admin@100.96.223.49` (`DESKTOP-DVFFB09`)

Every operation has a new direct-run job identity except the implementation
job, which did not exist on 66 before the direct submission and was first
created through this transport:

- `vc709-query-direct-diff-sstl15-20260828`
- `vc709-validate-direct-diff-sstl15-20260828`
- `vc709-sim-9600-direct-20260828`
- `vc709-sim-115200-direct-20260828`
- `vc709-synth-direct-diff-sstl15-20260828`
- `vc709-implement-prebit-diff-sstl15-20260828`

## Result

- Exact part query: succeeded.
- Source validation: succeeded.
- 9600 and 115200 XSim: 10/10 requirement cases passed at each rate.
- Synthesis and routed pre-bitstream implementation: succeeded.
- Methodology and DRC: 0 violations.
- CDC: one `CDC-3 Info`, the intended depth-2 `ASYNC_REG` UART RX synchronizer.
- STA: WNS 7.630 ns, TNS 0; WHS 0.093 ns, THS 0.
- Resources: 55 LUT, 62 FF, 0 BRAM, 0 DSP.
- Bitstream boundary: `stopBeforeBitstream=true`, no `write_bitstream` in the
  implementation Tcl, `bitstreamGenerated=false`, and no `.bit` file.

This is exploratory/candidate evidence only. It is not a formal run, approved
baseline, board confirmation, GJB compliance conclusion, or release approval.
The previous `vc709-prebit-20260827` package remains historical and is not an
input to this evidence package.
