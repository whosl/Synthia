# usbhostslave — 基准卡

| 项 | 值 |
|---|---|
| 梯队 | T3 |
| 来源 | https://github.com/freecores/usbhostslave |
| 许可证 | OpenCores（LGPL 类） |
| 参考顶层 | usbHostSlave |
| 需求来源 | USB 1.1 规范（官方免费）+ bench 用例 |

**出题要点**：82.7k 行；主/从双模式；建议裁剪出 slave-only 子题

**入库形态**：本目录为参考实现完整树（.git 已剥）。制作模板时：需求文档独立成篇（不引用本目录任何结构信息）；参考 RTL 摘出可综合核心（剥板级封装）登记为人工基线。
