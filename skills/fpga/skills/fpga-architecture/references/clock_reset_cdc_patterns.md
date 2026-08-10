# Clock, Reset, and CDC Patterns

## Clock Domains

Document every domain with:

- source clock name and nominal frequency
- reset signal, polarity, assertion/release rule
- blocks and signals owned by the domain
- crossing points to other domains

## Reset Rules

- Prefer async assert / sync deassert when board or IP reset can be asynchronous.
- Use one reset synchronizer per destination clock domain.
- Do not feed an unsynchronized reset into sequential logic in a different domain.
- For soft reset, define which state is cleared, which counters latch, and whether FIFOs are flushed.

## CDC Selection

| Crossing type | Preferred pattern | Notes |
| --- | --- | --- |
| Single-bit level status | 2FF synchronizer | Destination samples level; source must hold long enough. |
| Single-cycle pulse | toggle sync or pulse stretcher | Do not directly 2FF a one-cycle pulse unless pulse width is guaranteed. |
| Multi-bit configuration | handshake or shadow capture | Ensure all bits are sampled coherently. |
| Data stream | async FIFO | Include packet sideband such as `tlast` in FIFO payload. |
| Counter snapshot | Gray counter or freeze/snapshot | Avoid reading changing multi-bit binary counters across domains. |
| Reset crossing | reset synchronizer | Define flush/recovery sequence. |

## CDC Evidence

For each crossing, capture in the architecture notes:

- source and destination domains
- signal group
- chosen CDC primitive
- metastability containment
- data coherency rule
- TB or formal check idea
