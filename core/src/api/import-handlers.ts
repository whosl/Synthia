/**
 * P2 historical-material import handlers.
 *
 * Imports are intentionally a normalized manifest (`files[]`) rather than a
 * server-side path or an opaque archive.  This keeps the API deterministic and
 * lets Core validate every byte before it is committed.  A project source may
 * omit `files` and name an immutable workspace commit; Core then reads that git
 * tree through the existing workspace reader.  Raw ZIP bytes and arbitrary
 * server paths are rejected fail-closed.
 */

import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { TransactionClient } from "../db/repository.ts";
import {
  appendOutboxEventInTx,
  createRevision,
  type OutboxEventInput,
} from "../db/repository.ts";
import { sha256Hex } from "../hashing.ts";
import {
  isArtifactType,
  type ActorType,
  type ArtifactType,
  type DataClassification,
} from "../domain/enums.ts";
import { readTreeAt } from "../workspace/store.ts";
import { headSha, isRepo, listTreeEntries, type GitTreeEntry } from "../workspace/git.ts";
import { projectWorkspaceDir } from "../workspace/paths.ts";
import {
  asObject,
  asClient,
  runIdempotent,
  type HandlerResult,
  type RequestContext,
} from "./handlers.ts";
import {
  ApiError,
  capabilityUnavailableError,
  conflictApiError,
  forbiddenError,
  notFoundError,
  validationError,
} from "./errors.ts";

const MAX_IMPORT_FILES = 500;
const MAX_IMPORT_FILE_BYTES = 1024 * 1024;
const MAX_IMPORT_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_UNCOMPRESSED_BYTES = MAX_IMPORT_TOTAL_BYTES;
const MAX_ZIP_ENTRIES = MAX_IMPORT_FILES;
const MAX_PATH_BYTES = 512;
const MAX_NAME_BYTES = 256;

export const IMPORT_SNAPSHOT_LIMITS = Object.freeze({
  maxFiles: MAX_IMPORT_FILES,
  maxFileBytes: MAX_IMPORT_FILE_BYTES,
  maxTotalBytes: MAX_IMPORT_TOTAL_BYTES,
});

function requireHistoricalMaterialsWriteEnabled(ctx: RequestContext): void {
  if (ctx.featureFlags?.historicalMaterials !== true) {
    throw capabilityUnavailableError("historical materials write capability is disabled", {
      feature: "historical_materials",
    });
  }
}

type SourceKind = "project" | "local_directory" | "zip";
type SnapshotStatus = "pending_confirmation" | "confirmed" | "denied" | "failed" | "expired";

interface NormalizedFile {
  readonly id: string;
  readonly path: string;
  readonly bytes: Buffer;
  readonly contentText: string | null;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly valid: boolean;
}

interface SourceManifest {
  readonly sourceKind: SourceKind;
  readonly sourceProjectId: string | null;
  readonly sourceName: string;
  readonly sourceLocator: string | null;
  readonly sourceCommit: string | null;
  readonly sourceHash: string;
  readonly files: readonly NormalizedFile[];
}

interface SnapshotRow {
  readonly id: string;
  readonly project_id: string;
  readonly status: SnapshotStatus;
  readonly source_kind: SourceKind;
  readonly source_project_id: string | null;
  readonly source_name: string;
  readonly source_locator: string | null;
  readonly source_commit: string | null;
  readonly source_hash: string;
  readonly expires_at: Date | string | null;
  readonly created_by_type: string;
  readonly created_by: string;
  readonly confirmed_by: string | null;
  readonly confirmed_at: Date | string | null;
  readonly denial_reason: string | null;
  readonly denied_at?: Date | string | null;
  readonly failure_reason?: string | null;
  readonly created_at: Date | string;
}

function requireStringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`field '${key}' must be a non-empty string`);
  }
  return value.trim();
}

function validateBoundedName(value: string, key: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_NAME_BYTES) {
    throw validationError(`field '${key}' is too long`);
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw validationError(`field '${key}' contains a control or line-separator character`);
  }
  return value;
}

function optionalStringField(body: Record<string, unknown>, key: string, fallback: string | null = null): string | null {
  const value = body[key];
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw validationError(`field '${key}' must be a string`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

function optionalIntegerField(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw validationError(`field '${key}' must be a non-negative integer`);
  }
  return value;
}

function validateIdentifier(value: string, key: string): string {
  if (value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw validationError(`field '${key}' contains an invalid identifier`);
  }
  return value;
}

function validateSourceKind(body: Record<string, unknown>): SourceKind {
  const value = body.source_kind ?? body.source_type;
  if (value !== "project" && value !== "local_directory" && value !== "zip") {
    throw validationError("field 'source_kind' must be one of: project, local_directory, zip");
  }
  return value;
}

/** Normalize a source path independently of the stricter workspace layout. */
export function normalizeImportPath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) {
    throw validationError("import file path must be a non-empty string");
  }
  if (Buffer.byteLength(input, "utf8") > MAX_PATH_BYTES || input.includes("\0") || input.includes("\\")) {
    throw validationError("import file path is invalid");
  }
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input) || input.startsWith("//")) {
    throw validationError("import file path must be relative");
  }
  const withoutDot = input.startsWith("./") ? input.slice(2) : input;
  const parts = withoutDot.split("/");
  if (parts.length === 0 || parts.length > 32 || parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw validationError("import file path contains a traversal or empty segment", { path: input });
  }
  if (parts.some((part) => [...part].some((char) => char.charCodeAt(0) < 0x20 || char === "\u007f"))) {
    throw validationError("import file path contains a control character", { path: input });
  }
  return parts.join("/");
}

/** Sensitive material is rejected rather than silently becoming searchable. */
export function isSensitiveImportPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|known_hosts)$/.test(base)) return true;
  if (/(?:secret|credential|password|private[_-]?key|access[_-]?token)/i.test(base)) return true;
  return /\.(?:key|pem|crt|cer|der|p12|pfx|jks|keystore|kdb|kdbx)$/i.test(base);
}

function isIgnoredImportPath(path: string, sizeBytes: number): boolean {
  const parts = path.toLowerCase().split("/");
  const ignoredDirectories = new Set([".git", ".runs", ".edagent", "node_modules", "__pycache__", ".cache", "coverage", "dist", "build", "out", "target"]);
  if (parts.some((part) => ignoredDirectories.has(part))) return true;
  const base = parts[parts.length - 1] ?? "";
  if (/\.(?:o|obj|a|so|d|jou|str|tmp|swp|pyc)$/.test(base)) return true;
  // Ordinary large logs are not useful reference material. Small reports/logs
  // remain importable and can be explicitly reviewed by the user.
  if (/\.(?:log|rpt|report)$/i.test(base) && sizeBytes > 1024 * 1024) return true;
  return false;
}

function isSimulationOutputPath(path: string): boolean {
  return path.toLowerCase() === "sim" || path.toLowerCase().startsWith("sim/");
}

/** Workspace scaffolding is committed but is not importable project content. */
function isWorkspacePlaceholderPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === ".gitignore" || lower === ".gitkeep" || lower.endsWith("/.gitkeep");
}

/** Fail before reading Git blobs when a fixed source tree exceeds P2 limits. */
export function preflightProjectTree(entries: readonly GitTreeEntry[]): void {
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    if (isWorkspacePlaceholderPath(entry.path)) continue;
    const path = normalizeImportPath(entry.path);
    if (isSimulationOutputPath(path)) {
      throw validationError("source project commit contains simulation output", { path });
    }
    if (isSensitiveImportPath(path)) {
      throw validationError("source project commit contains a sensitive file", { path });
    }
    if (entry.objectType !== "blob" || entry.sizeBytes === null) {
      throw validationError("source project commit contains an unsupported tree entry", { path });
    }
    fileCount += 1;
    if (fileCount > MAX_IMPORT_FILES) {
      throw validationError(`source project commit exceeds ${MAX_IMPORT_FILES} files`);
    }
    if (entry.sizeBytes > MAX_IMPORT_FILE_BYTES) {
      throw validationError(`source project file exceeds ${MAX_IMPORT_FILE_BYTES} bytes`, { path });
    }
    totalBytes += entry.sizeBytes;
    if (totalBytes > MAX_IMPORT_TOTAL_BYTES) {
      throw validationError(`source project commit exceeds ${MAX_IMPORT_TOTAL_BYTES} total bytes`);
    }
  }
}

function inferMediaType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".v") || lower.endsWith(".sv") || lower.endsWith(".vh") || lower.endsWith(".svh")) return "text/x-verilog";
  if (lower.endsWith(".vhd") || lower.endsWith(".vhdl")) return "text/x-vhdl";
  if (lower.endsWith(".xdc")) return "text/x-xdc";
  if (lower.endsWith(".tcl")) return "text/x-tcl";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "text/plain";
}

export function normalizeProvidedFiles(value: unknown, snapshotId: string): NormalizedFile[] {
  if (!Array.isArray(value)) throw validationError("field 'files' must be an array");
  if (value.length === 0) throw validationError("field 'files' must contain at least one file");
  if (value.length > MAX_IMPORT_FILES) throw validationError(`field 'files' exceeds ${MAX_IMPORT_FILES} entries`);

  const seenPaths = new Set<string>();
  const result: NormalizedFile[] = [];
  let totalBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw validationError(`files[${index}] must be an object`);
    }
    const object = raw as Record<string, unknown>;
    if (object.id !== undefined || object.file_id !== undefined) {
      throw validationError(`files[${index}] id is server-generated and must not be supplied`);
    }
    const path = normalizeImportPath(object.path);
    if (isSensitiveImportPath(path)) throw validationError("sensitive import file is not allowed", { path });
    if (isSimulationOutputPath(path)) throw validationError("simulation output paths are not importable reference material", { path });
    if (object.valid !== undefined && object.valid !== true) {
      throw validationError("import file entries must be valid", { path });
    }

    if (object.content_base64 !== undefined || object.bytes !== undefined || object.archive_bytes !== undefined) {
      throw validationError(`files[${index}] must use parsed UTF-8 string content; binary/base64 payloads are not supported`);
    }
    if (typeof object.content !== "string") throw validationError(`files[${index}].content must be a UTF-8 string`);
    const bytes = Buffer.from(object.content, "utf8");
    if (bytes.byteLength > MAX_IMPORT_FILE_BYTES) {
      throw validationError(`files[${index}] exceeds ${MAX_IMPORT_FILE_BYTES} bytes`, { path });
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_IMPORT_TOTAL_BYTES) throw validationError(`import exceeds ${MAX_IMPORT_TOTAL_BYTES} total bytes`);
    if (isIgnoredImportPath(path, bytes.byteLength)) continue;
    if (seenPaths.has(path)) throw validationError("duplicate import file path", { path });
    seenPaths.add(path);

    const requestedId = `${snapshotId}_file_${index + 1}`;
    const contentText = object.content;
    const expectedHash = sha256Hex(bytes);
    if (object.content_hash !== undefined && object.content_hash !== null) {
      if (typeof object.content_hash !== "string" || object.content_hash !== expectedHash) {
        throw validationError("content_hash does not match imported bytes", { path, expected: expectedHash });
      }
    }
    const mediaType = object.media_type === undefined || object.media_type === null
      ? inferMediaType(path)
      : (() => {
        if (typeof object.media_type !== "string" || object.media_type.trim().length === 0 || object.media_type.length > 128) {
          throw validationError(`files[${index}].media_type must be a non-empty string`);
        }
        return object.media_type.trim();
      })();
    result.push({
      id: requestedId,
      path,
      bytes,
      contentText,
      contentHash: expectedHash,
      sizeBytes: bytes.byteLength,
      mediaType,
      valid: true,
    });
  }
  if (result.length === 0) throw validationError("import contains no usable files");
  return result;
}

export function canonicalSourceHash(files: readonly { readonly path: string; readonly contentHash: string }[]): string {
  return sha256Hex([...files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.path}:${file.contentHash}`).join("\n"));
}

function validateArchiveMetadata(body: Record<string, unknown>, fileCount: number, totalBytes: number): void {
  const archiveBytes = optionalIntegerField(body, "archive_size_bytes");
  const uncompressedBytes = optionalIntegerField(body, "uncompressed_size_bytes");
  const archiveEntries = optionalIntegerField(body, "archive_entry_count");
  if (archiveBytes !== null && archiveBytes > MAX_ZIP_BYTES) throw validationError("ZIP archive exceeds compressed-size limit");
  if (uncompressedBytes !== null && uncompressedBytes > MAX_ZIP_UNCOMPRESSED_BYTES) throw validationError("ZIP archive exceeds uncompressed-size limit");
  if (archiveEntries !== null && archiveEntries > MAX_ZIP_ENTRIES) throw validationError("ZIP archive contains too many entries");
  if (archiveBytes !== null && archiveBytes > 0 && uncompressedBytes !== null && uncompressedBytes / archiveBytes > 100) {
    throw validationError("ZIP compression ratio exceeds safety limit");
  }
  if (fileCount > MAX_ZIP_ENTRIES || totalBytes > MAX_ZIP_UNCOMPRESSED_BYTES) throw validationError("ZIP manifest exceeds safety limits");
  for (const key of ["archive", "archive_base64", "zip_base64", "archive_bytes"]) {
    if (body[key] !== undefined && body[key] !== null) {
      throw validationError("raw ZIP bytes are not accepted; submit a normalized files manifest");
    }
  }
}

async function requireTargetProjectAccess(
  ctx: RequestContext,
  tx: TransactionClient,
  projectId: string,
): Promise<{ project_type: string; status: string; data_classification: DataClassification }> {
  const result = await tx.query("SELECT project_type, status, data_classification FROM project WHERE id = $1", [projectId]);
  const row = result.rows[0] as { project_type?: string; status?: string; data_classification?: string } | undefined;
  if (!row) throw notFoundError(`project not found: ${projectId}`);
  if (!ctx.identity.scopes.includes("core:admin")) {
    const access = await tx.query(
      `SELECT 1 FROM role_assignment
        WHERE project_id = $1 AND actor_type = $2 AND actor_id = $3
        LIMIT 1`,
      [projectId, ctx.identity.actorType, ctx.identity.actorId],
    );
    if (access.rows.length === 0) throw notFoundError(`project not found: ${projectId}`);
  }
  if (!row.data_classification || !["D1", "D2", "D3", "D4", "UNCLASSIFIED"].includes(row.data_classification)) {
    throw conflictApiError("PROJECT_DATA_CLASSIFICATION_INVALID", { projectId });
  }
  return {
    project_type: row.project_type ?? "",
    status: row.status ?? "",
    data_classification: row.data_classification as DataClassification,
  };
}

async function requireEngineeringTarget(ctx: RequestContext, tx: TransactionClient, projectId: string): Promise<DataClassification> {
  const row = await requireTargetProjectAccess(ctx, tx, projectId);
  if (row.status !== "active") throw conflictApiError("PROJECT_NOT_ACTIVE", { projectId });
  if (row.project_type !== "engineering") throw conflictApiError("IMPORT_REQUIRES_ENGINEERING_PROJECT", { projectId });
  return row.data_classification;
}

async function requireSourceProject(
  ctx: RequestContext,
  tx: TransactionClient,
  targetProjectId: string,
  sourceProjectId: string,
): Promise<void> {
  if (sourceProjectId === targetProjectId) throw validationError("source_project_id must differ from target project");
  const result = await tx.query("SELECT id, status, data_classification FROM project WHERE id = $1", [sourceProjectId]);
  const row = result.rows[0] as { id?: string; status?: string; data_classification?: string } | undefined;
  if (!row) throw notFoundError(`source project not found: ${sourceProjectId}`);
  if (!ctx.identity.scopes.includes("core:admin")) {
    const access = await tx.query(
      `SELECT 1 FROM role_assignment
        WHERE project_id = $1 AND actor_type = $2 AND actor_id = $3
        LIMIT 1`,
      [sourceProjectId, ctx.identity.actorType, ctx.identity.actorId],
    );
    if (access.rows.length === 0) {
      // Deliberately use 404 so a caller without source access cannot probe
      // whether another project exists.
      throw notFoundError(`source project not found: ${sourceProjectId}`);
    }
  }
  // Check mutable source state only after access has been established.  A
  // caller without a source role must not distinguish inactive from missing.
  if (row.status !== "active") throw conflictApiError("SOURCE_PROJECT_NOT_ACTIVE", { sourceProjectId });
  const targetResult = await tx.query("SELECT data_classification FROM project WHERE id = $1", [targetProjectId]);
  const target = targetResult.rows[0] as { data_classification?: string } | undefined;
  const classificationRank: Record<string, number> = { UNCLASSIFIED: 0, D1: 1, D2: 2, D3: 3, D4: 4 };
  const sourceRank = row.data_classification ? classificationRank[row.data_classification] : undefined;
  const targetRank = target?.data_classification ? classificationRank[target.data_classification] : undefined;
  if (sourceRank === undefined || targetRank === undefined) {
    throw conflictApiError("PROJECT_DATA_CLASSIFICATION_INVALID", { sourceProjectId, targetProjectId });
  }
  if (sourceRank > targetRank) {
    throw forbiddenError("SOURCE_CLASSIFICATION_EXCEEDS_TARGET", {
      sourceProjectId,
      sourceClassification: row.data_classification,
      targetProjectId,
      targetClassification: target?.data_classification,
    });
  }
}

async function requireImportSourceAccess(
  ctx: RequestContext,
  tx: TransactionClient,
  body: Record<string, unknown>,
): Promise<{ sourceKind: SourceKind; sourceProjectId: string | null }> {
  const sourceKind = validateSourceKind(body);
  const sourceProjectId = optionalStringField(body, "source_project_id");
  if (sourceKind === "project") {
    if (!sourceProjectId) throw validationError("project imports require source_project_id");
    await requireSourceProject(ctx, tx, ctx.params.projectId!, sourceProjectId);
  } else if (sourceProjectId) {
    throw validationError("source_project_id is only valid for project imports");
  }
  return { sourceKind, sourceProjectId };
}

async function loadSourceManifest(
  ctx: RequestContext,
  tx: TransactionClient,
  body: Record<string, unknown>,
  snapshotId: string,
): Promise<SourceManifest> {
  const { sourceKind, sourceProjectId } = await requireImportSourceAccess(ctx, tx, body);

  const suppliedFiles = body.files ?? body.entries;
  let files: NormalizedFile[];
  let sourceCommit = optionalStringField(body, "commit") ?? optionalStringField(body, "source_commit");
  if (sourceKind === "project") {
    if (!sourceProjectId) throw validationError("project imports require source_project_id");
    if (sourceCommit !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sourceCommit)) {
      throw validationError("source_commit must be a 40 or 64 character git object hash");
    }
    try {
      const dir = projectWorkspaceDir(sourceProjectId);
      if (!(await isRepo(dir))) throw new Error("source workspace is not a git repository");
      sourceCommit = sourceCommit ?? await headSha(dir);
      if (!sourceCommit) throw new Error("source workspace has no commit");
      // Every normal workspace commit contains placeholders such as
      // `sim/.gitkeep`; preflight excludes those but rejects meaningful sim
      // output and oversized trees before `readTreeAt` materializes blobs.
      preflightProjectTree(await listTreeEntries(dir, sourceCommit));
      const tree = await readTreeAt(sourceProjectId, sourceCommit);
      const unsupportedBinary = tree.files.filter((file) => file.encoding === "base64").map((file) => file.path);
      if (unsupportedBinary.length > 0) {
        throw validationError("source project commit contains unsupported binary reference files", { paths: unsupportedBinary });
      }
      const generated = tree.files.map((file) => ({
        path: file.path,
        content: file.content!,
      }));
      const workspaceFiles = normalizeProvidedFiles(generated, snapshotId);
      if (suppliedFiles !== undefined && suppliedFiles !== null) {
        const requestedFiles = normalizeProvidedFiles(suppliedFiles, snapshotId);
        const workspaceHash = canonicalSourceHash(workspaceFiles);
        const requestedHash = canonicalSourceHash(requestedFiles);
        if (requestedHash !== workspaceHash) {
          throw validationError("project import files do not match the source workspace commit", {
            sourceProjectId,
            sourceCommit,
            expected: workspaceHash,
          });
        }
        files = requestedFiles;
      } else {
        files = workspaceFiles;
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw validationError("source project workspace could not be read", { sourceProjectId, sourceCommit });
    }
  } else if (suppliedFiles !== undefined && suppliedFiles !== null) {
    files = normalizeProvidedFiles(suppliedFiles, snapshotId);
  } else {
    throw validationError("import requires a normalized files manifest");
  }

  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (sourceKind === "zip") validateArchiveMetadata(body, files.length, totalBytes);
  const sourceHash = canonicalSourceHash(files);
  const suppliedHash = optionalStringField(body, "source_hash");
  if (suppliedHash !== null && suppliedHash !== sourceHash) {
    throw validationError("source_hash does not match the normalized manifest", { expected: sourceHash });
  }
  const sourceName = validateBoundedName(
    optionalStringField(body, "source_name") ?? (sourceKind === "project" ? sourceProjectId! : sourceKind),
    "source_name",
  );
  const sourceLocator = optionalStringField(body, "source_locator");
  if (sourceLocator !== null && (Buffer.byteLength(sourceLocator, "utf8") > MAX_PATH_BYTES || sourceLocator.includes("\0"))) {
    throw validationError("source_locator is invalid");
  }
  return { sourceKind, sourceProjectId, sourceName, sourceLocator, sourceCommit, sourceHash, files };
}

function asDateOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw validationError("expires_at must be an ISO timestamp");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw validationError("expires_at must be an ISO timestamp");
  return date.toISOString();
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value as string | Date).toISOString();
}

function effectiveStatus(row: SnapshotRow): SnapshotStatus {
  const expiresAt = row.expires_at === null ? null : new Date(row.expires_at).getTime();
  if ((row.status === "pending_confirmation" || row.status === "confirmed") && expiresAt !== null && expiresAt <= Date.now()) return "expired";
  return row.status;
}

function snapshotIsValid(row: SnapshotRow): boolean {
  const status = effectiveStatus(row);
  return status !== "failed" && status !== "expired";
}

function entryView(row: Record<string, unknown>, includeContent: boolean, searchable: boolean): Record<string, unknown> {
  const contentText = row.content_text as string | null | undefined;
  const bytes = row.content as Uint8Array | null | undefined;
  const view: Record<string, unknown> = {
    id: row.id,
    file_id: row.id,
    snapshot_id: row.snapshot_id,
    path: row.path,
    content_hash: row.content_hash,
    size_bytes: Number(row.size_bytes),
    bytes: Number(row.size_bytes),
    media_type: row.media_type,
    valid: row.valid === true,
    searchable,
    created_at: iso(row.created_at),
  };
  if (includeContent) {
    if (contentText !== null && contentText !== undefined) view.content = contentText;
    else if (bytes !== null && bytes !== undefined) view.content_base64 = Buffer.from(bytes).toString("base64");
  }
  return view;
}

async function loadSnapshotView(tx: TransactionClient, projectId: string, snapshotId: string, includeContent: boolean): Promise<Record<string, unknown>> {
  const snapshotResult = await tx.query(
    `SELECT s.*, src.source_kind AS src_source_kind, src.source_project_id AS src_source_project_id,
            src.source_name AS src_source_name, src.source_locator AS src_source_locator,
            src.source_commit AS src_source_commit, src.source_hash AS src_source_hash
       FROM import_snapshot s
       LEFT JOIN import_source src ON src.snapshot_id = s.id
      WHERE s.id = $1 AND s.project_id = $2`,
    [snapshotId, projectId],
  );
  const row = snapshotResult.rows[0] as SnapshotRow & Record<string, unknown> | undefined;
  if (!row) throw notFoundError(`import snapshot not found: ${snapshotId}`);
  const status = effectiveStatus(row);
  const valid = snapshotIsValid(row);
  const searchable = status === "confirmed" && valid;
  const contentColumns = includeContent ? ", content, content_text" : "";
  const entries = await tx.query(
    `SELECT id, snapshot_id, path, content_hash, size_bytes, media_type, valid, created_at${contentColumns}
       FROM import_file_entry WHERE snapshot_id = $1 ORDER BY path, id`,
    [snapshotId],
  );
  const files = entries.rows.map((entry) => entryView(entry as Record<string, unknown>, includeContent, searchable));
  const source = {
    kind: (row.src_source_kind ?? row.source_kind) as SourceKind,
    source_kind: (row.src_source_kind ?? row.source_kind) as SourceKind,
    project_id: (row.src_source_project_id ?? row.source_project_id) as string | null,
    source_project_id: (row.src_source_project_id ?? row.source_project_id) as string | null,
    name: (row.src_source_name ?? row.source_name) as string,
    source_name: (row.src_source_name ?? row.source_name) as string,
    locator: (row.src_source_locator ?? row.source_locator) as string | null,
    source_locator: (row.src_source_locator ?? row.source_locator) as string | null,
    commit: (row.src_source_commit ?? row.source_commit) as string | null,
    source_commit: (row.src_source_commit ?? row.source_commit) as string | null,
    hash: (row.src_source_hash ?? row.source_hash) as string,
    source_hash: (row.src_source_hash ?? row.source_hash) as string,
  };
  return {
    id: row.id,
    snapshot_id: row.id,
    project_id: row.project_id,
    status,
    confirmation_status: status,
    source_kind: row.source_kind,
    source_project_id: row.source_project_id,
    source_name: row.source_name,
    source_commit: row.source_commit,
    commit: row.source_commit,
    source_hash: row.source_hash,
    source,
    expires_at: iso(row.expires_at),
    valid,
    searchable,
    created_by: row.created_by,
    created_by_type: row.created_by_type,
    confirmed_by: row.confirmed_by,
    confirmed_at: iso(row.confirmed_at),
    denial_reason: row.denial_reason,
    denied_at: iso(row.denied_at),
    failure_reason: row.failure_reason ?? null,
    created_at: iso(row.created_at),
    files,
    entries: files,
  };
}

function auditEventInput(
  ctx: RequestContext,
  snapshotId: string,
  action: string,
  entryId: string | null,
  details: unknown,
  classification: DataClassification,
): OutboxEventInput {
  return {
    eventId: randomUUID(),
    aggregateType: "import_snapshot",
    aggregateId: snapshotId,
    eventType: `import_snapshot.${action}`,
    projectId: ctx.params.projectId ?? "",
    payload: { snapshotId, action, entryId, details },
    correlationId: ctx.correlationId,
    causationId: null,
    classification,
  };
}

async function appendImportAudit(
  tx: TransactionClient,
  ctx: RequestContext,
  snapshotId: string,
  action: string,
  entryId: string | null,
  details: unknown,
  classification: DataClassification,
): Promise<void> {
  await tx.query(
    `INSERT INTO import_audit_event
       (id, project_id, snapshot_id, entry_id, action, actor_type, actor_id, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [randomUUID(), ctx.params.projectId!, snapshotId, entryId, action, ctx.identity.actorType, ctx.identity.actorId, JSON.stringify(details ?? {})],
  );
  await appendOutboxEventInTx(tx, auditEventInput(ctx, snapshotId, action, entryId, details, classification));
}

export async function createImportSnapshotHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireHistoricalMaterialsWriteEnabled(ctx);
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  const requestedId = body.id === undefined || body.id === null
    ? `import_${randomUUID()}`
    : validateIdentifier(requireStringField(body, "id"), "id");
  const expiresAt = asDateOrNull(body.expires_at);
  const { result } = await runIdempotent(ctx, "create_import_snapshot", projectId, async (tx) => {
    const targetClassification = await requireEngineeringTarget(ctx, tx, projectId);
    const manifest = await loadSourceManifest(ctx, tx, body, requestedId);
    await tx.query(
      `INSERT INTO import_snapshot
         (id, project_id, status, source_kind, source_project_id, source_name,
          source_locator, source_commit, source_hash, expires_at, created_by_type, created_by)
       VALUES ($1,$2,'pending_confirmation',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [requestedId, projectId, manifest.sourceKind, manifest.sourceProjectId, manifest.sourceName,
       manifest.sourceLocator, manifest.sourceCommit, manifest.sourceHash, expiresAt,
       ctx.identity.actorType, ctx.identity.actorId],
    );
    await tx.query(
      `INSERT INTO import_source
         (id, snapshot_id, source_kind, source_project_id, source_name, source_locator, source_commit, source_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [`source_${requestedId}`, requestedId, manifest.sourceKind, manifest.sourceProjectId,
       manifest.sourceName, manifest.sourceLocator, manifest.sourceCommit, manifest.sourceHash],
    );
    for (const file of manifest.files) {
      await tx.query(
        `INSERT INTO import_file_entry
           (id, snapshot_id, path, content, content_text, content_hash, size_bytes, media_type, valid)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [file.id, requestedId, file.path, file.bytes, file.contentText, file.contentHash,
         file.sizeBytes, file.mediaType, file.valid],
      );
    }
    await appendImportAudit(tx, ctx, requestedId, "imported", null, {
      sourceKind: manifest.sourceKind,
      sourceProjectId: manifest.sourceProjectId,
      sourceHash: manifest.sourceHash,
      fileCount: manifest.files.length,
    }, targetClassification);
    return loadSnapshotView(tx, projectId, requestedId, false);
  }, async (tx) => {
    await requireEngineeringTarget(ctx, tx, projectId);
    await requireImportSourceAccess(ctx, tx, body);
  });
  return { status: 201, data: result };
}

export async function listImportSnapshotsHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  await requireTargetProjectAccess(ctx, ctx.pool as unknown as TransactionClient, projectId);
  const includeContent = ctx.url.searchParams.get("include_content") === "true";
  const rows = await ctx.pool.query<{ id: string }>(
    "SELECT id FROM import_snapshot WHERE project_id = $1 ORDER BY created_at DESC, id DESC",
    [projectId],
  );
  const items: Record<string, unknown>[] = [];
  for (const row of rows.rows) items.push(await loadSnapshotView(ctx.pool as unknown as TransactionClient, projectId, row.id, includeContent));
  return { status: 200, data: items };
}

export async function getImportSnapshotHandler(ctx: RequestContext): Promise<HandlerResult> {
  const includeContent = ctx.url.searchParams.get("include_content") === "true";
  await requireTargetProjectAccess(ctx, ctx.pool as unknown as TransactionClient, ctx.params.projectId!);
  return { status: 200, data: await loadSnapshotView(ctx.pool as unknown as TransactionClient, ctx.params.projectId!, ctx.params.snapshotId!, includeContent) };
}

async function transitionSnapshotHandler(ctx: RequestContext, target: "confirmed" | "denied"): Promise<HandlerResult> {
  requireHistoricalMaterialsWriteEnabled(ctx);
  const projectId = ctx.params.projectId!;
  const snapshotId = ctx.params.snapshotId!;
  const body = asObject(ctx.body);
  if (ctx.identity.actorType !== "human") {
    throw forbiddenError("IMPORT_CONFIRMATION_REQUIRES_HUMAN", { actorType: ctx.identity.actorType });
  }
  const operation = `${target === "confirmed" ? "confirm_import_snapshot" : "deny_import_snapshot"}:${snapshotId}`;
  const { result } = await runIdempotent(ctx, operation, projectId, async (tx) => {
    const targetClassification = await requireEngineeringTarget(ctx, tx, projectId);
    const selected = await tx.query(
      "SELECT * FROM import_snapshot WHERE id = $1 AND project_id = $2 FOR UPDATE",
      [snapshotId, projectId],
    );
    const row = selected.rows[0] as SnapshotRow | undefined;
    if (!row) throw notFoundError(`import snapshot not found: ${snapshotId}`);
    const current = effectiveStatus(row);
    if (current === target) return loadSnapshotView(tx, projectId, snapshotId, false);
    if (current !== "pending_confirmation") {
      throw conflictApiError("IMPORT_SNAPSHOT_STATE_CONFLICT", { snapshotId, status: current, requested: target });
    }
    const reason = optionalStringField(body, "reason");
    await tx.query(
      `UPDATE import_snapshot
          SET status = $1,
              confirmed_by = CASE WHEN $1 = 'confirmed' THEN $3 ELSE confirmed_by END,
              confirmed_at = CASE WHEN $1 = 'confirmed' THEN now() ELSE confirmed_at END,
              denial_reason = CASE WHEN $1 = 'denied' THEN $4 ELSE denial_reason END,
              denied_at = CASE WHEN $1 = 'denied' THEN now() ELSE denied_at END
        WHERE id = $2 AND project_id = $5`,
      [target, snapshotId, ctx.identity.actorId, reason, projectId],
    );
    await appendImportAudit(tx, ctx, snapshotId, target === "confirmed" ? "confirmed" : "denied", null, { reason }, targetClassification);
    return loadSnapshotView(tx, projectId, snapshotId, false);
  }, async (tx) => {
    await requireEngineeringTarget(ctx, tx, projectId);
  });
  return { status: 200, data: result };
}

export async function confirmImportSnapshotHandler(ctx: RequestContext): Promise<HandlerResult> {
  return transitionSnapshotHandler(ctx, "confirmed");
}

export async function denyImportSnapshotHandler(ctx: RequestContext): Promise<HandlerResult> {
  return transitionSnapshotHandler(ctx, "denied");
}

export async function searchImportSnapshotsHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  await requireTargetProjectAccess(ctx, ctx.pool as unknown as TransactionClient, projectId);
  const query = (ctx.url.searchParams.get("q") ?? "").trim();
  const includeContent = ctx.url.searchParams.get("include_content") === "true";
  const rawLimit = Number(ctx.url.searchParams.get("limit") ?? "50");
  if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) throw validationError("limit must be an integer between 1 and 100");
  const pattern = `%${query.replace(/[\\%_]/g, (value) => `\\${value}`)}%`;
  const contentColumns = includeContent ? ", e.content, e.content_text" : "";
  const rows = await ctx.pool.query(
    `SELECT e.id, e.snapshot_id, e.path, e.content_hash,
            e.size_bytes, e.media_type, e.valid, e.created_at,
            s.project_id, s.status, s.source_kind, s.source_project_id,
            s.source_name, s.source_hash, s.expires_at,
            COUNT(*) OVER()::int AS total${contentColumns}
       FROM import_file_entry e
       JOIN import_snapshot s ON s.id = e.snapshot_id
      WHERE s.project_id = $1
        AND s.status = 'confirmed'
        AND (s.expires_at IS NULL OR s.expires_at > now())
        AND e.valid = true
        AND ($2 = '' OR e.path ILIKE $3 ESCAPE '\\' OR COALESCE(e.content_text, '') ILIKE $3 ESCAPE '\\' OR s.source_name ILIKE $3 ESCAPE '\\')
      ORDER BY s.created_at DESC, e.path, e.id
      LIMIT $4`,
    [projectId, query, pattern, rawLimit],
  );
  const items = rows.rows.map((row) => {
    const record = row as Record<string, unknown>;
    const item = entryView(record, includeContent, true);
    return {
      ...item,
      snapshot_id: record.snapshot_id,
      project_id: record.project_id,
      status: "confirmed",
      source_kind: record.source_kind,
      source_project_id: record.source_project_id,
      source_name: record.source_name,
      source_hash: record.source_hash,
      expires_at: iso(record.expires_at),
      valid: true,
      searchable: true,
    };
  });
  const total = rows.rows.length === 0 ? 0 : Number((rows.rows[0] as Record<string, unknown>).total);
  return { status: 200, data: { items, results: items, query, total } };
}

function requireStringArrayField(body: Record<string, unknown>, keys: readonly string[]): string[] {
  const key = keys.find((candidate) => body[candidate] !== undefined);
  if (!key) throw validationError(`field '${keys[0]}' is required`);
  const value = body[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IMPORT_FILES || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw validationError(`field '${key}' must be a non-empty array of strings`);
  }
  const values = value as string[];
  if (new Set(values).size !== values.length) throw validationError(`field '${key}' contains duplicate ids`);
  return values;
}

export function resolveImportArtifactType(value: unknown): ArtifactType {
  if (value === undefined || value === null) return "KNOWLEDGE_ENTRY";
  if (!isArtifactType(value)) {
    throw validationError("field 'artifact_type' must be a recognized ArtifactType");
  }
  return value;
}

export async function copyImportSnapshotHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireHistoricalMaterialsWriteEnabled(ctx);
  const projectId = ctx.params.projectId!;
  const snapshotId = ctx.params.snapshotId!;
  const body = asObject(ctx.body);
  const copyId = validateIdentifier(requireStringField(body, "id"), "id");
  const name = validateBoundedName(requireStringField(body, "name"), "name");
  const entryIds = requireStringArrayField(body, ["file_ids", "entry_ids"]);
  const artifactType = resolveImportArtifactType(body.artifact_type);

  const { result } = await runIdempotent(ctx, `copy_import_snapshot:${snapshotId}`, projectId, async (tx) => {
    const targetClassification = await requireEngineeringTarget(ctx, tx, projectId);
    const snapResult = await tx.query(
      "SELECT * FROM import_snapshot WHERE id = $1 AND project_id = $2 FOR UPDATE",
      [snapshotId, projectId],
    );
    const snapshot = snapResult.rows[0] as SnapshotRow | undefined;
    if (!snapshot) throw notFoundError(`import snapshot not found: ${snapshotId}`);
    const status = effectiveStatus(snapshot);
    if (status !== "confirmed" || !snapshotIsValid(snapshot)) {
      throw conflictApiError("IMPORT_SNAPSHOT_NOT_SEARCHABLE", { snapshotId, status });
    }
    const entryResult = await tx.query(
      `SELECT id, snapshot_id, path, content, content_text, content_hash, size_bytes, media_type, valid
         FROM import_file_entry
        WHERE snapshot_id = $1 AND id = ANY($2::text[]) AND valid = true
        ORDER BY array_position($2::text[], id)`,
      [snapshotId, entryIds],
    );
    if (entryResult.rows.length !== entryIds.length) {
      throw notFoundError("one or more selected import files were not found or are invalid", { entryIds });
    }
    const revisions: Record<string, unknown>[] = [];
    const relations: Record<string, unknown>[] = [];
    for (let index = 0; index < entryResult.rows.length; index += 1) {
      const entry = entryResult.rows[index] as Record<string, unknown>;
      const contentText = entry.content_text as string | null;
      if (contentText === null) {
        throw validationError("binary import files cannot yet be copied as text revisions", { fileId: entry.id, path: entry.path });
      }
      // artifact_revision.id is global across all projects. Keep the caller's
      // id as the copy-operation identifier, and derive a project/snapshot/
      // file-namespaced revision id so common human labels cannot collide.
      const revisionId = `import_rev_${sha256Hex(`${projectId}\0${snapshotId}\0${copyId}\0${String(entry.id)}`).slice(0, 48)}`;
      const path = String(entry.path);
      const artifactId = `import-${projectId}-${sha256Hex(path).slice(0, 24)}`;
      // Serialize version allocation for a path-derived artifact under a
      // transaction-scoped advisory lock. This prevents two copies from both
      // selecting the same MAX(version)+1.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [artifactId]);
      await tx.query(
        `INSERT INTO artifact (id, project_id, artifact_type, title)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO NOTHING`,
        [artifactId, projectId, artifactType, name ?? path],
      );
      const artifactResult = await tx.query(
        "SELECT project_id, artifact_type, title FROM artifact WHERE id = $1 FOR UPDATE",
        [artifactId],
      );
      const artifact = artifactResult.rows[0] as { project_id?: string; artifact_type?: string; title?: string } | undefined;
      if (!artifact || artifact.project_id !== projectId) {
        throw conflictApiError("IMPORT_ARTIFACT_ID_OWNERSHIP_CONFLICT", { artifactId, projectId });
      }
      if (artifact.artifact_type !== artifactType) {
        throw conflictApiError("IMPORT_ARTIFACT_METADATA_CONFLICT", {
          artifactId,
          expectedType: artifactType,
          actualType: artifact.artifact_type,
        });
      }
      const versionResult = await tx.query(
        "SELECT COALESCE(MAX(version), 0)::int AS max FROM artifact_revision WHERE artifact_id = $1",
        [artifactId],
      );
      const versionRow = versionResult.rows[0] as { max?: number } | undefined;
      const version = Number(versionRow?.max ?? 0) + 1;
      await createRevision(asClient(tx), {
        id: revisionId,
        artifactId,
        projectId,
        version,
        state: "candidate",
        parentRevisionId: null,
        contentHash: String(entry.content_hash),
        contentLocation: `db://artifact_revision/${revisionId}`,
        content: contentText,
        schemaVersion: "v1",
        sourceIds: [snapshotId, String(entry.id)],
        dataClassification: targetClassification,
        toolModelProvenance: null,
        changeReason: `${name}: copied from import snapshot ${snapshotId}`,
        createdBy: ctx.identity.actorId,
        createdByType: ctx.identity.actorType as ActorType,
        createdAt: new Date().toISOString(),
        reviewIds: [],
      });
      const relationId = `import_rel_${randomUUID()}`;
      await tx.query(
        `INSERT INTO import_source_relation
           (id, project_id, snapshot_id, entry_id, source_project_id, target_revision_id,
            source_hash, relation_kind, created_by_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'imported_candidate',$8,$9)`,
        [relationId, projectId, snapshotId, entry.id, snapshot.source_project_id,
         revisionId, snapshot.source_hash, ctx.identity.actorType, ctx.identity.actorId],
      );
      await appendImportAudit(tx, ctx, snapshotId, "copied", String(entry.id), { revisionId, path }, targetClassification);
      await appendOutboxEventInTx(tx, {
        eventId: randomUUID(),
        aggregateType: "artifact_revision",
        aggregateId: revisionId,
        eventType: "revision.created",
        projectId,
        payload: { id: revisionId, artifactId, projectId, version, state: "candidate", importSnapshotId: snapshotId, importFileId: entry.id },
        correlationId: ctx.correlationId,
        causationId: null,
        classification: targetClassification,
      });
      revisions.push({ id: revisionId, artifact_id: artifactId, project_id: projectId, version, state: "candidate", file_id: entry.id, path, content_hash: entry.content_hash });
      relations.push({ id: relationId, snapshot_id: snapshotId, entry_id: entry.id, target_revision_id: revisionId, relation_kind: "imported_candidate" });
    }
    return {
      id: copyId,
      project_id: projectId,
      snapshot_id: snapshotId,
      candidate: true,
      revision_ids: revisions.map((revision) => revision.id),
      copied_files: revisions.map((revision) => ({
        file_id: revision.file_id,
        path: revision.path,
        revision_id: revision.id,
        artifact_id: revision.artifact_id,
        version: revision.version,
      })),
      revisions,
      source_relations: relations,
    };
  }, async (tx) => {
    await requireEngineeringTarget(ctx, tx, projectId);
  });
  return { status: 201, data: result };
}
