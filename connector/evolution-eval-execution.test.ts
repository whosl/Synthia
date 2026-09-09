import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalEvolutionEvalSealedInputProjection } from "../core/src/domain/evolution-eval.ts";
import {
  computeEvolutionEvalDispatchRequestHash,
  canonicalEvolutionEvalHash,
  validateEvolutionEvalSealedInput,
  type CoreIssuedEvalBinding,
  type EvolutionEvalSealedInputV1,
} from "./evolution-eval.ts";
import { FileEvolutionEvalLedger } from "./evolution-eval-ledger.ts";
import { EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER, EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER, EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER, REMOTE_SCHEMA_VERSION, type ConnectorEndpoint, type DiscoverySnapshot, type RemoteEnvelope } from "./remote.ts";
import { WorkerRuntime, type EvolutionEvalExecution } from "./worker.ts";
import { createVivadoProcessGuardian, readWindowsProcessIdentityFacts, VIVADO_CAPABILITIES, VivadoBatchAdapter, validateEvolutionEvalVivadoRequest } from "./vivado.ts";

const roots: string[] = [];
// Windows exercises PowerShell-backed write-through durability for every fact.
// Under full-file load several otherwise-fast cases legitimately exceed Bun's
// 5s default; this is test budget only and does not change product stop grace.
setDefaultTimeout(process.platform === "win32" ? 60_000 : 5_000);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function bindingAndInput(sequence = 1): { binding: CoreIssuedEvalBinding; input: EvolutionEvalSealedInputV1 } {
  const bytes = Buffer.from("module top; endmodule\n", "utf8");
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const manifest = {
    schema: "evolution-eval-workspace-manifest.v1" as const,
    workspace_id: "workspace-eval-1",
    revision: 1,
    files: [{
      path: "rtl/top.sv",
      sha256: sha,
      size_bytes: bytes.byteLength,
      media_type: "text/x-systemverilog",
      layer: "source" as const,
      read_only: true,
    }],
  };
  const dispatch = {
    schema: "evolution-eval-dispatch-request.v1" as const,
    eval_job_id: `eval-job-${sequence}`,
    connector_job_id: `connector-eval-job-${sequence}`,
    connector_idempotency_key: String(sequence).repeat(64),
    eval_input_ref: `eval-input-${sequence}`,
    input_manifest_hash: "2".repeat(64),
    workspace_id: manifest.workspace_id,
    workspace_revision: manifest.revision,
    workspace_manifest_hash: canonicalEvolutionEvalHash(manifest),
    sealed_input_projection_hash: canonicalEvolutionEvalHash({
      schema: "evolution-eval-sealed-input-projection.v1",
      manifest,
      files: manifest.files.map(({ path, sha256, size_bytes, media_type }) => ({
        path,
        sha256,
        size_bytes,
        media_type,
      })),
    }),
    operation: "validate_sources" as const,
    parameters: { operation: "validate_sources" as const, source_paths: ["rtl/top.sv"], top: "top" },
    part: null,
    toolchain_profile_hash: "3".repeat(64),
    requested_timeout_ms: 60_000,
    operation_cap_ms: 7_200_000 as const,
    deadline_at: "2099-01-01T00:00:00.000Z",
    run_class: "evolution_eval" as const,
  };
  const binding = {
    project_id: "project-eval-1",
    dispatch_request_hash: computeEvolutionEvalDispatchRequestHash(dispatch),
    dispatch,
  };
  return {
    binding,
    input: {
      schema: "evolution-eval-sealed-input.v1",
      manifest,
      files: [{
        path: manifest.files[0]!.path,
        sha256: sha,
        size_bytes: bytes.byteLength,
        media_type: manifest.files[0]!.media_type,
        content_base64: bytes.toString("base64"),
      }],
    },
  };
}

async function liveProcessIdentity(pid: number) {
  let source: string;
  if (process.platform === "linux") {
    const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
    const tail = statLine.slice(statLine.lastIndexOf(")") + 2).trim().split(/\s+/);
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    source = `${bootId}:${pid}:${tail[19]}`;
  } else if (process.platform === "win32") {
    const facts = readWindowsProcessIdentityFacts(pid);
    if (!facts) throw new Error("test process identity unavailable");
    source = `${pid}:${facts}`;
  } else {
    const boot = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).stdout.trim();
    const facts = spawnSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    source = `${boot}:${pid}:${facts}`;
  }
  return {
    pid,
    processGroupId: pid,
    startToken: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
  };
}

function barrier() {
  const value = Promise.withResolvers<void>();
  return { promise: value.promise, release: value.resolve };
}

function endpoint(root: string): ConnectorEndpoint {
  return {
    connector_id: "connector-eval-1",
    display_name: "eval",
    endpoint_url: "https://worker.example.test",
    protocol_version: REMOTE_SCHEMA_VERSION,
    transport_mode: "direct_https",
    auth_mode: "mtls",
    tls_trust_ref: "secret://trust",
    tls_client_cert_ref: "secret://cert",
    project_scope: ["project-eval-1"],
    data_classification_scope: ["restricted"],
    allowed_capability_ids: ["validate_sources", "simulate", "synthesize", "implement"],
    toolchain_profile_hash: "3".repeat(64),
    worker_labels: { root },
    heartbeat_interval_seconds: 10,
    lease_seconds: 30,
    max_concurrency: 1,
    registration_state: "approved",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    audited_by: "test",
  };
}

const discovery: DiscoverySnapshot = {
  connector_id: "connector-eval-1",
  connector_protocol_version: REMOTE_SCHEMA_VERSION,
  capability_map_version: "v1",
  vivado_version: "2021.1",
  vivado_patch: "1",
  part_catalog_hash: "parts",
  sdk_worker_build_hash: "worker",
  active_config_sha256: "6".repeat(64),
  worker_process_instance_id: "123e4567-e89b-42d3-a456-426614174000",
  vivado_toolchain_attestation_sha256: "7".repeat(64),
  live_mapping_health: "healthy",
  capabilities: ["validate_sources", "simulate", "synthesize", "implement"].map((operation) => ({
    operation,
    version: "vivado-batch-1",
    runClasses: ["exploratory", "evolution_eval"],
  })),
  toolchain_profile_hash: "3".repeat(64),
  license_status: "available",
};

function envelope(payload: unknown, key: string = crypto.randomUUID()): RemoteEnvelope<unknown> {
  return {
    schema_version: REMOTE_SCHEMA_VERSION,
    correlation_id: crypto.randomUUID(),
    idempotency_key: key,
    actor: { actor_type: "service", actor_id: "synthia-core-evolution-eval-dispatcher" },
    project_id: "project-eval-1",
    classification: "restricted",
    capability_version: "vivado-batch-1",
    payload,
  };
}

async function post(
  runtime: WorkerRuntime,
  path: string,
  payload: unknown,
  key?: string,
  attestation: "omit" | Partial<{ active_config_sha256: string; worker_process_instance_id: string; vivado_toolchain_attestation_sha256: string }> = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if ((path === "/evolution-eval/reserve" || path === "/evolution-eval/submit") && attestation !== "omit") {
    headers[EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER] = attestation.active_config_sha256
      ?? discovery.active_config_sha256!;
    headers[EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER] = attestation.worker_process_instance_id
      ?? discovery.worker_process_instance_id!;
    headers[EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER] = attestation.vivado_toolchain_attestation_sha256
      ?? discovery.vivado_toolchain_attestation_sha256!;
  }
  return runtime.handle(new Request(`https://worker.example.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(envelope(payload, key)),
  }));
}

async function postWithCorrelation(
  runtime: WorkerRuntime,
  path: string,
  payload: unknown,
  key: string,
  correlation: string,
): Promise<Response> {
  const body = envelope(payload, key);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (path === "/evolution-eval/reserve" || path === "/evolution-eval/submit") {
    headers[EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER] = discovery.active_config_sha256!;
    headers[EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER] = discovery.worker_process_instance_id!;
    headers[EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER] = discovery.vivado_toolchain_attestation_sha256!;
  }
  return runtime.handle(new Request(`https://worker.example.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, correlation_id: correlation }),
  }));
}

async function ready(runtime: WorkerRuntime): Promise<void> {
  await post(runtime, "/registration", { endpoint: {} });
  await post(runtime, "/discover", { connector_id: "connector-eval-1" });
  await post(runtime, "/heartbeat", { connector_id: "connector-eval-1" });
}

function expiredBindingAndInput(sequence: number) {
  const { binding, input } = bindingAndInput(sequence);
  const dispatch = { ...binding.dispatch, deadline_at: "2000-01-01T00:00:00.000Z" };
  return {
    binding: {
      ...binding,
      dispatch,
      dispatch_request_hash: computeEvolutionEvalDispatchRequestHash(dispatch),
    },
    input,
  };
}

async function materializeReplayFixture(
  spoolRoot: string,
  binding: CoreIssuedEvalBinding,
  input: EvolutionEvalSealedInputV1,
): Promise<string> {
  const projectionHash = validateEvolutionEvalSealedInput(input, binding).projectionHash;
  const key = new Bun.CryptoHasher("sha256")
    .update(binding.dispatch.connector_job_id)
    .digest("hex");
  const workspace = join(spoolRoot, "jobs", key);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "binding.json"), JSON.stringify({
    dispatch_request_hash: binding.dispatch_request_hash,
    workspace_manifest_hash: binding.dispatch.workspace_manifest_hash,
    sealed_input_projection_hash: projectionHash,
  }));
  return workspace;
}

test("evolution-eval preflight binds the active config and stable process instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthia-eval-attestation-")); roots.push(root);
  const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
  const runtime = new WorkerRuntime({
    endpoint: endpoint(root),
    workspaceRoot: join(root, "ordinary"),
    execution: { async discover() { return discovery; }, async execute() { return {}; } },
    evolutionEval: {
      ledger,
      spoolRoot: join(root, "spool"),
      execution: { async execute() { return { terminalState: "failed" }; } },
      toolchainProfileHash: "3".repeat(64),
    },
  });
  await ready(runtime);
  const { binding } = bindingAndInput();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await post(runtime, "/evolution-eval/preflight", {
      schema: "evolution-eval-preflight-request.v1",
      binding,
    });
    expect(response.status).toBe(200);
    const envelope = await response.json() as { payload: Record<string, unknown> };
    expect(envelope.payload.active_config_sha256).toBe(discovery.active_config_sha256);
    expect(envelope.payload.worker_process_instance_id).toBe(discovery.worker_process_instance_id);
    expect(envelope.payload.vivado_toolchain_attestation_sha256).toBe(discovery.vivado_toolchain_attestation_sha256);
    expect(envelope.payload.live_mapping_health).toBe("healthy");
  }
});

test("evolution-eval discovery without remote attestation never becomes ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthia-eval-attestation-missing-")); roots.push(root);
  const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
  const { active_config_sha256: _config, worker_process_instance_id: _instance, vivado_toolchain_attestation_sha256: _toolchain, live_mapping_health: _mapping, ...missingAttestation } = discovery;
  const runtime = new WorkerRuntime({
    endpoint: endpoint(root),
    workspaceRoot: join(root, "ordinary"),
    execution: { async discover() { return missingAttestation; }, async execute() { return {}; } },
    evolutionEval: {
      ledger,
      spoolRoot: join(root, "spool"),
      execution: { async execute() { return { terminalState: "failed" }; } },
      toolchainProfileHash: "3".repeat(64),
    },
  });
  await ready(runtime);
  const { binding } = bindingAndInput();
  const response = await post(runtime, "/evolution-eval/preflight", {
    schema: "evolution-eval-preflight-request.v1",
    binding,
  });
  expect(response.status).toBe(503);
});

test("evolution-eval reserve and submit reject missing or drifted remote attestation before effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthia-eval-attestation-mismatch-")); roots.push(root);
  const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
  let executions = 0;
  const runtime = new WorkerRuntime({
    endpoint: endpoint(root),
    workspaceRoot: join(root, "ordinary"),
    execution: { async discover() { return discovery; }, async execute() { return {}; } },
    evolutionEval: {
      ledger,
      spoolRoot: join(root, "spool"),
      execution: { async execute() { executions += 1; return { terminalState: "failed" }; } },
      toolchainProfileHash: "3".repeat(64),
    },
  });
  await ready(runtime);

  for (const [sequence, attestation] of [
    [2, "omit"],
    [3, { active_config_sha256: "7".repeat(64) }],
    [4, { worker_process_instance_id: "223e4567-e89b-42d3-a456-426614174000" }],
  ] as const) {
    const { binding } = bindingAndInput(sequence);
    const response = await post(runtime, "/evolution-eval/reserve", {
      schema: "evolution-eval-reserve-request.v1",
      binding,
    }, undefined, attestation);
    expect(response.status).toBe(409);
    expect((await response.json() as { error_code: string }).error_code)
      .toBe("EVOLUTION_EVAL_REMOTE_ATTESTATION_MISMATCH");
    expect((await ledger.query(binding)).state).toBe("ambiguous");
  }

  const { binding, input } = bindingAndInput(5);
  expect((await post(runtime, "/evolution-eval/reserve", {
    schema: "evolution-eval-reserve-request.v1",
    binding,
  })).status).toBe(200);
  for (const attestation of [
    "omit",
    { active_config_sha256: "7".repeat(64) },
    { worker_process_instance_id: "223e4567-e89b-42d3-a456-426614174000" },
  ] as const) {
    const response = await post(runtime, "/evolution-eval/submit", {
      schema: "evolution-eval-submit-request.v1",
      binding,
      input,
    }, binding.dispatch.connector_idempotency_key, attestation);
    expect(response.status).toBe(409);
    expect((await response.json() as { error_code: string }).error_code)
      .toBe("EVOLUTION_EVAL_REMOTE_ATTESTATION_MISMATCH");
    expect(await ledger.query(binding)).toMatchObject({ state: "proven_never_accepted", replay_permitted: true });
    expect(executions).toBe(0);
  }
});

test("evolution-eval restart rejects stale submit attestation while recovery routes remain available", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthia-eval-attestation-restart-")); roots.push(root);
  const ledgerRoot = join(root, "ledger");
  const ledger = await FileEvolutionEvalLedger.initialize({ root: ledgerRoot, ledgerEpoch: "epoch-1" });
  let executions = 0;
  const options = {
    endpoint: endpoint(root),
    workspaceRoot: join(root, "ordinary"),
    evolutionEval: {
      ledger,
      spoolRoot: join(root, "spool"),
      execution: { async execute() { executions += 1; return { terminalState: "failed" as const }; } },
      toolchainProfileHash: "3".repeat(64),
    },
  };
  const first = new WorkerRuntime({
    ...options,
    execution: { async discover() { return discovery; }, async execute() { return {}; } },
  });
  await ready(first);
  const { binding, input } = bindingAndInput(6);
  expect((await post(first, "/evolution-eval/reserve", {
    schema: "evolution-eval-reserve-request.v1",
    binding,
  })).status).toBe(200);

  const restartedDiscovery = {
    ...discovery,
    worker_process_instance_id: "223e4567-e89b-42d3-a456-426614174000",
  };
  const reopened = await FileEvolutionEvalLedger.reopen({ root: ledgerRoot, ledgerEpoch: "epoch-1" });
  const restarted = new WorkerRuntime({
    ...options,
    execution: { async discover() { return restartedDiscovery; }, async execute() { return {}; } },
    evolutionEval: { ...options.evolutionEval, ledger: reopened },
  });
  await ready(restarted);
  const staleSubmit = await post(restarted, "/evolution-eval/submit", {
    schema: "evolution-eval-submit-request.v1",
    binding,
    input,
  }, binding.dispatch.connector_idempotency_key, {
    active_config_sha256: discovery.active_config_sha256!,
    worker_process_instance_id: discovery.worker_process_instance_id!,
  });
  expect(staleSubmit.status).toBe(409);
  expect(await reopened.query(binding)).toMatchObject({ state: "proven_never_accepted", replay_permitted: true });
  expect(executions).toBe(0);

  expect((await post(restarted, "/evolution-eval/query", {
    schema: "evolution-eval-query-request.v1",
    binding,
  })).status).toBe(200);
  expect((await post(restarted, "/evolution-eval/spool/query", {
    schema: "evolution-eval-spool-query.v1",
    binding,
  })).status).toBe(200);
  expect((await post(restarted, "/evolution-eval/retention/query", {
    schema: "evolution-eval-retention-query-request.v1",
    binding,
  })).status).toBe(200);
  const evidence = await post(restarted, "/evolution-eval/evidence/manifest", {
    schema: "evolution-eval-evidence-manifest-request.v1",
    binding,
  });
  expect(evidence.status).toBe(404);
  expect((await evidence.json() as { error_code: string }).error_code)
    .toBe("EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE");
});

test("new-effect readiness is rechecked after materialization and before durable acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthia-eval-live-drift-")); roots.push(root);
  const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
  let readinessChecks = 0;
  let executions = 0;
  const runtime = new WorkerRuntime({
    endpoint: endpoint(root),
    workspaceRoot: join(root, "ordinary"),
    execution: { async discover() { return discovery; }, async execute() { return {}; } },
    evolutionEval: {
      ledger,
      spoolRoot: join(root, "spool"),
      toolchainProfileHash: "3".repeat(64),
      assertNewEffectReady: async () => {
        readinessChecks += 1;
        throw new Error("TOOLCHAIN_ATTESTATION_INVALID:live_mapping");
      },
      execution: { async execute() { executions += 1; return { terminalState: "failed" }; } },
    },
  });
  await ready(runtime);
  const { binding, input } = bindingAndInput(9);
  expect((await post(runtime, "/evolution-eval/reserve", { schema: "evolution-eval-reserve-request.v1", binding })).status).toBe(200);
  expect((await post(runtime, "/evolution-eval/submit", { schema: "evolution-eval-submit-request.v1", binding, input }, binding.dispatch.connector_idempotency_key)).status).toBe(400);
  expect(readinessChecks).toBe(1);
  expect(executions).toBe(0);
  expect(await ledger.query(binding)).toMatchObject({ state: "proven_never_accepted", replay_permitted: true });
});

test("launch readiness drift stops the inert guardian and settles without a Vivado effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthia-eval-launch-drift-")); roots.push(root);
  const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
  let readinessChecks = 0;
  let commandEffects = 0;
  let stopped = false;
  const identity = { pid: 5199, processGroupId: 5199, startToken: "launch-readiness-guardian" };
  const runtime = new WorkerRuntime({
    endpoint: endpoint(root), workspaceRoot: join(root, "ordinary"),
    execution: { async discover() { return discovery; }, async execute() { return {}; } },
    evolutionEval: {
      ledger, spoolRoot: join(root, "spool"), toolchainProfileHash: "3".repeat(64),
      assertNewEffectReady: async () => {
        readinessChecks += 1;
        if (readinessChecks > 1) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:live_mapping");
      },
      execution: {
        async execute({ onProcessStarted, onBeforeLaunch }) {
          if (await onProcessStarted(identity) && await onBeforeLaunch()) commandEffects += 1;
          stopped = true;
          return { terminalState: "failed", errorCode: "TOOLCHAIN_READINESS_DRIFT" };
        },
      },
      processSupervisor: {
        isTreeStopped: () => stopped,
        ownsIdentity: async () => true,
        async stopAndConfirm() { stopped = true; return true; },
      },
    },
  });
  await ready(runtime);
  const { binding, input } = bindingAndInput(4);
  await post(runtime, "/evolution-eval/reserve", { schema: "evolution-eval-reserve-request.v1", binding });
  expect((await post(runtime, "/evolution-eval/submit", { schema: "evolution-eval-submit-request.v1", binding, input }, binding.dispatch.connector_idempotency_key)).status).toBe(202);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await ledger.query(binding)).state === "terminal") break;
    await Bun.sleep(1);
  }
  expect(readinessChecks).toBe(2);
  expect(commandEffects).toBe(0);
  expect(await ledger.query(binding)).toMatchObject({ state: "terminal", terminal_state: "failed", process_stopped: true });
});

describe("evolution-eval sealed input fail-closed validation", () => {
  test("accepts exact full workspace bytes and rejects unknown/script/path/hash drift", () => {
    const { binding, input } = bindingAndInput();
    expect(validateEvolutionEvalSealedInput(input, binding).files[0]!.content.byteLength).toBeGreaterThan(0);
    expect(() => validateEvolutionEvalSealedInput({ ...input, command: "vivado -mode tcl" }, binding)).toThrow();
    expect(() => validateEvolutionEvalSealedInput({
      ...input,
      files: [{ ...input.files[0]!, content_base64: Buffer.from("drift").toString("base64") }],
    }, binding)).toThrow();
    const scriptManifest = {
      ...input.manifest,
      files: [{ ...input.manifest.files[0]!, path: "scripts/run.tcl", layer: "overlay" as const, read_only: false }],
    };
    expect(() => validateEvolutionEvalSealedInput({ ...input, manifest: scriptManifest }, binding)).toThrow();
    const skillManifest = {
      ...input.manifest,
      files: [{ ...input.manifest.files[0]!, layer: "skill" as const, read_only: true }],
    };
    expect(() => validateEvolutionEvalSealedInput({ ...input, manifest: skillManifest }, binding)).toThrow();
    for (const path of ["CON.v", "aux.xdc", "dir/LPT1.sv", "foo./top.sv"]) {
      const windowsAliasManifest = {
        ...input.manifest,
        files: [{ ...input.manifest.files[0]!, path }],
      };
      expect(() => validateEvolutionEvalSealedInput({ ...input, manifest: windowsAliasManifest }, binding)).toThrow();
    }
  });

  test("rejects Windows device aliases before admission, workspace materialization, or acceptance", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-win-path-")); roots.push(root);
    const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
    const runtime = new WorkerRuntime({
      endpoint: endpoint(root), workspaceRoot: join(root, "ordinary"),
      execution: { async discover() { return discovery; }, async execute() { return {}; } },
      evolutionEval: { ledger, spoolRoot: join(root, "spool"), execution: { async execute() { return { terminalState: "failed" }; } }, toolchainProfileHash: "3".repeat(64) },
    });
    await ready(runtime);
    const { binding, input } = bindingAndInput();
    const manifest = { ...input.manifest, files: [{ ...input.manifest.files[0]!, path: "CON.v" }] };
    const request = await post(runtime, "/evolution-eval/submit", {
      schema: "evolution-eval-submit-request.v1",
      binding,
      input: { ...input, manifest },
    }, binding.dispatch.connector_idempotency_key);
    expect(request.status).toBe(400);
    expect((await ledger.query(binding)).state).toBe("ambiguous");
    await expect(readdir(join(root, "spool", "admissions"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(root, "spool", "jobs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects an expired reserved submit at the HTTP boundary with zero execution effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-expired-http-")); roots.push(root);
    const ledger = await FileEvolutionEvalLedger.initialize({
      root: join(root, "ledger"),
      ledgerEpoch: "epoch-1",
    });
    let discoveries = 0;
    let preparations = 0;
    let executionEffects = 0;
    let guardianChecks = 0;
    const now = () => new Date("2026-08-29T00:00:00.000Z");
    const runtime = new WorkerRuntime({
      endpoint: endpoint(root),
      workspaceRoot: join(root, "ordinary"),
      now,
      execution: {
        async discover() { discoveries += 1; return discovery; },
        async execute() { executionEffects += 1; return {}; },
      },
      evolutionEval: {
        ledger,
        spoolRoot: join(root, "spool"),
        toolchainProfileHash: "3".repeat(64),
        now,
        execution: {
          async prepare() {
            preparations += 1;
            throw new Error("expired submit reached guardian preparation");
          },
          async execute() {
            executionEffects += 1;
            return { terminalState: "failed" };
          },
        },
        processSupervisor: {
          isTreeStopped() { guardianChecks += 1; return true; },
          async ownsIdentity() { guardianChecks += 1; return true; },
          async stopAndConfirm() { guardianChecks += 1; return true; },
        },
      },
    });
    await ready(runtime);
    const { binding, input } = expiredBindingAndInput(5);
    discoveries = 0;
    expect((await post(runtime, "/evolution-eval/reserve", {
      schema: "evolution-eval-reserve-request.v1",
      binding,
    })).status).toBe(200);
    expect(discoveries).toBe(1);

    discoveries = 0;
    const response = await post(runtime, "/evolution-eval/submit", {
      schema: "evolution-eval-submit-request.v1",
      binding,
      input,
    }, binding.dispatch.connector_idempotency_key);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: "EVOLUTION_EVAL_TIMEOUT_INVALID" });
    expect(discoveries).toBe(0);
    expect(preparations).toBe(0);
    expect(executionEffects).toBe(0);
    expect(guardianChecks).toBe(0);
    expect(await ledger.query(binding)).toMatchObject({
      state: "proven_never_accepted",
      replay_permitted: true,
    });
    await expect(readdir(join(root, "spool", "admissions"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(root, "spool", "jobs"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(root, "ordinary"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("replays accepted and terminal ledger state after deadline without new execution effects", async () => {
    for (const state of ["accepted", "terminal"] as const) {
      const root = await mkdtemp(join(tmpdir(), `synthia-eval-expired-${state}-replay-`));
      roots.push(root);
      const ledger = await FileEvolutionEvalLedger.initialize({
        root: join(root, "ledger"),
        ledgerEpoch: "epoch-1",
      });
      const { binding, input } = bindingAndInput(state === "accepted" ? 6 : 7);
      await ledger.queryOrReserve(binding);
      const accepted = await ledger.markAccepted(binding, { executionState: "running" });
      expect(accepted.accepted_now).toBe(true);
      const spoolRoot = join(root, "spool");
      const workspace = await materializeReplayFixture(spoolRoot, binding, input);
      if (state === "terminal") {
        const identity = {
          pid: 2_147_483_000,
          processGroupId: 2_147_483_000,
          startToken: "8".repeat(64),
        };
        expect(await ledger.markProcessStarted(binding, identity, accepted.effect_owner_token!)).toBe(true);
        expect(await ledger.markProcessExitConfirmed(binding, identity, accepted.effect_owner_token!)).toBe(true);
        expect(await ledger.markTerminal(
          binding,
          { terminalState: "succeeded", errorCode: null },
          accepted.effect_owner_token!,
        )).toMatchObject({ state: "terminal", terminal_state: "succeeded" });
      }

      const beforeWorkspace = await readdir(workspace);
      let discoveries = 0;
      let preparations = 0;
      let executionEffects = 0;
      let guardianChecks = 0;
      const now = () => new Date("2100-01-01T00:00:00.000Z");
      const reopened = await FileEvolutionEvalLedger.reopen({
        root: join(root, "ledger"),
        ledgerEpoch: "epoch-1",
      });
      const runtime = new WorkerRuntime({
        endpoint: endpoint(root),
        workspaceRoot: join(root, "ordinary"),
        now,
        execution: {
          async discover() { discoveries += 1; return discovery; },
          async execute() { executionEffects += 1; return {}; },
        },
        evolutionEval: {
          ledger: reopened,
          spoolRoot,
          toolchainProfileHash: "3".repeat(64),
          now,
          execution: {
            async prepare() {
              preparations += 1;
              throw new Error("replay reached guardian preparation");
            },
            async execute() {
              executionEffects += 1;
              return { terminalState: "failed" };
            },
          },
          processSupervisor: {
            isTreeStopped() { guardianChecks += 1; return true; },
            async ownsIdentity() { guardianChecks += 1; return true; },
            async stopAndConfirm() { guardianChecks += 1; return true; },
          },
        },
      });
      const response = await post(runtime, "/evolution-eval/submit", {
        schema: "evolution-eval-submit-request.v1",
        binding,
        input,
      }, binding.dispatch.connector_idempotency_key, "omit");
      expect(response.status).toBe(200);
      expect((await response.json()) as RemoteEnvelope<{ state: string }>).toMatchObject({
        payload: { state },
      });
      expect(discoveries).toBe(0);
      expect(preparations).toBe(0);
      expect(executionEffects).toBe(0);
      expect(guardianChecks).toBe(0);
      expect(await readdir(workspace)).toEqual(beforeWorkspace);
      await expect(readdir(join(spoolRoot, "admissions"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(join(root, "ordinary"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("applies HDL/media/UTF-8 policy only to parameter-selected Vivado inputs", () => {
    const { binding, input } = bindingAndInput();
    const binary = Buffer.from([0xff, 0x00, 0x80]);
    const binaryHash = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
    const manifest = {
      ...input.manifest,
      files: [{
        path: "assets/blob.bin",
        sha256: binaryHash,
        size_bytes: binary.byteLength,
        media_type: "application/octet-stream",
        layer: "overlay" as const,
        read_only: false,
      }, ...input.manifest.files],
    };
    const projectionHash = canonicalEvolutionEvalHash({
      schema: "evolution-eval-sealed-input-projection.v1",
      manifest,
      files: manifest.files.map(({ path, sha256, size_bytes, media_type }) => ({ path, sha256, size_bytes, media_type })),
    });
    expect(canonicalEvolutionEvalSealedInputProjection(manifest).sha256).toBe(projectionHash);
    const dispatch = {
      ...binding.dispatch,
      workspace_manifest_hash: canonicalEvolutionEvalHash(manifest),
      sealed_input_projection_hash: projectionHash,
    };
    const projectedBinding = {
      ...binding,
      dispatch,
      dispatch_request_hash: computeEvolutionEvalDispatchRequestHash(dispatch),
    };
    const projectedInput = {
      ...input,
      manifest,
      files: [{
        path: "assets/blob.bin",
        sha256: binaryHash,
        size_bytes: binary.byteLength,
        media_type: "application/octet-stream",
        content_base64: binary.toString("base64"),
      }, ...input.files],
    };
    expect(() => validateEvolutionEvalSealedInput(projectedInput, binding)).toThrow();
    expect(validateEvolutionEvalSealedInput(projectedInput, projectedBinding).projectionHash).toBe(projectionHash);

    const selectedManifest = {
      ...input.manifest,
      files: input.manifest.files.map((file) => ({ ...file, media_type: "application/octet-stream" })),
    };
    const selectedProjectionHash = canonicalEvolutionEvalHash({
      schema: "evolution-eval-sealed-input-projection.v1",
      manifest: selectedManifest,
      files: selectedManifest.files.map(({ path, sha256, size_bytes, media_type }) => ({ path, sha256, size_bytes, media_type })),
    });
    const selectedDispatch = {
      ...binding.dispatch,
      workspace_manifest_hash: canonicalEvolutionEvalHash(selectedManifest),
      sealed_input_projection_hash: selectedProjectionHash,
    };
    const selectedBinding = { ...binding, dispatch: selectedDispatch, dispatch_request_hash: computeEvolutionEvalDispatchRequestHash(selectedDispatch) };
    const selectedInput = {
      ...input,
      manifest: selectedManifest,
      files: input.files.map((file) => ({ ...file, media_type: "application/octet-stream" })),
    };
    expect(() => validateEvolutionEvalSealedInput(selectedInput, selectedBinding)).toThrow();
  });
  test("only four capabilities advertise eval and the inner union rejects raw controls", () => {
    expect(VIVADO_CAPABILITIES.filter((capability) => capability.runClasses.includes("evolution_eval")).map((capability) => capability.operation))
      .toEqual(["validate_sources", "simulate", "synthesize", "implement"]);
    const inner = {
      schema: "evolution-eval-vivado-request.v1" as const,
      evalJobId: "eval-job-1",
      jobId: "connector-eval-job-1",
      projectId: "project-eval-1",
      runClass: "evolution_eval" as const,
      dispatchRequestHash: "1".repeat(64),
      workspaceManifestHash: "2".repeat(64),
      sealedInputProjectionHash: "4".repeat(64),
      toolchainProfileHash: "3".repeat(64),
      deadlineAt: "2099-01-01T00:00:00.000Z",
      timeoutMs: 1_000,
      operation: "validate_sources" as const,
      sources: [{ path: "top.sv", content: new Uint8Array([1]), mediaType: "text/x-systemverilog" }],
      top: null,
    };
    expect(validateEvolutionEvalVivadoRequest(inner)).toEqual(inner);
    for (const forbidden of [
      { command: "vivado -mode tcl" },
      { rawTcl: "program_hw_devices" },
      { projectPath: "/formal/project" },
      { hardwareTarget: "device-0" },
      { script: "scripts/run.tcl" },
    ]) expect(() => validateEvolutionEvalVivadoRequest({ ...inner, ...forbidden })).toThrow();
    expect(() => validateEvolutionEvalVivadoRequest({ ...inner, sealedInputProjectionHash: "f".repeat(64) })).not.toThrow();
    expect(() => validateEvolutionEvalVivadoRequest({ ...inner, sealedInputProjectionHash: "F".repeat(64) })).toThrow();
  });
});

describe("evolution-eval Worker execution and recovery", () => {
  test("process, output-retention, and terminal facts survive ledger reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-facts-")); roots.push(root);
    const ledgerRoot = join(root, "ledger");
    const ledger = await FileEvolutionEvalLedger.initialize({ root: ledgerRoot, ledgerEpoch: "epoch-1" });
    const { binding } = bindingAndInput();
    await ledger.queryOrReserve(binding);
    const accepted = await ledger.markAccepted(binding, { executionState: "running" });
    expect(accepted.accepted_now).toBe(true);
    const identity = { pid: 4242, processGroupId: 4242, startToken: "worker-process-1" };
    expect(await ledger.markProcessStarted(binding, identity, accepted.effect_owner_token!)).toBe(true);
    expect(await ledger.markOutput(binding, { spoolManifestHash: "4".repeat(64), entryCount: 1, totalBytes: 16 }, accepted.effect_owner_token!)).toBe(true);
    expect(await ledger.markProcessExitConfirmed(binding, identity, accepted.effect_owner_token!)).toBe(true);
    expect((await ledger.markTerminal(binding, { terminalState: "succeeded", errorCode: null }, accepted.effect_owner_token!)).state).toBe("terminal");
    const reopened = await FileEvolutionEvalLedger.reopen({ root: ledgerRoot, ledgerEpoch: "epoch-1" });
    expect(await reopened.query(binding)).toMatchObject({ state: "terminal", terminal_state: "succeeded", process_stopped: true });
  });

  test("durable response-lost acceptance survives restart and never executes twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-worker-")); roots.push(root);
    const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
    let executions = 0;
    const execution: EvolutionEvalExecution = { async execute() { executions += 1; await new Promise(() => {}); throw new Error("unreachable"); } };
    const options = { endpoint: endpoint(root), workspaceRoot: join(root, "ordinary"), execution: { async discover() { return discovery; }, async execute() { return {}; } }, evolutionEval: { ledger, spoolRoot: join(root, "spool"), execution, toolchainProfileHash: "3".repeat(64), stopGraceMs: 10 } };
    const runtime = new WorkerRuntime(options); await ready(runtime);
    const { binding, input } = bindingAndInput();
    expect((await post(runtime, "/evolution-eval/reserve", { schema: "evolution-eval-reserve-request.v1", binding })).status).toBe(200);
    const submitted = await post(runtime, "/evolution-eval/submit", { schema: "evolution-eval-submit-request.v1", binding, input }, binding.dispatch.connector_idempotency_key);
    expect(submitted.status).toBe(202);
    await Bun.sleep(0);
    expect(executions).toBe(1);

    const reopened = await FileEvolutionEvalLedger.reopen({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
    const restarted = new WorkerRuntime({ ...options, evolutionEval: { ...options.evolutionEval, ledger: reopened } });
    const query = await post(restarted, "/evolution-eval/query", { schema: "evolution-eval-query-request.v1", binding });
    expect(query.status).toBe(200);
    expect(((await query.json()) as RemoteEnvelope<{ state: string }>).payload.state).toBe("accepted");
    expect(executions).toBe(1);
    const cancelled = await post(restarted, "/evolution-eval/cancel", { schema: "evolution-eval-cancel-request.v1", binding, reason: "deadline" });
    expect(((await cancelled.json()) as RemoteEnvelope<{ state: string }>).payload.state).toBe("ambiguous");
  });

  test("same-Worker reserve, submit, and cancel replays echo each new correlation from durable state", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-correlation-replay-")); roots.push(root);
    const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
    const execution: EvolutionEvalExecution = { async execute() { return new Promise(() => {}); } };
    const runtime = new WorkerRuntime({
      endpoint: endpoint(root), workspaceRoot: join(root, "ordinary"),
      execution: { async discover() { return discovery; }, async execute() { return {}; } },
      evolutionEval: { ledger, spoolRoot: join(root, "spool"), execution, toolchainProfileHash: "3".repeat(64), stopGraceMs: 5 },
    });
    await ready(runtime);
    const { binding, input } = bindingAndInput();
    const cases = [
      {
        path: "/evolution-eval/reserve",
        key: "reserve-replay-key",
        payload: { schema: "evolution-eval-reserve-request.v1", binding },
      },
      {
        path: "/evolution-eval/submit",
        key: binding.dispatch.connector_idempotency_key,
        payload: { schema: "evolution-eval-submit-request.v1", binding, input },
      },
      {
        path: "/evolution-eval/cancel",
        key: "cancel-replay-key",
        payload: { schema: "evolution-eval-cancel-request.v1", binding, reason: "deadline" },
      },
    ];
    for (const item of cases) {
      for (const correlation of [`${item.key}-first`, `${item.key}-retry`]) {
        const response = await postWithCorrelation(runtime, item.path, item.payload, item.key, correlation);
        expect(response.status).toBeLessThan(300);
        expect(((await response.json()) as RemoteEnvelope<unknown>).correlation_id).toBe(correlation);
      }
    }
  });

  test("cancel only reports cancelled after the executing process confirms stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-cancel-")); roots.push(root);
    const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
    const execution: EvolutionEvalExecution = {
      async execute({ signal, onProcessStarted }) {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
        const identity = await liveProcessIdentity(child.pid!);
        if (!await onProcessStarted(identity)) {
          try { process.kill(process.platform === "win32" ? identity.pid : -identity.processGroupId, "SIGKILL"); } catch {}
          return { terminalState: "failed" };
        }
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { terminalState: "failed" };
      },
    };
    const runtime = new WorkerRuntime({ endpoint: endpoint(root), workspaceRoot: join(root, "ordinary"), execution: { async discover() { return discovery; }, async execute() { return {}; } }, evolutionEval: { ledger, spoolRoot: join(root, "spool"), execution, toolchainProfileHash: "3".repeat(64), stopGraceMs: 100 } });
    await ready(runtime);
    const { binding, input } = bindingAndInput();
    await post(runtime, "/evolution-eval/reserve", { schema: "evolution-eval-reserve-request.v1", binding });
    await post(runtime, "/evolution-eval/submit", { schema: "evolution-eval-submit-request.v1", binding, input }, binding.dispatch.connector_idempotency_key);
    const response = await post(runtime, "/evolution-eval/cancel", { schema: "evolution-eval-cancel-request.v1", binding, reason: "tombstoned" });
    expect(response.status).toBe(200);
    const observation = (await response.json()) as RemoteEnvelope<{ state: string; terminal_state: string; process_stopped: boolean }>;
    expect(observation.payload).toMatchObject({ state: "terminal", terminal_state: "cancelled", process_stopped: true });
  });

  test("an execution that cannot confirm stop stays ambiguous, never cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-unconfirmed-")); roots.push(root);
    const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
    const execution: EvolutionEvalExecution = { execute: async () => new Promise(() => {}) };
    const runtime = new WorkerRuntime({ endpoint: endpoint(root), workspaceRoot: join(root, "ordinary"), execution: { async discover() { return discovery; }, async execute() { return {}; } }, evolutionEval: { ledger, spoolRoot: join(root, "spool"), execution, toolchainProfileHash: "3".repeat(64), stopGraceMs: 10 } });
    await ready(runtime);
    const { binding, input } = bindingAndInput();
    await post(runtime, "/evolution-eval/reserve", { schema: "evolution-eval-reserve-request.v1", binding });
    await post(runtime, "/evolution-eval/submit", { schema: "evolution-eval-submit-request.v1", binding, input }, binding.dispatch.connector_idempotency_key);
    const response = await post(runtime, "/evolution-eval/cancel", { schema: "evolution-eval-cancel-request.v1", binding, reason: "deadline" });
    expect((await response.json()) as RemoteEnvelope<{ state: string }>).toMatchObject({ payload: { state: "ambiguous" } });
    expect(await ledger.query(binding)).toMatchObject({ state: "accepted" });
  });

  test("generic submit rejects evolution_eval before any ledger or execution effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-generic-")); roots.push(root);
    const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
    let executions = 0;
    const runtime = new WorkerRuntime({ endpoint: endpoint(root), workspaceRoot: join(root, "ordinary"), execution: { async discover() { return discovery; }, async execute() { executions += 1; return {}; } }, evolutionEval: { ledger, spoolRoot: join(root, "spool"), execution: { async execute() { executions += 1; return { terminalState: "succeeded" }; } }, toolchainProfileHash: "3".repeat(64) } });
    await ready(runtime);
    const response = await post(runtime, "/jobs/submit", { request: { jobId: "generic-eval-1", idempotencyKey: "k", projectId: "project-eval-1", operation: "validate_sources", runClass: "evolution_eval", input: "x", correlationId: "c" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: "EVOLUTION_EVAL_DEDICATED_ROUTE_REQUIRED" });
    expect(executions).toBe(0);
  });

  test("durable 256 MiB admissions cap concurrent eval output at eight jobs across Worker instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-admission-")); roots.push(root);
    const ledgerRoot = join(root, "ledger");
    const firstLedger = await FileEvolutionEvalLedger.initialize({ root: ledgerRoot, ledgerEpoch: "epoch-1" });
    const secondLedger = await FileEvolutionEvalLedger.reopen({ root: ledgerRoot, ledgerEpoch: "epoch-1" });
    const execution: EvolutionEvalExecution = { async execute() { return new Promise(() => {}); } };
    const base = {
      endpoint: endpoint(root),
      workspaceRoot: join(root, "ordinary"),
      execution: { async discover() { return discovery; }, async execute() { return {}; } },
    };
    const spoolRoot = join(root, "spool");
    const left = new WorkerRuntime({ ...base, evolutionEval: { ledger: firstLedger, spoolRoot, execution, toolchainProfileHash: "3".repeat(64) } });
    const right = new WorkerRuntime({ ...base, evolutionEval: { ledger: secondLedger, spoolRoot, execution, toolchainProfileHash: "3".repeat(64) } });
    await Promise.all([ready(left), ready(right)]);
    const jobs = Array.from({ length: 9 }, (_, index) => bindingAndInput(index + 1));
    await Promise.all(jobs.map(({ binding }, index) => post(
      index % 2 === 0 ? left : right,
      "/evolution-eval/reserve",
      { schema: "evolution-eval-reserve-request.v1", binding },
    )));
    const firstSeven = await Promise.all(jobs.slice(0, 7).map(({ binding, input }, index) => post(
      index % 2 === 0 ? left : right,
      "/evolution-eval/submit",
      { schema: "evolution-eval-submit-request.v1", binding, input },
      binding.dispatch.connector_idempotency_key,
    )));
    expect(firstSeven.every((response) => response.status === 202)).toBe(true);
    const sevenSpool = await post(left, "/evolution-eval/spool/query", {
      schema: "evolution-eval-spool-query.v1",
      binding: jobs[0]!.binding,
    });
    expect((await sevenSpool.json()) as RemoteEnvelope<{ unacked_bytes: number }>).toMatchObject({
      payload: { unacked_bytes: 1_879_048_192 },
    });
    const boundary = await Promise.all(jobs.slice(7).map(({ binding, input }, index) => post(
      index % 2 === 0 ? left : right,
      "/evolution-eval/submit",
      { schema: "evolution-eval-submit-request.v1", binding, input },
      binding.dispatch.connector_idempotency_key,
    )));
    expect(boundary.filter((response) => response.status === 202)).toHaveLength(1);
    expect(boundary.filter((response) => response.status === 503)).toHaveLength(1);
    const accepted = jobs[0]!;
    const spool = await post(left, "/evolution-eval/spool/query", {
      schema: "evolution-eval-spool-query.v1",
      binding: accepted.binding,
    });
    expect((await spool.json()) as RemoteEnvelope<{ unacked_bytes: number; hard_cap_bytes: number }>).toMatchObject({
      payload: { unacked_bytes: 2_147_483_648, hard_cap_bytes: 2_147_483_648 },
    });

    const reopened = await FileEvolutionEvalLedger.reopen({ root: ledgerRoot, ledgerEpoch: "epoch-1" });
    const restarted = new WorkerRuntime({ ...base, evolutionEval: { ledger: reopened, spoolRoot, execution, toolchainProfileHash: "3".repeat(64) } });
    await ready(restarted);
    const replay = await post(restarted, "/evolution-eval/submit", {
      schema: "evolution-eval-submit-request.v1",
      binding: accepted.binding,
      input: accepted.input,
    }, accepted.binding.dispatch.connector_idempotency_key);
    expect(replay.status).toBe(200);
  }, process.platform === "win32" ? 120_000 : 5_000);

  test("restart reconciles a crash-stale admission only for terminal jobs with proven no output", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-admission-recovery-")); roots.push(root);
    const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
    const { binding, input } = bindingAndInput();
    await ledger.queryOrReserve(binding);
    const accepted = await ledger.markAccepted(binding, { executionState: "running" });
    const identity = { pid: 5401, processGroupId: 5401, startToken: "a".repeat(64) };
    await ledger.markProcessStarted(binding, identity, accepted.effect_owner_token!);
    await ledger.markProcessExitConfirmed(binding, identity, accepted.effect_owner_token!);
    expect((await ledger.markTerminal(binding, { terminalState: "failed", errorCode: "VIVADO_PREPARE_FAILED" }, accepted.effect_owner_token!)).state).toBe("terminal");
    const projectionHash = validateEvolutionEvalSealedInput(input, binding).projectionHash;
    const spoolRoot = join(root, "spool");
    const admissions = join(spoolRoot, "admissions");
    await mkdir(admissions, { recursive: true });
    await writeFile(join(admissions, "slot-0.json"), JSON.stringify({
      schema: "evolution-eval-spool-admission.v2",
      connector_job_id: binding.dispatch.connector_job_id,
      dispatch_request_hash: binding.dispatch_request_hash,
      sealed_input_projection_hash: projectionHash,
      reserved_bytes: 256 * 1024 * 1024,
      owner_process: { pid: 2147483647, start_token: "f".repeat(64) },
      binding,
    }));
    const reopened = await FileEvolutionEvalLedger.reopen({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
    const runtime = new WorkerRuntime({
      endpoint: endpoint(root), workspaceRoot: join(root, "ordinary"),
      execution: { async discover() { return discovery; }, async execute() { return {}; } },
      evolutionEval: { ledger: reopened, spoolRoot, execution: { async execute() { return { terminalState: "failed" }; } }, toolchainProfileHash: "3".repeat(64) },
    });
    await ready(runtime);
    const response = await post(runtime, "/evolution-eval/spool/query", { schema: "evolution-eval-spool-query.v1", binding });
    expect((await response.json()) as RemoteEnvelope<{ unacked_bytes: number }>).toMatchObject({ payload: { unacked_bytes: 0 } });
    expect((await readdir(admissions)).filter((name) => name.startsWith("slot-"))).toEqual([]);
  }, process.platform === "win32" ? 30_000 : 5_000);

  test("restart reclaims a dead-owner pre-accept admission only with durable negative proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-preaccept-recovery-")); roots.push(root);
    const ledgerRoot = join(root, "ledger");
    const ledger = await FileEvolutionEvalLedger.initialize({ root: ledgerRoot, ledgerEpoch: "epoch-1" });
    const { binding, input } = bindingAndInput();
    const projectionHash = validateEvolutionEvalSealedInput(input, binding).projectionHash;
    const spoolRoot = join(root, "spool");
    const admissions = join(spoolRoot, "admissions");
    await mkdir(admissions, { recursive: true });
    await writeFile(join(admissions, "slot-0.json"), JSON.stringify({
      schema: "evolution-eval-spool-admission.v2",
      connector_job_id: binding.dispatch.connector_job_id,
      dispatch_request_hash: binding.dispatch_request_hash,
      sealed_input_projection_hash: projectionHash,
      reserved_bytes: 256 * 1024 * 1024,
      owner_process: { pid: process.pid, start_token: "e".repeat(64) },
      binding,
    }));
    const reopened = await FileEvolutionEvalLedger.reopen({ root: ledgerRoot, ledgerEpoch: "epoch-1" });
    const runtime = new WorkerRuntime({
      endpoint: endpoint(root), workspaceRoot: join(root, "ordinary"),
      execution: { async discover() { return discovery; }, async execute() { return {}; } },
      evolutionEval: {
        ledger: reopened,
        spoolRoot,
        execution: { async execute() { return { terminalState: "failed" }; } },
        toolchainProfileHash: "3".repeat(64),
      },
    });
    await ready(runtime);
    const withoutProof = await post(runtime, "/evolution-eval/spool/query", {
      schema: "evolution-eval-spool-query.v1",
      binding,
    });
    expect((await withoutProof.json()) as RemoteEnvelope<{ unacked_bytes: number }>).toMatchObject({
      payload: { unacked_bytes: 256 * 1024 * 1024 },
    });
    expect((await readdir(admissions)).filter((name) => name.startsWith("slot-"))).toEqual(["slot-0.json"]);
    expect((await ledger.queryOrReserve(binding)).state).toBe("proven_never_accepted");
    const withProof = await post(runtime, "/evolution-eval/spool/query", {
      schema: "evolution-eval-spool-query.v1",
      binding,
    }, `spool-proof-${crypto.randomUUID()}`);
    expect((await withProof.json()) as RemoteEnvelope<{ unacked_bytes: number }>).toMatchObject({
      payload: { unacked_bytes: 0 },
    });
    expect((await readdir(admissions)).filter((name) => name.startsWith("slot-"))).toEqual([]);
  });

  test("a different live process cannot borrow a same-job admission before owner cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-live-owner-race-")); roots.push(root);
    const ownerProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (!ownerProcess.pid) throw new Error("test owner process unavailable");
    try {
      const ownerIdentity = await liveProcessIdentity(ownerProcess.pid);
      const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
      const { binding, input } = bindingAndInput();
      expect((await ledger.queryOrReserve(binding)).state).toBe("proven_never_accepted");
      const projectionHash = validateEvolutionEvalSealedInput(input, binding).projectionHash;
      const spoolRoot = join(root, "spool");
      const admissions = join(spoolRoot, "admissions");
      await mkdir(admissions, { recursive: true });
      await writeFile(join(admissions, "slot-0.json"), JSON.stringify({
        schema: "evolution-eval-spool-admission.v2",
        connector_job_id: binding.dispatch.connector_job_id,
        dispatch_request_hash: binding.dispatch_request_hash,
        sealed_input_projection_hash: projectionHash,
        reserved_bytes: 256 * 1024 * 1024,
        owner_process: { pid: ownerIdentity.pid, start_token: ownerIdentity.startToken },
        binding,
      }));
      let executions = 0;
      const runtime = new WorkerRuntime({
        endpoint: endpoint(root), workspaceRoot: join(root, "ordinary"),
        execution: { async discover() { return discovery; }, async execute() { return {}; } },
        evolutionEval: {
          ledger,
          spoolRoot,
          execution: { async execute() { executions += 1; return new Promise(() => {}); } },
          toolchainProfileHash: "3".repeat(64),
        },
      });
      await ready(runtime);
      const borrowed = await post(runtime, "/evolution-eval/submit", {
        schema: "evolution-eval-submit-request.v1",
        binding,
        input,
      }, binding.dispatch.connector_idempotency_key);
      expect(borrowed.status).toBe(503);
      expect(executions).toBe(0);
      expect(await ledger.query(binding)).toMatchObject({ state: "proven_never_accepted" });
      const occupied = await post(runtime, "/evolution-eval/spool/query", {
        schema: "evolution-eval-spool-query.v1",
        binding,
      });
      expect((await occupied.json()) as RemoteEnvelope<{ unacked_bytes: number }>).toMatchObject({
        payload: { unacked_bytes: 256 * 1024 * 1024 },
      });

      const ownerExited = new Promise<void>((resolveExit) => ownerProcess.once("exit", () => resolveExit()));
      ownerProcess.kill("SIGKILL");
      await ownerExited;
      const takeover = await post(runtime, "/evolution-eval/submit", {
        schema: "evolution-eval-submit-request.v1",
        binding,
        input,
      }, binding.dispatch.connector_idempotency_key);
      expect(takeover.status).toBe(202);
      expect(executions).toBe(1);
      expect(await ledger.query(binding)).toMatchObject({ state: "accepted" });
    } finally {
      if (ownerProcess.exitCode === null && ownerProcess.signalCode === null) ownerProcess.kill("SIGKILL");
    }
  }, process.platform === "win32" ? 60_000 : 5_000);

  test("cancel between acceptance and process callback latches a durable stop and never releases the command", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-prelaunch-cancel-")); roots.push(root);
    const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
    const entered = barrier();
    const release = barrier();
    let stopped = false;
    let commandEffects = 0;
    const identity = { pid: 5101, processGroupId: 5101, startToken: "prelaunch-cancel-guardian" };
    const execution: EvolutionEvalExecution = {
      async execute({ onProcessStarted }) {
        entered.release();
        await release.promise;
        if (await onProcessStarted(identity)) commandEffects += 1;
        stopped = true;
        return { terminalState: "failed" };
      },
    };
    const runtime = new WorkerRuntime({
      endpoint: endpoint(root), workspaceRoot: join(root, "ordinary"),
      execution: { async discover() { return discovery; }, async execute() { return {}; } },
      evolutionEval: {
        ledger, spoolRoot: join(root, "spool"), execution, toolchainProfileHash: "3".repeat(64), stopGraceMs: 1_000,
        processSupervisor: {
          isTreeStopped: () => stopped,
          ownsIdentity: async () => true,
          async stopAndConfirm() { stopped = true; return true; },
        },
      },
    });
    await ready(runtime);
    const { binding, input } = bindingAndInput();
    await post(runtime, "/evolution-eval/reserve", { schema: "evolution-eval-reserve-request.v1", binding });
    await post(runtime, "/evolution-eval/submit", { schema: "evolution-eval-submit-request.v1", binding, input }, binding.dispatch.connector_idempotency_key);
    await entered.promise;
    const cancelled = post(runtime, "/evolution-eval/cancel", { schema: "evolution-eval-cancel-request.v1", binding, reason: "tombstoned" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await ledger.getStopObservation(binding)).state === "stop_requested") break;
      await Bun.sleep(1);
    }
    release.release();
    expect(((await (await cancelled).json()) as RemoteEnvelope<{ state: string; terminal_state: string }>).payload)
      .toMatchObject({ state: "terminal", terminal_state: "cancelled" });
    expect(commandEffects).toBe(0);
  });

  test("deadline crossing during preparation starts only an inert guardian and settles timeout with zero command effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-prelaunch-deadline-")); roots.push(root);
    const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
    let stopped = false;
    let commandEffects = 0;
    const identity = { pid: 5201, processGroupId: 5201, startToken: "prelaunch-deadline-guardian" };
    const execution: EvolutionEvalExecution = {
      async execute({ onProcessStarted }) {
        await Bun.sleep(40);
        if (await onProcessStarted(identity)) commandEffects += 1;
        stopped = true;
        return { terminalState: "timeout" };
      },
    };
    const runtime = new WorkerRuntime({
      endpoint: endpoint(root), workspaceRoot: join(root, "ordinary"),
      execution: { async discover() { return discovery; }, async execute() { return {}; } },
      evolutionEval: {
        ledger, spoolRoot: join(root, "spool"), execution, toolchainProfileHash: "3".repeat(64), stopGraceMs: 100,
        processSupervisor: {
          isTreeStopped: () => stopped,
          ownsIdentity: async () => true,
          async stopAndConfirm() { stopped = true; return true; },
        },
      },
    });
    await ready(runtime);
    const base = bindingAndInput();
    const dispatch = {
      ...base.binding.dispatch,
      requested_timeout_ms: 10,
      // The requested 10ms timeout, not slow platform-specific durable setup,
      // must be what crosses during the 40ms preparation seam.
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const binding = { ...base.binding, dispatch, dispatch_request_hash: computeEvolutionEvalDispatchRequestHash(dispatch) };
    await post(runtime, "/evolution-eval/reserve", { schema: "evolution-eval-reserve-request.v1", binding });
    await post(runtime, "/evolution-eval/submit", { schema: "evolution-eval-submit-request.v1", binding, input: base.input }, binding.dispatch.connector_idempotency_key);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const observation = await ledger.query(binding);
      if (observation.state === "terminal") {
        expect(observation).toMatchObject({ terminal_state: "timeout", process_stopped: true });
        break;
      }
      await Bun.sleep(1);
    }
    expect(await ledger.query(binding)).toMatchObject({ state: "terminal", terminal_state: "timeout" });
    expect(commandEffects).toBe(0);
  });

  test("whole-tree supervisor proof refuses terminal when guardian exits but a descendant survives", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-tree-proof-")); roots.push(root);
    const ledger = await FileEvolutionEvalLedger.initialize({ root: join(root, "ledger"), ledgerEpoch: "epoch-1" });
    let guardianStopped = false;
    let descendantStopped = false;
    const identity = { pid: 5301, processGroupId: 5301, startToken: "windows-job-guardian-proof" };
    const execution: EvolutionEvalExecution = {
      async execute({ onProcessStarted }) {
        expect(await onProcessStarted(identity)).toBe(true);
        guardianStopped = true;
        return { terminalState: "succeeded" };
      },
    };
    const runtime = new WorkerRuntime({
      endpoint: endpoint(root), workspaceRoot: join(root, "ordinary"),
      execution: { async discover() { return discovery; }, async execute() { return {}; } },
      evolutionEval: {
        ledger, spoolRoot: join(root, "spool"), execution, toolchainProfileHash: "3".repeat(64),
        processSupervisor: {
          isTreeStopped: () => guardianStopped && descendantStopped,
          ownsIdentity: async () => true,
          async stopAndConfirm() { return false; },
        },
      },
    });
    await ready(runtime);
    const { binding, input } = bindingAndInput();
    await post(runtime, "/evolution-eval/reserve", { schema: "evolution-eval-reserve-request.v1", binding });
    await post(runtime, "/evolution-eval/submit", { schema: "evolution-eval-submit-request.v1", binding, input }, binding.dispatch.connector_idempotency_key);
    await Bun.sleep(20);
    expect(await ledger.query(binding)).toMatchObject({ state: "accepted" });
  });
});

describe("evolution-eval bounded process-tree stop", () => {
  test("process identity acquisition failure kills the inert guardian without releasing a command", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-token-fault-")); roots.push(root);
    let guardianPid = 0;
    await expect(createVivadoProcessGuardian(root, undefined, undefined, async (pid) => {
      guardianPid = pid;
      throw new Error("injected token read failure");
    })).rejects.toThrow("injected token read failure");
    expect(guardianPid).toBeGreaterThan(0);
    expect(() => process.kill(guardianPid, 0)).toThrow();
  }, process.platform === "win32" ? 30_000 : 5_000);

  test("closing a normally completed guardian never targets its exited PID", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-guardian-close-")); roots.push(root);
    let terminateCalls = 0;
    const guardian = await createVivadoProcessGuardian(
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      () => { terminateCalls += 1; },
    );
    const result = await guardian.run(process.execPath, ["-e", "process.exit(0)"], root, 5_000);
    expect(result.exitCode).toBe(0);
    await guardian.close();
    expect(terminateCalls).toBe(0);
  });

  test("Windows Job Object cancel kills the real guardian, child, and grandchild", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-windows-job-tree-")); roots.push(root);
    const grandchildScript = String.raw`
[IO.File]::WriteAllText((Join-Path (Get-Location) 'grandchild.pid'), [string]$PID)
Start-Sleep -Seconds 300
`;
    const grandchildEncoded = Buffer.from(grandchildScript, "utf16le").toString("base64");
    const childScript = String.raw`
[IO.File]::WriteAllText((Join-Path (Get-Location) 'child.pid'), [string]$PID)
$grandchild = Start-Process powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${grandchildEncoded}') -PassThru
[IO.File]::WriteAllText((Join-Path (Get-Location) 'spawned-grandchild.pid'), [string]$grandchild.Id)
Wait-Process -Id $grandchild.Id
`;
    const guardian = await createVivadoProcessGuardian(root);
    const controller = new AbortController();
    const run = guardian.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(childScript, "utf16le").toString("base64"),
    ], root, 60_000, controller.signal);
    const childPath = join(root, "child.pid");
    const grandchildPath = join(root, "grandchild.pid");
    const spawnedGrandchildPath = join(root, "spawned-grandchild.pid");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await Promise.all([readFile(childPath, "utf8"), readFile(grandchildPath, "utf8"), readFile(spawnedGrandchildPath, "utf8")]);
        break;
      } catch {
        await Bun.sleep(10);
      }
    }
    const childPid = Number((await readFile(childPath, "utf8")).trim());
    const grandchildPid = Number((await readFile(grandchildPath, "utf8")).trim());
    expect(Number((await readFile(spawnedGrandchildPath, "utf8")).trim())).toBe(grandchildPid);
    controller.abort("cancelled");
    await Promise.race([run, Bun.sleep(5_000).then(() => { throw new Error("Windows Job Object did not stop"); })]);
    await guardian.close();
    for (const pid of [guardian.identity.pid, childPid, grandchildPid]) {
      let alive = true;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { process.kill(pid, 0); } catch { alive = false; break; }
        await Bun.sleep(10);
      }
      expect(alive).toBe(false);
    }
  }, process.platform === "win32" ? 30_000 : 5_000);

  test("AbortSignal terminates the spawned Vivado process group and leaves no child", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "synthia-eval-process-")); roots.push(root);
    const binary = join(root, "fake-vivado.sh");
    await writeFile(binary, "#!/bin/sh\necho $$ > parent.pid\nsleep 30 &\necho $! > child.pid\nwait\n", "utf8");
    await chmod(binary, 0o700);
    const adapter = new VivadoBatchAdapter({ workspaceRoot: join(root, "work"), binary });
    const controller = new AbortController();
    const execution = adapter.executeEvolutionEval({
      schema: "evolution-eval-vivado-request.v1",
      evalJobId: "eval-process-job-1",
      operation: "validate_sources",
      jobId: "eval-process-1",
      projectId: "project-eval-1",
      runClass: "evolution_eval",
      dispatchRequestHash: "1".repeat(64),
      workspaceManifestHash: "2".repeat(64),
      sealedInputProjectionHash: "4".repeat(64),
      toolchainProfileHash: "3".repeat(64),
      deadlineAt: "2099-01-01T00:00:00.000Z",
      sources: [{ path: "top.sv", content: "module top; endmodule\n", mediaType: "text/x-systemverilog" }],
      top: "top",
      timeoutMs: 60_000,
    }, controller.signal);
    const pidPath = join(root, "work", "eval-process-1", "parent.pid");
    const childPath = join(root, "work", "eval-process-1", "child.pid");
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try { await Promise.all([readFile(pidPath, "utf8"), readFile(childPath, "utf8")]); break; }
      catch { await Bun.sleep(5); }
    }
    const parentPid = Number((await readFile(pidPath, "utf8")).trim());
    const childPid = Number((await readFile(childPath, "utf8")).trim());
    controller.abort("cancelled");
    await Promise.race([execution, Bun.sleep(2_000).then(() => { throw new Error("process tree did not stop"); })]);
    await Bun.sleep(20);
    for (const pid of [parentPid, childPid]) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });
});
