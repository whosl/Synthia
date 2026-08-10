# 寄存器 TB 访问计划

| Test | Sequence | Expected result |
| --- | --- | --- |
| Reset values | Reset, read all registers | All fields equal documented reset |
| RW readback | Write pattern, read back | Writable bits update, reserved bits stable |
| RO protection | Write RO field | Value unchanged or bus error per policy |
| W1C | Set by HW, write 1 | Field clears according to priority |
| Illegal address | Read/write unmapped offset | Default response/error per policy |
| Byte strobe | Partial writes | Only selected byte lanes update |
