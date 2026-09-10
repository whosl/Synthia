import type {
  CreateImportSnapshotRequest,
  HistoricalMaterialFile,
  HistoricalMaterialSnapshot,
  ImportSnapshotFileInput,
  ImportSnapshotStatus,
} from "../api/types.ts";

/** 人可读的资料快照状态。状态本身不代表仍可检索，需同时检查 valid。 */
export const HISTORICAL_STATUS_TEXT: Readonly<Record<ImportSnapshotStatus, string>> = {
  pending_confirmation: "待确认",
  confirmed: "已确认",
  denied: "已否决",
  failed: "导入失败",
  expired: "已过期",
};

export const HISTORICAL_STATUS_TONE: Readonly<Record<ImportSnapshotStatus, "neutral" | "ok" | "warn" | "danger">> = {
  pending_confirmation: "warn",
  confirmed: "ok",
  denied: "danger",
  failed: "danger",
  expired: "neutral",
};

/** 历史资料复制场景开放的 Core 合法产物类型；UI 不接受任意字符串。 */
export const HISTORICAL_COPY_ARTIFACT_TYPES = [
  { value: "KNOWLEDGE_ENTRY", label: "知识条目" },
  { value: "SOURCE_PACKAGE", label: "来源包" },
  { value: "DEVELOPMENT_REQUIREMENTS", label: "研制需求" },
  { value: "ARCHITECTURE_DESIGN", label: "架构设计" },
  { value: "DETAILED_DESIGN", label: "详细设计" },
  { value: "RTL_SOURCE_SET", label: "RTL 源代码集" },
  { value: "TB_SOURCE_SET", label: "验证环境源代码集" },
  { value: "XDC_CANDIDATE", label: "XDC 候选" },
] as const;

export type HistoricalCopyArtifactType = typeof HISTORICAL_COPY_ARTIFACT_TYPES[number]["value"];

export const DEFAULT_HISTORICAL_COPY_ARTIFACT_TYPE: HistoricalCopyArtifactType = "KNOWLEDGE_ENTRY";

const HISTORICAL_COPY_ARTIFACT_TYPE_SET: ReadonlySet<string> = new Set(
  HISTORICAL_COPY_ARTIFACT_TYPES.map((option) => option.value),
);

export function isHistoricalCopyArtifactType(value: unknown): value is HistoricalCopyArtifactType {
  return typeof value === "string" && HISTORICAL_COPY_ARTIFACT_TYPE_SET.has(value);
}

/** 只有确认且仍有效的快照能进入默认检索/复制路径。 */
export function isSearchableSnapshot(snapshot: Pick<HistoricalMaterialSnapshot, "status" | "valid" | "searchable">): boolean {
  return snapshot.status === "confirmed" && snapshot.valid && snapshot.searchable;
}

/** 文件条目同样需要显式 searchable，防止 UI 把待确认资料误当成默认上下文。 */
export function isSearchableFile(file: Pick<HistoricalMaterialFile, "id"> & { readonly searchable?: boolean; readonly valid?: boolean }): boolean {
  return file.searchable === true && file.valid !== false;
}

export interface MaterialImportParseResult {
  readonly ok: true;
  readonly request: CreateImportSnapshotRequest;
}

export interface MaterialImportParseError {
  readonly ok: false;
  readonly message: string;
}

export type MaterialImportParse = MaterialImportParseResult | MaterialImportParseError;

const MAX_IMPORT_FILES = 500;
const MAX_IMPORT_FILE_BYTES = 1024 * 1024;
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

/**
 * Core 仍是安全边界；此处只做导入控件的早期校验，让明显危险/畸形 payload 在
 * 离开浏览器前就被拒绝。路径规则与 Core 保持同一 fail-closed 方向：相对 POSIX
 * 路径、无 `..`、不包含秘密/证书扩展名。
 */
export function isSafeMaterialPath(raw: string): boolean {
  if (!raw || new TextEncoder().encode(raw).byteLength > 512 || raw.includes("\0") || raw.includes("\\")) return false;
  if (raw.startsWith("/") || raw.startsWith("//") || /^[A-Za-z]:/.test(raw)) return false;
  const path = raw.startsWith("./") ? raw.slice(2) : raw;
  const segments = path.split("/");
  if (segments.length === 0 || segments.length > 32 || segments.some((part) => part === "" || part === "." || part === "..")) return false;
  if (segments.some((part) => [...part].some((char) => char.charCodeAt(0) < 0x20 || char === "\u007f"))) return false;
  if (segments[0]!.toLowerCase() === "sim") return false;
  const base = segments[segments.length - 1]!.toLowerCase();
  if (base === ".env" || base.startsWith(".env.")) return false;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|known_hosts)$/.test(base)) return false;
  if (/(?:secret|credential|password|private[_-]?key|access[_-]?token)/i.test(base)) return false;
  if (/\.(?:key|pem|crt|cer|der|p12|pfx|jks|keystore|kdb|kdbx)$/i.test(base)) return false;
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sourceKind(value: unknown): CreateImportSnapshotRequest["source_kind"] | null {
  return value === "project" || value === "local_directory" || value === "zip" ? value : null;
}

function normalizeFile(value: unknown): ImportSnapshotFileInput | MaterialImportParseError {
  const row = asRecord(value);
  if (!row || typeof row.path !== "string" || typeof row.content !== "string") {
    return { ok: false, message: "每个资料文件必须包含 path 和字符串 content。" };
  }
  if (!isSafeMaterialPath(row.path)) return { ok: false, message: `资料路径不安全或包含敏感文件：${row.path}` };
  const path = row.path.startsWith("./") ? row.path.slice(2) : row.path;
  const mediaType = row.media_type;
  if (mediaType !== undefined && typeof mediaType !== "string") {
    return { ok: false, message: `资料文件 ${path} 的 media_type 必须是字符串。` };
  }
  if (typeof mediaType === "string" && (!mediaType.trim() || mediaType.length > 128)) {
    return { ok: false, message: `资料文件 ${path} 的 media_type 必须是 1–128 字符。` };
  }
  return { path, content: row.content, ...(typeof mediaType === "string" ? { media_type: mediaType.trim() } : {}) };
}

function isMaterialImportError(value: ImportSnapshotFileInput | MaterialImportParseError): value is MaterialImportParseError {
  return "ok" in value;
}

/**
 * 解析粘贴/上传的规范化 JSON。本地/ZIP 来源必须传 `files`；project 来源可省略
 * `files`，由 Core 从 `source_project_id` 的固定 commit 读取工作树。
 */
export function parseMaterialImportPayload(text: string): MaterialImportParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: "资料 JSON 无法解析。" };
  }
  const root = asRecord(parsed);
  if (!root) return { ok: false, message: "资料导入必须是 JSON 对象。" };
  const kind = sourceKind(root.source_kind) ?? "local_directory";
  if (root.source_kind !== undefined && !sourceKind(root.source_kind)) {
    return { ok: false, message: "source_kind 必须是 project、local_directory 或 zip。" };
  }
  if (kind === "project" && (typeof root.source_project_id !== "string" || !root.source_project_id.trim())) {
    return { ok: false, message: "project 来源必须提供 source_project_id。" };
  }
  if (kind !== "project" && root.source_project_id !== undefined && root.source_project_id !== null && root.source_project_id !== "") {
    return { ok: false, message: "只有 project 来源可以提供 source_project_id。" };
  }
  if (root.id !== undefined && (typeof root.id !== "string" || root.id.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(root.id))) {
    return { ok: false, message: "资料快照 id 只能包含字母、数字、点、下划线、冒号或连字符，且不超过 128 字符。" };
  }
  if (kind === "project" && root.commit !== undefined && (typeof root.commit !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(root.commit))) {
    return { ok: false, message: "project 来源的 commit 必须是 40 或 64 位十六进制 Git 对象哈希。" };
  }
  if (root.source_hash !== undefined && (typeof root.source_hash !== "string" || !/^[0-9a-f]{64}$/.test(root.source_hash))) {
    return { ok: false, message: "source_hash 必须是 64 位小写十六进制摘要。" };
  }
  if (root.expires_at !== undefined && root.expires_at !== null && (typeof root.expires_at !== "string" || !Number.isFinite(Date.parse(root.expires_at)))) {
    return { ok: false, message: "expires_at 必须是 ISO 时间戳或 null。" };
  }
  const rawFiles = root.files;
  const projectUsesWorkspace = kind === "project" && (rawFiles === undefined || rawFiles === null);
  if (!projectUsesWorkspace && (!Array.isArray(rawFiles) || rawFiles.length === 0)) {
    return {
      ok: false,
      message: kind === "project"
        ? "project 来源省略 files 时由 Core 从固定 commit 读取；若提供 files，则至少包含一个文件。"
        : "local_directory 和 zip 来源至少提供一个资料文件。",
    };
  }
  if (Array.isArray(rawFiles) && rawFiles.length > MAX_IMPORT_FILES) {
    return { ok: false, message: `资料文件数不能超过 ${MAX_IMPORT_FILES} 个。` };
  }

  const files: ImportSnapshotFileInput[] = [];
  let totalBytes = 0;
  const paths = new Set<string>();
  for (const raw of Array.isArray(rawFiles) ? rawFiles : []) {
    const normalized = normalizeFile(raw);
    if (isMaterialImportError(normalized)) return normalized;
    if (paths.has(normalized.path)) return { ok: false, message: `资料路径重复：${normalized.path}` };
    paths.add(normalized.path);
    const fileBytes = new TextEncoder().encode(normalized.content).byteLength;
    if (fileBytes > MAX_IMPORT_FILE_BYTES) return { ok: false, message: `单个资料文件不能超过 ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MiB：${normalized.path}` };
    totalBytes += fileBytes;
    if (totalBytes > MAX_IMPORT_BYTES) return { ok: false, message: `资料总大小不能超过 ${MAX_IMPORT_BYTES / 1024 / 1024} MiB。` };
    files.push(normalized);
  }

  const optionalString = (key: string): string | undefined => typeof root[key] === "string" && root[key].trim() ? root[key]!.trim() : undefined;
  return {
    ok: true,
    request: {
      ...(optionalString("id") ? { id: optionalString("id") } : {}),
      source_kind: kind,
      ...(typeof root.source_project_id === "string" && root.source_project_id.trim() ? { source_project_id: root.source_project_id.trim() } : {}),
      ...(optionalString("commit") ? { commit: optionalString("commit") } : {}),
      ...(optionalString("source_name") ? { source_name: optionalString("source_name") } : {}),
      ...(optionalString("source_hash") ? { source_hash: optionalString("source_hash") } : {}),
      ...(root.expires_at === null ? { expires_at: null } : typeof root.expires_at === "string" ? { expires_at: new Date(root.expires_at).toISOString() } : {}),
      ...(files.length > 0 ? { files } : {}),
    },
  };
}

/** 按用户勾选的 file id 生成复制请求所需的稳定文件集合。 */
export function selectedMaterialFiles(files: readonly HistoricalMaterialFile[], selectedIds: ReadonlySet<string>): HistoricalMaterialFile[] {
  return files.filter((file) => selectedIds.has(file.id) && isSafeMaterialPath(file.path) && isSearchableFile(file));
}

/** 状态异常或 Core 漏字段时，默认按不可检索处理。 */
export function canCopyMaterial(snapshot: Pick<HistoricalMaterialSnapshot, "status" | "valid" | "searchable">): boolean {
  return isSearchableSnapshot(snapshot);
}
