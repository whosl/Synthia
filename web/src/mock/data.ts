/**
 * `VITE_MOCK=1` 的离线数据源：把 worker-66 真机跑出来的 Vivado 产物
 * （`./vivado-fixture.ts`）编排成 Core API 的响应形状，让三栏项目页在没有
 * Core / Runtime 的情况下也能整页渲染。
 *
 * 哪些是真的、哪些是我编的（重要，别混淆）：
 * - **真的**：jobId、inputSha256、证据条目名/sha256/字节数、四个工具操作的成败
 *   与耗时、RTL/TB/XDC 源码、`synthia.bit` 的 3,011,427 字节与摘要、以及 v1 草稿
 *   被 XSim 判失败这件事本身（`VIVADO_SIMULATION_FAILED`，high=191 vs 期望 64）。
 * - **我编的**：四份中文设计文档的正文、门审查（G1–G4）的时间线、run/revision 的
 *   id 与时间戳、以及 SSE 叙述脚本。没有模型后端在跑，这些没法真机产出。
 *   文档正文的 `content_hash` 是对下面这些字符串真算的 SHA-256（gen 脚本填入），
 *   不是随手编的十六进制。
 *
 * 编排口径严格对齐 `runtime/loop.ts` 的真实行为，不多不少：
 * - 每轮 run 只登记 5 个 artifact（intake / behavior_wave / architecture /
 *   register_spec 四份文档 + RTL_SOURCE_SET），**TB、XDC 和所有 Vivado 报告都不
 *   登记为 artifact**，所以左栏「路径」视图里 `tb/`、`sim/`、`prj/constr/` 三个
 *   分组在当前后端下永远是空的——这是后端事实，不是 mock 偷懒。
 * - artifactId = `art-<stage>-<sha8(agentId:task)>`，因此**不同 run 的产物是不同的
 *   artifact**。项目里两轮 run ⇒ 10 个 artifact，当前选中 run 之外的 5 个没有
 *   docs 可关联，会落进左栏的「未关联当前任务」分组（这是真实边界，留着测它）。
 * - 文档路径取自 `runtime/deps.ts` 的 docPath；RTL 路径为 `rtl/<首个源文件>`。
 *
 * 两轮 run 复用同一批真机作业记录，所以同一个 jobId 会在两轮里各出现一次。
 */

import type {
  Artifact,
  ArtifactRevision,
  ProjectDetail,
  TaskAuditEvent,
  TaskDocRef,
  TaskEvidenceSummary,
  TaskAgentDetail,
  TaskAgentSummary,
} from "../api/types.ts";
import { VIVADO_FIXTURE } from "./vivado-fixture.ts";
import { DOC_INTAKE, DOC_BEHAVIOR, DOC_ARCH, DOC_REG } from "./docs.ts";
import { CONTENT_SHA } from "./content-hashes.ts";

const FX = VIVADO_FIXTURE as {
  toolchain: { vivadoVersion: string; vivadoPatch: string; part: string; toolchainProfileHash: string; capabilityMapVersion: string };
  jobs: Record<string, { jobId: string; operation: string; status: string; inputSha256: string; errorCode?: string | null; entries: Array<{ name: string; sha256: string; sizeBytes: number; mediaType: string }> }>;
  stdout: Record<string, string>;
  reports: Record<string, string>;
  sources: Record<string, string>;
};

export const PROJECT_ID = "p1";
const TASK_TEXT = "做一个 8 位 PWM 发生器：占空比可配，复位低有效，跑通仿真并出码流。";

// ─────────────────────────────────────────────────────────────────────
// 项目详情
// ─────────────────────────────────────────────────────────────────────

export const MOCK_PROJECT: ProjectDetail = {
  id: PROJECT_ID,
  name: "PWM 发生器（8 位可配占空比）",
  status: "active",
  data_classification: "internal",
  created_at: "2026-08-14T02:31:00.000Z",
  scope: "单模块 RTL，Kintex-7 目标板 smoke 验证",
  standard_version: "GB/T 33781-2017",
  target_part: FX.toolchain.part,
  toolchain_profile_ref: FX.toolchain.toolchainProfileHash,
  process_instances: [
    { id: "pi-p1-default", gate_profile_version: "gp-1", current_gate: "G4", created_at: "2026-08-14T02:31:00.000Z" },
  ],
};

// ─────────────────────────────────────────────────────────────────────
// 文档正文（手写；没有模型后端可跑，见文件头说明）
// ─────────────────────────────────────────────────────────────────────

const RTL_V2 = FX.sources["pwm_gen.v"]!;
const RTL_V1 = FX.sources["pwm_gen.v@v1"]!;

// ─────────────────────────────────────────────────────────────────────
// artifact / revision（每轮 run 各 5 个 artifact，见文件头口径）
// ─────────────────────────────────────────────────────────────────────

interface DocSpec {
  readonly stage: string;
  readonly artifactType: string;
  readonly path: string;
  readonly title: string;
  readonly content: string;
}

const DOC_SPECS: readonly DocSpec[] = [
  { stage: "intake", artifactType: "DEVELOPMENT_REQUIREMENTS", path: "doc/intake/summary.md", title: "intake document", content: DOC_INTAKE },
  { stage: "behavior_wave", artifactType: "DETAILED_DESIGN", path: "doc/spec/behavior_spec.md", title: "behavior_wave document", content: DOC_BEHAVIOR },
  { stage: "architecture", artifactType: "ARCHITECTURE_DESIGN", path: "doc/arch/module_partition.md", title: "architecture document", content: DOC_ARCH },
  { stage: "register_spec", artifactType: "DETAILED_DESIGN", path: "doc/reg/register_map.md", title: "register_spec document", content: DOC_REG },
];

const RTL_PATH = "rtl/pwm_gen.v";

interface AgentArtifacts {
  readonly artifacts: readonly Artifact[];
  readonly revisions: Readonly<Record<string, readonly ArtifactRevision[]>>;
  readonly content: Readonly<Record<string, string>>;
  readonly docs: readonly TaskDocRef[];
  /** stage → revision_id，audit 的 governance 事件按它拼 action 文本。 */
  readonly revisionByStage: Readonly<Record<string, string>>;
  /** RTL 第一版（草稿）修订 id，供 audit 的第一轮登记事件引用。 */
  readonly rtlDraftRevisionId: string;
}

/**
 * 造一轮 run 的 5 个 artifact。
 *
 * @param suffix        artifactId 的 sha8 位（真实实现里是 sha256(agentId:task) 前 8 位）
 * @param baseTs        产物创建时间基准
 * @param rtlApproved   RTL 最新修订是否已批准（succeeded 的 run 为 true → 编辑器只读）
 */
function buildAgentArtifacts(suffix: string, baseTs: string, rtlApproved: boolean): AgentArtifacts {
  const artifacts: Artifact[] = [];
  const revisions: Record<string, readonly ArtifactRevision[]> = {};
  const content: Record<string, string> = {};
  const docs: TaskDocRef[] = [];
  const revisionByStage: Record<string, string> = {};
  const base = Date.parse(baseTs);
  const at = (offsetSec: number): string => new Date(base + offsetSec * 1000).toISOString();

  DOC_SPECS.forEach((spec, i) => {
    const artifactId = `art-${spec.stage}-${suffix}`;
    const revisionId = `rev-${spec.stage}-${suffix}-1`;
    artifacts.push({ id: artifactId, artifact_type: spec.artifactType, created_at: at(i * 40) });
    revisions[artifactId] = [
      {
        id: revisionId,
        version: 1,
        state: "approved",
        content_hash: CONTENT_SHA[spec.stage]!,
        content_location: spec.path,
        title: spec.title,
        created_at: at(i * 40),
      },
    ];
    content[revisionId] = spec.content;
    docs.push({ phase: spec.stage, path: spec.path, artifact_id: artifactId, revision_id: revisionId });
    revisionByStage[spec.stage] = revisionId;
  });

  // RTL：两版真源码（v1 = 比较符写反的草稿，v2 = 修好的版本）。
  const rtlId = `art-rtl-${suffix}`;
  const rtlRev1 = `rev-rtl-${suffix}-1`;
  const rtlRev2 = `rev-rtl-${suffix}-2`;
  artifacts.push({ id: rtlId, artifact_type: "RTL_SOURCE_SET", created_at: at(200) });
  revisions[rtlId] = [
    { id: rtlRev1, version: 1, state: "superseded", content_hash: CONTENT_SHA.rtl_v1!, content_location: RTL_PATH, title: "RTL top=pwm_gen", created_at: at(200) },
    { id: rtlRev2, version: 2, state: rtlApproved ? "approved" : "candidate", content_hash: CONTENT_SHA.rtl_v2!, content_location: RTL_PATH, title: "RTL top=pwm_gen", created_at: at(340) },
  ];
  content[rtlRev1] = RTL_V1;
  content[rtlRev2] = RTL_V2;
  docs.push({ phase: "rtl_build", path: RTL_PATH, artifact_id: rtlId, revision_id: rtlRev2 });
  revisionByStage.rtl_build = rtlRev2;

  return { artifacts, revisions, content, docs, revisionByStage, rtlDraftRevisionId: rtlRev1 };
}

// ─────────────────────────────────────────────────────────────────────
// audit 事件（形态严格照抄 runtime/loop.ts 的 action 文本）
// ─────────────────────────────────────────────────────────────────────

class AuditBuilder {
  private seq = 0;
  private tsMs: number;
  readonly events: TaskAuditEvent[] = [];

  constructor(startIso: string) {
    this.tsMs = Date.parse(startIso);
  }

  /** 推进 @advanceSec 秒后追加一条事件。 */
  push(advanceSec: number, event: Omit<TaskAuditEvent, "ts" | "seq">): void {
    this.tsMs += advanceSec * 1000;
    this.seq += 1;
    this.events.push({ ts: new Date(this.tsMs).toISOString(), seq: this.seq, ...event });
  }

  get nowIso(): string {
    return new Date(this.tsMs).toISOString();
  }
}

/** 门审查三连（创建快照 → 提交 → 批准）。 */
function gateReview(b: AuditBuilder, gate: string, revisionCount: number): void {
  b.push(2, { category: "gate", phase: "gate_review", action: `${gate}: creating snapshot (${revisionCount} revisions)`, result: "ok" });
  b.push(1, { category: "gate", phase: "gate_review", action: `${gate}: submitting for review`, result: "ok" });
  b.push(4, { category: "gate", phase: "gate_review", action: `${gate}: approved — continuing`, result: "ok" });
}

/** 一次工具调用：权限门 + tool_call（真机 jobId / inputSha256 / 成败 / 耗时）。 */
function toolCall(b: AuditBuilder, jobKey: string, durationSec: number): void {
  const job = FX.jobs[jobKey]!;
  const op = job.operation;
  b.push(1, { category: "gate", phase: op, action: `gate ok (${FX.toolchain.capabilityMapVersion})`, result: "ok" });
  const ok = job.status === "succeeded";
  b.push(durationSec, {
    category: "tool_call",
    phase: op,
    action: ok ? `${op} succeeded` : `${op} ${job.status}`,
    inputSha256: job.inputSha256,
    jobId: job.jobId,
    result: ok ? "ok" : "failed",
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
  });
}

function evidenceOf(jobKey: string): TaskEvidenceSummary {
  const job = FX.jobs[jobKey]!;
  return {
    jobId: job.jobId,
    operation: job.operation,
    status: job.status,
    inputSha256: job.inputSha256,
    entries: job.entries,
  };
}

/**
 * 实现阶段的 Agent 叙述（**手写**，本地没有模型后端）。
 *
 * 拆成小块是给 SSE 逐块吐用的；拼起来的整段同时作为 `free_agent_reply` 落进
 * 已完成 run 的 audit——真实链路里就是这样：SSE 负责即时性，audit 负责权威性，
 * 两边文本一致时前端按文本指纹去重（见 ProjectView 的 parts 合成）。
 */
export const IMPLEMENT_NARRATION: readonly string[] = [
  "综合已经过了，",
  "资源占用很小：",
  "LUT 12 个、FF 17 个，",
  `在 ${FX.toolchain.part} 上基本可以忽略。\n\n`,
  "现在跑实现，",
  "顺序是 opt_design → place_design → route_design，",
  "然后出 DRC / 时序 / 资源三份报告，",
  "最后写比特流。\n\n",
  "约束里我把 NSTD-1 和 UCIO-1 降成了 Warning——",
  "这一轮是 smoke 验证，没有绑定物理引脚，",
  "不降级的话 write_bitstream 会被 DRC 直接挡下来。\n\n",
  "布线完成，时序收敛（WNS 为正），DRC 无 error。",
  "比特流 synthia.bit 已生成，3,011,427 字节。",
];

/** SSE 与 audit 共用的整段叙述文本（两边必须完全一致，否则前端会渲染两遍）。 */
export const IMPLEMENT_NARRATION_TEXT = IMPLEMENT_NARRATION.join("");

/**
 * 造 audit：需求 → G1 → 行为 → G2 → 架构/寄存器 → G3 → RTL 草稿 → 编译检查 →
 * TB → 仿真失败（真机 v1）→ 修复 → RTL v2 → 编译检查 → 仿真通过 → XDC → 综合 →
 * 实现 → G4 → 完成。`stopAfter` 用来把 running 的 run 停在某一步。
 */
function buildAudit(
  startIso: string,
  art: AgentArtifacts,
  stopAfter: "implement-gate" | "loop-succeeded",
): { events: readonly TaskAuditEvent[]; evidence: readonly TaskEvidenceSummary[]; endIso: string } {
  const b = new AuditBuilder(startIso);
  const evidence: TaskEvidenceSummary[] = [];
  const gov = (stage: string, revisionId: string, detail: string): void => {
    b.push(1, { category: "governance", phase: "governance", action: `registered ${stage} artifact: ${revisionId}`, result: "ok", detail });
  };

  b.push(6, { category: "model", phase: "generate_intake", action: "intake doc generated: doc/intake/summary.md", detail: "doc/intake/summary.md", result: "ok" });
  gov("intake", art.revisionByStage.intake!, "type=DEVELOPMENT_REQUIREMENTS path=doc/intake/summary.md");
  gateReview(b, "G1", 1);

  b.push(9, { category: "model", phase: "generate_behavior_wave", action: "behavior/wave doc generated: doc/spec/behavior_spec.md", detail: "doc/spec/behavior_spec.md", result: "ok" });
  gov("behavior_wave", art.revisionByStage.behavior_wave!, "type=DETAILED_DESIGN path=doc/spec/behavior_spec.md");
  gateReview(b, "G2", 2);

  b.push(11, { category: "model", phase: "generate_architecture", action: "architecture doc generated: doc/arch/module_partition.md", detail: "doc/arch/module_partition.md", result: "ok" });
  gov("architecture", art.revisionByStage.architecture!, "type=ARCHITECTURE_DESIGN path=doc/arch/module_partition.md");
  b.push(7, { category: "model", phase: "generate_register_spec", action: "register spec generated: doc/reg/register_map.md", detail: "doc/reg/register_map.md", result: "ok" });
  gov("register_spec", art.revisionByStage.register_spec!, "type=DETAILED_DESIGN path=doc/reg/register_map.md");
  gateReview(b, "G3", 4);

  // 第一轮：草稿 RTL（真机 v1，比较符写反）
  b.push(14, { category: "model", phase: "generate_rtl", action: "rtl generated: pwm_gen.v", detail: "top=pwm_gen", result: "ok" });
  gov("RTL", art.rtlDraftRevisionId, "top=pwm_gen");
  toolCall(b, "validate_sources@v1", 12);
  evidence.push(evidenceOf("validate_sources@v1"));
  b.push(8, { category: "model", phase: "generate_testbench", action: "testbench generated: pwm_gen_tb.v", detail: "top=pwm_gen_tb", result: "ok" });
  toolCall(b, "simulate@v1", 23);
  evidence.push(evidenceOf("simulate@v1"));

  // 修复循环：诊断 → 改 RTL → 重跑
  b.push(2, { category: "tool_call", phase: "repair", action: "diagnostics_fetched=true", result: "ok" });
  b.push(13, { category: "model", phase: "repair", action: "repair round 1 applied", detail: "cnt > duty → cnt < duty", result: "ok" });
  gov("RTL", art.revisionByStage.rtl_build!, "top=pwm_gen");
  toolCall(b, "validate_sources", 13);
  evidence.push(evidenceOf("validate_sources"));
  toolCall(b, "simulate", 32);
  evidence.push(evidenceOf("simulate"));

  b.push(6, { category: "model", phase: "generate_xdc", action: "xdc generated: pwm_gen.xdc", detail: "create_clock 10.000ns", result: "ok" });
  toolCall(b, "synthesize", 24);
  evidence.push(evidenceOf("synthesize"));

  if (stopAfter === "implement-gate") {
    // running 的 run 停在这里：权限门已过 = 工具条 running，叙述正由 SSE 逐字吐出，
    // 所以此时 audit 里还没有对应的 free_agent_reply。
    b.push(1, { category: "gate", phase: "implement", action: `gate ok (${FX.toolchain.capabilityMapVersion})`, result: "ok" });
    return { events: b.events, evidence, endIso: b.nowIso };
  }

  b.push(3, { category: "model", phase: "free_agent", action: "free_agent_reply", detail: IMPLEMENT_NARRATION_TEXT, result: "ok" });
  toolCall(b, "implement", 69);
  evidence.push(evidenceOf("implement"));
  gateReview(b, "G4", 5);
  b.push(1, { category: "loop", phase: "loop", action: "loop succeeded", result: "ok" });
  return { events: b.events, evidence, endIso: b.nowIso };
}

// ─────────────────────────────────────────────────────────────────────
// 两轮 run（老的已完成；新的停在实现阶段，由 SSE 推到完成）
// ─────────────────────────────────────────────────────────────────────

const AGENT_A = "agent-2026081603-8f21ac";
const AGENT_B = "agent-2026081714-3d09be";

const ART_A = buildAgentArtifacts("8f21ac41", "2026-08-16T03:12:00.000Z", true);
const ART_B = buildAgentArtifacts("3d09be07", "2026-08-17T14:03:00.000Z", false);

const AUDIT_A = buildAudit("2026-08-16T03:12:00.000Z", ART_A, "loop-succeeded");
const AUDIT_B_RUNNING = buildAudit("2026-08-17T14:03:00.000Z", ART_B, "implement-gate");
const AUDIT_B_DONE = buildAudit("2026-08-17T14:03:00.000Z", ART_B, "loop-succeeded");

export const MOCK_ARTIFACTS: readonly Artifact[] = [...ART_B.artifacts, ...ART_A.artifacts];

export const MOCK_REVISIONS: Readonly<Record<string, readonly ArtifactRevision[]>> = {
  ...ART_A.revisions,
  ...ART_B.revisions,
};

export const MOCK_CONTENT: Readonly<Record<string, string>> = { ...ART_A.content, ...ART_B.content };

const SUMMARY_A: TaskAgentSummary = {
  agent_id: AGENT_A,
  project_id: PROJECT_ID,
  status: "succeeded",
  current_stage: "implement",
  awaiting_gate: null,
  created_at: "2026-08-16T03:12:00.000Z",
};

const DETAIL_A: TaskAgentDetail = {
  ...SUMMARY_A,
  task: TASK_TEXT,
  docs: ART_A.docs,
  audit: AUDIT_A.events,
  evidence: AUDIT_A.evidence,
  reason: null,
};

const SUMMARY_B_RUNNING: TaskAgentSummary = {
  agent_id: AGENT_B,
  project_id: PROJECT_ID,
  status: "running",
  current_stage: "implement",
  awaiting_gate: null,
  created_at: "2026-08-17T14:03:00.000Z",
};

const DETAIL_B_RUNNING: TaskAgentDetail = {
  ...SUMMARY_B_RUNNING,
  task: TASK_TEXT,
  docs: ART_B.docs,
  audit: AUDIT_B_RUNNING.events,
  evidence: AUDIT_B_RUNNING.evidence,
  reason: null,
};

const SUMMARY_B_DONE: TaskAgentSummary = { ...SUMMARY_B_RUNNING, status: "succeeded" };

const DETAIL_B_DONE: TaskAgentDetail = {
  ...SUMMARY_B_DONE,
  task: TASK_TEXT,
  docs: ART_B.docs,
  audit: AUDIT_B_DONE.events,
  evidence: AUDIT_B_DONE.evidence,
  reason: null,
};

/**
 * 可变的 mock 运行态：新 run 起初是 running，SSE 脚本播完后翻成 succeeded
 * （前端轮询随即拉到完整 audit + 码流成功卡）。
 */
export const mockState = {
  agentBDone: false,
  /** 用户在 mock 里新建/发送的消息，回显进对话流。 */
  extraUserMessages: [] as Array<{ agentId: string; text: string; ts: string }>,
};

export const LIVE_AGENT_ID = AGENT_B;

export function mockAgents(): readonly TaskAgentSummary[] {
  return [mockState.agentBDone ? SUMMARY_B_DONE : SUMMARY_B_RUNNING, SUMMARY_A];
}

/**
 * 运行记录面板「查看内容」的离线回填：按 jobId 找到 `FX.jobs` 里的作业，校验
 * `name` 确实是该作业的证据条目之一，正文取 `FX.stdout[operation]`（真机
 * stdout 全文，唯一现成的可读文本源；条目本身如 worker-result.json 的真实字节
 * 未落进本仓库）。找不到作业或条目 → null，路由层据此回 404，对齐真实后端语义。
 */
export function mockJobEvidenceContent(jobId: string, name: string): { name: string; content: string; sha256: string; truncated: boolean; mediaType: string } | null {
  const job = Object.values(FX.jobs).find((j) => j.jobId === jobId);
  if (!job) return null;
  const entry = job.entries.find((e) => e.name === name);
  if (!entry) return null;
  const stdout = (FX.stdout as Record<string, string>)[job.operation];
  return {
    name: entry.name,
    content: stdout ?? `(mock：${job.operation} 无原始 stdout 快照)`,
    sha256: entry.sha256,
    truncated: false,
    mediaType: entry.mediaType,
  };
}

export function mockAgentDetail(agentId: string): TaskAgentDetail | null {
  const base =
    agentId === AGENT_A ? DETAIL_A : agentId === AGENT_B ? (mockState.agentBDone ? DETAIL_B_DONE : DETAIL_B_RUNNING) : null;
  if (!base) return null;
  const extras = mockState.extraUserMessages.filter((m) => m.agentId === agentId);
  if (extras.length === 0) return base;
  const lastSeq = base.audit.reduce((n, e) => Math.max(n, e.seq), 0);
  const appended: TaskAuditEvent[] = [];
  extras.forEach((m, i) => {
    appended.push({
      ts: m.ts,
      seq: lastSeq + i * 2 + 1,
      category: "model",
      phase: "free_agent",
      action: "user_message",
      detail: m.text,
      result: "ok",
    });
    appended.push({
      ts: m.ts,
      seq: lastSeq + i * 2 + 2,
      category: "model",
      phase: "free_agent",
      action: "free_agent_reply",
      detail: MOCK_REPLY_TEXT,
      result: "ok",
    });
  });
  return { ...base, audit: [...base.audit, ...appended] };
}

/** mock 模式下对用户消息的固定回复：明说这里没有模型，别让人误以为是真回答。 */
const MOCK_REPLY_TEXT =
  "（离线 mock 模式）这一页的数据来自 worker-66 的真机 Vivado 产物快照，但**没有模型后端在跑**，" +
  "所以我没法真的回答你这条消息。要看真实对话，需要连上 Core 与 Runtime 后去掉 `VITE_MOCK=1`。";

