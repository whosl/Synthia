/**
 * 共享契约：自由 Agent 模式（spec 001-agent-freedom）。
 *
 * 这是 subagent 团队所有 slice 的**唯一集成面**。任何 slice 不得另造同名类型；
 * 集成只认本文件导出的接口。实现细节（哪个文件、怎么循环）由各 slice 自定，
 * 但对外只暴露本契约。
 *
 * 设计取向（见 plan.md 基座修正）：不引入 pi-agent-core/dsh/Cordis。
 * 在现有自带 ModelClient 上自建自由 tool-calling 循环，GJB 三层钩子自控。
 */

import type { GovernanceClient, LoopConnector } from "./types.ts";

/** JSON Schema 子集（OpenAI tool `parameters` 格式）。 */
export type ToolParameters = Record<string, unknown>;

/** 工具执行上下文：注入治理能力（Core）与 Connector。工具内不得绕过 Core 直连 Worker。 */
export interface ToolExecContext {
  readonly projectId: string;
  /** Core 治理客户端（登记候选制品/快照/门禁）。 */
  readonly governance: GovernanceClient;
  /** Connector（经 Core 提交 Vivado Job）。无可用时为 null（工具须 fail-closed）。 */
  readonly connector: LoopConnector | null;
  /** 目标器件 part（Vivado 操作用）。 */
  readonly part: string;
  /** 当前任务分类/数据域标签（beforeToolCall 数据域判定用）。 */
  readonly classification: string;
}

/** 工具执行结果（回填给模型）。content 必须为可序列化文本/JSON 字符串。 */
export interface AgentToolResult {
  /** 给模型看的内容（人类可读摘要或 JSON 字符串）。 */
  readonly content: string;
  /** 是否为错误结果；true 时模型据此自纠。 */
  readonly isError?: boolean;
}

/** Agent 可自主选择的工具。 */
export interface AgentTool {
  /** 稳定工具名（snake_case），模型据此调用。 */
  readonly name: string;
  /** 给模型看的描述（决定模型是否调用）。 */
  readonly description: string;
  readonly parameters: ToolParameters;
  execute(args: unknown, ctx: ToolExecContext): Promise<AgentToolResult>;
}

/** 一次工具调用（模型产出）。 */
export interface AgentToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
}

/** 对话消息（OpenAI 风格）。 */
export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: readonly AgentToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

/** 三层强制钩子。返回 undefined 表示放行。 */
export interface BeforeToolCallHook {
  (call: AgentToolCall, ctx: ToolExecContext): { block: true; reason: string } | undefined;
}
export interface AfterToolCallHook {
  (call: AgentToolCall, result: AgentToolResult, ctx: ToolExecContext): void | Promise<void>;
}
export interface BeforeModelCallHook {
  (messages: readonly AgentMessage[]): { stop: true; reason: string } | undefined;
}

/** 模型一次对话回合：要么纯文本（闲聊/答复/收尾），要么一组工具调用。 */
export type ChatTurn =
  | { kind: "text"; content: string }
  | { kind: "tool_calls"; calls: readonly AgentToolCall[]; content: string | null };

/** 对话式模型原语（多轮 tool-calling）。Slice A 在 model-client.ts 上实现 chat()。 */
export interface ConversationalModel {
  chat(messages: readonly AgentMessage[], tools: readonly AgentTool[]): Promise<ChatTurn>;
}

/** 会话状态机。 */
export type FreeAgentStatus =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "cancelled"
  | "failed";

/** 自由 Agent 会话。server/web 面向此接口编程（Slice D）。 */
export interface FreeAgentSession {
  readonly runId: string;
  readonly projectId: string;
  status(): FreeAgentStatus;
  /**
   * 新指令或闲聊。内部循环：chat → 若 tool_calls 则逐个执行（含钩子）→ 回填 → 再 chat，
   * 直到模型返回纯文本。返回该文本。可被 steer()/abort() 打断。
   */
  prompt(text: string): Promise<string>;
  /** 运行中接管/纠偏（下一工具结束后注入上下文），不入队新 prompt。 */
  steer(text: string): void;
  /** 立即终止。 */
  abort(reason?: string): void;
}
