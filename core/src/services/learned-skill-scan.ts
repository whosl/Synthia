/** Deterministic, fail-closed scanner for immutable Learned-Skill assets. */

import { canonicalRequestHash, sha256Hex } from "../hashing.ts";

export const LEARNED_SKILL_SCANNER_VERSION = "learned-skill-scanner.v1";
export const MAX_LEARNED_SKILL_FILES = 64;
export const MAX_LEARNED_SKILL_FILE_BYTES = 256 * 1024;
export const MAX_LEARNED_SKILL_TOTAL_BYTES = 1024 * 1024;

export type LearnedSkillFileKind = "skill_md" | "reference" | "template" | "script";
export type LearnedSkillScriptLanguage = "tcl" | "python" | "typescript";

export interface LearnedSkillFileInput {
  readonly path: string;
  readonly kind: LearnedSkillFileKind;
  readonly language?: LearnedSkillScriptLanguage | null;
  readonly content: string;
}

export interface ScannedLearnedSkillFile {
  readonly path: string;
  readonly kind: LearnedSkillFileKind;
  readonly language: LearnedSkillScriptLanguage | null;
  readonly content: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
}

export interface LearnedSkillScanFinding {
  readonly code: string;
  readonly path: string | null;
  readonly detail: string;
}

export interface LearnedSkillScanResult {
  readonly scannerVersion: typeof LEARNED_SKILL_SCANNER_VERSION;
  readonly decision: "pass" | "quarantine";
  readonly findings: readonly LearnedSkillScanFinding[];
  readonly files: readonly ScannedLearnedSkillFile[];
  readonly contentManifestHash: string;
}

export interface LearnedSkillMetadataInput {
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly applicability: unknown;
  readonly outcomeContract: unknown;
}

interface DenyRule {
  readonly code: string;
  readonly pattern: RegExp;
  readonly detail: string;
}

const GENERAL_DENY_RULES: readonly DenyRule[] = [
  {
    code: "SECRET_MATERIAL",
    pattern: /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"'\n]{8,}["'])/i,
    detail: "asset appears to contain a credential or private key",
  },
  {
    code: "ABSOLUTE_PATH",
    pattern: /(?:^|[\s"'=(,:])(?:\/(?!\/)[^\s"'`<>{}\[\]]+|[A-Za-z]:\\[^\s"'`<>{}\[\]]*)/m,
    detail: "asset contains a host absolute path",
  },
  {
    code: "PROJECT_PRIVATE_CONTENT",
    pattern: /(?:\b(?:project|task|episode|application|evidence|workspace|tool[_ -]?run)[_-]?(?:id|ref)\b["']?\s*[:=]\s*["']?[A-Za-z0-9][A-Za-z0-9_.:-]{5,}|\b(?:confidential|proprietary|private[- ]project|customer[- ]specific|internal[- ]only)\b)/i,
    detail: "asset appears to contain private or project-specific content",
  },
  {
    code: "CAPABILITY_INJECTION",
    pattern: /(?:core_(?:approve|baseline|publish)|hardware_write|execute_tcl|mcp__[A-Za-z0-9_]+|vivado_raw_tcl)/i,
    detail: "asset attempts to name a forbidden governance or raw execution capability",
  },
];

const PYTHON_DENY_RULES: readonly DenyRule[] = [
  { code: "NETWORK_API", pattern: /(?:^|\n)\s*(?:from|import)\s+(?:socket|requests|urllib|httpx|aiohttp|ftplib|smtplib|paramiko)\b/m, detail: "Python network module is forbidden" },
  { code: "PROCESS_START", pattern: /\b(?:subprocess\.|os\.system\s*\(|os\.popen\s*\(|pty\.spawn\s*\()/, detail: "Python process creation is forbidden" },
  { code: "DYNAMIC_LOAD", pattern: /\b(?:eval|exec|compile|__import__)\s*\(|\bimportlib\./, detail: "Python dynamic evaluation/loading is forbidden" },
  { code: "DANGEROUS_FILE_API", pattern: /\b(?:shutil\.(?:rmtree|move|copytree)|os\.(?:remove|unlink|rename|replace|chmod|chown)|Path\([^\n]*\)\.(?:unlink|rename|replace|chmod))\s*\(/, detail: "Python destructive file API is forbidden" },
];

const TYPESCRIPT_DENY_RULES: readonly DenyRule[] = [
  { code: "NETWORK_API", pattern: /(?:\bfetch\s*\(|\bWebSocket\s*\(|\brequire\s*\(\s*["'](?:https?|net|tls|dgram)["']|from\s+["'](?:node:)?(?:https?|net|tls|dgram)["'])/, detail: "TypeScript network API is forbidden" },
  { code: "PROCESS_START", pattern: /(?:child_process|Bun\.spawn|Deno\.Command|process\.binding)\b/, detail: "TypeScript process creation is forbidden" },
  { code: "DYNAMIC_LOAD", pattern: /(?:\beval\s*\(|\bnew\s+Function\s*\(|\bimport\s*\(\s*[^"'])/, detail: "TypeScript dynamic evaluation/loading is forbidden" },
  { code: "DANGEROUS_FILE_API", pattern: /\b(?:rm|rmSync|unlink|unlinkSync|rename|renameSync|chmod|chmodSync|chown|chownSync)\s*\(/, detail: "TypeScript destructive file API is forbidden" },
];

const TCL_DENY_RULES: readonly DenyRule[] = [
  { code: "TCL_PROCESS_START", pattern: /(?:^|[;\n\[])\s*(?:exec|open\s+\||pid)\b/im, detail: "Tcl process creation or pipe opening is forbidden" },
  { code: "TCL_NETWORK_API", pattern: /(?:^|[;\n\[])\s*(?:socket|http::geturl|ftp::|smtp::)\b/im, detail: "Tcl network access is forbidden" },
  { code: "TCL_DYNAMIC_LOAD", pattern: /(?:^|[;\n\[])\s*(?:source|load|package\s+require|eval|uplevel|upvar|interp|rename)\b/im, detail: "Tcl dynamic loading/evaluation is forbidden" },
  { code: "TCL_DANGEROUS_FILE_API", pattern: /(?:^|[;\n\[])\s*file\s+(?:delete|rename|copy|link|attributes|owned)\b/im, detail: "Tcl mutating file operation is forbidden" },
  { code: "TCL_ENVIRONMENT_ACCESS", pattern: /\$::env\s*\(|\$env\s*\(/i, detail: "Tcl environment-variable access is forbidden" },
  { code: "TCL_RAW_VIVADO_ENTRY", pattern: /(?:^|[;\n\[])\s*(?:start_gui|launch_runs|open_hw|connect_hw_server|open_hw_target|program_hw_devices|write_cfgmem)\b/im, detail: "raw Vivado orchestration/hardware entry point is forbidden" },
];

/** Exported contract vectors keep the Tcl policy explicit and regression-testable. */
export const TCL_ALLOW_TEST_VECTORS = Object.freeze([
  "set failing_paths [get_timing_paths -quiet -max_paths 10]\nputs [llength $failing_paths]\n",
  "foreach cell [get_cells -hier *] { puts $cell }\n",
  "if {[llength $violations] == 0} { return }\nerror {timing violations remain}\n",
] as const);

export const TCL_DENY_TEST_VECTORS = Object.freeze([
  { code: "TCL_PROCESS_START", content: "exec sh -c {curl https://example.invalid}\n" },
  { code: "TCL_NETWORK_API", content: "socket example.invalid 443\n" },
  { code: "TCL_NETWORK_API", content: "set channel [socket example.invalid 443]\n" },
  { code: "TCL_DYNAMIC_LOAD", content: "source /tmp/untrusted.tcl\n" },
  { code: "TCL_DYNAMIC_LOAD", content: "set loaded [source relative.tcl]\n" },
  { code: "TCL_DYNAMIC_LOAD", content: "set plugin [load plugin.so]\n" },
  { code: "TCL_DANGEROUS_FILE_API", content: "file delete -force ../project\n" },
  { code: "TCL_DANGEROUS_FILE_API", content: "set deleted [file delete generated.dcp]\n" },
  { code: "TCL_ENVIRONMENT_ACCESS", content: "puts $::env(HOME)\n" },
  { code: "TCL_RAW_VIVADO_ENTRY", content: "open_hw_target\nprogram_hw_devices [current_hw_device]\n" },
] as const);

function finding(code: string, detail: string, path: string | null = null): LearnedSkillScanFinding {
  return { code, path, detail };
}

function hasUnpairedSurrogate(value: string): boolean {
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

function normalizePath(raw: string): string | null {
  if (
    !raw ||
    raw !== raw.normalize("NFC") ||
    raw.startsWith("/") ||
    raw.includes("\\") ||
    raw.includes("\0") ||
    Buffer.byteLength(raw, "utf8") > 512
  ) return null;
  const parts = raw.split("/");
  if (parts.length > 32 || parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function expectedFileShape(path: string): {
  kind: LearnedSkillFileKind;
  language: LearnedSkillScriptLanguage | null;
  mediaType: string;
} | null {
  if (path === "SKILL.md") return { kind: "skill_md", language: null, mediaType: "text/markdown" };
  if (path.startsWith("references/")) return { kind: "reference", language: null, mediaType: mediaTypeFor(path) };
  if (path.startsWith("templates/")) return { kind: "template", language: null, mediaType: mediaTypeFor(path) };
  if (!path.startsWith("scripts/")) return null;
  if (path.endsWith(".tcl")) return { kind: "script", language: "tcl", mediaType: "text/x-tcl" };
  if (path.endsWith(".py")) return { kind: "script", language: "python", mediaType: "text/x-python" };
  if (path.endsWith(".ts")) return { kind: "script", language: "typescript", mediaType: "text/typescript" };
  return null;
}

function mediaTypeFor(path: string): string {
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "application/yaml";
  if (path.endsWith(".sv")) return "text/systemverilog";
  if (path.endsWith(".v")) return "text/verilog";
  if (path.endsWith(".xdc")) return "text/x-xdc";
  return "text/plain";
}

function scanRules(
  content: string,
  path: string,
  rules: readonly DenyRule[],
  findings: LearnedSkillScanFinding[],
): void {
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(content)) findings.push(finding(rule.code, rule.detail, path));
  }
}

/** Shared fail-closed Tcl surface used by immutable Skill scripts and XDC inputs. */
export function scanTclSafetyRules(
  content: string,
  path: string | null = null,
): readonly LearnedSkillScanFinding[] {
  const findings: LearnedSkillScanFinding[] = [];
  const findingPath = path ?? "<tcl>";
  scanRules(content, findingPath, GENERAL_DENY_RULES, findings);
  scanRules(content, findingPath, TCL_DENY_RULES, findings);
  return findings;
}

export function scanLearnedSkillFiles(
  input: readonly LearnedSkillFileInput[],
): LearnedSkillScanResult {
  const findings: LearnedSkillScanFinding[] = [];
  const files: ScannedLearnedSkillFile[] = [];
  if (!Array.isArray(input) || input.length === 0) {
    findings.push(finding("FILES_REQUIRED", "at least SKILL.md is required"));
  }
  if (input.length > MAX_LEARNED_SKILL_FILES) {
    findings.push(finding("TOO_MANY_FILES", `at most ${MAX_LEARNED_SKILL_FILES} files are allowed`));
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  for (const raw of input.slice(0, MAX_LEARNED_SKILL_FILES)) {
    if (!raw || typeof raw !== "object") {
      findings.push(finding("INVALID_FILE", "file must be an object"));
      continue;
    }
    const path = typeof raw.path === "string" ? normalizePath(raw.path) : null;
    if (!path) {
      findings.push(finding("UNSAFE_PATH", "path must be normalized, relative, and traversal-free", typeof raw.path === "string" ? raw.path : null));
      continue;
    }
    const portableKey = path.toLowerCase();
    if (seen.has(portableKey)) {
      findings.push(finding("PATH_COLLISION", "duplicate or case-colliding path", path));
      continue;
    }
    seen.add(portableKey);
    const expected = expectedFileShape(path);
    if (!expected) {
      findings.push(finding("PATH_NOT_ALLOWED", "only SKILL.md, references/, templates/, and .tcl/.py/.ts scripts are allowed", path));
      continue;
    }
    const language = raw.language ?? null;
    if (raw.kind !== expected.kind || language !== expected.language) {
      findings.push(finding("FILE_SHAPE_MISMATCH", `expected kind=${expected.kind} language=${expected.language ?? "null"}`, path));
      continue;
    }
    if (typeof raw.content !== "string" || hasUnpairedSurrogate(raw.content)) {
      findings.push(finding("INVALID_UTF8_TEXT", "content must be valid Unicode text", path));
      continue;
    }
    const sizeBytes = Buffer.byteLength(raw.content, "utf8");
    totalBytes += sizeBytes;
    if (sizeBytes === 0) findings.push(finding("EMPTY_FILE", "empty assets are not allowed", path));
    if (sizeBytes > MAX_LEARNED_SKILL_FILE_BYTES) {
      findings.push(finding("FILE_TOO_LARGE", `file exceeds ${MAX_LEARNED_SKILL_FILE_BYTES} bytes`, path));
    }
    scanRules(raw.content, path, GENERAL_DENY_RULES, findings);
    if (language === "tcl") scanRules(raw.content, path, TCL_DENY_RULES, findings);
    if (language === "python") scanRules(raw.content, path, PYTHON_DENY_RULES, findings);
    if (language === "typescript") scanRules(raw.content, path, TYPESCRIPT_DENY_RULES, findings);

    files.push({
      path,
      kind: expected.kind,
      language: expected.language,
      content: raw.content,
      sha256: sha256Hex(raw.content),
      sizeBytes,
      mediaType: expected.mediaType,
    });
  }
  if (!seen.has("skill.md")) findings.push(finding("SKILL_MD_REQUIRED", "exactly one root SKILL.md is required"));
  if (totalBytes > MAX_LEARNED_SKILL_TOTAL_BYTES) {
    findings.push(finding("TOTAL_TOO_LARGE", `assets exceed ${MAX_LEARNED_SKILL_TOTAL_BYTES} bytes`));
  }
  const manifest = files
    .map((file) => ({ path: file.path, kind: file.kind, language: file.language, sha256: file.sha256, size_bytes: file.sizeBytes, media_type: file.mediaType }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    scannerVersion: LEARNED_SKILL_SCANNER_VERSION,
    decision: findings.length === 0 ? "pass" : "quarantine",
    findings,
    files,
    contentManifestHash: canonicalRequestHash({ schema: "learned-skill-manifest.v1", files: manifest }),
  };
}

/**
 * Scan both immutable assets and the metadata that is rendered into search and
 * agent prompts. A version is safe only when every surface passes the same
 * fail-closed content policy.
 */
export function scanLearnedSkillPackage(
  input: readonly LearnedSkillFileInput[],
  metadata: LearnedSkillMetadataInput,
): LearnedSkillScanResult {
  const scanned = scanLearnedSkillFiles(input);
  const findings = [...scanned.findings];
  const fields: readonly [string, unknown][] = [
    ["name", metadata.name],
    ["summary", metadata.summary],
    ["description", metadata.description],
    ["applicability", metadata.applicability],
    ["outcome_contract", metadata.outcomeContract],
  ];
  for (const [name, value] of fields) {
    let serialized: string;
    try {
      serialized = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      findings.push(finding("INVALID_METADATA", "metadata must be JSON serializable", `<metadata>.${name}`));
      continue;
    }
    if (typeof serialized !== "string" || hasUnpairedSurrogate(serialized)) {
      findings.push(finding("INVALID_METADATA", "metadata must be valid Unicode JSON", `<metadata>.${name}`));
      continue;
    }
    scanRules(serialized, `<metadata>.${name}`, GENERAL_DENY_RULES, findings);
  }
  return {
    ...scanned,
    decision: findings.length === 0 ? "pass" : "quarantine",
    findings,
  };
}
