import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  buildCandidate19Payload,
  candidate19ScriptConfigSha256,
  validateCandidate19ScriptConfig,
  type Candidate19ScriptConfig,
} from "./m4f-direct-six-process-cleanup-19.ts";
import {
  auditDirectSshEffectiveConfig,
  buildDirectSshEffectiveArguments,
  buildDirectSshOptions,
  captureM4fDirectTransportInputs,
  validateM4fDirectAdmissionConfig,
  type M4fDirectAdmissionConfig,
  type RawProcessResult,
} from "./m4f-gate-admission-transport.ts";

const SSH_PATH = "/usr/bin/ssh";
const TARGET_HOST = "100.96.223.49";
const EFFECTIVE_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 30_000;
const COMMAND_LIMIT = 7_000;
const WINDOWS_COMMAND_LIMIT = 8_191;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/u;
const C19_SOURCE_SHA256 = "17575ea5c61199697bd83b44fc9b6e7c6fbe4cb732341de4644eeae278cbf964";
const C19_TEST_SHA256 = "a61c2f18345afd2d06ca5352208538d1a4f4202573deb232babfbc301e7b8afb";
const C19_DOC_SHA256 = "27eeaafc8d9e099fb766b40c89d7785750231bc0d793d935c314bddd9b5417e8";
const TRANSPORT_SOURCE_SHA256 = "7d85d67480bb58532c8b1c30b80697305a5b470115cbae944c2cf762384ff5df";
const OUTER_PREFIX = "$ErrorActionPreference='Stop';$z=[Convert]::FromBase64String('";
const OUTER_SUFFIX = "');$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($z),[IO.Compression.CompressionMode]::Decompress);&([ScriptBlock]::Create([IO.StreamReader]::new($g).ReadToEnd()))";

export interface Candidate18Config {
  schema: "synthia-m4f-candidate18-parse-only-config.v1";
  parse_id: string;
  candidate19_script_config_path: string;
  candidate19_script_config_sha256: string;
  transport_config_path: string;
  transport_config_sha256: string;
  evidence_directory: string;
  expected_source_sha256: string;
  expected_test_source_sha256: string;
  expected_candidate19_source_sha256: typeof C19_SOURCE_SHA256;
  expected_candidate19_test_source_sha256: typeof C19_TEST_SHA256;
  expected_candidate19_doc_sha256: typeof C19_DOC_SHA256;
  expected_transport_source_sha256: typeof TRANSPORT_SOURCE_SHA256;
}

export interface Candidate18FileFact {
  schema: "synthia-m4f-candidate18-local-file.v1";
  path: string;
  device: number;
  inode: number;
  owner_uid: number;
  mode: number;
  link_count: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
  sha256: string;
}

export interface Candidate18CapturedFile {
  bytes: Buffer;
  fact: Candidate18FileFact;
}

export interface Candidate18Dependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  captureFile(path: string): Candidate18CapturedFile;
  sourceFile(): Candidate18CapturedFile;
  testSourceFile(): Candidate18CapturedFile;
  candidate19SourceFile(): Candidate18CapturedFile;
  candidate19TestSourceFile(): Candidate18CapturedFile;
  candidate19DocFile(): Candidate18CapturedFile;
  transportSourceFile(): Candidate18CapturedFile;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): unknown[];
  now(): Date;
}

export interface Candidate18Payload {
  input: Buffer;
  loader: string;
  command: string;
  input_sha256: string;
  loader_sha256: string;
  command_sha256: string;
  business_script_sha256: string;
  business_script_utf8_length: number;
  outer_loader_sha256: string;
  outer_loader_utf8_length: number;
  compressed_business_script_sha256: string;
  compressed_business_script_length: number;
}

export class Candidate18Failure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_CANDIDATE18_PARSE_ONLY_FAILED"));
  }
}

const CONFIG_KEYS = [
  "candidate19_script_config_path", "candidate19_script_config_sha256", "evidence_directory",
  "expected_candidate19_doc_sha256", "expected_candidate19_source_sha256",
  "expected_candidate19_test_source_sha256", "expected_source_sha256", "expected_test_source_sha256",
  "expected_transport_source_sha256", "parse_id", "schema", "transport_config_path",
  "transport_config_sha256",
] as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 1024
    && !value.includes("/../") && !/[\r\n\0]/u.test(value);
}

function sameFileStat(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink();
}

function capturedFact(path: string, stat: Stats, bytes: Buffer): Candidate18FileFact {
  return {
    schema: "synthia-m4f-candidate18-local-file.v1",
    path,
    device: stat.dev,
    inode: stat.ino,
    owner_uid: stat.uid,
    mode: stat.mode & 0o777,
    link_count: stat.nlink,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    sha256: sha256(bytes),
  };
}

function captureLocalFile(path: string): Candidate18CapturedFile {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("not_regular");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const handleBefore = fstatSync(fd);
    const bytes = readFileSync(fd);
    const handleAfter = fstatSync(fd);
    const after = lstatSync(path);
    if (!sameFileStat(before, handleBefore) || !sameFileStat(handleBefore, handleAfter)
      || !sameFileStat(handleAfter, after)) throw new Error("file_drift");
    return { bytes, fact: capturedFact(path, handleAfter, bytes) };
  } finally {
    closeSync(fd);
  }
}

function fail(code: string, stage: string, extra: Record<string, unknown> = {}): never {
  throw new Candidate18Failure({
    schema: "synthia-m4f-candidate18-parse-only-failure.v1",
    code,
    stage,
    remote_effect_state: stage === "config" || stage === "local_preflight"
      ? "not_started" : "parse_only_unknown",
    retry_permitted: false,
    business_target_body_not_invoked: true,
    outer_loader_target_body_not_invoked: true,
    process_mutation_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    cleanup_performed: false,
    ...extra,
  });
}

export function validateCandidate18Config(value: unknown): Candidate18Config {
  const config = object(value);
  if (!config || !exactKeys(config, CONFIG_KEYS)
    || config.schema !== "synthia-m4f-candidate18-parse-only-config.v1"
    || typeof config.parse_id !== "string" || !SAFE_ID.test(config.parse_id)
    || !safePath(config.candidate19_script_config_path) || !safePath(config.transport_config_path)
    || !safePath(config.evidence_directory)
    || config.expected_candidate19_source_sha256 !== C19_SOURCE_SHA256
    || config.expected_candidate19_test_source_sha256 !== C19_TEST_SHA256
    || config.expected_candidate19_doc_sha256 !== C19_DOC_SHA256
    || config.expected_transport_source_sha256 !== TRANSPORT_SOURCE_SHA256
    || [config.candidate19_script_config_sha256, config.transport_config_sha256,
      config.expected_source_sha256, config.expected_test_source_sha256]
      .some((item) => typeof item !== "string" || !HASH.test(item))) {
    fail("M4F_CANDIDATE18_CONFIG_INVALID", "config");
  }
  return value as Candidate18Config;
}

function decodeJson(bytes: Buffer, code: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(code, "local_preflight");
  }
}

function validateCapturedFile(
  captured: Candidate18CapturedFile,
  expectedPath: string | null,
  expectedSha256: string,
  code: string,
): Candidate18CapturedFile {
  const fact = captured?.fact;
  if (!Buffer.isBuffer(captured?.bytes) || !fact
    || fact.schema !== "synthia-m4f-candidate18-local-file.v1"
    || (expectedPath !== null && fact.path !== expectedPath)
    || !safePath(fact.path) || fact.sha256 !== expectedSha256
    || fact.sha256 !== sha256(captured.bytes) || fact.size !== captured.bytes.length
    || ![fact.device, fact.inode, fact.owner_uid, fact.mode, fact.link_count,
      fact.size, fact.mtime_ms, fact.ctime_ms]
      .every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)
    || fact.link_count !== 1) {
    fail(code, "local_preflight");
  }
  return captured;
}

function captureExpected(
  dependencies: Candidate18Dependencies,
  path: string,
  expectedSha256: string,
  code: string,
): Candidate18CapturedFile {
  let captured: Candidate18CapturedFile;
  try { captured = dependencies.captureFile(path); } catch {
    fail(code, "local_preflight");
  }
  return validateCapturedFile(captured, path, expectedSha256, code);
}

function validateLineageDocuments(
  scriptConfig: Candidate19ScriptConfig,
  files: {
    adjudicationRecord: Candidate18CapturedFile;
    adjudicationReview: Candidate18CapturedFile;
    admissionRecord: Candidate18CapturedFile;
    admissionReview: Candidate18CapturedFile;
  },
): void {
  const adjudication = object(decodeJson(
    files.adjudicationRecord.bytes, "M4F_CANDIDATE18_ADJUDICATION_RECORD_INVALID",
  ));
  const adjudicationReview = object(decodeJson(
    files.adjudicationReview.bytes, "M4F_CANDIDATE18_ADJUDICATION_REVIEW_INVALID",
  ));
  const admission = object(decodeJson(
    files.admissionRecord.bytes, "M4F_CANDIDATE18_ADMISSION_RECORD_INVALID",
  ));
  const admissionReview = object(decodeJson(
    files.admissionReview.bytes, "M4F_CANDIDATE18_ADMISSION_REVIEW_INVALID",
  ));
  const adjudicationAuthorization = object(adjudicationReview?.authorization_boundary);
  const reviewedAdjudication = object(adjudicationReview?.adjudication_record);
  const protectedBaseline = object(admissionReview?.protected_8443_baseline);
  const baselineIdentity = object(protectedBaseline?.identity);
  const baselineWorker = object(protectedBaseline?.worker);
  const baselineAuthorization = object(admissionReview?.authorization_boundary);
  const admissionSnapshot = object(admission?.target_snapshot);
  const admissionIdentity = object(admissionSnapshot?.identity);
  if (!adjudication
    || adjudication.schema !== "synthia-m4f-c17-local-adjudication-record.v1"
    || adjudication.status !== "progress_only_transport_adjudicated"
    || adjudication.eligible_for_separate_cleanup_freeze !== true
    || adjudication.cleanup_execution_authorized !== false
    || adjudication.cleanup_performed !== false || adjudication.source_evidence_mutated !== false
    || adjudication.network_attempted !== false || adjudication.ssh_attempted !== false
    || adjudication.remote_execution_attempted !== false
    || !adjudicationReview
    || adjudicationReview.schema !== "synthia-m4f-c17-local-adjudication-evidence-review.v1"
    || adjudicationReview.adjudication_id !== adjudication.adjudication_id
    || adjudicationReview.diagnostic_id !== adjudication.diagnostic_id
    || adjudicationReview.decision !== "GO_FOR_SEPARATE_CLEANUP_PRODUCTION_FREEZE_ONLY"
    || !reviewedAdjudication
    || reviewedAdjudication.sha256 !== scriptConfig.adjudication_record_sha256
    || !adjudicationAuthorization
    || adjudicationAuthorization.cleanup_execution_authorized !== false
    || adjudicationAuthorization.network_authorized !== false
    || adjudicationAuthorization.ssh_authorized !== false
    || adjudicationAuthorization.remote_execution_authorized !== false
    || !admission || admission.schema !== "synthia-m4f-direct-admission-v2-record.v1"
    || admission.status !== "observed"
    || admission.transport_source_sha256 !== TRANSPORT_SOURCE_SHA256
    || !admissionIdentity || admissionIdentity.computer_name !== scriptConfig.target_computer
    || admissionIdentity.whoami_name !== scriptConfig.target_identity_name
    || admissionIdentity.whoami_sid !== scriptConfig.target_identity_sid
    || !admissionReview
    || admissionReview.schema !== "synthia-m4f-admission-v2-protection-baseline-review.v1"
    || admissionReview.admission_id !== admission.admission_id
    || admissionReview.decision !== "GO_AS_C19_PROTECTED_8443_BASELINE_ONLY"
    || !baselineIdentity || baselineIdentity.computer_name !== scriptConfig.target_computer
    || baselineIdentity.whoami_name !== scriptConfig.target_identity_name
    || baselineIdentity.whoami_sid !== scriptConfig.target_identity_sid
    || !baselineWorker || canonicalJson(baselineWorker) !== canonicalJson(scriptConfig.protected_worker)
    || canonicalJson(protectedBaseline?.listener_exact_set)
      !== canonicalJson(scriptConfig.protected_listeners.map((listener) => ({
        address: listener.local_address, port: listener.local_port, pid: listener.owning_pid,
      })))
    || !baselineAuthorization || baselineAuthorization.cleanup_execution_authorized !== false
    || baselineAuthorization.network_authorized !== false
    || baselineAuthorization.ssh_authorized !== false
    || baselineAuthorization.remote_execution_authorized !== false
    || baselineAuthorization.process_termination_authorized !== false) {
    fail("M4F_CANDIDATE18_LINEAGE_DOCUMENT_INVALID", "local_preflight");
  }
}

function loadInputs(config: Candidate18Config, dependencies: Candidate18Dependencies): {
  scriptConfig: Candidate19ScriptConfig;
  transport: M4fDirectAdmissionConfig;
  scriptConfigBytes: Buffer;
  transportConfigBytes: Buffer;
  fileFacts: Candidate18FileFact[];
} {
  const scriptConfigFile = captureExpected(dependencies, config.candidate19_script_config_path,
    config.candidate19_script_config_sha256, "M4F_CANDIDATE18_SCRIPT_CONFIG_INPUT_INVALID");
  const transportConfigFile = captureExpected(dependencies, config.transport_config_path,
    config.transport_config_sha256, "M4F_CANDIDATE18_TRANSPORT_CONFIG_INPUT_INVALID");
  const scriptConfigBytes = scriptConfigFile.bytes;
  const transportConfigBytes = transportConfigFile.bytes;
  const scriptConfig = validateCandidate19ScriptConfig(
    decodeJson(scriptConfigBytes, "M4F_CANDIDATE18_SCRIPT_CONFIG_INVALID"),
  );
  const transport = validateM4fDirectAdmissionConfig(
    decodeJson(transportConfigBytes, "M4F_CANDIDATE18_TRANSPORT_CONFIG_INVALID"),
  );
  if (scriptConfig.expected_source_sha256 !== C19_SOURCE_SHA256
    || scriptConfig.expected_test_source_sha256 !== C19_TEST_SHA256
    || scriptConfig.expected_transport_source_sha256 !== TRANSPORT_SOURCE_SHA256
    || transport.target.host !== TARGET_HOST || transport.target.port !== 22
    || transport.target.computer_name !== scriptConfig.target_computer
    || transport.target.identity_name !== scriptConfig.target_identity_name
    || transport.target.identity_sid !== scriptConfig.target_identity_sid
    || transport.target.expected_effective_config_sha256 === null) {
    fail("M4F_CANDIDATE18_LINEAGE_OR_TARGET_MISMATCH", "local_preflight");
  }
  const lineage = {
    adjudicationRecord: captureExpected(dependencies, scriptConfig.adjudication_record_path,
      scriptConfig.adjudication_record_sha256, "M4F_CANDIDATE18_ADJUDICATION_RECORD_INVALID"),
    adjudicationReview: captureExpected(dependencies, scriptConfig.adjudication_review_path,
      scriptConfig.adjudication_review_sha256, "M4F_CANDIDATE18_ADJUDICATION_REVIEW_INVALID"),
    admissionRecord: captureExpected(dependencies, scriptConfig.admission_record_path,
      scriptConfig.admission_record_sha256, "M4F_CANDIDATE18_ADMISSION_RECORD_INVALID"),
    admissionReview: captureExpected(dependencies, scriptConfig.admission_review_path,
      scriptConfig.admission_review_sha256, "M4F_CANDIDATE18_ADMISSION_REVIEW_INVALID"),
  };
  validateLineageDocuments(scriptConfig, lineage);
  return {
    scriptConfig,
    transport,
    scriptConfigBytes,
    transportConfigBytes,
    fileFacts: [
      scriptConfigFile.fact,
      transportConfigFile.fact,
      lineage.adjudicationRecord.fact,
      lineage.adjudicationReview.fact,
      lineage.admissionRecord.fact,
      lineage.admissionReview.fact,
    ],
  };
}

function validateSources(
  config: Candidate18Config,
  dependencies: Candidate18Dependencies,
): Candidate18FileFact[] {
  const captures: Array<[Candidate18CapturedFile, string, string]> = [
    [dependencies.sourceFile(), config.expected_source_sha256, "M4F_CANDIDATE18_SOURCE_MISMATCH"],
    [dependencies.testSourceFile(), config.expected_test_source_sha256, "M4F_CANDIDATE18_TEST_SOURCE_MISMATCH"],
    [dependencies.candidate19SourceFile(), C19_SOURCE_SHA256, "M4F_CANDIDATE18_C19_SOURCE_MISMATCH"],
    [dependencies.candidate19TestSourceFile(), C19_TEST_SHA256, "M4F_CANDIDATE18_C19_TEST_MISMATCH"],
    [dependencies.candidate19DocFile(), C19_DOC_SHA256, "M4F_CANDIDATE18_C19_DOC_MISMATCH"],
    [dependencies.transportSourceFile(), TRANSPORT_SOURCE_SHA256,
      "M4F_CANDIDATE18_TRANSPORT_SOURCE_MISMATCH"],
  ];
  const facts: Candidate18FileFact[] = [];
  for (const [captured, expected, code] of captures) {
    facts.push(validateCapturedFile(captured, null, expected, code).fact);
  }
  return facts;
}

export function lintCandidate18Loader(loader: string): void {
  const operators = "eq|ne|ceq|cne|replace|match|and|or|not";
  const forbidden = [
    /ScriptBlock\]::Create/iu, /Invoke-Expression/iu, /(?:^|[^\w])iex(?:[^\w]|$)/iu,
    /(?:^|[^\w])&(?:[^\w]|$)/u, /\.Invoke\s*\(/iu, /\.Kill\s*\(/iu, /Stop-Process/iu,
    /taskkill/iu, /Get-Process/iu, /Get-CimInstance/iu, /Get-CimClass/iu,
    /MSFT_NetTCPConnection/iu, /Win32_Process/iu, /Vivado(?:\.exe|\s+-mode)/iu, /program_hw/iu,
    /Set-Content/iu, /Add-Content/iu, /Out-File/iu, /New-Item/iu, /\[IO\.File\]/iu,
    /Start-Process/iu, /\[Diagnostics\.Process\]/iu, /(?:^|;)\s*[<>](?:>|&?\d)?\s*/u,
  ];
  const hit = forbidden.find((pattern) => pattern.test(loader));
  if (hit
    || new RegExp("[^\\s]-(?:" + operators + ")\\b", "iu").test(loader)
    || new RegExp("-(?:" + operators + ")[^\\s]", "iu").test(loader)
    || /[^\s]\||\|[^\s]/u.test(loader) || /[^\s]&|&[^\s]/u.test(loader)
    || /\b(?:if|else|foreach|while)\(/iu.test(loader)
    || /function\s+(?:h|hash|sha|sha256)\b/iu.test(loader)
    || !loader.includes("[Management.Automation.Language.Parser]::ParseInput")
    || (loader.match(/\[Management\.Automation\.Language\.Parser\]::ParseInput/gu)?.length ?? 0) !== 2) {
    throw new Error("M4F_CANDIDATE18_LOADER_INVALID:" + String(hit ?? "shape"));
  }
}

export function validateCandidate18OuterInput(
  input: Buffer,
  scriptConfig: Candidate19ScriptConfig,
): void {
  const target = buildCandidate19Payload(scriptConfig);
  const expected = Buffer.from(target.outer_loader, "utf8");
  if (input.length !== expected.length || sha256(input) !== target.outer_loader_sha256
    || !input.equals(expected) || input.some((byte) => byte > 0x7f)) {
    throw new Error("M4F_CANDIDATE18_OUTER_INPUT_INVALID");
  }
  const outer = new TextDecoder("utf-8", { fatal: true }).decode(input);
  if (!outer.startsWith(OUTER_PREFIX) || !outer.endsWith(OUTER_SUFFIX)
    || outer.indexOf(OUTER_PREFIX) !== outer.lastIndexOf(OUTER_PREFIX)
    || outer.indexOf(OUTER_SUFFIX) !== outer.lastIndexOf(OUTER_SUFFIX)) {
    throw new Error("M4F_CANDIDATE18_OUTER_INPUT_INVALID");
  }
  const encoded = outer.slice(OUTER_PREFIX.length, -OUTER_SUFFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error("M4F_CANDIDATE18_OUTER_INPUT_INVALID");
  }
  const compressed = Buffer.from(encoded, "base64");
  if (compressed.toString("base64") !== encoded
    || compressed.length !== target.compressed_business_script.length
    || sha256(compressed) !== sha256(target.compressed_business_script)
    || !compressed.equals(target.compressed_business_script)) {
    throw new Error("M4F_CANDIDATE18_OUTER_INPUT_INVALID");
  }
  const businessBytes = gunzipSync(compressed);
  const business = new TextDecoder("utf-8", { fatal: true }).decode(businessBytes);
  if (businessBytes.length !== Buffer.byteLength(target.business_script, "utf8")
    || sha256(businessBytes) !== target.business_script_sha256
    || business !== target.business_script) {
    throw new Error("M4F_CANDIDATE18_OUTER_INPUT_INVALID");
  }
}

export function buildCandidate18Payload(scriptConfig: Candidate19ScriptConfig): Candidate18Payload {
  const target = buildCandidate19Payload(scriptConfig);
  if (!target.outer_loader.startsWith(OUTER_PREFIX) || !target.outer_loader.endsWith(OUTER_SUFFIX)
    || target.outer_loader.indexOf(OUTER_PREFIX) !== target.outer_loader.lastIndexOf(OUTER_PREFIX)
    || target.outer_loader.indexOf(OUTER_SUFFIX) !== target.outer_loader.lastIndexOf(OUTER_SUFFIX)) {
    fail("M4F_CANDIDATE18_OUTER_SHAPE_INVALID", "local_preflight");
  }
  const input = Buffer.from(target.outer_loader, "utf8");
  validateCandidate18OuterInput(input, scriptConfig);
  const inputHash = sha256(input);
  const businessLength = Buffer.byteLength(target.business_script, "utf8");
  const outerLength = Buffer.byteLength(target.outer_loader, "utf8");
  const compressedHash = sha256(target.compressed_business_script);
  const loader = "$ErrorActionPreference='Stop';"
    + "$o=[Console]::In.ReadToEnd();$u=[Text.Encoding]::UTF8;"
    + "function Get-SynC18Hash($q){([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($q)) -replace '-','').ToLowerInvariant()};"
    + `$ob=$u.GetBytes($o);$oh=Get-SynC18Hash $ob;if ($ob.Length -ne ${outerLength} -or $oh -cne '${target.outer_loader_sha256}'){throw 'O'};`
    + "$p='$ErrorActionPreference=''Stop'';$z=[Convert]::FromBase64String(''';"
    + "$s=''');$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($z),[IO.Compression.CompressionMode]::Decompress);'+[char]38+'([Script'+'Block]::Cre'+'ate([IO.StreamReader]::new($g).ReadToEnd()))';"
    + "if ( -not $o.StartsWith($p) -or -not $o.EndsWith($s) -or $o.IndexOf($p) -ne $o.LastIndexOf($p) -or $o.IndexOf($s) -ne $o.LastIndexOf($s)){throw 'S'};"
    + "$x=$o.Substring($p.Length,$o.Length-$p.Length-$s.Length);if ($x.Length -eq 0 -or $x -match '[^A-Za-z0-9+/=]'){throw 'B'};"
    + "$z=[Convert]::FromBase64String($x);if ([Convert]::ToBase64String($z) -cne $x){throw 'C'};"
    + `if ($z.Length -ne ${target.compressed_business_script.length} -or (Get-SynC18Hash $z) -cne '${compressedHash}'){throw 'G'};`
    + "$m=[IO.MemoryStream]::new();$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($z),[IO.Compression.CompressionMode]::Decompress);$g.CopyTo($m);$g.Dispose();$bb=$m.ToArray();"
    + `$bh=Get-SynC18Hash $bb;if ($bb.Length -ne ${businessLength} -or $bh -cne '${target.business_script_sha256}'){throw 'I'};`
    + "$v=[Text.UTF8Encoding]::new($false,$true);$b=$v.GetString($bb);"
    + "$ot=$null;$oe=$null;$oa=[Management.Automation.Language.Parser]::ParseInput($o,[ref]$ot,[ref]$oe);"
    + "$bt=$null;$be=$null;$ba=[Management.Automation.Language.Parser]::ParseInput($b,[ref]$bt,[ref]$be);"
    + "$ok=$oe.Count -eq 0 -and $be.Count -eq 0 -and $oa.GetType().FullName -ceq 'System.Management.Automation.Language.ScriptBlockAst' -and $ba.GetType().FullName -ceq 'System.Management.Automation.Language.ScriptBlockAst' -and $null -ne $oa.EndBlock -and $null -ne $ba.EndBlock;"
    + "$r=[ordered]@{s='c18p1';z=$(if ($ok){'ok'}else{'no'});i=$oh;l=$ob.Length;e=$PSVersionTable.PSEdition;v=$PSVersionTable.PSVersion.ToString();b=[ordered]@{h=$bh;l=$bb.Length;c=$be.Count;a=$ba.GetType().FullName;n=($null -ne $ba.EndBlock);i=$true};o=[ordered]@{h=$oh;l=$ob.Length;c=$oe.Count;a=$oa.GetType().FullName;n=($null -ne $oa.EndBlock);i=$true}};"
    + "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Out.WriteLine(($r | ConvertTo-Json -Compress -Depth 5));[Console]::Out.Flush();if ( -not $ok){exit 2}";
  lintCandidate18Loader(loader);
  const encoded = Buffer.from(loader, "utf16le").toString("base64");
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    + encoded;
  if (command.length > COMMAND_LIMIT || command.length > WINDOWS_COMMAND_LIMIT) {
    fail("M4F_CANDIDATE18_COMMAND_TOO_LONG", "local_preflight", { command_length: command.length });
  }
  return {
    input,
    loader,
    command,
    input_sha256: inputHash,
    loader_sha256: sha256(loader),
    command_sha256: sha256(Buffer.from(command, "ascii")),
    business_script_sha256: target.business_script_sha256,
    business_script_utf8_length: businessLength,
    outer_loader_sha256: target.outer_loader_sha256,
    outer_loader_utf8_length: outerLength,
    compressed_business_script_sha256: compressedHash,
    compressed_business_script_length: target.compressed_business_script.length,
  };
}

function buildContext(rawConfig: unknown, dependencies: Candidate18Dependencies) {
  const config = validateCandidate18Config(rawConfig);
  const sourceFacts = validateSources(config, dependencies);
  const inputs = loadInputs(config, dependencies);
  const payload = buildCandidate18Payload(inputs.scriptConfig);
  return { config, ...inputs, payload, sourceFacts };
}

function frozenFacts(context: ReturnType<typeof buildContext>): Candidate18FileFact[] {
  return [...context.sourceFacts, ...context.fileFacts];
}

function assertContextStable(
  initial: ReturnType<typeof buildContext>,
  refreshed: ReturnType<typeof buildContext>,
  stage: string,
): void {
  if (canonicalJson(frozenFacts(initial)) !== canonicalJson(frozenFacts(refreshed))
    || !initial.scriptConfigBytes.equals(refreshed.scriptConfigBytes)
    || !initial.transportConfigBytes.equals(refreshed.transportConfigBytes)
    || initial.payload.input_sha256 !== refreshed.payload.input_sha256
    || initial.payload.loader_sha256 !== refreshed.payload.loader_sha256
    || initial.payload.command_sha256 !== refreshed.payload.command_sha256) {
    fail("M4F_CANDIDATE18_FROZEN_INPUT_DRIFT", stage);
  }
}

export function planCandidate18(rawConfig: unknown, dependencies: Candidate18Dependencies): Record<string, unknown> {
  const context = buildContext(rawConfig, dependencies);
  return {
    schema: "synthia-m4f-candidate18-parse-only-plan.v1",
    status: "planned_not_executed",
    parse_id: context.config.parse_id,
    target_host: context.transport.target.host,
    target_computer: context.transport.target.computer_name,
    candidate19_script_config_sha256: context.config.candidate19_script_config_sha256,
    candidate19_script_config_canonical_sha256: candidate19ScriptConfigSha256(context.scriptConfig),
    candidate19_source_sha256: C19_SOURCE_SHA256,
    candidate19_test_source_sha256: C19_TEST_SHA256,
    candidate19_doc_sha256: C19_DOC_SHA256,
    transport_source_sha256: TRANSPORT_SOURCE_SHA256,
    input_sha256: context.payload.input_sha256,
    input_length: context.payload.input.length,
    loader_sha256: context.payload.loader_sha256,
    command_sha256: context.payload.command_sha256,
    command_length: context.payload.command.length,
    business_script_sha256: context.payload.business_script_sha256,
    business_script_utf8_length: context.payload.business_script_utf8_length,
    outer_loader_sha256: context.payload.outer_loader_sha256,
    outer_loader_utf8_length: context.payload.outer_loader_utf8_length,
    compressed_business_script_sha256: context.payload.compressed_business_script_sha256,
    compressed_business_script_length: context.payload.compressed_business_script_length,
    frozen_file_facts: [...context.sourceFacts, ...context.fileFacts],
    parser_required: "Windows PowerShell Desktop 5.1",
    parse_target_count: 2,
    attempt_count: 1,
    effective_timeout_ms: EFFECTIVE_TIMEOUT_MS,
    remote_timeout_ms: REMOTE_TIMEOUT_MS,
    business_target_body_not_invoked: true,
    outer_loader_target_body_not_invoked: true,
    network_attempted: false,
    process_mutation_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    cleanup_performed: false,
    retry_permitted: false,
  };
}

export function candidate18Confirmation(rawConfig: unknown, dependencies: Candidate18Dependencies): string {
  const config = validateCandidate18Config(rawConfig);
  const plan = planCandidate18(config, dependencies);
  return [
    "SYNTHIA_M4F_CANDIDATE18_DUAL_WINDOWS_PARSE_ONLY",
    config.parse_id,
    sha256(canonicalJson(config) + "\n"),
    sha256(canonicalJson(plan) + "\n"),
    config.expected_source_sha256,
    config.expected_test_source_sha256,
    C19_SOURCE_SHA256,
    C19_TEST_SHA256,
    C19_DOC_SHA256,
    TRANSPORT_SOURCE_SHA256,
  ].join(":");
}

export function planCandidate18Envelope(
  rawConfig: unknown,
  dependencies: Candidate18Dependencies,
): Record<string, unknown> {
  const config = validateCandidate18Config(rawConfig);
  const plan = planCandidate18(config, dependencies);
  return {
    ...plan,
    config_sha256: sha256(canonicalJson(config) + "\n"),
    plan_sha256: sha256(canonicalJson(plan) + "\n"),
    confirmation: candidate18Confirmation(config, dependencies),
  };
}

const TARGET_RESULT_KEYS = ["a", "c", "h", "i", "l", "n"] as const;

function validateTargetResult(
  value: unknown,
  expectedHash: string,
  expectedLength: number,
): Record<string, unknown> | null {
  const target = object(value);
  if (!target || !exactKeys(target, TARGET_RESULT_KEYS)
    || target.h !== expectedHash || target.l !== expectedLength || target.c !== 0
    || target.a !== "System.Management.Automation.Language.ScriptBlockAst"
    || target.n !== true || target.i !== true) return null;
  return target;
}

export function validateCandidate18Result(stdout: Buffer, payload: Candidate18Payload): Record<string, unknown> {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(stdout); } catch {
    return fail("M4F_CANDIDATE18_OUTPUT_INVALID", "output_validation");
  }
  if (!(text.endsWith("\r\n") || text.endsWith("\n"))) {
    return fail("M4F_CANDIDATE18_OUTPUT_INVALID", "output_validation");
  }
  const line = text.endsWith("\r\n") ? text.slice(0, -2) : text.slice(0, -1);
  if (line.includes("\r") || line.includes("\n")) {
    return fail("M4F_CANDIDATE18_OUTPUT_INVALID", "output_validation");
  }
  let value: Record<string, unknown> | null = null;
  try { value = object(JSON.parse(line)); } catch { /* rejected below */ }
  const keys = ["b", "e", "i", "l", "o", "s", "v", "z"];
  if (!value || !exactKeys(value, keys)
    || value.s !== "c18p1" || value.z !== "ok"
    || value.i !== payload.input_sha256 || value.l !== payload.input.length
    || value.e !== "Desktop" || typeof value.v !== "string" || !value.v.startsWith("5.1.")
    || !validateTargetResult(value.b, payload.business_script_sha256,
      payload.business_script_utf8_length)
    || !validateTargetResult(value.o, payload.outer_loader_sha256,
      payload.outer_loader_utf8_length)) {
    fail("M4F_CANDIDATE18_OUTPUT_INVALID", "output_validation");
  }
  const business = value.b as Record<string, unknown>;
  const outer = value.o as Record<string, unknown>;
  return {
    schema: "synthia-m4f-candidate18-parse-only-result.v1",
    status: "parsed_not_invoked",
    input_sha256: value.i,
    input_length: value.l,
    powershell_edition: value.e,
    powershell_version: value.v,
    business: {
      target_sha256: business.h, target_utf8_length: business.l,
      parse_error_count: business.c, parser_ast_type: business.a,
      parser_end_block_present: business.n, target_body_not_invoked: business.i,
    },
    outer_loader: {
      target_sha256: outer.h, target_utf8_length: outer.l,
      parse_error_count: outer.c, parser_ast_type: outer.a,
      parser_end_block_present: outer.n, target_body_not_invoked: outer.i,
    },
    process_mutation_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    cleanup_performed: false,
  };
}

function processEvidence(raw: RawProcessResult, stdin: Buffer): Record<string, unknown> {
  return {
    exit_status: raw.status,
    signal: raw.signal,
    error_code: raw.errorCode,
    timed_out: raw.errorCode === "ETIMEDOUT",
    stdin_length: stdin.length,
    stdin_sha256: sha256(stdin),
    stdout_length: raw.stdout.length,
    stdout_sha256: sha256(raw.stdout),
    stderr_length: raw.stderr.length,
    stderr_sha256: sha256(raw.stderr),
    retry_permitted: false,
  };
}

function writeEvidence(directory: string, name: string, value: string | Buffer): void {
  const fd = openSync(directory + "/" + name, "wx", 0o600);
  try { writeFileSync(fd, value); } finally { closeSync(fd); }
  chmodSync(directory + "/" + name, 0o600);
}

export function executeCandidate18(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: Candidate18Dependencies,
): Record<string, unknown> {
  const context = buildContext(rawConfig, dependencies);
  if (confirmation !== candidate18Confirmation(context.config, dependencies)) {
    fail("M4F_CANDIDATE18_CONFIRMATION_REQUIRED", "local_preflight");
  }
  const absolute = resolve(evidenceDirectory);
  if (absolute !== resolve(context.config.evidence_directory)) {
    fail("M4F_CANDIDATE18_EVIDENCE_PATH_MISMATCH", "local_preflight");
  }
  const initial = dependencies.transportInputs(context.transport, "local_preflight");
  try { mkdirSync(absolute, { mode: 0o700 }); chmodSync(absolute, 0o700); } catch {
    fail("M4F_CANDIDATE18_EVIDENCE_INVALID", "local_preflight");
  }
  let remote: RawProcessResult | null = null;
  try {
    writeEvidence(absolute, "parse-config.canonical.json", canonicalJson(context.config) + "\n");
    writeEvidence(absolute, "confirmation.sha256", sha256(confirmation) + "\n");
    writeEvidence(absolute, "candidate19-script-config.raw.json", context.scriptConfigBytes);
    writeEvidence(absolute, "transport-config.raw.json", context.transportConfigBytes);
    writeEvidence(absolute, "target-business-script.ps1",
      buildCandidate19Payload(context.scriptConfig).business_script);
    writeEvidence(absolute, "target-outer-loader.ps1",
      buildCandidate19Payload(context.scriptConfig).outer_loader);
    writeEvidence(absolute, "parse-loader.ps1", context.payload.loader);
    writeEvidence(absolute, "plan.canonical.json",
      canonicalJson(planCandidate18(context.config, dependencies)) + "\n");
    writeEvidence(absolute, "transport-inputs-initial.json", JSON.stringify(initial, null, 2) + "\n");
    writeEvidence(absolute, "frozen-file-facts-initial.json",
      JSON.stringify(frozenFacts(context), null, 2) + "\n");
    const effective = dependencies.spawn(
      SSH_PATH, buildDirectSshEffectiveArguments(context.transport), Buffer.alloc(0), EFFECTIVE_TIMEOUT_MS,
    );
    writeEvidence(absolute, "ssh-effective-stdout.raw", effective.stdout);
    writeEvidence(absolute, "ssh-effective-stderr.raw", effective.stderr);
    writeEvidence(absolute, "ssh-effective-process.json",
      JSON.stringify(processEvidence(effective, Buffer.alloc(0)), null, 2) + "\n");
    if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
      || effective.stderr.length !== 0
      || sha256(effective.stdout) !== context.transport.target.expected_effective_config_sha256) {
      fail("M4F_CANDIDATE18_EFFECTIVE_CONFIG_FAILED", "local_preflight");
    }
    auditDirectSshEffectiveConfig(effective.stdout, context.transport);
    const preContext = buildContext(context.config, dependencies);
    assertContextStable(context, preContext, "local_preflight");
    writeEvidence(absolute, "frozen-file-facts-pre-remote.json",
      JSON.stringify(frozenFacts(preContext), null, 2) + "\n");
    const preRemote = dependencies.transportInputs(context.transport, "network");
    writeEvidence(absolute, "transport-inputs-pre-remote.json", JSON.stringify(preRemote, null, 2) + "\n");
    if (canonicalJson(initial) !== canonicalJson(preRemote)) {
      fail("M4F_CANDIDATE18_TRANSPORT_INPUT_DRIFT", "network");
    }
    remote = dependencies.spawn(
      SSH_PATH,
      [...buildDirectSshOptions(context.transport), TARGET_HOST, context.payload.command],
      context.payload.input,
      REMOTE_TIMEOUT_MS,
    );
    writeEvidence(absolute, "stdout.raw", remote.stdout);
    writeEvidence(absolute, "stderr.raw", remote.stderr);
    writeEvidence(absolute, "remote-process.json",
      JSON.stringify(processEvidence(remote, context.payload.input), null, 2) + "\n");
    const postContext = buildContext(context.config, dependencies);
    assertContextStable(context, postContext, "network_postflight");
    writeEvidence(absolute, "frozen-file-facts-post-remote.json",
      JSON.stringify(frozenFacts(postContext), null, 2) + "\n");
    const postRemote = dependencies.transportInputs(context.transport, "network");
    writeEvidence(absolute, "transport-inputs-post-remote.json", JSON.stringify(postRemote, null, 2) + "\n");
    if (canonicalJson(initial) !== canonicalJson(postRemote)) {
      fail("M4F_CANDIDATE18_TRANSPORT_INPUT_DRIFT", "network_postflight");
    }
    if (remote.status !== 0 || remote.signal !== null || remote.errorCode !== null
      || remote.stderr.length !== 0) {
      fail("M4F_CANDIDATE18_REMOTE_PARSE_FAILED", "network", {
        remote_process: processEvidence(remote, context.payload.input),
      });
    }
    const result = validateCandidate18Result(remote.stdout, context.payload);
    const record = {
      schema: "synthia-m4f-candidate18-parse-only-record.v1",
      status: "parsed_not_invoked",
      parse_id: context.config.parse_id,
      recorded_at_utc: dependencies.now().toISOString(),
      config_sha256: sha256(canonicalJson(context.config) + "\n"),
      confirmation_sha256: sha256(confirmation),
      plan_sha256: sha256(canonicalJson(planCandidate18(context.config, dependencies)) + "\n"),
      candidate19_script_config_sha256: context.config.candidate19_script_config_sha256,
      candidate19_script_config_canonical_sha256: candidate19ScriptConfigSha256(context.scriptConfig),
      candidate19_source_sha256: C19_SOURCE_SHA256,
      candidate19_test_source_sha256: C19_TEST_SHA256,
      candidate19_doc_sha256: C19_DOC_SHA256,
      transport_source_sha256: TRANSPORT_SOURCE_SHA256,
      input_sha256: context.payload.input_sha256,
      input_length: context.payload.input.length,
      loader_sha256: context.payload.loader_sha256,
      command_sha256: context.payload.command_sha256,
      command_length: context.payload.command.length,
      business_script_sha256: context.payload.business_script_sha256,
      business_script_utf8_length: context.payload.business_script_utf8_length,
      outer_loader_sha256: context.payload.outer_loader_sha256,
      outer_loader_utf8_length: context.payload.outer_loader_utf8_length,
      compressed_business_script_sha256: context.payload.compressed_business_script_sha256,
      compressed_business_script_length: context.payload.compressed_business_script_length,
      frozen_file_facts: [...context.sourceFacts, ...context.fileFacts],
      effective_config_sha256: sha256(effective.stdout),
      attempt: 1,
      result,
      process: processEvidence(remote, context.payload.input),
      business_target_body_not_invoked: true,
      outer_loader_target_body_not_invoked: true,
      process_mutation_performed: false,
      file_mutation_performed: false,
      vivado_action_performed: false,
      hardware_action_performed: false,
      cleanup_performed: false,
      retry_permitted: false,
    };
    writeEvidence(absolute, "parse-record.json", JSON.stringify(record, null, 2) + "\n");
    return record;
  } catch (error) {
    try {
      const detail = error instanceof Candidate18Failure ? error.detail : {
        schema: "synthia-m4f-candidate18-parse-only-failure.v1",
        code: "M4F_CANDIDATE18_UNEXPECTED",
        stage: remote === null ? "local_preflight" : "network",
        remote_effect_state: remote === null ? "not_started" : "parse_only_unknown",
        retry_permitted: false,
      };
      writeEvidence(absolute, "parse-failure.json", JSON.stringify({
        ...detail,
        parse_id: context.config.parse_id,
        attempt: remote === null ? 0 : 1,
        remote_process: remote === null ? null : processEvidence(remote, context.payload.input),
        business_target_body_not_invoked: true,
        outer_loader_target_body_not_invoked: true,
        process_mutation_performed: false,
        file_mutation_performed: false,
        vivado_action_performed: false,
        hardware_action_performed: false,
        cleanup_performed: false,
        retry_permitted: false,
      }, null, 2) + "\n");
    } catch { /* preserve the primary failure */ }
    throw error;
  }
}

const systemDependencies: Candidate18Dependencies = {
  spawn(executable, args, stdin, timeoutMs) {
    const result = spawnSync(executable, args, {
      input: stdin,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
      encoding: "buffer",
      windowsHide: true,
    });
    return {
      status: result.status,
      signal: result.signal,
      errorCode: result.error && "code" in result.error ? String(result.error.code) : null,
      stdout: Buffer.from(result.stdout ?? Buffer.alloc(0)),
      stderr: Buffer.from(result.stderr ?? Buffer.alloc(0)),
    };
  },
  captureFile: captureLocalFile,
  sourceFile: () => captureLocalFile(fileURLToPath(new URL(import.meta.url))),
  testSourceFile: () => captureLocalFile(fileURLToPath(
    new URL("../m4f-direct-six-process-parse-only-18.test.ts", import.meta.url),
  )),
  candidate19SourceFile: () => captureLocalFile(fileURLToPath(
    new URL("./m4f-direct-six-process-cleanup-19.ts", import.meta.url),
  )),
  candidate19TestSourceFile: () => captureLocalFile(fileURLToPath(
    new URL("../m4f-direct-six-process-cleanup-19.test.ts", import.meta.url),
  )),
  candidate19DocFile: () => captureLocalFile(fileURLToPath(
    new URL("../M4F-DIRECT-SIX-PROCESS-CLEANUP-18-19.md", import.meta.url),
  )),
  transportSourceFile: () => captureLocalFile(fileURLToPath(
    new URL("./m4f-gate-admission-transport.ts", import.meta.url),
  )),
  transportInputs: (config, stage) => captureM4fDirectTransportInputs(config, stage),
  now: () => new Date(),
};

function main(): void {
  const args = process.argv.slice(2);
  try {
    if (args.length < 3 || args[1] !== "--config") throw new Error("usage");
    const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
    if (args.length === 3 && args[0] === "--plan") {
      process.stdout.write(JSON.stringify(planCandidate18Envelope(raw, systemDependencies)) + "\n");
      return;
    }
    if (args.length === 7 && args[0] === "--execute-parse-only"
      && args[3] === "--confirmation" && args[5] === "--evidence") {
      process.stdout.write(JSON.stringify(executeCandidate18(
        raw, args[4]!, args[6]!, systemDependencies,
      )) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof Candidate18Failure ? error.detail : {
      schema: "synthia-m4f-candidate18-parse-only-failure.v1",
      code: "M4F_CANDIDATE18_UNEXPECTED",
      stage: "unknown",
      remote_effect_state: "parse_only_unknown",
      retry_permitted: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
