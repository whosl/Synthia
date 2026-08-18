/**
 * 顶栏阶段进度条的数据驱动 profile（spec §3.1，D18）。
 *
 * - 第一轮只有 `fpga-full` 一套 profile，节点直接取自 `domain/tasks.ts:STAGE_CHAIN`
 *   （15 节点），不重复定义阶段链本身。
 * - **关键约束**：执行链上的门只有 G1/G2/G3/G4；其中里程碑门是 G1/G3/G4（G2 是普通
 *   门）。`gates.ts:MILESTONE_GATES` 含 G7/G9，但那两个不在执行链上，顶栏绝不渲染
 *   它们——本文件不 import gates.ts 的 MILESTONE_GATES，避免误用。
 * - PC 端把 15 节点按里程碑门切成三段（`STAGE_SEGMENTS`），每段的「中间节点」折叠
 *   显示为一条带进度的短轨，终点是里程碑门（实心菱形）。
 */

import { STAGE_CHAIN, type StageChainNode, type StageNode, type StageNodeStatus } from "./tasks.ts";

// ─── profile ────────────────────────────────────────────────────────────

export interface ProcessProfile {
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly StageNode[];
}

/** 第一轮唯一 profile：FPGA 全流程（16 节点见 STAGE_CHAIN 注释，实为 15）。 */
export const FPGA_FULL_PROFILE: ProcessProfile = {
  id: "fpga-full",
  name: "FPGA 全流程",
  nodes: STAGE_CHAIN,
};

export const PROCESS_PROFILES: readonly ProcessProfile[] = [FPGA_FULL_PROFILE];

// ─── 分段（里程碑门为锚点） ─────────────────────────────────────────────────

/** 执行链上的里程碑门（仅 G1/G3/G4；G7/G9 不在执行链上，顶栏不显示）。 */
export type ExecMilestoneGateId = "G1" | "G3" | "G4";

export const EXEC_MILESTONE_GATES: readonly ExecMilestoneGateId[] = ["G1", "G3", "G4"];

export interface StageSegment {
  /** 1-based 段序号，移动端摘要用「①②③」展示。 */
  readonly index: number;
  /** 段名（折叠短轨文案前缀，如「设计 3/4」的「设计」）。 */
  readonly label: string;
  /** 段内除终点里程碑门以外的节点 id，按 STAGE_CHAIN 顺序（可能含普通门如 G2）。 */
  readonly middleNodeIds: readonly string[];
  /** 段终点：里程碑门 id。 */
  readonly gateId: ExecMilestoneGateId;
}

/** spec §3.1 表格的三段切分：段1→G1，段2(含G2)→G3，段3→G4。 */
export const STAGE_SEGMENTS: readonly StageSegment[] = [
  { index: 1, label: "需求", middleNodeIds: ["intake"], gateId: "G1" },
  {
    index: 2,
    label: "设计",
    middleNodeIds: ["behavior_wave", "G2", "architecture", "register_spec"],
    gateId: "G3",
  },
  {
    index: 3,
    label: "实现",
    middleNodeIds: ["rtl", "validate", "tb", "simulate", "xdc", "synthesize", "implement"],
    gateId: "G4",
  },
];

/** 段内全部节点 id（中间节点 + 终点门），按顺序，供 hover 浮层展开列表用。 */
export function segmentAllNodeIds(segment: StageSegment): readonly string[] {
  return [...segment.middleNodeIds, segment.gateId];
}

/** 给定节点 id 所属的段序号（1-based）；未知 id 兜底返回 1（不应发生）。 */
export function segmentIndexOf(nodeId: string): number {
  const seg = STAGE_SEGMENTS.find((s) => segmentAllNodeIds(s).includes(nodeId));
  return seg ? seg.index : 1;
}

function nodeStatus(chain: readonly StageChainNode[], id: string): StageNodeStatus | undefined {
  return chain.find((c) => c.node.id === id)?.status;
}

function chainNode(chain: readonly StageChainNode[], id: string): StageChainNode | undefined {
  return chain.find((c) => c.node.id === id);
}

/** 由 STAGE_CHAIN 静态取门节点对象（供 StageRail 渲染菱形节点用）。 */
export function gateNode(gateId: ExecMilestoneGateId): StageNode {
  const node = STAGE_CHAIN.find((n) => n.id === gateId);
  if (!node) throw new Error(`未知里程碑门 id：${gateId}`);
  return node;
}

// ─── 进度推导 ───────────────────────────────────────────────────────────

export interface SegmentProgress {
  /** 段内中间节点（不含终点门）已完成数。 */
  readonly done: number;
  /** 段内中间节点（不含终点门）总数。 */
  readonly total: number;
  readonly label: string;
}

/** 折叠段短轨进度，如「设计 3/4」（只统计中间节点，终点门单独用菱形展示）。 */
export function segmentProgress(segment: StageSegment, chain: readonly StageChainNode[]): SegmentProgress {
  const total = segment.middleNodeIds.length;
  const done = segment.middleNodeIds.filter((id) => nodeStatus(chain, id) === "done").length;
  return { done, total, label: segment.label };
}

/** 折叠段整体视觉状态（中间节点 + 终点门合并判定，优先级 failed > waiting > running > done > pending）。 */
export function segmentStatus(segment: StageSegment, chain: readonly StageChainNode[]): StageNodeStatus {
  const statuses = segmentAllNodeIds(segment).map((id) => nodeStatus(chain, id) ?? "pending");
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "waiting")) return "waiting";
  if (statuses.some((s) => s === "running")) return "running";
  if (statuses.every((s) => s === "done")) return "done";
  return "pending";
}

/** 整体进度，如「8/15」。 */
export function overallProgress(chain: readonly StageChainNode[]): { readonly done: number; readonly total: number } {
  return { done: chain.filter((c) => c.status === "done").length, total: chain.length };
}

// ─── 移动端摘要 ─────────────────────────────────────────────────────────

export interface CurrentStageSummary {
  /** 当前节点所属段序号（① ② ③）。 */
  readonly segmentIndex: number;
  readonly node: StageNode;
  readonly status: StageNodeStatus;
  /** 整体进度。 */
  readonly done: number;
  readonly total: number;
}

/**
 * 移动端一行摘要所需数据：「③ RTL 生成 · 进行中 · 8/15」。
 *
 * 当前节点优先取「进行中/等待批准/失败」的活跃节点；若全部节点要么完成要么
 * 未开始（无活跃节点），退化为取最后一个已完成节点；若全部未开始，取第一个
 * 节点（intake）。chain 为 null（尚无 run）时返回 null，调用方应显示「尚无任务」。
 */
export function currentStageSummary(chain: readonly StageChainNode[] | null): CurrentStageSummary | null {
  if (!chain || chain.length === 0) return null;
  const { done, total } = overallProgress(chain);
  const active = chain.find((c) => c.status === "running" || c.status === "waiting" || c.status === "failed");
  const lastDone = [...chain].reverse().find((c) => c.status === "done");
  const current = active ?? lastDone ?? chain[0];
  return {
    segmentIndex: segmentIndexOf(current.node.id),
    node: current.node,
    status: current.status,
    done,
    total,
  };
}

export { chainNode };
