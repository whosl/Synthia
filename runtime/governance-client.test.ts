import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
    const { snapshotId } = await gov.createSnapshot({
      memberRevisionIds: ["rev-1", "rev-2"],
      toolModelPolicyHash: "policy-v1",
    });
    expect(snapshotId).toBeTruthy();
    expect(gov.snapshots).toHaveLength(1);
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

    const { snapshotId } = await gov.createSnapshot({
      memberRevisionIds: [rev.revisionId],
      toolModelPolicyHash: "policy",
    });
    expect(snapshotId).toContain("nogov");

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
    // content is inlined; content_location is no longer sent (server defaults it)
    expect(capturedBody.content).toBe("# doc");
    expect(capturedBody.content_location).toBeUndefined();
    expect(capturedBody.version).toBe(1);
    expect(capturedHeaders.Authorization).toBe("Bearer tok");
    expect(capturedHeaders["Idempotency-Key"]).toBeTruthy();
  });

  test("createSnapshot POSTs member_revision_ids + tool_model_policy_hash", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ data: { id: "snap-1" } }), { status: 201 });
    };
    const gov = new CoreGovernanceClient({
      baseUrl: "http://core", token: "t", projectId: "p1",
      processInstanceId: "pi-1", fetchImpl,
    });
    const { snapshotId } = await gov.createSnapshot({
      memberRevisionIds: ["rev-a", "rev-b"],
      toolModelPolicyHash: "hash123",
    });
    expect(snapshotId).toBe("snap-1");
    expect(capturedBody.member_revision_ids).toEqual(["rev-a", "rev-b"]);
    expect(capturedBody.tool_model_policy_hash).toBe("hash123");
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
    // content is inlined verbatim; content_location omitted
    expect(capturedBody.content).toBe("test content 123");
    expect(capturedBody.content_location).toBeUndefined();
    // Verify it's actually the SHA-256 by re-computing
    const recomputed = createHash("sha256").update("test content 123").digest("hex");
    expect(capturedBody.content_hash).toBe(recomputed);
  });
});
