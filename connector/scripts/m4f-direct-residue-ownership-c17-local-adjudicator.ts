import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { fileURLToPath } from "node:url";

const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/u;
const UTC_100NS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const C17_EVIDENCE_DIRECTORY = "/private/tmp/synthia-m4f-direct-residue-ownership-prod-20260829-17-evidence";
const C17_DIAGNOSTIC_ID = "m4f-direct-residue-ownership-prod-20260829-17";
const C17_CONFIG_CANONICAL_SHA256 = "b8c44874644aa34918d538b5cc4dff56f342cd2db293e034a3baa5ce158fc3ad";
const C17_STDERR_LENGTH = 810;
const C17_STDERR_SHA256 = "52958a8c061c159decb31dd53806e87dfd41443c208ce951f236d40e05185588";
const C17_STDOUT_LENGTH = 8618;
const C17_STDOUT_SHA256 = "1e8fca53ae9271300ca86190f8ca97a3df6258c3dd64a17b942598ace819f3c5";
const C17_PLAN_SHA256 = "97e4999f2aef46a591b7d1e25d078493adfb32e0cef91d42cb7ddb009d48029d";
const C17_SOURCE_SHA256 = "77b6cbb757a0aca9b8d03b33e1fea0d2310987761196a596ee5d3b921671ae45";
const C17_TEST_SHA256 = "20475984ed9ef7a6cf87c8672ea4ef971feb87e1d4cfddcf01bd2aa3d59dbaba";
const TRANSPORT_SOURCE_SHA256 = "7d85d67480bb58532c8b1c30b80697305a5b470115cbae944c2cf762384ff5df";
const CLOSURE_ROW_LIMIT = 32;

export const C17_EVIDENCE_FILE_HASHES = {
  "admission-config.raw.json": "a9836a641902774cd0b57fcde56dd673e7e49703d27a225afb4211da65089ff5",
  "confirmation.sha256": "53b0926f8aeeaf0b8469e5a7226f2bc0c2cbe6b0754bf594d1d74dc3fadd5e7b",
  "diagnostic-config.canonical.json": C17_CONFIG_CANONICAL_SHA256,
  "markers.json": "e07606c030ce6a947fc6589b7e45614cfa9d100588e35e13b7dd942c2dcfc97f",
  "observation.json": "bfb868f5894f5cc76a359876a15ce69fa8aa9925de314e4138f59d20751412b7",
  "plan.canonical.json": C17_PLAN_SHA256,
  "remote-command.json": "decde722c5e8d3868ca8db3ffd7c7939849d7f831877beed45be849dccbf7acf",
  "remote-process.json": "690a82707e5bc439c1a0ceb45fc9756ad3bc1f92d6784cd2ec1bd0eb9100f6f8",
  "remote-script.ps1": "bc251afa48e8850bdeedd4849603980df65b1de1756d4accf89ec11cdd5c6b57",
  "remote-stderr.raw": C17_STDERR_SHA256,
  "remote-stdout.raw": C17_STDOUT_SHA256,
  "result.json": "8b22d1fe0c1f366475d9a9230c5024fafbb48e858cffe338eaf4d368957dcd50",
  "ssh-effective-process.json": "2d34fe118bf672d91fd797101435aba4edf7c5dea2238babe17253c4c5747159",
  "ssh-effective-stderr.raw": EMPTY_SHA256,
  "ssh-effective-stdout.raw": "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90",
  "transport-inputs-initial.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-post_remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-pre_remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
} as const;

const EVIDENCE_NAMES = Object.keys(C17_EVIDENCE_FILE_HASHES).sort();
const FIXED_LINEAGE = {
  actual_config: {
    path: "/private/tmp/synthia-m4f-direct-residue-ownership-candidate17.json",
    sha256: "c0ab83414454067972bc2ebf03fe15c9b2ded423062826fddd4b952b4c151e40",
  },
  plan: {
    path: "/private/tmp/synthia-m4f-direct-residue-ownership-candidate17-plan.canonical.json",
    sha256: C17_PLAN_SHA256,
  },
  confirmation: {
    path: "/private/tmp/synthia-m4f-direct-residue-ownership-candidate17-confirmation.txt",
    sha256: "eda255abff547781de452ab8e0337cd66edc1e8b93a82912d158d925cd0f7a9c",
  },
  pre_review: {
    path: "/private/tmp/synthia-m4f-direct-residue-ownership-candidate17-review-draft.json",
    sha256: "fad1a17785e581521ee0b1021eb887c3971466f23a878e062bc1bfa509c08362",
  },
  formal_review: {
    path: "/private/tmp/synthia-m4f-direct-residue-ownership-candidate17-review-record.json",
    sha256: "7b516e31ddf1e5e2b150066cfda0b3ac34f44d0ba9a2ae6bd2999521bb5bc93b",
  },
  evidence_review: {
    path: "/private/tmp/synthia-m4f-direct-residue-ownership-candidate17-evidence-review-record.json",
    sha256: "856189d2f1ed6432e747eb91ec326014831a7d528299630ce86be18b3d2e9f82",
  },
  candidate16_review: {
    path: "/private/tmp/synthia-m4f-direct-residue-ownership-candidate16-success-evidence-review-record.json",
    sha256: "74e748d1130fc28b7d51b7c4bd9ad69c99fb259f15e1f8cd6f5e5d71649c7165",
  },
  candidate17_source: {
    path: fileURLToPath(new URL("./m4f-direct-residue-ownership-diagnostic-17.ts", import.meta.url)),
    sha256: C17_SOURCE_SHA256,
  },
  candidate17_test: {
    path: fileURLToPath(new URL("../m4f-direct-residue-ownership-diagnostic-17.test.ts", import.meta.url)),
    sha256: C17_TEST_SHA256,
  },
  transport_source: {
    path: fileURLToPath(new URL("./m4f-gate-admission-transport.ts", import.meta.url)),
    sha256: TRANSPORT_SOURCE_SHA256,
  },
} as const;

type Candidate = "candidate09" | "candidate10";
type Role = "powershell" | "conhost";

export interface StatFact {
  device: number;
  inode: number;
  owner_uid: number;
  mode: number;
  link_count: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
  kind: "file" | "directory";
  symbolic_link: boolean;
}

export interface BoundFileFact extends Omit<StatFact, "kind" | "symbolic_link"> {
  schema: "synthia-m4f-local-bound-file.v1";
  path: string;
  sha256: string;
}

export interface BoundDirectoryFact extends Omit<StatFact, "kind" | "symbolic_link" | "size"> {
  schema: "synthia-m4f-local-bound-directory.v1";
  path: string;
  entries: string[];
}

export interface LocalAdjudicatorConfig {
  schema: "synthia-m4f-c17-local-adjudicator-config.v1";
  adjudication_id: string;
  evidence_directory: BoundDirectoryFact;
  evidence_files: Record<string, BoundFileFact>;
  lineage: Record<string, BoundFileFact>;
  record_path: string;
}

export interface FileCapture {
  path_before: StatFact;
  handle_before: StatFact;
  bytes: Buffer;
  handle_after: StatFact;
  path_after: StatFact;
}

export interface DirectoryCapture {
  before: StatFact;
  entries: string[];
  after: StatFact;
}

export interface LocalAdjudicatorDependencies {
  captureFile(path: string): FileCapture;
  captureDirectory(path: string): DirectoryCapture;
  writeExclusive(path: string, bytes: Buffer): void;
  now(): Date;
}

export interface OwnershipMarker {
  schema: "synthia-m4f-r15.v1";
  diagnostic_id: string;
  ordinal: number;
  stage: "start" | "snapshot" | "complete";
  phase: "start" | "begin" | "end" | "complete";
  status: "started" | "observed" | "unknown" | "complete";
  payload: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

interface ProcessEdge { pid: number; parentPid: number }
interface DetailFact {
  pid: number;
  parentPid: number;
  name: string;
  cimCreationUtc: string | null;
  sessionId: number;
  commandLineSha256: string | null;
  getProcessId: number | null;
  getProcessName: string | null;
  getProcessHasExited: boolean | null;
  getProcessCreationUtc: string | null;
  wrapperShapeExact: boolean | null;
  wrapperCanonicalUtf16le: boolean | null;
  wrapperDecodedUtf8Sha256: string | null;
}

interface Snapshot { edges: ProcessEdge[]; details: DetailFact[] }

export interface OwnershipObservation {
  targets: Array<Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
  cross_candidate_connected: boolean;
  reasons: string[];
}

export interface LocalAdjudicationRecord {
  schema: "synthia-m4f-c17-local-adjudication-record.v1";
  adjudication_id: string;
  diagnostic_id: typeof C17_DIAGNOSTIC_ID;
  status: "progress_only_transport_adjudicated";
  original_status: "partial_unknown";
  original_cleanup_derivation_permitted: false;
  eligible_for_separate_cleanup_freeze: true;
  cleanup_execution_authorized: false;
  cleanup_performed: false;
  source_evidence_mutated: false;
  record_created: boolean;
  network_attempted: false;
  ssh_attempted: false;
  remote_execution_attempted: false;
  stderr_adjudication: Record<string, unknown>;
  stdout_adjudication: Record<string, unknown>;
  process_adjudication: Record<string, unknown>;
  input_bindings: Record<string, unknown>;
  recorded_at_utc: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code: string): never {
  throw new Error(code);
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !/[\r\n\0]/u.test(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function statFact(stat: Stats): StatFact {
  return {
    device: stat.dev,
    inode: stat.ino,
    owner_uid: stat.uid,
    mode: stat.mode & 0o777,
    link_count: stat.nlink,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    kind: stat.isDirectory() ? "directory" : "file",
    symbolic_link: stat.isSymbolicLink(),
  };
}

function sameStat(left: StatFact, right: StatFact): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function fileFactKeys(): string[] {
  return [
    "schema", "path", "sha256", "device", "inode", "owner_uid", "mode", "link_count",
    "size", "mtime_ms", "ctime_ms",
  ];
}

function validateFileFact(value: unknown): BoundFileFact {
  const fact = object(value);
  if (!fact || !exactKeys(fact, fileFactKeys()) || fact.schema !== "synthia-m4f-local-bound-file.v1"
    || !absolutePath(fact.path) || typeof fact.sha256 !== "string" || !HASH.test(fact.sha256)
    || ![fact.device, fact.inode, fact.owner_uid, fact.mode, fact.link_count, fact.size,
      fact.mtime_ms, fact.ctime_ms].every(finiteNonNegative)) {
    fail("M4F_C17_ADJUDICATOR_CONFIG_INVALID");
  }
  return value as BoundFileFact;
}

function validateDirectoryFact(value: unknown): BoundDirectoryFact {
  const fact = object(value);
  const keys = [
    "schema", "path", "entries", "device", "inode", "owner_uid", "mode", "link_count",
    "mtime_ms", "ctime_ms",
  ];
  if (!fact || !exactKeys(fact, keys) || fact.schema !== "synthia-m4f-local-bound-directory.v1"
    || !absolutePath(fact.path) || !Array.isArray(fact.entries)
    || fact.entries.some((entry) => typeof entry !== "string" || entry.includes("/") || entry.length < 1)
    || canonicalJson(fact.entries) !== canonicalJson([...fact.entries].sort())
    || ![fact.device, fact.inode, fact.owner_uid, fact.mode, fact.link_count,
      fact.mtime_ms, fact.ctime_ms].every(finiteNonNegative)) {
    fail("M4F_C17_ADJUDICATOR_CONFIG_INVALID");
  }
  return value as BoundDirectoryFact;
}

export function validateLocalAdjudicatorConfig(value: unknown): LocalAdjudicatorConfig {
  const config = object(value);
  const files = object(config?.evidence_files);
  const lineage = object(config?.lineage);
  const lineageKeys = [...Object.keys(FIXED_LINEAGE), "adjudicator_source", "adjudicator_test"].sort();
  if (!config || !exactKeys(config, [
    "schema", "adjudication_id", "evidence_directory", "evidence_files", "lineage", "record_path",
  ]) || config.schema !== "synthia-m4f-c17-local-adjudicator-config.v1"
    || typeof config.adjudication_id !== "string" || !SAFE_ID.test(config.adjudication_id)
    || !absolutePath(config.record_path) || config.record_path.startsWith(C17_EVIDENCE_DIRECTORY + "/")
    || !files || !exactKeys(files, EVIDENCE_NAMES) || !lineage || !exactKeys(lineage, lineageKeys)) {
    fail("M4F_C17_ADJUDICATOR_CONFIG_INVALID");
  }
  const directory = validateDirectoryFact(config.evidence_directory);
  if (directory.path !== C17_EVIDENCE_DIRECTORY || directory.mode !== 0o700
    || canonicalJson(directory.entries) !== canonicalJson(EVIDENCE_NAMES)) {
    fail("M4F_C17_ADJUDICATOR_CONFIG_INVALID");
  }
  for (const name of EVIDENCE_NAMES) {
    const fact = validateFileFact(files[name]);
    if (fact.path !== C17_EVIDENCE_DIRECTORY + "/" + name || fact.sha256 !== C17_EVIDENCE_FILE_HASHES[
      name as keyof typeof C17_EVIDENCE_FILE_HASHES
    ] || fact.mode !== 0o600 || fact.link_count !== 1) {
      fail("M4F_C17_ADJUDICATOR_CONFIG_INVALID");
    }
  }
  for (const [name, fixed] of Object.entries(FIXED_LINEAGE)) {
    const fact = validateFileFact(lineage[name]);
    if (fact.path !== fixed.path || fact.sha256 !== fixed.sha256 || fact.link_count !== 1) {
      fail("M4F_C17_ADJUDICATOR_CONFIG_INVALID");
    }
  }
  for (const name of ["adjudicator_source", "adjudicator_test"]) {
    const fact = validateFileFact(lineage[name]);
    const expectedPath = name === "adjudicator_source"
      ? fileURLToPath(new URL(import.meta.url))
      : fileURLToPath(new URL("../m4f-direct-residue-ownership-c17-local-adjudicator.test.ts", import.meta.url));
    if (fact.path !== expectedPath || fact.link_count !== 1) fail("M4F_C17_ADJUDICATOR_CONFIG_INVALID");
  }
  return value as LocalAdjudicatorConfig;
}

function captureFileSystem(path: string): FileCapture {
  let fd: number | null = null;
  try {
    const pathBefore = statFact(lstatSync(path));
    fd = openSync(path, "r");
    const handleBefore = statFact(fstatSync(fd));
    const bytes = readFileSync(fd);
    const handleAfter = statFact(fstatSync(fd));
    const pathAfter = statFact(lstatSync(path));
    return { path_before: pathBefore, handle_before: handleBefore, bytes, handle_after: handleAfter, path_after: pathAfter };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function captureDirectorySystem(path: string): DirectoryCapture {
  const before = statFact(lstatSync(path));
  const entries = readdirSync(path).sort();
  const after = statFact(lstatSync(path));
  return { before, entries, after };
}

function factStat(fact: BoundFileFact): StatFact {
  return {
    device: fact.device, inode: fact.inode, owner_uid: fact.owner_uid, mode: fact.mode,
    link_count: fact.link_count, size: fact.size, mtime_ms: fact.mtime_ms, ctime_ms: fact.ctime_ms,
    kind: "file", symbolic_link: false,
  };
}

function directoryStat(fact: BoundDirectoryFact): StatFact {
  return {
    device: fact.device, inode: fact.inode, owner_uid: fact.owner_uid, mode: fact.mode,
    link_count: fact.link_count, size: 0, mtime_ms: fact.mtime_ms, ctime_ms: fact.ctime_ms,
    kind: "directory", symbolic_link: false,
  };
}

function readBoundFile(fact: BoundFileFact, dependencies: LocalAdjudicatorDependencies): Buffer {
  let captured: FileCapture;
  try { captured = dependencies.captureFile(fact.path); } catch { fail("M4F_C17_ADJUDICATOR_BOUND_FILE_UNAVAILABLE"); }
  const expected = factStat(fact);
  if (!sameStat(captured.path_before, expected) || !sameStat(captured.handle_before, expected)
    || !sameStat(captured.handle_after, expected) || !sameStat(captured.path_after, expected)
    || sha256(captured.bytes) !== fact.sha256) {
    fail("M4F_C17_ADJUDICATOR_BOUND_FILE_DRIFT");
  }
  return captured.bytes;
}

function captureBoundDirectory(
  fact: BoundDirectoryFact,
  dependencies: LocalAdjudicatorDependencies,
): DirectoryCapture {
  let captured: DirectoryCapture;
  try { captured = dependencies.captureDirectory(fact.path); } catch {
    fail("M4F_C17_ADJUDICATOR_EVIDENCE_DIRECTORY_UNAVAILABLE");
  }
  const expected = directoryStat(fact);
  const before = { ...captured.before, size: 0 };
  const after = { ...captured.after, size: 0 };
  if (!sameStat(before, expected) || !sameStat(after, expected)
    || canonicalJson(captured.entries) !== canonicalJson(fact.entries)) {
    fail("M4F_C17_ADJUDICATOR_EVIDENCE_DIRECTORY_DRIFT");
  }
  return captured;
}

export function boundFileFact(path: string): BoundFileFact {
  const captured = captureFileSystem(path);
  if (!sameStat(captured.path_before, captured.handle_before)
    || !sameStat(captured.handle_before, captured.handle_after)
    || !sameStat(captured.handle_after, captured.path_after)
    || captured.handle_after.kind !== "file" || captured.handle_after.symbolic_link
    || captured.handle_after.link_count !== 1) fail("M4F_C17_ADJUDICATOR_BOUND_FILE_DRIFT");
  const stat = captured.handle_after;
  return {
    schema: "synthia-m4f-local-bound-file.v1", path, sha256: sha256(captured.bytes),
    device: stat.device, inode: stat.inode, owner_uid: stat.owner_uid, mode: stat.mode,
    link_count: stat.link_count, size: stat.size, mtime_ms: stat.mtime_ms, ctime_ms: stat.ctime_ms,
  };
}

export function boundDirectoryFact(path: string): BoundDirectoryFact {
  const captured = captureDirectorySystem(path);
  if (!sameStat(captured.before, captured.after) || captured.after.kind !== "directory"
    || captured.after.symbolic_link) fail("M4F_C17_ADJUDICATOR_EVIDENCE_DIRECTORY_DRIFT");
  const stat = captured.after;
  return {
    schema: "synthia-m4f-local-bound-directory.v1", path, entries: captured.entries,
    device: stat.device, inode: stat.inode, owner_uid: stat.owner_uid, mode: stat.mode,
    link_count: stat.link_count, mtime_ms: stat.mtime_ms, ctime_ms: stat.ctime_ms,
  };
}

let cp936EncodeTable: Map<string, Buffer> | null = null;

function cp936Table(): Map<string, Buffer> {
  if (cp936EncodeTable) return cp936EncodeTable;
  const table = new Map<string, Buffer>();
  const decoder = new TextDecoder("gbk", { fatal: true });
  for (let value = 0; value <= 0x7f; value += 1) table.set(String.fromCharCode(value), Buffer.from([value]));
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      const bytes = Buffer.from([lead, trail]);
      try {
        const decoded = decoder.decode(bytes);
        if ([...decoded].length === 1 && !table.has(decoded)) table.set(decoded, bytes);
      } catch { /* invalid CP936 pair */ }
    }
  }
  cp936EncodeTable = table;
  return table;
}

function encodeCp936(text: string): Buffer {
  const table = cp936Table();
  const chunks: Buffer[] = [];
  for (const character of text) {
    const bytes = table.get(character);
    if (!bytes) fail("M4F_C17_ADJUDICATOR_CLIXML_CP936_REENCODE_FAILED");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

interface XmlNode {
  name: string;
  attributes: Array<[string, string]>;
  children: Array<XmlNode | string>;
  selfClosing: boolean;
}

class StrictXmlParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parseDocument(): XmlNode {
    if (this.source.includes("<!") || this.source.includes("<?") || this.source.includes("&")) {
      fail("M4F_C17_ADJUDICATOR_CLIXML_FORBIDDEN_MARKUP");
    }
    const node = this.parseNode();
    if (this.index !== this.source.length) fail("M4F_C17_ADJUDICATOR_CLIXML_TRAILING_DATA");
    return node;
  }

  private readName(): string {
    const match = /^[A-Za-z][A-Za-z0-9]*\b/u.exec(this.source.slice(this.index));
    if (!match) fail("M4F_C17_ADJUDICATOR_CLIXML_NAME_INVALID");
    this.index += match[0].length;
    return match[0];
  }

  private parseNode(): XmlNode {
    if (this.source[this.index] !== "<" || this.source[this.index + 1] === "/") {
      fail("M4F_C17_ADJUDICATOR_CLIXML_NODE_INVALID");
    }
    this.index += 1;
    const name = this.readName();
    const attributes: Array<[string, string]> = [];
    const seen = new Set<string>();
    while (this.source[this.index] === " ") {
      if (this.source.slice(this.index, this.index + 3) === " />") {
        this.index += 3;
        return { name, attributes, children: [], selfClosing: true };
      }
      this.index += 1;
      const attributeName = this.readName();
      if (seen.has(attributeName) || this.source.slice(this.index, this.index + 2) !== "=\"") {
        fail("M4F_C17_ADJUDICATOR_CLIXML_ATTRIBUTE_INVALID");
      }
      seen.add(attributeName);
      this.index += 2;
      const end = this.source.indexOf("\"", this.index);
      if (end < 0) fail("M4F_C17_ADJUDICATOR_CLIXML_ATTRIBUTE_INVALID");
      const value = this.source.slice(this.index, end);
      if (/[<>&]/u.test(value)) fail("M4F_C17_ADJUDICATOR_CLIXML_ATTRIBUTE_INVALID");
      attributes.push([attributeName, value]);
      this.index = end + 1;
    }
    if (this.source[this.index] !== ">") fail("M4F_C17_ADJUDICATOR_CLIXML_TAG_INVALID");
    this.index += 1;
    const children: Array<XmlNode | string> = [];
    while (this.source.slice(this.index, this.index + name.length + 3) !== "</" + name + ">") {
      if (this.index >= this.source.length) fail("M4F_C17_ADJUDICATOR_CLIXML_UNCLOSED_NODE");
      if (this.source[this.index] === "<") {
        if (this.source[this.index + 1] === "/") fail("M4F_C17_ADJUDICATOR_CLIXML_CLOSE_MISMATCH");
        children.push(this.parseNode());
      } else {
        const end = this.source.indexOf("<", this.index);
        if (end < 0) fail("M4F_C17_ADJUDICATOR_CLIXML_UNCLOSED_NODE");
        const text = this.source.slice(this.index, end);
        if (text.length === 0 || text.includes("&")) fail("M4F_C17_ADJUDICATOR_CLIXML_TEXT_INVALID");
        children.push(text);
        this.index = end;
      }
    }
    this.index += name.length + 3;
    return { name, attributes, children, selfClosing: false };
  }
}

function xml(
  name: string,
  attributes: Array<[string, string]> = [],
  children: Array<XmlNode | string> = [],
  selfClosing = false,
): XmlNode {
  return { name, attributes, children, selfClosing };
}

function expectedProgressRecord(sourceId: string): XmlNode {
  return xml("MS", [], [
    xml("I64", [["N", "SourceId"]], [sourceId]),
    xml("PR", [["N", "Record"]], [
      xml("AV", [], ["正在准备首次使用模块。"]),
      xml("AI", [], ["0"]),
      xml("Nil", [], [], true),
      xml("PI", [], ["-1"]),
      xml("PC", [], ["-1"]),
      xml("T", [], ["Completed"]),
      xml("SR", [], ["-1"]),
      xml("SD", [], [" "]),
    ]),
  ]);
}

function expectedProgressXml(): XmlNode {
  return xml("Objs", [
    ["Version", "1.1.0.1"],
    ["xmlns", "http://schemas.microsoft.com/powershell/2004/04"],
  ], [
    xml("Obj", [["S", "progress"], ["RefId", "0"]], [
      xml("TN", [["RefId", "0"]], [
        xml("T", [], ["System.Management.Automation.PSCustomObject"]),
        xml("T", [], ["System.Object"]),
      ]),
      expectedProgressRecord("1"),
    ]),
    xml("Obj", [["S", "progress"], ["RefId", "1"]], [
      xml("TNRef", [["RefId", "0"]], [], true),
      expectedProgressRecord("2"),
    ]),
    xml("Obj", [["S", "progress"], ["RefId", "2"]], [
      xml("TNRef", [["RefId", "0"]], [], true),
      expectedProgressRecord("2"),
    ]),
  ]);
}

export function adjudicatePowerShellProgressClixml(bytes: Buffer): Record<string, unknown> {
  const header = Buffer.from("#< CLIXML\r\n", "ascii");
  if (bytes.length !== C17_STDERR_LENGTH || sha256(bytes) !== C17_STDERR_SHA256
    || !bytes.subarray(0, header.length).equals(header)) {
    fail("M4F_C17_ADJUDICATOR_STDERR_FROZEN_BYTES_MISMATCH");
  }
  const xmlBytes = bytes.subarray(header.length);
  let decoded: string;
  try { decoded = new TextDecoder("gbk", { fatal: true }).decode(xmlBytes); } catch {
    fail("M4F_C17_ADJUDICATOR_CLIXML_CP936_DECODE_FAILED");
  }
  if (!encodeCp936(decoded).equals(xmlBytes)) fail("M4F_C17_ADJUDICATOR_CLIXML_CP936_ROUNDTRIP_FAILED");
  const parsed = new StrictXmlParser(decoded).parseDocument();
  if (canonicalJson(parsed) !== canonicalJson(expectedProgressXml())) {
    fail("M4F_C17_ADJUDICATOR_CLIXML_SEMANTIC_MISMATCH");
  }
  return {
    classification: "powershell_progress_clixml_only",
    encoding: "CP936_GBK_FATAL_EXACT_ROUNDTRIP",
    header: "#< CLIXML\\r\\n",
    byte_length: bytes.length,
    sha256: sha256(bytes),
    root_namespace: "http://schemas.microsoft.com/powershell/2004/04",
    root_version: "1.1.0.1",
    object_count: 3,
    stream: "progress",
    ref_ids: ["0", "1", "2"],
    source_ids: ["1", "2", "2"],
    records: ["Completed", "Completed", "Completed"],
    message: "正在准备首次使用模块。",
    forbidden_stream_count: 0,
    trailing_byte_length: 0,
  };
}

function safePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validUtc(value: unknown): value is string {
  return typeof value === "string" && UTC_100NS.test(value) && !Number.isNaN(Date.parse(value));
}

function comparableUtc(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,7})Z$/u.exec(value);
  if (!match) fail("M4F_C17_ADJUDICATOR_TIMESTAMP_INVALID");
  return match[1]! + "." + match[2]!.padEnd(7, "0") + "Z";
}

function cimCorrelatesWithHandle(cimValue: string, handleValue: string): boolean {
  if (!UTC_100NS.test(cimValue) || !UTC_100NS.test(handleValue)) return false;
  const cimFraction = cimValue.slice(-8, -1);
  const handleFraction = handleValue.slice(-8, -1);
  return cimFraction.endsWith("0") && cimValue.slice(0, -2) === handleValue.slice(0, -2)
    && cimFraction.slice(0, 6) === handleFraction.slice(0, 6);
}

function parseSnapshot(value: unknown, scriptConfig: Record<string, unknown>): Snapshot | null {
  const payload = object(value);
  const targets = scriptConfig.targets;
  const cmdBindings = scriptConfig.cmd_bindings;
  if (!payload || !exactKeys(payload, ["cc", "d", "e", "n", "rl"]) || payload.cc !== 1
    || payload.rl !== false || !safeInteger(payload.n) || !Array.isArray(payload.e)
    || payload.n !== payload.e.length || !Array.isArray(payload.d)
    || payload.d.length !== 6 || !Array.isArray(targets) || targets.length !== 4
    || !Array.isArray(cmdBindings) || cmdBindings.length !== 2) return null;
  const targetMap = new Map<number, Record<string, unknown>>();
  const cmdMap = new Map<number, Record<string, unknown>>();
  for (const raw of targets) {
    const target = object(raw);
    if (!target || !safePid(target.pid)) return null;
    targetMap.set(target.pid, target);
  }
  for (const raw of cmdBindings) {
    const cmd = object(raw);
    if (!cmd || !safePid(cmd.pid)) return null;
    cmdMap.set(cmd.pid, cmd);
  }
  const edges: ProcessEdge[] = [];
  const edgePids = new Set<number>();
  for (const row of payload.e) {
    if (!Array.isArray(row) || row.length !== 2 || !safePid(row[0]) || edgePids.has(row[0])
      || !safeInteger(row[1])) return null;
    edgePids.add(row[0]);
    edges.push({ pid: row[0], parentPid: row[1] });
  }
  const details: DetailFact[] = [];
  const detailPids = new Set<number>();
  for (const row of payload.d) {
    if (!Array.isArray(row) || row.length !== 13 || !safePid(row[0]) || detailPids.has(row[0])
      || !safeInteger(row[1]) || typeof row[2] !== "string" || row[2] !== row[2].toLowerCase()
      || row[3] !== null && !validUtc(row[3]) || !safeInteger(row[4])
      || row[5] !== null && (typeof row[5] !== "string" || !HASH.test(row[5]))
      || row[6] !== null && !safePid(row[6]) || row[7] !== null && typeof row[7] !== "string"
      || row[8] !== null && typeof row[8] !== "boolean" || row[9] !== null && !validUtc(row[9])
      || row[10] !== null && typeof row[10] !== "boolean" || row[11] !== null && typeof row[11] !== "boolean"
      || row[12] !== null && (typeof row[12] !== "string" || !HASH.test(row[12]))) return null;
    const target = targetMap.get(row[0]);
    const cmd = cmdMap.get(row[0]);
    if (target) {
      if (row[5] === null || row[6] === null || typeof row[7] !== "string"
        || typeof row[8] !== "boolean" || row[9] === null) return null;
      if (target.role === "powershell") {
        if (typeof row[10] !== "boolean" || typeof row[11] !== "boolean"
          || (!row[10] || !row[11]) && row[12] !== null) return null;
      } else if (row[10] !== null || row[11] !== null || row[12] !== null) return null;
    } else if (!cmd || row[5] === null || row.slice(6).some((item) => item !== null)) return null;
    if (!edgePids.has(row[0])) return null;
    detailPids.add(row[0]);
    details.push({
      pid: row[0], parentPid: row[1], name: row[2], cimCreationUtc: row[3], sessionId: row[4],
      commandLineSha256: row[5], getProcessId: row[6], getProcessName: row[7],
      getProcessHasExited: row[8], getProcessCreationUtc: row[9], wrapperShapeExact: row[10],
      wrapperCanonicalUtf16le: row[11], wrapperDecodedUtf8Sha256: row[12],
    });
  }
  if ([...targetMap].some(([pid]) => !detailPids.has(pid))
    || [...detailPids].some((pid) => !targetMap.has(pid) && !cmdMap.has(pid))) return null;
  const edgeParents = new Map(edges.map((edge) => [edge.pid, edge.parentPid]));
  if (details.some((detail) => edgeParents.get(detail.pid) !== detail.parentPid)
    || [...cmdMap].some(([pid]) => edgePids.has(pid) !== detailPids.has(pid))) return null;
  return { edges, details };
}

function validCompletePayload(value: unknown): boolean {
  const payload = object(value);
  return !!payload && exactKeys(payload, ["am", "cd", "cp", "fm", "ha", "pm", "rd", "si", "sm", "va"])
    && payload.rd === 15 && ["am", "cd", "cp", "fm", "ha", "pm", "si", "sm", "va"]
      .every((key) => payload[key] === 0);
}

export function parseOwnershipMarkers(bytes: Buffer, scriptConfig: Record<string, unknown>): OwnershipMarker[] {
  if (bytes.length !== C17_STDOUT_LENGTH || sha256(bytes) !== C17_STDOUT_SHA256) {
    fail("M4F_C17_ADJUDICATOR_STDOUT_FROZEN_BYTES_MISMATCH");
  }
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline !== bytes.length - 1) fail("M4F_C17_ADJUDICATOR_STDOUT_TAIL_INVALID");
  let lines: string[];
  try {
    lines = new TextDecoder("utf8", { fatal: true }).decode(bytes).split(/\r?\n/u);
  } catch { fail("M4F_C17_ADJUDICATOR_STDOUT_UTF8_INVALID"); }
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 4) fail("M4F_C17_ADJUDICATOR_MARKER_COUNT_INVALID");
  const rules = [
    ["start", "start", "observed"], ["snapshot", "begin", "started"],
    ["snapshot", "end", "observed"], ["complete", "complete", "complete"],
  ] as const;
  const markers: OwnershipMarker[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let marker: Record<string, unknown> | null = null;
    try { marker = object(JSON.parse(lines[index]!)); } catch { /* rejected below */ }
    const rule = rules[index]!;
    if (!marker || !exactKeys(marker, ["diagnostic_id", "error", "ordinal", "payload", "phase", "schema", "stage", "status"])
      || marker.schema !== "synthia-m4f-r15.v1" || marker.diagnostic_id !== C17_DIAGNOSTIC_ID
      || marker.ordinal !== index + 1 || marker.stage !== rule[0] || marker.phase !== rule[1]
      || marker.status !== rule[2] || marker.error !== null) {
      fail("M4F_C17_ADJUDICATOR_MARKER_INVALID");
    }
    if (index === 0) {
      const payload = object(marker.payload);
      if (!payload || !exactKeys(payload, ["de"]) || payload.de !== 1) fail("M4F_C17_ADJUDICATOR_MARKER_INVALID");
    } else if (index === 1) {
      const payload = object(marker.payload);
      if (!payload || Object.keys(payload).length !== 0) fail("M4F_C17_ADJUDICATOR_MARKER_INVALID");
    } else if (index === 2) {
      if (!parseSnapshot(marker.payload, scriptConfig)) fail("M4F_C17_ADJUDICATOR_MARKER_INVALID");
    } else if (!validCompletePayload(marker.payload)) fail("M4F_C17_ADJUDICATOR_MARKER_INVALID");
    markers.push(marker as unknown as OwnershipMarker);
  }
  return markers;
}

function descendants(root: number, children: Map<number, number[]>): { pids: Set<number>; overflow: boolean } {
  const pids = new Set<number>();
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (pids.has(child) || child === root) continue;
      pids.add(child);
      if (pids.size > CLOSURE_ROW_LIMIT) return { pids, overflow: true };
      queue.push(child);
    }
  }
  return { pids, overflow: false };
}

function requiredObjectArray(value: unknown, length: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length !== length) fail("M4F_C17_ADJUDICATOR_CONFIG_SEMANTIC_MISMATCH");
  const result = value.map(object);
  if (result.some((item) => item === null)) fail("M4F_C17_ADJUDICATOR_CONFIG_SEMANTIC_MISMATCH");
  return result as Record<string, unknown>[];
}

export function deriveOwnershipObservation(
  markers: OwnershipMarker[],
  scriptConfig: Record<string, unknown>,
): OwnershipObservation {
  const marker = markers[2];
  const snapshot = marker?.stage === "snapshot" && marker.phase === "end"
    ? parseSnapshot(marker.payload, scriptConfig)
    : null;
  if (!snapshot) fail("M4F_C17_ADJUDICATOR_OBSERVATION_UNAVAILABLE");
  const targetBindings = requiredObjectArray(scriptConfig.targets, 4);
  const cmdBindings = requiredObjectArray(scriptConfig.cmd_bindings, 2);
  const attemptWindows = requiredObjectArray(scriptConfig.attempt_windows, 2);
  const hashes = object(scriptConfig.raw_command_hashes);
  if (!hashes || typeof scriptConfig.expected_wrapper_decoded_utf8_sha256 !== "string") {
    fail("M4F_C17_ADJUDICATOR_CONFIG_SEMANTIC_MISMATCH");
  }
  const details = new Map(snapshot.details.map((detail) => [detail.pid, detail]));
  const edgePids = new Set(snapshot.edges.map((edge) => edge.pid));
  const children = new Map<number, number[]>();
  for (const edge of snapshot.edges) {
    const rows = children.get(edge.parentPid) ?? [];
    rows.push(edge.pid);
    children.set(edge.parentPid, rows);
  }
  const reasons = new Set<string>();
  const targets = targetBindings.map((binding): Record<string, unknown> => {
    const candidate = binding.candidate as Candidate;
    const role = binding.role as Role;
    const pid = binding.pid as number;
    const creation = binding.creation_utc as string;
    const name = binding.name as string;
    const detail = details.get(pid);
    const exists = !!detail;
    const nameExact = detail?.name === name;
    const gpExists = detail?.getProcessId !== null && detail?.getProcessId !== undefined;
    const gpIdExact = detail?.getProcessId === pid;
    const gpNameExact = detail?.getProcessName === name;
    const gpHasExited = detail?.getProcessHasExited ?? null;
    const gpCreationExact = detail?.getProcessCreationUtc === creation;
    const cimMicrosecondsMatch = !!detail?.cimCreationUtc && cimCorrelatesWithHandle(detail.cimCreationUtc, creation);
    const expectedCommandHash = role === "powershell" ? hashes.powershell : hashes.conhost;
    const rawCommandExact = detail?.commandLineSha256 === expectedCommandHash;
    const wrapperFull = role === "powershell" ? !!detail && detail.wrapperShapeExact === true
      && detail.wrapperCanonicalUtf16le === true
      && detail.wrapperDecodedUtf8Sha256 === scriptConfig.expected_wrapper_decoded_utf8_sha256
      && rawCommandExact : null;
    const prefix = candidate + "_" + role + "_";
    if (!exists) reasons.add(prefix + "missing");
    if (exists && !nameExact) reasons.add(prefix + "name_mismatch");
    if (exists && !gpExists) reasons.add(prefix + "get_process_missing");
    if (gpExists && !gpIdExact) reasons.add(prefix + "get_process_id_mismatch");
    if (gpExists && !gpNameExact) reasons.add(prefix + "get_process_name_mismatch");
    if (gpExists && gpHasExited !== false) reasons.add(prefix + "get_process_exited_or_unknown");
    if (gpExists && !gpCreationExact) reasons.add(prefix + "get_process_creation_mismatch");
    if (exists && !cimMicrosecondsMatch) reasons.add(prefix + "cim_microseconds_mismatch");
    if (exists && !rawCommandExact) reasons.add(prefix + "raw_command_hash_mismatch");
    if (role === "powershell" && !wrapperFull) reasons.add(candidate + "_wrapper_not_proven");
    return {
      candidate, role, expected_pid: pid, expected_creation_utc: creation, exists, name_exact: nameExact,
      get_process_exists: gpExists, get_process_id_exact: gpIdExact, get_process_name_exact: gpNameExact,
      get_process_has_exited: gpHasExited, get_process_creation_utc: detail?.getProcessCreationUtc ?? null,
      get_process_creation_exact: gpCreationExact, cim_creation_utc: detail?.cimCreationUtc ?? null,
      cim_microseconds_match: cimMicrosecondsMatch, command_line_hash_exact: rawCommandExact,
      session_id: detail?.sessionId ?? null, parent_pid: detail?.parentPid ?? null,
      wrapper_full_proof: wrapperFull, classification: exists ? "unattributed" : "missing",
    };
  });
  const candidates: Array<Record<string, unknown>> = [];
  const candidateClosures = new Map<Candidate, Set<number>>();
  const provisional = new Map<Candidate, boolean>();
  for (const candidate of ["candidate09", "candidate10"] as const) {
    const window = attemptWindows.find((item) => item.candidate === candidate)!;
    const binding = cmdBindings.find((item) => item.candidate === candidate)!;
    const power = targets.find((item) => item.candidate === candidate && item.role === "powershell")!;
    const conhost = targets.find((item) => item.candidate === candidate && item.role === "conhost")!;
    const cmdPid = binding.pid as number;
    const parentSame = power.parent_pid === cmdPid && conhost.parent_pid === cmdPid;
    const cmd = details.get(cmdPid);
    const cmdInGraph = edgePids.has(cmdPid);
    const cmdExact = !!cmd && cmdInGraph && cmd.name === binding.name && cmd.parentPid === binding.parent_pid
      && cmd.cimCreationUtc === binding.creation_utc && cmd.sessionId === binding.session_id
      && cmd.commandLineSha256 === hashes.cmd;
    const cmdState = cmdExact ? "present" : !cmd && !cmdInGraph ? "naturally_exited" : "invalid_or_reused";
    const sameSession = power.session_id !== null && power.session_id === conhost.session_id
      && power.session_id === binding.session_id && (!cmd || power.session_id === cmd.sessionId);
    const attemptWindowMatch = comparableUtc(binding.creation_utc as string) >= comparableUtc(window.started_at_utc as string)
      && comparableUtc(binding.creation_utc as string) <= comparableUtc(window.ended_at_utc as string);
    const cmdEarlier = typeof power.get_process_creation_utc === "string"
      && typeof conhost.get_process_creation_utc === "string"
      && comparableUtc(binding.creation_utc as string) < comparableUtc(power.get_process_creation_utc)
      && comparableUtc(binding.creation_utc as string) < comparableUtc(conhost.get_process_creation_utc);
    const parentPid = binding.parent_pid as number;
    const cmdParentMissing = parentPid > 0 && !edgePids.has(parentPid);
    const closure = new Set<number>([cmdPid, parentPid, power.expected_pid as number, conhost.expected_pid as number]);
    candidateClosures.set(candidate, closure);
    const walked = descendants(cmdPid, children);
    const knownChildren = new Set([power.expected_pid as number, conhost.expected_pid as number]);
    const targetWalks = [
      descendants(power.expected_pid as number, children), descendants(conhost.expected_pid as number, children),
    ];
    const childSetExact = walked.pids.size === knownChildren.size
      && [...walked.pids].every((pid) => knownChildren.has(pid));
    const unknownDescendant = !childSetExact || targetWalks.some((item) => item.pids.size > 0);
    const overflow = walked.overflow || targetWalks.some((item) => item.overflow);
    if (!parentSame) reasons.add(candidate + "_parent_mismatch");
    if (cmdState === "invalid_or_reused") reasons.add(candidate + "_cmd_identity_invalid_or_reused");
    if (!sameSession) reasons.add(candidate + "_session_mismatch");
    if (!attemptWindowMatch) reasons.add(candidate + "_cmd_outside_attempt_window");
    if (!cmdEarlier) reasons.add(candidate + "_cmd_not_earlier_than_children");
    if (!cmdParentMissing) reasons.add(candidate + "_cmd_upstream_not_missing");
    if (unknownDescendant) reasons.add(candidate + "_unknown_descendant");
    if (overflow) reasons.add(candidate + "_closure_overflow");
    const targetExact = power.exists && power.name_exact && power.get_process_exists
      && power.get_process_id_exact && power.get_process_name_exact && power.get_process_has_exited === false
      && power.get_process_creation_exact && power.cim_microseconds_match && power.command_line_hash_exact
      && power.wrapper_full_proof === true && conhost.exists && conhost.name_exact
      && conhost.get_process_exists && conhost.get_process_id_exact && conhost.get_process_name_exact
      && conhost.get_process_has_exited === false && conhost.get_process_creation_exact
      && conhost.cim_microseconds_match && conhost.command_line_hash_exact;
    const owned = !!targetExact && parentSame && cmdState !== "invalid_or_reused" && sameSession
      && attemptWindowMatch && cmdEarlier && cmdParentMissing && !unknownDescendant && !overflow;
    provisional.set(candidate, owned);
    candidates.push({
      candidate, ownership_mode: null, cmd_pid: cmdPid, cmd_creation_utc: binding.creation_utc,
      cmd_parent_pid: parentPid, cmd_parent_missing: cmdParentMissing, same_session: sameSession,
      attempt_window_match: attemptWindowMatch, cmd_earlier_than_children: cmdEarlier,
      unknown_descendant: unknownDescendant, closure_overflow: overflow,
      current_cmd_state: cmdState, cleanup_derivation_permitted: false,
    });
  }
  const left = candidateClosures.get("candidate09")!;
  const right = candidateClosures.get("candidate10")!;
  const crossCandidateConnected = [...left].some((pid) => right.has(pid));
  if (crossCandidateConnected) reasons.add("cross_candidate_connected");
  if (!crossCandidateConnected) {
    for (const candidate of ["candidate09", "candidate10"] as const) {
      if (!provisional.get(candidate)) continue;
      const power = targets.find((item) => item.candidate === candidate && item.role === "powershell")!;
      const conhost = targets.find((item) => item.candidate === candidate && item.role === "conhost")!;
      const observation = candidates.find((item) => item.candidate === candidate)!;
      power.classification = "candidate09_10_stdin_wrapper";
      conhost.classification = "candidate_console_peer";
      observation.ownership_mode = observation.current_cmd_state === "present"
        ? "orphaned_session_residue_cmd_present"
        : "orphaned_session_residue_cmd_naturally_exited";
    }
  }
  return {
    targets,
    candidates,
    cross_candidate_connected: crossCandidateConnected,
    reasons: [...reasons].sort(),
  };
}

function parseJson(bytes: Buffer, code: string): unknown {
  try {
    const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch { fail(code); }
}

function exactJsonBytes(bytes: Buffer, value: unknown): boolean {
  return bytes.equals(Buffer.from(canonicalJson(value) + "\n", "utf8"));
}

function validateTransportSnapshots(
  evidence: Record<string, Buffer>,
  admission: Record<string, unknown>,
): void {
  const initial = parseJson(evidence["transport-inputs-initial.json"]!, "M4F_C17_ADJUDICATOR_TRANSPORT_INVALID");
  const pre = parseJson(evidence["transport-inputs-pre_remote.json"]!, "M4F_C17_ADJUDICATOR_TRANSPORT_INVALID");
  const post = parseJson(evidence["transport-inputs-post_remote.json"]!, "M4F_C17_ADJUDICATOR_TRANSPORT_INVALID");
  if (canonicalJson(initial) !== canonicalJson(pre) || canonicalJson(initial) !== canonicalJson(post)
    || !Array.isArray(initial) || initial.length !== 2) fail("M4F_C17_ADJUDICATOR_TRANSPORT_INVALID");
  const target = object(admission.target);
  if (!target) fail("M4F_C17_ADJUDICATOR_ADMISSION_INVALID");
  const expected = [
    ["identity_file", target.identity_file],
    ["known_hosts_file", target.known_hosts_file],
  ];
  for (let index = 0; index < initial.length; index += 1) {
    const fact = object(initial[index]);
    if (!fact || !exactKeys(fact, [
      "ctime_ms", "device", "inode", "label", "link_count", "mode", "mtime_ms", "owner_uid",
      "path", "schema", "sha256", "size",
    ]) || fact.schema !== "synthia-m4f-direct-local-input.v1" || fact.label !== expected[index]![0]
      || fact.path !== expected[index]![1] || fact.link_count !== 1 || fact.mode !== 0o600
      || typeof fact.sha256 !== "string" || !HASH.test(fact.sha256)
      || ![fact.device, fact.inode, fact.owner_uid, fact.size, fact.mtime_ms, fact.ctime_ms]
        .every(finiteNonNegative)) fail("M4F_C17_ADJUDICATOR_TRANSPORT_INVALID");
  }
}

function auditEffectiveConfig(bytes: Buffer, admission: Record<string, unknown>): void {
  let text: string;
  try { text = new TextDecoder("utf8", { fatal: true }).decode(bytes); } catch {
    fail("M4F_C17_ADJUDICATOR_EFFECTIVE_CONFIG_INVALID");
  }
  const target = object(admission.target);
  if (!target) fail("M4F_C17_ADJUDICATOR_ADMISSION_INVALID");
  const expected: Record<string, string> = {
    hostname: "100.96.223.49", user: "admin", port: "22", batchmode: "yes", connecttimeout: "15",
    connectionattempts: "1", serveraliveinterval: "0", serveralivecountmax: "4",
    numberofpasswordprompts: "0", identityagent: "none", identitiesonly: "yes",
    pubkeyauthentication: "true", passwordauthentication: "no", kbdinteractiveauthentication: "no",
    gssapiauthentication: "no", hostbasedauthentication: "no", preferredauthentications: "publickey",
    stricthostkeychecking: "true", forwardagent: "no", clearallforwardings: "yes",
    permitlocalcommand: "no", controlmaster: "false", controlpersist: "no", warnweakcrypto: "no",
    requesttty: "false", identityfile: String(target.identity_file),
    userknownhostsfile: String(target.known_hosts_file), globalknownhostsfile: "/dev/null",
  };
  const values = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/u)) {
    if (line === "") continue;
    const separator = line.indexOf(" ");
    if (separator < 1) fail("M4F_C17_ADJUDICATOR_EFFECTIVE_CONFIG_INVALID");
    const key = line.slice(0, separator).toLowerCase();
    values.set(key, [...(values.get(key) ?? []), line.slice(separator + 1)]);
  }
  for (const [key, value] of Object.entries(expected)) {
    const observed = values.get(key);
    if (!observed || observed.length !== 1 || observed[0]!.toLowerCase() !== value.toLowerCase()) {
      fail("M4F_C17_ADJUDICATOR_EFFECTIVE_CONFIG_INVALID");
    }
  }
  if (values.has("proxycommand") || values.has("proxyjump")) {
    fail("M4F_C17_ADJUDICATOR_EFFECTIVE_CONFIG_INVALID");
  }
}

function reconstructedC17Plan(
  actual: Record<string, unknown>,
  admission: Record<string, unknown>,
  evidence: Record<string, Buffer>,
): Record<string, unknown> {
  const scriptConfig = object(actual.script_config);
  const target = object(admission.target);
  const command = object(parseJson(evidence["remote-command.json"]!, "M4F_C17_ADJUDICATOR_COMMAND_INVALID"));
  if (!scriptConfig || !target || !command) fail("M4F_C17_ADJUDICATOR_PLAN_REBUILD_FAILED");
  return {
    schema: "synthia-m4f-direct-residue-ownership-plan.v6",
    diagnostic_id: actual.diagnostic_id,
    lineage: "candidate17_after_candidate16_windows_powershell_5_1_parse_success",
    script_config_sha256: actual.script_config_sha256,
    candidate15_failure: scriptConfig.candidate15_failure,
    candidate16_parse_success: actual.candidate16_parse_success,
    evidence_directory: actual.evidence_directory,
    topology: "single_ssh_direct_encoded_command_empty_stdin",
    syntax_gate: "candidate17_static_token_and_balanced_delimiter_v1",
    corrected_foreach_grammar: "foreach ($i in $want)",
    attempt_count: 1,
    retry_permitted: false,
    local_timeout_ms: 25_000,
    local_timeout_kill_signal: "SIGKILL",
    remote_cooperative_deadline_seconds: 15,
    stdin_length: 0,
    cim_snapshot_count: 1,
    get_process_target_count: 4,
    get_process_target_count_basis: "static_proof_four_unique_target_ids_cmd_ids_disjoint_and_guarded_branch",
    full_graph_projection: "pid_parent_edges_only",
    detailed_object_count_maximum: 6,
    pid_zero_excluded: true,
    closure_row_limit: 32,
    wrapper_spacing: "exactly_two_ascii_spaces_after_executable_only",
    wrapper_known_command_sha256: scriptConfig.known_double_space_wrapper_command_sha256,
    remote_script_length: evidence["remote-script.ps1"]!.length,
    remote_script_sha256: sha256(evidence["remote-script.ps1"]!),
    remote_command_length: command.length,
    remote_command_sha256: command.sha256,
    remote_command_length_limit: 7_000,
    windows_command_limit: 8_191,
    first_remote_action: "write_and_flush_start_marker",
    raw_command_line_returned: false,
    raw_command_stored: false,
    process_mutation_performed: false,
    file_mutation_performed: false,
    cleanup_performed: false,
    cleanup_derivation_permitted: false,
    cleanup_requires_separate_authorization: true,
    vivado_action_performed: false,
    hardware_action_performed: false,
    target_host: target.host,
    target_user: target.user,
    network_attempted: false,
  };
}

function validateLineageSemantics(lineage: Record<string, Buffer>): void {
  const draft = object(parseJson(lineage.pre_review!, "M4F_C17_ADJUDICATOR_REVIEW_INVALID"));
  const review = object(parseJson(lineage.formal_review!, "M4F_C17_ADJUDICATOR_REVIEW_INVALID"));
  const c16 = object(parseJson(lineage.candidate16_review!, "M4F_C17_ADJUDICATOR_REVIEW_INVALID"));
  const evidenceReview = object(parseJson(lineage.evidence_review!, "M4F_C17_ADJUDICATOR_REVIEW_INVALID"));
  const draftVerification = object(draft?.verification);
  const reviewBoundary = object(review?.review_boundary);
  const c16Boundary = object(c16?.review_boundary);
  const evidenceReviewGate = object(evidenceReview?.required_next_gate);
  const evidenceReviewBoundary = object(evidenceReview?.review_boundary);
  if (!draft || draft.schema !== "synthia-m4f-direct-residue-ownership-candidate17-review-draft.v1"
    || draft.diagnostic_id !== C17_DIAGNOSTIC_ID || draft.eligible_for_execution !== false
    || !draftVerification || draftVerification.network_attempted !== false
    || draftVerification.ssh_attempted !== false || draftVerification.remote_command_executed !== false
    || !review || review.schema !== "synthia-m4f-direct-residue-ownership-candidate17-review-record.v1"
    || review.diagnostic_id !== C17_DIAGNOSTIC_ID || review.candidate17_execution_authorized !== false
    || review.eligible_for_execution !== false || !reviewBoundary
    || reviewBoundary.candidate17_execution_attempted !== false
    || reviewBoundary.network_attempted_by_reviewer !== false
    || reviewBoundary.ssh_attempted_by_reviewer !== false
    || reviewBoundary.cleanup_requires_separate_future_review_and_authorization !== true
    || !c16 || c16.schema !== "synthia-m4f-direct-residue-ownership-parse-success-evidence-review.v1"
    || c16.candidate16_success_accepted !== true || c16.candidate17_execution_authorized !== false
    || c16.decision !== "GO_FOR_CANDIDATE17_PRODUCTION_FREEZE_ONLY" || !c16Boundary
    || c16Boundary.network_attempted_by_reviewer !== false || c16Boundary.ssh_attempted_by_reviewer !== false
    || !evidenceReview
    || evidenceReview.schema !== "synthia-m4f-direct-residue-ownership-candidate17-evidence-review.v1"
    || evidenceReview.diagnostic_id !== C17_DIAGNOSTIC_ID
    || evidenceReview.decision !== "PARTIAL_UNKNOWN_NO_RETRY_LOCAL_PROGRESS_ONLY_ADJUDICATOR_RECOMMENDED"
    || evidenceReview.original_result_preserved !== true || evidenceReview.original_result_status !== "partial_unknown"
    || evidenceReview.cleanup_freeze_eligible !== false || evidenceReview.cleanup_authorized !== false
    || evidenceReview.retry_permitted !== false || !evidenceReviewGate
    || evidenceReviewGate.local_adjudicator_required !== true
    || evidenceReviewGate.original_partial_unknown_must_not_be_rewritten !== true
    || evidenceReviewGate.remote_retry_forbidden !== true || !evidenceReviewBoundary
    || evidenceReviewBoundary.network_attempted_by_reviewer !== false
    || evidenceReviewBoundary.ssh_attempted_by_reviewer !== false
    || evidenceReviewBoundary.remote_action_performed_by_reviewer !== false) {
    fail("M4F_C17_ADJUDICATOR_REVIEW_INVALID");
  }
}

function validateProcessAndStoredResult(
  evidence: Record<string, Buffer>,
  markers: OwnershipMarker[],
  observation: OwnershipObservation,
): Record<string, unknown> {
  const process = object(parseJson(evidence["remote-process.json"]!, "M4F_C17_ADJUDICATOR_PROCESS_INVALID"));
  const effective = object(parseJson(evidence["ssh-effective-process.json"]!, "M4F_C17_ADJUDICATOR_PROCESS_INVALID"));
  const result = object(parseJson(evidence["result.json"]!, "M4F_C17_ADJUDICATOR_RESULT_INVALID"));
  const storedMarkers = parseJson(evidence["markers.json"]!, "M4F_C17_ADJUDICATOR_MARKER_INVALID");
  const storedObservation = parseJson(evidence["observation.json"]!, "M4F_C17_ADJUDICATOR_OBSERVATION_INVALID");
  const processKeys = [
    "attempt_count", "ended_at_utc", "error_code", "exit_status", "retry_permitted", "signal",
    "started_at_utc", "stderr_length", "stderr_sha256", "stdin_length", "stdin_sha256",
    "stdout_length", "stdout_sha256",
  ];
  const resultKeys = [
    "attempt_count", "cleanup_derivation_permitted", "cleanup_performed", "diagnostic_id", "ended_at_utc",
    "marker_count", "reasons", "retry_permitted", "schema", "started_at_utc", "status", "stdin_length",
    "trailing_fragment_length", "trailing_fragment_sha256",
  ];
  if (!process || !exactKeys(process, processKeys) || process.attempt_count !== 1 || process.exit_status !== 0
    || process.signal !== null || process.error_code !== null || process.stdin_length !== 0
    || process.stdin_sha256 !== EMPTY_SHA256 || process.stdout_length !== C17_STDOUT_LENGTH
    || process.stdout_sha256 !== C17_STDOUT_SHA256 || process.stderr_length !== C17_STDERR_LENGTH
    || process.stderr_sha256 !== C17_STDERR_SHA256 || process.retry_permitted !== false
    || typeof process.started_at_utc !== "string" || typeof process.ended_at_utc !== "string"
    || Number.isNaN(Date.parse(process.started_at_utc)) || Number.isNaN(Date.parse(process.ended_at_utc))
    || Date.parse(process.started_at_utc) > Date.parse(process.ended_at_utc)) {
    fail("M4F_C17_ADJUDICATOR_PROCESS_INVALID");
  }
  if (!effective || !exactKeys(effective, processKeys) || effective.attempt_count !== 0
    || effective.exit_status !== 0 || effective.signal !== null || effective.error_code !== null
    || effective.stdin_length !== 0 || effective.stdin_sha256 !== EMPTY_SHA256
    || effective.stdout_length !== evidence["ssh-effective-stdout.raw"]!.length
    || effective.stdout_sha256 !== sha256(evidence["ssh-effective-stdout.raw"]!)
    || effective.stderr_length !== 0 || effective.stderr_sha256 !== EMPTY_SHA256
    || effective.retry_permitted !== false || evidence["ssh-effective-stderr.raw"]!.length !== 0) {
    fail("M4F_C17_ADJUDICATOR_PROCESS_INVALID");
  }
  if (!result || !exactKeys(result, resultKeys)
    || result.schema !== "synthia-m4f-direct-residue-ownership-result.v6"
    || result.diagnostic_id !== C17_DIAGNOSTIC_ID || result.status !== "partial_unknown"
    || canonicalJson(result.reasons) !== "[]" || result.attempt_count !== 1 || result.stdin_length !== 0
    || result.marker_count !== 4 || result.trailing_fragment_length !== 0
    || result.trailing_fragment_sha256 !== EMPTY_SHA256 || result.retry_permitted !== false
    || result.cleanup_performed !== false || result.cleanup_derivation_permitted !== false
    || canonicalJson(storedMarkers) !== canonicalJson(markers)
    || canonicalJson(storedObservation) !== canonicalJson(observation)
    || observation.reasons.length !== 0
    || observation.candidates.length !== 2
    || observation.candidates.some((candidate) => candidate.cleanup_derivation_permitted !== false
      || !["orphaned_session_residue_cmd_present", "orphaned_session_residue_cmd_naturally_exited"]
        .includes(String(candidate.ownership_mode)))
    || observation.targets.length !== 4
    || observation.targets.some((target) => target.exists !== true || target.name_exact !== true
      || target.get_process_exists !== true || target.get_process_id_exact !== true
      || target.get_process_name_exact !== true || target.get_process_has_exited !== false
      || target.get_process_creation_exact !== true || target.cim_microseconds_match !== true
      || target.command_line_hash_exact !== true
      || target.role === "powershell" && target.wrapper_full_proof !== true)) {
    fail("M4F_C17_ADJUDICATOR_RESULT_INVALID");
  }
  const nonStderrProcessPredicates = process.exit_status === 0 && process.signal === null
    && process.error_code === null;
  const originalProcessOk = nonStderrProcessPredicates && evidence["remote-stderr.raw"]!.length === 0;
  if (!nonStderrProcessPredicates || originalProcessOk) fail("M4F_C17_ADJUDICATOR_PROCESS_CAUSE_INVALID");
  return {
    remote_exit_status: 0,
    remote_signal: null,
    remote_error_code: null,
    attempt_count: 1,
    stdin_length: 0,
    retry_permitted: false,
    all_non_stderr_process_predicates_true: true,
    stderr_was_only_false_process_ok_predicate: true,
  };
}

function adjudicatorInputHashSummary(config: LocalAdjudicatorConfig): Record<string, unknown> {
  return {
    config_sha256: sha256(canonicalJson(config) + "\n"),
    evidence_directory: config.evidence_directory.path,
    evidence_file_count: EVIDENCE_NAMES.length,
    evidence_files: Object.fromEntries(EVIDENCE_NAMES.map((name) => [name, config.evidence_files[name]!.sha256])),
    lineage: Object.fromEntries(Object.entries(config.lineage).map(([name, fact]) => [name, fact.sha256])),
  };
}

export function localAdjudicatorPlan(rawConfig: unknown): Record<string, unknown> {
  const config = validateLocalAdjudicatorConfig(rawConfig);
  return {
    schema: "synthia-m4f-c17-local-adjudicator-plan.v1",
    adjudication_id: config.adjudication_id,
    diagnostic_id: C17_DIAGNOSTIC_ID,
    operation: "adjudicate_frozen_c17_progress_only_locally",
    evidence_file_count: EVIDENCE_NAMES.length,
    record_path: config.record_path,
    status_if_all_checks_pass: "progress_only_transport_adjudicated",
    eligible_for_separate_cleanup_freeze_if_all_checks_pass: true,
    cleanup_execution_authorized: false,
    cleanup_performed: false,
    source_evidence_mutated: false,
    network_attempted: false,
    ssh_attempted: false,
    remote_execution_attempted: false,
    adjudicator_source_sha256: config.lineage.adjudicator_source!.sha256,
    adjudicator_test_sha256: config.lineage.adjudicator_test!.sha256,
  };
}

export function localAdjudicatorConfirmation(rawConfig: unknown): string {
  const config = validateLocalAdjudicatorConfig(rawConfig);
  return [
    "SYNTHIA_M4F_C17_PROGRESS_ONLY_LOCAL_ADJUDICATION",
    config.adjudication_id,
    sha256(canonicalJson(config) + "\n"),
    sha256(canonicalJson(localAdjudicatorPlan(config)) + "\n"),
    config.lineage.adjudicator_source!.sha256,
    config.lineage.adjudicator_test!.sha256,
  ].join(":");
}

export function adjudicateC17Locally(
  rawConfig: unknown,
  dependencies: LocalAdjudicatorDependencies,
): LocalAdjudicationRecord {
  const config = validateLocalAdjudicatorConfig(rawConfig);
  captureBoundDirectory(config.evidence_directory, dependencies);
  const evidence: Record<string, Buffer> = {};
  for (const name of EVIDENCE_NAMES) evidence[name] = readBoundFile(config.evidence_files[name]!, dependencies);
  captureBoundDirectory(config.evidence_directory, dependencies);
  const lineage: Record<string, Buffer> = {};
  for (const [name, fact] of Object.entries(config.lineage)) lineage[name] = readBoundFile(fact, dependencies);
  validateLineageSemantics(lineage);

  const actual = object(parseJson(lineage.actual_config!, "M4F_C17_ADJUDICATOR_CONFIG_SEMANTIC_MISMATCH"));
  const evidenceConfig = object(parseJson(
    evidence["diagnostic-config.canonical.json"]!, "M4F_C17_ADJUDICATOR_CONFIG_SEMANTIC_MISMATCH",
  ));
  const admission = object(parseJson(evidence["admission-config.raw.json"]!, "M4F_C17_ADJUDICATOR_ADMISSION_INVALID"));
  const scriptConfig = object(actual?.script_config);
  if (!actual || !evidenceConfig || !scriptConfig || !admission
    || actual.schema !== "synthia-m4f-direct-residue-ownership-config.v6"
    || actual.diagnostic_id !== C17_DIAGNOSTIC_ID || actual.evidence_directory !== C17_EVIDENCE_DIRECTORY
    || sha256(canonicalJson(actual) + "\n") !== C17_CONFIG_CANONICAL_SHA256
    || !exactJsonBytes(evidence["diagnostic-config.canonical.json"]!, actual)
    || canonicalJson(evidenceConfig) !== canonicalJson(actual)
    || scriptConfig.admission_config_sha256 !== sha256(evidence["admission-config.raw.json"]!)
    || actual.expected_source_sha256 !== C17_SOURCE_SHA256 || actual.expected_test_source_sha256 !== C17_TEST_SHA256
    || scriptConfig.expected_transport_source_sha256 !== TRANSPORT_SOURCE_SHA256) {
    fail("M4F_C17_ADJUDICATOR_CONFIG_SEMANTIC_MISMATCH");
  }
  const rebuiltPlan = reconstructedC17Plan(actual, admission, evidence);
  if (!exactJsonBytes(evidence["plan.canonical.json"]!, rebuiltPlan)
    || !lineage.plan!.equals(evidence["plan.canonical.json"]!)
    || sha256(canonicalJson(rebuiltPlan) + "\n") !== C17_PLAN_SHA256) {
    fail("M4F_C17_ADJUDICATOR_PLAN_REBUILD_FAILED");
  }
  const c17Confirmation = [
    "SYNTHIA_M4F_DIRECT_RESIDUE_OWNERSHIP_17_READ_ONLY", C17_DIAGNOSTIC_ID,
    C17_CONFIG_CANONICAL_SHA256, C17_PLAN_SHA256, C17_SOURCE_SHA256, C17_TEST_SHA256,
  ].join(":");
  if (!lineage.confirmation!.equals(Buffer.from(c17Confirmation + "\n"))
    || !evidence["confirmation.sha256"]!.equals(Buffer.from(sha256(c17Confirmation) + "\n"))) {
    fail("M4F_C17_ADJUDICATOR_CONFIRMATION_REBUILD_FAILED");
  }
  const command = object(parseJson(evidence["remote-command.json"]!, "M4F_C17_ADJUDICATOR_COMMAND_INVALID"));
  if (!command || !exactKeys(command, ["attempt_count", "length", "raw_command_stored", "sha256", "stdin_length"])
    || command.attempt_count !== 1 || command.length !== 6698
    || command.sha256 !== "b31c13f392e1bf3000df9b143a4f78c639ce23224299d131397491f1d761ca06"
    || command.raw_command_stored !== false || command.stdin_length !== 0
    || evidence["remote-script.ps1"]!.length !== 2477
    || sha256(evidence["remote-script.ps1"]!) !== "bc251afa48e8850bdeedd4849603980df65b1de1756d4accf89ec11cdd5c6b57") {
    fail("M4F_C17_ADJUDICATOR_COMMAND_INVALID");
  }
  validateTransportSnapshots(evidence, admission);
  auditEffectiveConfig(evidence["ssh-effective-stdout.raw"]!, admission);
  const stderrAdjudication = adjudicatePowerShellProgressClixml(evidence["remote-stderr.raw"]!);
  const markers = parseOwnershipMarkers(evidence["remote-stdout.raw"]!, scriptConfig);
  const observation = deriveOwnershipObservation(markers, scriptConfig);
  const processAdjudication = validateProcessAndStoredResult(evidence, markers, observation);
  const targetBindings = requiredObjectArray(scriptConfig.targets, 4);
  const cmdBindings = requiredObjectArray(scriptConfig.cmd_bindings, 2);
  return {
    schema: "synthia-m4f-c17-local-adjudication-record.v1",
    adjudication_id: config.adjudication_id,
    diagnostic_id: C17_DIAGNOSTIC_ID,
    status: "progress_only_transport_adjudicated",
    original_status: "partial_unknown",
    original_cleanup_derivation_permitted: false,
    eligible_for_separate_cleanup_freeze: true,
    cleanup_execution_authorized: false,
    cleanup_performed: false,
    source_evidence_mutated: false,
    record_created: false,
    network_attempted: false,
    ssh_attempted: false,
    remote_execution_attempted: false,
    stderr_adjudication: stderrAdjudication,
    stdout_adjudication: {
      byte_length: evidence["remote-stdout.raw"]!.length,
      sha256: sha256(evidence["remote-stdout.raw"]!),
      marker_count: markers.length,
      marker_statuses: markers.map((marker) => marker.status),
      trailing_fragment_length: 0,
      observation_rebuilt_independently: true,
      observation_reasons: observation.reasons,
      target_count: observation.targets.length,
      candidate_count: observation.candidates.length,
      stored_markers_canonical_match: true,
      stored_observation_canonical_match: true,
      observation_semantic_sha256: sha256(canonicalJson(observation) + "\n"),
      owned_target_identities: targetBindings.map((binding) => ({
        candidate: binding.candidate,
        role: binding.role,
        pid: binding.pid,
        name: binding.name,
        creation_utc: binding.creation_utc,
      })),
      owned_cmd_identities: cmdBindings.map((binding) => ({
        candidate: binding.candidate,
        pid: binding.pid,
        name: binding.name,
        creation_utc: binding.creation_utc,
        parent_pid: binding.parent_pid,
        session_id: binding.session_id,
      })),
    },
    process_adjudication: processAdjudication,
    input_bindings: adjudicatorInputHashSummary(config),
    recorded_at_utc: dependencies.now().toISOString(),
  };
}

export function recordC17LocalAdjudication(
  rawConfig: unknown,
  confirmation: string,
  dependencies: LocalAdjudicatorDependencies,
): LocalAdjudicationRecord {
  const config = validateLocalAdjudicatorConfig(rawConfig);
  if (confirmation !== localAdjudicatorConfirmation(config)) fail("M4F_C17_ADJUDICATOR_CONFIRMATION_REQUIRED");
  const record = { ...adjudicateC17Locally(config, dependencies), record_created: true };
  dependencies.writeExclusive(config.record_path, Buffer.from(canonicalJson(record) + "\n"));
  return record;
}

export function createProductionAdjudicatorConfig(
  adjudicationId: string,
  recordPath: string,
): LocalAdjudicatorConfig {
  const evidenceDirectory = boundDirectoryFact(C17_EVIDENCE_DIRECTORY);
  const evidenceFiles = Object.fromEntries(EVIDENCE_NAMES.map((name) => [
    name, boundFileFact(C17_EVIDENCE_DIRECTORY + "/" + name),
  ]));
  const lineage: Record<string, BoundFileFact> = {};
  for (const [name, fixed] of Object.entries(FIXED_LINEAGE)) lineage[name] = boundFileFact(fixed.path);
  lineage.adjudicator_source = boundFileFact(fileURLToPath(new URL(import.meta.url)));
  lineage.adjudicator_test = boundFileFact(fileURLToPath(
    new URL("../m4f-direct-residue-ownership-c17-local-adjudicator.test.ts", import.meta.url),
  ));
  return validateLocalAdjudicatorConfig({
    schema: "synthia-m4f-c17-local-adjudicator-config.v1",
    adjudication_id: adjudicationId,
    evidence_directory: evidenceDirectory,
    evidence_files: evidenceFiles,
    lineage,
    record_path: recordPath,
  });
}

const systemDependencies: LocalAdjudicatorDependencies = {
  captureFile: captureFileSystem,
  captureDirectory: captureDirectorySystem,
  writeExclusive(path, bytes) {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    chmodSync(path, 0o600);
  },
  now: () => new Date(),
};

function main(): void {
  const args = process.argv.slice(2);
  const planning = args.length === 3 && args[0] === "--plan" && args[1] === "--config";
  const adjudicating = args.length === 5 && args[0] === "--adjudicate-local" && args[1] === "--config"
    && args[3] === "--confirmation";
  if (!planning && !adjudicating) {
    process.stderr.write("usage: --plan --config <path> | --adjudicate-local --config <path> --confirmation <exact>\n");
    process.exitCode = 64;
    return;
  }
  const config = validateLocalAdjudicatorConfig(JSON.parse(readFileSync(args[2]!, "utf8")));
  if (planning) {
    const record = adjudicateC17Locally(config, systemDependencies);
    process.stdout.write(JSON.stringify({
      ...localAdjudicatorPlan(config),
      config_sha256: sha256(canonicalJson(config) + "\n"),
      plan_sha256: sha256(canonicalJson(localAdjudicatorPlan(config)) + "\n"),
      confirmation: localAdjudicatorConfirmation(config),
      preflight_status: record.status,
    }) + "\n");
    return;
  }
  const record = recordC17LocalAdjudication(config, args[4]!, systemDependencies);
  process.stdout.write(JSON.stringify({
    adjudication_id: record.adjudication_id,
    status: record.status,
    eligible_for_separate_cleanup_freeze: record.eligible_for_separate_cleanup_freeze,
    cleanup_execution_authorized: false,
    cleanup_performed: false,
    network_attempted: false,
    ssh_attempted: false,
  }) + "\n");
}

if (import.meta.main) main();
