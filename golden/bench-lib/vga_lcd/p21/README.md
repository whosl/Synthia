# p21 VGA/LCD repaired regression

2026-09-24 从 p21 项目工作区保存的可复现候选：RTL v8、TB v5。文件内 v6/v4 注释是原始版本历史；本次修复记录在此。原有 `../golden/rtl` 15 件冻结参考未修改。

修复内容：

- TB 的 CD 位按 CTRL[9:7] 写入，保留 VEN；读改写先清掩码再置位；16/24bpp 的预期行步长随格式更新。
- 原每四次请求一次 8 拍延迟不足以耗尽 FIFO，欠载注入改为 64 拍。欠载消隐期间保持预期像素索引，恢复输出后继续逐像素比较，并保留后续完整恢复帧比对。所有原 `$fatal` 断言保留。
- RTL 字节窗口随行首清空；STAT.AVMP 修正到 bit16；VEN=0 输出回到规定空闲电平。
- 行地址乘法设置 `use_dsp = "no"`，保持原资源预算。

本地完整行为回归（需要 Icarus Verilog）：

```sh
iverilog -g2012 -s tb_top -o /tmp/p21-sim rtl/vga_golden_top.v tb/tb_top.v
vvp /tmp/p21-sim
```

预期最后输出 `PASS: VGA-DRQ-TST-002 scenarios (a)-(j) all passed` 并调用 `$finish`，模拟时间 236358496 ns。场景子项的 PASS 不等于整个测试通过。

真实 Vivado 2021.1 / xc7k70tfbv676-1 回归：

| 操作 | Job | 结果 |
|---|---|---|
| validate_sources | job-85c649d9-271f-4b77-ac8a-b1e5add51a48 | succeeded |
| simulate | job-c6bbcb06-d45a-4d57-9c7d-8e0eedf3d622 | 全部场景结束并 `$finish`；VCD 已生成 |
| synthesize | job-7a9eebf1-7ed8-4c64-9b55-6a71b97ebf9c | succeeded |
| implement | job-6c8566c7-7a39-4b1c-8cf2-7a92321081c0 | succeeded，stop_before_bitstream=true |

实现后：WNS +0.957 ns，TNS 0，WHS +0.063 ns，LUT 961，FF 543，BRAM 0，DSP 0。仿真与实现源代码哈希相同。

边界：这是 clock-only 约束下的探索验证，不包含板级 IO 时序、bitstream 或上板验收。保留原 D1 的 525 行解释（2/29/480/14）；原需求同时写出的 2/29/480/13 与 525 的算术矛盾未擅自改写。VCD 为有大小限制的采集片段，不能代替完整仿真日志。

历史更正：2026-09-11 的 job-4c4c5b9a… 只有中间场景 PASS，100ms 截止前未完成测试台，旧“四步全绿”不构成完整仿真通过。9 月 15 日的 x_probe_dut 运行是其他诊断用例，保留原始历史供追溯；本次完整工程运行成为最新状态。
