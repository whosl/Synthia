import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  buildDirectGateRootsRemoteScript,
  directGateRootsConfirmation,
  directGateRootsEffectBindingSha256,
  directGateRootsReviewConfigSha256,
  DirectGateRootsFailure,
  executeDirectGateRoots,
  planDirectGateRoots,
  recordDirectGateRoots,
  type DirectGateRootsDependencies,
  type M4fDirectAdmissionV2Approval,
  type M4fDirectGateRootsApproval,
  type M4fDirectGateRootsConfig,
  type M4fDirectGateRootsConfigV2,
  type M4fDirectGateRootsConfigV3,
  type RawProcessResult,
} from "./scripts/m4f-direct-gate-roots.ts";
import {
  buildDirectPowerShellStdinCommand,
  captureM4fDirectTransportInputs,
  directPowerShellStdinWrapperFact,
  M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE,
  type M4fDirectAdmissionConfig,
} from "./scripts/m4f-gate-admission-transport.ts";
import {
  admissionV2Confirmation,
  recordAdmissionV2,
  type AdmissionV2Dependencies,
  type AdmissionV2Record,
  type M4fDirectAdmissionV2Config,
} from "./scripts/m4f-direct-admission-v2.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("M4-F direct Gate-root ceremony", () => {
  test("plan is local-only and parameterizes two new target paths", () => {
    const scenario = fixture();
    const plan = planDirectGateRoots(scenario.config, scenario.dependencies);
    expect(plan).toMatchObject({
      schema: "synthia-m4f-direct-gate-roots-plan.v1",
      status: "planned_not_executed",
      gate_root: "C:\\Windows\\Temp\\synthia-m4f-gate-roots-test-01",
      backing_root: "D:\\synthia-m4f-toolchain-gate-roots-test-01",
      no_cleanup: true,
      network_attempted: false,
      remote_write_started: false,
    });
    expect(plan).toMatchObject({
      service_identity_sid: scenario.config.service_identity_sid,
      minimum_gate_free_bytes: scenario.config.minimum_gate_free_bytes,
      minimum_backing_free_bytes: scenario.config.minimum_backing_free_bytes,
      admission_config_sha256: scenario.config.admission_config_sha256,
      admission_record_sha256: scenario.config.admission_record_sha256,
      admission_approval_sha256: scenario.config.admission_approval_sha256,
    });
    expect(plan.config_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(plan).not.toHaveProperty("admission_contract");
    expect(plan).not.toHaveProperty("admission_id");
    expect(plan).not.toHaveProperty("base_admission_config_sha256");
    expect(plan).not.toHaveProperty("admission_config_canonical_sha256");
    expect(plan.confirmation).toBe(directGateRootsConfirmation(scenario.config));
    expect(scenario.calls).toHaveLength(0);
  });

  test("wrong confirmation creates no evidence and starts no process", () => {
    const scenario = fixture();
    const evidence = join(scenario.root, "must-not-exist");
    const failure = capture(() => recordDirectGateRoots(
      scenario.config,
      "wrong",
      evidence,
      scenario.dependencies,
    ));
    expect(failure).toMatchObject({
      code: "M4F_DIRECT_GATE_ROOTS_CONFIRMATION_REQUIRED",
      stage: "local_preflight",
      remote_write_state: "not_started",
      retry_permitted: false,
      cleanup_permitted: false,
    });
    expect(existsSync(evidence)).toBe(false);
    expect(scenario.calls).toHaveLength(0);
  });

  test("legacy v1 and v2 configs are plan-only and cannot create evidence or spawn", () => {
    for (const scenario of [fixture(), fixtureV2()]) {
      const evidence = join(scenario.root, "legacy-evidence-must-not-exist");
      const failure = capture(() => recordDirectGateRoots(
        scenario.config,
        confirmation(scenario),
        evidence,
        scenario.dependencies,
      ));
      expect(failure).toMatchObject({
        code: "M4F_DIRECT_GATE_ROOTS_LEGACY_EXECUTION_FORBIDDEN",
        stage: "local_preflight",
        remote_write_state: "not_started",
      });
      expect(existsSync(evidence)).toBe(false);
      expect(scenario.calls).toHaveLength(0);
    }
  });

  test("confirmation binds the complete roots effect config", () => {
    const scenario = fixture();
    const approved = confirmation(scenario);
    for (const mutate of [
      (config: M4fDirectGateRootsConfig) => { config.service_identity_sid = "S-1-5-21-100-200-300-1999"; },
      (config: M4fDirectGateRootsConfig) => { config.minimum_gate_free_bytes += 1; },
      (config: M4fDirectGateRootsConfig) => { config.minimum_backing_free_bytes += 1; },
      (config: M4fDirectGateRootsConfig) => { config.admission_record_sha256 = "0".repeat(64); },
    ]) {
      const changed = structuredClone(scenario.config);
      mutate(changed);
      expect(directGateRootsConfirmation(changed)).not.toBe(approved);
      const failure = capture(() => executeDirectGateRoots(changed, approved, scenario.dependencies));
      expect(failure.code).toBe("M4F_DIRECT_GATE_ROOTS_CONFIRMATION_REQUIRED");
      expect(scenario.calls).toHaveLength(0);
    }
  });

  test("accepts only direct admission config, record, and independent approval bindings", () => {
    for (const mutation of [
      (scenario: Scenario) => { scenario.admissionConfig.schema = "synthia-m4f-admission-config.v0" as never; },
      (scenario: Scenario) => { scenario.admissionConfig.target.host = "100.66.198.60" as never; },
      (scenario: Scenario) => { scenario.admissionRecord.schema = "synthia-m4f-gate-roots-record.v1"; },
      (scenario: Scenario) => { scenario.approval.schema = "synthia-m4f-approval.v0"; },
      (scenario: Scenario) => { scenario.approval.target_host = "192.168.31.66"; },
      (scenario: Scenario) => { scenario.approval.effective_config_sha256 = "0".repeat(64); },
      (scenario: Scenario) => { scenario.admissionRecord.remote_wrapper_sha256 = "0".repeat(64); },
    ]) {
      const scenario = fixture();
      mutation(scenario);
      rewriteBindings(scenario);
      const failure = capture(() => planDirectGateRoots(scenario.config));
      expect(String(failure.code)).toMatch(/^M4F_DIRECT_GATE_ROOTS_/u);
      expect(scenario.calls).toHaveLength(0);
    }
  });

  test("plans from an exact reviewed Admission v2 record without starting Gate-root transport", () => {
    const scenario = fixtureV2();
    expect(scenario.v2Calls).toHaveLength(2);
    expect(scenario.calls).toHaveLength(0);
    const plan = planDirectGateRoots(scenario.config, scenario.dependencies);
    expect(plan).toMatchObject({
      schema: "synthia-m4f-direct-gate-roots-plan.v1",
      status: "planned_not_executed",
      admission_contract: "v2",
      admission_id: scenario.v2Config.admission_id,
      admission_config_sha256: scenario.config.admission_config_sha256,
      admission_config_canonical_sha256: scenario.v2Record.config_sha256,
      base_admission_config_sha256: scenario.v2Config.admission_config_sha256,
      network_attempted: false,
      remote_write_started: false,
      gate_roots_source_sha256: scenario.config.expected_source_sha256,
      gate_roots_transport_source_sha256: scenario.config.expected_transport_source_sha256,
      admission_v2_validator_source_sha256: scenario.config.expected_admission_v2_source_sha256,
      gate_roots_wrapper_source_sha256: scenario.config.expected_wrapper_source_sha256,
      gate_roots_remote_script_sha256: scenario.config.expected_remote_script_sha256,
    });
    expect(scenario.calls).toHaveLength(0);
  });

  test("locks v2 and executable v3 service identity to LocalService", () => {
    const v2 = fixtureV2();
    const v3 = fixtureV3();
    expect(v2.config.service_identity_sid).toBe("S-1-5-19");
    expect(v3.config.service_identity_sid).toBe("S-1-5-19");

    const changedV2 = structuredClone(v2.config);
    changedV2.service_identity_sid = "S-1-5-21-100-200-300-1999";
    expect(capture(() => planDirectGateRoots(changedV2, v2.dependencies))).toMatchObject({
      code: "M4F_DIRECT_GATE_ROOTS_CONFIG_INVALID",
      remote_write_state: "not_started",
    });

    const changedV3 = structuredClone(v3.config);
    changedV3.service_identity_sid = "S-1-5-21-100-200-300-1999";
    expect(capture(() => executeDirectGateRoots(
      changedV3,
      "irrelevant-because-config-must-fail-first",
      v3.dependencies,
    ))).toMatchObject({
      code: "M4F_DIRECT_GATE_ROOTS_CONFIG_INVALID",
      remote_write_state: "not_started",
    });
    expect(v2.calls).toHaveLength(0);
    expect(v3.calls).toHaveLength(0);
  });

  test("v3 plan validates and prints the independent roots approval", () => {
    const scenario = fixtureV3();
    const plan = planDirectGateRoots(scenario.config, scenario.dependencies);
    expect(plan).toMatchObject({
      admission_contract: "v3",
      roots_review_config_sha256: scenario.rootsApproval.roots_review_config_sha256,
      roots_approval_sha256: scenario.config.roots_approval_sha256,
      roots_approval_reviewer: scenario.rootsApproval.reviewer,
      roots_approved_at_utc: scenario.rootsApproval.approved_at_utc,
      execution_authorized: true,
      network_attempted: false,
      remote_write_started: false,
    });
    expect(scenario.calls).toHaveLength(0);
  });

  test("carries independent roots approval and Admission v2 into v3 evidence", () => {
    const scenario = fixtureV3();
    const evidence = executeDirectGateRoots(
      scenario.config,
      confirmation(scenario),
      scenario.dependencies,
    );
    expect(scenario.calls).toHaveLength(2);
    expect(evidence.record).toMatchObject({
      schema: "synthia-m4f-direct-gate-roots-record.v3",
      admission_contract: "direct_admission_v2",
      admission_id: scenario.v2Config.admission_id,
      admission_v2_config_sha256: scenario.config.admission_config_sha256,
      admission_v2_config_canonical_sha256: scenario.v2Record.config_sha256,
      base_admission_config_sha256: scenario.v2Config.admission_config_sha256,
      admission_record_sha256: scenario.config.admission_record_sha256,
      admission_approval_sha256: scenario.config.admission_approval_sha256,
      gate_roots_transport_source_sha256: scenario.config.expected_transport_source_sha256,
      admission_v2_validator_source_sha256: scenario.config.expected_admission_v2_source_sha256,
      roots_review_config_sha256: scenario.rootsApproval.roots_review_config_sha256,
      roots_approval_sha256: scenario.config.roots_approval_sha256,
    });
  });

  test("v3 confirmation binds every reviewed Gate-root execution TCB hash", () => {
    const scenario = fixtureV3();
    const approved = confirmation(scenario);
    for (const field of [
      "expected_source_sha256",
      "expected_transport_source_sha256",
      "expected_admission_v2_source_sha256",
      "expected_wrapper_source_sha256",
      "expected_remote_script_sha256",
    ] as const) {
      const changed = structuredClone(scenario.config);
      changed[field] = "0".repeat(64);
      expect(directGateRootsConfirmation(changed)).not.toBe(approved);
      expect(capture(() => executeDirectGateRoots(changed, approved, scenario.dependencies)).code)
        .toBe("M4F_DIRECT_GATE_ROOTS_CONFIRMATION_REQUIRED");
      expect(scenario.calls).toHaveLength(0);
    }
  });

  test("rejects current Gate-root source or dependency replacement before first SSH", () => {
    for (const mutate of [
      (scenario: ScenarioV3) => {
        scenario.dependencies.sourceBytes = () => Buffer.from("replaced-gate-roots-source");
      },
      (scenario: ScenarioV3) => {
        scenario.dependencies.transportSourceBytes = () => Buffer.from("replaced-transport-source");
      },
      (scenario: ScenarioV3) => {
        scenario.dependencies.admissionV2SourceBytes = () => Buffer.from("replaced-admission-source");
      },
      (scenario: ScenarioV3) => {
        scenario.config.expected_remote_script_sha256 = "0".repeat(64);
      },
    ]) {
      const scenario = fixtureV3();
      mutate(scenario);
      const failure = capture(() => executeDirectGateRoots(
        scenario.config,
        confirmation(scenario),
        scenario.dependencies,
      ));
      expect(failure).toMatchObject({
        code: "M4F_DIRECT_GATE_ROOTS_EXECUTION_TCB_MISMATCH",
        stage: "local_preflight",
        remote_write_state: "not_started",
      });
      expect(scenario.calls).toHaveLength(0);
    }
  });

  test("rejects roots approval replacement or semantic substitution before first SSH", () => {
    const replaced = fixtureV3();
    const oldConfirmation = confirmation(replaced);
    writeSecure(replaced.config.roots_approval_path, JSON.stringify({
      ...replaced.rootsApproval,
      reviewer: "replacement-reviewer",
    }) + "\n");
    expect(capture(() => executeDirectGateRoots(
      replaced.config,
      oldConfirmation,
      replaced.dependencies,
    )).code).toBe("M4F_DIRECT_GATE_ROOTS_INPUT_UNTRUSTED");
    expect(replaced.calls).toHaveLength(0);

    for (const mutate of [
      (approval: M4fDirectGateRootsApproval) => { approval.roots_review_config_sha256 = "0".repeat(64); },
      (approval: M4fDirectGateRootsApproval) => { approval.gate_roots_source_sha256 = "0".repeat(64); },
      (approval: M4fDirectGateRootsApproval) => { approval.gate_roots_transport_source_sha256 = "0".repeat(64); },
      (approval: M4fDirectGateRootsApproval) => { approval.admission_v2_validator_source_sha256 = "0".repeat(64); },
      (approval: M4fDirectGateRootsApproval) => { approval.gate_roots_wrapper_source_sha256 = "0".repeat(64); },
      (approval: M4fDirectGateRootsApproval) => { approval.gate_roots_remote_script_sha256 = "0".repeat(64); },
      (approval: M4fDirectGateRootsApproval) => { approval.effect_binding_sha256 = "0".repeat(64); },
      (approval: M4fDirectGateRootsApproval) => { approval.target_identity_sid = "S-1-5-21-9-9-9-1001"; },
    ]) {
      const scenario = fixtureV3();
      mutate(scenario.rootsApproval);
      writeSecure(
        scenario.config.roots_approval_path,
        JSON.stringify(scenario.rootsApproval) + "\n",
      );
      scenario.config.roots_approval_sha256 = sha256(readFileSync(scenario.config.roots_approval_path));
      expect(capture(() => executeDirectGateRoots(
        scenario.config,
        confirmation(scenario),
        scenario.dependencies,
      )).code).toBe("M4F_DIRECT_GATE_ROOTS_APPROVAL_INVALID");
      expect(scenario.calls).toHaveLength(0);
    }

    for (const reviewer of [
      "independent-v2-reviewer",
      " Independent-V2-Reviewer ",
    ]) {
      const scenario = fixtureV3();
      scenario.rootsApproval.reviewer = reviewer;
      writeSecure(
        scenario.config.roots_approval_path,
        JSON.stringify(scenario.rootsApproval) + "\n",
      );
      scenario.config.roots_approval_sha256 = sha256(readFileSync(scenario.config.roots_approval_path));
      expect(capture(() => executeDirectGateRoots(
        scenario.config,
        confirmation(scenario),
        scenario.dependencies,
      )).code).toBe("M4F_DIRECT_GATE_ROOTS_APPROVAL_INVALID");
      expect(scenario.calls).toHaveLength(0);
    }
  });

  test("rejects v1/v2 contract confusion and every v2 binding substitution before SSH", () => {
    const v1AsV2 = fixture();
    v1AsV2.config.schema = "synthia-m4f-direct-gate-roots-config.v2";
    expect(capture(() => planDirectGateRoots(v1AsV2.config)).code)
      .toBe("M4F_DIRECT_GATE_ROOTS_CONFIG_INVALID");
    expect(v1AsV2.calls).toHaveLength(0);

    const v2AsV1 = fixtureV2();
    v2AsV1.config.schema = "synthia-m4f-direct-gate-roots-config.v1";
    expect(capture(() => planDirectGateRoots(v2AsV1.config)).code)
      .toBe("M4F_DIRECT_GATE_ROOTS_CONFIG_INVALID");
    expect(v2AsV1.calls).toHaveLength(0);

    for (const mutate of [
      (scenario: ScenarioV2) => {
        scenario.approval.schema = "synthia-m4f-direct-admission-approval.v1" as never;
      },
      (scenario: ScenarioV2) => {
        scenario.v2Record.schema = "synthia-m4f-direct-admission-record.v1" as never;
      },
      (scenario: ScenarioV2) => { scenario.approval.admission_id = "substituted-admission"; },
      (scenario: ScenarioV2) => {
        scenario.approval.admission_v2_config_canonical_sha256 = scenario.config.admission_config_sha256;
      },
      (scenario: ScenarioV2) => { scenario.approval.base_admission_config_sha256 = "0".repeat(64); },
      (scenario: ScenarioV2) => { scenario.approval.remote_compressed_sha256 = "0".repeat(64); },
      (scenario: ScenarioV2) => { scenario.approval.target_identity_sid = "S-1-5-21-9-9-9-1001"; },
      (scenario: ScenarioV2) => {
        scenario.v2Record.transport_inputs_after[0]!.sha256 = "0".repeat(64);
      },
      (scenario: ScenarioV2) => {
        ((scenario.v2Record.target_snapshot.identity as Record<string, unknown>)).whoami_sid =
          "S-1-5-21-9-9-9-1001";
      },
      (scenario: ScenarioV2) => { scenario.v2Record.remote_loader_sha256 = "0".repeat(64); },
    ]) {
      const scenario = fixtureV2();
      mutate(scenario);
      rewriteV2Bindings(scenario);
      const failure = capture(() => planDirectGateRoots(scenario.config));
      expect(String(failure.code)).toMatch(/^M4F_DIRECT_GATE_ROOTS_/u);
      expect(scenario.calls).toHaveLength(0);
    }
  });

  test("reuses the exact direct SSH policy and sends one ASCII script over stdin", () => {
    const scenario = fixtureV3();
    const evidence = executeDirectGateRoots(
      scenario.config,
      confirmation(scenario),
      scenario.dependencies,
    );
    expect(scenario.calls).toHaveLength(2);
    expect(scenario.calls[0]!.args[0]).toBe("-G");
    expect(scenario.calls[0]!.args).toContain("-T");
    expect(scenario.calls[1]!.args).toContain("-T");
    expect(scenario.calls[1]!.args.at(-1)).toBe(buildDirectPowerShellStdinCommand());
    expect(scenario.calls[1]!.args.at(-1)).toContain("-EncodedCommand ");
    expect(scenario.calls[1]!.args.at(-1)).not.toContain("-Command -");
    expect(scenario.calls[1]!.args.join(" ").length).toBeLessThan(8191);
    expect(scenario.calls[1]!.stdin).toEqual(evidence.remoteScript);
    expect(evidence.record.process).toMatchObject({
      stdin_length: evidence.remoteScript.length,
      stdin_sha256: sha256(evidence.remoteScript),
      outcome_ambiguous: false,
      retry_permitted: false,
    });
    expect(evidence.record).toMatchObject({
      remote_wrapper_length: directPowerShellStdinWrapperFact().source_length,
      remote_wrapper_sha256: directPowerShellStdinWrapperFact().source_sha256,
      remote_command_length: directPowerShellStdinWrapperFact().command_length,
    });
    expect(evidence.record.transport_inputs_before).toEqual(scenario.admissionRecord.local_inputs_after);
    expect(evidence.record.transport_inputs_after).toEqual(scenario.admissionRecord.local_inputs_after);
    for (const option of [
      "BatchMode=yes", "NumberOfPasswordPrompts=0", "IdentityAgent=none",
      "IdentitiesOnly=yes", "PubkeyAuthentication=yes", "PasswordAuthentication=no",
      "KbdInteractiveAuthentication=no", "GSSAPIAuthentication=no",
      "StrictHostKeyChecking=yes", "ForwardAgent=no", "ClearAllForwardings=yes",
      "ProxyCommand=none", "ProxyJump=none", "ControlMaster=no", "ControlPersist=no",
      "WarnWeakCrypto=no",
    ]) expect(scenario.calls[1]!.args).toContain(option);
  });

  test("rejects key or known-hosts replacement against admission facts before SSH", () => {
    for (const pathOf of [
      (scenario: Scenario) => scenario.admissionConfig.target.identity_file,
      (scenario: Scenario) => scenario.admissionConfig.target.known_hosts_file,
    ]) {
      const scenario = fixtureV3();
      writeSecure(pathOf(scenario), "replacement\n");
      const failure = capture(() => executeDirectGateRoots(
        scenario.config,
        confirmation(scenario),
        scenario.dependencies,
      ));
      expect(String(failure.code)).toMatch(/TRANSPORT_INPUT|KNOWN_HOSTS|HOST_KEY/u);
      expect(scenario.calls).toHaveLength(0);
    }
  });

  test("remote program proves pre/post volumes, strict C ancestry, record-only D ancestry, and exact roots", () => {
    const scenario = fixture();
    const script = buildDirectGateRootsRemoteScript(
      scenario.config,
      scenario.admissionConfig,
      sha256(confirmation(scenario)),
    );
    expect(script).toContain("M4F_DIRECT_GATE_ROOTS_ALREADY_EXISTS_GATE");
    expect(script).toContain("M4F_DIRECT_GATE_ROOTS_ALREADY_EXISTS_BACKING");
    expect(script.indexOf("ALREADY_EXISTS_BACKING")).toBeLessThan(script.indexOf("New-Item"));
    expect(script).toContain('Ancestors ([IO.Path]::GetDirectoryName($gateRoot)) "C:\\" $true');
    expect(script).toContain('Ancestors ([IO.Path]::GetDirectoryName($backingRoot)) "D:\\" $false');
    expect(script).toContain("M4F_DIRECT_GATE_ROOTS_VOLUME_MAPPING_DRIFT");
    expect(script).toContain("explicit_ace_count=3");
    expect(script).toContain("alternate_streams=$false");
    expect(script).toContain("No cleanup is intentional");
    expect(script).not.toMatch(/Remove-Item|program_hw|open_hw|connect_hw|write_bitstream|write_cfgmem|vivado/iu);
    expect((script.match(/New-Item -ItemType Directory/gu) ?? [])).toHaveLength(2);
  });

  test("is StrictMode-safe when Get-Volume has no SerialNumber and keeps every mapping gate", () => {
    const scenario = fixture();
    const script = buildDirectGateRootsRemoteScript(
      scenario.config,
      scenario.admissionConfig,
      sha256(confirmation(scenario)),
    );
    const firstWrite = script.indexOf("New-Item -ItemType Directory");
    expect(script).toContain("Set-StrictMode -Version Latest");
    expect(script).not.toContain("$volume.SerialNumber");
    expect(script.match(/\$volume\.([A-Za-z]+)/gu)?.sort()).toEqual([
      "$volume.DriveType",
      "$volume.FileSystem",
      "$volume.UniqueId",
      "$volume.UniqueId",
    ]);
    expect(script).toContain(
      "[string]::IsNullOrWhiteSpace([string]$logical[0].VolumeSerialNumber)",
    );
    expect((script.match(/\[string\]\$logical\[0\]\.VolumeSerialNumber/gu) ?? [])).toHaveLength(3);
    expect(script.indexOf("$logical[0].VolumeSerialNumber")).toBeLessThan(firstWrite);
    for (const binding of [
      "$volume.UniqueId",
      "$partition.DiskNumber",
      "$partition.PartitionNumber",
      "$disk.UniqueId",
      "$partition.AccessPaths",
      "$disk.IsOffline",
    ]) expect(script).toContain(binding);
  });

  test("reads native ACL SIDs without localized or untranslatable NTAccount displays", () => {
    const scenario = fixture();
    const script = buildDirectGateRootsRemoteScript(
      scenario.config,
      scenario.admissionConfig,
      sha256(confirmation(scenario)),
    );
    const ancestorStart = script.indexOf("function Ancestors(");
    const ancestorEnd = script.indexOf("function Root-Acl", ancestorStart);
    const ancestorFunction = script.slice(ancestorStart, ancestorEnd);
    const rootAclStart = script.indexOf("function Root-Acl");
    const rootAclEnd = script.indexOf("function Root-Fact", rootAclStart);
    const rootAclFunction = script.slice(rootAclStart, rootAclEnd);
    const rootStart = script.indexOf("function Root-Fact(");
    const rootEnd = script.indexOf("$gateVolumeBefore=Volume-Fact", rootStart);
    const rootFunction = script.slice(rootStart, rootEnd);
    const firstWrite = script.indexOf("New-Item -ItemType Directory");

    expect(ancestorFunction).toContain(
      "$acl.GetOwner([Security.Principal.SecurityIdentifier])",
    );
    expect(ancestorFunction).toContain(
      "$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])",
    );
    expect(rootFunction).toContain(
      "$acl.GetOwner([Security.Principal.SecurityIdentifier])",
    );
    expect(rootFunction).toContain(
      "$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])",
    );
    expect(script).toContain(
      'SecurityIdentifier]::new("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464")',
    );
    expect(script).not.toContain("function Sid(");
    expect(script).not.toContain("Security.Principal.NTAccount");
    expect(script).not.toContain(".Translate(");
    expect(script).not.toContain("$acl.Owner");
    expect(script).not.toContain("$acl.Access");
    expect(rootAclFunction).toContain("$acl.SetOwner($administratorsSid)");
    expect((rootAclFunction.match(/FileSystemAccessRule\]::new\(/gu) ?? [])).toHaveLength(3);
    expect(rootAclFunction).toContain("FileSystemAccessRule]::new($serviceSid");
    for (const capture of [
      '[object[]]$gateAncestorsBefore=@(Ancestors ([IO.Path]::GetDirectoryName($gateRoot)) "C:\\" $true)',
      '[object[]]$backingAncestorsBefore=@(Ancestors ([IO.Path]::GetDirectoryName($backingRoot)) "D:\\" $false)',
    ]) {
      expect(script.indexOf(capture)).toBeGreaterThanOrEqual(0);
      expect(script.indexOf(capture)).toBeLessThan(firstWrite);
    }
  });

  test("requires exact native SecurityIdentifier owner and rule references", () => {
    const scenario = fixture();
    const script = buildDirectGateRootsRemoteScript(
      scenario.config,
      scenario.admissionConfig,
      sha256(confirmation(scenario)),
    );
    const ancestorStart = script.indexOf("function Ancestors(");
    const ancestorEnd = script.indexOf("function Root-Acl", ancestorStart);
    const ancestorFunction = script.slice(ancestorStart, ancestorEnd);
    const rootStart = script.indexOf("function Root-Fact(");
    const rootEnd = script.indexOf("$gateVolumeBefore=Volume-Fact", rootStart);
    const rootFunction = script.slice(rootStart, rootEnd);

    expect(ancestorFunction).toContain(
      "-not ($ownerReference -is [Security.Principal.SecurityIdentifier])",
    );
    expect(ancestorFunction).toContain(
      "-not ($_.IdentityReference -is [Security.Principal.SecurityIdentifier])",
    );
    expect(ancestorFunction).toContain("M4F_DIRECT_GATE_ROOTS_ANCESTOR_OWNER_SID_INVALID");
    expect(ancestorFunction).toContain("M4F_DIRECT_GATE_ROOTS_ANCESTOR_RULE_SID_INVALID");
    expect(ancestorFunction).toContain("$owner=$ownerReference.Value");
    expect(ancestorFunction).toContain("$sid=$_.IdentityReference.Value");
    expect(ancestorFunction).toContain("$StrictAcl -and -not ($trusted -ccontains $owner)");
    expect(ancestorFunction).toContain("(($rights -band 852032) -ne 0)");
    expect(rootFunction).toContain(
      "-not ($ownerReference -is [Security.Principal.SecurityIdentifier])",
    );
    expect(rootFunction).toContain(
      "-not ($_.IdentityReference -is [Security.Principal.SecurityIdentifier])",
    );
    expect(rootFunction).toContain("M4F_DIRECT_GATE_ROOTS_ROOT_RULE_SID_INVALID");
    expect(rootFunction).toContain("owner_sid=$ownerReference.Value");
    expect(rootFunction).toContain("$sid=$_.IdentityReference.Value");
    expect(rootFunction).toContain("$ownerReference.Value -cne $administratorsSid.Value");
    expect(rootFunction).toContain("$rules.Count -ne 3");
    expect(rootFunction).toContain("-not $expected.ContainsKey($sid)");
  });

  test("accepts native Windows application-package SID facts without account names", () => {
    const scenario = fixtureV3();
    const gateBefore = (scenario.remoteResult.gate_ancestors_before as Record<string, unknown>[])[0]!;
    gateBefore.rules = [
      {
        sid: "S-1-15-2-1",
        type: "Allow",
        rights: 1,
        inherited: true,
        inheritance: "ContainerInherit, ObjectInherit",
        propagation: "None",
        applies_to_current: true,
      },
      {
        sid: "S-1-15-2-2",
        type: "Allow",
        rights: 1,
        inherited: true,
        inheritance: "ContainerInherit, ObjectInherit",
        propagation: "None",
        applies_to_current: true,
      },
    ];

    expect(executeDirectGateRoots(
      scenario.config,
      confirmation(scenario),
      scenario.dependencies,
    ).record.status).toBe("created");
  });

  test("uses raw DirectoryInfo type checks when walking PowerShell 5.1 parents", () => {
    const scenario = fixture();
    const script = buildDirectGateRootsRemoteScript(
      scenario.config,
      scenario.admissionConfig,
      sha256(confirmation(scenario)),
    );
    const ancestorStart = script.indexOf("function Ancestors(");
    const ancestorEnd = script.indexOf("function Root-Acl", ancestorStart);
    const ancestorFunction = script.slice(ancestorStart, ancestorEnd);
    const firstWrite = script.indexOf("New-Item -ItemType Directory");

    expect(ancestorStart).toBeGreaterThanOrEqual(0);
    expect(ancestorEnd).toBeGreaterThan(ancestorStart);
    expect(ancestorFunction).toContain("$current=$current.Parent");
    expect(ancestorFunction).toContain("-not ($current -is [IO.DirectoryInfo])");
    expect(ancestorFunction).not.toContain("$current.PSIsContainer");
    expect(ancestorFunction.indexOf("$current -is [IO.DirectoryInfo]")).toBeLessThan(
      ancestorFunction.indexOf("Get-Acl -LiteralPath $current.FullName"),
    );
    for (const capture of [
      '[object[]]$gateAncestorsBefore=@(Ancestors ([IO.Path]::GetDirectoryName($gateRoot)) "C:\\" $true)',
      '[object[]]$backingAncestorsBefore=@(Ancestors ([IO.Path]::GetDirectoryName($backingRoot)) "D:\\" $false)',
    ]) {
      expect(script.indexOf(capture)).toBeGreaterThanOrEqual(0);
      expect(script.indexOf(capture)).toBeLessThan(firstWrite);
    }
  });

  test("preserves one- and three-element ancestor chains as flat JSON arrays", () => {
    const scenario = fixtureV3();
    const script = buildDirectGateRootsRemoteScript(
      scenario.config,
      scenario.admissionConfig,
      sha256(confirmation(scenario)),
    );
    const ancestorStart = script.indexOf("function Ancestors(");
    const ancestorEnd = script.indexOf("function Root-Acl", ancestorStart);
    const ancestorFunction = script.slice(ancestorStart, ancestorEnd);
    expect(ancestorFunction).toContain("$facts; return");
    expect(ancestorFunction).not.toContain("Write-Output -NoEnumerate");
    expect(ancestorFunction).not.toContain("return @($facts)");
    for (const capture of [
      '[object[]]$gateAncestorsBefore=@(Ancestors ([IO.Path]::GetDirectoryName($gateRoot)) "C:\\" $true)',
      '[object[]]$backingAncestorsBefore=@(Ancestors ([IO.Path]::GetDirectoryName($backingRoot)) "D:\\" $false)',
      '[object[]]$gateAncestorsAfter=@(Ancestors $gateRoot "C:\\" $true)',
      '[object[]]$backingAncestorsAfter=@(Ancestors $backingRoot "D:\\" $false)',
    ]) expect(script).toContain(capture);

    scenario.remoteResult.gate_ancestors_before = [
      ancestorFact("C:\\Windows\\Temp", true),
      ancestorFact("C:\\Windows", true),
      ancestorFact("C:\\", true),
    ];
    scenario.remoteResult.gate_ancestors_after = [
      ancestorFact("C:\\Windows\\Temp\\synthia-m4f-" + scenario.config.gate_id, true),
      ancestorFact("C:\\Windows\\Temp", true),
      ancestorFact("C:\\Windows", true),
    ];
    const serialized = JSON.parse(JSON.stringify(scenario.remoteResult)) as Record<string, unknown>;
    expect(Array.isArray(serialized.backing_ancestors_before)).toBe(true);
    expect(serialized.backing_ancestors_before).toHaveLength(1);
    expect(Array.isArray(serialized.gate_ancestors_before)).toBe(true);
    expect(serialized.gate_ancestors_before).toHaveLength(3);
    expect((serialized.gate_ancestors_before as unknown[]).every(
      (fact) => !Array.isArray(fact),
    )).toBe(true);
    expect(executeDirectGateRoots(
      scenario.config,
      confirmation(scenario),
      scenario.dependencies,
    ).record.status).toBe("created");

    const unwrapped = fixtureV3();
    unwrapped.remoteResult.backing_ancestors_before = ancestorFact("D:\\", false);
    expect(capture(() => executeDirectGateRoots(
      unwrapped.config,
      confirmation(unwrapped),
      unwrapped.dependencies,
    )).code).toBe("M4F_DIRECT_GATE_ROOTS_OUTPUT_INVALID");

    const nested = fixtureV3();
    nested.remoteResult.gate_ancestors_before = [[
      ancestorFact("C:\\Windows\\Temp", true),
      ancestorFact("C:\\Windows", true),
      ancestorFact("C:\\", true),
    ]];
    expect(capture(() => executeDirectGateRoots(
      nested.config,
      confirmation(nested),
      nested.dependencies,
    )).code).toBe("M4F_DIRECT_GATE_ROOTS_OUTPUT_INVALID");
  });

  test("Windows PowerShell 5.1 serializes typed pipeline captures as flat arrays", () => {
    if (process.platform !== "win32") return;
    const source = [
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference=\"Stop\"",
      "function Ancestors([int]$Count) { $facts=@(); for ($index=0; $index -lt $Count; $index+=1) { $facts+=,[ordered]@{ path=(\"fact-\"+$index); rules=@() } }; $facts; return }",
      "[object[]]$backingAncestorsBefore=@(Ancestors 1)",
      "[object[]]$gateAncestorsBefore=@(Ancestors 3)",
      "$result=[ordered]@{ backing_ancestors_before=$backingAncestorsBefore; gate_ancestors_before=$gateAncestorsBefore }",
      "$result | ConvertTo-Json -Compress -Depth 8",
    ].join("; ");
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      source,
    ], { encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe("");
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(Array.isArray(parsed.backing_ancestors_before)).toBe(true);
    expect(parsed.backing_ancestors_before).toHaveLength(1);
    expect(Array.isArray(parsed.gate_ancestors_before)).toBe(true);
    expect(parsed.gate_ancestors_before).toHaveLength(3);
    for (const key of ["backing_ancestors_before", "gate_ancestors_before"]) {
      expect((parsed[key] as unknown[]).every(
        (fact) => typeof fact === "object" && fact !== null && !Array.isArray(fact),
      )).toBe(true);
    }
  });

  test("accepts only DirectoryInfo for created roots before object and ACL facts", () => {
    const scenario = fixture();
    const script = buildDirectGateRootsRemoteScript(
      scenario.config,
      scenario.admissionConfig,
      sha256(confirmation(scenario)),
    );
    const rootStart = script.indexOf("function Root-Fact(");
    const rootEnd = script.indexOf("$gateVolumeBefore=Volume-Fact", rootStart);
    const rootFunction = script.slice(rootStart, rootEnd);
    const firstWrite = script.indexOf("New-Item -ItemType Directory");

    expect(rootStart).toBeGreaterThanOrEqual(0);
    expect(rootEnd).toBeGreaterThan(rootStart);
    expect(rootStart).toBeLessThan(firstWrite);
    expect(rootFunction).toContain("-not ($item -is [IO.DirectoryInfo])");
    expect(rootFunction).not.toContain("$item.PSIsContainer");
    expect(rootFunction.indexOf("$item -is [IO.DirectoryInfo]")).toBeLessThan(
      rootFunction.indexOf("$item.Attributes -band [IO.FileAttributes]::ReparsePoint"),
    );
    expect(rootFunction).toContain("Get-ChildItem -LiteralPath $Path -Force");
    expect(rootFunction).toContain("Get-Item -LiteralPath $Path -Stream *");
    expect(rootFunction).toContain("Get-Acl -LiteralPath $Path");
  });

  test("single-shot failures are unknown, never retried, and never cleaned", () => {
    for (const raw of [
      processResult("", "", null, null, "ETIMEDOUT"),
      processResult("", "", null, "SIGTERM", null),
      processResult("", "ssh failed", 255, null, null),
    ]) {
      const scenario = fixtureV3();
      scenario.networkResult = raw;
      const failure = capture(() => executeDirectGateRoots(
        scenario.config,
        confirmation(scenario),
        scenario.dependencies,
      ));
      expect(failure).toMatchObject({
        code: "M4F_DIRECT_GATE_ROOTS_TRANSPORT_FAILED",
        stage: "remote_write",
        remote_write_state: "unknown",
        retry_permitted: false,
        cleanup_permitted: false,
      });
      expect(failure.process).toMatchObject({ outcome_ambiguous: true, retry_permitted: false });
      expect(scenario.calls).toHaveLength(2);
    }
  });

  test("freezes all available evidence after a failed remote write", () => {
    const scenario = fixtureV3();
    const evidence = join(scenario.root, "failed-remote-evidence");
    const rawStdout = Buffer.from('{"partial":true}\r\n');
    const rawStderr = Buffer.from("remote PowerShell failed\r\n");
    scenario.networkResult = {
      status: 255,
      signal: null,
      errorCode: null,
      stdout: rawStdout,
      stderr: rawStderr,
    };
    const failure = capture(() => recordDirectGateRoots(
      scenario.config,
      confirmation(scenario),
      evidence,
      scenario.dependencies,
    ));
    expect(failure).toMatchObject({
      code: "M4F_DIRECT_GATE_ROOTS_TRANSPORT_FAILED",
      stage: "remote_write",
      remote_write_state: "unknown",
      remote_attempt: {
        started: true,
        process_result_returned: true,
        raw_stdout_captured: true,
        raw_stderr_captured: true,
      },
    });
    expect(readFileSync(join(evidence, "direct-ssh-effective-config.txt")))
      .toEqual(Buffer.from(scenario.effective));
    expect(readFileSync(join(evidence, "remote-gate-roots-script.ps1")))
      .toEqual(scenario.calls[1]!.stdin);
    expect(readFileSync(join(evidence, "remote-gate-roots-stdout.bin"))).toEqual(rawStdout);
    expect(readFileSync(join(evidence, "remote-gate-roots-stderr.bin"))).toEqual(rawStderr);
    expect(JSON.parse(readFileSync(
      join(evidence, "remote-gate-roots-process.json"),
      "utf8",
    ))).toMatchObject({
      exit_status: 255,
      stderr_length: rawStderr.length,
      retry_permitted: false,
    });
    expect(JSON.parse(readFileSync(
      join(evidence, "remote-write-attempt.json"),
      "utf8",
    ))).toMatchObject({
      started: true,
      process_result_returned: true,
    });
    for (const name of [
      "gate-roots-failure.json",
      "direct-ssh-effective-config.txt",
      "powershell-stdin-wrapper.ps1",
      "remote-gate-roots-script.ps1",
      "remote-gate-roots-stdout.bin",
      "remote-gate-roots-stderr.bin",
      "remote-gate-roots-process.json",
      "remote-write-attempt.json",
    ]) expect(lstatSync(join(evidence, name)).mode & 0o777).toBe(0o600);
    expect(scenario.calls).toHaveLength(2);
  });

  test("preserves the original failure if one best-effort evidence write fails", () => {
    const scenario = fixtureV3();
    const evidence = join(scenario.root, "partially-colliding-evidence");
    scenario.networkResult = processResult("partial", "ssh failed", 255);
    const originalSpawn = scenario.dependencies.spawn;
    scenario.dependencies.spawn = (executable, args, stdin, timeoutMs) => {
      const result = originalSpawn(executable, args, stdin, timeoutMs);
      if (scenario.calls.length === 2) {
        writeSecure(join(evidence, "remote-gate-roots-stdout.bin"), "preexisting-collision");
      }
      return result;
    };
    const failure = capture(() => recordDirectGateRoots(
      scenario.config,
      confirmation(scenario),
      evidence,
      scenario.dependencies,
    ));
    expect(failure.code).toBe("M4F_DIRECT_GATE_ROOTS_TRANSPORT_FAILED");
    expect(JSON.parse(readFileSync(join(evidence, "gate-roots-failure.json"), "utf8")))
      .toMatchObject({ code: "M4F_DIRECT_GATE_ROOTS_TRANSPORT_FAILED" });
    expect(existsSync(join(evidence, "remote-gate-roots-stderr.bin"))).toBe(true);
    expect(scenario.calls).toHaveLength(2);
  });

  test("records a remote-attempt marker when process invocation returns no result", () => {
    const scenario = fixtureV3();
    const evidence = join(scenario.root, "throwing-spawn-evidence");
    const originalSpawn = scenario.dependencies.spawn;
    scenario.dependencies.spawn = (executable, args, stdin, timeoutMs) => {
      if (scenario.calls.length === 1) {
        scenario.calls.push({ executable, args, stdin: Buffer.from(stdin), timeoutMs });
        throw new Error("synthetic spawn exception");
      }
      return originalSpawn(executable, args, stdin, timeoutMs);
    };
    const failure = capture(() => recordDirectGateRoots(
      scenario.config,
      confirmation(scenario),
      evidence,
      scenario.dependencies,
    ));
    expect(failure).toMatchObject({
      code: "M4F_DIRECT_GATE_ROOTS_TRANSPORT_INVOCATION_FAILED",
      stage: "remote_write",
      remote_attempt: {
        started: true,
        process_result_returned: false,
        raw_stdout_captured: false,
        raw_stderr_captured: false,
      },
    });
    expect(readFileSync(join(evidence, "direct-ssh-effective-config.txt")))
      .toEqual(Buffer.from(scenario.effective));
    expect(readFileSync(join(evidence, "remote-gate-roots-script.ps1")))
      .toEqual(scenario.calls[1]!.stdin);
    expect(existsSync(join(evidence, "remote-gate-roots-stdout.bin"))).toBe(false);
    expect(existsSync(join(evidence, "remote-gate-roots-process.json"))).toBe(false);
    expect(scenario.calls).toHaveLength(2);
  });

  test("rejects effective-config drift and malformed remote facts", () => {
    const drift = fixtureV3();
    drift.effective = drift.effective.replace("requesttty false", "requesttty true");
    expect(capture(() => executeDirectGateRoots(
      drift.config,
      confirmation(drift),
      drift.dependencies,
    )).code).toBe("M4F_DIRECT_GATE_ROOTS_EFFECTIVE_CONFIG_MISMATCH");
    expect(drift.calls).toHaveLength(1);

    for (const mutate of [
      (result: Record<string, unknown>) => { result.created_count = 1; },
      (result: Record<string, unknown>) => { result.gate_root_fact = {}; },
      (result: Record<string, unknown>) => { (result.gate_volume_after as Record<string, unknown>).disk_unique_id = "drift"; },
      (result: Record<string, unknown>) => { (result.gate_volume_before as Record<string, unknown>).volume_serial_number = "different-source"; },
      (result: Record<string, unknown>) => { result.backing_ancestors_after = []; },
      (result: Record<string, unknown>) => { result.no_cleanup = false; },
    ]) {
      const scenario = fixtureV3();
      mutate(scenario.remoteResult);
      expect(capture(() => executeDirectGateRoots(
        scenario.config,
        confirmation(scenario),
        scenario.dependencies,
      )).code).toBe("M4F_DIRECT_GATE_ROOTS_OUTPUT_INVALID");
      expect(scenario.calls).toHaveLength(2);
    }
  });

  test("accepts the signed Int32 ACL rights emitted by Windows", () => {
    const scenario = fixtureV3();
    const backingBefore = (scenario.remoteResult.backing_ancestors_before as Record<string, unknown>[])[0]!;
    backingBefore.rules = [{
      sid: "S-1-5-32-545",
      type: "Allow",
      rights: -536805376,
      inherited: true,
      inheritance: "ContainerInherit, ObjectInherit",
      propagation: "None",
      applies_to_current: true,
    }];
    expect(executeDirectGateRoots(
      scenario.config,
      confirmation(scenario),
      scenario.dependencies,
    ).record.status).toBe("created");

    const outsideInt32 = fixtureV3();
    const invalidBacking = (outsideInt32.remoteResult.backing_ancestors_before as Record<string, unknown>[])[0]!;
    invalidBacking.rules = [{
      sid: "S-1-5-32-545",
      type: "Allow",
      rights: 2_147_483_648,
      inherited: true,
      inheritance: "ContainerInherit, ObjectInherit",
      propagation: "None",
      applies_to_current: true,
    }];
    expect(capture(() => executeDirectGateRoots(
      outsideInt32.config,
      confirmation(outsideInt32),
      outsideInt32.dependencies,
    )).code).toBe("M4F_DIRECT_GATE_ROOTS_OUTPUT_INVALID");
  });

  test("records a new 0700 evidence directory with 0600 exact-input evidence", () => {
    const scenario = fixtureV3();
    const evidence = join(scenario.root, "new-evidence");
    recordDirectGateRoots(scenario.config, confirmation(scenario), evidence, scenario.dependencies);
    expect(lstatSync(evidence).mode & 0o777).toBe(0o700);
    for (const name of [
      "gate-roots-record.json",
      "direct-ssh-effective-config.txt",
      "powershell-stdin-wrapper.ps1",
      "remote-gate-roots-script.ps1",
      "remote-gate-roots-result.json",
    ]) expect(lstatSync(join(evidence, name)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(evidence, "remote-gate-roots-script.ps1")))
      .toEqual(scenario.calls[1]!.stdin);
    expect(readFileSync(join(evidence, "powershell-stdin-wrapper.ps1"), "ascii"))
      .toBe(M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE);

    expect(capture(() => recordDirectGateRoots(
      scenario.config,
      confirmation(scenario),
      evidence,
      scenario.dependencies,
    )).code).toBe("M4F_DIRECT_GATE_ROOTS_EVIDENCE_DIRECTORY_INVALID");
    expect(scenario.calls).toHaveLength(2);
  });
});

interface Scenario {
  root: string;
  admissionConfig: M4fDirectAdmissionConfig;
  admissionRecord: Record<string, unknown>;
  approval: Record<string, unknown>;
  config: M4fDirectGateRootsConfig;
  effective: string;
  remoteResult: Record<string, unknown>;
  networkResult: RawProcessResult | null;
  calls: Array<{ executable: string; args: readonly string[]; stdin: Buffer; timeoutMs: number }>;
  dependencies: DirectGateRootsDependencies;
}

interface ScenarioV2 extends Scenario {
  config: M4fDirectGateRootsConfigV2;
  v2Config: M4fDirectAdmissionV2Config;
  v2Record: AdmissionV2Record;
  approval: M4fDirectAdmissionV2Approval;
  v2Calls: Array<{ args: readonly string[]; stdin: Buffer; timeoutMs: number }>;
}

type ScenarioV3 = Omit<ScenarioV2, "config"> & {
  config: M4fDirectGateRootsConfigV3;
  rootsApproval: M4fDirectGateRootsApproval;
};

function fixture(): Scenario {
  const root = mkdtempSync(join(tmpdir(), "synthia-direct-gate-roots-"));
  roots.push(root);
  const identityFile = join(root, "target-id");
  const knownHostsFile = join(root, "target-known-hosts");
  const hostKey = Buffer.from(Array.from({ length: 48 }, (_, index) => index + 1));
  const hostFingerprint = "SHA256:"
    + createHash("sha256").update(hostKey).digest("base64").replace(/=+$/u, "");
  writeSecure(identityFile, "private-key-placeholder\n");
  writeSecure(knownHostsFile, "100.96.223.49 ssh-ed25519 " + hostKey.toString("base64") + "\n");
  const admissionConfig: M4fDirectAdmissionConfig = {
    schema: "synthia-m4f-direct-admission-config.v1",
    gate_id: "gate-roots-test-01",
    target: {
      host: "100.96.223.49",
      port: 22,
      user: "admin",
      computer_name: "DESKTOP-DVFFB09",
      identity_name: "desktop-dvffb09\\admin",
      identity_sid: "S-1-5-21-100-200-300-1001",
      identity_file: identityFile,
      known_hosts_file: knownHostsFile,
      known_hosts_host_token: "100.96.223.49",
      host_key_fingerprint: hostFingerprint,
      expected_effective_config_sha256: null,
      acl_paths: ["C:\\Windows\\Temp", "D:\\synthia-worker"],
      vivado_executable: "D:\\Xilinx\\Vivado\\2021.1\\bin\\vivado.bat",
      bun_executable: "D:\\synthia-worker\\runtime\\bun.exe",
    },
  };
  const effective = effectiveConfig(admissionConfig);
  const scenario = {
    root,
    admissionConfig,
    admissionRecord: {},
    approval: {},
    config: {} as M4fDirectGateRootsConfig,
    effective,
    remoteResult: {},
    networkResult: null,
    calls: [],
    dependencies: {} as DirectGateRootsDependencies,
  } satisfies Scenario;
  initializeBindings(scenario);
  scenario.remoteResult = remoteResult(scenario);
  scenario.dependencies = {
    spawn(executable, args, stdin, timeoutMs) {
      scenario.calls.push({ executable, args, stdin: Buffer.from(stdin), timeoutMs });
      if (scenario.calls.length === 1) return processResult(scenario.effective);
      return scenario.networkResult ?? processResult(JSON.stringify(scenario.remoteResult) + "\n");
    },
    sourceBytes: () => Buffer.from("direct-gate-roots-source"),
    transportSourceBytes: () => Buffer.from("unused-v1-transport-source"),
    admissionV2SourceBytes: () => Buffer.from("unused-v1-admission-source"),
    now: () => new Date("2026-08-28T02:03:04.000Z"),
  };
  return scenario;
}

function fixtureV2(): ScenarioV2 {
  const scenario = fixture();
  scenario.admissionConfig.target.acl_paths = [
    "C:\\Windows\\Temp",
    "D:\\synthia-worker",
    "D:\\Xilinx\\Vivado\\2021.1",
  ];
  scenario.admissionConfig.target.bun_executable =
    "D:\\synthia-worker\\runtime\\bun-1.4.1\\bun.exe";
  scenario.effective = effectiveConfig(scenario.admissionConfig);
  scenario.admissionConfig.target.expected_effective_config_sha256 = sha256(scenario.effective);
  const baseAdmissionConfigPath = scenario.config.admission_config_path;
  writeSecure(baseAdmissionConfigPath, JSON.stringify(scenario.admissionConfig) + "\n");
  const baseAdmissionConfigSha256 = sha256(readFileSync(baseAdmissionConfigPath));
  const source = Buffer.from("admission-v2-source");
  const transport = Buffer.from("admission-v2-transport");
  const loader = Buffer.from("admission-v2-loader");
  const v2Config: M4fDirectAdmissionV2Config = {
    schema: "synthia-m4f-direct-admission-v2-config.v1",
    admission_id: "admission-v2-gate-roots-01",
    admission_config_path: baseAdmissionConfigPath,
    admission_config_sha256: baseAdmissionConfigSha256,
    expected_source_sha256: sha256(source),
    expected_transport_source_sha256: sha256(transport),
    expected_loader_source_sha256: sha256(loader),
  };
  const v2ConfigPath = join(scenario.root, "admission-v2-config.json");
  writeSecure(v2ConfigPath, JSON.stringify(v2Config) + "\n");
  const v2Calls: ScenarioV2["v2Calls"] = [];
  const v2Dependencies: AdmissionV2Dependencies = {
    spawn(_executable, args, stdin, timeoutMs) {
      v2Calls.push({ args, stdin: Buffer.from(stdin), timeoutMs });
      return args[0] === "-G"
        ? processResult(scenario.effective)
        : processResult(JSON.stringify(compactV2Snapshot(scenario.admissionConfig)) + "\n");
    },
    sourceBytes: () => Buffer.from(source),
    transportSourceBytes: () => Buffer.from(transport),
    loaderSourceBytes: () => Buffer.from(loader),
    now: () => new Date("2026-08-28T01:00:00.000Z"),
    monotonicMs: (() => {
      let tick = 0;
      return () => (tick += 25);
    })(),
  };
  const v2Evidence = join(scenario.root, "admission-v2-evidence");
  const v2Record = recordAdmissionV2(
    v2Config,
    admissionV2Confirmation(v2Config),
    v2Evidence,
    v2Dependencies,
  );
  const v2RecordPath = join(v2Evidence, "admission-v2-record.json");
  const v2RecordSha256 = sha256(readFileSync(v2RecordPath));
  const approval: M4fDirectAdmissionV2Approval = {
    schema: "synthia-m4f-direct-admission-v2-approval.v1",
    decision: "approved",
    gate_id: scenario.admissionConfig.gate_id,
    admission_id: v2Config.admission_id,
    reviewer: "independent-v2-reviewer",
    approved_at_utc: "2026-08-28T01:30:00.000Z",
    admission_v2_config_sha256: sha256(readFileSync(v2ConfigPath)),
    admission_v2_config_canonical_sha256: v2Record.config_sha256,
    base_admission_config_sha256: baseAdmissionConfigSha256,
    admission_record_sha256: v2RecordSha256,
    effective_config_sha256: v2Record.effective_config_sha256,
    source_sha256: v2Record.source_sha256,
    transport_source_sha256: v2Record.transport_source_sha256,
    loader_source_sha256: v2Record.loader_source_sha256,
    remote_script_sha256: v2Record.remote_script_sha256,
    remote_compressed_sha256: v2Record.remote_compressed_sha256,
    remote_loader_sha256: v2Record.remote_loader_sha256,
    target_host: "100.96.223.49",
    target_user: "admin",
    target_computer: "DESKTOP-DVFFB09",
    target_identity_name: scenario.admissionConfig.target.identity_name,
    target_identity_sid: scenario.admissionConfig.target.identity_sid,
    host_key_fingerprint: scenario.admissionConfig.target.host_key_fingerprint,
  };
  const approvalPath = join(scenario.root, "admission-v2-approval.json");
  writeSecure(approvalPath, JSON.stringify(approval) + "\n");
  scenario.config = {
    schema: "synthia-m4f-direct-gate-roots-config.v2",
    gate_id: scenario.admissionConfig.gate_id,
    service_identity_sid: "S-1-5-19",
    minimum_gate_free_bytes: 10 * 1024 * 1024 * 1024,
    minimum_backing_free_bytes: 20 * 1024 * 1024 * 1024,
    admission_config_path: v2ConfigPath,
    admission_config_sha256: sha256(readFileSync(v2ConfigPath)),
    admission_record_path: v2RecordPath,
    admission_record_sha256: v2RecordSha256,
    admission_approval_path: approvalPath,
    admission_approval_sha256: sha256(readFileSync(approvalPath)),
    expected_source_sha256: sha256(Buffer.from("direct-gate-roots-source")),
    expected_transport_source_sha256: sha256(transport),
    expected_admission_v2_source_sha256: sha256(source),
    expected_wrapper_source_sha256: directPowerShellStdinWrapperFact().source_sha256,
    expected_remote_script_sha256: "0".repeat(64),
  };
  scenario.dependencies.transportSourceBytes = () => Buffer.from(transport);
  scenario.dependencies.admissionV2SourceBytes = () => Buffer.from(source);
  const effectBinding = directGateRootsEffectBindingSha256(
    scenario.config,
    scenario.admissionConfig,
  );
  scenario.config.expected_remote_script_sha256 = sha256(Buffer.from(
    buildDirectGateRootsRemoteScript(scenario.config, scenario.admissionConfig, effectBinding),
    "ascii",
  ));
  scenario.remoteResult = remoteResult(scenario);
  return Object.assign(scenario, { v2Config, v2Record, approval, v2Calls });
}

function fixtureV3(): ScenarioV3 {
  const scenario = fixtureV2();
  const rootsApprovalPath = join(scenario.root, "gate-roots-approval.json");
  const config: M4fDirectGateRootsConfigV3 = {
    ...scenario.config,
    schema: "synthia-m4f-direct-gate-roots-config.v3",
    roots_approval_path: rootsApprovalPath,
    roots_approval_sha256: "0".repeat(64),
  };
  const effectBinding = directGateRootsEffectBindingSha256(config, scenario.admissionConfig);
  config.expected_remote_script_sha256 = sha256(Buffer.from(
    buildDirectGateRootsRemoteScript(config, scenario.admissionConfig, effectBinding),
    "ascii",
  ));
  const rootsApproval: M4fDirectGateRootsApproval = {
    schema: "synthia-m4f-direct-gate-roots-approval.v1",
    decision: "approved",
    gate_id: config.gate_id,
    reviewer: "independent-gate-roots-reviewer",
    approved_at_utc: "2026-08-28T01:45:00.000Z",
    roots_review_config_sha256: directGateRootsReviewConfigSha256(config),
    gate_roots_source_sha256: config.expected_source_sha256,
    gate_roots_transport_source_sha256: config.expected_transport_source_sha256,
    admission_v2_validator_source_sha256: config.expected_admission_v2_source_sha256,
    gate_roots_wrapper_source_sha256: config.expected_wrapper_source_sha256,
    gate_roots_remote_script_sha256: config.expected_remote_script_sha256,
    effect_binding_sha256: effectBinding,
    target_host: "100.96.223.49",
    target_user: "admin",
    target_computer: "DESKTOP-DVFFB09",
    target_identity_name: scenario.admissionConfig.target.identity_name,
    target_identity_sid: scenario.admissionConfig.target.identity_sid,
  };
  writeSecure(rootsApprovalPath, JSON.stringify(rootsApproval) + "\n");
  config.roots_approval_sha256 = sha256(readFileSync(rootsApprovalPath));
  const upgraded = Object.assign(scenario, { config, rootsApproval }) as unknown as ScenarioV3;
  upgraded.remoteResult = remoteResult(upgraded);
  return upgraded;
}

function rewriteV2Bindings(scenario: ScenarioV2): void {
  writeSecure(scenario.config.admission_config_path, JSON.stringify(scenario.v2Config) + "\n");
  scenario.config.admission_config_sha256 = sha256(readFileSync(scenario.config.admission_config_path));
  writeSecure(scenario.config.admission_record_path, JSON.stringify(scenario.v2Record, null, 2) + "\n");
  scenario.config.admission_record_sha256 = sha256(readFileSync(scenario.config.admission_record_path));
  scenario.approval.admission_v2_config_sha256 = scenario.config.admission_config_sha256;
  scenario.approval.admission_record_sha256 = scenario.config.admission_record_sha256;
  writeSecure(scenario.config.admission_approval_path, JSON.stringify(scenario.approval) + "\n");
  scenario.config.admission_approval_sha256 = sha256(readFileSync(scenario.config.admission_approval_path));
}

function compactV2Snapshot(admission: M4fDirectAdmissionConfig): Record<string, unknown> {
  const rule = {
    s: admission.target.identity_sid,
    t: "Allow",
    r: 2032127,
    i: false,
    n: "None",
    p: "None",
  };
  const file = (path: string) => ({ p: path, e: true, l: 100, h: "a".repeat(64), v: "1.0" });
  return {
    s: "s2",
    t: "2026-08-28T01:00:00.000Z",
    i: {
      c: admission.target.computer_name,
      d: "WORKGROUP",
      u: admission.target.user,
      n: admission.target.identity_name,
      s: admission.target.identity_sid,
    },
    v: [
      { d: "C:", t: 3, f: 50_000_000_000, s: 100_000_000_000, y: "NTFS" },
      { d: "D:", t: 3, f: 100_000_000_000, s: 200_000_000_000, y: "NTFS" },
    ],
    a: admission.target.acl_paths.map((path) => ({
      p: path,
      e: true,
      o: admission.target.identity_sid,
      x: true,
      y: false,
      r: [rule],
    })),
    l: [{ a: "0.0.0.0", p: 8443, i: 13644 }],
    p: [{
      i: 13644,
      p: 100,
      n: "node.exe",
      x: "D:\\synthia-worker\\node.exe",
      c: "2026-08-28T00:00:00.000Z",
    }],
    x: file(admission.target.vivado_executable),
    b: file(admission.target.bun_executable),
    h: false,
    k: false,
  };
}

function initializeBindings(scenario: Scenario): void {
  const admissionConfigPath = join(scenario.root, "admission-config.json");
  writeSecure(admissionConfigPath, JSON.stringify(scenario.admissionConfig) + "\n");
  const admissionConfigHash = sha256(readFileSync(admissionConfigPath));
  scenario.admissionRecord = {
    schema: "synthia-m4f-direct-admission-record.v1",
    gate_id: scenario.admissionConfig.gate_id,
    action: "admission_snapshot",
    status: "observed",
    retry_permitted: false,
    recorded_at_utc: "2026-08-28T01:00:00.000Z",
    config_sha256: admissionConfigHash,
    source_sha256: "1".repeat(64),
    effective_config_sha256: sha256(scenario.effective),
    remote_wrapper_length: directPowerShellStdinWrapperFact().source_length,
    remote_wrapper_sha256: directPowerShellStdinWrapperFact().source_sha256,
    remote_command_length: directPowerShellStdinWrapperFact().command_length,
    target_binding: {
      host: "100.96.223.49",
      port: 22,
      user: "admin",
      computer_name: "DESKTOP-DVFFB09",
      identity_name: scenario.admissionConfig.target.identity_name,
      identity_sid: scenario.admissionConfig.target.identity_sid,
      host_key_fingerprint: scenario.admissionConfig.target.host_key_fingerprint,
    },
    local_inputs_before: captureM4fDirectTransportInputs(scenario.admissionConfig),
    local_inputs_after: captureM4fDirectTransportInputs(scenario.admissionConfig),
    target_snapshot: {},
    process: {},
  };
  const recordPath = join(scenario.root, "admission-record.json");
  writeSecure(recordPath, JSON.stringify(scenario.admissionRecord) + "\n");
  const recordHash = sha256(readFileSync(recordPath));
  scenario.approval = {
    schema: "synthia-m4f-direct-admission-approval.v1",
    decision: "approved",
    gate_id: scenario.admissionConfig.gate_id,
    reviewer: "independent-reviewer",
    approved_at_utc: "2026-08-28T01:30:00.000Z",
    admission_config_sha256: admissionConfigHash,
    admission_record_sha256: recordHash,
    effective_config_sha256: sha256(scenario.effective),
    target_host: "100.96.223.49",
    target_computer: "DESKTOP-DVFFB09",
  };
  const approvalPath = join(scenario.root, "admission-approval.json");
  writeSecure(approvalPath, JSON.stringify(scenario.approval) + "\n");
  scenario.config = {
    schema: "synthia-m4f-direct-gate-roots-config.v1",
    gate_id: scenario.admissionConfig.gate_id,
    service_identity_sid: "S-1-5-21-100-200-300-1002",
    minimum_gate_free_bytes: 10 * 1024 * 1024 * 1024,
    minimum_backing_free_bytes: 20 * 1024 * 1024 * 1024,
    admission_config_path: admissionConfigPath,
    admission_config_sha256: admissionConfigHash,
    admission_record_path: recordPath,
    admission_record_sha256: recordHash,
    admission_approval_path: approvalPath,
    admission_approval_sha256: sha256(readFileSync(approvalPath)),
  };
}

function rewriteBindings(scenario: Scenario): void {
  writeSecure(scenario.config.admission_config_path, JSON.stringify(scenario.admissionConfig) + "\n");
  scenario.config.admission_config_sha256 = sha256(readFileSync(scenario.config.admission_config_path));
  scenario.admissionRecord.config_sha256 = scenario.config.admission_config_sha256;
  writeSecure(scenario.config.admission_record_path, JSON.stringify(scenario.admissionRecord) + "\n");
  scenario.config.admission_record_sha256 = sha256(readFileSync(scenario.config.admission_record_path));
  scenario.approval.admission_config_sha256 = scenario.config.admission_config_sha256;
  scenario.approval.admission_record_sha256 = scenario.config.admission_record_sha256;
  writeSecure(scenario.config.admission_approval_path, JSON.stringify(scenario.approval) + "\n");
  scenario.config.admission_approval_sha256 = sha256(readFileSync(scenario.config.admission_approval_path));
}

function remoteResult(scenario: Scenario): Record<string, unknown> {
  const gateRoot = "C:\\Windows\\Temp\\synthia-m4f-" + scenario.config.gate_id;
  const backingRoot = "D:\\synthia-m4f-toolchain-" + scenario.config.gate_id;
  const binding = scenario.config.schema === "synthia-m4f-direct-gate-roots-config.v1"
    ? {
      schema: "synthia-m4f-direct-gate-roots-result.v1",
      confirmation_sha256: sha256(confirmation(scenario)),
    }
    : {
      schema: "synthia-m4f-direct-gate-roots-result.v2",
      effect_binding_sha256: directGateRootsEffectBindingSha256(
        scenario.config,
        scenario.admissionConfig,
      ),
    };
  return {
    ...binding,
    status: "created",
    gate_id: scenario.config.gate_id,
    identity: {
      computer_name: scenario.admissionConfig.target.computer_name,
      identity_name: scenario.admissionConfig.target.identity_name,
      identity_sid: scenario.admissionConfig.target.identity_sid,
    },
    gate_root: gateRoot,
    backing_root: backingRoot,
    created_count: 2,
    no_cleanup: true,
    gate_root_fact: rootFact(gateRoot, scenario.config.service_identity_sid),
    backing_root_fact: rootFact(backingRoot, scenario.config.service_identity_sid),
    gate_volume_before: volumeFact("C:\\", 50_000_000_000),
    gate_volume_after: volumeFact("C:\\", 49_999_999_000),
    backing_volume_before: volumeFact("D:\\", 100_000_000_000),
    backing_volume_after: volumeFact("D:\\", 99_999_999_000),
    gate_ancestors_before: [ancestorFact("C:\\Windows\\Temp", true)],
    gate_ancestors_after: [ancestorFact(gateRoot, true)],
    backing_ancestors_before: [ancestorFact("D:\\", false)],
    backing_ancestors_after: [ancestorFact(backingRoot, false)],
  };
}

function rootFact(path: string, serviceSid: string): Record<string, unknown> {
  return {
    path,
    owner_sid: "S-1-5-32-544",
    protected: true,
    explicit_ace_count: 3,
    empty: true,
    reparse: false,
    alternate_streams: false,
    rules: [
      { sid: "S-1-5-18", rights: 2032127 },
      { sid: "S-1-5-32-544", rights: 2032127 },
      { sid: serviceSid, rights: 1179817 },
    ],
  };
}

function ancestorFact(path: string, strictAcl: boolean): Record<string, unknown> {
  return {
    path,
    owner_sid: "S-1-5-32-544",
    reparse: false,
    acl_protected: true,
    strict_acl: strictAcl,
    rules: [],
  };
}

function volumeFact(root: "C:\\" | "D:\\", freeBytes: number): Record<string, unknown> {
  const disk = root === "C:\\" ? 0 : 1;
  return {
    root,
    device_id: root.slice(0, 2),
    drive_type: 3,
    file_system: "NTFS",
    free_bytes: freeBytes,
    logical_volume_serial: "SERIAL-" + disk,
    volume_unique_id: "VOLUME-" + disk,
    volume_serial_number: "SERIAL-" + disk,
    disk_number: disk,
    partition_number: 1,
    disk_unique_id: "DISK-" + disk,
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
    "warnweakcrypto no",
    "requesttty false", "identityfile " + config.target.identity_file,
    "userknownhostsfile " + config.target.known_hosts_file,
    "globalknownhostsfile /dev/null", "",
  ].join("\n");
}

function confirmation(scenario: Scenario): string {
  return directGateRootsConfirmation(scenario.config);
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
    expect(error).toBeInstanceOf(DirectGateRootsFailure);
    return (error as DirectGateRootsFailure).detail;
  }
  throw new Error("expected DirectGateRootsFailure");
}
