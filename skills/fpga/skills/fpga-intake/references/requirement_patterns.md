# Requirement Patterns From Supplied Materials

The provided FPGA cases and 10 R&D requirement samples share recurring acceptance patterns. Use these as prompts, not as facts to invent.

## Common Acceptance Dimensions

| Dimension | Typical questions |
| --- | --- |
| Functional behavior | What must be produced for each transaction, frame, sample, descriptor, or register access? |
| Throughput/rate | Pixel clock, sample rate, packet rate, bus width, burst length, or frame rate. |
| Latency | Fixed pipeline latency, maximum interrupt latency, timestamp jitter, frame-boundary update point. |
| Error handling | Timeout, overflow, malformed packet, protocol violation, ECC error, lost lock, backpressure. |
| Observability | Status registers, counters, first-error latch, state-machine state, timestamp, debug header. |
| Verification | Self-checking TB, golden model, VCD/FST checkpoints (external pre-existing evidence only, registered via Core before use as input; the platform does not generate waveforms), packet capture, board-level report. |
| Recoverability | Soft reset, channel isolation, auto retry, link restart, safe pattern, safe output state. |

## Patterns In The 10 R&D Samples

- PCIe DMA: descriptor contract, doorbell, completion writeback, EOP alignment, channel isolation.
- DDR4 subsystem: address partitions, arbitration/QoS, 4 KB burst split, performance counters, snapshot reads.
- LVDS capture: source-synchronous sampling, bit slip, training, frame packing, backpressure, IO timing notes.
- GigE UDP offload: MAC/IP/port config, ARP cache, payload length policy, UDP Rx filtering, counters.
- MIPI-to-HDMI video: frame/line events, crop/scale/color/OSD, safe pattern, double buffering, CDC.
- JESD204B Rx: CGS/ILAS/DATA states, SYSREF/LMFC alignment, lane monitoring, retry policy.
- ADC DSP: stream backpressure, FIR coefficient loading, safe coefficient switch, decimation phase, saturation counters.
- PTP timestamping: local time counter, set/step/slew adjustment, Rx/Tx timestamp FIFO, jitter acceptance.
- Motor control: PWM shadow update, dead time, encoder filtering, fault latch, safe shutdown.
- Safety/ECC/WDT: SECDED, error injection, WDT kick/timeout actions, event mask, first-error record.

## Patterns In The 50 Prompt Cases

- Video/image: line buffers, edge pixels, sync alignment, frame-safe updates, OSD coordinate checks.
- Interface/protocol: UART/SPI/I2C/AXI/APB/RMII/I2S/CAN timing and protocol model TBs.
- DSP/SDR: fixed-point growth, saturation/rounding, reference models, pipeline delay alignment.
- SoC/peripherals: memory-mapped registers, interrupts, AXI/APB bridges, timers, DMA, trace FIFO.
- Industrial/control: debounce, motor PWM, encoder ABZ, PPS timestamping, frame packing, overflow behavior.
