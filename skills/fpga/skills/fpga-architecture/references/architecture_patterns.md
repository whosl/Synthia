# FPGA Architecture Patterns

## Descriptor or DMA Blocks

Split descriptor fetch, stream ingress/egress, completion writeback, interrupt/status, and error recovery. Keep descriptor format and queue ownership in register spec.

## Memory Subsystems

Separate address permission, burst shaping, arbitration/QoS, DDR user-interface wrapper, performance counters, and snapshot register interface. Treat vendor DDR PHY/controller as a black box.

## Source-Synchronous Capture

Split IO primitive wrapper, sampling/deserialization, bit-slip training, channel alignment, frame parser, packetizer, and system-side FIFO. Keep IO timing constraints in a separate note.

## Video Pipelines

Split input unpack, format conversion, crop/scale/filter, OSD, timing generator, output formatter, and frame-sync control. Record whether the design is pure streaming or frame-buffered.

## DSP Pipelines

Split input adapter, coefficient/config bank, compute pipeline, output adapter, statistics, and reference-model alignment. Document fixed latency and valid shift registers.

## Safety/Control Peripherals

Split event capture, first-error latch, counters, masks, interrupt generation, safe-action controller, and test/error injection path. Keep production disable rules explicit.
