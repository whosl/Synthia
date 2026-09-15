import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "../src/api/client.ts";
import {
  approveGateSubmission,
  confirmFormalInput,
  confirmProjectReadiness,
  createChangeRequest,
  createProjectReadiness,
  getDeliveryManifest,
  getDeliveryRelease,
  getDeliveryReleaseContent,
  getFormalInputApproval,
  getProcessProfile,
  getProcessState,
  getProjectWorkVersion,
  getWorkspaceTree,
  listBitstreams,
  listDeliveryReleases,
  listGateEvaluations,
  listGateSubmissions,
  listProjectReadiness,
  listTasks,
  previewFormalInput,
  withdrawChangeRequest,
} from "../src/api/index.ts";
import type { EngineeringConfigV1 } from "../src/api/types.ts";
import { deliveryContentMatchesHash } from "../src/domain/formal-delivery.ts";
import { parseAndVerifyProcessProfile } from "../src/domain/process-profile.ts";
import { LIVE_AGENT_ID } from "../src/mock/data.ts";
import {
  mockP4ArtifactRevision,
  resetMockP4State,
  restorePersistedMockP4State,
} from "../src/mock/p4.ts";
import { mockApiFetch } from "../src/mock/server.ts";

const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await mockApiFetch(input, init);
  if (!response) throw new Error(`unexpected non-mock request: ${String(input)}`);
  return response;
}) as typeof fetch;

const client = createClient({ fetchImpl: mockFetch });
const projectId = "p1";
let previousStorage: PropertyDescriptor | undefined;

function completeConfig(): EngineeringConfigV1 {
  const revisionId = mockP4ArtifactRevision(projectId).id;
  return {
    schema: "engineering-config.v1",
    targetPart: { value: "xc7k70tfbv676-1", state: "identified" },
    // The UI defaults an optional board reference to missing. Complete XDC
    // facts must remain internally consistent without inventing a board id.
    board: { ref: null, state: "missing" },
    constraints: {
      pin: { state: "complete", revisionIds: [revisionId] },
      electrical: { state: "complete", revisionIds: [revisionId] },
      clock: { state: "complete", revisionIds: [revisionId] },
    },
    dataScope: { classification: "D1", description: "项目源文件与已确认资料" },
    sourcePolicy: { confirmedOnly: true },
  };
}

beforeEach(() => {
  const stored = new Map<string, string>();
  const storage: Storage = {
    get length() { return stored.size; },
    clear: () => stored.clear(),
    getItem: (key) => stored.get(key) ?? null,
    key: (index) => [...stored.keys()][index] ?? null,
    removeItem: (key) => { stored.delete(key); },
    setItem: (key, value) => { stored.set(key, value); },
  };
  previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  resetMockP4State(projectId);
});

afterEach(() => {
  resetMockP4State(projectId);
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("P4 offline contract backend", () => {
  test("persists G0 → formal input → G4 sealed release → CR/withdraw without changing the old release", async () => {
    const profile = await parseAndVerifyProcessProfile(await getProcessProfile(client, "GJB_REF_V1"));
    expect(profile.nodes.map((node) => node.id)).toEqual(["G0", "G1", "G2", "G3", "G4"]);

    const initial = await getProcessState(client, projectId);
    expect(initial).toMatchObject({ currentGate: "G0", completed: false });
    expect(initial.workVersionId).toMatch(/^wv-/);
    const workspace = await getWorkspaceTree(client, projectId);
    expect(workspace.workspace_manifest_hash).toMatch(/^[0-9a-f]{64}$/);

    const readinessBody = {
      id: "ready-mock-p4",
      work_version_id: initial.workVersionId,
      engineering_config: completeConfig(),
      source_snapshot_ids: [],
      workspace_expected_commit: workspace.head_commit!,
      workspace_manifest_hash: workspace.workspace_manifest_hash!,
      reason: "P4 browser acceptance",
    };
    const readiness = await createProjectReadiness(client, projectId, readinessBody, "idem-ready");
    expect(readiness).toMatchObject({ state: "ready", status: "draft", constraints_complete: true });
    expect(await createProjectReadiness(client, projectId, readinessBody, "idem-ready")).toEqual(readiness);
    await expect(createProjectReadiness(client, projectId, {
      ...readinessBody,
      reason: "same key, different body",
    }, "idem-ready")).rejects.toMatchObject({ status: 409 });

    await confirmProjectReadiness(client, projectId, readiness.id, { reason: "人工核对完成" }, "idem-confirm-ready");
    const atG4 = await getProcessState(client, projectId);
    expect(atG4).toMatchObject({ currentGate: "G4", completed: false, workVersionId: initial.workVersionId });
    expect(atG4.readiness).toMatchObject({ ready: true, constraintsComplete: true });

    const tasksAtPreview = await listTasks(client, projectId);
    const mainAtPreview = tasksAtPreview.agents.find((task) => task.agent_id === LIVE_AGENT_ID)!;
    expect(mainAtPreview.formal_input?.status).toBe("awaiting_input_confirmation");
    const runtimePreview = mainAtPreview.formal_input!.preview;
    expect(await previewFormalInput(client, projectId, {
      work_version_id: runtimePreview.work_version_id,
      snapshot_id: runtimePreview.snapshot_id,
      readiness_id: runtimePreview.readiness_id,
      authorized_task_id: runtimePreview.authorized_task_id,
    }, "idem-preview")).toEqual(runtimePreview);

    const approval = await confirmFormalInput(client, projectId, {
      id: mainAtPreview.formal_input!.approval_id,
      work_version_id: runtimePreview.work_version_id,
      snapshot_id: runtimePreview.snapshot_id,
      readiness_id: runtimePreview.readiness_id,
      authorized_task_id: runtimePreview.authorized_task_id,
      purpose: "g4_delivery",
      preview_hash: runtimePreview.preview_hash,
    }, "idem-formal-confirm");
    expect(approval.input_hash).toBe(runtimePreview.input_hash);

    const tasksAwaitingGate = await listTasks(client, projectId);
    expect(tasksAwaitingGate.agents.find((task) => task.agent_id === LIVE_AGENT_ID)).toMatchObject({
      status: "awaiting_approval",
      awaiting_gate: "G4",
      formal_input: { status: "awaiting_gate_approval" },
    });
    const submissions = await listGateSubmissions(client, projectId, "in_review");
    expect(submissions).toHaveLength(1);
    const evaluation = (await listGateEvaluations(client, projectId, submissions[0]!.id))[0]!;
    expect(evaluation.items).toHaveLength(12);
    expect(evaluation.items.every((item) => item.passed)).toBe(true);
    expect((await listBitstreams(client, projectId))[0]).toMatchObject({
      class: "formal",
      input_hash: approval.input_hash,
      artifact_classification: "tool_run_evidence",
      usage_classification: "run_class_governed",
    });

    await approveGateSubmission(client, projectId, submissions[0]!.id, {
      configuration_snapshot_id: submissions[0]!.snapshot_id,
      approved_gate_result_id: `agr-${submissions[0]!.id}`,
      approver_role: "quality",
      check_results_hash: evaluation.result_hash,
      signed_at: new Date().toISOString(),
      signature_method: "platform_token",
      baseline_id: "bl-b2-mock",
      gate_check_evaluation_id: evaluation.id,
      candidate_manifest_hash: evaluation.sealed_projection_hash!,
      delivery_release_id: evaluation.delivery_release_id!,
    }, "idem-approve-g4");

    expect(await getProcessState(client, projectId)).toMatchObject({ currentGate: "G4", completed: true });
    const releases = await listDeliveryReleases(client, projectId);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ state: "sealed", version: 1, supersedes_release_id: null });
    const release = await getDeliveryRelease(client, projectId, releases[0]!.id);
    const manifest = await getDeliveryManifest(client, projectId, release.id);
    expect(manifest.manifest_hash).toBe(release.manifest_hash);
    expect(new Set(manifest.items.map((item) => item.category))).toEqual(new Set([
      "rtl", "tb", "constraint", "document", "run_result", "raw_evidence", "confirmation", "source", "bitstream",
    ]));
    const rtl = release.items.find((item) => item.path === "rtl/pwm.sv")!;
    expect(deliveryContentMatchesHash(await getDeliveryReleaseContent(client, projectId, release.id, rtl.path), rtl.sha256)).toBe(true);
    expect(restorePersistedMockP4State()).toBe(true);
    expect((await listDeliveryReleases(client, projectId))[0]!.id).toBe(release.id);

    const change = await createChangeRequest(client, projectId, {
      id: "cr-mock-p4",
      work_version_id: "wv-mock-p4-v2",
      base_delivery_release_id: release.id,
      reason: "修改 PWM 分辨率",
      affected_paths: ["rtl/pwm.sv"],
      impact_gate: "G3",
    }, "idem-change");
    expect(change).toMatchObject({ state: "open", project_work_version_id: "wv-mock-p4-v2" });
    expect(await getProcessState(client, projectId)).toMatchObject({ currentGate: "G3", completed: false, workVersionId: "wv-mock-p4-v2" });
    expect(await getProjectWorkVersion(client, projectId, change.project_work_version_id)).toMatchObject({ state: "working", origin: "change_request" });
    expect((await listDeliveryReleases(client, projectId))[0]).toMatchObject({ id: release.id, state: "sealed" });
    expect((await listTasks(client, projectId)).agents.find((task) => task.agent_id === LIVE_AGENT_ID)).toMatchObject({
      status: "succeeded",
      awaiting_gate: null,
      formal_input: null,
    });

    const withdrawn = await withdrawChangeRequest(client, projectId, change.id, "取消本次修改", "idem-withdraw");
    expect(withdrawn.state).toBe("withdrawn");
    expect(await getProcessState(client, projectId)).toMatchObject({ currentGate: "G4", completed: true, workVersionId: release.work_version_id });
    expect(await getFormalInputApproval(client, projectId, release.formal_input_approval_id)).toEqual(approval);
    expect((await listProjectReadiness(client, projectId)).some((row) => row.id === readiness.id)).toBe(true);
    expect((await listDeliveryReleases(client, projectId))[0]).toMatchObject({ id: release.id, state: "sealed" });
  });
});
