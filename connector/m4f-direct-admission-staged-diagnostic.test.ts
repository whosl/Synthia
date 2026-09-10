import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDiagnosticStages,
  buildDiagnosticStageScript,
  M4F_DIRECT_STAGED_DIAGNOSTIC_GUARDS,
  planStagedDiagnostic,
  recordStagedDiagnostic,
  spawnBoundedDiagnosticProcess,
  stagedDiagnosticConfirmation,
  StagedDiagnosticFailure,
  type DiagnosticStage,
  type M4fDirectStagedDiagnosticConfig,
  type StagedDiagnosticDependencies,
} from "./scripts/m4f-direct-admission-staged-diagnostic.ts";
import type {
  M4fDirectAdmissionConfig,
  RawProcessResult,
} from "./scripts/m4f-gate-admission-transport.ts";

const roots: string[] = [];
const KEY_BYTES = Buffer.from(Array.from({ length: 48 }, (_, index) => index + 1));
const FINGERPRINT = "SHA256:" + createHash("sha256")
  .update(KEY_BYTES).digest("base64").replace(/=+$/u, "");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("M4-F direct staged read-only diagnostic", () => {
  test("enforces the local deadline with a non-ignorable kill signal", () => {
    const started = performance.now();
    const result = spawnBoundedDiagnosticProcess(
      "/bin/sh",
      ["-c", "trap '' TERM; while :; do :; done"],
      Buffer.alloc(0),
      100,
    );
    const elapsed = performance.now() - started;
    expect(result.errorCode).toBe("ETIMEDOUT");
    expect(result.signal).toBe("SIGKILL");
    expect(elapsed).toBeLessThan(1_000);
  });

  test("plans a finite fixed whitelist with one separate ACL stage per configured path", () => {
    const scenario = fixture();
    const plan = planStagedDiagnostic(scenario.config, scenario.dependencies);
    expect(plan).toMatchObject({
      schema: "synthia-m4f-direct-staged-diagnostic-plan.v1",
      status: "planned_not_executed",
      target_host: "100.96.223.49",
      target_user: "admin",
      target_computer: "DESKTOP-DVFFB09",
      stage_timeout_ms: 60_000,
      stage_count: 10,
      maximum_remote_elapsed_ms: 600_000,
      continuation_policy: "continue_distinct_stages_after_unknown_no_stage_retry",
      source_sha256: scenario.config.expected_source_sha256,
      transport_source_sha256: scenario.config.expected_transport_source_sha256,
      expected_effective_config_sha256: scenario.config.expected_effective_config_sha256,
      retry_per_stage: false,
      network_attempted: false,
      hardware_action_performed: false,
    });
    expect((plan.stages as DiagnosticStage[]).map((stage) => stage.stage_id)).toEqual([
      "wrapper-smoke", "identity", "volumes", "acl-01", "acl-02", "acl-03",
      "listeners", "processes", "vivado-fact", "bun-fact",
    ]);
    expect((plan.stages as DiagnosticStage[]).filter((stage) => stage.kind === "acl")
      .map((stage) => stage.acl_path)).toEqual(scenario.admission.target.acl_paths);
    expect(plan.confirmation).toBe(stagedDiagnosticConfirmation(scenario.config));
    expect(scenario.calls).toHaveLength(0);
    expect(M4F_DIRECT_STAGED_DIAGNOSTIC_GUARDS).toMatchObject({
      targetHost: "100.96.223.49",
      stageTimeoutMs: 60_000,
      maxStageCount: 23,
      keepaliveEnabled: false,
    });
  });

  test("rejects wrong confirmation before evidence creation or process spawn", () => {
    const scenario = fixture();
    const evidence = join(scenario.root, "must-not-exist");
    const failure = capture(() => recordStagedDiagnostic(
      scenario.config,
      "wrong",
      evidence,
      scenario.dependencies,
    ));
    expect(failure).toMatchObject({
      code: "M4F_DIRECT_STAGED_DIAGNOSTIC_CONFIRMATION_REQUIRED",
      stage: "local_preflight",
      remote_effect_state: "not_started",
      retry_permitted: false,
    });
    expect(existsSync(evidence)).toBe(false);
    expect(scenario.calls).toHaveLength(0);
  });

  test("inherits the exact direct target, key, known-hosts, identity, and keepalive-zero policy", () => {
    for (const mutate of [
      (admission: M4fDirectAdmissionConfig) => { admission.target.host = "100.66.198.60" as never; },
      (admission: M4fDirectAdmissionConfig) => { admission.target.user = "Administrator" as never; },
      (admission: M4fDirectAdmissionConfig) => { admission.target.computer_name = "OTHER" as never; },
      (admission: M4fDirectAdmissionConfig) => { admission.target.identity_name = "other\\admin"; },
    ]) {
      const scenario = fixture();
      mutate(scenario.admission);
      rewriteAdmission(scenario);
      expect(capture(() => planStagedDiagnostic(scenario.config, scenario.dependencies)).code)
        .toBe("M4F_DIRECT_STAGED_DIAGNOSTIC_ADMISSION_CONFIG_INVALID");
      expect(scenario.calls).toHaveLength(0);
    }

    const scenario = fixture();
    recordStagedDiagnostic(
      scenario.config,
      stagedDiagnosticConfirmation(scenario.config),
      join(scenario.root, "evidence"),
      scenario.dependencies,
    );
    for (const call of scenario.calls.slice(1)) {
      expect(call.args).toContain("HostName=100.96.223.49");
      expect(call.args).toContain("User=admin");
      expect(call.args).toContain("IdentityFile=" + scenario.admission.target.identity_file);
      expect(call.args).toContain("UserKnownHostsFile=" + scenario.admission.target.known_hosts_file);
      expect(call.args).toContain("ServerAliveInterval=0");
      expect(call.timeoutMs).toBe(60_000);
    }
  });

  test("generates only whitelisted read-only stage programs with exact identity binding", () => {
    const scenario = fixture();
    const stages = buildDiagnosticStages(scenario.admission);
    const source = stages.map((stage) => buildDiagnosticStageScript(stage, scenario.admission)).join("\n");
    expect(source).toContain("M4F_DIRECT_DIAGNOSTIC_IDENTITY_MISMATCH");
    expect(source).toContain("Get-CimInstance Win32_LogicalDisk");
    expect(source).toContain("Get-Acl -LiteralPath");
    expect(source).toContain("Get-NetTCPConnection -State Listen");
    expect(source).toContain("Get-CimInstance Win32_Process");
    expect(source).toContain("Get-FileHash -LiteralPath");
    expect(source).toContain("hardware_action_performed=$false");
    expect(source).not.toMatch(/(?:New|Set|Remove|Copy|Move)-Item|Set-Acl|Set-Content|Add-Content|Out-File/iu);
    expect(source).not.toMatch(/Start-Process|Invoke-Expression|Invoke-Command|open_hw|connect_hw|program_hw|write_bitstream|write_cfgmem/iu);
    expect(source).not.toMatch(/[&]\s*[^\r\n]*vivado/iu);
    expect(source).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|curl|wget/iu);
    expect(source).not.toContain("100.66.198.60");
    expect(source).not.toContain("192.168.31.66");

    const smoke = buildDiagnosticStageScript(stages[0]!, scenario.admission);
    expect(smoke).toContain("$identityFact=$null");
    expect(smoke).not.toContain("WindowsIdentity");
    expect(smoke).not.toContain("M4F_DIRECT_DIAGNOSTIC_IDENTITY_MISMATCH");
    expect(smoke).not.toMatch(/Get-CimInstance|Get-Acl|Get-NetTCPConnection|Get-FileHash/iu);

    const businessMarkers = {
      identity: "$payload=[ordered]@{identity=",
      volumes: "Get-CimInstance Win32_LogicalDisk",
      acl: "$path=[string]$cfg.aclPath",
      listeners: "Get-NetTCPConnection",
      processes: "$names=@(",
      vivado_fact: "$path=[string]$cfg.vivadoPath",
      bun_fact: "$path=[string]$cfg.bunPath",
    } as const;
    for (const stage of stages) {
      const script = buildDiagnosticStageScript(stage, scenario.admission);
      expect(script).toContain('stageId');
      if (stage.kind !== "wrapper_smoke") {
        const identityIndex = script.indexOf("M4F_DIRECT_DIAGNOSTIC_IDENTITY_MISMATCH");
        const businessIndex = script.indexOf(businessMarkers[stage.kind]);
        expect(identityIndex).toBeGreaterThan(-1);
        expect(businessIndex).toBeGreaterThan(identityIndex);
      }
    }
  });

  test("rejects a stale source binding before evidence creation or process spawn", () => {
    const scenario = fixture();
    const evidence = join(scenario.root, "source-drift-must-not-exist");
    const confirmation = stagedDiagnosticConfirmation(scenario.config);
    scenario.source = Buffer.from("changed-diagnostic-source");
    const failure = capture(() => recordStagedDiagnostic(
      scenario.config,
      confirmation,
      evidence,
      scenario.dependencies,
    ));
    expect(failure).toMatchObject({
      code: "M4F_DIRECT_STAGED_DIAGNOSTIC_SOURCE_MISMATCH",
      stage: "local_preflight",
      remote_effect_state: "not_started",
      retry_permitted: false,
    });
    expect(existsSync(evidence)).toBe(false);
    expect(scenario.calls).toHaveLength(0);
  });

  test("rejects a stale transport-source binding before evidence creation or process spawn", () => {
    const scenario = fixture();
    const evidence = join(scenario.root, "transport-source-stale-must-not-exist");
    const confirmation = stagedDiagnosticConfirmation(scenario.config);
    scenario.transportSource = Buffer.from("changed-transport-source");
    const failure = capture(() => recordStagedDiagnostic(
      scenario.config,
      confirmation,
      evidence,
      scenario.dependencies,
    ));
    expect(failure).toMatchObject({
      code: "M4F_DIRECT_STAGED_DIAGNOSTIC_TRANSPORT_SOURCE_MISMATCH",
      stage: "local_preflight",
      remote_effect_state: "not_started",
      retry_permitted: false,
    });
    expect(existsSync(evidence)).toBe(false);
    expect(scenario.calls).toHaveLength(0);
  });

  test("rejects an unreviewed effective ssh config before the first remote stage", () => {
    const scenario = fixture();
    scenario.config.expected_effective_config_sha256 = "0".repeat(64);
    const evidence = join(scenario.root, "effective-mismatch-evidence");
    const failure = capture(() => recordStagedDiagnostic(
      scenario.config,
      stagedDiagnosticConfirmation(scenario.config),
      evidence,
      scenario.dependencies,
    ));
    expect(failure).toMatchObject({
      code: "M4F_DIRECT_STAGED_DIAGNOSTIC_EFFECTIVE_CONFIG_HASH_MISMATCH",
      stage: "local_preflight",
      retry_permitted: false,
    });
    expect(scenario.calls).toHaveLength(1);
    expect(scenario.calls[0]!.args[0]).toBe("-G");
    const frozen = JSON.parse(readFileSync(join(evidence, "diagnostic-failure.json"), "utf8"));
    expect(frozen).toMatchObject({ attempted_stage_count: 0, completed_stage_count: 0 });
  });

  test("attempts every stage exactly once and freezes new 0700/0600 per-stage evidence", () => {
    const scenario = fixture();
    const evidence = join(scenario.root, "new-evidence");
    const result = recordStagedDiagnostic(
      scenario.config,
      stagedDiagnosticConfirmation(scenario.config),
      evidence,
      scenario.dependencies,
    );
    expect(result).toMatchObject({
      schema: "synthia-m4f-direct-staged-diagnostic-record.v1",
      status: "completed",
      retry_permitted: false,
      stage_timeout_ms: 60_000,
      maximum_remote_elapsed_ms: 600_000,
      continuation_policy: "continue_distinct_stages_after_unknown_no_stage_retry",
      planned_stage_count: 10,
      attempted_stage_count: 10,
      observed_stage_count: 10,
      unknown_stage_count: 0,
      hardware_action_performed: false,
    });
    expect(scenario.calls).toHaveLength(11);
    expect(scenario.calls[0]!.args[0]).toBe("-G");
    expect(scenario.calls.slice(1).every((call) => call.timeoutMs === 60_000)).toBe(true);
    expect(result.stage_records.map((record) => record.attempt)).toEqual(Array(10).fill(1));
    expect(result.stage_records.every((record) => record.retry_permitted === false)).toBe(true);
    expect(lstatSync(evidence).mode & 0o777).toBe(0o700);
    for (let index = 0; index < result.stage_records.length; index += 1) {
      const record = result.stage_records[index]!;
      const directory = join(evidence, String(index + 1).padStart(2, "0") + "-" + record.stage_id);
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
      for (const name of ["stdin.ps1", "stdout.raw", "stderr.raw", "stage-record.json"]) {
        expect(lstatSync(join(directory, name)).mode & 0o777).toBe(0o600);
      }
      expect(readFileSync(join(directory, "stdin.ps1"))).toEqual(scenario.calls[index + 1]!.stdin);
      expect(readFileSync(join(directory, "stdout.raw")).length).toBeGreaterThan(0);
      expect(readFileSync(join(directory, "stderr.raw")).length).toBe(0);
    }
  });

  test("records timeout/nonzero/malformed stages as unknown and never retries them", () => {
    const scenario = fixture();
    scenario.stageResults.set("volumes", processResult("", "", null, null, "ETIMEDOUT"));
    scenario.stageResults.set("listeners", processResult("", "ssh failed\r\n", 255));
    scenario.stageResults.set("bun-fact", processResult("not-json\n"));
    const evidence = join(scenario.root, "partial-evidence");
    const result = recordStagedDiagnostic(
      scenario.config,
      stagedDiagnosticConfirmation(scenario.config),
      evidence,
      scenario.dependencies,
    );
    expect(result.status).toBe("completed_with_unknown");
    expect(result.unknown_stage_count).toBe(3);
    expect(result.attempted_stage_count).toBe(result.planned_stage_count);
    for (const stageId of ["volumes", "listeners", "bun-fact"]) {
      const record = result.stage_records.find((item) => item.stage_id === stageId)!;
      expect(record).toMatchObject({ status: "unknown", output_valid: false, attempt: 1, retry_permitted: false });
      expect(scenario.calls.slice(1).filter((call) => stageIdFromInput(call.stdin) === stageId)).toHaveLength(1);
      const index = result.stage_records.indexOf(record);
      const directory = join(evidence, String(index + 1).padStart(2, "0") + "-" + stageId);
      expect(readFileSync(join(directory, "stdout.raw"))).toEqual(scenario.stageResults.get(stageId)!.stdout);
      expect(readFileSync(join(directory, "stderr.raw"))).toEqual(scenario.stageResults.get(stageId)!.stderr);
      const frozen = JSON.parse(readFileSync(join(directory, "stage-record.json"), "utf8"));
      expect(frozen.process.stdout_sha256).toBe(sha256(scenario.stageResults.get(stageId)!.stdout));
      expect(frozen.process.stderr_sha256).toBe(sha256(scenario.stageResults.get(stageId)!.stderr));
    }
    expect(result.stage_records.find((record) => record.stage_id === "processes")?.status).toBe("observed");
  });

  test("rejects malformed nested payload facts instead of marking them observed", () => {
    for (const [stageId, mutate] of [
      ["identity", (value: Record<string, unknown>) => { (value.payload as Record<string, unknown>).identity = {}; }],
      ["volumes", (value: Record<string, unknown>) => { (value.payload as Record<string, unknown>).volumes = [{}]; }],
      ["acl-01", (value: Record<string, unknown>) => { (value.payload as Record<string, unknown>).acl = { path: "C:\\Windows\\Temp" }; }],
      ["listeners", (value: Record<string, unknown>) => { (value.payload as Record<string, unknown>).listeners = [{ port: 22 }]; }],
      ["processes", (value: Record<string, unknown>) => { (value.payload as Record<string, unknown>).processes = [{ name: "cmd.exe" }]; }],
      ["vivado-fact", (value: Record<string, unknown>) => { (value.payload as Record<string, unknown>).vivado = { path: "D:\\wrong" }; }],
      ["bun-fact", (value: Record<string, unknown>) => { (value.payload as Record<string, unknown>).bun = { path: "D:\\wrong" }; }],
    ] as Array<[string, (value: Record<string, unknown>) => void]>) {
      const scenario = fixture();
      const value = stageOutput(stageId, scenario.admission);
      mutate(value);
      scenario.stageResults.set(stageId, processResult(JSON.stringify(value) + "\n"));
      const result = recordStagedDiagnostic(
        scenario.config,
        stagedDiagnosticConfirmation(scenario.config),
        join(scenario.root, "evidence-" + stageId),
        scenario.dependencies,
      );
      expect(result.stage_records.find((record) => record.stage_id === stageId))
        .toMatchObject({ status: "unknown", output_valid: false });
    }
  });

  test("rejects exact-shape payloads with invalid semantic values", () => {
    for (const [stageId, mutate] of [
      ["volumes", (value: Record<string, unknown>) => {
        const volumes = (value.payload as Record<string, unknown>).volumes as Array<Record<string, unknown>>;
        volumes[0]!.drive_type = 4;
      }],
      ["acl-01", (value: Record<string, unknown>) => {
        const acl = (value.payload as Record<string, unknown>).acl as Record<string, unknown>;
        acl.rules = [{
          sid: "S-1-5-32-544",
          type: "Allow",
          rights: 1,
          inherited: false,
          inheritance: "Arbitrary",
          propagation: "None",
        }];
      }],
      ["listeners", (value: Record<string, unknown>) => {
        (value.payload as Record<string, unknown>).listeners = [{
          address: "not-an-ip", port: 8443, pid: 100,
        }];
      }],
      ["processes", (value: Record<string, unknown>) => {
        (value.payload as Record<string, unknown>).processes = [{
          pid: 100,
          parent_pid: 1,
          name: "bun.exe",
          executable_path: "D:\\synthia-worker\\runtime\\bun.exe",
          creation_date: "2026-08-28T05:00:00+08:00",
        }];
      }],
      ["identity", (value: Record<string, unknown>) => {
        value.observed_at_utc = "2026-08-28T13:00:00+08:00";
      }],
    ] as Array<[string, (value: Record<string, unknown>) => void]>) {
      const scenario = fixture();
      const value = stageOutput(stageId, scenario.admission);
      mutate(value);
      scenario.stageResults.set(stageId, processResult(JSON.stringify(value) + "\n"));
      const result = recordStagedDiagnostic(
        scenario.config,
        stagedDiagnosticConfirmation(scenario.config),
        join(scenario.root, "semantic-evidence-" + stageId),
        scenario.dependencies,
      );
      expect(result.stage_records.find((record) => record.stage_id === stageId))
        .toMatchObject({ status: "unknown", output_valid: false });
    }
  });

  test("binds current-stage raw evidence hashes when post-spawn input capture fails", () => {
    const scenario = fixture();
    scenario.onStage = (stageId) => {
      if (stageId === "wrapper-smoke") {
        writeSecure(scenario.admission.target.identity_file, "changed-key-bytes\n");
      }
    };
    const evidence = join(scenario.root, "post-spawn-drift-evidence");
    const failure = capture(() => recordStagedDiagnostic(
      scenario.config,
      stagedDiagnosticConfirmation(scenario.config),
      evidence,
      scenario.dependencies,
    ));
    expect(failure.code).toBe("M4F_DIRECT_STAGED_DIAGNOSTIC_TRANSPORT_INPUT_DRIFT");
    const frozen = JSON.parse(readFileSync(join(evidence, "diagnostic-failure.json"), "utf8"));
    const stdout = readFileSync(join(evidence, "01-wrapper-smoke", "stdout.raw"));
    const stderr = readFileSync(join(evidence, "01-wrapper-smoke", "stderr.raw"));
    expect(frozen).toMatchObject({
      attempted_stage_count: 1,
      completed_stage_count: 0,
      current_stage_id: "wrapper-smoke",
      current_stage_process: {
        stdout_length: stdout.length,
        stdout_sha256: sha256(stdout),
        stderr_length: stderr.length,
        stderr_sha256: sha256(stderr),
      },
    });
  });

  test("stops between stages and freezes failure when the transport source drifts", () => {
    const scenario = fixture();
    scenario.onStage = (stageId) => {
      if (stageId === "wrapper-smoke") {
        scenario.transportSource = Buffer.from("transport-source-drift");
      }
    };
    const evidence = join(scenario.root, "transport-source-drift-evidence");
    const failure = capture(() => recordStagedDiagnostic(
      scenario.config,
      stagedDiagnosticConfirmation(scenario.config),
      evidence,
      scenario.dependencies,
    ));
    expect(failure.code).toBe("M4F_DIRECT_STAGED_DIAGNOSTIC_TRANSPORT_SOURCE_MISMATCH");
    const frozen = JSON.parse(readFileSync(join(evidence, "diagnostic-failure.json"), "utf8"));
    expect(frozen).toMatchObject({
      attempted_stage_count: 1,
      completed_stage_count: 1,
      current_stage_id: "identity",
      transport_source_sha256: scenario.config.expected_transport_source_sha256,
    });
    expect(scenario.calls).toHaveLength(2);
  });

  test("freezes a top-level partial failure when a bound local input drifts", () => {
    const scenario = fixture();
    scenario.onStage = (stageId) => {
      if (stageId === "wrapper-smoke") {
        writeSecure(scenario.config.admission_config_path, JSON.stringify({ changed: true }) + "\n");
      }
    };
    const evidence = join(scenario.root, "drift-evidence");
    const failure = capture(() => recordStagedDiagnostic(
      scenario.config,
      stagedDiagnosticConfirmation(scenario.config),
      evidence,
      scenario.dependencies,
    ));
    expect(String(failure.code)).toMatch(/ADMISSION_CONFIG/u);
    const frozen = JSON.parse(readFileSync(join(evidence, "diagnostic-failure.json"), "utf8"));
    expect(frozen).toMatchObject({
      diagnostic_id: scenario.config.diagnostic_id,
      planned_stage_count: 10,
      attempted_stage_count: 1,
      completed_stage_count: 1,
      retry_permitted: false,
      continuation_policy: "continue_distinct_stages_after_unknown_no_stage_retry",
      hardware_action_performed: false,
    });
    expect(lstatSync(join(evidence, "diagnostic-failure.json")).mode & 0o777).toBe(0o600);
    expect(scenario.calls).toHaveLength(2);
  });

  test("never reuses an existing evidence directory", () => {
    const scenario = fixture();
    const evidence = join(scenario.root, "existing");
    writeFileSync(evidence, "occupied");
    const failure = capture(() => recordStagedDiagnostic(
      scenario.config,
      stagedDiagnosticConfirmation(scenario.config),
      evidence,
      scenario.dependencies,
    ));
    expect(failure.code).toBe("M4F_DIRECT_STAGED_DIAGNOSTIC_EVIDENCE_DIRECTORY_INVALID");
    expect(scenario.calls).toHaveLength(0);
  });
});

interface Scenario {
  root: string;
  admission: M4fDirectAdmissionConfig;
  config: M4fDirectStagedDiagnosticConfig;
  effective: string;
  calls: Array<{ executable: string; args: readonly string[]; stdin: Buffer; timeoutMs: number }>;
  stageResults: Map<string, RawProcessResult>;
  onStage: ((stageId: string) => void) | null;
  source: Buffer;
  transportSource: Buffer;
  dependencies: StagedDiagnosticDependencies;
}

function fixture(): Scenario {
  const root = mkdtempSync(join(tmpdir(), "synthia-direct-staged-diagnostic-"));
  roots.push(root);
  const identity = join(root, "target-id");
  const knownHosts = join(root, "target-known-hosts");
  writeSecure(identity, "private-key-placeholder\n");
  writeSecure(knownHosts, "100.96.223.49 ssh-ed25519 " + KEY_BYTES.toString("base64") + "\n");
  const admission: M4fDirectAdmissionConfig = {
    schema: "synthia-m4f-direct-admission-config.v1",
    gate_id: "staged-diagnostic-source",
    target: {
      host: "100.96.223.49",
      port: 22,
      user: "admin",
      computer_name: "DESKTOP-DVFFB09",
      identity_name: "desktop-dvffb09\\admin",
      identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001",
      identity_file: identity,
      known_hosts_file: knownHosts,
      known_hosts_host_token: "100.96.223.49",
      host_key_fingerprint: FINGERPRINT,
      expected_effective_config_sha256: null,
      acl_paths: ["C:\\Windows\\Temp", "D:\\synthia-worker", "D:\\Xilinx\\Vivado\\2021.1"],
      vivado_executable: "D:\\Xilinx\\Vivado\\2021.1\\bin\\vivado.bat",
      bun_executable: "D:\\synthia-worker\\runtime\\bun.exe",
    },
  };
  const admissionPath = join(root, "admission-config.json");
  writeSecure(admissionPath, JSON.stringify(admission) + "\n");
  const effective = effectiveConfig(admission);
  const source = Buffer.from("staged-diagnostic-source");
  const transportSource = Buffer.from("direct-transport-source");
  const config: M4fDirectStagedDiagnosticConfig = {
    schema: "synthia-m4f-direct-staged-diagnostic-config.v1",
    diagnostic_id: "direct-staged-test-01",
    admission_config_path: admissionPath,
    admission_config_sha256: sha256(readFileSync(admissionPath)),
    expected_source_sha256: sha256(source),
    expected_transport_source_sha256: sha256(transportSource),
    expected_effective_config_sha256: sha256(effective),
  };
  const scenario: Scenario = {
    root,
    admission,
    config,
    effective,
    calls: [],
    stageResults: new Map(),
    onStage: null,
    source,
    transportSource,
    dependencies: {} as StagedDiagnosticDependencies,
  };
  let nowCounter = 0;
  let monotonic = 0;
  scenario.dependencies = {
    spawn(executable, args, stdin, timeoutMs) {
      scenario.calls.push({ executable, args, stdin: Buffer.from(stdin), timeoutMs });
      if (args[0] === "-G") return processResult(scenario.effective);
      const stageId = stageIdFromInput(stdin);
      scenario.onStage?.(stageId);
      return scenario.stageResults.get(stageId)
        ?? processResult(JSON.stringify(stageOutput(stageId, scenario.admission)) + "\n");
    },
    sourceBytes: () => Buffer.from(scenario.source),
    transportSourceBytes: () => Buffer.from(scenario.transportSource),
    now: () => new Date(Date.parse("2026-08-28T05:00:00.000Z") + nowCounter++ * 1000),
    monotonicMs: () => (monotonic += 25),
  };
  return scenario;
}

function rewriteAdmission(scenario: Scenario): void {
  writeSecure(scenario.config.admission_config_path, JSON.stringify(scenario.admission) + "\n");
  scenario.config.admission_config_sha256 = sha256(readFileSync(scenario.config.admission_config_path));
}

function stageIdFromInput(stdin: Buffer): string {
  const script = stdin.toString("ascii");
  const encoded = script.match(/FromBase64String\("([^"]+)"\)/u)?.[1];
  if (!encoded) return "unknown";
  return String(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")).stageId);
}

function stageOutput(stageId: string, admission: M4fDirectAdmissionConfig): Record<string, unknown> {
  const identity = {
    computer_name: admission.target.computer_name,
    identity_name: admission.target.identity_name,
    identity_sid: admission.target.identity_sid,
  };
  let payload: Record<string, unknown>;
  if (stageId === "wrapper-smoke") payload = { wrapper: "ok" };
  else if (stageId === "identity") payload = { identity };
  else if (stageId === "volumes") payload = { volumes: [
    { device_id: "C:", drive_type: 3, free_bytes: 10, size_bytes: 20, file_system: "NTFS" },
    { device_id: "D:", drive_type: 3, free_bytes: 30, size_bytes: 40, file_system: "NTFS" },
  ] };
  else if (stageId.startsWith("acl-")) {
    const index = Number(stageId.slice(4)) - 1;
    payload = { acl: {
      path: admission.target.acl_paths[index],
      exists: true,
      owner_sid: "S-1-5-32-544",
      protected: true,
      reparse: false,
      rules: [],
    } };
  } else if (stageId === "listeners") payload = { listeners: [] };
  else if (stageId === "processes") payload = { processes: [] };
  else if (stageId === "vivado-fact") payload = { vivado: {
    path: admission.target.vivado_executable,
    exists: true,
    length: 100,
    sha256: "a".repeat(64),
    file_version: "2021.1",
  } };
  else payload = { bun: {
    path: admission.target.bun_executable,
    exists: false,
    length: null,
    sha256: null,
    file_version: null,
  } };
  return {
    schema: "synthia-m4f-direct-staged-diagnostic-stage-result.v1",
    stage_id: stageId,
    observed_at_utc: "2026-08-28T05:00:00.000Z",
    identity: stageId === "wrapper-smoke" ? null : identity,
    payload,
    hardware_action_performed: false,
  };
}

function effectiveConfig(config: M4fDirectAdmissionConfig): string {
  return [
    "host 100.96.223.49", "hostname 100.96.223.49", "user admin", "port 22",
    "batchmode yes", "connecttimeout 15", "connectionattempts 1",
    "serveraliveinterval 0", "serveralivecountmax 4", "numberofpasswordprompts 0",
    "identityagent none", "identitiesonly yes", "pubkeyauthentication true",
    "passwordauthentication no", "kbdinteractiveauthentication no", "gssapiauthentication no",
    "hostbasedauthentication no", "preferredauthentications publickey",
    "stricthostkeychecking true", "forwardagent no", "clearallforwardings yes",
    "permitlocalcommand no", "controlmaster false", "controlpersist no",
    "warnweakcrypto no", "requesttty false", "identityfile " + config.target.identity_file,
    "userknownhostsfile " + config.target.known_hosts_file,
    "globalknownhostsfile /dev/null", "",
  ].join("\n");
}

function writeSecure(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function processResult(
  stdout = "",
  stderr = "",
  status: number | null = 0,
  signal: NodeJS.Signals | null = null,
  errorCode: string | null = null,
): RawProcessResult {
  return { status, signal, errorCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

function capture(action: () => unknown): Record<string, unknown> {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(StagedDiagnosticFailure);
    return (error as StagedDiagnosticFailure).detail;
  }
  throw new Error("expected StagedDiagnosticFailure");
}
