# 时钟、复位与 CDC 方案

## Clock Domains

| Domain | Clock | Frequency | Owner modules | Notes |
| --- | --- | --- | --- | --- |
| sys | `clk_sys` | TBD | | |

## Reset Domains

| Reset | Polarity | Assertion | Release | Destination clocks |
| --- | --- | --- | --- | --- |
| `rstn_sys` | active low | async | sync | `clk_sys` |

## CDC Inventory

| ID | Source | Destination | Signals | Pattern | Verification |
| --- | --- | --- | --- | --- | --- |
| CDC-001 | | | | | |

## Open Questions

-
