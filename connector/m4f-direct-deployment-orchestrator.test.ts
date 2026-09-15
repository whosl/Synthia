import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalEvolutionEvalHash } from "./evolution-eval.ts";
import { captureM4fDirectTransportInputs } from "./scripts/m4f-gate-admission-transport.ts";
import {
  directDeploymentConfirmation,
  executeM4fDirectDeployment,
  M4F_DIRECT_DEPLOYMENT_REMOTE_PROGRAM,
  M4fDirectDeploymentFailure,
  planM4fDirectDeployment,
  recordM4fDirectDeployment,
  type DirectDeploymentDependencies,
  type M4fDeploymentArtifact,
  type M4fDirectDeploymentConfigV1,
  type RawProcessResult,
} from "./scripts/m4f-direct-deployment-orchestrator.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("M4-F direct deployment orchestrator", () => {
  test("plan is the default, is local-only, and redacts secret hashes", () => {
    const scenario = fixture();
    const plan = planM4fDirectDeployment(scenario.config, scenario.dependencies);
    expect(plan).toMatchObject({
      schema: "synthia-m4f-direct-deployment-plan.v1",
      status: "planned_not_executed",
      target: {
        host: "100.96.223.49",
        user: "admin",
        computer_name: "DESKTOP-DVFFB09",
        origin: "https://100.96.223.49:18443",
      },
      service_identity_sid: "S-1-5-19",
      dry_run_default: true,
      network_attempted: false,
      remote_mutation_started: false,
      retry_permitted: false,
      automatic_cleanup: false,
      vivado_execution_permitted: false,
      hardware_action_permitted: false,
      old_8443_mutation_permitted: false,
    });
    expect(plan.phase_order).toEqual([
      "transport_and_remote_read_only_preflight",
      "exclusive_version_root_create",
      "versioned_release_tls_config_upload",
      "remote_hash_acl_tls_seal",
      "stage_and_initialize_once",
      "post_initialize_stop_and_reopen_verify",
      "localservice_task_register_and_start",
      "process_listener_ledger_evidence_collect",
    ]);
    expect(plan.artifacts.filter((item) => item.secret)).toHaveLength(2);
    expect(plan.artifacts.filter((item) => item.secret).every((item) => item.sha256 === null)).toBe(true);
    expect(plan.artifacts.filter((item) => item.secret).every((item) => item.remote_name === null && item.size_bytes === null)).toBe(true);
    expect(plan.tls_public_binding.private_key_or_password_in_plan).toBe(false);
    expect(plan.confirmation).toBe(directDeploymentConfirmation(plan));
    expect(scenario.calls).toEqual([]);
  });

  test("wrong exact confirmation fails before transport or remote mutation", () => {
    const scenario = fixture();
    const failure = capture(() => executeM4fDirectDeployment(
      scenario.config,
      "wrong",
      scenario.dependencies,
    ));
    expect(failure).toMatchObject({
      code: "M4F_DIRECT_DEPLOYMENT_CONFIRMATION_REQUIRED",
      stage: "confirmation",
      remote_effect_state: "not_started",
      retry_permitted: false,
      automatic_cleanup: false,
    });
    expect(scenario.calls).toEqual([]);
  });

  test("record mode does not create an evidence directory for an unconfirmed plan", () => {
    const scenario = fixture();
    const evidence = join(scenario.root, "must-not-exist");
    expect(() => recordM4fDirectDeployment(
      scenario.config,
      "wrong",
      evidence,
      scenario.dependencies,
    )).toThrow(M4fDirectDeploymentFailure);
    expect(existsSync(evidence)).toBe(false);
    expect(scenario.calls).toEqual([]);
  });

  test("confirmation binds config, plan, local source, and remote program hashes", () => {
    const scenario = fixture();
    const plan = planM4fDirectDeployment(scenario.config, scenario.dependencies);
    const approved = plan.confirmation;
    for (const mutate of [
      (config: M4fDirectDeploymentConfigV1) => { config.ledger_epoch += "-changed"; },
      (config: M4fDirectDeploymentConfigV1) => { config.protected_8443.pid += 1; },
      (config: M4fDirectDeploymentConfigV1) => { config.tls.expected_issuer += " changed"; },
      (config: M4fDirectDeploymentConfigV1) => { config.task_name += "-changed"; },
    ]) {
      const changed = structuredClone(scenario.config);
      mutate(changed);
      expect(planM4fDirectDeployment(changed, scenario.dependencies).confirmation).not.toBe(approved);
    }
    expect(scenario.calls).toEqual([]);
  });

  test("runs the reviewed one-way phases once and returns redacted evidence", () => {
    const scenario = fixture();
    const plan = planM4fDirectDeployment(scenario.config, scenario.dependencies);
    const record = executeM4fDirectDeployment(
      scenario.config,
      plan.confirmation,
      scenario.dependencies,
    );
    expect(record).toMatchObject({
      schema: "synthia-m4f-direct-deployment-record.v1",
      status: "deployed_observed",
      secret_bytes_in_evidence: false,
      secret_hashes_in_evidence: false,
      retry_permitted: false,
      automatic_cleanup: false,
      vivado_executed: false,
      hardware_action_performed: false,
      old_8443_untouched: true,
    });
    expect(record.phases.map((phase) => phase.phase)).toEqual(
      plan.phase_order.filter((phase) => phase !== "versioned_release_tls_config_upload"),
    );
    expect(record.uploads).toHaveLength(8);
    expect(record.artifacts.every((item) => !item.secret)).toBe(true);
    expect(scenario.calls).toEqual([
      "effective",
      "phase:transport_and_remote_read_only_preflight",
      "phase:exclusive_version_root_create",
      ...scenario.config.artifacts.map((artifact) => `upload:${artifact.role}`),
      "phase:remote_hash_acl_tls_seal",
      "phase:stage_and_initialize_once",
      "phase:post_initialize_stop_and_reopen_verify",
      "phase:localservice_task_register_and_start",
      "phase:process_listener_ledger_evidence_collect",
    ]);
  });

  test("freezes the first failed upload and never retries or cleans", () => {
    const scenario = fixture();
    const baseUpload = scenario.dependencies.upload;
    let uploadCalls = 0;
    scenario.dependencies.upload = (config, artifact, remotePath) => {
      uploadCalls += 1;
      if (uploadCalls === 2) return raw("", "copy failed", 1);
      return baseUpload(config, artifact, remotePath);
    };
    const confirmation = planM4fDirectDeployment(scenario.config, scenario.dependencies).confirmation;
    const failure = capture(() => executeM4fDirectDeployment(
      scenario.config,
      confirmation,
      scenario.dependencies,
    ));
    expect(failure).toMatchObject({
      code: "M4F_DIRECT_DEPLOYMENT_UPLOAD_FAILED",
      stage: "versioned_release_tls_config_upload",
      retry_permitted: false,
      automatic_cleanup: false,
      remote_effect_state: "unknown",
    });
    expect(uploadCalls).toBe(2);
    expect(scenario.calls.filter((call) => call.startsWith("phase:"))).toEqual([
      "phase:transport_and_remote_read_only_preflight",
      "phase:exclusive_version_root_create",
    ]);
  });

  test("binds the raw effective SSH config and rejects semantic-looking drift before remote phases", () => {
    const scenario = fixture();
    scenario.dependencies.runEffectiveConfig = () => {
      scenario.calls.push("effective");
      const admission = JSON.parse(readFileSync(scenario.config.admission_config_path, "utf8"));
      return raw(effectiveConfig(
        admission.target.identity_file,
        admission.target.known_hosts_file,
      ) + "compression no\n", "", 0);
    };
    const confirmation = planM4fDirectDeployment(scenario.config, scenario.dependencies).confirmation;
    expect(capture(() => executeM4fDirectDeployment(
      scenario.config,
      confirmation,
      scenario.dependencies,
    ))).toMatchObject({
      code: "M4F_DIRECT_DEPLOYMENT_EFFECTIVE_CONFIG_DRIFT",
      stage: "transport",
      remote_effect_state: "not_started",
    });
    expect(scenario.calls).toEqual(["effective"]);
  });

  test("rejects extra or missing phase evidence and starts no later phase", () => {
    const scenario = fixture();
    scenario.dependencies.runPhase = (_admission, phase) => {
      scenario.calls.push(`phase:${phase}`);
      return raw(JSON.stringify({ ...phasePayload(scenario.config, phase), unsupported: true }) + "\n", "", 0);
    };
    const confirmation = planM4fDirectDeployment(scenario.config, scenario.dependencies).confirmation;
    expect(capture(() => executeM4fDirectDeployment(
      scenario.config,
      confirmation,
      scenario.dependencies,
    ))).toMatchObject({
      code: "M4F_DIRECT_DEPLOYMENT_PHASE_OUTPUT_INVALID",
      stage: "transport_and_remote_read_only_preflight",
      completed_phases: [],
      completed_uploads: [],
    });
    expect(scenario.calls).toEqual([
      "effective",
      "phase:transport_and_remote_read_only_preflight",
    ]);
  });

  test("writes one exclusive immutable evidence directory and refuses overwrite", () => {
    const scenario = fixture();
    const confirmation = planM4fDirectDeployment(scenario.config, scenario.dependencies).confirmation;
    const evidence = join(scenario.root, "evidence");
    const record = recordM4fDirectDeployment(
      scenario.config,
      confirmation,
      evidence,
      scenario.dependencies,
    );
    expect(record.status).toBe("deployed_observed");
    expect(existsSync(join(evidence, "deployment-record.json"))).toBe(true);
    expect(statSync(join(evidence, "deployment-plan.json")).mode & 0o777).toBe(0o400);
    expect(statSync(join(evidence, "deployment-record.json")).mode & 0o777).toBe(0o400);
    expect(readFileSync(join(evidence, "deployment-record.json"), "utf8")).not.toContain(
      scenario.config.artifacts.find((item) => item.role === "pfx_password")!.sha256,
    );
    expect(existsSync(join(evidence, "deployment-plan.json"))).toBe(true);
    const callsBeforeReuse = [...scenario.calls];
    expect(() => recordM4fDirectDeployment(
      scenario.config,
      confirmation,
      evidence,
      scenario.dependencies,
    )).toThrow();
    expect(scenario.calls).toEqual(callsBeforeReuse);
    chmodSync(evidence, 0o700);
  });

  test("freezes a redacted failure beside the pre-network plan", () => {
    const scenario = fixture();
    scenario.dependencies.runPhase = (_admission, phase) => {
      scenario.calls.push(`phase:${phase}`);
      return raw("partial", "", 0);
    };
    const confirmation = planM4fDirectDeployment(scenario.config, scenario.dependencies).confirmation;
    const evidence = join(scenario.root, "failure-evidence");
    expect(() => recordM4fDirectDeployment(
      scenario.config,
      confirmation,
      evidence,
      scenario.dependencies,
    )).toThrow(M4fDirectDeploymentFailure);
    expect(existsSync(join(evidence, "deployment-plan.json"))).toBe(true);
    expect(existsSync(join(evidence, "deployment-failure.json"))).toBe(true);
    expect(statSync(join(evidence, "deployment-failure.json")).mode & 0o777).toBe(0o400);
    const frozen = readFileSync(join(evidence, "deployment-failure.json"), "utf8");
    for (const secret of scenario.config.artifacts.filter((item) => item.secret)) {
      expect(frozen).not.toContain(secret.local_path);
      expect(frozen).not.toContain(secret.sha256);
    }
    chmodSync(evidence, 0o700);
  });

  test("remote program protects 8443 and enforces TLS, LocalService, ledger, and no Vivado", () => {
    const source = M4F_DIRECT_DEPLOYMENT_REMOTE_PROGRAM;
    for (const contract of [
      "OldWorker",
      "AssertCanonicalPath",
      "M4F_DEPLOY_PATH_NONCANONICAL",
      "M4F_DEPLOY_PATH_LAYOUT_MISMATCH",
      "AssertNoReparseChain",
      "M4F_DEPLOY_REPARSE_ANCESTOR",
      "AssertDeploymentBoundary",
      "M4F_DEPLOY_OLD_8443_IDENTITY_DRIFT",
      "M4F_DEPLOY_OLD_8443_LISTENER_DRIFT",
      "M4F_DEPLOY_OLD_8443_TASK_DRIFT",
      "IP Address=100\\.96\\.223\\.49",
      "$cfg.tls.required_eku_oid",
      "EphemeralKeySet",
      "secret_hashes_emitted=$false",
      "--initialize-evolution-ledger",
      "--verify-evolution-ledger",
      "initialize_process_stopped=$true",
      "evolution_eval_ledger_mode -cne 'reopen'",
      "New-ScheduledTaskPrincipal -UserId 'S-1-5-19'",
      "-LogonType ServiceAccount -RunLevel Limited",
      "-RestartCount 0",
      "Get-NetTCPConnection -State Listen -LocalPort 18443",
      "GetOwnerSid",
      "secret_material_emitted=$false",
    ]) expect(source).toContain(contract);
    for (const forbidden of [
      "vivado -mode",
      "vivado.bat",
      "hw_server -",
      "open_hw",
      "program_hw",
      "write_cfgmem",
      "Remove-Item",
      "Unregister-ScheduledTask",
      "Stop-Process",
      "Stop-ScheduledTask",
    ]) expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
  });

  test("rejects old worker roots, wrong SAN, and secret classification drift", () => {
    for (const mutate of [
      (config: M4fDirectDeploymentConfigV1) => { config.release_root = "D:\\synthia-worker\\gate"; },
      (config: M4fDirectDeploymentConfigV1) => { config.tls.required_ip_san = "192.168.31.66" as never; },
      (config: M4fDirectDeploymentConfigV1) => { config.artifacts.find((item) => item.role === "server_pfx")!.secret = false; },
      (config: M4fDirectDeploymentConfigV1) => { config.service_identity_sid = "S-1-5-18" as never; },
    ]) {
      const scenario = fixture();
      mutate(scenario.config);
      expect(() => planM4fDirectDeployment(scenario.config, scenario.dependencies)).toThrow(
        M4fDirectDeploymentFailure,
      );
      expect(scenario.calls).toEqual([]);
    }
  });

  test("rejects Windows traversal, mixed separators, ADS, device names, and trailing aliases", () => {
    for (const mutate of [
      (config: M4fDirectDeploymentConfigV1) => { config.release_root = `${config.gate_root}\\..\\..\\System32\\${config.release_version}`; },
      (config: M4fDirectDeploymentConfigV1) => { config.release_root = `${config.gate_root}/release-${config.release_version}`; },
      (config: M4fDirectDeploymentConfigV1) => { config.release_root = `${config.gate_root}\\release-${config.release_version}:ads`; },
      (config: M4fDirectDeploymentConfigV1) => { config.release_root = `${config.gate_root}\\CON\\release-${config.release_version}`; },
      (config: M4fDirectDeploymentConfigV1) => { config.release_root = `${config.gate_root}\\release-${config.release_version}.`; },
      (config: M4fDirectDeploymentConfigV1) => { config.active_config_path = `${config.release_root}\\..\\escaped.json`; },
    ]) {
      const scenario = fixture();
      mutate(scenario.config);
      expect(() => planM4fDirectDeployment(scenario.config, scenario.dependencies)).toThrow(
        M4fDirectDeploymentFailure,
      );
      expect(scenario.calls).toEqual([]);
    }
  });

  test("rejects traversal and aliasing in every mutable template root", () => {
    const mutations: Array<(template: Record<string, unknown>) => void> = [
      (template) => { template.workspace_root = String(template.workspace_root) + "\\..\\escape"; },
      (template) => { template.evidence_root = String(template.evidence_root) + "\\CON"; },
      (template) => { template.evolution_eval_ledger_root = String(template.evolution_eval_ledger_root).replaceAll("\\", "/"); },
      (template) => { template.evolution_eval_spool_root = String(template.evolution_eval_spool_root) + "."; },
      (template) => { template.evolution_eval_log_root = String(template.evolution_eval_log_root) + ":ads"; },
    ];
    for (const mutate of mutations) {
      const scenario = fixture();
      rewriteTemplate(scenario, mutate);
      expect(() => planM4fDirectDeployment(scenario.config, scenario.dependencies)).toThrow(
        M4fDirectDeploymentFailure,
      );
      expect(scenario.calls).toEqual([]);
    }
  });
});

interface Scenario {
  root: string;
  config: M4fDirectDeploymentConfigV1;
  dependencies: DirectDeploymentDependencies;
  calls: string[];
}

function fixture(): Scenario {
  const root = mkdtempSync(join(tmpdir(), "synthia-m4f-deploy-test-"));
  temporaryRoots.push(root);
  const inputs = join(root, "inputs");
  mkdirSync(inputs);
  const gateId = "prod-test-01";
  const gateRoot = `C:\\Windows\\Temp\\synthia-m4f-${gateId}`;
  const releaseRoot = `${gateRoot}\\release-worker-v1`;
  const artifactBytes = new Map<string, Buffer>();
  const add = (role: string, value: string | Record<string, unknown>) => {
    artifactBytes.set(role, Buffer.from(typeof value === "string" ? value : JSON.stringify(value) + "\n"));
  };
  add("worker_bundle", "bundle bytes");
  add("bun_runtime", "bun runtime bytes");
  add("launcher", "@echo off\n");
  add("windows_certifier", "[CmdletBinding()] param()\n");
  add("toolchain_attestation", { schema: "synthia-vivado-toolchain-attestation.v1" });
  add("server_pfx", "fake pfx bytes");
  add("pfx_password", "not-a-real-password\n");
  add("trusted_client_ca", "fake public client ca bytes");

  const remoteNames: Record<string, string> = {
    release_manifest: "worker-release.manifest.json",
    worker_bundle: "server.bundle.mjs",
    bun_runtime: "bun.exe",
    launcher: "start-worker-66.cmd",
    windows_certifier: "certify-m4f-windows.ps1",
    config_template: "worker-18443.config.template.json",
    toolchain_attestation: "vivado-toolchain-attestation.json",
    server_pfx: "server-18443.pfx",
    pfx_password: "pfx-password.txt",
    trusted_client_ca: "client-ca.cer",
  };
  const hashOfRole = (role: string) => hash(artifactBytes.get(role)!);
  add("config_template", {
    connector_id: "vivado-m4f-sidecar",
    display_name: "M4-F sidecar",
    listen_host: "0.0.0.0",
    listen_port: 18443,
    endpoint_url: "https://100.96.223.49:18443",
    protocol_version: "connector.remote.v1",
    transport_mode: "direct_https",
    auth_mode: "mtls",
    server_certificate_path: `${releaseRoot}\\${remoteNames.server_pfx}`,
    server_private_key_path: `${releaseRoot}\\${remoteNames.server_pfx}`,
    trusted_client_ca_path: `${releaseRoot}\\${remoteNames.trusted_client_ca}`,
    workspace_root: `${gateRoot}\\workspace`,
    evidence_root: `${gateRoot}\\evidence`,
    evolution_eval_enabled: false,
    evolution_eval_ledger_root: `${gateRoot}\\ledger`,
    evolution_eval_ledger_epoch: "test-epoch-01",
    evolution_eval_ledger_mode: "reopen",
    evolution_eval_spool_root: `${gateRoot}\\spool`,
    evolution_eval_log_root: `${gateRoot}\\logs`,
    vivado_toolchain_attestation_path: `${releaseRoot}\\${remoteNames.toolchain_attestation}`,
    vivado_toolchain_attestation_sha256: hashOfRole("toolchain_attestation"),
  });
  const manifestBody = {
    schema: "synthia-worker-release-manifest.v1",
    bundle: { sha256: hashOfRole("worker_bundle") },
    runtime: { sha256: hashOfRole("bun_runtime") },
    release_files: {
      launcher_sha256: hashOfRole("launcher"),
      windows_certifier_sha256: hashOfRole("windows_certifier"),
      config_template_sha256: hashOfRole("config_template"),
    },
  };
  add("release_manifest", {
    ...manifestBody,
    manifest_hash: canonicalEvolutionEvalHash(manifestBody),
  });

  const roles = [
    "release_manifest", "worker_bundle", "bun_runtime", "launcher", "windows_certifier",
    "config_template", "toolchain_attestation", "server_pfx", "pfx_password", "trusted_client_ca",
  ] as const;
  const artifacts: M4fDeploymentArtifact[] = roles.map((role) => {
    const path = join(inputs, remoteNames[role]!);
    writeFileSync(path, artifactBytes.get(role)!, { mode: 0o600 });
    chmodSync(path, 0o600);
    return {
      role,
      local_path: path,
      remote_name: remoteNames[role]!,
      sha256: hash(artifactBytes.get(role)!),
      secret: role === "server_pfx" || role === "pfx_password",
    };
  });

  const identity = join(root, "identity");
  const knownHosts = join(root, "known-hosts");
  writeFileSync(identity, "private key test fixture", { mode: 0o600 });
  const hostKey = Buffer.alloc(32, 7);
  writeFileSync(knownHosts, `100.96.223.49 ssh-ed25519 ${hostKey.toString("base64")}\n`, { mode: 0o600 });
  chmodSync(identity, 0o600);
  chmodSync(knownHosts, 0o600);
  const admission = {
    schema: "synthia-m4f-direct-admission-config.v1",
    gate_id: gateId,
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
      host_key_fingerprint: "SHA256:" + hashBase64(hostKey),
      expected_effective_config_sha256: hash(effectiveConfig(identity, knownHosts)),
      acl_paths: [gateRoot, `D:\\synthia-m4f-toolchain-${gateId}`],
      vivado_executable: "D:\\Xilinx\\Vivado\\2021.1\\bin\\vivado.bat",
      bun_executable: "D:\\bun\\bun.exe",
    },
  };
  const admissionPath = join(root, "admission.json");
  writeFileSync(admissionPath, JSON.stringify(admission));
  const roots = {
    schema: "synthia-m4f-direct-gate-roots-record.v3",
    status: "created",
    gate_id: gateId,
    gate_root: gateRoot,
    backing_root: `D:\\synthia-m4f-toolchain-${gateId}`,
    effective_config_sha256: admission.target.expected_effective_config_sha256,
    transport_inputs_after: captureM4fDirectTransportInputs(admission as never),
    remote_result: { hardware_action_performed: false },
  };
  const rootsPath = join(root, "roots.json");
  writeFileSync(rootsPath, JSON.stringify(roots));

  const source = Buffer.from("local orchestrator source fixture");
  const remote = Buffer.from(M4F_DIRECT_DEPLOYMENT_REMOTE_PROGRAM, "utf8");
  const config: M4fDirectDeploymentConfigV1 = {
    schema: "synthia-m4f-direct-deployment-config.v1",
    gate_id: gateId,
    deployment_id: "deploy-test-01",
    release_version: "worker-v1",
    admission_config_path: admissionPath,
    admission_config_sha256: hash(readFileSync(admissionPath)),
    gate_roots_record_path: rootsPath,
    gate_roots_record_sha256: hash(readFileSync(rootsPath)),
    gate_root: gateRoot,
    backing_root: roots.backing_root,
    release_root: releaseRoot,
    active_config_path: `${releaseRoot}\\worker-18443.active.json`,
    ledger_epoch: "test-epoch-01",
    service_identity_sid: "S-1-5-19",
    task_name: "Synthia-M4F-18443-deploy-test-01",
    protected_8443: {
      pid: 13644,
      process_start_utc: "2026-08-28T00:00:00.000Z",
      task_name: "Synthia Worker 66",
      task_definition_sha256: "b".repeat(64),
    },
    tls: {
      required_ip_san: "100.96.223.49",
      required_eku_oid: "1.3.6.1.5.5.7.3.1",
      expected_issuer: "CN=Synthia M4F Test CA",
      expected_certificate_sha256: "c".repeat(64),
      expected_not_after_utc: "2099-01-01T00:00:00.000Z",
    },
    artifacts,
    expected_source_sha256: hash(source),
    expected_remote_program_sha256: hash(remote),
  };

  const calls: string[] = [];
  const dependencies: DirectDeploymentDependencies = {
    sourceBytes: () => Buffer.from(source),
    remoteProgramBytes: () => Buffer.from(remote),
    runEffectiveConfig() {
      calls.push("effective");
      return raw(effectiveConfig(admission.target.identity_file, admission.target.known_hosts_file), "", 0);
    },
    runPhase(_admission, phase) {
      calls.push(`phase:${phase}`);
      return raw(JSON.stringify(phasePayload(config, phase)) + "\n", "", 0);
    },
    upload(_admission, artifact) {
      calls.push(`upload:${artifact.role}`);
      return raw("", "", 0);
    },
    now: () => new Date("2026-08-29T00:00:00.000Z"),
  };
  return { root, config, dependencies, calls };
}

function phasePayload(config: M4fDirectDeploymentConfigV1, phase: string): Record<string, unknown> {
  const common = {
    schema: "synthia-m4f-direct-deployment-phase.v1",
    phase,
    retry_permitted: false,
    vivado_executed: false,
    hardware_action_performed: false,
  };
  const old = {
    pid: config.protected_8443.pid,
    start_utc: config.protected_8443.process_start_utc,
    listener_count: 1,
    task_state: "Running",
    task_definition_sha256: config.protected_8443.task_definition_sha256,
  };
  if (phase === "transport_and_remote_read_only_preflight") return {
    ...common,
    status: "passed",
    old_8443: old,
    gate_root_exists: true,
    backing_root_exists: true,
    release_root_exists: false,
    listener_18443_count: 0,
    remote_mutation: false,
  };
  if (phase === "exclusive_version_root_create") return {
    ...common,
    status: "created",
    release_root: config.release_root,
    exclusive_create: true,
    old_8443_untouched: true,
    remote_mutation: true,
  };
  if (phase === "remote_hash_acl_tls_seal") return {
    ...common,
    status: "sealed",
    public_artifacts: config.artifacts.filter((item) => !item.secret)
      .map((item) => ({ role: item.role, sha256: item.sha256 })),
    secret_artifacts_verified: 2,
    secret_hashes_emitted: false,
    tls: {
      ip_san: config.tls.required_ip_san,
      server_auth_eku: true,
      issuer: config.tls.expected_issuer,
      certificate_sha256: config.tls.expected_certificate_sha256,
      not_after_utc: config.tls.expected_not_after_utc,
    },
    old_8443_untouched: true,
    remote_mutation: true,
  };
  const ceremony = `${config.gate_root}\\ceremony-${config.gate_id}`;
  if (phase === "stage_and_initialize_once") return {
    ...common,
    status: "initialized_once",
    initialize_config: `${ceremony}\\worker-66.initialize.json`,
    reopen_config: `${ceremony}\\worker-66.reopen.json`,
    ledger_epoch: config.ledger_epoch,
    initialize_process_stopped: true,
    old_8443_untouched: true,
    remote_mutation: true,
  };
  if (phase === "post_initialize_stop_and_reopen_verify") return {
    ...common,
    status: "reopen_promoted",
    initialize_archived: true,
    initialize_process_stopped: true,
    reopen_verified: true,
    active_config_sha256: "d".repeat(64),
    ledger_epoch: config.ledger_epoch,
    old_8443_untouched: true,
    remote_mutation: true,
  };
  if (phase === "localservice_task_register_and_start") return {
    ...common,
    status: "started",
    task_name: config.task_name,
    task_definition_sha256: "e".repeat(64),
    supervisor_wrapper_sha256: "f".repeat(64),
    task_state: "Running",
    pid: 4242,
    process_start_utc: "2026-08-29T00:00:00.000Z",
    owner_sid: "S-1-5-19",
    listener_port: 18443,
    old_8443_untouched: true,
    remote_mutation: true,
  };
  if (phase === "process_listener_ledger_evidence_collect") return {
    ...common,
    status: "observed",
    task: {
      name: config.task_name,
      state: "Running",
      principal_sid: "S-1-5-19",
      restart_count: 0,
      definition_sha256: "e".repeat(64),
    },
    process: { pid: 4242, start_utc: "2026-08-29T00:00:00.000Z", owner_sid: "S-1-5-19" },
    listener: { port: 18443, pid: 4242 },
    ledger: { epoch: config.ledger_epoch, mode: "reopen", metadata_sha256: "1".repeat(64) },
    active_config_sha256: "d".repeat(64),
    old_8443: old,
    old_8443_untouched: true,
    secret_material_emitted: false,
    remote_mutation: false,
  };
  throw new Error(`unexpected phase ${phase}`);
}

function rewriteTemplate(
  scenario: Scenario,
  mutate: (template: Record<string, unknown>) => void,
): void {
  const templateArtifact = scenario.config.artifacts.find((item) => item.role === "config_template")!;
  const template = JSON.parse(readFileSync(templateArtifact.local_path, "utf8")) as Record<string, unknown>;
  mutate(template);
  writeFileSync(templateArtifact.local_path, JSON.stringify(template) + "\n", { mode: 0o600 });
  chmodSync(templateArtifact.local_path, 0o600);
  templateArtifact.sha256 = hash(readFileSync(templateArtifact.local_path));

  const manifestArtifact = scenario.config.artifacts.find((item) => item.role === "release_manifest")!;
  const manifest = JSON.parse(readFileSync(manifestArtifact.local_path, "utf8")) as Record<string, unknown>;
  (manifest.release_files as Record<string, unknown>).config_template_sha256 = templateArtifact.sha256;
  const { manifest_hash: _oldHash, ...body } = manifest;
  manifest.manifest_hash = canonicalEvolutionEvalHash(body);
  writeFileSync(manifestArtifact.local_path, JSON.stringify(manifest) + "\n", { mode: 0o600 });
  chmodSync(manifestArtifact.local_path, 0o600);
  manifestArtifact.sha256 = hash(readFileSync(manifestArtifact.local_path));
}

function effectiveConfig(identity: string, knownHosts: string): string {
  const values: Record<string, string> = {
    hostname: "100.96.223.49",
    user: "admin",
    port: "22",
    batchmode: "yes",
    connecttimeout: "15",
    connectionattempts: "1",
    serveraliveinterval: "0",
    serveralivecountmax: "4",
    numberofpasswordprompts: "0",
    identityagent: "none",
    identitiesonly: "yes",
    pubkeyauthentication: "true",
    passwordauthentication: "no",
    kbdinteractiveauthentication: "no",
    gssapiauthentication: "no",
    hostbasedauthentication: "no",
    preferredauthentications: "publickey",
    stricthostkeychecking: "true",
    forwardagent: "no",
    clearallforwardings: "yes",
    permitlocalcommand: "no",
    controlmaster: "false",
    controlpersist: "no",
    warnweakcrypto: "no",
    requesttty: "false",
    identityfile: identity,
    userknownhostsfile: knownHosts,
    globalknownhostsfile: "/dev/null",
  };
  return Object.entries(values).map(([key, value]) => `${key} ${value}`).join("\n") + "\n";
}

function raw(stdout: string, stderr: string, status: number): RawProcessResult {
  return {
    status,
    signal: null,
    errorCode: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBase64(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("base64").replace(/=+$/u, "");
}

function capture(fn: () => unknown): Record<string, unknown> {
  try { fn(); } catch (error) {
    if (error instanceof M4fDirectDeploymentFailure) return error.detail;
    throw error;
  }
  throw new Error("expected failure");
}
