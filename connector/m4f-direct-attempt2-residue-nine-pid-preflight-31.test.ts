import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  buildCandidate31Payload,
  candidate31Confirmation,
  candidate31HasForbiddenMutation,
  CANDIDATE30_EVIDENCE_DIRECTORY,
  CANDIDATE30_MANIFEST,
  CANDIDATE30_MANIFEST_SHA256,
  CANDIDATE30_RECORD_SHA256,
  CANDIDATE17_EVIDENCE_DIRECTORY,
  CANDIDATE17_MANIFEST,
  CANDIDATE17_MANIFEST_SHA256,
  CANDIDATE31_EVIDENCE_DIRECTORY,
  CANDIDATE31_ID,
  CANDIDATE31_TARGETS,
  Candidate31Failure,
  executeCandidate31,
  planCandidate31,
  validateCandidate31Config,
  validateCandidate31Output,
  type Candidate31Config,
  type Candidate31Dependencies,
} from "./scripts/m4f-direct-attempt2-residue-nine-pid-preflight-31.ts";
import type { RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const SOURCE = new URL("./scripts/m4f-direct-attempt2-residue-nine-pid-preflight-31.ts", import.meta.url).pathname;
const TEST_SOURCE = new URL("./m4f-direct-attempt2-residue-nine-pid-preflight-31.test.ts", import.meta.url).pathname;
const SIX_SOURCE = new URL("./scripts/m4f-direct-six-process-cleanup-19.ts", import.meta.url).pathname;
const SIX_TEST = new URL("./m4f-direct-six-process-cleanup-19.test.ts", import.meta.url).pathname;
const TRANSPORT_CONFIG = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const ORIGINAL_SIX_CONFIG = "/private/tmp/synthia-m4f-direct-six-process-cleanup-prod-20260829-19.json";
const EFFECTIVE = CANDIDATE30_EVIDENCE_DIRECTORY + "/ssh-effective-stdout.raw";
const WORKER_HASH = "e5d000e033425243c23868bbede8cbd67d09872e5379c05cf6b8371ef175998f";
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
type ProcessRow = [number, number, string, string, number, string | null, boolean, number | null, string | null];

function row(
  pid: number,
  parentPid: number,
  name: string,
  creation: string,
  executablePath: string | null = "C:\\Windows\\System32\\" + name,
  commandLength: number | null = 20,
  commandHash: string | null = "a".repeat(64),
): ProcessRow {
  return [pid, parentPid, name, creation, 0, executablePath, commandLength !== null, commandLength, commandHash];
}

function workerRow(): ProcessRow {
  return row(13644, 2712, "node.exe", "2026-08-14T08:02:31.2903580Z",
    "D:\\softwares\\Nodejs\\node.exe", 66, WORKER_HASH);
}

function baseMarkers(): Array<Record<string, unknown>> {
  const system = row(4, 0, "system", "2026-08-01T00:00:00.0000000Z", null, null, null);
  const services = row(2712, 4, "services.exe", "2026-08-02T00:00:00.0000000Z");
  const sshd = row(700, 4, "sshd.exe", "2026-08-01T00:00:00.5000000Z");
  const cmd = row(800, 700, "cmd.exe", "2026-08-30T00:00:00.1000000Z");
  const current = row(900, 800, "powershell.exe", "2026-08-30T00:00:00.2000000Z");
  const targets = CANDIDATE31_TARGETS.map((target) => [
    target.ordinal, target.pid, "absent", null, [], "absent", 0, "not_observed",
  ]);
  return [
    { s: "r31", id: CANDIDATE31_ID, n: 1, t: "start", z: "observed" },
    {
      s: "r31", id: CANDIDATE31_ID, n: 2, t: "snapshot", z: "observed",
      p: {
        cim_snapshot_count: 1, target_count: 9, current_process: current,
        current_chain: [cmd, sshd, system], current_chain_terminal: "zero", current_chain_terminal_pid: 0,
        targets, effective_present_set: [], diagnostic_root_pid: 700,
        diagnostic_tree: structuredClone([sshd, cmd, current]), diagnostic_tree_valid: true,
        protected_worker: workerRow(), protected_worker_exact: true,
        worker_ancestors: [services, system], worker_ancestor_terminal: "zero", worker_ancestor_terminal_pid: 0,
        worker_descendants: [workerRow()], worker_descendants_valid: true,
        listeners_8443: [["0.0.0.0", 8443, 13644]], listeners_18443: [],
        stdin_length: 0, decision: "observed",
      },
    },
    {
      s: "r31", id: CANDIDATE31_ID, n: 3, t: "complete", z: "complete",
      p: {
        retry_permitted: false, process_mutation_performed: false, file_mutation_performed: false,
        vivado_action_performed: false, hardware_action_performed: false, cleanup_performed: false,
        remote_file_write_performed: false, stdin_length: 0,
      },
    },
  ];
}

function output(change?: (markers: Array<Record<string, unknown>>) => void): Buffer {
  const markers = baseMarkers();
  change?.(markers);
  return Buffer.from(markers.map((marker) => JSON.stringify(marker)).join("\r\n") + "\r\n");
}

function snapshot(markers: Array<Record<string, unknown>>): Record<string, unknown> {
  return markers[1]!.p as Record<string, unknown>;
}

function setBlocked(markers: Array<Record<string, unknown>>): void {
  markers[1]!.z = "observed_blocked";
  snapshot(markers).decision = "observed_blocked";
}

function exactTarget(targetIndex = 0): unknown[] {
  const target = CANDIDATE31_TARGETS[targetIndex]!;
  const actual = row(target.pid, target.parent_pid, target.name, target.creation_utc,
    "C:\\Windows\\System32\\" + target.name, target.command_length ?? 123, target.command_sha256);
  const parent = row(target.parent_pid, 4, "parent.exe", "2026-08-01T00:00:01.0000000Z");
  const system = row(4, 0, "system", "2026-08-01T00:00:00.0000000Z", null, null, null);
  return [target.ordinal, target.pid, "exact", actual, [parent, system], "zero", 0, "captured_this_observation"];
}

function processResult(
  stdout: string | Buffer,
  stderr: string | Buffer = "",
  status: number | null = 0,
  errorCode: string | null = null,
): RawProcessResult {
  return {
    status, signal: null, errorCode,
    stdout: Buffer.isBuffer(stdout) ? Buffer.from(stdout) : Buffer.from(stdout),
    stderr: Buffer.isBuffer(stderr) ? Buffer.from(stderr) : Buffer.from(stderr),
  };
}

function fixture() {
  const files = new Map<string, Buffer>();
  for (const path of [SOURCE, TEST_SOURCE, SIX_SOURCE, SIX_TEST, TRANSPORT_CONFIG, ORIGINAL_SIX_CONFIG]) {
    files.set(path, readFileSync(path));
  }
  for (const name of Object.keys(CANDIDATE30_MANIFEST)) {
    const path = CANDIDATE30_EVIDENCE_DIRECTORY + "/" + name;
    files.set(path, readFileSync(path));
  }
  for (const name of Object.keys(CANDIDATE17_MANIFEST)) {
    const path = CANDIDATE17_EVIDENCE_DIRECTORY + "/" + name;
    files.set(path, readFileSync(path));
  }
  const config: Candidate31Config = {
    schema: "synthia-m4f-direct-attempt2-residue-nine-pid-preflight-31-config.v1",
    preflight_id: CANDIDATE31_ID,
    evidence_directory: CANDIDATE31_EVIDENCE_DIRECTORY,
    candidate30_evidence_directory: CANDIDATE30_EVIDENCE_DIRECTORY,
    candidate30_evidence_manifest_sha256: CANDIDATE30_MANIFEST_SHA256,
    candidate30_record_sha256: CANDIDATE30_RECORD_SHA256,
    candidate17_evidence_directory: CANDIDATE17_EVIDENCE_DIRECTORY,
    candidate17_evidence_manifest_sha256: CANDIDATE17_MANIFEST_SHA256,
    original_six_config_path: ORIGINAL_SIX_CONFIG,
    original_six_config_sha256: sha256(files.get(ORIGINAL_SIX_CONFIG)!),
    expected_source_sha256: sha256(files.get(SOURCE)!),
    expected_test_sha256: sha256(files.get(TEST_SOURCE)!),
    expected_six_source_sha256: sha256(files.get(SIX_SOURCE)!),
    expected_six_test_sha256: sha256(files.get(SIX_TEST)!),
  };
  const calls: Array<{ args: readonly string[]; stdin: Buffer; timeoutMs: number }> = [];
  const writes = new Map<string, Buffer>();
  let remote = processResult(output());
  let candidate17Entries = Object.keys(CANDIDATE17_MANIFEST).sort();
  let created = false;
  const dependencies: Candidate31Dependencies = {
    read(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error("missing:" + path);
      return Buffer.from(bytes);
    },
    entries(path) {
      if (path === CANDIDATE30_EVIDENCE_DIRECTORY) return Object.keys(CANDIDATE30_MANIFEST).sort();
      if (path === CANDIDATE17_EVIDENCE_DIRECTORY) return [...candidate17Entries];
      throw new Error("directory:" + path);
    },
    spawn(_executable, args, stdin, timeoutMs) {
      calls.push({ args: [...args], stdin: Buffer.from(stdin), timeoutMs });
      return args[0] === "-G" ? processResult(files.get(EFFECTIVE)!) : remote;
    },
    transportInputs: () => [{ sha256: "a".repeat(64) }],
    createEvidence(path) {
      if (created || path !== CANDIDATE31_EVIDENCE_DIRECTORY) throw new Error("create");
      created = true;
    },
    writeEvidence(path, bytes) {
      if (!created || writes.has(path)) throw new Error("write");
      writes.set(path, Buffer.from(bytes));
    },
    now: () => new Date("2026-08-30T18:00:00.000Z"),
  };
  return {
    config, dependencies, calls, writes,
    setRemote(value: RawProcessResult) { remote = value; },
    setFile(path: string, value: Buffer) { files.set(path, Buffer.from(value)); },
    setCandidate17Entries(value: string[]) { candidate17Entries = [...value]; },
  };
}

function failure(run: () => unknown): Candidate31Failure {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(Candidate31Failure);
    return error as Candidate31Failure;
  }
  throw new Error("expected failure");
}

describe("M4-F Candidate 31 nine-PID read-only preflight", () => {
  test("binds exactly Candidate30 and original-six lineage with strict config keys", () => {
    const value = fixture();
    expect(validateCandidate31Config(value.config)).toEqual(value.config);
    expect(CANDIDATE31_TARGETS.map((target) => target.pid)).toEqual([
      44768, 56576, 64484, 58908, 67048, 66316, 39016, 48664, 66340,
    ]);
    expect(new Set(CANDIDATE31_TARGETS.map((target) => target.pid)).size).toBe(9);
    expect(CANDIDATE31_TARGETS.slice(0, 6).map((target) => target.creation_utc)).toEqual([
      "2026-08-28T16:25:51.0137880Z",
      "2026-08-28T16:25:50.9870650Z",
      "2026-08-28T16:25:50.9908920Z",
      "2026-08-28T17:12:52.5233860Z",
      "2026-08-28T17:12:52.4952390Z",
      "2026-08-28T17:12:52.5009290Z",
    ]);
    expect(() => validateCandidate31Config({ ...value.config, unexpected_legacy_record_sha256: "0".repeat(64) }))
      .toThrow("M4F_CANDIDATE31_CONFIG_INVALID");
  });

  test("builds alias-safe WinPS source with one process and one listener CIM snapshot", () => {
    const built = buildCandidate31Payload();
    expect(built.command.length).toBeLessThanOrEqual(7_000);
    expect(built.command).toStartWith("powershell.exe -NoLogo -NoProfile -NonInteractive");
    expect(built.command).toEndWith("\"");
    expect(built.targetScript.match(/Get-CimInstance Win32_Process/gu)).toHaveLength(1);
    expect(built.targetScript.match(/MSFT_NetTCPConnection/gu)).toHaveLength(1);
    expect(built.targetScript).toContain("function Get-SynthiaM4f31Sha256");
    expect(built.targetScript).toContain("function ConvertTo-SynthiaM4f31ProcessRow");
    expect(built.targetScript).toContain("function Get-SynthiaM4f31AncestorChain");
    expect(built.targetScript).not.toMatch(/function\s+[ARH]\s*\(/u);
    expect(built.targetScript).not.toMatch(/\$[A-Za-z][A-Za-z0-9_]*-(?:eq|ne|ceq|and|or|not|gt|lt)\b/u);
    expect(built.targetScript).not.toContain(" -lt 8");
    expect(built.targetScript).not.toContain(" -lt 32");
    expect(candidate31HasForbiddenMutation(built.targetScript)).toBe(false);
    expect(candidate31HasForbiddenMutation("Stop-Process -Id 1")).toBe(true);
    expect(candidate31HasForbiddenMutation("Vivado.exe -mode batch")).toBe(true);
    expect(candidate31HasForbiddenMutation("Out-File result.txt")).toBe(true);
  });

  test("plans locally with only Candidate30 and original-six bindings", () => {
    const value = fixture();
    expect(planCandidate31(value.config, value.dependencies)).toMatchObject({
      preflight_id: CANDIDATE31_ID,
      status: "planned_not_executed",
      candidate30_evidence_manifest_sha256: CANDIDATE30_MANIFEST_SHA256,
      candidate30_record_sha256: CANDIDATE30_RECORD_SHA256,
      candidate17_evidence_manifest_sha256: CANDIDATE17_MANIFEST_SHA256,
      original_six_config_sha256: value.config.original_six_config_sha256,
      six_source_sha256: value.config.expected_six_source_sha256,
      six_test_sha256: value.config.expected_six_test_sha256,
      effective_audit_count: 1,
      remote_attempt_count: 1,
      stdin_length: 0,
      retry_permitted: false,
      cleanup_permitted: false,
      vivado_action_permitted: false,
      hardware_action_permitted: false,
    });
    expect(value.calls).toHaveLength(0);
  });

  test("accepts all nine absent and an exact present target", () => {
    expect(validateCandidate31Output(output())).toMatchObject({
      status: "observed", exact_present_count: 0, absent_count: 9,
    });
    const exact = output((markers) => {
      const value = snapshot(markers);
      (value.targets as unknown[])[0] = exactTarget(0);
      value.effective_present_set = [CANDIDATE31_TARGETS[0]!.pid];
    });
    expect(validateCandidate31Output(exact)).toMatchObject({
      status: "observed", exact_present_count: 1, absent_count: 8,
    });
  });

  test("rejects claimed exact on every identity field drift and PID reuse", () => {
    const replacements = new Map<number, unknown>([
      [1, 1], [2, "notepad.exe"], [3, "2026-08-30T19:00:00.0000000Z"], [4, 99],
      [5, "C:\\bad.exe"], [7, 99], [8, "f".repeat(64)],
    ]);
    for (const [index, replacement] of replacements) {
      const drift = output((markers) => {
        const value = snapshot(markers);
        const observed = exactTarget(6);
        (observed[3] as unknown[])[index] = replacement;
        (value.targets as unknown[])[6] = observed;
        value.effective_present_set = [CANDIDATE31_TARGETS[6]!.pid];
      });
      expect(() => validateCandidate31Output(drift)).toThrow();
    }
  });

  test("records mismatch as blocked rather than absent", () => {
    const blocked = output((markers) => {
      const value = snapshot(markers);
      const observed = exactTarget(0);
      (observed[3] as unknown[])[2] = "notepad.exe";
      observed[2] = "mismatch";
      (value.targets as unknown[])[0] = observed;
      setBlocked(markers);
    });
    expect(validateCandidate31Output(blocked)).toMatchObject({
      status: "observed_blocked", exact_present_count: 0, absent_count: 8,
    });
  });

  test("supports more than eight ancestor levels and classifies incomplete or invalid chains", () => {
    const deep = output((markers) => {
      const value = snapshot(markers);
      const observed = exactTarget(0);
      const chain: ProcessRow[] = [];
      let childPid = CANDIDATE31_TARGETS[0]!.parent_pid;
      for (let index = 0; index < 10; index += 1) {
        const parentPid = index === 9 ? 4 : 80_000 + index;
        chain.push(row(childPid, parentPid, "parent" + index + ".exe",
          `2026-08-01T00:00:${String(10 - index).padStart(2, "0")}.0000000Z`));
        childPid = parentPid;
      }
      chain.push(row(4, 0, "system", "2026-08-01T00:00:00.0000000Z", null, null, null));
      observed[4] = chain;
      (value.targets as unknown[])[0] = observed;
      value.effective_present_set = [CANDIDATE31_TARGETS[0]!.pid];
    });
    expect(validateCandidate31Output(deep)).toMatchObject({ exact_present_count: 1 });

    const missingParent = output((markers) => {
      const value = snapshot(markers);
      const observed = exactTarget(0);
      observed[4] = [];
      observed[5] = "missing_parent";
      observed[6] = CANDIDATE31_TARGETS[0]!.parent_pid;
      (value.targets as unknown[])[0] = observed;
      value.effective_present_set = [CANDIDATE31_TARGETS[0]!.pid];
    });
    expect(validateCandidate31Output(missingParent)).toMatchObject({
      status: "observed", exact_present_count: 1,
    });

    for (const terminal of ["cycle", "invalid_edge"] as const) {
      const blocked = output((markers) => {
        const value = snapshot(markers);
        const observed = exactTarget(0);
        observed[2] = "mismatch";
        if (terminal === "cycle") {
          const actual = observed[3] as ProcessRow;
          actual[1] = actual[0];
          observed[4] = [];
          observed[5] = terminal;
          observed[6] = actual[0];
        } else {
          const actual = observed[3] as ProcessRow;
          const invalidParent = row(actual[1], 4, "parent.exe", "2026-08-29T00:00:00.0000000Z");
          observed[4] = [invalidParent];
          observed[5] = terminal;
          observed[6] = invalidParent[0];
        }
        (value.targets as unknown[])[0] = observed;
        setBlocked(markers);
      });
      expect(validateCandidate31Output(blocked)).toMatchObject({ status: "observed_blocked" });
    }
  });

  test("recomputes worker and strict listener gates", () => {
    const workerDrift = output((markers) => {
      const value = snapshot(markers);
      (value.protected_worker as unknown[])[5] = "C:\\bad.exe";
      ((value.worker_descendants as unknown[])[0] as unknown[])[5] = "C:\\bad.exe";
      value.protected_worker_exact = false;
      setBlocked(markers);
    });
    expect(validateCandidate31Output(workerDrift)).toMatchObject({ status: "observed_blocked" });
    const listenerCases = [
      { listeners_8443: [] },
      { listeners_8443: [["127.0.0.1", 8443, 13644]] },
      { listeners_8443: [["0.0.0.0", 8443, 1]] },
      { listeners_8443: [["0.0.0.0", 8443, 13644], ["::", 8443, 13644]] },
      { listeners_18443: [["0.0.0.0", 18443, 13644]] },
    ];
    for (const change of listenerCases) {
      const blocked = output((markers) => {
        Object.assign(snapshot(markers), change);
        setBlocked(markers);
      });
      expect(validateCandidate31Output(blocked)).toMatchObject({ status: "observed_blocked" });
    }
  });

  test("rejects cross-section PID row contradictions and actual PID substitution", () => {
    const contradiction = output((markers) => {
      const value = snapshot(markers);
      ((value.diagnostic_tree as unknown[])[2] as unknown[])[8] = "f".repeat(64);
    });
    expect(() => validateCandidate31Output(contradiction)).toThrow("candidate31 inconsistent process row");

    const pidSubstitution = output((markers) => {
      const value = snapshot(markers);
      const observed = exactTarget(0);
      (observed[3] as unknown[])[0] = 99999;
      (value.targets as unknown[])[0] = observed;
      value.effective_present_set = [CANDIDATE31_TARGETS[0]!.pid];
    });
    expect(() => validateCandidate31Output(pidSubstitution)).toThrow("candidate31 present target");
  });

  test("rejects a claimed exact target whose own ancestor chain reaches the omitted diagnostic root", () => {
    const omitted = output((markers) => {
      const value = snapshot(markers);
      const observed = exactTarget(0);
      const actual = observed[3] as ProcessRow;
      const parent = row(actual[1], 700, "parent.exe", "2026-08-01T00:00:01.0000000Z");
      const sshd = structuredClone((value.diagnostic_tree as ProcessRow[])[0]!);
      const system = row(4, 0, "system", "2026-08-01T00:00:00.0000000Z", null, null, null);
      observed[4] = [parent, sshd, system];
      (value.targets as unknown[])[0] = observed;
      value.effective_present_set = [CANDIDATE31_TARGETS[0]!.pid];
    });
    expect(() => validateCandidate31Output(omitted)).toThrow("candidate31 target state");
  });

  test("binds Candidate17 exact entry set, hashes and owned dual-time tuples", () => {
    const extra = fixture();
    extra.setCandidate17Entries([...Object.keys(CANDIDATE17_MANIFEST), "extra"]);
    expect(failure(() => planCandidate31(extra.config, extra.dependencies)).detail.code)
      .toBe("M4F_CANDIDATE31_CANDIDATE17_EVIDENCE_INVALID");

    const hashDrift = fixture();
    hashDrift.setFile(CANDIDATE17_EVIDENCE_DIRECTORY + "/observation.json", Buffer.from("{}\n"));
    expect(failure(() => planCandidate31(hashDrift.config, hashDrift.dependencies)).detail.code)
      .toBe("M4F_CANDIDATE31_INPUT_DRIFT");

    const plan = planCandidate31(fixture().config, fixture().dependencies);
    expect(plan).toMatchObject({
      candidate17_evidence_manifest_sha256: CANDIDATE17_MANIFEST_SHA256,
      original_six_dual_time_tuples: [
        [44768, "2026-08-28T16:25:51.0137884Z", "2026-08-28T16:25:51.0137880Z"],
        [56576, "2026-08-28T16:25:50.9870650Z", "2026-08-28T16:25:50.9870650Z"],
        [64484, "2026-08-28T16:25:50.9908927Z", "2026-08-28T16:25:50.9908920Z"],
        [58908, "2026-08-28T17:12:52.5233863Z", "2026-08-28T17:12:52.5233860Z"],
        [67048, "2026-08-28T17:12:52.4952390Z", "2026-08-28T17:12:52.4952390Z"],
        [66316, "2026-08-28T17:12:52.5009297Z", "2026-08-28T17:12:52.5009290Z"],
      ],
    });
  });

  test("runs one effective audit and one empty-stdin read-only attempt", () => {
    const value = fixture();
    const confirmation = candidate31Confirmation(value.config, value.dependencies);
    expect(executeCandidate31(value.config, confirmation, value.dependencies)).toMatchObject({
      status: "observed", preflight_id: CANDIDATE31_ID,
      candidate30_evidence_manifest_sha256: CANDIDATE30_MANIFEST_SHA256,
      candidate30_record_sha256: CANDIDATE30_RECORD_SHA256,
      original_six_config_sha256: value.config.original_six_config_sha256,
      target_body_invoked: true, cim_executed: true, cleanup_performed: false,
      process_mutation_performed: false, vivado_action_performed: false,
      hardware_action_performed: false, retry_permitted: false,
    });
    expect(value.calls).toHaveLength(2);
    expect(value.calls[0]!.args[0]).toBe("-G");
    expect(value.calls[1]!.args).toContain("100.96.223.49");
    expect(value.calls.every((call) => call.stdin.length === 0)).toBe(true);
    expect(value.writes.has(CANDIDATE31_EVIDENCE_DIRECTORY + "/preflight-record.json")).toBe(true);
    expect(value.writes.has(CANDIDATE31_EVIDENCE_DIRECTORY + "/target-preflight-script.ps1")).toBe(true);
  });

  test("fails closed on confirmation, drift and remote failure", () => {
    const wrong = fixture();
    expect(failure(() => executeCandidate31(wrong.config, "wrong", wrong.dependencies)).detail.code)
      .toBe("M4F_CANDIDATE31_CONFIRMATION_REQUIRED");
    expect(wrong.calls).toHaveLength(0);

    const drift = fixture();
    drift.config.expected_six_source_sha256 = "0".repeat(64);
    expect(failure(() => planCandidate31(drift.config, drift.dependencies)).detail.code)
      .toBe("M4F_CANDIDATE31_INPUT_DRIFT");
    expect(drift.calls).toHaveLength(0);

    const remote = fixture();
    remote.setRemote(processResult("", "failure", 1));
    const confirmation = candidate31Confirmation(remote.config, remote.dependencies);
    expect(failure(() => executeCandidate31(remote.config, confirmation, remote.dependencies)).detail)
      .toMatchObject({
        code: "M4F_CANDIDATE31_REMOTE_FAILED", retry_permitted: false,
        cleanup_performed: false, process_mutation_performed: false,
        vivado_action_performed: false, hardware_action_performed: false,
      });
    expect(remote.calls).toHaveLength(2);
  });
});
