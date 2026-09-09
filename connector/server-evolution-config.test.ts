import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../core/src/hashing.ts";
import { canonicalEvolutionEvalHash } from "./evolution-eval.ts";
import {
  initializeEvolutionEvalLedgerFromConfig,
  loadWorkerConfig,
  verifyConfiguredBundleIdentity,
  verifyEvolutionEvalLedgerFromConfig,
  verifyWorkerReleaseManifest,
  type WorkerConfig,
} from "./server.ts";

const roots: string[] = [];
const executedBundleHash = sha256(await readFile(process.argv[1]!));
afterEach(async () => {
  delete process.env.SYNTHIA_WORKER_CONFIG_SHA256;
  delete process.env.SYNTHIA_WORKER_VERIFY_BUNDLE;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function config(root: string, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    connector_id: "vivado-66-xc7k70t",
    display_name: "M4-F config test",
    endpoint_url: "https://127.0.0.1:8443",
    protocol_version: "connector.remote.v1",
    transport_mode: "direct_https",
    auth_mode: "mtls",
    tls_trust_ref: "secret://trust/test",
    tls_client_cert_ref: "secret://cert/test",
    project_scope: ["p1"],
    data_classification_scope: ["internal"],
    allowed_capability_ids: ["validate_sources", "simulate", "synthesize", "implement"],
    toolchain_profile_hash: "1".repeat(64),
    worker_labels: { os: "test" },
    heartbeat_interval_seconds: 10,
    lease_seconds: 30,
    max_concurrency: 1,
    registration_state: "registering",
    created_at: "2026-08-27T00:00:00.000Z",
    updated_at: "2026-08-27T00:00:00.000Z",
    audited_by: "test",
    listen_host: "127.0.0.1",
    listen_port: 8443,
    server_certificate_path: join(root, "server.pfx"),
    server_private_key_path: join(root, "server.pfx"),
    trusted_client_ca_path: join(root, "client-ca.cer"),
    workspace_root: join(root, "workspaces"),
    evidence_root: join(root, "evidence"),
    vivado_binary: join(root, "vivado.bat"),
    vivado_part: "xc7k70tfbv676-1",
    vivado_install_identity: "test-vivado",
    capability_map_version: "vivado-2021.1-1",
    part_catalog_hash: "2".repeat(64),
    sdk_worker_build_hash: executedBundleHash,
    evolution_eval_enabled: true,
    evolution_eval_ledger_root: join(root, "evolution-ledger"),
    evolution_eval_ledger_epoch: "worker-66-m4f-test-epoch",
    evolution_eval_ledger_mode: "initialize",
    evolution_eval_spool_root: join(root, "evolution-spool"),
    evolution_eval_log_root: join(root, "logs"),
    vivado_toolchain_attestation_path: join(root, "vivado-toolchain-attestation.json"),
    vivado_toolchain_attestation_sha256: "9".repeat(64),
    vivado_toolchain_lock_handoff_path: join(root, "vivado-toolchain-lock-handoff.json"),
    ...overrides,
  };
}

async function writeConfig(root: string, value: WorkerConfig): Promise<string> {
  const path = join(root, "worker.json");
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, bytes);
  process.env.SYNTHIA_WORKER_CONFIG_SHA256 = sha256(bytes);
  return path;
}

describe("M4-F evolution-eval Worker configuration ceremony", () => {
  test("initializes once, then verifies only the same epoch in reopen mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-m4f-config-"));
    roots.push(root);
    const initial = config(root);
    const path = await writeConfig(root, initial);
    expect(await initializeEvolutionEvalLedgerFromConfig(path)).toBe(initial.evolution_eval_ledger_epoch!);
    expect(JSON.parse(await readFile(join(initial.evolution_eval_ledger_root!, "ledger.json"), "utf8")))
      .toMatchObject({ schema: "evolution-eval-ledger-metadata.v2", ledger_epoch: initial.evolution_eval_ledger_epoch });
    await expect(initializeEvolutionEvalLedgerFromConfig(path))
      .rejects.toThrow("CONFIG_INVALID:evolution_eval_ledger:EVOLUTION_EVAL_LEDGER_CORRUPT");

    const reopen = { ...initial, evolution_eval_ledger_mode: "reopen" as const };
    await writeConfig(root, reopen);
    expect(await verifyEvolutionEvalLedgerFromConfig(path)).toBe(initial.evolution_eval_ledger_epoch!);
    await writeConfig(root, { ...reopen, evolution_eval_ledger_epoch: "worker-66-wrong-epoch" });
    await expect(verifyEvolutionEvalLedgerFromConfig(path))
      .rejects.toThrow("CONFIG_INVALID:evolution_eval_ledger:EVOLUTION_EVAL_LEDGER_EPOCH_MISMATCH");
  });

  test("rejects unsafe roots, invalid modes, and non-boolean enablement before startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-m4f-invalid-"));
    roots.push(root);
    const duplicateRoots = config(root, { evolution_eval_spool_root: join(root, "workspaces") });
    await expect(loadWorkerConfig(await writeConfig(root, duplicateRoots)))
      .rejects.toThrow("CONFIG_INVALID:evolution_eval_roots");
    const nestedRoots = config(root, { evolution_eval_spool_root: join(root, "workspaces", "eval-spool") });
    await expect(loadWorkerConfig(await writeConfig(root, nestedRoots)))
      .rejects.toThrow("CONFIG_INVALID:evolution_eval_roots");
    await expect(loadWorkerConfig(await writeConfig(root, config(root, {
      evolution_eval_ledger_mode: "unsafe" as never,
    })))).rejects.toThrow("CONFIG_INVALID:evolution_eval_ledger_mode");
    await expect(loadWorkerConfig(await writeConfig(root, config(root, {
      evolution_eval_enabled: "true" as never,
    })))).rejects.toThrow("CONFIG_INVALID:evolution_eval_enabled");
    await expect(loadWorkerConfig(await writeConfig(root, config(root, {
      evolution_eval_ledger_epoch: "REPLACE_WITH_M4F_DEPLOYMENT_EPOCH",
    })))).rejects.toThrow("CONFIG_INVALID:evolution_eval_ledger_epoch");
    await expect(loadWorkerConfig(await writeConfig(root, config(root, {
      evolution_eval_log_root: undefined,
    })))).rejects.toThrow("CONFIG_INVALID:evolution_eval_log_root");
  });

  test("binds the configured SDK build identity to the exact bundle bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-m4f-bundle-"));
    roots.push(root);
    const bundle = join(root, "server.bundle.mjs");
    const bytes = new TextEncoder().encode("export const release = 'm4f';\n");
    await writeFile(bundle, bytes);
    const expected = config(root, { sdk_worker_build_hash: sha256(bytes) });
    expect(await verifyConfiguredBundleIdentity(expected, bundle)).toBe(sha256(bytes));
    await expect(verifyConfiguredBundleIdentity({ ...expected, sdk_worker_build_hash: "f".repeat(64) }, bundle))
      .rejects.toThrow("CONFIG_INVALID:sdk_worker_build_hash");
  });

  test("eval ceremonies verify the actual executing bundle without the legacy opt-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-m4f-bundle-required-"));
    roots.push(root);
    const path = await writeConfig(root, config(root, { sdk_worker_build_hash: "f".repeat(64) }));
    delete process.env.SYNTHIA_WORKER_VERIFY_BUNDLE;
    await expect(initializeEvolutionEvalLedgerFromConfig(path))
      .rejects.toThrow("CONFIG_INVALID:sdk_worker_build_hash");
    expect(await readFile(process.argv[1]!)).toBeTruthy();
  });

  test("eval ceremonies require an exact active config hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-m4f-config-required-"));
    roots.push(root);
    const path = await writeConfig(root, config(root));
    delete process.env.SYNTHIA_WORKER_CONFIG_SHA256;
    await expect(initializeEvolutionEvalLedgerFromConfig(path))
      .rejects.toThrow("CONFIG_INVALID:active_config_sha256");
  });

  test("server discovery uses actual config bytes and a fresh per-start process UUID", async () => {
    const source = await readFile(join(import.meta.dir, "server.ts"), "utf8");
    expect(source).toContain('sha256: createHash("sha256").update(bytes).digest("hex")');
    expect(source).toContain("const workerProcessInstanceId = randomUUID();");
    expect(source).toContain("activeConfigSha256: loaded.sha256");
    expect(source).toContain("workerProcessInstanceId");
  });

  test("recomputes the canonical A-layer manifest hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-m4f-manifest-"));
    roots.push(root);
    const body = {
      schema: "synthia-worker-release-manifest.v1",
      git_commit: "a".repeat(40),
      source_state: "dirty",
      git_status_sha256: "b".repeat(64),
      bundle: { path: "server.bundle.mjs", size_bytes: 1, sha256: "c".repeat(64) },
      runtime: { kind: "bun", version: "1.3.14", executable_name: "bun.exe", sha256: "d".repeat(64) },
      release_files: {
        config_template_sha256: "e".repeat(64),
        launcher_sha256: "f".repeat(64),
        windows_certifier_sha256: "1".repeat(64),
      },
      sources: [{ path: "connector/server.ts", sha256: "2".repeat(64) }],
      expected: {
        sdk_worker_build_hash: "c".repeat(64),
        protocol_version: "connector.remote.v1",
        capability_map_version: "vivado-test-1",
        part_catalog_hash: "3".repeat(64),
        toolchain_profile_hash: "4".repeat(64),
        vivado_version: "2021.1",
        vivado_patch: "3247384",
        part: "xc7k70tfbv676-1",
        capabilities: ["implement", "simulate", "synthesize", "validate_sources"].map((operation) => ({
          operation,
          version: "vivado-batch-1",
          run_classes: ["evolution_eval", "exploratory", "formal", "gate_check"],
        })),
      },
    };
    const path = join(root, "manifest.json");
    await writeFile(path, JSON.stringify({ ...body, manifest_hash: canonicalEvolutionEvalHash(body) }));
    expect(await verifyWorkerReleaseManifest(path)).toBe(canonicalEvolutionEvalHash(body));
    const emptyStatusHash = sha256("");
    const dirtyEmpty = { ...body, git_status_sha256: emptyStatusHash };
    await writeFile(path, JSON.stringify({ ...dirtyEmpty, manifest_hash: canonicalEvolutionEvalHash(dirtyEmpty) }));
    await expect(verifyWorkerReleaseManifest(path)).rejects.toThrow("RELEASE_MANIFEST_INVALID:shape");
    await writeFile(path, JSON.stringify({ ...body, git_status_sha256: "5".repeat(64), manifest_hash: canonicalEvolutionEvalHash(body) }));
    await expect(verifyWorkerReleaseManifest(path)).rejects.toThrow("RELEASE_MANIFEST_INVALID:canonical_hash");

    for (const expected of [
      { ...body.expected, capabilities: [] },
      {
        ...body.expected,
        capabilities: [{
          ...body.expected.capabilities[0]!,
          run_classes: [],
        }, ...body.expected.capabilities.slice(1)],
      },
      {
        ...body.expected,
        capabilities: [{
          ...body.expected.capabilities[0]!,
          operation: "invalid:operation",
        }, ...body.expected.capabilities.slice(1)],
      },
      { ...body.expected, capability_map_version: "" },
    ]) {
      const invalid = { ...body, expected };
      await writeFile(path, JSON.stringify({
        ...invalid,
        manifest_hash: canonicalEvolutionEvalHash(invalid),
      }));
      await expect(verifyWorkerReleaseManifest(path)).rejects.toThrow("RELEASE_MANIFEST_INVALID:");
    }
  });
});
