import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type BoundJumpPhaseResult,
  CeremonyFailure,
  JUMP_COMPUTER,
  JUMP_HOST,
  JUMP_IDENTITY_NAME,
  JUMP_IDENTITY_SID,
  type MasterAuditEvidence,
  type ProcessObservation,
  type RawProcessResult,
  SSH_PATH,
} from "./scripts/m4f-bound-jump-transport.ts";
import {
  BOUND_JUMP_ARGUMENTS_09,
  createBoundJumpTransport09,
  invokeBoundJumpPhase09,
  normalizeBoundJumpFailure09,
  redactSuccessfulPhase09,
  type BoundJumpFailureDetail09,
  type BoundJumpRuntime09,
} from "./scripts/m4f-bound-jump-transport-09.ts";

const PHASE = "jump-local-receiver-representation-09:diagnose";
const SECRET = "secret-command --token super-secret";
const SECRET_BASE64 = Buffer.from(SECRET).toString("base64");
const MASTER_NETWORK = [
  "p87062",
  "cssh",
  "f3",
  "tIPv4",
  "PTCP",
  "n100.123.31.75:65322->100.66.198.60:22",
  "TST=ESTABLISHED",
  "TQR=0",
  "TQS=0",
  "",
].join("\n");

describe("M4-F native stage-aware bound jump transport _09", () => {
  test("uses the exact frozen no-fallback child argv and accepts only CRLF-framed success", () => {
    const scenario = fixture();
    const result = createBoundJumpTransport09(scenario.runtime).invokeBoundJumpPhase09(PHASE, "artifact");
    expect(scenario.calls).toHaveLength(1);
    expect(scenario.calls[0]?.executable).toBe(SSH_PATH);
    expect(scenario.calls[0]?.args).toEqual(BOUND_JUMP_ARGUMENTS_09);
    expect(scenario.calls[0]?.args.slice(0, 4)).toEqual(["-T", "-o", "ControlPath=/private/tmp/synthia-m4f-jump.sock", "-o"]);
    expect(scenario.calls[0]?.args).toContain(JUMP_HOST);
    expect(scenario.calls[0]?.args).not.toContain("/private/tmp/synthia-m4f-jump.sock");
    expect(result.payload).toEqual({ schema: "answer.v1", status: "ok" });

    const lfOnly = fixture({ stdout: `${JSON.stringify(identity())}\n${JSON.stringify({ schema: "answer.v1" })}\n` });
    const failure = capture(() => createBoundJumpTransport09(lfOnly.runtime).invokeBoundJumpPhase09(PHASE, "artifact"));
    expect(failure.transport_stage).toBe("output_validation");
    expect(failure.effect_state).toBe("unknown");
  });

  test("proves not-started only before spawn and preserves a redacted audit cause", () => {
    const invalid = capture(() => createBoundJumpTransport09(fixture().runtime).invokeBoundJumpPhase09("BAD PHASE", "artifact"));
    expect(invalid).toMatchObject({
      phase: "unknown",
      transport_stage: "pre_audit",
      child_state: "not_started_proven",
      child_outcome_state: "not_started",
      effect_state: "not_started",
      retry_permitted: false,
    });

    const scenario = fixture({
      auditError: new CeremonyFailure({
        schema: "synthia-m4f-bound-transport-failure.v1",
        code: "M4F_BOUND_MASTER_CHECK_FAILED",
        process: rawProcess(1, null, null, SECRET, ""),
        raw_command: SECRET,
      }),
    });
    const audited = capture(() => createBoundJumpTransport09(scenario.runtime).invokeBoundJumpPhase09(PHASE, "artifact"));
    expect(audited).toMatchObject({
      transport_stage: "pre_audit",
      child_state: "not_started_proven",
      effect_state: "not_started",
      underlying_code: "M4F_BOUND_MASTER_CHECK_FAILED",
    });
    expect(audited.process?.stdout_length).toBe(Buffer.byteLength(SECRET));
    expect(JSON.stringify(audited)).not.toContain(SECRET);
    expect(JSON.stringify(audited)).not.toContain(SECRET_BASE64);
    expect(scenario.calls).toHaveLength(0);
  });

  test("spawn throws and returned error codes never claim a known child outcome", () => {
    const thrown = fixture({ spawnThrow: new Error(SECRET) });
    const thrownFailure = capture(() => createBoundJumpTransport09(thrown.runtime).invokeBoundJumpPhase09(PHASE, "artifact"));
    expect(thrownFailure).toMatchObject({
      transport_stage: "child_execution",
      child_state: "unknown",
      child_outcome_state: "unknown",
      effect_state: "unknown",
      underlying_code: "M4F_BOUND_PHASE_SPAWN_SYNC_FAILED",
      unexpected_type: "error",
    });
    expect(JSON.stringify(thrownFailure)).not.toContain(SECRET);

    for (const code of ["ENOENT", "ENOBUFS", "ETIMEDOUT", "SECRET_CODE"] as const) {
      const scenario = fixture({ raw: raw("", SECRET, null, null, code) });
      const failure = capture(() => createBoundJumpTransport09(scenario.runtime).invokeBoundJumpPhase09(PHASE, "artifact"));
      expect(failure).toMatchObject({
        transport_stage: "child_execution",
        child_state: "unknown",
        child_outcome_state: "ambiguous",
        effect_state: "unknown",
        underlying_code: "M4F_BOUND_PHASE_OUTCOME_AMBIGUOUS",
      });
      expect(failure.process?.error_code).toBe(code === "SECRET_CODE" ? "OTHER" : code);
      expect(failure.process?.outcome_ambiguous).toBe(true);
      expect(JSON.stringify(failure)).not.toContain(SECRET);
      expect(JSON.stringify(failure)).not.toContain(SECRET_BASE64);
      expect(JSON.stringify(failure)).not.toContain("SECRET_CODE");
    }
  });

  test("separates signal, known exit, post-audit, and output-validation outcomes", () => {
    const scenarios = [
      [fixture({ raw: raw("", "", null, "SIGTERM") }), "child_execution", "started", "ambiguous"],
      [fixture({ raw: raw("", "", 23) }), "child_execution", "started", "known"],
      [fixture({ secondAuditError: new Error(SECRET) }), "post_audit", "started", "ambiguous"],
      [fixture({ stdout: `${JSON.stringify(identity())}\r\nnot-json\r\n` }), "output_validation", "started", "known"],
    ] as const;
    for (const [scenario, stage, child, outcome] of scenarios) {
      const failure = capture(() => createBoundJumpTransport09(scenario.runtime).invokeBoundJumpPhase09(PHASE, "artifact"));
      expect(failure.transport_stage).toBe(stage);
      expect(failure.child_state).toBe(child);
      expect(failure.child_outcome_state).toBe(outcome);
      expect(failure.effect_state).toBe("unknown");
      expect(failure.retry_permitted).toBe(false);
      expect(JSON.stringify(failure)).not.toContain(SECRET);
    }
  });

  test("does not leak an invalid remote payload through validation failure evidence", () => {
    const payload = { schema: "answer.v1", raw_command: SECRET, nested: { token: SECRET_BASE64 } };
    const scenario = fixture({ stdout: `${JSON.stringify(identity())}\r\n${JSON.stringify(payload)}\r\n` });
    const observation = createBoundJumpTransport09(scenario.runtime).invokeBoundJumpPhase09(PHASE, "artifact");
    const redacted = redactSuccessfulPhase09(observation);
    expect(redacted).not.toHaveProperty("identity");
    expect(redacted).not.toHaveProperty("payload");
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(JSON.stringify(redacted)).not.toContain(SECRET_BASE64);
    expect(redacted.process.stdout_length).toBeGreaterThan(0);
    expect(redacted.process.stdout_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("normalizes forged matching-schema failures instead of passing them through", () => {
    for (const forged of [
      {
        schema: "synthia-m4f-bound-phase-failure-09.v1",
        code: "M4F_BOUND_PHASE_09_FAILED",
        phase: PHASE,
        transport_stage: "pre_audit",
        child_state: "not_started_proven",
        child_outcome_state: "not_started",
        effect_state: "not_started",
        retry_permitted: false,
        raw_command: SECRET,
      },
      {
        schema: "synthia-m4f-bound-phase-failure-09.v1",
        code: "M4F_BOUND_PHASE_09_FAILED",
        secret: SECRET_BASE64,
      },
    ]) {
      const failure = capture(() => invokeBoundJumpPhase09(PHASE, "artifact", {
        invokePhase: () => { throw new CeremonyFailure(forged); },
      }));
      expect(failure).toMatchObject({
        transport_stage: "unknown",
        child_state: "unknown",
        child_outcome_state: "unknown",
        effect_state: "unknown",
        retry_permitted: false,
        underlying_code: "M4F_BOUND_UNKNOWN_FAILURE",
      });
      expect(JSON.stringify(failure)).not.toContain(SECRET);
      expect(JSON.stringify(failure)).not.toContain(SECRET_BASE64);
      expect(failure).not.toHaveProperty("raw_command");
      expect(failure).not.toHaveProperty("secret");
    }
  });

  test("normalizes a caught native failure after the same error object is mutated and rethrown", () => {
    let native: CeremonyFailure;
    try {
      createBoundJumpTransport09(fixture({ raw: raw("", "", 9) }).runtime).invokeBoundJumpPhase09(PHASE, "artifact");
      throw new Error("expected native failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CeremonyFailure);
      native = error as CeremonyFailure;
    }
    native.detail.raw_command = SECRET;
    native.detail.effect_state = "not_started";
    (native.detail.process as Record<string, unknown>).secret = SECRET_BASE64;
    const failure = capture(() => invokeBoundJumpPhase09(PHASE, "artifact", {
      invokePhase: () => { throw native; },
    }));
    expect(failure).toMatchObject({
      transport_stage: "unknown",
      child_state: "unknown",
      child_outcome_state: "unknown",
      effect_state: "unknown",
      retry_permitted: false,
    });
    expect(failure).not.toHaveProperty("raw_command");
    expect(JSON.stringify(failure)).not.toContain(SECRET);
    expect(JSON.stringify(failure)).not.toContain(SECRET_BASE64);
  });

  test("rejects invalid UTF-8 as output validation without replacement decoding", () => {
    const bytes = Buffer.concat([Buffer.from(`${JSON.stringify(identity())}\r\n`, "utf8"), Buffer.from([0xc3, 0x28]), Buffer.from("\r\n")]);
    const scenario = fixture({ raw: { status: 0, signal: null, errorCode: null, stdout: bytes, stderr: Buffer.alloc(0) } });
    const failure = capture(() => createBoundJumpTransport09(scenario.runtime).invokeBoundJumpPhase09(PHASE, "artifact"));
    expect(failure).toMatchObject({
      transport_stage: "output_validation",
      child_state: "started",
      child_outcome_state: "known",
      effect_state: "unknown",
      retry_permitted: false,
    });
  });

  test("public normalization is always conservative for oversized and non-error values", () => {
    for (const value of [new Error(SECRET.repeat(100_000)), { schema: "synthia-m4f-bound-phase-failure-09.v1", secret: SECRET }, SECRET]) {
      const failure = normalizeBoundJumpFailure09(value, PHASE);
      expect(failure).toMatchObject({
        transport_stage: "unknown",
        child_state: "unknown",
        child_outcome_state: "unknown",
        effect_state: "unknown",
        retry_permitted: false,
      });
      expect(["error", "non_error"]).toContain(failure.unexpected_type);
      expect(JSON.stringify(failure)).not.toContain(SECRET);
    }
  });

  test("rejects master evidence unless network bytes, digest, fd, port, PID, and endpoints bind", () => {
    const valid = redactSuccessfulPhase09(phase());
    expect(valid.master_before.network_sha256).toBe(createHash("sha256").update(MASTER_NETWORK).digest("hex"));
    for (const mutate of [
      (master: MasterAuditEvidence) => { master.master_pid = 87_063; },
      (master: MasterAuditEvidence) => { master.network_connection.local_port = 65_323; },
      (master: MasterAuditEvidence) => { master.network_connection.fd = 4; },
      (master: MasterAuditEvidence) => { master.network_connection.remote_address = "100.66.198.61"; },
      (master: MasterAuditEvidence) => { master.network_sha256 = "0".repeat(64); },
      (master: MasterAuditEvidence) => { master.network_process.stdout_base64 = Buffer.from(`${MASTER_NETWORK}extra`).toString("base64"); },
    ]) {
      const observation = phase();
      mutate(observation.master_before);
      expect(() => redactSuccessfulPhase09(observation)).toThrow(CeremonyFailure);
    }
  });
});

interface FixtureOptions {
  raw?: RawProcessResult;
  stdout?: string;
  spawnThrow?: unknown;
  auditError?: unknown;
  secondAuditError?: unknown;
}

function fixture(options: FixtureOptions = {}): {
  runtime: BoundJumpRuntime09;
  calls: Array<{ executable: string; args: readonly string[]; stdin: Uint8Array }>;
} {
  const calls: Array<{ executable: string; args: readonly string[]; stdin: Uint8Array }> = [];
  let auditCount = 0;
  const stdout = options.stdout ?? `${JSON.stringify(identity())}\r\n${JSON.stringify({ schema: "answer.v1", status: "ok" })}\r\n`;
  return {
    calls,
    runtime: {
      auditMaster() {
        auditCount += 1;
        if (auditCount === 1 && options.auditError !== undefined) throw options.auditError;
        if (auditCount === 2 && options.secondAuditError !== undefined) throw options.secondAuditError;
        return master();
      },
      spawn(executable, args, stdin) {
        calls.push({ executable, args, stdin });
        if (options.spawnThrow !== undefined) throw options.spawnThrow;
        return options.raw ?? raw(stdout);
      },
    },
  };
}

function raw(
  stdout = "",
  stderr = "",
  status: number | null = 0,
  signal: NodeJS.Signals | null = null,
  errorCode: string | null = null,
): RawProcessResult {
  return { status, signal, errorCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

function rawProcess(
  exitStatus: number | null,
  signal: NodeJS.Signals | null,
  errorCode: string | null,
  stdout: string,
  stderr: string,
): ProcessObservation {
  return {
    exit_status: exitStatus,
    signal,
    error_code: errorCode,
    stdout_base64: Buffer.from(stdout).toString("base64"),
    stderr_base64: Buffer.from(stderr).toString("base64"),
    timed_out: errorCode === "ETIMEDOUT",
    outcome_ambiguous: signal !== null || errorCode !== null || exitStatus === null,
    retry_permitted: false,
  };
}

function identity(): Record<string, unknown> {
  return {
    schema: "synthia-m4f-jump-identity.v1",
    computer_name: JUMP_COMPUTER,
    identity_name: JUMP_IDENTITY_NAME,
    identity_sid: JUMP_IDENTITY_SID,
  };
}

function master(): MasterAuditEvidence {
  return {
    schema: "synthia-m4f-bound-master-audit.v1",
    master_pid: 87_062,
    master_socket: "/private/tmp/synthia-m4f-jump.sock",
    known_hosts_path: "/Users/wenzhuolin/.ssh/known_hosts",
    host_key_fingerprint: "SHA256:I37M/4mZJwdlChfZyay+GSbhTuRKEQthOZW7sHmugh8",
    ssh_executable: "/usr/bin/ssh",
    master_effective_config_sha256: "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9",
    child_effective_config_sha256: "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8",
    network_sha256: createHash("sha256").update(MASTER_NETWORK).digest("hex"),
    network_process: rawProcess(0, null, null, MASTER_NETWORK, ""),
    network_connection: {
      fd: 3,
      protocol: "TCP",
      local_address: "100.123.31.75",
      local_port: 65_322,
      remote_address: "100.66.198.60",
      remote_port: 22,
      state: "ESTABLISHED",
    },
  };
}

function phase(): BoundJumpPhaseResult {
  const stdout = `${JSON.stringify(identity())}\r\n${JSON.stringify({ schema: "answer.v1", status: "ok" })}\r\n`;
  return {
    schema: "synthia-m4f-bound-phase.v1",
    phase: PHASE,
    identity: identity(),
    payload: { schema: "answer.v1", status: "ok" },
    process: rawProcess(0, null, null, stdout, ""),
    input: {
      artifact_length: 8,
      artifact_sha256: "a".repeat(64),
      stdin_length: 13,
      stdin_sha256: "b".repeat(64),
      receiver_source_length: 1_220,
      receiver_source_sha256: "c".repeat(64),
      receiver_encoded_length: 3_256,
      receiver_encoded_sha256: "d".repeat(64),
      receiver_command_length: 3_346,
      receiver_command_maximum: 8_192,
    },
    master_before: master(),
    master_after: master(),
  };
}

function capture(action: () => unknown): BoundJumpFailureDetail09 {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CeremonyFailure);
    return (error as CeremonyFailure).detail as unknown as BoundJumpFailureDetail09;
  }
  throw new Error("expected failure");
}
