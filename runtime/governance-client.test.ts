import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { GJB_REF_V1_PROFILE } from "../core/src/services/process-profile.ts";
import { CoreGovernanceClient, MockGovernanceClient, GovernanceError } from "./governance-client.ts";
import { NoGovernanceClient } from "./types.ts";

// ---------------------------------------------------------------------------
// MockGovernanceClient — deterministic id generation and recording
// ---------------------------------------------------------------------------

describe("MockGovernanceClient", () => {
  test("registerCandidateArtifact records artifact with correct fields", async () => {
    const gov = new MockGovernanceClient();
    const rev = await gov.registerCandidateArtifact({
      artifactId: "art-1",
      artifactType: "DEVELOPMENT_REQUIREMENTS",
      title: "Intake Summary",
      content: "# Intake\n## Task\n8-bit counter.",
      contentLocation: "doc/intake/summary.md",
      version: 1,
    });
    expect(rev.artifactId).toBe("art-1");
    expect(rev.version).toBe(1);
    expect(rev.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(gov.registeredArtifacts).toHaveLength(1);
    expect(gov.registeredArtifacts[0]!.artifactType).toBe("DEVELOPMENT_REQUIREMENTS");
    expect(gov.registeredArtifacts[0]!.contentLocation).toBe("doc/intake/summary.md");
  });

  test("createSnapshot records member revisions", async () => {
    const gov = new MockGovernanceClient();
    const { snapshotId, manifestHash } = await gov.createSnapshot({
      memberRevisionIds: ["rev-1", "rev-2"],
      toolModelPolicyHash: "policy-v1",
    });
    expect(snapshotId).toBeTruthy();
    expect(manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(gov.snapshots).toHaveLength(1);
    expect(gov.snapshots[0]!.manifestHash).toBe(manifestHash);
    expect(gov.snapshots[0]!.memberRevisionIds).toEqual(["rev-1", "rev-2"]);
    expect(gov.snapshots[0]!.toolModelPolicyHash).toBe("policy-v1");
  });

  test("createGateSubmission records gate and snapshot", async () => {
    const gov = new MockGovernanceClient();
    const { submissionId } = await gov.createGateSubmission({
      processInstanceId: "pi-1",
      gate: "G1",
      snapshotId: "snap-1",
    });
    expect(submissionId).toBeTruthy();
    expect(gov.submissions).toHaveLength(1);
    expect(gov.submissions[0]!.gate).toBe("G1");
  });

  test("submitGate returns configurable state", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("in_review");
    const r1 = await gov.submitGate("sub-1");
    expect(r1.state).toBe("in_review");

    gov.setSubmitResult("approved");
    const r2 = await gov.submitGate("sub-2");
    expect(r2.state).toBe("approved");
  });

  test("getGateSubmissionState returns pre-set state", async () => {
    const gov = new MockGovernanceClient();
    gov.setGateState("sub-1", "approved");
    gov.setGateState("sub-2", "rejected");
    expect((await gov.getGateSubmissionState("sub-1")).state).toBe("approved");
    expect((await gov.getGateSubmissionState("sub-2")).state).toBe("rejected");
    // Default when not set → approved
    expect((await gov.getGateSubmissionState("sub-3")).state).toBe("approved");
  });
});

function canonicalMaterial(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const content = typeof overrides.content === "string" ? overrides.content : "# UART";
  return {
    project_id: "p1",
    snapshot_id: "imp-1",
    file_id: "file-1",
    path: "docs/uart.md",
    content,
    content_hash: createHash("sha256").update(content).digest("hex"),
    source_hash: "b".repeat(64),
    source_kind: "local_directory",
    source_project_id: null,
    source_name: "UART reference",
    expires_at: null,
    status: "confirmed",
    valid: true,
    searchable: true,
    ...overrides,
  };
}

function canonicalSearch(items: readonly Record<string, unknown>[], query = ""): unknown {
  return {
    data: {
      items,
      results: items,
      query,
      total: items.length,
    },
  };
}

function canonicalReadiness(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ready-1",
    status: "confirmed",
    ready: true,
    readinessHash: "b".repeat(64),
    targetPart: "xc7k70tfbv676-1",
    boardRef: "board-kc705-v1",
    workspaceReady: true,
    dataScopeRecorded: true,
    sourceMaterialsRecorded: true,
    pinConstraintsComplete: false,
    electricalConstraintsComplete: false,
    clockConstraintsComplete: true,
    constraintsComplete: false,
    toolchainProfileHash: "c".repeat(64),
    constraintRevisionIds: ["rev-xdc"],
    generatedBy: { type: "runtime", id: "runtime-1" },
    confirmedBy: { id: "human-1", at: "2026-08-24T10:00:00.000Z" },
    ...overrides,
  };
}

function canonicalProcessState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "process-state.v1",
    projectId: "p1",
    processInstanceId: "pi-1",
    workVersionId: "wv-1",
    profileId: "GJB_REF_V1",
    profileHash: GJB_REF_V1_PROFILE.profileHash,
    currentGate: "G0",
    completed: false,
    readiness: canonicalReadiness(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// NoGovernanceClient — auto-approves everything
// ---------------------------------------------------------------------------

describe("NoGovernanceClient", () => {
  test("auto-approves all gates and generates deterministic ids", async () => {
    const gov = new NoGovernanceClient();
    const rev = await gov.registerCandidateArtifact({
      artifactId: "art-1",
      artifactType: "RTL_SOURCE_SET",
      title: "RTL",
      content: "module counter; endmodule",
      contentLocation: "rtl/counter.v",
      version: 1,
    });
    expect(rev.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rev.version).toBe(1);

    const { snapshotId, manifestHash } = await gov.createSnapshot({
      memberRevisionIds: [rev.revisionId],
      toolModelPolicyHash: "policy",
    });
    expect(snapshotId).toContain("nogov");
    expect(manifestHash).toMatch(/^[0-9a-f]{64}$/);

    const profile = await gov.getProcessProfile("GJB_REF_V1");
    expect(profile.profileHash).toBe(GJB_REF_V1_PROFILE.profileHash);
    const processState = await gov.getProcessState("offline-project");
    expect(processState).toMatchObject({
      schema: "process-state.v1",
      profileId: "GJB_REF_V1",
      currentGate: "G0",
      completed: false,
      readiness: { status: "confirmed", ready: true, constraintsComplete: false },
    });

    const { submissionId } = await gov.createGateSubmission({
      processInstanceId: "pi", gate: "G1", snapshotId,
    });
    expect(submissionId).toContain("nogov");

    // Auto-approve
    const submitResult = await gov.submitGate(submissionId);
    expect(submitResult.state).toBe("approved");

    const pollResult = await gov.getGateSubmissionState(submissionId);
    expect(pollResult.state).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// CoreGovernanceClient — envelope unwrapping + retry logic (fake fetch)
// ---------------------------------------------------------------------------

describe("CoreGovernanceClient", () => {
  test("registerCandidateArtifact POSTs correct body and unwraps data", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      capturedHeaders = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ data: { id: "rev-123", version: 1 } }), { status: 201 });
    };
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core:8787", token: "tok", projectId: "p1",
      processInstanceId: "pi-1", fetchImpl,
    });
    const rev = await gov.registerCandidateArtifact({
      artifactId: "art-x", artifactType: "DEVELOPMENT_REQUIREMENTS",
      title: "Intake", content: "# doc", contentLocation: "doc/intake/summary.md",
      version: 1,
    });
    expect(rev.revisionId).toBe("rev-123");
    expect(rev.version).toBe(1);
    expect(capturedUrl).toBe("http://core:8787/api/v1/projects/p1/artifacts/art-x/revisions");
    expect(capturedBody.artifact_type).toBe("DEVELOPMENT_REQUIREMENTS");
    expect(capturedBody.content_hash).toMatch(/^[0-9a-f]{64}$/);
    // 正文内联，路径也一并送上——不送就只剩 `db://artifact_revision/<id>`，
    // 前端便无从知道这一版对应工作区里的哪个文件。
    expect(capturedBody.content).toBe("# doc");
    expect(capturedBody.content_location).toBe("doc/intake/summary.md");
    expect(capturedBody.version).toBe(1);
    expect(capturedHeaders.Authorization).toBe("Bearer tok");
    expect(capturedHeaders["Idempotency-Key"]).toBeTruthy();
  });

  test("createSnapshot POSTs member_revision_ids + tool_model_policy_hash", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ data: { id: "snap-1", manifestHash: "a".repeat(64) } }), { status: 201 });
    };
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      processInstanceId: "pi-1", fetchImpl,
    });
    const { snapshotId, manifestHash } = await gov.createSnapshot({
      memberRevisionIds: ["rev-a", "rev-b"],
      toolModelPolicyHash: "hash123",
    });
    expect(snapshotId).toBe("snap-1");
    expect(manifestHash).toBe("a".repeat(64));
    expect(capturedBody.member_revision_ids).toEqual(["rev-a", "rev-b"]);
    expect(capturedBody.tool_model_policy_hash).toBe("hash123");
  });

  test("createSnapshot rejects an omitted or malformed manifestHash", async () => {
    const responses = [
      { data: { id: "snap-1" } },
      { data: { id: "snap-1", manifestHash: "NOT-A-HASH" } },
    ];
    let index = 0;
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      fetchImpl: async () => new Response(JSON.stringify(responses[index++]!), { status: 201 }),
    });
    for (const _response of responses) {
      await expect(gov.createSnapshot({ memberRevisionIds: ["rev-a"], toolModelPolicyHash: "policy" }))
        .rejects.toMatchObject({ code: "SNAPSHOT_RESPONSE_INVALID" });
    }
  });

  test("createGateSubmission POSTs gate + snapshot_id + process_instance_id", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ data: { id: "sub-1" } }), { status: 201 });
    };
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      processInstanceId: "pi-1", fetchImpl,
    });
    const { submissionId } = await gov.createGateSubmission({
      processInstanceId: "pi-9", gate: "G3", snapshotId: "snap-1",
    });
    expect(submissionId).toBe("sub-1");
    expect(capturedBody.gate).toBe("G3");
    expect(capturedBody.snapshot_id).toBe("snap-1");
    expect(capturedBody.process_instance_id).toBe("pi-9");
  });

  test("submitGate POSTs to .../submit and returns state", async () => {
    let capturedUrl = "";
    const fetchImpl = async (url: string, _init: RequestInit) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ data: { state: "in_review" } }), { status: 200 });
    };
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      processInstanceId: "pi-1", fetchImpl,
    });
    const { state } = await gov.submitGate("sub-abc");
    expect(state).toBe("in_review");
    expect(capturedUrl).toBe("http://core/api/v1/projects/p1/gate-submissions/sub-abc/submit");
  });

  test("getGateSubmissionState GETs and returns state", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const fetchImpl = async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init.method;
      return new Response(JSON.stringify({ data: { state: "approved" } }), { status: 200 });
    };
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      processInstanceId: "pi-1", fetchImpl,
    });
    const { state } = await gov.getGateSubmissionState("sub-xyz");
    expect(state).toBe("approved");
    expect(capturedUrl).toBe("http://core/api/v1/projects/p1/gate-submissions/sub-xyz");
    expect(capturedMethod).toBe("GET");
  });

  test("getProjectInfo maps project type and process profile fields when Core exposes them", async () => {
    let capturedUrl = "";
    const fetchImpl = async (url: string, _init: RequestInit) => {
      capturedUrl = url;
      return new Response(JSON.stringify({
        data: {
          id: "p1",
          name: "UART TX",
          scope: "single module",
          status: "active",
          data_classification: "D1",
          standard_version: "GB/T 33781-2017",
          target_part: "xc7a100tcsg324-1",
          project_type: "engineering",
          process_version_id: "GJB_REF_V1",
          process_profile_id: "GJB_REF_V1",
          process_profile_name: "GJB reference flow",
          process_profile_version: "GJB_REF_V1",
          process_instances: [{
            id: "pi-1",
            current_gate: "G0",
            gate_profile_version: "flow-v1",
          }],
        },
      }), { status: 200 });
    };
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      processInstanceId: "pi-1", fetchImpl,
    });

    const info = await gov.getProjectInfo("p1");

    expect(capturedUrl).toBe("http://core/api/v1/projects/p1");
    expect(info.projectType).toBe("engineering");
    expect(info.processVersionId).toBe("GJB_REF_V1");
    expect(info.processProfileId).toBe("GJB_REF_V1");
    expect(info.processProfileName).toBe("GJB reference flow");
    expect(info.processProfileVersion).toBe("GJB_REF_V1");
    expect(info.processInstances[0]).toEqual({
      id: "pi-1",
      currentGate: "G0",
      gateProfileVersion: "flow-v1",
    });
  });

  test("getProjectInfo preserves explicit null process facts separately from omitted facts", async () => {
    let includeProcessFacts = true;
    const fetchImpl = async () => new Response(JSON.stringify({
      data: {
        id: "p-free",
        name: "Free project",
        scope: "",
        status: "active",
        data_classification: "D1",
        standard_version: "",
        target_part: null,
        project_type: "free",
        ...(includeProcessFacts ? {
          process_version_id: null,
          process_profile_id: null,
          process_profile_name: null,
          process_profile_version: null,
        } : {}),
        process_instances: [],
      },
    }), { status: 200 });
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p-free",
      processInstanceId: "pi-free", fetchImpl,
    });

    const explicitNull = await gov.getProjectInfo("p-free");
    for (const key of [
      "processVersionId",
      "processProfileId",
      "processProfileName",
      "processProfileVersion",
    ] as const) {
      expect(Object.hasOwn(explicitNull, key)).toBe(true);
      expect(explicitNull[key]).toBeNull();
    }

    includeProcessFacts = false;
    const omitted = await gov.getProjectInfo("p-free");
    for (const key of [
      "processVersionId",
      "processProfileId",
      "processProfileName",
      "processProfileVersion",
    ] as const) {
      expect(Object.hasOwn(omitted, key)).toBe(false);
    }
  });

  test("getProcessProfile reads the global endpoint and strictly verifies the Core profile", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedMethod = init?.method ?? "";
        return new Response(JSON.stringify({ data: GJB_REF_V1_PROFILE }), { status: 200 });
      },
    });

    const profile = await gov.getProcessProfile("GJB_REF_V1");

    expect(capturedUrl).toBe("http://core/api/v1/process-versions/GJB_REF_V1/profile");
    expect(capturedMethod).toBe("GET");
    expect(profile.profileHash).toBe(GJB_REF_V1_PROFILE.profileHash);
    expect(profile.nodes.map((node) => node.id)).toEqual(["G0", "G1", "G2", "G3", "G4"]);
  });

  test("getProcessProfile rejects malformed profiles and unsafe ids fail before fetch", async () => {
    let calls = 0;
    const invalidProfile = structuredClone(GJB_REF_V1_PROFILE) as unknown as Record<string, unknown>;
    invalidProfile.profileHash = "0".repeat(64);
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ data: invalidProfile }), { status: 200 });
      },
    });
    await expect(gov.getProcessProfile("GJB_REF_V1")).rejects.toMatchObject({ code: "PROCESS_PROFILE_INVALID" });
    expect(calls).toBe(1);
    await expect(gov.getProcessProfile("../GJB_REF_V1")).rejects.toMatchObject({ code: "validation" });
    expect(calls).toBe(1);
  });

  test("getProcessState maps the exact camelCase v1 projection including readiness", async () => {
    let capturedUrl = "";
    const state = canonicalProcessState();
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      fetchImpl: async (url) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({ data: state }), { status: 200 });
      },
    });

    const result = await gov.getProcessState("p1");

    expect(capturedUrl).toBe("http://core/api/v1/projects/p1/process-state");
    expect(result).toEqual(state);
    expect(result.readiness?.status === "confirmed" && result.readiness.ready).toBe(true);
    expect(result.readiness?.constraintsComplete).toBe(false);
  });

  test("getProcessState fails closed on cross-project, missing work, G5+, and inconsistent readiness", async () => {
    const states = [
      canonicalProcessState({ projectId: "p-other" }),
      canonicalProcessState({ workVersionId: undefined }),
      canonicalProcessState({ currentGate: "G5" }),
      canonicalProcessState({ readiness: { ...canonicalReadiness(), constraintsComplete: true } }),
    ];
    let index = 0;
    let calls = 0;
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ data: states[index++]! }), { status: 200 });
      },
    });
    await expect(gov.getProcessState("p1")).rejects.toMatchObject({ code: "PROJECT_OWNERSHIP_MISMATCH" });
    await expect(gov.getProcessState("p1")).rejects.toMatchObject({ code: "PROCESS_STATE_INVALID" });
    await expect(gov.getProcessState("p1")).rejects.toMatchObject({ code: "PROCESS_STATE_INVALID" });
    await expect(gov.getProcessState("p1")).rejects.toMatchObject({ code: "PROCESS_STATE_INVALID" });
    expect(calls).toBe(4);
    await expect(gov.getProcessState("p-other")).rejects.toMatchObject({ code: "PROJECT_OWNERSHIP_MISMATCH" });
    expect(calls).toBe(4);
  });

  test("searchImportedMaterials calls the project-scoped P2 endpoint and maps file rows", async () => {
    let capturedUrl = "";
    const fetchImpl = async (url: string, _init: RequestInit) => {
      capturedUrl = url;
      return new Response(JSON.stringify(canonicalSearch([canonicalMaterial()], "uart")), { status: 200 });
    };
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1", fetchImpl,
    });

    const rows = await gov.searchImportedMaterials("p1", { q: "uart", limit: 4 });

    expect(capturedUrl).toBe(
      "http://core/api/v1/projects/p1/import-snapshots/search?q=uart&limit=4&include_content=true",
    );
    expect(rows).toEqual([{
      projectId: "p1",
      snapshotId: "imp-1",
      fileId: "file-1",
      path: "docs/uart.md",
      content: "# UART",
      contentHash: createHash("sha256").update("# UART").digest("hex"),
      sourceHash: "b".repeat(64),
      sourceKind: "local_directory",
      sourceName: "UART reference",
      sourceProjectId: null,
      expiresAt: null,
      status: "confirmed",
      valid: true,
      searchable: true,
    }]);
  });

  test("searchImportedMaterials rejects aliases, nested detail shapes, and conflicting duplicate arrays", async () => {
    const payloads = [
      { data: [canonicalMaterial()] },
      { data: { results: [canonicalMaterial()], query: "", total: 1 } },
      { data: { snapshots: [{ ...canonicalMaterial(), entries: [canonicalMaterial()] }] } },
      { data: {
        items: [canonicalMaterial()],
        results: [canonicalMaterial({ status: "pending_confirmation" })],
        query: "",
        total: 1,
      } },
    ];
    let index = 0;
    const fetchImpl = async () => new Response(JSON.stringify(payloads[index++]!), { status: 200 });
    const gov = new CoreGovernanceClient({ baseUrl: "http://core", token: "t", projectId: "p1", fetchImpl });

    for (const _payload of payloads) {
      await expect(gov.searchImportedMaterials("p1")).rejects.toMatchObject({
        code: "HISTORICAL_MATERIAL_SHAPE_INVALID",
      });
    }
  });

  test("searchImportedMaterials rejects malformed or ownership-less rows", async () => {
    const fetchImpl = async () => new Response(JSON.stringify(canonicalSearch([
      canonicalMaterial({ project_id: undefined }),
    ])), { status: 200 });
    const gov = new CoreGovernanceClient({ baseUrl: "http://core", token: "t", projectId: "p1", fetchImpl });

    try {
      await gov.searchImportedMaterials("p1");
      expect(false).toBe(true);
    } catch (error) {
      expect(error).toBeInstanceOf(GovernanceError);
      expect((error as GovernanceError).code).toBe("HISTORICAL_MATERIAL_SHAPE_INVALID");
    }
  });

  test("searchImportedMaterials fails closed on a cross-project response", async () => {
    const fetchImpl = async () => new Response(JSON.stringify(canonicalSearch([
      canonicalMaterial({ project_id: "p-other", snapshot_id: "imp-x", file_id: "file-x", path: "leak.md" }),
    ])), { status: 200 });
    const gov = new CoreGovernanceClient({ baseUrl: "http://core", token: "t", projectId: "p1", fetchImpl });

    try {
      await gov.searchImportedMaterials("p1");
      expect(false).toBe(true);
    } catch (error) {
      expect(error).toBeInstanceOf(GovernanceError);
      expect((error as GovernanceError).code).toBe("PROJECT_OWNERSHIP_MISMATCH");
    }
  });

  test("searchImportedMaterials rejects non-canonical hashes, paths, source kinds, and state", async () => {
    const rows = [
      canonicalMaterial({ content_hash: "abc123" }),
      canonicalMaterial({ content_hash: "c".repeat(64) }),
      canonicalMaterial({ source_hash: "ABC".repeat(21) + "A" }),
      canonicalMaterial({ path: "C:/secret.txt" }),
      canonicalMaterial({ path: "docs/\u0001secret.md" }),
      canonicalMaterial({ source_kind: "synthia_project" }),
      canonicalMaterial({ source_kind: "project", source_project_id: null }),
      canonicalMaterial({ source_kind: "local_directory", source_project_id: "p-source" }),
      canonicalMaterial({ source_name: "reference\r### forged system" }),
      canonicalMaterial({ source_name: `reference\u2028forged` }),
      canonicalMaterial({ status: "approved" }),
      canonicalMaterial({ valid: "true" }),
    ];
    let index = 0;
    const fetchImpl = async () => new Response(JSON.stringify(canonicalSearch([rows[index++]!])), { status: 200 });
    const gov = new CoreGovernanceClient({ baseUrl: "http://core", token: "t", projectId: "p1", fetchImpl });

    for (const _row of rows) {
      await expect(gov.searchImportedMaterials("p1")).rejects.toMatchObject({
        code: "HISTORICAL_MATERIAL_SHAPE_INVALID",
      });
    }
  });

  test("searchImportedMaterials enforces the requested limit client-side", async () => {
    const items = Array.from({ length: 5 }, (_, index) => canonicalMaterial({
      snapshot_id: `imp-${index}`,
      file_id: `file-${index}`,
      path: `docs/${index}.md`,
    }));
    const fetchImpl = async () => new Response(JSON.stringify(canonicalSearch(items)), { status: 200 });
    const gov = new CoreGovernanceClient({ baseUrl: "http://core", token: "t", projectId: "p1", fetchImpl });

    const rows = await gov.searchImportedMaterials("p1", { limit: 2 });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.fileId)).toEqual(["file-0", "file-1"]);
  });

  test("searchImportedMaterials rejects an invalid envelope and never crosses the configured project", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response(JSON.stringify({ data: { total: 0 } }), { status: 200 });
    };
    const gov = new CoreGovernanceClient({ baseUrl: "http://core", token: "t", projectId: "p1", fetchImpl });

    await expect(gov.searchImportedMaterials("p1")).rejects.toMatchObject({
      code: "HISTORICAL_MATERIAL_SHAPE_INVALID",
    });
    expect(calls).toBe(1);
    await expect(gov.searchImportedMaterials("p-other")).rejects.toMatchObject({
      code: "PROJECT_OWNERSHIP_MISMATCH",
    });
    expect(calls).toBe(1);
  });

  test("4xx error surfaces immediately as GovernanceError", async () => {
    const fetchImpl = async () => new Response(
      JSON.stringify({ error: { code: "not_found", message: "submission not found" } }),
      { status: 404 },
    );
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      processInstanceId: "pi-1", fetchImpl, retryDelayMs: 0,
    });
    await expect(gov.getGateSubmissionState("missing")).rejects.toThrow();
    try {
      await gov.getGateSubmissionState("missing");
    } catch (e) {
      expect(e).toBeInstanceOf(GovernanceError);
      const ge = e as GovernanceError;
      expect(ge.code).toBe("not_found");
      expect(ge.httpStatus).toBe(404);
      expect(ge.retryable).toBe(false);
    }
  });

  test("5xx error retries once then surfaces", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { code: "capability_unavailable", message: "draining", retryable: true } }),
        { status: 503 },
      );
    };
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      processInstanceId: "pi-1", fetchImpl, retryDelayMs: 0,
    });
    await expect(gov.getGateSubmissionState("sub-1")).rejects.toThrow();
    expect(calls).toBe(2); // initial + 1 retry
  });

  test("network error retries once then surfaces as GovernanceError", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    };
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      processInstanceId: "pi-1", fetchImpl, retryDelayMs: 0,
    });
    try {
      await gov.getGateSubmissionState("sub-1");
      expect(false).toBe(true); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(GovernanceError);
      expect((e as GovernanceError).code).toBe("network_error");
    }
    expect(calls).toBe(2); // initial + 1 retry
  });

  test("content_hash matches sha256 of content", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ data: { id: "rev-1", version: 1 } }), { status: 201 });
    };
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      processInstanceId: "pi-1", fetchImpl,
    });
    await gov.registerCandidateArtifact({
      artifactId: "art-1", artifactType: "ARCHITECTURE_DESIGN",
      title: "Arch", content: "test content 123",
      contentLocation: "doc/arch/module_partition.md",
      version: 1,
    });
    expect(capturedBody.content_hash).toMatch(/^[0-9a-f]{64}$/);
    // content is inlined verbatim; content_location carries the workspace path
    expect(capturedBody.content).toBe("test content 123");
    expect(capturedBody.content_location).toBe("doc/arch/module_partition.md");
    // Verify it's actually the SHA-256 by re-computing
    const recomputed = createHash("sha256").update("test content 123").digest("hex");
    expect(capturedBody.content_hash).toBe(recomputed);
  });
});
