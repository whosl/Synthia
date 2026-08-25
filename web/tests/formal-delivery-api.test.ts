import { describe, expect, test } from "bun:test";
import type { ApiClient, RequestOptions } from "../src/api/client.ts";
import {
  approveGateSubmission,
  confirmFormalInput,
  confirmProjectReadiness,
  createChangeRequest,
  createFormalJob,
  createProjectReadiness,
  getDeliveryManifest,
  getDeliveryReleaseContent,
  getFormalInputApproval,
  getProcessProfile,
  getProcessState,
  listBitstreams,
  listDeliveryReleases,
  listGateEvaluations,
  listProjectReadiness,
  previewFormalInput,
  withdrawChangeRequest,
} from "../src/api/index.ts";

interface CapturedCall {
  readonly path: string;
  readonly options: RequestOptions;
}

function captureClient(): { readonly client: ApiClient; readonly calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const client = (async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
    calls.push({ path, options });
    return {} as T;
  }) as ApiClient;
  return { client, calls };
}

describe("P4 API routes", () => {
  test("read routes stay project scoped and encode resource identities", async () => {
    const { client, calls } = captureClient();
    await getProcessProfile(client, "GJB_REF_V1");
    await getProcessState(client, "project/one");
    await listProjectReadiness(client, "project/one");
    await listGateEvaluations(client, "project/one", "sub/4");
    await getFormalInputApproval(client, "project/one", "fia/1");
    await listBitstreams(client, "project/one");
    await listDeliveryReleases(client, "project/one");
    await getDeliveryManifest(client, "project/one", "rel/1");
    await getDeliveryReleaseContent(client, "project/one", "rel/1", "build/output.formal.bit");
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/process-versions/GJB_REF_V1/profile",
      "/api/v1/projects/project%2Fone/process-state",
      "/api/v1/projects/project%2Fone/readiness",
      "/api/v1/projects/project%2Fone/gate-submissions/sub%2F4/evaluations",
      "/api/v1/projects/project%2Fone/formal-input-approvals/fia%2F1",
      "/api/v1/projects/project%2Fone/bitstreams",
      "/api/v1/projects/project%2Fone/delivery-releases",
      "/api/v1/projects/project%2Fone/delivery-releases/rel%2F1/manifest",
      "/api/v1/projects/project%2Fone/delivery-releases/rel%2F1/content?path=build%2Foutput.formal.bit",
    ]);
  });

  test("every P4 write carries its stable idempotency key and frozen body", async () => {
    const { client, calls } = captureClient();
    const engineeringConfig = {
      schema: "engineering-config.v1" as const,
      targetPart: { value: "xc7k70t", state: "identified" as const },
      board: { ref: "kc705", state: "identified" as const },
      constraints: {
        pin: { state: "complete" as const, revisionIds: ["rev-xdc"] },
        electrical: { state: "complete" as const, revisionIds: ["rev-xdc"] },
        clock: { state: "complete" as const, revisionIds: ["rev-xdc"] },
      },
      dataScope: { classification: "D1" as const, description: "registered project files" },
      sourcePolicy: { confirmedOnly: true as const },
    };
    await createProjectReadiness(client, "p1", {
      id: "ready-1",
      work_version_id: "wv-1",
      engineering_config: engineeringConfig,
      source_snapshot_ids: [],
      workspace_expected_commit: "a".repeat(40),
      workspace_manifest_hash: "b".repeat(64),
      reason: "human reviewed configuration",
    }, "idem-ready");
    await confirmProjectReadiness(client, "p1", "ready-1", { reason: "confirmed" }, "idem-confirm-ready");
    const previewBody = { work_version_id: "wv-1", snapshot_id: "snap-4", readiness_id: "ready-1", authorized_task_id: "task-main" };
    await previewFormalInput(client, "p1", previewBody, "idem-preview");
    await confirmFormalInput(client, "p1", { ...previewBody, id: "fia-1", purpose: "g4_delivery", preview_hash: "c".repeat(64) }, "idem-fia");
    await createFormalJob(client, "p1", { operation: "implement", run_class_intent: "formal", formal_input_approval_id: "fia-1" }, "idem-job");
    await createChangeRequest(client, "p1", {
      id: "cr-1",
      work_version_id: "wv-2",
      base_delivery_release_id: "rel-1",
      reason: "change UART",
      affected_paths: ["rtl/uart.sv"],
      impact_gate: "G3",
    }, "idem-change");
    await withdrawChangeRequest(client, "p1", "cr-1", "superseded request", "idem-withdraw");

    expect(calls).toHaveLength(7);
    expect(calls.every((call) => call.options.method === "POST")).toBe(true);
    expect(calls.map((call) => call.options.headers?.["idempotency-key"])).toEqual([
      "idem-ready", "idem-confirm-ready", "idem-preview", "idem-fia", "idem-job", "idem-change", "idem-withdraw",
    ]);
    expect(calls[4]!.options.body).toEqual({
      operation: "implement",
      run_class_intent: "formal",
      formal_input_approval_id: "fia-1",
    });
    expect(calls[5]!.options.body).toEqual(expect.objectContaining({
      id: "cr-1",
      work_version_id: "wv-2",
      base_delivery_release_id: "rel-1",
    }));
    expect(calls[6]).toEqual({
      path: "/api/v1/projects/p1/change-requests/cr-1/withdraw",
      options: {
        method: "POST",
        body: { reason: "superseded request" },
        headers: { "idempotency-key": "idem-withdraw" },
      },
    });
  });

  test("G4 approval transports evaluation, sealed projection, release, and B2 identities together", async () => {
    const { client, calls } = captureClient();
    await approveGateSubmission(client, "p1", "sub-g4", {
      configuration_snapshot_id: "snap-4",
      approved_gate_result_id: "agr-sub-g4",
      approver_role: "quality",
      check_results_hash: "a".repeat(64),
      signed_at: "2026-08-24T00:00:00.000Z",
      signature_method: "platform_token",
      baseline_id: "bl-g4-1",
      gate_check_evaluation_id: "eval-g4-1",
      candidate_manifest_hash: "b".repeat(64),
      delivery_release_id: "rel-1",
    }, "idem-approve-g4");
    expect(calls[0]).toEqual({
      path: "/api/v1/projects/p1/gate-submissions/sub-g4/approve",
      options: {
        method: "POST",
        body: expect.objectContaining({
          baseline_id: "bl-g4-1",
          gate_check_evaluation_id: "eval-g4-1",
          candidate_manifest_hash: "b".repeat(64),
          delivery_release_id: "rel-1",
        }),
        headers: { "idempotency-key": "idem-approve-g4" },
      },
    });
  });
});
