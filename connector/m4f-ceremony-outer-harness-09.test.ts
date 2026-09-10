import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  classifyAttemptEvidence09,
  reportOuterHarnessResult09,
  runBoundedChild09ForTest,
  runOuterHarness09,
  verifyStaticPins09ForTest,
  type OuterHarnessChildInvocation09,
  type OuterHarnessChildOutcome09,
  type OuterHarnessFaults09,
  type OuterHarnessRequest09,
  type OuterHarnessRuntime09,
} from "./scripts/run-m4f-ceremony-outer-harness-09.ts";

const roots: string[] = [];
const HASH = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("M4-F durable ceremony outer harness _09", () => {
  test("binds sealed complete pins, fixed invocation, minimal confirmation env, and a hash-complete final manifest", async () => {
    let invocation: OuterHarnessChildInvocation09 | null = null;
    const result = await runOuterHarness09(fixture("success"), {}, runtime(async (value) => {
      invocation = value;
      writeSync(value.stdoutDescriptor, "out");
      writeSync(value.stderrDescriptor, "err");
      return outcome({ exitStatus: 23 });
    }));
    const attempt = json(result.markerPath);
    expect(attempt).toMatchObject({
      schema: "synthia-m4f-outer-harness-attempt-09.v1",
      state: "launching",
      invocation_count: 1,
      retry_permitted: false,
      effect_state_if_incomplete: "unknown",
      ceremony: "diagnostic",
      confirmation_env_name: "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_CONFIRMATION_09",
      confirmation_token_id: "receiver-representation-diagnostic-09",
      argv_count: 2,
    });
    expect(attempt).not.toHaveProperty("argv");
    expect(attempt).not.toHaveProperty("confirmation_env_value");
    expect(attempt.pins_manifest_sha256).toMatch(/^[0-9a-f]{64}$/u);
    const pins = attempt.verified_pins as Record<string, Record<string, unknown>>;
    expect(Object.keys(pins.files).sort()).toEqual([
      "diagnostic_artifact_file_09", "diagnostic_source_08", "diagnostic_source_09", "diagnostic_test_08",
      "diagnostic_test_09", "legacy_transport", "parse_artifact_file_09", "parse_source_08", "parse_source_09",
      "parse_test_08", "parse_test_09",
      "recorder_source_09", "recorder_test_09", "transport_source_09", "transport_test_09",
    ]);
    expect(Object.keys(pins.artifacts).sort()).toEqual(["diagnostic_artifact_09", "parse_artifact_09"]);
    expect(Object.keys(pins.runtime).sort()).toEqual(["length", "owner_uid", "path_sha256", "sha256", "version"]);
    expect(invocation?.executable).toBe(process.execPath);
    expect(invocation?.args).toHaveLength(1);
    expect(invocation?.args[0]).toEndWith("invoke-m4f-jump-local-receiver-representation-diagnostic-09.ts");
    expect(invocation?.env).toEqual({
      SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_CONFIRMATION_09:
        "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_20260827_09",
    });
    const child = json(result.resultPath);
    expect(child).toMatchObject({
      launch_invoked: true,
      child_start_state: "started",
      child_exit_status: 23,
      child_signal: null,
      child_error_code: null,
      timed_out: false,
      drain_complete: true,
      outcome_ambiguous: false,
      effect_state: "unknown",
      retry_permitted: false,
    });
    const finalization = json(result.finalizationPath);
    expect(Object.keys(finalization).sort()).toEqual([
      "attempt", "attempt_id", "child_result", "finalization_exit_code", "finalized_utc",
      "pins_manifest_sha256", "schema", "state", "stderr", "stdout",
    ]);
    expect(finalization).toMatchObject({
      state: "finalized",
      finalization_exit_code: 0,
      attempt: fact(result.markerPath),
      child_result: fact(result.resultPath),
      stdout: fact(join(result.attemptDirectory, "child.stdout")),
      stderr: fact(join(result.attemptDirectory, "child.stderr")),
      pins_manifest_sha256: attempt.pins_manifest_sha256,
    });
    expect(classifyAttemptEvidence09(result.attemptDirectory)).toBe("finalized_no_retry");
    expect(readdirSync(result.attemptDirectory).sort()).toEqual([
      "attempt.json", "child-result.json", "child.stderr", "child.stdout", "finalization.json",
    ]);
    for (const name of readdirSync(result.attemptDirectory)) {
      expect(lstatSync(join(result.attemptDirectory, name)).mode & 0o777).toBe(0o600);
    }
  });

  test("parse marker binds both target artifacts and both diagnostic and parse source/test pairs", async () => {
    let invocation: OuterHarnessChildInvocation09 | null = null;
    const result = await runOuterHarness09(fixture("parse", "parse"), {}, runtime(async (value) => {
      invocation = value;
      return outcome();
    }));
    const attempt = json(result.markerPath);
    expect(attempt).toMatchObject({
      ceremony: "parse",
      confirmation_env_name: "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_PARSE_GATE_CONFIRMATION_09",
      confirmation_token_id: "receiver-representation-parse-09",
    });
    expect(invocation?.args[0]).toEndWith("invoke-m4f-jump-local-receiver-representation-parse-gate-09.ts");
    expect(invocation?.env).toEqual({
      SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_PARSE_GATE_CONFIRMATION_09:
        "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_PARSE_GATE_20260827_09",
    });
  });

  test("static authority drift blocks every dynamic resolver and child invocation", async () => {
    const scripts = join(import.meta.dir, "scripts");
    expect(() => verifyStaticPins09ForTest(
      (path) => path === join(scripts, "invoke-m4f-jump-local-receiver-representation-diagnostic-09.ts")
        ? Buffer.from("globalThis.__m4fRecorderSentinel = true;", "utf8")
        : readFileSync(path),
    )).toThrow("M4F_OUTER_HARNESS_09_PIN_MISMATCH");
    expect((globalThis as Record<string, unknown>).__m4fRecorderSentinel).toBeUndefined();
    const source = readFileSync(join(scripts, "run-m4f-ceremony-outer-harness-09.ts"), "utf8");
    expect(source).not.toMatch(/await\s+import|import\s*\(/u);
  });

  test("caller cannot supply matching altered expected pins or a confirmation secret", async () => {
    const request = fixture("caller-authority") as OuterHarnessRequest09 & Record<string, unknown>;
    request.pins = { diagnostic_source_09: { length: 1, sha256: "0".repeat(64) } };
    request.confirmationEnvValue = "caller-secret";
    let invoked = false;
    await expect(runOuterHarness09(request, {}, runtime(async () => {
      invoked = true;
      return outcome();
    }))).rejects.toThrow("M4F_OUTER_HARNESS_09_REQUEST_INVALID");
    expect(invoked).toBe(false);
    expect(existsSync(join(request.evidenceRoot, request.attemptId))).toBe(false);
  });

  test("inert artifact drift is rejected by static authority without executing its bytes", () => {
    const artifactPath = join(import.meta.dir, "scripts", "m4f-jump-local-receiver-representation-diagnostic-09.ps1");
    expect(() => verifyStaticPins09ForTest(
      (path) => path === artifactPath ? Buffer.from("throw 'sentinel'", "utf8") : readFileSync(path),
    )).toThrow("M4F_OUTER_HARNESS_09_PIN_MISMATCH");
  });

  test("a durable prelaunch marker is permanently unknown and duplicate attempts never overwrite", async () => {
    const request = fixture("prelaunch-crash");
    await expect(runOuterHarness09(request, { beforeLaunch: crash }, runtime())).rejects.toThrow("simulated crash");
    const directory = join(request.evidenceRoot, request.attemptId);
    expect(classifyAttemptEvidence09(directory)).toBe("unknown_no_retry");
    expect(json(join(directory, "attempt.json"))).toMatchObject({
      state: "launching", invocation_count: 1, effect_state_if_incomplete: "unknown", retry_permitted: false,
    });
    expect(existsSync(join(directory, "child-result.json"))).toBe(false);
    await expect(runOuterHarness09(request, {}, runtime())).rejects.toThrow();
  });

  test("strict child outcome sanitizer never persists unknown or secret-shaped strings", async () => {
    const request = fixture("sanitize");
    const result = await runOuterHarness09(request, {}, runtime(async () => ({
      childStartState: "started",
      exitStatus: null,
      signal: "SECRET_SIGNAL_VALUE",
      errorCode: "SECRET_ERROR_VALUE",
      stdoutLimitExceeded: false,
      stderrLimitExceeded: false,
      timedOut: false,
      drainComplete: true,
    })));
    const child = json(result.resultPath);
    expect(child).toMatchObject({
      child_start_state: "unknown", child_exit_status: null, child_signal: null,
      child_error_code: "OTHER", outcome_ambiguous: true, effect_state: "unknown", retry_permitted: false,
    });
    expect(readFileSync(result.resultPath, "utf8")).not.toContain("SECRET_");
  });

  test("semantic contradiction started plus ENOENT collapses to unknown", async () => {
    const result = await runOuterHarness09(fixture("contradiction"), {}, runtime(async () => outcome({
      childStartState: "started", exitStatus: null, errorCode: "ENOENT",
    })));
    expect(json(result.resultPath)).toMatchObject({
      child_start_state: "unknown", child_error_code: "OTHER", outcome_ambiguous: true,
    });
  });

  test("not-started proof requires a fully drained spawn refusal", async () => {
    const result = await runOuterHarness09(fixture("undrained-refusal"), {}, runtime(async () => outcome({
      childStartState: "not_started_proven", exitStatus: null, errorCode: "ENOENT", drainComplete: false,
    })));
    expect(json(result.resultPath)).toMatchObject({
      child_start_state: "unknown", child_error_code: "OTHER", drain_complete: false, outcome_ambiguous: true,
    });
  });

  test("a post-spawn error can never downgrade monotonic started state to not-started proof", async () => {
    const root = temporaryRoot("spawn-monotonic");
    const stdoutDescriptor = openSync(join(root, "stdout"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const stderrDescriptor = openSync(join(root, "stderr"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    const pending = runBoundedChild09ForTest({
      executable: process.execPath, args: ["-e", ""], cwd: import.meta.dir, env: {}, stdoutDescriptor, stderrDescriptor,
    }, 1_000, 1_000, (() => child) as never);
    queueMicrotask(() => {
      child.emit("spawn");
      child.emit("error", Object.assign(new Error("late error"), { code: "ENOENT" }));
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    const observed = await pending;
    closeSync(stdoutDescriptor);
    closeSync(stderrDescriptor);
    expect(observed).toMatchObject({ childStartState: "started", exitStatus: 0, errorCode: "OTHER" });
  });

  test("outer watchdog kills, drains, and returns structured timeout evidence", async () => {
    const root = temporaryRoot("watchdog");
    const stdoutPath = join(root, "stdout");
    const stderrPath = join(root, "stderr");
    const stdoutDescriptor = openSync(stdoutPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const stderrDescriptor = openSync(stderrPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const child = await runBoundedChild09ForTest({
      executable: process.execPath,
      args: ["-e", "await new Promise(() => {})"],
      cwd: import.meta.dir,
      env: {},
      stdoutDescriptor,
      stderrDescriptor,
    }, 25, 1_000);
    closeSync(stdoutDescriptor);
    closeSync(stderrDescriptor);
    expect(child).toMatchObject({
      childStartState: "started", exitStatus: null, signal: "SIGKILL", errorCode: "ETIMEDOUT",
      timedOut: true, drainComplete: true,
    });
  });

  test("each stream is independently capped at 8 MiB and remains unknown/no-retry", async () => {
    const result = await runOuterHarness09(fixture("bounded"), {}, runtime(async (value) => {
      writeSync(value.stdoutDescriptor, Buffer.alloc(8 * 1024 * 1024));
      return outcome({ exitStatus: null, signal: "SIGKILL", errorCode: "EOVERFLOW", stdoutLimitExceeded: true });
    }));
    expect(lstatSync(join(result.attemptDirectory, "child.stdout")).size).toBe(8 * 1024 * 1024);
    expect(json(result.resultPath)).toMatchObject({
      stdout_limit_exceeded: true, outcome_ambiguous: true, effect_state: "unknown", retry_permitted: false,
    });
  });

  for (const fault of ["afterChildCloseBeforeStreamFsync", "beforeStdoutFsync", "beforeStderrFsync"] as const) {
    test(`stream durability failure at ${fault} cannot publish a child result`, async () => {
      const request = fixture(`stream-${fault}`);
      await expect(runOuterHarness09(request, { [fault]: crash }, runtime())).rejects.toThrow("simulated crash");
      const directory = join(request.evidenceRoot, request.attemptId);
      expect(existsSync(join(directory, "attempt.json"))).toBe(true);
      expect(existsSync(join(directory, "child-result.json"))).toBe(false);
      expect(classifyAttemptEvidence09(directory)).toBe("unknown_no_retry");
    });
  }

  for (const fault of [
    "beforeMarkerTempWrite", "afterMarkerTempWrite", "afterMarkerTempFsync", "beforeMarkerLink",
    "afterMarkerLink", "afterMarkerDirectoryFsync",
  ] as const) {
    test(`marker publication crash point ${fault} is absent or complete and never retryable once dir exists`, async () => {
      const request = fixture(`marker-${fault}`);
      await expect(runOuterHarness09(request, { [fault]: crash }, runtime())).rejects.toThrow("simulated crash");
      const directory = join(request.evidenceRoot, request.attemptId);
      const markerPath = join(directory, "attempt.json");
      if (existsSync(markerPath)) expectCanonical(markerPath);
      expect(classifyAttemptEvidence09(directory)).toBe("unknown_no_retry");
    });
  }

  for (const fault of [
    "beforeResultTempWrite", "afterResultTempWrite", "afterResultTempFsync", "beforeResultLink",
    "afterResultLink", "afterResultDirectoryFsync",
  ] as const) {
    test(`result publication crash point ${fault} is absent or complete and never finalized`, async () => {
      const request = fixture(`result-${fault}`);
      await expect(runOuterHarness09(request, { [fault]: crash }, runtime())).rejects.toThrow("simulated crash");
      const directory = join(request.evidenceRoot, request.attemptId);
      const resultPath = join(directory, "child-result.json");
      if (existsSync(resultPath)) {
        expectCanonical(resultPath);
        expect(classifyAttemptEvidence09(directory)).toBe("result_complete_unfinalized_no_retry");
      } else expect(classifyAttemptEvidence09(directory)).toBe("unknown_no_retry");
      expect(existsSync(join(directory, "finalization.json"))).toBe(false);
    });
  }

  for (const fault of [
    "beforeFinalizationTempWrite", "afterFinalizationTempWrite", "afterFinalizationTempFsync",
    "beforeFinalizationLink", "afterFinalizationLink", "afterFinalizationDirectoryFsync",
  ] as const) {
    test(`finalization publication crash point ${fault} is absent or complete`, async () => {
      const request = fixture(`final-${fault}`);
      await expect(runOuterHarness09(request, { [fault]: crash }, runtime())).rejects.toThrow("simulated crash");
      const directory = join(request.evidenceRoot, request.attemptId);
      const finalizationPath = join(directory, "finalization.json");
      if (existsSync(finalizationPath)) {
        expectCanonical(finalizationPath);
        expect(classifyAttemptEvidence09(directory)).toBe("finalized_no_retry");
      } else expect(classifyAttemptEvidence09(directory)).toBe("result_complete_unfinalized_no_retry");
    });
  }

  test("before mkdir is the only crash point with no occupied attempt", async () => {
    const request = fixture("before-mkdir");
    await expect(runOuterHarness09(request, { beforeAttemptDirectory: crash }, runtime())).rejects.toThrow();
    expect(classifyAttemptEvidence09(join(request.evidenceRoot, request.attemptId))).toBe("absent_retry_safe");
  });

  test("after directory fsync and during stream creation remain unknown/no-retry", async () => {
    for (const fault of ["afterAttemptDirectorySync", "afterStdoutCreate", "afterStderrCreate"] as const) {
      const request = fixture(`early-${fault}`);
      await expect(runOuterHarness09(request, { [fault]: crash }, runtime())).rejects.toThrow();
      expect(classifyAttemptEvidence09(join(request.evidenceRoot, request.attemptId))).toBe("unknown_no_retry");
    }
  });

  test("spawn refusal is exact and never falsely claims started", async () => {
    const result = await runOuterHarness09(fixture("enoent"), {}, runtime(async () => outcome({
      childStartState: "not_started_proven", exitStatus: null, errorCode: "ENOENT",
    })));
    expect(json(result.resultPath)).toMatchObject({
      launch_invoked: true, child_start_state: "not_started_proven", child_exit_status: null,
      child_error_code: "ENOENT", outcome_ambiguous: true, effect_state: "unknown", retry_permitted: false,
    });
  });

  test("stdout report failure cannot damage already finalized evidence", async () => {
    const result = await runOuterHarness09(fixture("report-failure"), {}, runtime());
    expect(() => reportOuterHarnessResult09(result, () => { throw new Error("stdout unavailable"); })).toThrow(
      "stdout unavailable",
    );
    expect(classifyAttemptEvidence09(result.attemptDirectory)).toBe("finalized_no_retry");
  });

  test("recovery requires a valid durable marker before accepting any retained result", async () => {
    const result = await runOuterHarness09(fixture("missing-marker"), {}, runtime());
    rmSync(result.markerPath);
    expect(classifyAttemptEvidence09(result.attemptDirectory)).toBe("unknown_no_retry");
  });

  for (const mutation of ["wrong-attempt", "bad-finished-time", "false-ambiguity"] as const) {
    test(`recovery rejects result coherence forgery ${mutation}`, async () => {
      const result = await runOuterHarness09(fixture(`forged-result-${mutation}`), {}, runtime());
      rmSync(result.finalizationPath);
      rewriteJson(result.resultPath, (value) => {
        if (mutation === "wrong-attempt") value.attempt_id = "another-attempt";
        if (mutation === "bad-finished-time") value.finished_utc = "not-a-time";
        if (mutation === "false-ambiguity") value.outcome_ambiguous = true;
      });
      expect(classifyAttemptEvidence09(result.attemptDirectory)).toBe("unknown_no_retry");
    });
  }

  test("arbitrary marker, zero manifest, and mismatched three-way IDs can never finalize", async () => {
    const result = await runOuterHarness09(fixture("forged-three-way"), {}, runtime());
    rewriteJson(result.markerPath, (value) => {
      value.attempt_id = "wrong-marker";
      value.pins_manifest_sha256 = "0".repeat(64);
      value.verified_pins = {};
    });
    rewriteJson(result.resultPath, (value) => { value.attempt_id = "wrong-result"; });
    rewriteJson(result.finalizationPath, (value) => { value.attempt_id = "wrong-finalization"; });
    expect(classifyAttemptEvidence09(result.attemptDirectory)).toBe("unknown_no_retry");
  });

  test("recovery binds UTC ordering, exact authority pins, and 0600 non-symlink evidence", async () => {
    const time = await runOuterHarness09(fixture("bad-final-time"), {}, runtime());
    rewriteJson(time.finalizationPath, (value) => { value.finalized_utc = "1970-01-01T00:00:00.000Z"; });
    expect(classifyAttemptEvidence09(time.attemptDirectory)).toBe("unknown_no_retry");

    const pins = await runOuterHarness09(fixture("bad-marker-pins"), {}, runtime());
    rewriteJson(pins.markerPath, (value) => { value.verified_pins = {}; });
    expect(classifyAttemptEvidence09(pins.attemptDirectory)).toBe("unknown_no_retry");

    const mode = await runOuterHarness09(fixture("bad-result-mode"), {}, runtime());
    chmodSync(mode.resultPath, 0o644);
    expect(classifyAttemptEvidence09(mode.attemptDirectory)).toBe("unknown_no_retry");
  });

  test("rejects unsafe roots, arbitrary ceremonies, ambient commands, and confirmation argv by construction", async () => {
    const unsafe = fixture("unsafe-root");
    chmodSync(unsafe.evidenceRoot, 0o755);
    await expect(runOuterHarness09(unsafe, {}, runtime())).rejects.toThrow("M4F_OUTER_HARNESS_09_DIRECTORY_INVALID");
    const arbitrary = fixture("arbitrary");
    await expect(runOuterHarness09({ ...arbitrary, ceremony: "other" as "diagnostic" }, {}, runtime())).rejects.toThrow(
      "M4F_OUTER_HARNESS_09_REQUEST_INVALID",
    );
    const source = readFileSync(join(import.meta.dir, "scripts", "run-m4f-ceremony-outer-harness-09.ts"), "utf8");
    expect(source).not.toMatch(/spawnSync|process\.env|env:\s*process\.env|renameSync|confirmationEnvValue:\s*args|\beval\b/iu);
    expect(source).toContain("linkSync(temporary, path)");
    expect(source).toContain("OUTER_WATCHDOG_MILLISECONDS = 105_000");
    expect(source).toContain("if (args.length !== 3)");
  });
});

function crash(): never {
  throw new Error("simulated crash");
}

function outcome(overrides: Partial<OuterHarnessChildOutcome09> = {}): OuterHarnessChildOutcome09 {
  return {
    childStartState: "started",
    exitStatus: 0,
    signal: null,
    errorCode: null,
    stdoutLimitExceeded: false,
    stderrLimitExceeded: false,
    timedOut: false,
    drainComplete: true,
    ...overrides,
  };
}

function runtime(runChild: OuterHarnessRuntime09["runChild"] = async () => outcome()): OuterHarnessRuntime09 {
  return { runChild };
}

function temporaryRoot(suffix: string): string {
  const root = mkdtempSync(join(tmpdir(), `m4f-harness-09-${suffix}-`));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function fixture(attemptId: string, ceremony: "diagnostic" | "parse" = "diagnostic"): OuterHarnessRequest09 {
  return { evidenceRoot: temporaryRoot(attemptId), attemptId, ceremony };
}

function fact(path: string): { length: number; sha256: string } {
  const bytes = readFileSync(path);
  return { length: bytes.length, sha256: HASH(bytes) };
}

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function expectCanonical(path: string): void {
  const bytes = readFileSync(path, "utf8");
  expect(`${JSON.stringify(JSON.parse(bytes))}\n`).toBe(bytes);
}

function rewriteJson(path: string, mutate: (value: Record<string, unknown>) => void): void {
  const value = json(path);
  mutate(value);
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}
