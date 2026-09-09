import { sha256Hex } from "../hashing.ts";

export const EVOLUTION_EVAL_OPERATIONS = [
  "validate_sources",
  "simulate",
  "synthesize",
  "implement",
] as const;
export type EvolutionEvalOperation = (typeof EVOLUTION_EVAL_OPERATIONS)[number];

export const EVOLUTION_EVAL_STABLE_STATES = [
  "submitted",
  "running",
  "rejected",
  "succeeded",
  "failed",
  "cancelled",
  "timeout",
  "unknown_effect",
] as const;
export type EvolutionEvalJobState = (typeof EVOLUTION_EVAL_STABLE_STATES)[number];

export type EvolutionEvalParametersV1 =
  | { readonly operation: "validate_sources"; readonly source_paths: readonly string[]; readonly top: string | null }
  | { readonly operation: "simulate"; readonly source_paths: readonly string[]; readonly top: string; readonly testbench: string }
  | { readonly operation: "synthesize"; readonly source_paths: readonly string[]; readonly top: string; readonly part: string }
  | {
      readonly operation: "implement";
      readonly source_paths: readonly string[];
      readonly constraint_paths: readonly string[];
      readonly top: string;
      readonly part: string;
      readonly generate_trial_bitstream: boolean;
    };

export interface EvolutionEvalWorkspaceManifestFileV1 {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly layer: "source" | "skill" | "overlay";
  readonly read_only: boolean;
}

export interface EvolutionEvalWorkspaceManifestV1 {
  readonly schema: "evolution-eval-workspace-manifest.v1";
  readonly workspace_id: string;
  readonly revision: number;
  readonly files: readonly EvolutionEvalWorkspaceManifestFileV1[];
}

export interface EvolutionEvalSealedInputProjectionV1 {
  readonly schema: "evolution-eval-sealed-input-projection.v1";
  readonly manifest: EvolutionEvalWorkspaceManifestV1;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly size_bytes: number;
    readonly media_type: string;
  }[];
}

export interface EvolutionEvalEvidenceManifestEntryV1 {
  readonly name: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: "application/json" | "text/plain" | "application/octet-stream";
  readonly artifact_classification: "experimental/evolution_eval" | "evolution_eval_evidence";
  readonly usage_classification: "evolution_eval_only";
}

export interface EvolutionEvalEvidenceManifestV1 {
  readonly schema: "evolution-eval-evidence-manifest.v1";
  readonly eval_job_id: string;
  readonly tool_run_id: string;
  readonly entries: readonly EvolutionEvalEvidenceManifestEntryV1[];
}

export const EVOLUTION_EVAL_LIMITS = Object.freeze({
  source: Object.freeze({ files: 4096, bytes: 512 * 1024 * 1024, fileBytes: 4 * 1024 * 1024 }),
  skill: Object.freeze({ files: 512, bytes: 32 * 1024 * 1024, fileBytes: 1024 * 1024 }),
  overlay: Object.freeze({ files: 512, bytes: 32 * 1024 * 1024, fileBytes: 1024 * 1024 }),
  workspace: Object.freeze({ files: 5120, bytes: 576 * 1024 * 1024 }),
  write: Object.freeze({ changes: 32, bytes: 8 * 1024 * 1024 }),
  read: Object.freeze({ paths: 32, bytes: 8 * 1024 * 1024 }),
  evidence: Object.freeze({ entries: 128, entryBytes: 64 * 1024 * 1024, bytes: 256 * 1024 * 1024 }),
  connectorUnackedSpoolBytes: 2 * 1024 * 1024 * 1024,
  jobsPerRun: 3,
  runBudgetMs: 2 * 60 * 60 * 1000,
  operationCapMs: 2 * 60 * 60 * 1000,
});

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,127}$/;
const PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EVIDENCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const PORTABLE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WINDOWS_DEVICE_PATH_SEGMENT_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const VIVADO_MEDIA_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ".v": "text/x-verilog",
  ".vh": "text/x-verilog",
  ".sv": "text/x-systemverilog",
  ".svh": "text/x-systemverilog",
  ".xdc": "application/x-xdc",
});

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** RFC 8785 requires valid Unicode and does not silently normalize inputs. */
export function requireNfcString(value: string, label = "string"): string {
  if (hasLoneSurrogate(value)) throw new TypeError(`${label} contains invalid Unicode`);
  if (value.normalize("NFC") !== value) throw new TypeError(`${label} must be NFC normalized`);
  return value;
}

/**
 * RFC 8785 JSON Canonicalization Scheme for JSON-domain values.
 *
 * Number and string serialization deliberately use ECMAScript JSON.stringify,
 * while object properties are ordered by UTF-16 code units as JCS requires.
 */
export function evolutionEvalCanonicalJson(value: unknown): string {
  const encode = (item: unknown, path: string): string => {
    if (item === null) return "null";
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "string") return JSON.stringify(requireNfcString(item, path));
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError(`${path} must be a finite JSON number`);
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      const entries: string[] = [];
      for (let index = 0; index < item.length; index += 1) {
        if (!(index in item)) throw new TypeError(`${path} must not contain array holes`);
        entries.push(encode(item[index], `${path}[${index}]`));
      }
      return `[${entries.join(",")}]`;
    }
    if (typeof item === "object") {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${path} must be a plain JSON object`);
      }
      const object = item as Record<string, unknown>;
      const keys = Object.keys(object);
      for (const key of keys) requireNfcString(key, `${path} key`);
      keys.sort();
      return `{${keys.map((key) => {
        const member = object[key];
        if (member === undefined || typeof member === "function" || typeof member === "symbol" || typeof member === "bigint") {
          throw new TypeError(`${path}.${key} is not a JSON value`);
        }
        return `${JSON.stringify(key)}:${encode(member, `${path}.${key}`)}`;
      }).join(",")}}`;
    }
    throw new TypeError(`${path} is not a JSON value`);
  };
  return encode(value, "$input");
}

export function evolutionEvalCanonicalHash(value: unknown): string {
  return sha256Hex(evolutionEvalCanonicalJson(value));
}

export function portableEvolutionEvalPath(path: string): string {
  requireNfcString(path, "path");
  if (
    path.length === 0
    || Buffer.byteLength(path, "utf8") > 512
    || !/^[\x00-\x7f]+$/.test(path)
  ) {
    throw new TypeError("path is not a portable workspace-relative POSIX path");
  }
  const segments = path.split("/");
  if (
    segments.length > 32
    || segments.some((segment) => (
      !PORTABLE_PATH_SEGMENT_PATTERN.test(segment)
      || segment.endsWith(".")
      || WINDOWS_DEVICE_PATH_SEGMENT_PATTERN.test(segment)
    ))
  ) {
    throw new TypeError("path is not a portable workspace-relative POSIX path");
  }
  return path;
}

export function portablePathKey(path: string): string {
  return portableEvolutionEvalPath(path).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function vivadoMediaTypeForPath(path: string): string {
  const canonical = portableEvolutionEvalPath(path);
  const dot = canonical.lastIndexOf(".");
  const mediaType = VIVADO_MEDIA_BY_EXTENSION[dot < 0 ? "" : canonical.slice(dot).toLowerCase()];
  if (!mediaType) throw new TypeError("Vivado input path has a forbidden extension");
  return mediaType;
}

function requireUniquePortablePaths(paths: readonly string[], min: number, max: number, label: string): string[] {
  if (paths.length < min || paths.length > max) {
    throw new TypeError(`${label} must contain ${min}–${max} paths`);
  }
  const normalized = paths.map(portableEvolutionEvalPath);
  const keys = normalized.map(portablePathKey);
  if (new Set(keys).size !== keys.length) throw new TypeError(`${label} paths must be portable-unique`);
  return normalized;
}

function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
  const actual = (ownKeys as string[]).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new TypeError(`${label} must contain exactly: ${canonical.join(", ")}`);
  }
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of strings`);
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || typeof value[index] !== "string") {
      throw new TypeError(`${label} must be an array of strings`);
    }
    result.push(value[index]);
  }
  return result;
}

export function validateEvolutionEvalParameters(
  operation: EvolutionEvalOperation,
  parameters: unknown,
): EvolutionEvalParametersV1 {
  if (!EVOLUTION_EVAL_OPERATIONS.includes(operation)) {
    throw new TypeError("operation and parameters.operation must match the evolution-eval allowlist");
  }
  const record = requirePlainRecord(parameters, "parameters");
  const keysByOperation: Readonly<Record<EvolutionEvalOperation, readonly string[]>> = {
    validate_sources: ["operation", "source_paths", "top"],
    simulate: ["operation", "source_paths", "testbench", "top"],
    synthesize: ["operation", "part", "source_paths", "top"],
    implement: [
      "constraint_paths",
      "generate_trial_bitstream",
      "operation",
      "part",
      "source_paths",
      "top",
    ],
  };
  requireExactKeys(record, keysByOperation[operation], "parameters");
  if (typeof record.operation !== "string" || record.operation !== operation) {
    throw new TypeError("operation and parameters.operation must match the evolution-eval allowlist");
  }
  const sourcePaths = requireStringArray(record.source_paths, "source_paths");
  requireUniquePortablePaths(sourcePaths, 1, 512, "source_paths");
  for (const path of sourcePaths) vivadoMediaTypeForPath(path);
  if (
    (operation === "validate_sources" && record.top !== null && typeof record.top !== "string")
    || (operation !== "validate_sources" && typeof record.top !== "string")
    || (typeof record.top === "string" && !IDENTIFIER_PATTERN.test(record.top))
  ) {
    throw new TypeError("top is not a valid HDL identifier");
  }
  if (operation === "simulate") {
    if (typeof record.testbench !== "string" || !IDENTIFIER_PATTERN.test(record.testbench)) {
      throw new TypeError("testbench is not a valid HDL identifier");
    }
  }
  if (operation === "synthesize" || operation === "implement") {
    if (typeof record.part !== "string" || !PART_PATTERN.test(record.part)) {
      throw new TypeError("part is not canonical");
    }
  }
  if (operation === "implement") {
    const constraintPaths = requireStringArray(record.constraint_paths, "constraint_paths");
    requireUniquePortablePaths(constraintPaths, 0, 128, "constraint_paths");
    for (const path of constraintPaths) {
      if (vivadoMediaTypeForPath(path) !== "application/x-xdc") {
        throw new TypeError("constraint_paths may contain only .xdc files");
      }
    }
    if (typeof record.generate_trial_bitstream !== "boolean") {
      throw new TypeError("generate_trial_bitstream must be a boolean");
    }
  }
  return record as unknown as EvolutionEvalParametersV1;
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function canonicalEvolutionEvalWorkspaceManifest(
  manifest: EvolutionEvalWorkspaceManifestV1,
): { readonly manifest: EvolutionEvalWorkspaceManifestV1; readonly canonical: string; readonly sha256: string } {
  if (manifest.schema !== "evolution-eval-workspace-manifest.v1") throw new TypeError("workspace manifest schema is invalid");
  if (!Number.isSafeInteger(manifest.revision) || manifest.revision < 1) throw new TypeError("workspace revision is invalid");
  requireNfcString(manifest.workspace_id, "workspace_id");
  const files = manifest.files.map((file) => {
    portableEvolutionEvalPath(file.path);
    requireNfcString(file.media_type, "media_type");
    if (!HASH_PATTERN.test(file.sha256)) throw new TypeError("workspace file hash is invalid");
    if (!Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0) throw new TypeError("workspace file size is invalid");
    if ((file.layer === "overlay") === file.read_only) throw new TypeError("workspace layer/read_only mismatch");
    return { ...file };
  }).sort((left, right) => bytewise(portablePathKey(left.path), portablePathKey(right.path)));
  const keys = files.map((file) => portablePathKey(file.path));
  if (new Set(keys).size !== keys.length) throw new TypeError("workspace paths collide portably");
  const sorted = { ...manifest, files } satisfies EvolutionEvalWorkspaceManifestV1;
  const canonical = evolutionEvalCanonicalJson(sorted);
  return { manifest: sorted, canonical, sha256: sha256Hex(canonical) };
}

/**
 * Canonical Connector-visible projection. The full workspace manifest remains
 * Core-authoritative and may bind Skill assets, while this JCS preimage can
 * contain only source/overlay metadata in the same canonical path order.
 */
export function canonicalEvolutionEvalSealedInputProjection(
  fullManifest: EvolutionEvalWorkspaceManifestV1,
): {
  readonly projection: EvolutionEvalSealedInputProjectionV1;
  readonly canonical: string;
  readonly sha256: string;
} {
  const canonicalWorkspace = canonicalEvolutionEvalWorkspaceManifest(fullManifest);
  const projectedManifest = canonicalEvolutionEvalWorkspaceManifest({
    ...canonicalWorkspace.manifest,
    files: canonicalWorkspace.manifest.files.filter((file) => file.layer !== "skill"),
  }).manifest;
  const projection: EvolutionEvalSealedInputProjectionV1 = {
    schema: "evolution-eval-sealed-input-projection.v1",
    manifest: projectedManifest,
    files: projectedManifest.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size_bytes: file.size_bytes,
      media_type: file.media_type,
    })),
  };
  const canonical = evolutionEvalCanonicalJson(projection);
  return { projection, canonical, sha256: sha256Hex(canonical) };
}

export function canonicalEvolutionEvalEvidenceManifest(
  input: unknown,
): { readonly manifest: EvolutionEvalEvidenceManifestV1; readonly canonical: string; readonly sha256: string } {
  const manifest = requirePlainRecord(input, "evidence manifest");
  requireExactKeys(
    manifest,
    ["schema", "eval_job_id", "tool_run_id", "entries"],
    "evidence manifest",
  );
  if (manifest.schema !== "evolution-eval-evidence-manifest.v1") {
    throw new TypeError("evidence manifest schema is invalid");
  }
  for (const field of ["eval_job_id", "tool_run_id"] as const) {
    const value = manifest[field];
    if (
      typeof value !== "string"
      || Buffer.byteLength(value, "utf8") < 1
      || Buffer.byteLength(value, "utf8") > 128
      || /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new TypeError(`evidence manifest ${field} is invalid`);
    }
    requireNfcString(value, `evidence manifest ${field}`);
  }
  if (!Array.isArray(manifest.entries)) throw new TypeError("evidence entries must be an array");
  if (manifest.entries.length > EVOLUTION_EVAL_LIMITS.evidence.entries) throw new TypeError("evidence entry limit exceeded");
  let totalBytes = 0;
  const entries = manifest.entries.map((raw, index) => {
    const entry = requirePlainRecord(raw, `evidence entry ${index}`);
    requireExactKeys(
      entry,
      [
        "name",
        "sha256",
        "size_bytes",
        "media_type",
        "artifact_classification",
        "usage_classification",
      ],
      `evidence entry ${index}`,
    );
    if (typeof entry.name !== "string") throw new TypeError("evidence name is invalid");
    requireNfcString(entry.name, "evidence name");
    if (
      !EVIDENCE_NAME_PATTERN.test(entry.name)
      || typeof entry.sha256 !== "string"
      || !HASH_PATTERN.test(entry.sha256)
    ) throw new TypeError("evidence entry is invalid");
    if (!Number.isSafeInteger(entry.size_bytes) || Number(entry.size_bytes) < 0 || Number(entry.size_bytes) > EVOLUTION_EVAL_LIMITS.evidence.entryBytes) {
      throw new TypeError("evidence entry size limit exceeded");
    }
    totalBytes += Number(entry.size_bytes);
    if (![
      "application/json",
      "text/plain",
      "application/octet-stream",
    ].includes(String(entry.media_type))) {
      throw new TypeError("evidence media type is invalid");
    }
    const lower = entry.name.toLowerCase();
    if (lower.endsWith(".bit")) {
      if (entry.media_type !== "application/octet-stream" || entry.artifact_classification !== "experimental/evolution_eval") {
        throw new TypeError("bitstream evidence classification is invalid");
      }
    } else if (entry.artifact_classification !== "evolution_eval_evidence") {
      throw new TypeError("non-bitstream evidence classification is invalid");
    }
    if (entry.usage_classification !== "evolution_eval_only") throw new TypeError("evidence usage classification is invalid");
    if (lower.endsWith(".json") && entry.media_type !== "application/json") throw new TypeError("JSON evidence media type is invalid");
    if (/\.(rpt|log|tcl)$/u.test(lower) && entry.media_type !== "text/plain") throw new TypeError("text evidence media type is invalid");
    if (/\.(bit|dcp)$/u.test(lower) && entry.media_type !== "application/octet-stream") throw new TypeError("binary evidence media type is invalid");
    return {
      name: entry.name,
      sha256: entry.sha256,
      size_bytes: Number(entry.size_bytes),
      media_type: entry.media_type,
      artifact_classification: entry.artifact_classification,
      usage_classification: entry.usage_classification,
    } as EvolutionEvalEvidenceManifestEntryV1;
  }).sort((left, right) => bytewise(left.name, right.name));
  if (totalBytes > EVOLUTION_EVAL_LIMITS.evidence.bytes) throw new TypeError("evidence manifest byte limit exceeded");
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) throw new TypeError("evidence names must be unique");
  const sorted: EvolutionEvalEvidenceManifestV1 = {
    schema: "evolution-eval-evidence-manifest.v1",
    eval_job_id: manifest.eval_job_id as string,
    tool_run_id: manifest.tool_run_id as string,
    entries,
  };
  const canonical = evolutionEvalCanonicalJson(sorted);
  return { manifest: sorted, canonical, sha256: sha256Hex(canonical) };
}
