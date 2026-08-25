/**
 * P4 process projection. The browser owns no stage list: node order, copy and
 * required checks all come from Core's immutable process-profile.v1 response.
 */
import type {
  P4GateId,
  ProcessProfileCheckV1,
  ProcessProfileNodeV1,
  ProcessProfileV1,
  ProcessReadinessV1,
  ProcessStateV1,
} from "../api/types.ts";
import { sha256Hex } from "../util/sha256.ts";

const HASH_RE = /^[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const GATES: readonly P4GateId[] = ["G0", "G1", "G2", "G3", "G4"];

export class ProcessContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessContractError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProcessContractError(`${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  const row = record(value, path);
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ProcessContractError(`${path} 字段不符合 v1 契约`);
  }
  return row;
}

function text(value: unknown, path: string, safeId = false): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw new ProcessContractError(`${path} 必须是非空安全字符串`);
  }
  if (safeId && !SAFE_ID_RE.test(value)) throw new ProcessContractError(`${path} 不是安全标识`);
  return value;
}

function hash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH_RE.test(value)) throw new ProcessContractError(`${path} 不是 SHA-256`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ProcessContractError(`${path} 必须是布尔值`);
  return value;
}

function parseCheck(value: unknown, path: string): ProcessProfileCheckV1 {
  const row = exactRecord(value, ["code", "severity"], path);
  const severity = row.severity;
  if (severity !== "hard" && severity !== "advisory") throw new ProcessContractError(`${path}.severity 非法`);
  return { code: text(row.code, `${path}.code`), severity };
}

function parseNode(value: unknown, index: number): ProcessProfileNodeV1 {
  const path = `profile.nodes[${index}]`;
  const row = exactRecord(
    value,
    ["activities", "goal", "id", "kind", "milestoneBaseline", "name", "ordinal", "requiredChecks"],
    path,
  );
  if (row.id !== GATES[index]) throw new ProcessContractError(`${path}.id/ordinal 必须连续覆盖 G0-G4`);
  const id = GATES[index]!;
  if (row.kind !== "gate" || row.ordinal !== index) throw new ProcessContractError(`${path} 不是规范 gate 节点`);
  if (!Array.isArray(row.activities) || row.activities.length === 0) throw new ProcessContractError(`${path}.activities 不能为空`);
  if (!Array.isArray(row.requiredChecks) || row.requiredChecks.length === 0) throw new ProcessContractError(`${path}.requiredChecks 不能为空`);
  const activities = row.activities.map((item, at) => text(item, `${path}.activities[${at}]`));
  const requiredChecks = row.requiredChecks.map((item, at) => parseCheck(item, `${path}.requiredChecks[${at}]`));
  if (new Set(activities).size !== activities.length || new Set(requiredChecks.map((item) => item.code)).size !== requiredChecks.length) {
    throw new ProcessContractError(`${path} 含重复活动或检查`);
  }
  const expectedBaseline = id === "G1" ? "B0" : id === "G3" ? "B1" : id === "G4" ? "B2" : null;
  if (row.milestoneBaseline !== expectedBaseline) throw new ProcessContractError(`${path}.milestoneBaseline 非法`);
  return {
    id,
    kind: "gate",
    ordinal: index,
    name: text(row.name, `${path}.name`),
    goal: text(row.goal, `${path}.goal`),
    activities,
    requiredChecks,
    milestoneBaseline: expectedBaseline,
  };
}

export function parseProcessProfile(value: unknown): ProcessProfileV1 {
  const row = exactRecord(value, ["id", "name", "nodes", "profileHash", "schema", "version"], "profile");
  if (row.schema !== "process-profile.v1" || row.id !== "GJB_REF_V1" || row.version !== "GJB_REF_V1") {
    throw new ProcessContractError("Core 返回了不支持的流程 profile");
  }
  if (!Array.isArray(row.nodes) || row.nodes.length !== GATES.length) {
    throw new ProcessContractError("GJB_REF_V1 必须且只能包含 G0-G4");
  }
  return {
    schema: "process-profile.v1",
    id: "GJB_REF_V1",
    version: "GJB_REF_V1",
    name: text(row.name, "profile.name"),
    nodes: row.nodes.map(parseNode),
    profileHash: hash(row.profileHash, "profile.profileHash"),
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, sortKeys(source[key])]));
  }
  return value;
}

export async function parseAndVerifyProcessProfile(value: unknown): Promise<ProcessProfileV1> {
  const profile = parseProcessProfile(value);
  const { profileHash, ...body } = profile;
  const computed = await sha256Hex(JSON.stringify(sortKeys(body)));
  if (computed !== profileHash) throw new ProcessContractError("流程定义摘要校验失败，已停止展示正式流程");
  return profile;
}

function parseReadiness(value: unknown): ProcessReadinessV1 | null {
  if (value === null) return null;
  const keys = [
    "boardRef", "clockConstraintsComplete", "confirmedBy", "constraintRevisionIds", "constraintsComplete",
    "dataScopeRecorded", "electricalConstraintsComplete", "generatedBy", "id", "pinConstraintsComplete",
    "readinessHash", "ready", "sourceMaterialsRecorded", "status", "targetPart", "toolchainProfileHash", "workspaceReady",
  ];
  const row = exactRecord(value, keys, "processState.readiness");
  if (row.status !== "draft" && row.status !== "confirmed") throw new ProcessContractError("readiness.status 非法");
  if (!Array.isArray(row.constraintRevisionIds)) throw new ProcessContractError("readiness.constraintRevisionIds 必须是数组");
  const generated = exactRecord(row.generatedBy, ["id", "type"], "readiness.generatedBy");
  const pin = bool(row.pinConstraintsComplete, "readiness.pinConstraintsComplete");
  const electrical = bool(row.electricalConstraintsComplete, "readiness.electricalConstraintsComplete");
  const clock = bool(row.clockConstraintsComplete, "readiness.clockConstraintsComplete");
  const complete = bool(row.constraintsComplete, "readiness.constraintsComplete");
  if (complete !== (pin && electrical && clock)) throw new ProcessContractError("readiness 约束结论自相矛盾");
  let confirmedBy: ProcessReadinessV1["confirmedBy"] = null;
  if (row.confirmedBy !== null) {
    const confirmed = exactRecord(row.confirmedBy, ["at", "id"], "readiness.confirmedBy");
    const at = text(confirmed.at, "readiness.confirmedBy.at");
    if (Number.isNaN(Date.parse(at))) throw new ProcessContractError("readiness 确认时间非法");
    confirmedBy = { id: text(confirmed.id, "readiness.confirmedBy.id", true), at };
  }
  if ((row.status === "confirmed") !== (confirmedBy !== null)) throw new ProcessContractError("readiness 确认事实不一致");
  const ready = bool(row.ready, "readiness.ready");
  if (ready && row.status !== "confirmed") throw new ProcessContractError("未确认的 readiness 不能 ready");
  const revisionIds = row.constraintRevisionIds.map((item, index) => text(item, `readiness.constraintRevisionIds[${index}]`, true));
  if (new Set(revisionIds).size !== revisionIds.length) throw new ProcessContractError("readiness 含重复约束修订");
  const toolchainProfileHash = row.toolchainProfileHash === null
    ? null
    : hash(row.toolchainProfileHash, "readiness.toolchainProfileHash");
  if (ready && toolchainProfileHash === null) throw new ProcessContractError("ready readiness 缺少工具链绑定");
  return {
    id: text(row.id, "readiness.id", true),
    status: row.status,
    ready,
    readinessHash: hash(row.readinessHash, "readiness.readinessHash"),
    targetPart: text(row.targetPart, "readiness.targetPart"),
    boardRef: text(row.boardRef, "readiness.boardRef"),
    workspaceReady: bool(row.workspaceReady, "readiness.workspaceReady"),
    dataScopeRecorded: bool(row.dataScopeRecorded, "readiness.dataScopeRecorded"),
    sourceMaterialsRecorded: bool(row.sourceMaterialsRecorded, "readiness.sourceMaterialsRecorded"),
    pinConstraintsComplete: pin,
    electricalConstraintsComplete: electrical,
    clockConstraintsComplete: clock,
    constraintsComplete: complete,
    toolchainProfileHash,
    constraintRevisionIds: revisionIds,
    generatedBy: {
      type: text(generated.type, "readiness.generatedBy.type", true),
      id: text(generated.id, "readiness.generatedBy.id", true),
    },
    confirmedBy,
  };
}

export function parseProcessState(value: unknown, expectedProjectId: string): ProcessStateV1 {
  const row = exactRecord(
    value,
    ["completed", "currentGate", "processInstanceId", "profileHash", "profileId", "projectId", "readiness", "schema", "workVersionId"],
    "processState",
  );
  if (row.schema !== "process-state.v1" || row.profileId !== "GJB_REF_V1") {
    throw new ProcessContractError("Core 返回了不支持的流程状态");
  }
  const projectId = text(row.projectId, "processState.projectId", true);
  if (projectId !== expectedProjectId) throw new ProcessContractError("Core 返回了其他项目的流程状态");
  if (typeof row.currentGate !== "string" || !GATES.includes(row.currentGate as P4GateId)) {
    throw new ProcessContractError("currentGate 必须是 G0-G4");
  }
  const completed = bool(row.completed, "processState.completed");
  if (completed && row.currentGate !== "G4") throw new ProcessContractError("完成态必须停在 G4");
  return {
    schema: "process-state.v1",
    projectId,
    processInstanceId: text(row.processInstanceId, "processState.processInstanceId", true),
    profileId: "GJB_REF_V1",
    profileHash: hash(row.profileHash, "processState.profileHash"),
    workVersionId: text(row.workVersionId, "processState.workVersionId", true),
    currentGate: row.currentGate as P4GateId,
    completed,
    readiness: parseReadiness(row.readiness),
  };
}

export type ProcessGateStatus = "done" | "current" | "gated" | "failed" | "pending";

export interface ProcessGateView {
  readonly node: ProcessProfileNodeV1;
  readonly status: ProcessGateStatus;
}

export function deriveProcessGateChain(
  profile: ProcessProfileV1 | null,
  state: ProcessStateV1 | null,
  latestSubmissionState: Readonly<Partial<Record<P4GateId, string>>> = {},
): readonly ProcessGateView[] | null {
  if (!profile || !state) return null;
  if (profile.id !== state.profileId || profile.profileHash !== state.profileHash) {
    throw new ProcessContractError("流程定义与项目状态摘要不一致");
  }
  const current = profile.nodes.findIndex((node) => node.id === state.currentGate);
  return profile.nodes.map((node, index) => {
    let status: ProcessGateStatus = index < current || state.completed ? "done" : index > current ? "pending" : "current";
    const submission = latestSubmissionState[node.id];
    if (index === current && (submission === "rejected" || submission === "failed")) status = "failed";
    else if (index === current && (submission === "in_review" || submission === "checking" || submission === "submitted")) status = "gated";
    else if (node.id === "G0" && index === current && state.readiness && !state.readiness.ready) status = "failed";
    return { node, status };
  });
}

export const PROCESS_GATE_STATUS_TEXT: Readonly<Record<ProcessGateStatus, string>> = {
  done: "已完成",
  current: "进行中",
  gated: "等待确认",
  failed: "被阻断",
  pending: "未开始",
};

export function processProgress(chain: readonly ProcessGateView[]): { readonly done: number; readonly total: number } {
  return { done: chain.filter((entry) => entry.status === "done").length, total: chain.length };
}

export function currentProcessGate(chain: readonly ProcessGateView[] | null): ProcessGateView | null {
  if (!chain?.length) return null;
  return chain.find((entry) => entry.status === "current" || entry.status === "gated" || entry.status === "failed")
    ?? [...chain].reverse().find((entry) => entry.status === "done")
    ?? chain[0]!;
}
