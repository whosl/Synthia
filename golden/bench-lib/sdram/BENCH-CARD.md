# sdram — 基准卡

| 项 | 值 |
|---|---|
| 梯队 | T4（再验证轮） |
| 来源 | https://github.com/freecores/sdram |
| 许可证 | OpenCores（LGPL 类） |
| 参考顶层 | sdram（rtl/，4 文件：hostcont/sdramcnt/micro） |
| 需求来源 | SDRAM 器件公开数据手册（Micron TN-46/TN-47 类：命令真值表/初始化序列/刷新规格）——标准本身（JEDEC EDSJ79）付费，按 nesdev 先例以公开器件手册为权威 |

**出题要点**：~2k 行、零原语；**存储控制器类——样例库新类型**（初始化状态机/自动刷新/预充电仲裁/时序参数化）；需求书须附命令真值表与初始化时序常量附录
**入库形态**：参考实现完整树（.git 已剥）
