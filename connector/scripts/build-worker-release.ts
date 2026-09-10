import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalEvolutionEvalHash } from "../evolution-eval.ts";
import { VIVADO_CAPABILITIES } from "../vivado.ts";

const RELEASE_SCHEMA = "synthia-worker-release-manifest.v1" as const;
const HASH_RE = /^[0-9a-f]{64}$/;
const BUILD_CONTEXT_PATHS = [
  "bun.lock",
  "bunfig.toml",
  "package.json",
] as const;
const RELEASE_INPUT_PATHS = [
  "connector/worker-66.config.json",
  "connector/start-worker-66.cmd",
  "connector/scripts/certify-m4f-windows.ps1",
] as const;

export interface WorkerReleaseManifestV1 {
  readonly schema: typeof RELEASE_SCHEMA;
  readonly git_commit: string;
  readonly source_state: "clean" | "dirty";
  readonly git_status_sha256: string;
  readonly bundle: {
    readonly path: "server.bundle.mjs";
    readonly size_bytes: number;
    readonly sha256: string;
  };
  readonly runtime: {
    readonly kind: "bun";
    readonly version: "1.4.1";
    readonly executable_name: "bun.exe";
    readonly sha256: string;
  };
  readonly release_files: {
    readonly config_template_sha256: string;
    readonly launcher_sha256: string;
    readonly windows_certifier_sha256: string;
  };
  readonly sources: readonly { readonly path: string; readonly sha256: string }[];
  readonly expected: {
    readonly sdk_worker_build_hash: string;
    readonly protocol_version: "connector.remote.v1";
    readonly capability_map_version: string;
    readonly part_catalog_hash: string;
    readonly toolchain_profile_hash: string;
    readonly vivado_version: string;
    readonly vivado_patch: string;
    readonly part: string;
    readonly capabilities: readonly {
      readonly operation: string;
      readonly version: string;
      readonly run_classes: readonly string[];
    }[];
  };
  readonly manifest_hash: string;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileHash(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function commandBytes(cwd: string, executable: string, args: readonly string[]): Uint8Array {
  const result = spawnSync(executable, [...args], { cwd, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`RELEASE_COMMAND_FAILED:${basename(executable)}:${result.stderr.toString().trim() || result.error?.message || result.status}`);
  }
  return result.stdout;
}

function command(cwd: string, executable: string, args: readonly string[]): string {
  return Buffer.from(commandBytes(cwd, executable, args)).toString("utf8").trim();
}

function assertNoSecrets(text: string, name: string): void {
  const forbidden = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/,
    /CF-Access-Client-Secret\s*[:=]\s*["'][^<][^"']+/i,
    /["'](?:password|access_token|client_secret)["']\s*:\s*["'](?!<|REPLACE_)[^"']+/i,
    /SYNTHIA_WORKER_PFX_PASSWORD\s*=\s*(?![<%$])[^\s"']+/,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) throw new Error(`RELEASE_SECRET_SCAN_FAILED:${name}`);
}

function assertSafeBundle(text: string, forbiddenRoots: readonly string[]): void {
  assertNoSecrets(text, "bundle");
  const containsBuildRoot = forbiddenRoots.some((root) => {
    const forward = root.replaceAll("\\", "/");
    const backward = root.replaceAll("/", "\\");
    return text.includes(forward) || text.includes(backward);
  });
  if (containsBuildRoot
    || /\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(text)
    || /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+[\\/]/i.test(text)) {
    throw new Error("RELEASE_ABSOLUTE_PATH_SCAN_FAILED");
  }
  for (const marker of [
    "evolution-eval-ledger-metadata.v2",
    "evolution-eval-evidence-purged.v1",
    "physical_deleted",
    "validate_sources",
    "simulate",
    "synthesize",
    "implement",
  ]) {
    if (!text.includes(marker)) throw new Error(`RELEASE_BUNDLE_MARKER_MISSING:${marker}`);
  }
}

async function metafileInputs(path: string): Promise<string[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as { inputs?: Record<string, unknown> };
  if (!parsed.inputs || typeof parsed.inputs !== "object") throw new Error("RELEASE_METAFILE_INVALID");
  const inputs = Object.keys(parsed.inputs).sort();
  if (!inputs.length || inputs.some((path) => isAbsolute(path) || path === ".." || path.startsWith("../") || path.includes("\\"))) {
    throw new Error("RELEASE_METAFILE_INVALID");
  }
  return inputs;
}

async function hashes(root: string, paths: readonly string[]): Promise<Map<string, string>> {
  return new Map(await Promise.all(paths.map(async (path) => [path, await fileHash(join(root, path))] as const)));
}

function sameHashes(left: Map<string, string>, right: Map<string, string>): boolean {
  return left.size === right.size && [...left].every(([path, hash]) => right.get(path) === hash);
}

function parseArgs(args: readonly string[]): { output: string; allowDirty: boolean; allowNonWindows: boolean } {
  let output = "";
  let allowDirty = false;
  let allowNonWindows = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--output") output = args[++index] ?? "";
    else if (arg === "--allow-dirty") allowDirty = true;
    else if (arg === "--allow-non-windows") allowNonWindows = true;
    else throw new Error(`RELEASE_ARGUMENT_INVALID:${arg}`);
  }
  if (!output) throw new Error("RELEASE_OUTPUT_REQUIRED");
  return { output: resolve(output), allowDirty, allowNonWindows };
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(import.meta.dir, "../..");
  const args = parseArgs(process.argv.slice(2));
  const repositoryRelative = relative(repositoryRoot, args.output);
  if (args.output === parse(args.output).root
    || repositoryRelative === ""
    || (!repositoryRelative.startsWith("..") && !isAbsolute(repositoryRelative))) {
    throw new Error("RELEASE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  try {
    await stat(args.output);
    throw new Error("RELEASE_OUTPUT_ALREADY_EXISTS");
  } catch (error) {
    if (error instanceof Error && error.message === "RELEASE_OUTPUT_ALREADY_EXISTS") throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (process.platform !== "win32" && !args.allowNonWindows) throw new Error("RELEASE_WINDOWS_BUILD_REQUIRED");
  if (Bun.version !== "1.4.1") throw new Error(`RELEASE_BUN_VERSION_MISMATCH:${Bun.version}`);
  const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all"] as const;
  const initialGitStatus = commandBytes(repositoryRoot, "git", statusArgs);
  const sourceState = initialGitStatus.byteLength === 0 ? "clean" as const : "dirty" as const;
  if (sourceState === "dirty" && !args.allowDirty) throw new Error("RELEASE_GIT_DIRTY");
  const gitCommit = command(repositoryRoot, "git", ["rev-parse", "HEAD"]);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(gitCommit)) throw new Error("RELEASE_GIT_COMMIT_INVALID");

  const temporary = await mkdtemp(join(tmpdir(), "synthia-worker-release-"));
  try {
    const discoveryBundle = join(temporary, "discovery.bundle.mjs");
    const discoveryMetafile = join(temporary, "discovery.metafile.json");
    command(repositoryRoot, process.execPath, [
      "build",
      "connector/server.ts",
      "--target=node",
      `--outfile=${discoveryBundle}`,
      `--metafile=${discoveryMetafile}`,
    ]);
    const bundleInputs = await metafileInputs(discoveryMetafile);
    const sourcePaths = [...new Set([...bundleInputs, ...BUILD_CONTEXT_PATHS])].sort();
    const snapshotInputs = [...new Set([...sourcePaths, ...RELEASE_INPUT_PATHS])].sort();
    const liveBefore = await hashes(repositoryRoot, snapshotInputs);
    const snapshotRoot = join(temporary, "snapshot");
    for (const path of snapshotInputs) {
      const target = join(snapshotRoot, path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(repositoryRoot, path), target);
    }
    const liveAfterCopy = await hashes(repositoryRoot, snapshotInputs);
    const finalGitStatus = commandBytes(repositoryRoot, "git", statusArgs);
    if (!sameHashes(liveBefore, liveAfterCopy)
      || !Buffer.from(initialGitStatus).equals(Buffer.from(finalGitStatus))
      || command(repositoryRoot, "git", ["rev-parse", "HEAD"]) !== gitCommit) {
      throw new Error("RELEASE_SOURCE_CHANGED_DURING_SNAPSHOT");
    }

    const first = join(temporary, "server-1.bundle.mjs");
    const second = join(temporary, "server-2.bundle.mjs");
    const buildMetafiles = [join(temporary, "server-1.metafile.json"), join(temporary, "server-2.metafile.json")];
    for (const [index, output] of [first, second].entries()) {
      command(snapshotRoot, process.execPath, [
        "build",
        "connector/server.ts",
        "--target=node",
        `--outfile=${output}`,
        `--metafile=${buildMetafiles[index]}`,
      ]);
    }
    for (const path of buildMetafiles) {
      if (JSON.stringify(await metafileInputs(path)) !== JSON.stringify(bundleInputs)) {
        throw new Error("RELEASE_METAFILE_INPUT_DRIFT");
      }
    }
    const firstBytes = await readFile(first);
    const secondBytes = await readFile(second);
    if (!firstBytes.equals(secondBytes)) throw new Error("RELEASE_DOUBLE_BUILD_MISMATCH");
    assertSafeBundle(firstBytes.toString("utf8"), [repositoryRoot, snapshotRoot]);
    const bundleHash = sha256(firstBytes);

    await mkdir(args.output, { recursive: true });
    const bundlePath = join(args.output, "server.bundle.mjs");
    await writeFile(bundlePath, firstBytes, { mode: 0o600 });

    const sourceConfig = JSON.parse(await readFile(join(snapshotRoot, "connector/worker-66.config.json"), "utf8")) as Record<string, unknown>;
    const stagedConfig = {
      ...sourceConfig,
      sdk_worker_build_hash: bundleHash,
      evolution_eval_enabled: false,
      evolution_eval_ledger_mode: "reopen",
    };
    if (sourceConfig.protocol_version !== "connector.remote.v1") {
      throw new Error("RELEASE_PROTOCOL_VERSION_INVALID");
    }
    const protocolVersion = "connector.remote.v1" as const;
    const configPath = join(args.output, "worker-66.config.template.json");
    await writeFile(configPath, `${JSON.stringify(stagedConfig, null, 2)}\n`, { mode: 0o600 });
    await copyFile(join(snapshotRoot, "connector/start-worker-66.cmd"), join(args.output, "start-worker-66.cmd"));
    await copyFile(join(snapshotRoot, "connector/scripts/certify-m4f-windows.ps1"), join(args.output, "certify-m4f-windows.ps1"));

    const sources = await Promise.all(sourcePaths.map(async (path) => ({
      path,
      sha256: await fileHash(join(snapshotRoot, path)),
    })));
    const capabilities = VIVADO_CAPABILITIES.map((capability) => ({
      operation: capability.operation,
      version: capability.version,
      run_classes: [...capability.runClasses].sort(),
    })).sort((left, right) => left.operation < right.operation ? -1 : left.operation > right.operation ? 1 : 0);
    const body = {
      schema: RELEASE_SCHEMA,
      git_commit: gitCommit,
      source_state: sourceState,
      git_status_sha256: sha256(initialGitStatus),
      bundle: {
        path: "server.bundle.mjs" as const,
        size_bytes: (await stat(bundlePath)).size,
        sha256: bundleHash,
      },
      runtime: {
        kind: "bun" as const,
        version: "1.4.1" as const,
        executable_name: "bun.exe" as const,
        sha256: await fileHash(process.execPath),
      },
      release_files: {
        config_template_sha256: await fileHash(configPath),
        launcher_sha256: await fileHash(join(args.output, "start-worker-66.cmd")),
        windows_certifier_sha256: await fileHash(join(args.output, "certify-m4f-windows.ps1")),
      },
      sources,
      expected: {
        sdk_worker_build_hash: bundleHash,
        protocol_version: protocolVersion,
        capability_map_version: String(sourceConfig.capability_map_version),
        part_catalog_hash: String(sourceConfig.part_catalog_hash),
        toolchain_profile_hash: String(sourceConfig.toolchain_profile_hash),
        vivado_version: "2021.1",
        vivado_patch: "3247384",
        part: String(sourceConfig.vivado_part),
        capabilities,
      },
    };
    const manifest: WorkerReleaseManifestV1 = {
      ...body,
      manifest_hash: canonicalEvolutionEvalHash(body),
    };
    for (const hash of [
      manifest.bundle.sha256,
      manifest.runtime.sha256,
      manifest.release_files.config_template_sha256,
      manifest.release_files.launcher_sha256,
      manifest.release_files.windows_certifier_sha256,
      manifest.expected.part_catalog_hash,
      manifest.expected.toolchain_profile_hash,
      manifest.manifest_hash,
      ...manifest.sources.map((source) => source.sha256),
    ]) if (!HASH_RE.test(hash)) throw new Error("RELEASE_HASH_INVALID");
    if (manifest.expected.sdk_worker_build_hash !== manifest.bundle.sha256) throw new Error("RELEASE_BUILD_IDENTITY_INVALID");
    for (const path of [configPath, join(args.output, "start-worker-66.cmd"), join(args.output, "certify-m4f-windows.ps1")]) {
      assertNoSecrets(await readFile(path, "utf8"), basename(path));
    }
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    assertNoSecrets(manifestText, "worker-release.manifest.json");
    await writeFile(join(args.output, "worker-release.manifest.json"), manifestText, { mode: 0o600 });
    console.log(JSON.stringify({ output: args.output, bundle_sha256: bundleHash, manifest_hash: manifest.manifest_hash }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "RELEASE_BUILD_FAILED");
    process.exitCode = 1;
  });
}
