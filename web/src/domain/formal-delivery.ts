import type {
  BitstreamResultV1,
  DeliveryManifestV1,
  DeliveryReleaseContentV1,
  EngineeringConfigV1,
  GateCheckEvaluationV1,
  GateSubmission,
  P4GateId,
  ProcessProfileV1,
  ProcessStateV1,
  ProjectReadinessRecord,
} from "../api/types.ts";
import { sha256Bytes } from "../util/sha256.ts";

/** Human-authored G0 facts. ProjectView adds Core-owned workspace/id bindings. */
export interface ReadinessPreparationInput {
  readonly engineeringConfig: EngineeringConfigV1;
  readonly sourceSnapshotIds: readonly string[];
  readonly reason: string;
}

export interface FormalInputContext {
  readonly workVersionId: string;
  readonly snapshotId: string;
  readonly readinessId: string;
  readonly authorizedTaskId: string;
}

export interface G4CheckRow {
  readonly code: string;
  readonly label: string;
  readonly severity: "hard" | "advisory";
  readonly status: "passed" | "failed" | "missing";
  readonly details: Readonly<Record<string, unknown>> | null;
}

const CHECK_LABELS: Readonly<Record<string, string>> = {
  "artifact.rtl": "RTL 文件齐全",
  "artifact.testbench": "测试平台齐全",
  "artifact.constraints": "约束文件齐全",
  "formal_input.confirmed": "正式输入已人工确认",
  "constraints.complete": "引脚、电气与时钟约束完整",
  "formal_simulation.succeeded": "正式仿真通过",
  "formal_implementation.succeeded": "正式实现完成",
  "drc.clean": "DRC 无错误",
  "timing.met": "时序达标",
  "evidence.frozen": "原始证据已冻结",
  "bitstream.formal": "正式码流已形成",
  "delivery.manifest_sealed": "交付清单已密封",
};

export function requiredCheckLabel(code: string): string {
  return CHECK_LABELS[code] ?? "流程要求";
}

export function deriveG4Checks(
  profile: ProcessProfileV1 | null,
  evaluation: GateCheckEvaluationV1 | null,
): readonly G4CheckRow[] {
  const required = profile?.nodes.find((node) => node.id === "G4")?.requiredChecks ?? [];
  const items = new Map((evaluation?.items ?? []).map((item) => [item.check_code, item]));
  return required.map((check) => {
    const item = items.get(check.code);
    return {
      code: check.code,
      label: requiredCheckLabel(check.code),
      severity: check.severity,
      status: item ? (item.passed ? "passed" : "failed") : "missing",
      details: item?.details ?? null,
    };
  });
}

/** A modern approval may only bind a passed evaluation for the exact snapshot. */
export function latestPassedEvaluation(
  evaluations: readonly GateCheckEvaluationV1[],
  snapshotId: string,
): GateCheckEvaluationV1 | null {
  return [...evaluations]
    .filter((row) => row.passed && row.snapshot_id === snapshotId)
    .sort((left, right) => right.evaluated_at.localeCompare(left.evaluated_at))[0] ?? null;
}

/** G0 can be revised after confirmation when incomplete constraints block G4. */
export function shouldPrepareReadiness(state: ProcessStateV1 | null): boolean {
  return !state?.readiness?.ready || !state.readiness.constraintsComplete;
}

function workVersionId(readiness: ProjectReadinessRecord): string | null {
  return readiness.workVersionId ?? readiness.work_version_id ?? null;
}

/** Resolve preview inputs only from Core-owned facts; never invent ids in the browser. */
export function resolveFormalInputContext(input: {
  readonly state: ProcessStateV1 | null;
  readonly readinessRows: readonly ProjectReadinessRecord[];
  readonly submissions: readonly GateSubmission[];
  readonly authorizedTaskId: string | null;
}): FormalInputContext | null {
  const readinessId = input.state?.readiness?.id;
  if (!readinessId || !input.state?.readiness?.ready || !input.authorizedTaskId) return null;
  const readiness = input.readinessRows.find((row) => row.id === readinessId);
  const versionId = readiness ? workVersionId(readiness) : null;
  const submission = [...input.submissions]
    .filter((row) => row.gate === "G4" && row.work_version_id === input.state?.workVersionId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!versionId || !submission?.snapshot_id) return null;
  return {
    workVersionId: versionId,
    snapshotId: submission.snapshot_id,
    readinessId,
    authorizedTaskId: input.authorizedTaskId,
  };
}

export function formalInputBlockers(state: ProcessStateV1 | null, context: FormalInputContext | null): readonly string[] {
  const blockers: string[] = [];
  if (!state) return ["Core 流程状态尚不可用"];
  if (!state.readiness?.ready) blockers.push("G0 准备尚未由本人确认");
  if (state.readiness && !state.readiness.constraintsComplete) blockers.push("引脚、电气或时钟约束尚不完整");
  if (!context) blockers.push("当前工作版本、G4 快照或主任务尚未形成完整绑定");
  return blockers;
}

export const DELIVERY_CATEGORY_TEXT: Readonly<Record<string, string>> = {
  rtl: "RTL",
  tb: "测试平台",
  constraint: "约束",
  document: "文档",
  run_result: "运行结果",
  raw_evidence: "原始证据",
  confirmation: "确认记录",
  source: "来源",
  bitstream: "正式码流",
};

/** Never collapse an exploratory result into the ambiguous word "bitstream". */
export function bitstreamClassText(value: BitstreamResultV1["class"]): "试验码流" | "正式码流" {
  return value === "formal" ? "正式码流" : "试验码流";
}

export function changeImpactGateOptions(): readonly Exclude<P4GateId, "G0">[] {
  return ["G1", "G2", "G3", "G4"];
}

export function deliveryContentBytes(content: DeliveryReleaseContentV1): Uint8Array {
  if (content.encoding === "utf8") return new TextEncoder().encode(content.content);
  const decoded = globalThis.atob(content.content);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

/** Recompute the downloaded bytes; a matching response header alone is not trusted. */
export function deliveryContentMatchesHash(content: DeliveryReleaseContentV1, expectedHash: string): boolean {
  return content.sha256 === expectedHash && sha256Bytes(deliveryContentBytes(content)) === expectedHash;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalJsonValue(source[key]);
    }
    return sorted;
  }
  return value;
}

/** Return the exact canonical-json.v1 bytes covered by Core's manifest_hash. */
export function deliveryManifestBytes(manifest: DeliveryManifestV1): Uint8Array {
  const { manifest_hash: _manifestHash, ...sealedManifest } = manifest;
  return new TextEncoder().encode(JSON.stringify(canonicalJsonValue(sealedManifest)));
}

/** Refuse to download a manifest whose response fields do not reproduce its sealed digest. */
export function deliveryManifestMatchesHash(manifest: DeliveryManifestV1): boolean {
  return sha256Bytes(deliveryManifestBytes(manifest)) === manifest.manifest_hash;
}
