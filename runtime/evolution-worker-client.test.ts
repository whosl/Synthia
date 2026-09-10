import { describe, expect, test } from "bun:test";
import {
  CoreCuratorEvolutionClient,
  CoreDistillerEvolutionClient,
  CoreSchedulerEvolutionClient,
  EvolutionWorkerClientError,
  type CuratorClaimV1,
  type CuratorCompleteRequestV1,
  type DistillationClaimV1,
  type DistillationCompleteRequestV1,
  type EvolutionLearnedSkillSummaryV1,
} from "./evolution-worker-client.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NOW = "2026-08-26T06:00:00.000Z";
const LATER = "2026-08-26T06:05:00.000Z";

function ok(data: unknown, correlationId = "corr-worker-1"): Response {
  return Response.json({ data, correlation_id: correlationId });
}

function apiError(
  status: number,
  code: string,
  retryable: boolean,
  details: unknown = null,
): Response {
  return Response.json({
    error: {
      code,
      message: code,
      retryable,
      details,
      correlation_id: "corr-error-1",
    },
  }, { status });
}

function distiller(fetchImpl: typeof fetch): CoreDistillerEvolutionClient {
  return new CoreDistillerEvolutionClient({
    baseUrl: "http://core.local/",
    distillerToken: "distiller.token/+opaque",
    fetchImpl,
    retryDelayMs: 0,
    sleep: async () => {},
  });
}

function curator(fetchImpl: typeof fetch): CoreCuratorEvolutionClient {
  return new CoreCuratorEvolutionClient({
    baseUrl: "http://core.local/",
    curatorToken: "curator.token/+opaque",
    fetchImpl,
    retryDelayMs: 0,
    sleep: async () => {},
  });
}

function scheduler(fetchImpl: typeof fetch): CoreSchedulerEvolutionClient {
  return new CoreSchedulerEvolutionClient({
    baseUrl: "http://core.local/",
    schedulerToken: "scheduler.token/+opaque",
    fetchImpl,
    retryDelayMs: 0,
    sleep: async () => {},
  });
}

function unknownMetrics(): EvolutionLearnedSkillSummaryV1["metrics"] {
  return {
    measurement_state: "unknown",
    primary_applied: 0,
    evaluated: 0,
    pending: 0,
    inconclusive: 0,
    success: 0,
    applicability_failure: 0,
    execution_failure: 0,
    success_rate: null,
    median_duration_ms: null,
    human_corrections: null,
    first_solved_problem_families: null,
  };
}

function skillSummary(): EvolutionLearnedSkillSummaryV1 {
  return {
    schema: "learned-skill-summary.v1",
    skill_id: "skill-1",
    slug: "timing-repair",
    name: "Timing repair",
    summary: "Repair generated clock constraints",
    applicability_summary: "Vivado timing",
    active_version_id: "version-1",
    active_version_no: 1,
    quality_state: "active_unproven",
    freshness_state: "current",
    availability_state: "available",
    enabled: true,
    pinned: false,
    recommended: true,
    control_revision: 1,
    last_used_at: null,
    metrics: unknownMetrics(),
  };
}

function distillationClaim(): DistillationClaimV1 {
  return {
    schema: "distillation-claim.v1",
    run: {
      run_id: "distill-1",
      state: "running",
      attempt: 1,
      lease_token: "lease.distiller/+opaque",
      lease_expires_at: LATER,
      episode: {
        episode_id: "episode-1",
        observation_key: "turn:turn-1",
        episode_key: "turn:turn-1:9",
        project_ref: "project-1",
        task_ref: "task-1",
        turn_id: "turn-1",
        end_event_sequence: 9,
        content_hash: HASH_A,
        outcome_claim: "fixed",
      },
      trajectory: {
        schema: "learning-trajectory.v1",
        objective: "remove the timing failure",
        messages: [{ sequence: 1, role: "user", content: "fix timing", content_hash: HASH_A }],
        tools: [{
          call_sequence: 2,
          result_sequence: 3,
          tool_call_id: "call-1",
          name: "vivado_synthesize",
          args: { top: "top" },
          args_hash: HASH_A,
          result: { status: "failed" },
          result_hash: HASH_B,
          is_error: true,
          tool_run_refs: ["job-1"],
          evidence_refs: ["evidence-1"],
        }],
        human_corrections: [{ sequence: 4, content: "use the generated clock", content_hash: HASH_B }],
      },
      existing_skills: [skillSummary()],
    },
  };
}

function applicationDetail(): CuratorClaimV1["run"] extends infer R
  ? R extends { applications: readonly (infer A)[] } ? A extends { application: infer D } ? D : never : never
  : never {
  return {
    schema: "skill-application-detail.v1",
    application_id: "application-1",
    project_ref: "redacted",
    task_ref: "redacted",
    observation_key: "turn:turn-1",
    episode_ref: "redacted",
    local_goal: "remove the timing failure",
    state: "pending_evaluation",
    started_at: NOW,
    closed_at: LATER,
    duration_ms: 300_000,
    human_corrections: 0,
    outcome_claim: "fixed",
    skills: [{
      skill_id: "skill-1",
      version_id: "version-1",
      role: "primary",
      reason_codes: ["matching_error_family"],
    }],
    evidence_summary: {
      visible: 0,
      redacted: 1,
      refs: [],
    },
    evaluations: [],
  };
}

function curatorClaim(): CuratorClaimV1 {
  return {
    schema: "curator-claim.v1",
    run: {
      run_id: "curator-1",
      mode: "run",
      state: "running",
      attempt: 2,
      lease_token: "lease.curator/+opaque",
      lease_expires_at: LATER,
      schedule_bucket: "2026-W35",
      eval_recovery: {
        budget_started_at: NOW,
        deadline_at: "2026-08-26T08:00:00.000Z",
        unknown_effect_latched_at: null,
        jobs: [],
      },
      applications: [{
        application: applicationDetail(),
        primary_version: {
          skill: skillSummary(),
          version_id: "version-1",
          content_manifest_hash: HASH_A,
          description: "Check generated clocks",
          applicability: { toolchain: "Vivado" },
          outcome_contract: { success: "timing failure is gone" },
          files: [{
            path: "SKILL.md",
            kind: "skill_md",
            language: "markdown",
            sha256: HASH_B,
            content: "# Timing repair",
          }],
        },
        eval_input: {
          eval_input_ref: "eval-input-1",
          input_manifest_hash: HASH_A,
          source_commit: "a".repeat(40),
          source_manifest_hash: HASH_B,
          allowed_operations: ["validate_sources", "simulate", "synthesize", "implement"],
          trial_bitstream_allowed: true,
          part: "xc7a35tcpg236-1",
          toolchain_profile_hash: HASH_A,
        },
        evidence_snapshot_hash: HASH_A,
        evidence: [{
          type: "tool_run",
          id: "job-1",
          sha256: HASH_B,
          summary: "Vivado synthesis evidence",
          content: null,
        }],
      }],
    },
  };
}

function noOpComplete(): DistillationCompleteRequestV1 {
  return {
    lease_token: "lease.distiller/+opaque",
    input_hash: HASH_A,
    model_id: "model-v1",
    prompt_hash: HASH_B,
    action: "no_op",
    expected_parent_version_id: null,
    expected_control_revision: null,
    skill: null,
  };
}

function curatorComplete(): CuratorCompleteRequestV1 {
  return {
    lease_token: "lease.curator/+opaque",
    evaluator_version: "curator-v1",
    evaluations: [{
      application_id: "application-1",
      evidence_snapshot_hash: HASH_A,
      outcome: "success",
      confidence: 0.95,
      reason: "the local timing goal is closed",
      evidence_refs: [{ type: "tool_run", id: "job-1" }],
      eval_job_refs: [],
      supersedes_id: null,
    }],
    remediations: [{
      skill_id: "skill-1",
      expected_active_version_id: "version-1",
      expected_control_revision: 1,
      action: "no_op",
    }],
  };
}

describe("CoreDistillerEvolutionClient", () => {
  test("claim uses only the A.4 route, token, and snake_case DTO", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = distiller((async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return ok(distillationClaim());
    }) as typeof fetch);

    const result = await client.claim({ worker_id: "distiller-worker-1", lease_seconds: 30 });
    expect(result.run).toMatchObject({ run_id: "distill-1", attempt: 1 });
    expect(result.run?.trajectory.tools[0]).toMatchObject({ tool_call_id: "call-1", is_error: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://core.local/api/v1/internal/evolution/distillation-runs/claim");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer distiller.token/+opaque");
    expect(headers.get("x-synthia-task-id")).toBeNull();
    expect(headers.get("idempotency-key")).toBeNull();
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      worker_id: "distiller-worker-1",
      lease_seconds: 30,
    });
  });

  test("renew, complete, and fail use exact A.4 bodies and typed results", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = distiller((async (input, init) => {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      if (url.endsWith("/lease")) {
        return ok({ schema: "distillation-lease.v1", run_id: "distill-1", lease_expires_at: LATER });
      }
      if (url.endsWith("/complete")) {
        return ok({
          schema: "distillation-result.v1",
          run_id: "distill-1",
          state: "noop",
          version_id: null,
          replayed: false,
        });
      }
      return ok({ schema: "distillation-failure.v1", run_id: "distill-1", state: "queued" });
    }) as typeof fetch);

    await expect(client.renewLease("distill-1", {
      lease_token: "lease.distiller/+opaque",
      lease_seconds: 900,
    })).resolves.toMatchObject({ schema: "distillation-lease.v1", lease_expires_at: LATER });
    await expect(client.complete("distill-1", noOpComplete())).resolves.toMatchObject({ state: "noop" });
    await expect(client.fail("distill-1", {
      lease_token: "lease.distiller/+opaque",
      error_code: "MODEL_UNAVAILABLE",
      retryable: true,
      details_hash: HASH_A,
    })).resolves.toMatchObject({ state: "queued" });

    expect(calls.map((call) => call.url)).toEqual([
      "http://core.local/api/v1/internal/evolution/distillation-runs/distill-1/lease",
      "http://core.local/api/v1/internal/evolution/distillation-runs/distill-1/complete",
      "http://core.local/api/v1/internal/evolution/distillation-runs/distill-1/fail",
    ]);
    expect(calls[0]!.body).toEqual({ lease_token: "lease.distiller/+opaque", lease_seconds: 900 });
    expect(calls[1]!.body).toEqual(noOpComplete());
    expect(calls[2]!.body).toEqual({
      lease_token: "lease.distiller/+opaque",
      error_code: "MODEL_UNAVAILABLE",
      retryable: true,
      details_hash: HASH_A,
    });
  });

  test("complete validates create/patch CAS invariants before touching Core", async () => {
    let calls = 0;
    const client = distiller((async () => {
      calls += 1;
      return ok({});
    }) as unknown as typeof fetch);
    const malformed = {
      ...noOpComplete(),
      action: "create",
      skill: {
        skill_id: "skill-existing",
        slug: "new-skill",
        name: "New skill",
        summary: "summary",
        description: "description",
        applicability: {},
        outcome_contract: {},
        files: [],
      },
    } as unknown as DistillationCompleteRequestV1;
    await expect(client.complete("distill-1", malformed)).rejects.toMatchObject({
      code: "evolution_contract_error",
      retryable: false,
    } satisfies Partial<EvolutionWorkerClientError>);
    expect(calls).toBe(0);
  });

  test("claim rejects zero-based episode and trajectory sequences", async () => {
    const invalid = structuredClone(distillationClaim()) as unknown as {
      run: { episode: { end_event_sequence: number } };
    };
    invalid.run.episode.end_event_sequence = 0;
    const client = distiller((async () => ok(invalid)) as unknown as typeof fetch);
    await expect(client.claim({ worker_id: "worker-1", lease_seconds: 60 })).rejects.toMatchObject({
      code: "evolution_contract_error",
      retryable: false,
    } satisfies Partial<EvolutionWorkerClientError>);
  });
});

describe("CoreCuratorEvolutionClient", () => {
  test("manual and scheduled claims use distinct routes with the Curator singleton token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = curator((async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return ok(curatorClaim());
    }) as typeof fetch);

    const result = await client.claimManual({ worker_id: "curator-worker-1", lease_seconds: 120 });
    await client.claimScheduled({ worker_id: "curator-worker-2", lease_seconds: 120 });
    expect(result.run).toMatchObject({ run_id: "curator-1", mode: "run", schedule_bucket: "2026-W35" });
    expect(result.run?.applications[0]).toMatchObject({
      application: { project_ref: "redacted", task_ref: "redacted" },
      evidence_snapshot_hash: HASH_A,
    });
    expect(calls[0]!.url).toBe("http://core.local/api/v1/internal/evolution/curator-runs/claim-manual");
    expect(calls[1]!.url).toBe("http://core.local/api/v1/internal/evolution/curator-runs/claim-scheduled");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer curator.token/+opaque");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      worker_id: "curator-worker-1",
      lease_seconds: 120,
    });
  });

  test("claim rejects the unfrozen recovery error_code extension", async () => {
    const invalid = structuredClone(curatorClaim()) as unknown as {
      run: { eval_recovery: { jobs: unknown[] } };
    };
    invalid.run.eval_recovery.jobs = [{
      eval_job_id: "job-1",
      tool_run_id: "tool-1",
      application_id: "application-1",
      version_id: "version-1",
      ordinal: 1,
      operation: "synthesize",
      state: "failed",
      error_code: "EVOLUTION_EVAL_NOT_ACCEPTED",
      workspace_id: "workspace-1",
      workspace_revision: 1,
      workspace_manifest_hash: HASH_A,
      workspace_sealed: true,
      evidence_state: "none",
      retention_state: "not_applicable",
      evidence_manifest_hash: null,
      reconciliation_state: "confirmed",
    }];
    const client = curator((async () => ok(invalid)) as unknown as typeof fetch);
    await expect(client.claimManual({ worker_id: "curator-worker-1", lease_seconds: 120 }))
      .rejects.toMatchObject({ code: "evolution_contract_error", retryable: false });
  });

  test("renew, complete, and fail use exact A.5 bodies and response identities", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const input = curatorComplete();
    const client = curator((async (rawUrl, init) => {
      const url = String(rawUrl);
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      if (url.endsWith("/lease")) {
        return ok({ schema: "curator-lease.v1", run_id: "curator-1", lease_expires_at: LATER });
      }
      if (url.endsWith("/complete")) {
        return ok({
          schema: "curator-result.v1",
          run_id: "curator-1",
          state: "completed",
          evaluation_ids: ["evaluation-1"],
          proposed_evaluations: [],
          produced_version_ids: [],
          skipped_actions: [],
          replayed: false,
        });
      }
      return ok({ schema: "curator-failure.v1", run_id: "curator-1", state: "failed" });
    }) as typeof fetch);

    await expect(client.renewLease("curator-1", {
      lease_token: "lease.curator/+opaque",
      lease_seconds: 30,
    })).resolves.toMatchObject({ schema: "curator-lease.v1" });
    await expect(client.complete("curator-1", input)).resolves.toMatchObject({
      state: "completed",
      evaluation_ids: ["evaluation-1"],
    });
    await expect(client.fail("curator-1", {
      lease_token: "lease.curator/+opaque",
      error_code: "EVALUATOR_FAILED",
      retryable: false,
      details_hash: HASH_B,
    })).resolves.toMatchObject({ state: "failed" });

    expect(calls[1]!.body).toEqual(input);
    expect(calls.every((call) => call.url.includes("/api/v1/internal/evolution/curator-runs/"))).toBe(true);
  });

  test("dry-run result retains proposed evaluations without inventing writes", async () => {
    const proposed = curatorComplete().evaluations[0]!;
    const client = curator((async () => ok({
      schema: "curator-result.v1",
      run_id: "curator-dry-1",
      state: "dry_run_complete",
      evaluation_ids: [],
      proposed_evaluations: [proposed],
      produced_version_ids: [],
      skipped_actions: [{ skill_id: "skill-1", action: "no_op", reason: "CAS changed" }],
      replayed: false,
    })) as unknown as typeof fetch);
    const result = await client.complete("curator-dry-1", curatorComplete());
    expect(result.proposed_evaluations[0]).toEqual(proposed);
    expect(result.skipped_actions[0]).toEqual({ skill_id: "skill-1", action: "no_op", reason: "CAS changed" });
  });
});

describe("CoreSchedulerEvolutionClient", () => {
  test.each(["queued", "no_work", "already_completed"] as const)(
    "ensureScheduled sends the exact request and parses canonical %s facts",
    async (state) => {
      let captured: { url: string; init: RequestInit } | undefined;
      const client = scheduler((async (input, init) => {
        captured = { url: String(input), init: init ?? {} };
        return ok({
          schema: "curator-schedule.v1",
          request_key: "host-cycle-hint",
          schedule_bucket: "scheduled:after:core-run-7",
          eligible_at: LATER,
          state,
          curator_run_id: state === "queued" ? "curator-scheduled-8" : null,
          reason_code: state === "queued" ? "materialized" : state,
          ...(state === "no_work" ? { retry_not_before: LATER } : {}),
          replayed: state !== "queued",
        });
      }) as typeof fetch);

      await expect(client.ensureScheduled({ request_key: "host-cycle-hint" }))
        .resolves.toMatchObject({
          state,
          schedule_bucket: "scheduled:after:core-run-7",
          eligible_at: LATER,
          retry_not_before: state === "no_work" ? LATER : null,
        });
      expect(captured?.url).toBe(
        "http://core.local/api/v1/internal/evolution/curator-runs/ensure-scheduled",
      );
      expect(new Headers(captured?.init.headers).get("authorization"))
        .toBe("Bearer scheduler.token/+opaque");
      expect(JSON.parse(String(captured?.init.body))).toEqual({ request_key: "host-cycle-hint" });
    },
  );

  test("scheduler auth failures and cancellation fail closed without token fallback", async () => {
    const denied = scheduler((async () => apiError(401, "UNAUTHORIZED", false)) as unknown as typeof fetch);
    await expect(denied.ensureScheduled({ request_key: "denied" })).rejects.toMatchObject({
      httpStatus: 401,
      code: "UNAUTHORIZED",
      retryable: false,
    });

    let signal: AbortSignal | undefined;
    const hung = scheduler((async (_input, init) => {
      signal = init?.signal as AbortSignal;
      return await new Promise<Response>(() => {});
    }) as typeof fetch);
    const controller = new AbortController();
    const request = hung.ensureScheduled({ request_key: "cancelled" }, controller.signal);
    controller.abort(new DOMException("service stopping", "AbortError"));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(signal?.aborted).toBe(true);
  });
});

describe("evolution worker transport and authority boundary", () => {
  test("transport aborts hung fetches on caller cancellation and request timeout", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return await new Promise<Response>(() => {});
    }) as typeof fetch;
    const cancelledClient = new CoreDistillerEvolutionClient({
      baseUrl: "http://core.local",
      distillerToken: "distiller.token/+opaque",
      fetchImpl,
      requestTimeoutMs: 1_000,
    });
    const controller = new AbortController();
    const cancelled = cancelledClient.claim({ worker_id: "worker-1", lease_seconds: 60 }, controller.signal);
    controller.abort(new DOMException("service stopping", "AbortError"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(signals[0]?.aborted).toBe(true);

    const timedClient = new CoreDistillerEvolutionClient({
      baseUrl: "http://core.local",
      distillerToken: "distiller.token/+opaque",
      fetchImpl,
      requestTimeoutMs: 5,
    });
    await expect(timedClient.claim({ worker_id: "worker-1", lease_seconds: 60 }))
      .rejects.toMatchObject({ code: "network_error", retryable: true });
    expect(signals[1]?.aborted).toBe(true);
  });

  test("rejects zero or missing-effective transport deadlines", () => {
    expect(() => new CoreDistillerEvolutionClient({
      baseUrl: "http://core.local",
      distillerToken: "token",
      requestTimeoutMs: 0,
    })).toThrow("requestTimeoutMs must be a positive safe integer");
  });

  test("both claim and renew enforce the frozen 30-900 second lease boundary", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return ok({});
    }) as unknown as typeof fetch;
    await expect(distiller(fetchImpl).claim({ worker_id: "worker-1", lease_seconds: 29 }))
      .rejects.toMatchObject({ code: "evolution_contract_error" });
    await expect(curator(fetchImpl).claimManual({ worker_id: "worker-1", lease_seconds: 901 }))
      .rejects.toMatchObject({ code: "evolution_contract_error" });
    await expect(distiller(fetchImpl).renewLease("run-1", { lease_token: "lease", lease_seconds: 29 }))
      .rejects.toMatchObject({ code: "evolution_contract_error" });
    await expect(curator(fetchImpl).renewLease("run-1", { lease_token: "lease", lease_seconds: 901 }))
      .rejects.toMatchObject({ code: "evolution_contract_error" });
    expect(calls).toBe(0);
  });

  test("renew retries network and retryable Core failures with byte-identical request facts", async () => {
    const calls: Array<{ authorization: string | null; body: string }> = [];
    let attempt = 0;
    const client = distiller((async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: String(init?.body),
      });
      attempt += 1;
      if (attempt === 1) throw new TypeError("connection reset");
      if (attempt === 2) return apiError(503, "CORE_BUSY", true);
      return ok({ schema: "distillation-lease.v1", run_id: "distill-1", lease_expires_at: LATER });
    }) as unknown as typeof fetch);

    // One request permits one retry. The first call exhausts its two network/5xx attempts.
    await expect(client.renewLease("distill-1", {
      lease_token: "lease.distiller/+opaque",
      lease_seconds: 60,
    })).rejects.toMatchObject({
      code: "CORE_BUSY",
      retryable: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);

    const result = await client.renewLease("distill-1", {
      lease_token: "lease.distiller/+opaque",
      lease_seconds: 60,
    });
    expect(result.run_id).toBe("distill-1");
    expect(calls).toHaveLength(3);
  });

  test("claim and fail never retry transparently after a response-lost network error", async () => {
    let claimCalls = 0;
    const claimClient = distiller((async () => {
      claimCalls += 1;
      throw new TypeError("response lost after claim");
    }) as unknown as typeof fetch);
    await expect(claimClient.claim({ worker_id: "worker-1", lease_seconds: 60 })).rejects.toMatchObject({
      code: "network_error",
      retryable: true,
    } satisfies Partial<EvolutionWorkerClientError>);
    expect(claimCalls).toBe(1);

    let failCalls = 0;
    const failClient = curator((async () => {
      failCalls += 1;
      throw new TypeError("response lost after fail");
    }) as unknown as typeof fetch);
    await expect(failClient.fail("curator-1", {
      lease_token: "lease.curator/+opaque",
      error_code: "EVALUATOR_FAILED",
      retryable: true,
      details_hash: HASH_A,
    })).rejects.toMatchObject({ code: "network_error" });
    expect(failCalls).toBe(1);
  });

  test("response-body network failures retry, while unserializable requests fail before fetch", async () => {
    let readAttempts = 0;
    const client = curator((async () => {
      readAttempts += 1;
      if (readAttempts === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => { throw new TypeError("body stream reset"); },
        } as unknown as Response;
      }
      return ok({ schema: "curator-lease.v1", run_id: "curator-1", lease_expires_at: LATER });
    }) as unknown as typeof fetch);
    await expect(client.renewLease("curator-1", { lease_token: "lease", lease_seconds: 60 }))
      .resolves.toEqual({ schema: "curator-lease.v1", run_id: "curator-1", lease_expires_at: LATER });
    expect(readAttempts).toBe(2);

    let writeCalls = 0;
    const writeClient = curator((async () => {
      writeCalls += 1;
      return ok({});
    }) as unknown as typeof fetch);
    const malformed: CuratorCompleteRequestV1 = {
      ...curatorComplete(),
      remediations: [{
        ...curatorComplete().remediations[0]!,
        patch: 1n,
      }],
    };
    await expect(writeClient.complete("curator-1", malformed)).rejects.toMatchObject({
      code: "evolution_contract_error",
      retryable: false,
    } satisfies Partial<EvolutionWorkerClientError>);
    expect(writeCalls).toBe(0);
  });

  test("stable Core conflicts are not retried and retain correlation/details", async () => {
    let calls = 0;
    const client = curator((async () => {
      calls += 1;
      return apiError(409, "EVOLUTION_LEASE_CONFLICT", false, { run_id: "curator-1" });
    }) as unknown as typeof fetch);
    await expect(client.renewLease("curator-1", {
      lease_token: "stale-token",
      lease_seconds: 60,
    })).rejects.toMatchObject({
      code: "EVOLUTION_LEASE_CONFLICT",
      httpStatus: 409,
      retryable: false,
      correlationId: "corr-error-1",
      details: { run_id: "curator-1" },
    } satisfies Partial<EvolutionWorkerClientError>);
    expect(calls).toBe(1);
  });

  test("malformed success envelopes fail closed", async () => {
    const client = distiller((async () => Response.json({
      data: { schema: "distillation-claim.v1", run: null },
    })) as unknown as typeof fetch);
    await expect(client.claim({ worker_id: "worker-1", lease_seconds: 60 })).rejects.toMatchObject({
      code: "evolution_contract_error",
      retryable: false,
    } satisfies Partial<EvolutionWorkerClientError>);
  });

  test("public clients expose only their authority-specific lifecycle operations", () => {
    expect(Object.getOwnPropertyNames(CoreDistillerEvolutionClient.prototype).sort()).toEqual([
      "claim",
      "complete",
      "constructor",
      "fail",
      "renewLease",
    ]);
    expect(Object.getOwnPropertyNames(CoreCuratorEvolutionClient.prototype).sort()).toEqual([
      "claimManual",
      "claimScheduled",
      "complete",
      "constructor",
      "fail",
      "renewLease",
    ]);
    expect(Object.getOwnPropertyNames(CoreSchedulerEvolutionClient.prototype).sort()).toEqual([
      "constructor",
      "ensureScheduled",
    ]);
  });
});
