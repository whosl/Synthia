/**
 * 布局预览 demo 共享静态数据（UART 项目，纯占位，无 API）。
 * 四个布局方案（A 驾驶舱 / B 对话主轴 / C 阶段导航 / D 分组滚动）共用。
 */

export interface DemoGate { id: string; name: string; state: "done" | "current" | "todo" }
export interface DemoFeedItem { kind: "user" | "text" | "doc" | "tool" | "gate" | "note"; text: string; meta?: string; status?: "ok" | "fail" | "run" | "wait" }
export interface DemoArtifact { type: string; doc: string; version: number; state: string; time: string; content: string }
export interface DemoRun { op: string; state: "succeeded" | "failed" | "running"; duration: string; note?: string }

export const demoProject = {
  name: "UART 收发器",
  part: "xc7k70tfbv676-1",
  milestones: [
    { id: "B0", name: "需求里程碑", active: true },
    { id: "B1", name: "设计里程碑", active: true },
    { id: "B2", name: "RTL里程碑", active: false },
    { id: "B3", name: "实现里程碑", active: false },
  ],
  gates: [
    { id: "G1", name: "需求审查", state: "done" },
    { id: "G2", name: "行为审查", state: "done" },
    { id: "G3", name: "设计审查", state: "current" },
    { id: "G4", name: "RTL审查", state: "todo" },
  ] as DemoGate[],
  awaitingGate: "G3 设计审查",
};

export const demoStages = [
  { id: "intake", name: "需求解析", state: "done" },
  { id: "G1", name: "需求审查", state: "done", gate: true },
  { id: "behavior_wave", name: "行为与波形设计", state: "done" },
  { id: "G2", name: "行为审查", state: "done", gate: true },
  { id: "architecture", name: "架构设计", state: "done" },
  { id: "register_spec", name: "寄存器规格", state: "done" },
  { id: "G3", name: "设计审查", state: "current", gate: true },
  { id: "rtl", name: "RTL 实现", state: "todo" },
  { id: "validate", name: "编译检查", state: "todo" },
  { id: "tb", name: "测试平台", state: "todo" },
  { id: "simulate", name: "仿真", state: "todo" },
  { id: "xdc", name: "约束生成", state: "todo" },
  { id: "synthesize", name: "综合", state: "todo" },
  { id: "implement", name: "实现与码流", state: "todo" },
  { id: "G4", name: "RTL审查", state: "todo", gate: true },
];

export const demoFeed: DemoFeedItem[] = [
  { kind: "user", text: "设计一个 UART 收发器：9600 波特率、8N1、100MHz 时钟，完成从需求到码流的 GJB 全流程" },
  { kind: "text", text: "我已读完任务，整理出需求梳理摘要，已登记为候选制品并提交需求审查。" },
  { kind: "doc", text: "《研制（开发）技术要求》", meta: "候选 v1", status: "ok" },
  { kind: "gate", text: "需求审查评估通过", meta: "12s", status: "ok" },
  { kind: "text", text: "行为与波形设计已完成，行为规格含规则编号与首失配比对策略。" },
  { kind: "doc", text: "《PLDS 需求规格说明》", meta: "候选 v1", status: "ok" },
  { kind: "tool", text: "仿真", meta: "8s", status: "fail" },
  { kind: "text", text: "仿真发现数据位时序错位，正在读取仿真器输出定位问题（第 1 次修复）。" },
  { kind: "tool", text: "仿真（修复后）", meta: "9s", status: "ok" },
  { kind: "doc", text: "《PLDS 结构设计说明》", meta: "候选 v1", status: "ok" },
  { kind: "doc", text: "《PLDS 详细设计说明》", meta: "候选 v1", status: "ok" },
  { kind: "tool", text: "综合", meta: "45s", status: "run" },
  { kind: "note", text: "等待 G3 设计审查人工批准", status: "wait" },
];

export const demoArtifacts: DemoArtifact[] = [
  { type: "需求", doc: "《研制（开发）技术要求》", version: 1, state: "候选", time: "08-14 10:02", content: "功能：UART 全双工收发，9600 8N1；性能：位时间误差 ≤0.5%；接口：clk/rst_n/tx/rx；环境：Vivado 2021.1 / xc7k70t；测试：环回 4 字节自检。" },
  { type: "需求", doc: "《PLDS 需求规格说明》", version: 1, state: "候选", time: "08-14 10:41", content: "UART-SRS-FUN-001：上电复位后 tx 保持空闲高电平；FUN-002：tx_start 单拍脉冲触发一帧发送；TIM-001：位周期 10417±1 时钟；CKR-001：单一 100MHz 时钟域。" },
  { type: "设计", doc: "《PLDS 结构设计说明》", version: 1, state: "候选", time: "08-14 11:20", content: "设计单元：uart_top（顶层）/ baud_gen（波特率节拍）/ uart_tx（发送状态机）/ uart_rx（接收状态机）；单时钟域，rxd 单级同步。" },
  { type: "设计", doc: "《PLDS 详细设计说明》", version: 2, state: "候选", time: "08-14 11:52", content: "CLKS_PER_BIT=10417（误差 -0.003%）；状态机 IDLE→START→DATA→STOP；中点采样（半位 5208）；异常：帧错误置 frame_err 单拍。" },
  { type: "实现", doc: "《PLDS 源代码（RTL）》", version: 2, state: "候选", time: "08-14 13:15", content: "module uart_top / baud_gen / uart_tx / uart_rx（Verilog-2001，可综合）" },
];

export const demoRuns: DemoRun[] = [
  { op: "编译检查", state: "succeeded", duration: "6s" },
  { op: "仿真", state: "failed", duration: "8s", note: "数据位时序错位（见 worker-result.json）" },
  { op: "仿真（修复后）", state: "succeeded", duration: "9s" },
  { op: "综合", state: "running", duration: "45s…" },
];
