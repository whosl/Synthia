import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// connector/server.ts
import { createServer } from "node:https";
import { createHash as createHash7, randomUUID as randomUUID2 } from "node:crypto";
import { open as open3, readFile as readFile5, stat as stat3, writeFile as writeFile3 } from "node:fs/promises";
import { access as access2, constants as constants2 } from "node:fs/promises";
import { join as join5 } from "node:path";
import { execFile, spawn as spawn2 } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";

// connector/worker.ts
import { chmod as chmod2, link, lstat, mkdir as mkdir2, open, readFile as readFile2, readdir as readdir2, rename, rm, stat as stat2, unlink as unlink2, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";
import { spawnSync as spawnSync2 } from "node:child_process";
import { createReadStream, lstatSync } from "node:fs";
import { createHash as createHash4 } from "node:crypto";

// core/src/hashing.ts
import { createHash, randomUUID } from "node:crypto";
function sha256Hex(data) {
  const h = createHash("sha256");
  if (typeof data === "string") {
    h.update(data, "utf8");
  } else {
    h.update(data);
  }
  return h.digest("hex");
}
var sha256 = sha256Hex;

// connector/evolution-eval.ts
import { createHash as createHash2 } from "node:crypto";
var EVOLUTION_EVAL_RUN_CLASS = "evolution_eval";
var EVOLUTION_EVAL_DISPATCH_SCHEMA = "evolution-eval-dispatch-request.v1";
var EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA = "evolution-eval-ledger-query.v1";
var EVOLUTION_EVAL_OPERATION_CAP_MS = 7200000;
var EVOLUTION_EVAL_SPOOL_HARD_CAP_BYTES = 2147483648;
var EVOLUTION_EVAL_EVIDENCE_LIMITS = Object.freeze({
  entries: 128,
  entryBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  quarantineMs: 24 * 60 * 60 * 1000,
  absoluteRetentionMs: 7 * 24 * 60 * 60 * 1000
});
var EVOLUTION_EVAL_HTTP_BODY_MAX_BYTES = 850 * 1024 * 1024;
var EVOLUTION_EVAL_LIMITS = Object.freeze({
  source: Object.freeze({ files: 4096, bytes: 512 * 1024 * 1024, fileBytes: 4 * 1024 * 1024 }),
  skill: Object.freeze({ files: 512, bytes: 32 * 1024 * 1024, fileBytes: 1024 * 1024 }),
  overlay: Object.freeze({ files: 512, bytes: 32 * 1024 * 1024, fileBytes: 1024 * 1024 }),
  workspace: Object.freeze({ files: 5120, bytes: 576 * 1024 * 1024 })
});
var EVOLUTION_EVAL_OPERATIONS = [
  "validate_sources",
  "simulate",
  "synthesize",
  "implement"
];

class EvolutionEvalProtocolError extends Error {
  code;
  constructor(code, message = code) {
    super(message);
    this.code = code;
    this.name = "EvolutionEvalProtocolError";
  }
}
var HASH_PATTERN = /^[0-9a-f]{64}$/;
var HDL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,127}$/;
var PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
var LEDGER_EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
function sha2562(value) {
  return createHash2("sha256").update(value).digest("hex");
}
function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function record(value, label) {
  if (!isPlainRecord(value))
    fail(`${label} must be a plain object`);
  return value;
}
function exactKeys(value, expected, label) {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string"))
    fail(`${label} contains unsupported fields`);
  const actual = ownKeys.sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    fail(`${label} has a non-canonical shape`);
  }
}
function fail(message, code = "EVOLUTION_EVAL_INVALID_REQUEST") {
  throw new EvolutionEvalProtocolError(code, message);
}
function hasLoneSurrogate(value) {
  for (let index = 0;index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 55296 && code <= 56319) {
      if (index + 1 >= value.length)
        return true;
      const next = value.charCodeAt(index + 1);
      if (next < 56320 || next > 57343)
        return true;
      index += 1;
    } else if (code >= 56320 && code <= 57343) {
      return true;
    }
  }
  return false;
}
function requireEvolutionEvalNfc(value, label = "string") {
  if (hasLoneSurrogate(value) || value.normalize("NFC") !== value)
    fail(`${label} must be valid NFC`);
  return value;
}
function requiredString(value, label, maxBytes = 128) {
  if (typeof value !== "string")
    fail(`${label} must be a string`);
  requireEvolutionEvalNfc(value, label);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} is not a canonical opaque identifier`);
  }
  return value;
}
function hashString(value, label) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value))
    fail(`${label} must be a lowercase SHA-256`);
  return value;
}
function timestamp(value, label) {
  if (typeof value !== "string")
    fail(`${label} must be an absolute timestamp`);
  requireEvolutionEvalNfc(value, label);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || !value.endsWith("Z"))
    fail(`${label} must be an absolute UTC timestamp`);
  return value;
}
function positiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    fail(`${label} is outside its frozen range`);
  }
  return Number(value);
}
function portablePath(value, label) {
  if (typeof value !== "string")
    fail(`${label} must be a path`);
  requireEvolutionEvalNfc(value, label);
  if (!/^[\x00-\x7f]+$/u.test(value) || Buffer.byteLength(value, "utf8") > 512) {
    fail(`${label} is not a portable path`);
  }
  const segments = value.split("/");
  const reservedWindowsName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
  if (segments.length < 1 || segments.length > 32 || segments.some((segment) => !PATH_SEGMENT_PATTERN.test(segment) || /[ .]$/u.test(segment) || reservedWindowsName.test(segment))) {
    fail(`${label} is not a portable path`);
  }
  return value;
}
function portableKey(value) {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}
function strictBase64(value, label, expectedBytes) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail(`${label} is not canonical base64`);
  }
  const maximumEncoded = Math.ceil(expectedBytes / 3) * 4;
  if (value.length > maximumEncoded)
    fail(`${label} exceeds its declared size`, "EVOLUTION_EVAL_RESOURCE_LIMIT");
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== expectedBytes || bytes.toString("base64") !== value)
    fail(`${label} size or encoding differs`);
  return bytes;
}
function extensionMedia(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".v") || lower.endsWith(".vh"))
    return "text/x-verilog";
  if (lower.endsWith(".sv") || lower.endsWith(".svh"))
    return "text/x-systemverilog";
  if (lower.endsWith(".xdc"))
    return "application/x-xdc";
  return;
}
function nonnegativeInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    fail(`${label} is outside its frozen range`, "EVOLUTION_EVAL_RESOURCE_LIMIT");
  }
  return Number(value);
}
function pathArray(value, label, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${label} has an invalid number of paths`);
  }
  const paths = value.map((item, index) => portablePath(item, `${label}[${index}]`));
  if (new Set(paths.map(portableKey)).size !== paths.length)
    fail(`${label} contains a portable collision`);
  return paths;
}
function validateParameters(operation, value) {
  const parameters = record(value, "parameters");
  const keys = {
    validate_sources: ["operation", "source_paths", "top"],
    simulate: ["operation", "source_paths", "testbench", "top"],
    synthesize: ["operation", "part", "source_paths", "top"],
    implement: ["constraint_paths", "generate_trial_bitstream", "operation", "part", "source_paths", "top"]
  };
  exactKeys(parameters, keys[operation], "parameters");
  if (parameters.operation !== operation)
    fail("operation and parameters.operation differ");
  const sourcePaths = pathArray(parameters.source_paths, "source_paths", 1, 512);
  for (const path of sourcePaths) {
    if (!/\.(?:v|vh|sv|svh)$/iu.test(path))
      fail("source_paths contains a forbidden extension");
  }
  if (operation === "validate_sources") {
    if (parameters.top !== null && (typeof parameters.top !== "string" || !HDL_IDENTIFIER_PATTERN.test(parameters.top))) {
      fail("top is not a valid HDL identifier");
    }
  } else if (typeof parameters.top !== "string" || !HDL_IDENTIFIER_PATTERN.test(parameters.top)) {
    fail("top is not a valid HDL identifier");
  }
  if (operation === "simulate" && (typeof parameters.testbench !== "string" || !HDL_IDENTIFIER_PATTERN.test(parameters.testbench)))
    fail("testbench is not a valid HDL identifier");
  if (operation === "synthesize" || operation === "implement") {
    if (typeof parameters.part !== "string" || !PART_PATTERN.test(parameters.part))
      fail("part is invalid");
  }
  if (operation === "implement") {
    const constraints = pathArray(parameters.constraint_paths, "constraint_paths", 0, 128);
    if (constraints.some((path) => !/\.xdc$/iu.test(path)))
      fail("constraint_paths must contain only XDC files");
    if (parameters.generate_trial_bitstream !== true && parameters.generate_trial_bitstream !== false) {
      fail("generate_trial_bitstream must be boolean");
    }
  }
  return structuredClone(parameters);
}
function canonicalEvolutionEvalJson(value) {
  const encode = (item, label) => {
    if (item === null)
      return "null";
    if (typeof item === "boolean")
      return item ? "true" : "false";
    if (typeof item === "string")
      return JSON.stringify(requireEvolutionEvalNfc(item, label));
    if (typeof item === "number") {
      if (!Number.isFinite(item))
        fail(`${label} is not a finite JSON number`);
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      const encoded = [];
      for (let index = 0;index < item.length; index += 1) {
        if (!(index in item))
          fail(`${label} contains an array hole`);
        encoded.push(encode(item[index], `${label}[${index}]`));
      }
      return `[${encoded.join(",")}]`;
    }
    const object = record(item, label);
    const keys = Object.keys(object);
    if (Reflect.ownKeys(object).length !== keys.length)
      fail(`${label} contains unsupported keys`);
    for (const key of keys)
      requireEvolutionEvalNfc(key, `${label} key`);
    keys.sort();
    return `{${keys.map((key) => {
      const member = object[key];
      if (member === undefined || typeof member === "function" || typeof member === "symbol" || typeof member === "bigint") {
        fail(`${label}.${key} is not JSON`);
      }
      return `${JSON.stringify(key)}:${encode(member, `${label}.${key}`)}`;
    }).join(",")}}`;
  };
  return encode(value, "$input");
}
function canonicalEvolutionEvalHash(value) {
  return sha2562(canonicalEvolutionEvalJson(value));
}
function computeEvolutionEvalDispatchRequestHash(dispatch) {
  return canonicalEvolutionEvalHash(dispatch);
}
function validateCoreIssuedEvalBinding(value, expectedProjectId) {
  const binding = record(value, "binding");
  exactKeys(binding, ["dispatch", "dispatch_request_hash", "project_id"], "binding");
  const projectId = requiredString(binding.project_id, "project_id");
  if (expectedProjectId !== undefined && projectId !== requiredString(expectedProjectId, "expected project_id")) {
    fail("binding project_id differs from the remote envelope", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  const requestHash = hashString(binding.dispatch_request_hash, "dispatch_request_hash");
  const dispatch = record(binding.dispatch, "dispatch");
  exactKeys(dispatch, [
    "connector_idempotency_key",
    "connector_job_id",
    "deadline_at",
    "eval_input_ref",
    "eval_job_id",
    "input_manifest_hash",
    "operation",
    "operation_cap_ms",
    "parameters",
    "part",
    "requested_timeout_ms",
    "run_class",
    "schema",
    "sealed_input_projection_hash",
    "toolchain_profile_hash",
    "workspace_id",
    "workspace_manifest_hash",
    "workspace_revision"
  ], "dispatch");
  if (dispatch.schema !== EVOLUTION_EVAL_DISPATCH_SCHEMA || dispatch.run_class !== EVOLUTION_EVAL_RUN_CLASS) {
    fail("dispatch schema or run_class is invalid", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  if (!EVOLUTION_EVAL_OPERATIONS.includes(dispatch.operation)) {
    fail("dispatch operation is forbidden", "EVOLUTION_EVAL_OPERATION_FORBIDDEN");
  }
  const operation = dispatch.operation;
  const canonicalDispatch = {
    schema: EVOLUTION_EVAL_DISPATCH_SCHEMA,
    eval_job_id: requiredString(dispatch.eval_job_id, "eval_job_id"),
    connector_job_id: requiredString(dispatch.connector_job_id, "connector_job_id"),
    connector_idempotency_key: hashString(dispatch.connector_idempotency_key, "connector_idempotency_key"),
    eval_input_ref: requiredString(dispatch.eval_input_ref, "eval_input_ref"),
    input_manifest_hash: hashString(dispatch.input_manifest_hash, "input_manifest_hash"),
    workspace_id: requiredString(dispatch.workspace_id, "workspace_id"),
    workspace_revision: positiveInteger(dispatch.workspace_revision, "workspace_revision", Number.MAX_SAFE_INTEGER),
    workspace_manifest_hash: hashString(dispatch.workspace_manifest_hash, "workspace_manifest_hash"),
    sealed_input_projection_hash: hashString(dispatch.sealed_input_projection_hash, "sealed_input_projection_hash"),
    operation,
    parameters: validateParameters(operation, dispatch.parameters),
    part: dispatch.part === null ? null : requiredString(dispatch.part, "part"),
    toolchain_profile_hash: hashString(dispatch.toolchain_profile_hash, "toolchain_profile_hash"),
    requested_timeout_ms: positiveInteger(dispatch.requested_timeout_ms, "requested_timeout_ms", EVOLUTION_EVAL_OPERATION_CAP_MS),
    operation_cap_ms: positiveInteger(dispatch.operation_cap_ms, "operation_cap_ms", EVOLUTION_EVAL_OPERATION_CAP_MS),
    deadline_at: timestamp(dispatch.deadline_at, "deadline_at"),
    run_class: EVOLUTION_EVAL_RUN_CLASS
  };
  if (canonicalDispatch.operation_cap_ms !== EVOLUTION_EVAL_OPERATION_CAP_MS) {
    fail("operation_cap_ms differs from the frozen policy", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  if (canonicalDispatch.part !== null && !PART_PATTERN.test(canonicalDispatch.part)) {
    fail("dispatch part is invalid", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  if ((canonicalDispatch.parameters.operation === "synthesize" || canonicalDispatch.parameters.operation === "implement") && canonicalDispatch.part !== canonicalDispatch.parameters.part) {
    fail("dispatch part differs from typed parameters", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  if (computeEvolutionEvalDispatchRequestHash(canonicalDispatch) !== requestHash) {
    fail("dispatch_request_hash does not bind the canonical dispatch", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  return structuredClone({ project_id: projectId, dispatch_request_hash: requestHash, dispatch: canonicalDispatch });
}
function evolutionEvalBindingFingerprint(binding) {
  return canonicalEvolutionEvalHash(validateCoreIssuedEvalBinding(binding));
}
function baseQuery(value, expected, expectedEpoch) {
  if (value.schema !== EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA)
    fail("ledger query schema is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
  const connectorJobId = requiredString(value.connector_job_id, "connector_job_id");
  const connectorKey = hashString(value.connector_idempotency_key, "connector_idempotency_key");
  const dispatchHash = hashString(value.dispatch_request_hash, "dispatch_request_hash");
  const epoch = requiredString(value.ledger_epoch, "ledger_epoch");
  if (!LEDGER_EPOCH_PATTERN.test(epoch))
    fail("ledger_epoch is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
  if (connectorJobId !== expected.dispatch.connector_job_id || connectorKey !== expected.dispatch.connector_idempotency_key || dispatchHash !== expected.dispatch_request_hash || expectedEpoch !== undefined && epoch !== expectedEpoch)
    fail("ledger observation binding differs", "EVOLUTION_EVAL_BINDING_CONFLICT");
  return {
    connector_job_id: connectorJobId,
    connector_idempotency_key: connectorKey,
    dispatch_request_hash: dispatchHash,
    ledger_epoch: epoch
  };
}
function validateEvalLedgerQuery(input, expectedBinding, expectedEpoch) {
  const expected = validateCoreIssuedEvalBinding(expectedBinding);
  const value = record(input, "ledger query");
  const common = [
    "connector_idempotency_key",
    "connector_job_id",
    "dispatch_request_hash",
    "ledger_epoch",
    "schema",
    "state"
  ];
  const base = baseQuery(value, expected, expectedEpoch);
  if (typeof value.state !== "string")
    fail("ledger state is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
  if (value.state === "proven_never_accepted") {
    exactKeys(value, [...common, "replay_permitted"], "ledger query");
    if (typeof value.replay_permitted !== "boolean")
      fail("replay_permitted is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    return { schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA, ...base, state: value.state, replay_permitted: value.replay_permitted };
  }
  if (value.state === "accepted") {
    exactKeys(value, [...common, "accepted_at", "execution_state"], "ledger query");
    if (!["queued", "preparing", "running"].includes(value.execution_state)) {
      fail("execution_state is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    }
    return {
      schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA,
      ...base,
      state: value.state,
      execution_state: value.execution_state,
      accepted_at: timestamp(value.accepted_at, "accepted_at")
    };
  }
  if (value.state === "terminal") {
    exactKeys(value, [...common, "error_code", "process_stopped", "terminal_at", "terminal_state"], "ledger query");
    if (!["succeeded", "failed", "cancelled", "timeout"].includes(value.terminal_state)) {
      fail("terminal_state is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    }
    if (value.process_stopped !== true)
      fail("terminal must prove process_stopped", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    if (value.error_code !== null && (typeof value.error_code !== "string" || !ERROR_CODE_PATTERN.test(value.error_code))) {
      fail("terminal error_code is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    }
    return {
      schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA,
      ...base,
      state: value.state,
      terminal_state: value.terminal_state,
      process_stopped: true,
      terminal_at: timestamp(value.terminal_at, "terminal_at"),
      error_code: value.error_code
    };
  }
  if (value.state === "transient_unavailable") {
    exactKeys(value, [...common, "error_code", "retryable"], "ledger query");
    if (value.retryable !== true || typeof value.error_code !== "string" || !ERROR_CODE_PATTERN.test(value.error_code)) {
      fail("transient observation is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    }
    return { schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA, ...base, state: value.state, retryable: true, error_code: value.error_code };
  }
  if (value.state === "ambiguous") {
    exactKeys(value, [...common, "effect_possible", "error_code"], "ledger query");
    if (value.effect_possible !== true || typeof value.error_code !== "string" || !ERROR_CODE_PATTERN.test(value.error_code)) {
      fail("ambiguous observation is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    }
    return { schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA, ...base, state: value.state, effect_possible: true, error_code: value.error_code };
  }
  if (value.state === "ledger_corrupt") {
    exactKeys(value, [...common, "error_code", "replay_permitted"], "ledger query");
    if (value.replay_permitted !== false || typeof value.error_code !== "string" || !ERROR_CODE_PATTERN.test(value.error_code)) {
      fail("corrupt observation is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    }
    return { schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA, ...base, state: value.state, replay_permitted: false, error_code: value.error_code };
  }
  fail("ledger taxonomy is not one of the six frozen states", "EVOLUTION_EVAL_LEDGER_CORRUPT");
}
function evaluateEvolutionEvalDiscoveryPolicy(capabilities, expectedVersion) {
  if (!Array.isArray(capabilities))
    fail("capabilities must be an array", "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
  const selected = {};
  const forbidden = new Set;
  const mismatches = new Set;
  const seenOperations = new Set;
  const knownRunClasses = new Set(["exploratory", "gate_check", "formal", EVOLUTION_EVAL_RUN_CLASS]);
  for (const input of capabilities) {
    const capability = record(input, "capability");
    exactKeys(capability, ["operation", "runClasses", "version"], "capability");
    const operation = requiredString(capability.operation, "capability.operation");
    const version = requiredString(capability.version, "capability.version");
    if (!Array.isArray(capability.runClasses) || capability.runClasses.length === 0) {
      fail("capability.runClasses is invalid", "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    }
    const runClasses = capability.runClasses.map((runClass, index) => requiredString(runClass, `runClasses[${index}]`));
    if (new Set(runClasses).size !== runClasses.length || runClasses.some((runClass) => !knownRunClasses.has(runClass))) {
      fail("capability.runClasses contains duplicates", "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    }
    if (seenOperations.has(operation))
      forbidden.add(operation);
    seenOperations.add(operation);
    const evo = runClasses.includes(EVOLUTION_EVAL_RUN_CLASS);
    if (!EVOLUTION_EVAL_OPERATIONS.includes(operation)) {
      if (evo)
        forbidden.add(operation);
      continue;
    }
    const typedOperation = operation;
    if (evo) {
      selected[typedOperation] = { operation, version, runClasses: [...runClasses] };
      if (expectedVersion !== undefined && version !== expectedVersion)
        mismatches.add(typedOperation);
    }
  }
  const missing = EVOLUTION_EVAL_OPERATIONS.filter((operation) => selected[operation] === undefined);
  return Object.freeze({
    eligible: missing.length === 0 && forbidden.size === 0 && mismatches.size === 0,
    capabilities: Object.freeze(structuredClone(selected)),
    missing_operations: Object.freeze(missing),
    forbidden_operations: Object.freeze([...forbidden].sort()),
    version_mismatches: Object.freeze(EVOLUTION_EVAL_OPERATIONS.filter((operation) => mismatches.has(operation)))
  });
}
function validateEvolutionEvalSealedInput(input, bindingInput) {
  const binding = validateCoreIssuedEvalBinding(bindingInput);
  const value = record(input, "sealed input");
  exactKeys(value, ["files", "manifest", "schema"], "sealed input");
  if (value.schema !== "evolution-eval-sealed-input.v1")
    fail("sealed input schema is invalid");
  const manifestValue = record(value.manifest, "workspace manifest");
  exactKeys(manifestValue, ["files", "revision", "schema", "workspace_id"], "workspace manifest");
  if (manifestValue.schema !== "evolution-eval-workspace-manifest.v1")
    fail("workspace manifest schema is invalid");
  const workspaceId = requiredString(manifestValue.workspace_id, "workspace_id");
  const revision = positiveInteger(manifestValue.revision, "workspace revision", Number.MAX_SAFE_INTEGER);
  if (workspaceId !== binding.dispatch.workspace_id || revision !== binding.dispatch.workspace_revision) {
    fail("workspace identity differs from dispatch", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  if (!Array.isArray(manifestValue.files) || !Array.isArray(value.files) || manifestValue.files.length > EVOLUTION_EVAL_LIMITS.workspace.files) {
    fail("workspace file cardinality differs or exceeds its cap", "EVOLUTION_EVAL_RESOURCE_LIMIT");
  }
  const layerCounts = { source: 0, skill: 0, overlay: 0 };
  const layerBytes = { source: 0, skill: 0, overlay: 0 };
  let workspaceBytes = 0;
  const manifestFiles = [];
  const seen = new Set;
  let previousKey;
  for (let index = 0;index < manifestValue.files.length; index += 1) {
    const file = record(manifestValue.files[index], `manifest.files[${index}]`);
    exactKeys(file, ["layer", "media_type", "path", "read_only", "sha256", "size_bytes"], `manifest.files[${index}]`);
    const path = portablePath(file.path, `manifest.files[${index}].path`);
    const key = portableKey(path);
    if (seen.has(key) || previousKey !== undefined && previousKey >= key)
      fail("manifest paths are not uniquely sorted");
    seen.add(key);
    previousKey = key;
    if (!(file.layer === "source" || file.layer === "overlay")) {
      fail("remote manifest may contain only source/overlay files", "EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    }
    const layer = file.layer;
    if (file.read_only !== (layer !== "overlay"))
      fail("file read_only differs from its layer");
    if (typeof file.media_type !== "string" || file.media_type.length < 1 || file.media_type.length > 128)
      fail("file media_type is invalid");
    const size = nonnegativeInteger(file.size_bytes, "file size", EVOLUTION_EVAL_LIMITS[layer].fileBytes);
    layerCounts[layer] += 1;
    layerBytes[layer] += size;
    workspaceBytes += size;
    if (layerCounts[layer] > EVOLUTION_EVAL_LIMITS[layer].files || layerBytes[layer] > EVOLUTION_EVAL_LIMITS[layer].bytes || workspaceBytes > EVOLUTION_EVAL_LIMITS.workspace.bytes) {
      fail("workspace exceeds a frozen resource budget", "EVOLUTION_EVAL_RESOURCE_LIMIT");
    }
    if (layer === "overlay" && /\.(?:tcl|py|ts|sh|bat|cmd|ps1)$/iu.test(path)) {
      fail("overlay executable assets are forbidden", "EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    }
    manifestFiles.push({
      path,
      sha256: hashString(file.sha256, `manifest.files[${index}].sha256`),
      size_bytes: size,
      media_type: file.media_type,
      layer,
      read_only: file.read_only
    });
  }
  const canonicalManifest = {
    schema: "evolution-eval-workspace-manifest.v1",
    workspace_id: workspaceId,
    revision,
    files: manifestFiles
  };
  const transportedManifestFiles = manifestFiles;
  if (value.files.length !== transportedManifestFiles.length) {
    fail("sealed bytes must be the exact source/overlay projection", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  const decoded = [];
  for (let index = 0;index < value.files.length; index += 1) {
    const file = record(value.files[index], `sealed files[${index}]`);
    exactKeys(file, ["content_base64", "media_type", "path", "sha256", "size_bytes"], `sealed files[${index}]`);
    const manifestFile = transportedManifestFiles[index];
    const path = portablePath(file.path, `sealed files[${index}].path`);
    const digest = hashString(file.sha256, `sealed files[${index}].sha256`);
    const size = nonnegativeInteger(file.size_bytes, `sealed files[${index}].size_bytes`, manifestFile.size_bytes);
    if (path !== manifestFile.path || digest !== manifestFile.sha256 || size !== manifestFile.size_bytes || file.media_type !== manifestFile.media_type)
      fail("sealed file differs from manifest", "EVOLUTION_EVAL_BINDING_CONFLICT");
    const content = strictBase64(file.content_base64, `sealed files[${index}].content_base64`, size);
    if (sha2562(content) !== digest)
      fail("sealed file content hash differs", "EVOLUTION_EVAL_BINDING_CONFLICT");
    decoded.push({ path, sha256: digest, size_bytes: size, media_type: manifestFile.media_type, content });
  }
  const parameterPaths = [
    ...binding.dispatch.parameters.source_paths,
    ...binding.dispatch.parameters.operation === "implement" ? binding.dispatch.parameters.constraint_paths : []
  ];
  for (const path of parameterPaths) {
    const file = manifestFiles.find((candidate) => portableKey(candidate.path) === portableKey(path));
    if (!file || file.layer === "skill")
      fail("Vivado input is absent or belongs to the Skill layer", "EVOLUTION_EVAL_BINDING_CONFLICT");
    const expectedMedia = extensionMedia(path);
    if (!expectedMedia || expectedMedia !== file.media_type)
      fail("Vivado input media type differs from its extension");
    let text;
    const transported = decoded.find((candidate) => portableKey(candidate.path) === portableKey(path));
    if (!transported)
      fail("Vivado input bytes are absent", "EVOLUTION_EVAL_BINDING_CONFLICT");
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(transported.content);
    } catch {
      fail("Vivado input is not valid UTF-8");
    }
    if (!path.toLowerCase().endsWith(".xdc") && (/\$(?:system|fopen|fclose|readmemh|readmemb|writememh|writememb)\b/iu.test(text) || /\bimport\s*"DPI(?:-C)?"/iu.test(text) || /`include\s*["<](?:\/|\\|\.\.)/u.test(text)))
      fail("Vivado source contains a process or filesystem escape", "EVOLUTION_EVAL_OPERATION_FORBIDDEN");
  }
  const projectionHash = canonicalEvolutionEvalHash({
    schema: "evolution-eval-sealed-input-projection.v1",
    manifest: canonicalManifest,
    files: decoded.map(({ path, sha256: sha2563, size_bytes, media_type }) => ({
      path,
      sha256: sha2563,
      size_bytes,
      media_type
    }))
  });
  if (projectionHash !== binding.dispatch.sealed_input_projection_hash) {
    fail("sealed input projection differs from dispatch", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  return { manifest: canonicalManifest, files: decoded, projectionHash };
}
function effectiveEvolutionEvalTimeoutMs(bindingInput, now = new Date) {
  const binding = validateCoreIssuedEvalBinding(bindingInput);
  const remaining = Date.parse(binding.dispatch.deadline_at) - now.getTime();
  const effective = Math.min(binding.dispatch.requested_timeout_ms, EVOLUTION_EVAL_OPERATION_CAP_MS, remaining);
  if (!Number.isSafeInteger(effective) || effective < 1) {
    fail("the absolute deadline has elapsed", "EVOLUTION_EVAL_TIMEOUT_INVALID");
  }
  return effective;
}
function evolutionEvalDiscardAuthorizationHash(bindingInput, input) {
  const binding = validateCoreIssuedEvalBinding(bindingInput);
  const common = {
    schema: "evolution-eval-evidence-discard-authorization.v1",
    project_id: binding.project_id,
    eval_job_id: binding.dispatch.eval_job_id,
    connector_job_id: binding.dispatch.connector_job_id,
    dispatch_request_hash: binding.dispatch_request_hash,
    reason: input.reason
  };
  return canonicalEvolutionEvalHash(input.reason === "unavailable_at_deadline" ? { ...common, deadline_at: binding.dispatch.deadline_at } : {
    ...common,
    connector_manifest_hash: input.connectorManifestHash,
    terminal_at: input.terminalAt
  });
}
function validateEvolutionEvalRemoteRequest(input, expectedProjectId) {
  const value = record(input, "evolution-eval request");
  if (typeof value.schema !== "string")
    fail("request schema is missing");
  const bindingOnly = [
    "evolution-eval-preflight-request.v1",
    "evolution-eval-query-request.v1",
    "evolution-eval-reserve-request.v1",
    "evolution-eval-spool-query.v1",
    "evolution-eval-retention-query-request.v1",
    "evolution-eval-evidence-manifest-request.v1"
  ];
  if (bindingOnly.includes(value.schema)) {
    exactKeys(value, ["binding", "schema"], "evolution-eval request");
    return { schema: value.schema, binding: validateCoreIssuedEvalBinding(value.binding, expectedProjectId) };
  }
  if (value.schema === "evolution-eval-evidence-entry-request.v1") {
    exactKeys(value, ["binding", "name", "schema"], "evolution-eval request");
    if (typeof value.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value.name))
      fail("evidence name is invalid");
    return { schema: value.schema, binding: validateCoreIssuedEvalBinding(value.binding, expectedProjectId), name: value.name };
  }
  if (value.schema === "evolution-eval-evidence-ack-request.v1") {
    exactKeys(value, ["binding", "connector_manifest_hash", "core_ack_fact_hash", "core_manifest_hash", "schema"], "evolution-eval request");
    for (const field of ["connector_manifest_hash", "core_manifest_hash", "core_ack_fact_hash"]) {
      if (typeof value[field] !== "string" || !/^[0-9a-f]{64}$/.test(value[field]))
        fail("retention fact hash is invalid");
    }
    return structuredClone({ ...value, binding: validateCoreIssuedEvalBinding(value.binding, expectedProjectId) });
  }
  if (value.schema === "evolution-eval-evidence-corrupt-ack-request.v1") {
    exactKeys(value, ["binding", "core_quarantine_fact_hash", "error_fact_hash", "schema"], "evolution-eval request");
    for (const field of ["error_fact_hash", "core_quarantine_fact_hash"]) {
      if (typeof value[field] !== "string" || !/^[0-9a-f]{64}$/.test(value[field]))
        fail("retention fact hash is invalid");
    }
    return structuredClone({ ...value, binding: validateCoreIssuedEvalBinding(value.binding, expectedProjectId) });
  }
  if (value.schema === "evolution-eval-evidence-cleanup-request.v1") {
    if (value.mode === "connector_authorized") {
      exactKeys(value, ["binding", "connector_authorization_fact_hash", "core_cleanup_fact_hash", "mode", "schema"], "evolution-eval request");
      for (const field of ["connector_authorization_fact_hash", "core_cleanup_fact_hash"]) {
        if (typeof value[field] !== "string" || !/^[0-9a-f]{64}$/.test(value[field]))
          fail("retention fact hash is invalid");
      }
    } else if (value.mode === "core_discard") {
      if (value.reason === "unavailable_at_deadline") {
        exactKeys(value, ["binding", "core_cleanup_fact_hash", "core_conclusion_fact_hash", "discard_authorization_hash", "mode", "reason", "schema"], "evolution-eval request");
      } else if (value.reason === "absolute_expiry") {
        exactKeys(value, ["binding", "core_cleanup_fact_hash", "core_conclusion_fact_hash", "core_manifest_hash", "discard_authorization_hash", "mode", "reason", "schema"], "evolution-eval request");
        if (typeof value.core_manifest_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.core_manifest_hash))
          fail("retention fact hash is invalid");
      } else
        fail("discard reason is invalid");
      for (const field of ["core_conclusion_fact_hash", "core_cleanup_fact_hash", "discard_authorization_hash"]) {
        if (typeof value[field] !== "string" || !/^[0-9a-f]{64}$/.test(value[field]))
          fail("retention fact hash is invalid");
      }
    } else
      fail("cleanup mode is invalid");
    return structuredClone({ ...value, binding: validateCoreIssuedEvalBinding(value.binding, expectedProjectId) });
  }
  if (value.schema === "evolution-eval-cancel-request.v1") {
    exactKeys(value, ["binding", "reason", "schema"], "evolution-eval request");
    if (!(value.reason === "tombstoned" || value.reason === "deadline" || value.reason === "shutdown"))
      fail("cancel reason is invalid");
    return { schema: value.schema, binding: validateCoreIssuedEvalBinding(value.binding, expectedProjectId), reason: value.reason };
  }
  if (value.schema === "evolution-eval-submit-request.v1") {
    exactKeys(value, ["binding", "input", "schema"], "evolution-eval request");
    const binding = validateCoreIssuedEvalBinding(value.binding, expectedProjectId);
    validateEvolutionEvalSealedInput(value.input, binding);
    return structuredClone({ schema: value.schema, binding, input: value.input });
  }
  fail("request schema is forbidden", "EVOLUTION_EVAL_OPERATION_FORBIDDEN");
}

// connector/remote.ts
var REMOTE_SCHEMA_VERSION = "connector.remote.v1";
var EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER = "x-synthia-evolution-eval-active-config-sha256";
var EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER = "x-synthia-evolution-eval-worker-process-instance-id";
var EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER = "x-synthia-evolution-eval-vivado-toolchain-attestation-sha256";
var MAX_EVIDENCE_ENTRY_BYTES = 64 * 1024 * 1024;
var MAX_EVIDENCE_ENTRIES = 64;
var MAX_EVIDENCE_TOTAL_BYTES = 128 * 1024 * 1024;
var MAX_EVIDENCE_PREVIEW_BYTES = 257 * 1024;

// connector/vivado.ts
import { createHash as createHash3, randomBytes } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
var VIVADO_CAPABILITY_VERSION = "vivado-batch-1";
var VIVADO_CAPABILITIES = [
  ["discover_toolchain", "node", "toolchain_snapshot"],
  ["query_parts", "part_query", "part_list"],
  ["validate_sources", "source_manifest", "source_validation"],
  ["simulate", "simulation_request", "simulation_result"],
  ["synthesize", "synthesis_request", "synthesis_result"],
  ["implement", "implementation_request", "bitstream_artifact"],
  ["report_drc", "design_request", "drc_report"],
  ["report_sta", "design_request", "sta_report"],
  ["report_resources", "design_request", "resource_report"]
].map(([operation, inputKind, outputKind]) => ({
  operation,
  version: VIVADO_CAPABILITY_VERSION,
  runClasses: [
    "exploratory",
    "gate_check",
    "formal",
    ...["validate_sources", "simulate", "synthesize", "implement"].includes(operation) ? ["evolution_eval"] : []
  ],
  inputKind,
  outputKind,
  execution: "vivado_batch"
}));
var VIVADO_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
var VIVADO_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
var XSIM_RUNTIME_CAP = "100ms";
var idRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var hash = (data) => createHash3("sha256").update(data).digest("hex");
function reject(code) {
  throw new Error(`VIVADO_POLICY_REJECTED:${code}`);
}
var WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;
function safePath(path) {
  if (!path || Buffer.byteLength(path, "utf8") > 512 || path !== path.normalize("NFC") || path.startsWith("/") || path.startsWith("\\") || path.includes("\\") || path.includes("\x00"))
    reject("UNSAFE_PATH");
  const segments = path.split("/");
  if (segments.length === 0 || segments.length > 32)
    reject("UNSAFE_PATH");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || Buffer.byteLength(segment, "utf8") > 255 || /[\u0000-\u001f\u007f:*?"<>|]/u.test(segment) || /[ .]$/.test(segment))
      reject("UNSAFE_PATH");
    const deviceName = segment.split(".", 1)[0].replace(/[ .]+$/u, "");
    if (WINDOWS_RESERVED_NAME.test(deviceName))
      reject("UNSAFE_PATH");
  }
}
function portablePathKey(path) {
  return path.normalize("NFC").toLowerCase();
}
function assertDistinctPortablePaths(paths) {
  const seen = new Set;
  for (const path of paths) {
    const key = portablePathKey(path);
    if (seen.has(key))
      reject("PATH_COLLISION");
    seen.add(key);
  }
}
function safeToken(value, name) {
  if (!value || value.length > 256 || /[\0\r\n{}\[\]$;]/.test(value))
    reject(`UNSAFE_${name.toUpperCase()}`);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var VERILOG_MEDIA_TYPES = { "text/verilog": true, "text/x-verilog": true, "text/systemverilog": true, "text/x-systemverilog": true, "application/systemverilog": true };
function assertSourceLanguage(source) {
  const lower = source.path.toLowerCase();
  const extOk = lower.endsWith(".v") || lower.endsWith(".vh") || lower.endsWith(".sv") || lower.endsWith(".svh");
  const mediaOk = source.mediaType === undefined || VERILOG_MEDIA_TYPES[source.mediaType] === true;
  if (!extOk || !mediaOk)
    reject("UNSUPPORTED_SOURCE_LANGUAGE");
}
function stripVerilogLexical(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = i + 1 < n ? text[i + 1] : "";
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && text[i] !== `
`)
        i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && i + 1 < n && text[i + 1] === "/"))
        i++;
      i += 2;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < n)
          i += 2;
        else
          i += 1;
      }
      if (i < n)
        i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
var moduleDeclRe = /\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)\b/g;
function declaredModules(source) {
  const text = stripVerilogLexical(typeof source.content === "string" ? source.content : Buffer.from(source.content).toString("utf8"));
  const names = [];
  let m;
  moduleDeclRe.lastIndex = 0;
  while ((m = moduleDeclRe.exec(text)) !== null)
    names.push(m[1]);
  return names;
}
function assertSimulateModules(request) {
  const totals = new Map;
  for (const source of request.sources)
    for (const name of declaredModules(source))
      totals.set(name, (totals.get(name) ?? 0) + 1);
  const topCount = totals.get(request.top) ?? 0;
  const tbCount = totals.get(request.testbench) ?? 0;
  if (topCount === 0 || tbCount === 0)
    reject("MISSING_TOP_MODULE");
  if (topCount > 1 || tbCount > 1)
    reject("AMBIGUOUS_TOP_MODULE");
  for (const source of request.sources) {
    const names = new Set(declaredModules(source));
    if (names.has(request.top) && names.has(request.testbench))
      reject("AMBIGUOUS_SOURCE_ROLE");
  }
}
var XDC_COMMANDS = new Set([
  "create_clock",
  "create_generated_clock",
  "set_case_analysis",
  "set_clock_groups",
  "set_clock_latency",
  "set_clock_transition",
  "set_clock_uncertainty",
  "set_disable_timing",
  "set_false_path",
  "set_input_delay",
  "set_input_transition",
  "set_io",
  "set_load",
  "set_location",
  "set_max_capacitance",
  "set_max_delay",
  "set_max_fanout",
  "set_max_transition",
  "set_min_delay",
  "set_multicycle_path",
  "set_output_delay",
  "set_property"
]);
var XDC_QUERY_COMMANDS = new Set(["get_cells", "get_clocks", "get_drc_checks", "get_nets", "get_pins", "get_ports"]);
function assertXdcLine(line) {
  if (/\\[ \t]*$/.test(line))
    reject("XDC_LINE_CONTINUATION");
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#"))
    return;
  if (trimmed.includes("$") || trimmed.includes(";") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(trimmed))
    reject("UNSAFE_XDC_COMMAND");
  let remainder = "";
  for (let cursor = 0;cursor < trimmed.length; ) {
    const open = trimmed.indexOf("[", cursor);
    const strayClose = trimmed.indexOf("]", cursor);
    if (strayClose !== -1 && (open === -1 || strayClose < open))
      reject("UNSAFE_XDC_COMMAND");
    if (open === -1) {
      remainder += trimmed.slice(cursor);
      break;
    }
    remainder += trimmed.slice(cursor, open);
    const close = trimmed.indexOf("]", open + 1);
    if (close === -1 || trimmed.slice(open + 1, close).includes("[") || trimmed.slice(open + 1, close).includes("]"))
      reject("UNSAFE_XDC_COMMAND");
    const query = trimmed.slice(open + 1, close).trim();
    const command2 = query.match(/^([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1];
    if (!command2 || !XDC_QUERY_COMMANDS.has(command2))
      reject("UNSAFE_XDC_QUERY");
    remainder += " __SYNTHIA_QUERY__ ";
    cursor = close + 1;
  }
  if (remainder.includes("[") || remainder.includes("]"))
    reject("UNSAFE_XDC_COMMAND");
  const command = remainder.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1];
  if (!command || !XDC_COMMANDS.has(command))
    reject("UNSAFE_XDC_COMMAND");
}
function assertXdcPolicy(content) {
  let text;
  try {
    text = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    reject("INVALID_CONSTRAINT_ENCODING");
  }
  const normalized = text.replace(/\r\n/g, `
`);
  if (normalized.includes("\r"))
    reject("INVALID_CONSTRAINT_ENCODING");
  for (const line of normalized.split(`
`))
    assertXdcLine(line);
}
function validateVivadoRequest(request) {
  if (!isPlainObject(request))
    reject("INVALID_REQUEST");
  if (typeof request.jobId !== "string" || typeof request.projectId !== "string" || !idRe.test(request.jobId) || !idRe.test(request.projectId))
    reject("INVALID_ID");
  if (request.runClass !== "exploratory" && request.runClass !== "gate_check" && request.runClass !== "formal" && request.runClass !== "evolution_eval")
    reject("INVALID_RUN_CLASS");
  if (request.runClass === "evolution_eval" && !["validate_sources", "simulate", "synthesize", "implement"].includes(request.operation))
    reject("CAPABILITY_UNAVAILABLE");
  if (request.inputHash !== undefined && (typeof request.inputHash !== "string" || !/^[0-9a-f]{64}$/.test(request.inputHash)))
    reject("INVALID_INPUT_HASH");
  if (request.toolchainHash !== undefined && (typeof request.toolchainHash !== "string" || !/^[0-9a-f]{64}$/.test(request.toolchainHash)))
    reject("INVALID_TOOLCHAIN_HASH");
  if (request.runClass === "formal" && (!request.inputHash || !request.toolchainHash))
    reject("FORMAL_BINDING_REQUIRED");
  if (request.timeoutMs !== undefined) {
    const t = request.timeoutMs;
    if (typeof t !== "number" || !Number.isFinite(t) || !Number.isInteger(t) || t <= 0 || t > VIVADO_MAX_TIMEOUT_MS)
      reject("INVALID_TIMEOUT");
  }
  if (!VIVADO_CAPABILITIES.some((c) => c.operation === request.operation))
    reject("CAPABILITY_UNAVAILABLE");
  if (request.toolchain !== undefined) {
    if (!isPlainObject(request.toolchain))
      reject("INVALID_TOOLCHAIN");
    if (request.toolchain.vivadoBinary !== undefined && typeof request.toolchain.vivadoBinary !== "string")
      reject("INVALID_TOOLCHAIN");
    if (request.toolchain.requiredLicense !== undefined && typeof request.toolchain.requiredLicense !== "string")
      reject("INVALID_TOOLCHAIN");
    if (request.toolchain.part !== undefined && typeof request.toolchain.part !== "string")
      reject("INVALID_TOOLCHAIN");
    if (request.toolchain.profileHash !== undefined && typeof request.toolchain.profileHash !== "string")
      reject("INVALID_TOOLCHAIN");
    if (request.toolchain.vivadoBinary)
      safeToken(request.toolchain.vivadoBinary, "binary");
    if (request.toolchain.part)
      safeToken(request.toolchain.part, "part");
    if (request.toolchain.profileHash !== undefined && !/^[0-9a-f]{64}$/.test(request.toolchain.profileHash))
      reject("INVALID_TOOLCHAIN");
    if (request.runClass === "formal" && request.toolchain.profileHash !== undefined && request.toolchain.profileHash !== request.toolchainHash)
      reject("FORMAL_TOOLCHAIN_MISMATCH");
  }
  if ("part" in request) {
    if (typeof request.part !== "string")
      reject("INVALID_PART");
    safeToken(request.part, "part");
  }
  if ("top" in request) {
    if (typeof request.top !== "string")
      reject("INVALID_TOP");
    safeToken(request.top, "top");
  }
  if (request.operation === "simulate") {
    const tb = request.testbench;
    if (tb === undefined)
      reject("NO_TESTBENCH");
    if (typeof tb !== "string")
      reject("INVALID_TESTBENCH");
    safeToken(tb, "testbench");
    if (request.top === tb)
      reject("SAME_TOP_TESTBENCH");
  }
  if (request.operation === "implement" && request.generateTrialBitstream !== undefined && typeof request.generateTrialBitstream !== "boolean")
    reject("INVALID_TRIAL_BITSTREAM_POLICY");
  if ("pattern" in request && request.pattern) {
    if (typeof request.pattern !== "string")
      reject("INVALID_PATTERN");
    safeToken(request.pattern, "pattern");
  }
  if ("family" in request && request.family) {
    if (typeof request.family !== "string")
      reject("INVALID_FAMILY");
    safeToken(request.family, "family");
  }
  if ("sources" in request) {
    if (!Array.isArray(request.sources))
      reject("INVALID_SOURCES");
    if (!request.sources.length)
      reject("NO_SOURCES");
    for (const source of request.sources) {
      if (!isPlainObject(source))
        reject("INVALID_SOURCE");
      if (typeof source.path !== "string")
        reject("INVALID_SOURCE_PATH");
      safePath(source.path);
      if (typeof source.content !== "string" && !(source.content instanceof Uint8Array))
        reject("INVALID_SOURCE_CONTENT");
      if (source.mediaType !== undefined && typeof source.mediaType !== "string")
        reject("INVALID_SOURCE_MEDIA_TYPE");
      assertSourceLanguage(source);
      const size = typeof source.content === "string" ? Buffer.byteLength(source.content) : source.content.byteLength;
      if (!size)
        reject("EMPTY_SOURCE");
      if (size > 16 * 1024 * 1024)
        reject("SOURCE_TOO_LARGE");
    }
    if (request.operation === "simulate")
      assertSimulateModules(request);
  }
  if ("constraints" in request && request.constraints !== undefined) {
    if (!Array.isArray(request.constraints))
      reject("INVALID_CONSTRAINTS");
    for (const constraint of request.constraints) {
      if (!isPlainObject(constraint))
        reject("INVALID_CONSTRAINT");
      if (typeof constraint.path !== "string")
        reject("INVALID_CONSTRAINT_PATH");
      safePath(constraint.path);
      if (!constraint.path.toLowerCase().endsWith(".xdc"))
        reject("UNSUPPORTED_CONSTRAINT_FORMAT");
      if (typeof constraint.content !== "string" && !(constraint.content instanceof Uint8Array))
        reject("INVALID_CONSTRAINT_CONTENT");
      if (constraint.mediaType !== undefined && typeof constraint.mediaType !== "string")
        reject("INVALID_CONSTRAINT_MEDIA_TYPE");
      const size = typeof constraint.content === "string" ? Buffer.byteLength(constraint.content) : constraint.content.byteLength;
      if (!size)
        reject("EMPTY_CONSTRAINT");
      if (size > 4 * 1024 * 1024)
        reject("CONSTRAINT_TOO_LARGE");
      assertXdcPolicy(constraint.content);
    }
  }
  const paths = [
    ..."sources" in request && Array.isArray(request.sources) ? request.sources.map((source) => source.path) : [],
    ..."constraints" in request && Array.isArray(request.constraints) ? request.constraints.map((constraint) => constraint.path) : []
  ];
  assertDistinctPortablePaths(paths);
  if ("part" in request && request.toolchain?.part !== undefined && request.part !== request.toolchain.part)
    reject("TOOLCHAIN_PART_MISMATCH");
}
function validateEvolutionEvalVivadoRequest(input) {
  if (!isPlainObject(input))
    reject("INVALID_REQUEST");
  const request = input;
  const operation = request.operation;
  if (!(operation === "validate_sources" || operation === "simulate" || operation === "synthesize" || operation === "implement"))
    reject("CAPABILITY_UNAVAILABLE");
  const keysByOperation = {
    validate_sources: ["deadlineAt", "dispatchRequestHash", "evalJobId", "jobId", "operation", "projectId", "runClass", "schema", "sealedInputProjectionHash", "sources", "timeoutMs", "toolchainProfileHash", "top", "workspaceManifestHash"],
    simulate: ["deadlineAt", "dispatchRequestHash", "evalJobId", "jobId", "operation", "projectId", "runClass", "schema", "sealedInputProjectionHash", "sources", "testbench", "timeoutMs", "toolchainProfileHash", "top", "workspaceManifestHash"],
    synthesize: ["deadlineAt", "dispatchRequestHash", "evalJobId", "jobId", "operation", "part", "projectId", "runClass", "schema", "sealedInputProjectionHash", "sources", "timeoutMs", "toolchainProfileHash", "top", "workspaceManifestHash"],
    implement: ["constraints", "deadlineAt", "dispatchRequestHash", "evalJobId", "generateTrialBitstream", "jobId", "operation", "part", "projectId", "runClass", "schema", "sealedInputProjectionHash", "sources", "timeoutMs", "toolchainProfileHash", "top", "workspaceManifestHash"]
  };
  const actual = Reflect.ownKeys(request);
  const expected = keysByOperation[operation];
  if (actual.some((key) => typeof key !== "string") || actual.length !== expected.length || [...actual].sort().some((key, index) => key !== [...expected].sort()[index]))
    reject("INVALID_REQUEST");
  if (request.schema !== "evolution-eval-vivado-request.v1" || request.runClass !== "evolution_eval")
    reject("INVALID_RUN_CLASS");
  if (!Array.isArray(request.sources) || request.sources.length < 1 || request.sources.length > 512)
    reject("INVALID_SOURCES");
  for (const source of request.sources) {
    if (!isPlainObject(source) || Reflect.ownKeys(source).length !== 3 || !["content", "mediaType", "path"].every((key) => Object.prototype.hasOwnProperty.call(source, key)))
      reject("INVALID_SOURCE");
  }
  if (operation === "implement") {
    if (!Array.isArray(request.constraints) || request.constraints.length > 128)
      reject("INVALID_CONSTRAINTS");
    for (const constraint of request.constraints) {
      if (!isPlainObject(constraint) || Reflect.ownKeys(constraint).length !== 3 || !["content", "mediaType", "path"].every((key) => Object.prototype.hasOwnProperty.call(constraint, key)))
        reject("INVALID_CONSTRAINT");
    }
  }
  for (const key of ["dispatchRequestHash", "workspaceManifestHash", "sealedInputProjectionHash", "toolchainProfileHash"]) {
    if (typeof request[key] !== "string" || !/^[0-9a-f]{64}$/.test(request[key]))
      reject("INVALID_INPUT_HASH");
  }
  if (typeof request.deadlineAt !== "string" || !request.deadlineAt.endsWith("Z") || !Number.isFinite(Date.parse(request.deadlineAt)))
    reject("INVALID_TIMEOUT");
  const generic = operation === "validate_sources" ? { operation, jobId: request.jobId, projectId: request.projectId, runClass: request.runClass, sources: request.sources, ...request.top === null ? {} : { top: request.top }, inputHash: request.workspaceManifestHash, toolchainHash: request.toolchainProfileHash, timeoutMs: request.timeoutMs } : operation === "simulate" ? { operation, jobId: request.jobId, projectId: request.projectId, runClass: request.runClass, sources: request.sources, top: request.top, testbench: request.testbench, inputHash: request.workspaceManifestHash, toolchainHash: request.toolchainProfileHash, timeoutMs: request.timeoutMs } : operation === "synthesize" ? { operation, jobId: request.jobId, projectId: request.projectId, runClass: request.runClass, sources: request.sources, top: request.top, part: request.part, inputHash: request.workspaceManifestHash, toolchainHash: request.toolchainProfileHash, timeoutMs: request.timeoutMs } : { operation, jobId: request.jobId, projectId: request.projectId, runClass: request.runClass, sources: request.sources, constraints: request.constraints, top: request.top, part: request.part, generateTrialBitstream: request.generateTrialBitstream, inputHash: request.workspaceManifestHash, toolchainHash: request.toolchainProfileHash, timeoutMs: request.timeoutMs };
  validateVivadoRequest(generic);
  if (typeof request.evalJobId !== "string" || !idRe.test(request.evalJobId))
    reject("INVALID_ID");
  return structuredClone(input);
}
function tclQuote(value) {
  return `{${value.replace(/[{}]/g, (c) => `\\${c}`)}}`;
}
function readSourceLine(source, inputDir) {
  const target = tclQuote(join(inputDir, source.path));
  const isSystemVerilog = source.path.toLowerCase().endsWith(".sv") || source.mediaType === "text/systemverilog" || source.mediaType === "application/systemverilog";
  return isSystemVerilog ? `read_verilog -sv ${target}` : `read_verilog ${target}`;
}
function scriptFor(request, inputDir, outputDir) {
  const sources = "sources" in request ? request.sources.map((s) => readSourceLine(s, inputDir)).join(`
`) : "";
  const top = "top" in request && typeof request.top === "string" ? `-top ${tclQuote(request.top)}` : "";
  const part = "part" in request && typeof request.part === "string" ? `-part ${tclQuote(request.part)}` : request.toolchain?.part ? `-part ${tclQuote(request.toolchain.part)}` : "";
  if (request.operation === "discover_toolchain")
    return `puts [version -short]
puts [join [get_parts *] \\"\\n\\"]`;
  if (request.operation === "query_parts")
    return `puts [join [get_parts ${tclQuote(request.pattern ?? "*")}] "\\n"]`;
  if (request.operation === "validate_sources")
    return `${sources}
puts SOURCE_VALIDATION_OK`;
  if (request.operation === "simulate") {
    const designPaths = [];
    const simPaths = [];
    for (const source of request.sources) {
      const target = tclQuote(join(inputDir, source.path));
      (declaredModules(source).includes(request.testbench) ? simPaths : designPaths).push(target);
    }
    const designFiles = designPaths.join(" ");
    const simFiles = simPaths.join(" ");
    const project = tclQuote(join(resolve(inputDir, ".."), "vivado-project"));
    const projectPart = tclQuote(request.toolchain?.part ?? "xc7k70tfbv676-1");
    const topQ = tclQuote(request.top);
    const tbQ = tclQuote(request.testbench);
    return `${sources}
create_project synthia_batch ${project} -part ${projectPart} -force
add_files -fileset sources_1 ${designFiles}
add_files -fileset sim_1 ${simFiles}
set_property top ${topQ} [get_filesets sources_1]
set_property top ${tbQ} [get_filesets sim_1]
set_property xsim.simulate.runtime {${XSIM_RUNTIME_CAP}} [get_filesets sim_1]
update_compile_order -fileset sources_1
update_compile_order -fileset sim_1
launch_simulation -mode behavioral -scripts_only -absolute_path
set simRoot [file normalize [file join ${project} "synthia_batch.sim" "sim_1" "behav" "xsim"]]
cd $simRoot
proc phaseExitCode {options} {
  if {[dict exists $options -errorcode]} {
    set ec [dict get $options -errorcode]
    if {[llength $ec] >= 3 && [lindex $ec 0] eq "CHILDSTATUS"} { return [lindex $ec 2] }
  }
  return 1
}
set phase compile
if {[catch {exec cmd.exe /d /c [list call [file join $simRoot compile.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=compile"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts $sim_output; return -options $sim_options $sim_output }
set phase elaborate
if {[catch {exec cmd.exe /d /c [list call [file join $simRoot elaborate.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=elaborate"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts $sim_output; return -options $sim_options $sim_output }
set phase simulate
if {[catch {exec cmd.exe /d /c [list call [file join $simRoot simulate.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=simulate"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts "SIMULATOR_OUTPUT_BEGIN"; puts $sim_output; puts "SIMULATOR_OUTPUT_END"; return -options $sim_options $sim_output }
puts "PHASE=simulate"
puts "PHASE_EXIT_CODE=0"
puts "SIMULATOR_OUTPUT_BEGIN"
puts $sim_output
puts "SIMULATOR_OUTPUT_END"
puts SIMULATION_OK`;
  }
  if (request.operation === "synthesize")
    return `${sources}
synth_design ${part} ${top}
report_utilization -file ${tclQuote(join(outputDir, "resources.rpt"))}`;
  if (request.operation === "implement") {
    const constraints = (request.constraints ?? []).map((c) => `read_xdc ${tclQuote(join(inputDir, c.path))}`).join(`
`);
    const out = (name) => tclQuote(join(outputDir, name));
    return [sources, constraints, `synth_design ${part} ${top}`, `write_checkpoint -force ${out("synth.dcp")}`, "opt_design", "place_design", "route_design", `report_drc -file ${out("drc.rpt")}`, `report_timing_summary -file ${out("sta.rpt")}`, `report_utilization -file ${out("resources.rpt")}`, "set drcErrors [get_drc_violations -quiet -filter {SEVERITY == Error}]", 'if {[llength $drcErrors] > 0} { error "SYNTHIA_DRC_FAILED" }', "set failingPaths [get_timing_paths -quiet -max_paths 1 -slack_lesser_than 0]", 'if {[llength $failingPaths] > 0} { error "SYNTHIA_TIMING_FAILED" }', `write_checkpoint -force ${out("routed.dcp")}`, request.generateTrialBitstream === false ? "" : `write_bitstream -force ${out("synthia.bit")}`, "puts IMPLEMENT_OK"].filter(Boolean).join(`
`);
  }
  const report = request.operation === "report_drc" ? `report_drc -file ${tclQuote(join(outputDir, "drc.rpt"))}` : request.operation === "report_sta" ? `report_timing_summary -file ${tclQuote(join(outputDir, "sta.rpt"))}` : `report_utilization -file ${tclQuote(join(outputDir, "resources.rpt"))}`;
  return `${sources}
synth_design ${part} ${top}
${report}`;
}
function inputMember(source) {
  const bytes = typeof source.content === "string" ? new TextEncoder().encode(source.content) : source.content;
  return {
    path: source.path,
    sha256: hash(bytes),
    sizeBytes: bytes.byteLength,
    mediaType: source.mediaType ?? "application/octet-stream"
  };
}
function evidenceInputManifest(request) {
  return {
    schema: "vivado-input-manifest.v1",
    jobId: request.jobId,
    projectId: request.projectId,
    operation: request.operation,
    runClass: request.runClass,
    inputHash: request.inputHash ?? null,
    toolchainHash: request.toolchainHash ?? request.toolchain?.profileHash ?? null,
    top: "top" in request ? request.top : null,
    testbench: request.operation === "simulate" ? request.testbench : null,
    part: "part" in request ? request.part : request.toolchain?.part ?? null,
    sources: "sources" in request ? request.sources.map(inputMember).sort((a, b) => String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0) : [],
    constraints: "constraints" in request && request.constraints ? request.constraints.map(inputMember).sort((a, b) => String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0) : []
  };
}
var RESULT_FILE_BY_OPERATION = {
  validate_sources: "validation-result.json",
  simulate: "simulation-result.json",
  synthesize: "synthesis-result.json",
  implement: "implementation-result.json"
};
async function writeExecutionEvidence(outputDir, request, result, status, details = {}) {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  await Promise.all([
    writeFile(join(outputDir, "stdout.log"), stdout, "utf8"),
    writeFile(join(outputDir, "stderr.log"), stderr, "utf8"),
    writeFile(join(outputDir, "tool.log"), `${stdout}${stdout && stderr ? `
` : ""}${stderr}`, "utf8")
  ]);
  const resultName = RESULT_FILE_BY_OPERATION[request.operation];
  if (resultName) {
    await writeFile(join(outputDir, resultName), JSON.stringify({
      schema: `${request.operation}-result.v1`,
      passed: status === "succeeded",
      status,
      exitCode: result.exitCode,
      timedOut: result.timedOut === true,
      ...details
    }, null, 2), "utf8");
  }
}
async function evidence(workspace, jobId, omittedNames = new Set) {
  const output = join(workspace, "output");
  const entries = [];
  for (const name of (await readdir(output)).sort()) {
    safePath(name);
    if (omittedNames.has(name))
      continue;
    const bytes = await readFile(join(output, name));
    const mediaType = name.endsWith(".json") ? "application/json" : name.endsWith(".rpt") || name.endsWith(".log") || name.endsWith(".tcl") ? "text/plain" : "application/octet-stream";
    entries.push({ name, uri: `workspace://${jobId}/output/${name}`, sha256: hash(bytes), sizeBytes: (await stat(join(output, name))).size, mediaType });
  }
  return { jobId, entries };
}
function terminateProcessTree(pid) {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
    } catch {}
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }, 1000).unref();
}
var WINDOWS_PROCESS_IDENTITY_SOURCE = String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$identityPid = [int]$env:SYNTHIA_PROCESS_IDENTITY_PID
$process = Get-Process -Id $identityPid
$operatingSystem = Get-CimInstance Win32_OperatingSystem
$cimProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $identityPid)
if ($null -eq $cimProcess -or [string]::IsNullOrWhiteSpace([string]$cimProcess.CommandLine)) { exit 19 }
$facts = $operatingSystem.LastBootUpTime.ToUniversalTime().Ticks.ToString() + ':' +
  $process.StartTime.ToUniversalTime().Ticks.ToString() + ':' + [string]$cimProcess.CommandLine
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($facts))
[Console]::Out.Write('SYNTHIA_PROCESS_IDENTITY:' + $env:SYNTHIA_PROCESS_IDENTITY_NONCE + ':' + $encoded)
`;
function readWindowsProcessIdentityFacts(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1)
    return null;
  const nonce = randomBytes(16).toString("hex");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(WINDOWS_PROCESS_IDENTITY_SOURCE, "utf16le").toString("base64")
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      SYNTHIA_PROCESS_IDENTITY_PID: String(pid),
      SYNTHIA_PROCESS_IDENTITY_NONCE: nonce
    }
  });
  if (result.error || result.status !== 0 || result.stderr.trim() !== "")
    return null;
  const prefix = `SYNTHIA_PROCESS_IDENTITY:${nonce}:`;
  if (!result.stdout.startsWith(prefix))
    return null;
  const encoded = result.stdout.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded)
    return null;
  let facts;
  try {
    facts = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return /^\d+:\d+:.+$/s.test(facts) ? facts : null;
}
async function processStartToken(pid) {
  let source = "";
  if (process.platform === "linux") {
    const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
    const tail = statLine.slice(statLine.lastIndexOf(")") + 2).trim().split(/\s+/);
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (!tail[19] || !bootId)
      throw new Error("VIVADO_PROCESS_IDENTITY_UNAVAILABLE");
    source = `${bootId}:${pid}:${tail[19]}`;
  } else if (process.platform === "win32") {
    const facts = readWindowsProcessIdentityFacts(pid);
    if (!facts)
      throw new Error("VIVADO_PROCESS_IDENTITY_UNAVAILABLE");
    source = `${pid}:${facts}`;
  } else {
    const bootResult = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
    const factsResult = spawnSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    const boot = bootResult.stdout.trim();
    const facts = factsResult.stdout.trim();
    if (bootResult.error || bootResult.status !== 0 || factsResult.error || factsResult.status !== 0 || !boot || !facts) {
      throw new Error("VIVADO_PROCESS_IDENTITY_UNAVAILABLE");
    }
    source = `${boot}:${pid}:${facts}`;
  }
  if (!source.trim())
    throw new Error("VIVADO_PROCESS_IDENTITY_UNAVAILABLE");
  return hash(source);
}
var PROCESS_GUARDIAN_SOURCE = String.raw`
const { spawn } = require("node:child_process");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  if (!input) process.exit(125);
  let request;
  try { request = JSON.parse(input); } catch { process.exit(125); }
  const lower = String(request.command).toLowerCase();
  const isBatch = process.platform === "win32" && (lower.endsWith(".bat") || lower.endsWith(".cmd"));
  const child = isBatch
    ? spawn("cmd.exe", ["/d", "/s", "/c", '"' + request.command + '"', ...request.args], { cwd: request.cwd, stdio: ["ignore", "inherit", "inherit"], windowsVerbatimArguments: true })
    : spawn(request.command, request.args, { cwd: request.cwd, stdio: ["ignore", "inherit", "inherit"] });
  child.once("error", () => process.exit(126));
  child.once("exit", (code, signal) => process.exit(code == null ? (signal ? 128 : 1) : code));
});
process.stdin.resume();
`;
var WINDOWS_JOB_GUARDIAN_SOURCE = String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SynthiaJobGuardian {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const int JobObjectExtendedLimitInformation = 9;
  const int JobObjectBasicAccountingInformation = 1;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = new IntPtr(0x0002000D);

  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public uint dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returnedLength);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(
    string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
    uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Win(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new[]{' ', '\t', '"'}) < 0) return value;
    var b = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { b.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
      b.Append('\\', slashes).Append(c); slashes = 0;
    }
    return b.Append('\\', slashes * 2).Append('"').ToString();
  }
  static string CommandLine(string application, string[] args) {
    var b = new StringBuilder(Quote(application)); foreach (var arg in args) b.Append(' ').Append(Quote(arg)); return b.ToString();
  }

  public static int Run(string application, string[] args, string cwd) {
    IntPtr job = IntPtr.Zero, limits = IntPtr.Zero, list = IntPtr.Zero, jobValue = IntPtr.Zero;
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    try {
      job = CreateJobObject(IntPtr.Zero, null); Win(job != IntPtr.Zero);
      var policy = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      policy.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int policySize = Marshal.SizeOf(policy); limits = Marshal.AllocHGlobal(policySize); Marshal.StructureToPtr(policy, limits, false);
      Win(SetInformationJobObject(job, JobObjectExtendedLimitInformation, limits, (uint)policySize));

      IntPtr listSize = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref listSize);
      list = Marshal.AllocHGlobal(listSize); Win(InitializeProcThreadAttributeList(list, 1, 0, ref listSize));
      jobValue = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue, job);
      Win(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));

      var si = new STARTUPINFOEX(); si.StartupInfo.cb = Marshal.SizeOf(si); si.lpAttributeList = list;
      si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      si.StartupInfo.hStdInput = GetStdHandle(-10); si.StartupInfo.hStdOutput = GetStdHandle(-11); si.StartupInfo.hStdError = GetStdHandle(-12);
      var line = new StringBuilder(CommandLine(application, args));
      Win(CreateProcess(application, line, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref si, out pi));
      if (ResumeThread(pi.hThread) == 0xFFFFFFFF) { TerminateProcess(pi.hProcess, 126); throw new Win32Exception(Marshal.GetLastWin32Error()); }
      WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
      uint code; Win(GetExitCodeProcess(pi.hProcess, out code));
      int accountingSize = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
      IntPtr accounting = Marshal.AllocHGlobal(accountingSize);
      try {
        while (true) {
          Win(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, accounting, (uint)accountingSize, IntPtr.Zero));
          var state = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(accounting, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
          if (state.ActiveProcesses == 0) break;
          Thread.Sleep(10);
        }
      } finally { Marshal.FreeHGlobal(accounting); }
      return unchecked((int)code);
    } finally {
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread); if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
      if (list != IntPtr.Zero) DeleteProcThreadAttributeList(list); if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
      if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue); if (limits != IntPtr.Zero) Marshal.FreeHGlobal(limits);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
'@
$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) { exit 125 }
$request = $raw | ConvertFrom-Json
$application = [string]$request.command
[string[]]$arguments = @($request.args | ForEach-Object { [string]$_ })
if ($application.ToLowerInvariant().EndsWith('.bat') -or $application.ToLowerInvariant().EndsWith('.cmd')) {
  $joined = '"' + $application + '" ' + (($arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"','\"') + '"' } else { $_ } }) -join ' ')
  $application = [string]$request.command_interpreter
  $arguments = @('/d', '/s', '/c', $joined)
}
exit [SynthiaJobGuardian]::Run($application, $arguments, [string]$request.cwd)
`;
function windowsSystemExecutable(name) {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !isAbsolute(systemRoot))
    throw new Error("VIVADO_EXECUTABLE_UNAVAILABLE");
  const candidate = realpathSync(join(systemRoot, "System32", name));
  if (!statSync(candidate).isFile())
    throw new Error("VIVADO_EXECUTABLE_UNAVAILABLE");
  return candidate;
}
function resolveWindowsExecutable(command) {
  if (isAbsolute(command)) {
    const candidate2 = realpathSync(command);
    if (!statSync(candidate2).isFile())
      throw new Error("VIVADO_EXECUTABLE_UNAVAILABLE");
    return candidate2;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(command))
    throw new Error("VIVADO_EXECUTABLE_UNAVAILABLE");
  const where = windowsSystemExecutable("where.exe");
  const result = spawnSync(where, [command], {
    cwd: dirname(where),
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error || result.status !== 0 || result.stderr.trim() !== "")
    throw new Error("VIVADO_EXECUTABLE_UNAVAILABLE");
  const candidates = [...new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => realpathSync(line)).map((line) => line.toLowerCase()))];
  if (candidates.length !== 1)
    throw new Error("VIVADO_EXECUTABLE_AMBIGUOUS");
  const candidate = realpathSync(candidates[0]);
  if (!statSync(candidate).isFile())
    throw new Error("VIVADO_EXECUTABLE_UNAVAILABLE");
  return candidate;
}
function windowsGuardianRequest(command, args, cwd) {
  const resolvedCommand = resolveWindowsExecutable(command);
  return {
    command: resolvedCommand,
    args: [...args],
    cwd,
    command_interpreter: /\.(?:bat|cmd)$/i.test(resolvedCommand) ? windowsSystemExecutable("cmd.exe") : null
  };
}
var defaultRunner = (command, args, cwd, timeoutMs, signal, onProcessStarted) => {
  const { promise, resolve: resolve2, reject: reject2 } = Promise.withResolvers();
  const nonce = randomBytes(16).toString("hex");
  const windowsGuardian = `${WINDOWS_JOB_GUARDIAN_SOURCE}
# ${nonce}`;
  const guardianCommand = process.platform === "win32" ? "powershell.exe" : process.execPath;
  const guardianArgs = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(windowsGuardian, "utf16le").toString("base64")] : ["-e", PROCESS_GUARDIAN_SOURCE, nonce];
  const child = spawn(guardianCommand, guardianArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  let stdout = "", stderr = "", timedOut = false;
  if (!child.pid) {
    reject2(new Error("VIVADO_PROCESS_ID_UNAVAILABLE"));
    return promise;
  }
  const processStarted = processStartToken(child.pid).then(async (startToken) => {
    const identity = { pid: child.pid, processGroupId: child.pid, startToken };
    if (await onProcessStarted?.(identity) === false)
      throw new Error("VIVADO_PROCESS_IDENTITY_NOT_DURABLE");
    if (signal?.aborted)
      throw new Error("VIVADO_PROCESS_LAUNCH_CANCELLED");
    child.stdin.end(JSON.stringify(process.platform === "win32" ? windowsGuardianRequest(command, args, cwd) : { command, args: [...args], cwd }));
    return identity;
  }).catch((error) => {
    terminateProcessTree(child.pid);
    throw error;
  });
  child.stdout.on("data", (d) => stdout += d);
  child.stderr.on("data", (d) => stderr += d);
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid)
      terminateProcessTree(child.pid);
  }, timeoutMs);
  const abort = () => {
    if (child.pid)
      terminateProcessTree(child.pid);
  };
  if (signal?.aborted)
    abort();
  else
    signal?.addEventListener("abort", abort, { once: true });
  child.once("error", reject2);
  child.once("close", (exitCode, closeSignal) => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    processStarted.then(() => resolve2({ exitCode: exitCode ?? (timedOut ? 124 : 1), stdout, stderr, timedOut, signal: closeSignal }), reject2);
  });
  return promise;
};
async function createVivadoProcessGuardian(cwd, signal, onProcessStarted, identityReader = processStartToken, beforeLaunch, terminateTree = terminateProcessTree) {
  const nonce = randomBytes(16).toString("hex");
  const windowsGuardian = `${WINDOWS_JOB_GUARDIAN_SOURCE}
# ${nonce}`;
  const guardianCommand = process.platform === "win32" ? "powershell.exe" : process.execPath;
  const guardianArgs = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(windowsGuardian, "utf16le").toString("base64")] : ["-e", PROCESS_GUARDIAN_SOURCE, nonce];
  const child = spawn(guardianCommand, guardianArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  if (!child.pid)
    throw new Error("VIVADO_PROCESS_ID_UNAVAILABLE");
  let stdout = "";
  let stderr = "";
  let spawnError;
  child.stdout.on("data", (data) => stdout += data);
  child.stderr.on("data", (data) => stderr += data);
  child.once("error", (error) => {
    spawnError = error;
  });
  let exited = false;
  const closed = new Promise((resolveClose) => {
    child.once("close", (exitCode, closeSignal) => {
      exited = true;
      resolveClose({ exitCode, signal: closeSignal });
    });
  });
  const abort = () => {
    if (!exited)
      terminateTree(child.pid);
  };
  if (signal?.aborted)
    abort();
  else
    signal?.addEventListener("abort", abort, { once: true });
  let identity;
  let permitted = false;
  try {
    identity = { pid: child.pid, processGroupId: child.pid, startToken: await identityReader(child.pid) };
    permitted = await onProcessStarted?.(identity) !== false;
  } catch (error) {
    if (!exited)
      terminateTree(child.pid);
    await closed;
    signal?.removeEventListener("abort", abort);
    throw error;
  }
  if (!permitted || signal?.aborted) {
    if (!exited)
      terminateTree(child.pid);
    await closed;
    signal?.removeEventListener("abort", abort);
    throw new Error("VIVADO_PROCESS_LAUNCH_CANCELLED");
  }
  let launched = false;
  return {
    identity,
    run: async (command, args, runCwd, timeoutMs, runSignal) => {
      if (launched || runCwd !== cwd || !permitted || signal?.aborted || runSignal?.aborted) {
        throw new Error("VIVADO_PROCESS_LAUNCH_CANCELLED");
      }
      launched = true;
      const serializedRequest = JSON.stringify(process.platform === "win32" ? windowsGuardianRequest(command, args, runCwd) : { command, args: [...args], cwd: runCwd });
      let launchReady = false;
      try {
        launchReady = await beforeLaunch?.() !== false;
      } catch {
        if (!exited)
          terminateTree(child.pid);
        await closed;
        throw new Error("VIVADO_PROCESS_LAUNCH_CANCELLED");
      }
      if (!launchReady || signal?.aborted || runSignal?.aborted) {
        if (!exited)
          terminateTree(child.pid);
        await closed;
        throw new Error("VIVADO_PROCESS_LAUNCH_CANCELLED");
      }
      const runAbort = () => {
        if (!exited)
          terminateTree(child.pid);
      };
      runSignal?.addEventListener("abort", runAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (!exited)
          terminateTree(child.pid);
      }, timeoutMs);
      child.stdin.end(serializedRequest);
      const ended = await closed;
      clearTimeout(timer);
      runSignal?.removeEventListener("abort", runAbort);
      signal?.removeEventListener("abort", abort);
      if (spawnError)
        throw spawnError;
      return {
        exitCode: ended.exitCode ?? (timedOut ? 124 : 1),
        stdout,
        stderr,
        timedOut,
        signal: ended.signal
      };
    },
    async close() {
      if (!exited)
        terminateTree(child.pid);
      await closed;
      signal?.removeEventListener("abort", abort);
    }
  };
}
function parseSimulatePhases(text) {
  const phaseMatch = text.match(/^PHASE=(\S+)/m);
  const exitMatch = text.match(/^PHASE_EXIT_CODE=(\d+)/m);
  const beginIdx = text.indexOf("SIMULATOR_OUTPUT_BEGIN");
  const endIdx = text.lastIndexOf("SIMULATOR_OUTPUT_END");
  const simulatorStdout = beginIdx !== -1 && endIdx !== -1 ? text.slice(beginIdx + "SIMULATOR_OUTPUT_BEGIN".length, endIdx).trim() : undefined;
  return { phase: phaseMatch?.[1], phaseExitCode: exitMatch ? Number(exitMatch[1]) : undefined, simulatorStdout };
}
function judgeSimulation(simulatorStdout, phaseExitCode, exitCode) {
  const region = simulatorStdout ?? "";
  if (/\bFatal:/i.test(region) || /\$fatal/i.test(region) || /^\s*FAIL\b/m.test(region))
    return { status: "failed", errorCode: "VIVADO_SIMULATION_FAILED" };
  if ((phaseExitCode ?? exitCode) !== 0 || exitCode !== 0)
    return { status: "failed", errorCode: "VIVADO_SIMULATION_FAILED" };
  if (/\bPASS\b/.test(region))
    return { status: "succeeded" };
  return { status: "failed", errorCode: "VIVADO_SIMULATION_INCONCLUSIVE" };
}
var IMPLEMENTATION_OUTPUTS = ["synth.dcp", "drc.rpt", "sta.rpt", "resources.rpt", "routed.dcp", "synthia.bit"];
var FAILED_IMPLEMENTATION_OMISSIONS = new Set(["synthia.bit"]);
function judgeDrcReport(report) {
  const finished = report.match(/DRC finished with\s+(\d+)\s+Errors?/i);
  if (finished)
    return Number(finished[1]) === 0 ? "passed" : "failed";
  if (!/\bReport DRC\b/i.test(report))
    return "inconclusive";
  const found = report.match(/Violations found:\s*(\d+)/i);
  const rows = [...report.matchAll(/^\|\s*[^|]+\|\s*(Error|Critical Warning|Warning|Advisory)\s*\|[^|]*\|\s*(\d+)\s*\|\s*$/gim)];
  if (rows.some((row) => row[1]?.toLowerCase() === "error") || /^\S+#\d+\s+Error\s*$/im.test(report))
    return "failed";
  if (!found)
    return "inconclusive";
  const violationCount = Number(found[1]);
  if (violationCount === 0)
    return "passed";
  const summarizedCount = rows.reduce((total, row) => total + Number(row[2]), 0);
  return rows.length > 0 && summarizedCount === violationCount ? "passed" : "inconclusive";
}
function judgeStaReport(report) {
  if (/timing constraints are not met/i.test(report) || /Slack\s*\(VIOLATED\)/i.test(report))
    return "failed";
  const lines = report.split(/\r?\n/);
  const summaryHeader = lines.findIndex((line) => /\bWNS\(ns\)/.test(line) && /\bTNS\(ns\)/.test(line));
  let summary;
  if (summaryHeader !== -1) {
    for (const line of lines.slice(summaryHeader + 1, summaryHeader + 8)) {
      const values = line.trim().split(/\s+/);
      if (values.length >= 2 && values.every((value) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))) {
        summary = values.map(Number);
        break;
      }
    }
  }
  if (summary) {
    const slackAndViolationIndexes = summary.length >= 10 ? [0, 1, 4, 5, 8, 9] : [0, 1];
    if (slackAndViolationIndexes.some((index) => (summary?.[index] ?? 0) < 0))
      return "failed";
  }
  if (!/All user specified timing constraints are met\./i.test(report) || !summary)
    return "inconclusive";
  return "passed";
}
async function implementationVerdict(outputDir, exitCode, text, requireBitstream = true) {
  let drc;
  let sta;
  try {
    drc = await readFile(join(outputDir, "drc.rpt"), "utf8");
  } catch {}
  try {
    sta = await readFile(join(outputDir, "sta.rpt"), "utf8");
  } catch {}
  if (drc !== undefined && judgeDrcReport(drc) === "failed" || /SYNTHIA_DRC_FAILED/.test(text))
    return { status: "failed", errorCode: "VIVADO_DRC_FAILED" };
  if (sta !== undefined && judgeStaReport(sta) === "failed" || /SYNTHIA_TIMING_FAILED/.test(text))
    return { status: "failed", errorCode: "VIVADO_TIMING_FAILED" };
  if (exitCode !== 0)
    return { status: "failed", errorCode: "VIVADO_IMPLEMENTATION_FAILED" };
  if (drc === undefined || sta === undefined || judgeDrcReport(drc) !== "passed" || judgeStaReport(sta) !== "passed")
    return { status: "failed", errorCode: "VIVADO_IMPLEMENTATION_EVIDENCE_INCOMPLETE" };
  for (const name of IMPLEMENTATION_OUTPUTS.filter((name2) => requireBitstream || name2 !== "synthia.bit")) {
    try {
      const details = await stat(join(outputDir, name));
      if (!details.isFile() || details.size === 0)
        return { status: "failed", errorCode: "VIVADO_IMPLEMENTATION_EVIDENCE_INCOMPLETE" };
    } catch {
      return { status: "failed", errorCode: "VIVADO_IMPLEMENTATION_EVIDENCE_INCOMPLETE" };
    }
  }
  return { status: "succeeded" };
}
async function failedImplementationEvidence(workspace, jobId) {
  try {
    await unlink(join(workspace, "output", "synthia.bit"));
  } catch {}
  return evidence(workspace, jobId, FAILED_IMPLEMENTATION_OMISSIONS);
}

class VivadoBatchAdapter {
  run;
  root;
  defaultBinary;
  configuredPart;
  configuredProfileHash;
  injected;
  constructor(options) {
    this.root = resolve(options.workspaceRoot);
    this.defaultBinary = options.binary ?? "vivado";
    this.configuredPart = options.part;
    this.configuredProfileHash = options.profileHash;
    this.injected = options.commandRunner !== undefined;
    this.run = options.commandRunner ?? defaultRunner;
  }
  capabilities() {
    return VIVADO_CAPABILITIES;
  }
  async execute(request, signal) {
    validateVivadoRequest(request);
    if (request.runClass === "evolution_eval")
      reject("EVOLUTION_EVAL_DEDICATED_ROUTE_REQUIRED");
    return this.executeRequest(request, signal);
  }
  async executeEvolutionEval(input, signal, onProcessStarted, sealedWorkspace, processRunner) {
    const request = validateEvolutionEvalVivadoRequest(input);
    const common = {
      jobId: request.jobId,
      projectId: request.projectId,
      runClass: request.runClass,
      inputHash: request.workspaceManifestHash,
      toolchainHash: request.toolchainProfileHash,
      timeoutMs: request.timeoutMs
    };
    const generic = request.operation === "validate_sources" ? { ...common, operation: request.operation, sources: request.sources, ...request.top === null ? {} : { top: request.top } } : request.operation === "simulate" ? { ...common, operation: request.operation, sources: request.sources, top: request.top, testbench: request.testbench } : request.operation === "synthesize" ? { ...common, operation: request.operation, sources: request.sources, top: request.top, part: request.part } : { ...common, operation: request.operation, sources: request.sources, constraints: request.constraints, top: request.top, part: request.part, generateTrialBitstream: request.generateTrialBitstream };
    return this.executeRequest(generic, signal, onProcessStarted, sealedWorkspace, processRunner);
  }
  async executeRequest(request, signal, onProcessStarted, sealedWorkspace, processRunner) {
    validateVivadoRequest(request);
    if (request.toolchain?.vivadoBinary !== undefined && request.toolchain.vivadoBinary !== this.defaultBinary)
      reject("TOOLCHAIN_BINARY_MISMATCH");
    if (this.configuredPart !== undefined && (("part" in request) && request.part !== this.configuredPart || request.toolchain?.part !== undefined && request.toolchain.part !== this.configuredPart))
      reject("TOOLCHAIN_PART_MISMATCH");
    if (this.configuredProfileHash !== undefined && (request.toolchainHash !== undefined && request.toolchainHash !== this.configuredProfileHash || request.toolchain?.profileHash !== undefined && request.toolchain.profileHash !== this.configuredProfileHash))
      reject("TOOLCHAIN_PROFILE_MISMATCH");
    const effectiveToolchain = {
      ...request.toolchain ?? {},
      vivadoBinary: this.defaultBinary,
      ...this.configuredPart !== undefined ? { part: this.configuredPart } : {},
      ...this.configuredProfileHash !== undefined ? { profileHash: this.configuredProfileHash } : {}
    };
    const effectiveRequest = { ...request, toolchain: effectiveToolchain };
    const workspace = sealedWorkspace === undefined ? join(this.root, request.jobId) : resolve(sealedWorkspace);
    if (sealedWorkspace !== undefined && request.runClass !== "evolution_eval")
      reject("SEALED_WORKSPACE_FORBIDDEN");
    if (sealedWorkspace !== undefined && workspace !== this.root && !workspace.startsWith(`${this.root}${sep}`))
      reject("UNSAFE_WORKSPACE");
    const inputDir = join(workspace, "input");
    const outputDir = join(workspace, "output");
    await mkdir(inputDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    const stageInput = async (item) => {
      safePath(item.path);
      const target = join(inputDir, item.path);
      if (sealedWorkspace === undefined) {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, item.content);
      } else {
        let existing;
        try {
          existing = await readFile(target);
        } catch {
          reject("SEALED_INPUT_MISSING");
        }
        const expected = typeof item.content === "string" ? Buffer.from(item.content) : Buffer.from(item.content);
        if (!Buffer.from(existing).equals(expected))
          reject("SEALED_INPUT_DRIFT");
      }
      if (request.runClass === "evolution_eval")
        await chmod(target, 256);
    };
    if ("sources" in request)
      for (const source of request.sources)
        await stageInput(source);
    if ("constraints" in request && request.constraints)
      for (const constraint of request.constraints)
        await stageInput(constraint);
    const inputSha256 = hash(JSON.stringify(effectiveRequest));
    const binary = this.defaultBinary;
    const command = [binary, "-mode", "batch", "-nolog", "-nojournal", "-notrace", "-source", join(workspace, "run.tcl")];
    const base = { jobId: request.jobId, operation: request.operation, command, inputSha256, workspace, toolchain: { binary, licenseStatus: "unknown", part: "part" in request ? request.part : effectiveRequest.toolchain?.part, profileHash: effectiveRequest.toolchain?.profileHash ?? request.toolchainHash }, evidence: { jobId: request.jobId, entries: [] } };
    try {
      if (!this.injected && (binary.includes("/") || binary.includes("\\")))
        await access(binary, constants.X_OK);
    } catch {
      return { ...base, status: "unsupported", unsupportedReason: "BINARY_UNAVAILABLE" };
    }
    const runScript = scriptFor(effectiveRequest, inputDir, outputDir);
    await Promise.all([
      writeFile(join(workspace, "run.tcl"), runScript, "utf8"),
      writeFile(join(outputDir, "run.tcl"), runScript, "utf8"),
      writeFile(join(outputDir, "input-manifest.json"), JSON.stringify(evidenceInputManifest(effectiveRequest), null, 2), "utf8")
    ]);
    const effectiveTimeout = request.timeoutMs ?? VIVADO_DEFAULT_TIMEOUT_MS;
    let result;
    try {
      result = await (processRunner ?? this.run)(binary, command.slice(1), workspace, effectiveTimeout, signal, processRunner ? undefined : onProcessStarted);
    } catch (error) {
      const code = error?.code;
      const ev2 = request.operation === "implement" ? await failedImplementationEvidence(workspace, request.jobId) : await evidence(workspace, request.jobId);
      if (code === "ENOENT" || code === "EACCES")
        return { ...base, status: "unsupported", unsupportedReason: "BINARY_UNAVAILABLE", evidence: ev2 };
      return { ...base, status: "lost", evidence: ev2 };
    }
    if (result.timedOut) {
      const ev2 = request.operation === "implement" ? await failedImplementationEvidence(workspace, request.jobId) : await evidence(workspace, request.jobId);
      return { ...base, status: "timeout", timedOut: true, signal: result.signal ?? null, exitCode: result.exitCode, timeoutMs: effectiveTimeout, evidence: ev2 };
    }
    const text = `${result.stdout}
${result.stderr}`;
    const licenseSuccess = /\b(?:checkout|feature)\b.*\b(?:succe\w*|granted|checked[\s-]*out)\b|\b(?:license|licence)\b.*\b(?:granted|checked[\s-]*out|succe\w*)\b|\bgot\s+(?:a\s+)?(?:license|licence)\b/i.test(text);
    const licenseFailure = !licenseSuccess && result.exitCode !== 0 && /\b(?:license|licence)\b/i.test(text);
    if (licenseFailure) {
      const ev2 = request.operation === "implement" ? await failedImplementationEvidence(workspace, request.jobId) : await evidence(workspace, request.jobId);
      return { ...base, status: "unsupported", unsupportedReason: "LICENSE_UNAVAILABLE", exitCode: result.exitCode, toolchain: { ...base.toolchain, licenseStatus: "unavailable" }, evidence: ev2 };
    }
    if (/part.*(not found|does not exist|unknown)/i.test(text)) {
      const ev2 = request.operation === "implement" ? await failedImplementationEvidence(workspace, request.jobId) : await evidence(workspace, request.jobId);
      return { ...base, status: "unsupported", unsupportedReason: "PART_UNAVAILABLE", exitCode: result.exitCode, evidence: ev2 };
    }
    const toolchain = { ...base.toolchain, licenseStatus: licenseSuccess ? "available" : base.toolchain.licenseStatus };
    if (request.operation === "simulate") {
      const sim = parseSimulatePhases(result.stdout);
      const verdict = judgeSimulation(sim.simulatorStdout, sim.phaseExitCode, result.exitCode);
      await writeExecutionEvidence(outputDir, request, result, verdict.status, {
        phase: sim.phase ?? null,
        phaseExitCode: sim.phaseExitCode ?? null,
        simulatorVerdict: verdict.errorCode ?? "passed"
      });
      const ev2 = await evidence(workspace, request.jobId);
      return { ...base, status: verdict.status, exitCode: result.exitCode, phase: sim.phase, phaseExitCode: sim.phaseExitCode, simulatorStdout: sim.simulatorStdout, toolchain, timeoutMs: effectiveTimeout, stdout: result.stdout, stderr: result.stderr, output: { stdout: result.stdout, stderr: result.stderr }, evidence: ev2, errorCode: verdict.errorCode };
    }
    if (request.operation === "implement") {
      const verdict = await implementationVerdict(outputDir, result.exitCode, text, request.generateTrialBitstream !== false);
      let drcVerdict = "inconclusive";
      let timingVerdict = "inconclusive";
      try {
        drcVerdict = judgeDrcReport(await readFile(join(outputDir, "drc.rpt"), "utf8"));
      } catch {}
      try {
        timingVerdict = judgeStaReport(await readFile(join(outputDir, "sta.rpt"), "utf8"));
      } catch {}
      await writeExecutionEvidence(outputDir, request, result, verdict.status, {
        drcVerdict,
        timingVerdict,
        errorCode: verdict.errorCode ?? null
      });
      const ev2 = verdict.status === "succeeded" ? await evidence(workspace, request.jobId) : await failedImplementationEvidence(workspace, request.jobId);
      return { ...base, status: verdict.status, exitCode: result.exitCode, toolchain, timeoutMs: effectiveTimeout, stdout: result.stdout, stderr: result.stderr, output: { stdout: result.stdout, stderr: result.stderr }, evidence: ev2, errorCode: verdict.errorCode };
    }
    const status = result.exitCode === 0 ? "succeeded" : "failed";
    await writeExecutionEvidence(outputDir, request, result, status);
    const ev = await evidence(workspace, request.jobId);
    return { ...base, status, exitCode: result.exitCode, toolchain, timeoutMs: effectiveTimeout, stdout: result.stdout, stderr: result.stderr, output: { stdout: result.stdout, stderr: result.stderr }, evidence: ev };
  }
}

// connector/worker.ts
function validEvolutionEvalRemoteAttestation(discovery) {
  return typeof discovery?.active_config_sha256 === "string" && /^[0-9a-f]{64}$/.test(discovery.active_config_sha256) && typeof discovery.worker_process_instance_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(discovery.worker_process_instance_id) && typeof discovery.vivado_toolchain_attestation_sha256 === "string" && /^[0-9a-f]{64}$/.test(discovery.vivado_toolchain_attestation_sha256) && discovery.live_mapping_health === "healthy";
}
var terminal = new Set(["succeeded", "failed", "cancelled", "timeout", "lost", "unknown_effect"]);
var idRe2 = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var classes = ["public", "internal", "confidential", "restricted"];
var MAX_CONTENT_BYTES = 256 * 1024;
var CONTENT_WINDOW_BYTES = 128 * 1024;
var evidenceNameRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
var EVOLUTION_EVAL_ADMISSION_BYTES = 256 * 1024 * 1024;
var EVOLUTION_EVAL_ADMISSION_SLOTS = EVOLUTION_EVAL_SPOOL_HARD_CAP_BYTES / EVOLUTION_EVAL_ADMISSION_BYTES;
var WINDOWS_MOVE_WRITE_THROUGH = String.raw`
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SynthiaDurableMove {
  const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
  const uint OPEN_EXISTING = 3, FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION {
    public uint Attributes; public FILETIME CreationTime, LastAccessTime, LastWriteTime;
    public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
  }
  [DllImport("kernel32.dll", EntryPoint="MoveFileExW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool MoveFileExW(string source, string target, uint flags);
  [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(IntPtr handle, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  static bool Identity(string path, out uint volume, out uint high, out uint low) {
    volume = high = low = 0;
    IntPtr handle = CreateFileW(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
    if (handle == new IntPtr(-1)) return false;
    try {
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(handle, out info)) return false;
      volume = info.VolumeSerialNumber; high = info.FileIndexHigh; low = info.FileIndexLow;
      return high != 0 || low != 0;
    } finally { CloseHandle(handle); }
  }
  static bool Same(uint av, uint ah, uint al, uint bv, uint bh, uint bl) {
    return av == bv && ah == bh && al == bl;
  }
  public static int MoveNoReplace(string source, string target, string mutexName) {
    using (var mutex = new System.Threading.Mutex(false, mutexName)) {
      bool held = false;
      try {
        try { held = mutex.WaitOne(System.TimeSpan.FromMinutes(2)); }
        catch (System.Threading.AbandonedMutexException) { held = true; }
        if (!held) return 258;
        uint sv, sh, sl; if (!Identity(source, out sv, out sh, out sl)) return 6;
        if (MoveFileExW(source, target, 8)) {
          uint tv, th, tl;
          return Identity(target, out tv, out th, out tl) && Same(sv, sh, sl, tv, th, tl) ? 0 : 13;
        }
        int moveError = Marshal.GetLastWin32Error();
        if (moveError == 80 || moveError == 183) {
          uint rv, rh, rl, tv, th, tl;
          if (!Identity(source, out rv, out rh, out rl) || !Same(sv, sh, sl, rv, rh, rl)
            || !Identity(target, out tv, out th, out tl)) return 13;
        }
        return moveError;
      } finally {
        if (held) mutex.ReleaseMutex();
      }
    }
  }
}
'@
$code = [SynthiaDurableMove]::MoveNoReplace(
  $env:SYNTHIA_EVOLUTION_MOVE_SOURCE,
  $env:SYNTHIA_EVOLUTION_MOVE_TARGET,
  $env:SYNTHIA_EVOLUTION_MOVE_MUTEX)
if ($code -eq 0) { exit 0 }
if ($code -eq 80 -or $code -eq 183) { exit 17 }
[Console]::Error.Write($code)
exit 18
`;
function windowsMoveWriteThrough(source, target) {
  const sourceWasDirectory = lstatSync(source).isDirectory();
  const result = spawnSync2("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(WINDOWS_MOVE_WRITE_THROUGH, "utf16le").toString("base64")
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      SYNTHIA_EVOLUTION_MOVE_SOURCE: source,
      SYNTHIA_EVOLUTION_MOVE_TARGET: target,
      SYNTHIA_EVOLUTION_MOVE_MUTEX: `Local\\SynthiaEvolutionMove-${sha256(target)}`
    }
  });
  if (!result.error && result.stderr.trim() === "" && result.status === 0) {
    let sourceAbsent = false;
    try {
      lstatSync(source);
    } catch (error) {
      sourceAbsent = error instanceof Error && "code" in error && error.code === "ENOENT";
    }
    try {
      if (sourceAbsent && lstatSync(target).isDirectory() === sourceWasDirectory)
        return "created";
    } catch {}
  }
  if (!result.error && result.stderr.trim() === "" && result.status === 17) {
    try {
      if (lstatSync(source).isDirectory() === sourceWasDirectory) {
        lstatSync(target);
        return "exists";
      }
    } catch {}
  }
  throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_UNAVAILABLE", `MoveFileExW failed: ${result.stderr.trim() || result.error?.message || result.status}`);
}
var unavailableExecution = {
  async discover() {
    return { connector_id: "unavailable", connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: "none", vivado_version: "unavailable", vivado_patch: "unavailable", part_catalog_hash: "unavailable", sdk_worker_build_hash: "unavailable", capabilities: [], toolchain_profile_hash: "unavailable", license_status: "unknown", unsupported: ["vivado_discovery", "vivado_execution"] };
  },
  async execute() {
    return { outcome: "failure", error_code: "UNSUPPORTED_VIVADO" };
  }
};
function good(v) {
  return typeof v === "string" && v.trim().length > 0;
}
function responseError(code, message, status) {
  return Response.json({ error_code: code, message }, { status });
}
function copy(v) {
  return structuredClone(v);
}
function exactObjectKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string"))
    return false;
  const actual = new Set(keys);
  return required.every((key) => actual.has(key)) && [...actual].every((key) => required.includes(key) || optional.includes(key));
}
async function boundedJson(request, maximumBytes) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_RESOURCE_LIMIT");
  }
  if (!request.body)
    throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_INVALID_REQUEST");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done)
        break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_RESOURCE_LIMIT");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_INVALID_REQUEST");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_INVALID_REQUEST");
  }
}
function evalCommon(binding, ledgerEpoch) {
  return {
    schema: "evolution-eval-ledger-query.v1",
    connector_job_id: binding.dispatch.connector_job_id,
    connector_idempotency_key: binding.dispatch.connector_idempotency_key,
    dispatch_request_hash: binding.dispatch_request_hash,
    ledger_epoch: ledgerEpoch
  };
}
async function syncFile(path) {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncDirectory(path) {
  if (process.platform === "win32") {
    const details = await stat2(path);
    if (!details.isDirectory())
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_UNAVAILABLE");
    return;
  }
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function evolutionEvidenceMediaType(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json"))
    return "application/json";
  if (lower.endsWith(".rpt") || lower.endsWith(".log") || lower.endsWith(".tcl"))
    return "text/plain";
  if (lower.endsWith(".bit") || lower.endsWith(".dcp"))
    return "application/octet-stream";
  return null;
}
function evidenceArtifactClassification(name) {
  return name.toLowerCase().endsWith(".bit") ? "experimental/evolution_eval" : "evolution_eval_evidence";
}
function assertConnectorEvidenceManifest(value, binding) {
  if (!exactObjectKeys(value, [
    "connector_job_id",
    "dispatch_request_hash",
    "entries",
    "eval_job_id",
    "manifest_hash",
    "schema"
  ]))
    throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
  const manifest = value;
  if (manifest.schema !== "evolution-eval-connector-evidence-manifest.v1" || manifest.eval_job_id !== binding.dispatch.eval_job_id || manifest.connector_job_id !== binding.dispatch.connector_job_id || manifest.dispatch_request_hash !== binding.dispatch_request_hash || !Array.isArray(manifest.entries) || manifest.entries.length > EVOLUTION_EVAL_EVIDENCE_LIMITS.entries || !/^[0-9a-f]{64}$/.test(String(manifest.manifest_hash))) {
    throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
  }
  let totalBytes = 0;
  let priorName;
  const names = new Set;
  for (const entry of manifest.entries) {
    if (!exactObjectKeys(entry, [
      "artifact_classification",
      "media_type",
      "name",
      "sha256",
      "size_bytes",
      "usage_classification"
    ]) || typeof entry.name !== "string" || !evidenceNameRe.test(entry.name) || names.has(entry.name) || priorName !== undefined && priorName >= entry.name || !/^[0-9a-f]{64}$/.test(String(entry.sha256)) || !Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0 || entry.size_bytes > EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes || !["application/json", "text/plain", "application/octet-stream"].includes(entry.media_type) || evolutionEvidenceMediaType(entry.name) !== null && evolutionEvidenceMediaType(entry.name) !== entry.media_type || entry.artifact_classification !== evidenceArtifactClassification(entry.name) || entry.usage_classification !== "evolution_eval_only") {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    names.add(entry.name);
    priorName = entry.name;
    totalBytes += entry.size_bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > EVOLUTION_EVAL_EVIDENCE_LIMITS.totalBytes) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_LIMIT_EXCEEDED");
    }
  }
  const { manifest_hash: ignored, ...canonical } = manifest;
  if (canonicalEvolutionEvalHash(canonical) !== manifest.manifest_hash) {
    throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
  }
  return structuredClone(manifest);
}
async function readProcessStartToken(pid) {
  try {
    let source;
    if (process.platform === "linux") {
      const statLine = await readFile2(`/proc/${pid}/stat`, "utf8");
      const tail = statLine.slice(statLine.lastIndexOf(")") + 2).trim().split(/\s+/);
      const bootId = (await readFile2("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      if (!tail[19] || !bootId)
        return null;
      source = `${bootId}:${pid}:${tail[19]}`;
    } else if (process.platform === "win32") {
      const facts = readWindowsProcessIdentityFacts(pid);
      if (!facts)
        return null;
      source = `${pid}:${facts}`;
    } else {
      const bootResult = spawnSync2("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
      const factsResult = spawnSync2("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      const boot = bootResult.stdout.trim();
      const facts = factsResult.stdout.trim();
      if (bootResult.error || bootResult.status !== 0 || bootResult.stderr.trim() !== "" || factsResult.error || factsResult.status !== 0 || factsResult.stderr.trim() !== "" || !boot || !facts)
        return null;
      source = `${boot}:${pid}:${facts}`;
    }
    return source.trim().length > 0 ? sha256(source) : null;
  } catch {
    return null;
  }
}
async function currentAdmissionOwner() {
  const startToken = await readProcessStartToken(process.pid);
  if (!startToken)
    throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_UNAVAILABLE");
  return { pid: process.pid, start_token: startToken };
}
async function admissionOwnerState(owner) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return "gone";
  }
  const observed = await readProcessStartToken(owner.pid);
  if (observed === null)
    return "unknown";
  return observed === owner.start_token ? "matching" : "gone";
}

class EvolutionEvalWorker {
  options;
  root;
  clock;
  stopGraceMs;
  startupReconciliation;
  retentionTimers = new Map;
  active = new Map;
  spoolTail = Promise.resolve();
  constructor(options) {
    this.options = options;
    this.root = resolve2(options.spoolRoot);
    this.clock = options.now ?? (() => new Date);
    this.stopGraceMs = options.stopGraceMs ?? 5000;
    if (!options.toolchainProfileHash.match(/^[0-9a-f]{64}$/) || !Number.isSafeInteger(this.stopGraceMs) || this.stopGraceMs < 1 || this.stopGraceMs > 60000)
      throw new Error("CONFIG_INVALID");
    this.startupReconciliation = this.reconcileSpoolAdmissions().catch(() => {
      return;
    });
    setInterval(() => {
      this.reconcileSpoolAdmissions().catch(() => {
        return;
      });
    }, 60 * 60 * 1000).unref();
  }
  async query(bindingInput) {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    const observation = await this.options.ledger.query(binding);
    if (observation.state === "terminal")
      await this.reconcileSpoolAdmissions();
    return observation;
  }
  reserve(binding) {
    return this.options.ledger.queryOrReserve(validateCoreIssuedEvalBinding(binding));
  }
  async querySpool(bindingInput) {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    await this.reconcileSpoolAdmissions();
    return {
      schema: "evolution-eval-spool-result.v1",
      binding,
      unacked_bytes: await this.spoolBytes(),
      hard_cap_bytes: EVOLUTION_EVAL_SPOOL_HARD_CAP_BYTES
    };
  }
  async evidenceManifest(bindingInput) {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    await this.reconcileRetentionForBinding(binding);
    await this.assertEvidenceReadable(binding);
    return this.readEvidenceManifest(binding);
  }
  async queryRetention(bindingInput) {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    await this.startupReconciliation;
    await this.reconcileRetentionForBinding(binding);
    const observation = await this.options.ledger.getRetentionObservation(binding);
    if (observation.state === "absent") {
      return {
        schema: "evolution-eval-retention-result.v1",
        binding,
        state: "absent",
        retryable: false,
        authorization_kind: null,
        authorization_hash: null,
        connector_fact_hash: null,
        source_authorization_kind: null,
        source_authorization_hash: null,
        source_connector_fact_hash: null,
        error_code: null,
        physical_deleted: false
      };
    }
    if (observation.state === "pending_ack") {
      return {
        schema: "evolution-eval-retention-result.v1",
        binding,
        state: "pending_ack",
        retryable: false,
        authorization_kind: null,
        authorization_hash: null,
        connector_fact_hash: null,
        source_authorization_kind: null,
        source_authorization_hash: null,
        source_connector_fact_hash: null,
        error_code: null,
        physical_deleted: false
      };
    }
    if (observation.state === "acknowledged" || observation.state === "quarantined" || observation.state === "discarded" || observation.state === "cleaned" || observation.state === "expired") {
      const authorizationHash = observation.state === "acknowledged" || observation.state === "quarantined" || observation.state === "discarded" || observation.state === "cleaned" ? observation.authorizationHash : observation.factHash;
      const kind = observation.state === "acknowledged" ? "ack" : observation.state === "quarantined" ? "quarantine" : observation.state === "discarded" ? "discard" : observation.state === "expired" ? "expiry" : "cleanup";
      return this.retentionResult(binding, observation.state, kind, authorizationHash, observation.factHash, observation.state === "cleaned" ? {
        kind: observation.sourceKind,
        hash: observation.sourceAuthorizationHash,
        connectorFactHash: observation.authorizationFactHash
      } : undefined);
    }
    if (observation.state === "unavailable") {
      return {
        schema: "evolution-eval-retention-result.v1",
        binding,
        state: "transient_unavailable",
        retryable: true,
        authorization_kind: null,
        authorization_hash: null,
        connector_fact_hash: null,
        source_authorization_kind: null,
        source_authorization_hash: null,
        source_connector_fact_hash: null,
        error_code: "EVOLUTION_EVAL_LEDGER_UNAVAILABLE",
        physical_deleted: await this.evidenceBytesPurged(binding)
      };
    }
    throw new EvolutionEvalProtocolError(observation.state === "corrupt" ? "EVOLUTION_EVAL_EVIDENCE_CORRUPT" : "EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE");
  }
  async evidenceEntry(bindingInput, name) {
    const { binding, entry, path } = await this.evidenceEntryDescriptor(bindingInput, name);
    const bytes = await readFile2(path);
    return {
      schema: "evolution-eval-connector-evidence-entry.v1",
      eval_job_id: binding.dispatch.eval_job_id,
      connector_job_id: binding.dispatch.connector_job_id,
      dispatch_request_hash: binding.dispatch_request_hash,
      name: entry.name,
      sha256: entry.sha256,
      size_bytes: entry.size_bytes,
      media_type: entry.media_type,
      content_base64: bytes.toString("base64")
    };
  }
  async evidenceEntryDescriptor(bindingInput, name) {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    if (!evidenceNameRe.test(name))
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE");
    await this.reconcileRetentionForBinding(binding);
    await this.assertEvidenceReadable(binding);
    const manifest = await this.readEvidenceManifest(binding);
    const entry = manifest.entries.find((candidate) => candidate.name === name);
    if (!entry)
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE");
    const path = join2(this.jobWorkspace(binding), "output", name);
    let before;
    try {
      before = await lstat(path);
    } catch {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size !== entry.size_bytes || before.size > EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    const digest = createHash4("sha256");
    let total = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      total += chunk.byteLength;
      if (total > EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes || total > entry.size_bytes) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      digest.update(chunk);
    }
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || total !== entry.size_bytes || digest.digest("hex") !== entry.sha256) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    return { binding, entry, path };
  }
  async acknowledgeEvidence(bindingInput, hashes) {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    const observation = await this.options.ledger.markEvidenceAcknowledged(binding, hashes);
    if (!(observation.state === "acknowledged" || observation.state === "cleaned")) {
      throw new EvolutionEvalProtocolError(observation.state === "unavailable" ? "EVOLUTION_EVAL_LEDGER_UNAVAILABLE" : "EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    if (observation.state === "cleaned") {
      return this.retentionResult(binding, "acknowledged", "ack", observation.sourceAuthorizationHash, observation.authorizationFactHash);
    }
    await this.reconcileRetentionForBinding(binding);
    return this.retentionResult(binding, "acknowledged", "ack", observation.authorizationHash, observation.factHash);
  }
  async quarantineEvidence(bindingInput, hashes) {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    const observation = await this.options.ledger.markEvidenceQuarantined(binding, hashes);
    if (!(observation.state === "quarantined" || observation.state === "cleaned")) {
      throw new EvolutionEvalProtocolError(observation.state === "unavailable" ? "EVOLUTION_EVAL_LEDGER_UNAVAILABLE" : "EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    if (observation.state === "quarantined" && !await this.evidenceBytesPurged(binding)) {
      await this.moveEvidenceToQuarantine(binding);
      await this.reconcileRetentionForBinding(binding);
    }
    if (observation.state === "cleaned") {
      return this.retentionResult(binding, "quarantined", "quarantine", observation.sourceAuthorizationHash, observation.authorizationFactHash);
    }
    return this.retentionResult(binding, "quarantined", "quarantine", observation.authorizationHash, observation.factHash);
  }
  async cleanupEvidence(bindingInput, authorizationFactHash, coreCleanupFactHash) {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    const before = await this.options.ledger.getRetentionObservation(binding);
    if (before.state === "cleaned") {
      if (before.authorizationFactHash !== authorizationFactHash || before.authorizationHash !== coreCleanupFactHash) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      await this.deleteEvidenceBytes(binding);
      await this.releaseSpoolAdmission(binding, binding.dispatch.sealed_input_projection_hash);
      return this.retentionResult(binding, "cleaned", "cleanup", before.authorizationHash, before.factHash, {
        kind: before.sourceKind,
        hash: before.sourceAuthorizationHash,
        connectorFactHash: before.authorizationFactHash
      });
    }
    if (!(before.state === "acknowledged" || before.state === "quarantined") || before.factHash !== authorizationFactHash) {
      throw new EvolutionEvalProtocolError(before.state === "unavailable" ? "EVOLUTION_EVAL_LEDGER_UNAVAILABLE" : "EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    const cleaned = await this.options.ledger.markEvidenceCleaned(binding, authorizationFactHash, coreCleanupFactHash);
    if (cleaned.state !== "cleaned") {
      throw new EvolutionEvalProtocolError(cleaned.state === "unavailable" ? "EVOLUTION_EVAL_LEDGER_UNAVAILABLE" : "EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    await this.deleteEvidenceBytes(binding);
    await this.releaseSpoolAdmission(binding, binding.dispatch.sealed_input_projection_hash);
    return this.retentionResult(binding, "cleaned", "cleanup", cleaned.authorizationHash, cleaned.factHash, {
      kind: cleaned.sourceKind,
      hash: cleaned.sourceAuthorizationHash,
      connectorFactHash: cleaned.authorizationFactHash
    });
  }
  async discardEvidence(bindingInput, input) {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    let observation = await this.options.ledger.markEvidenceDiscarded(binding, input);
    if (!(observation.state === "discarded" || observation.state === "cleaned")) {
      throw new EvolutionEvalProtocolError(observation.state === "unavailable" ? "EVOLUTION_EVAL_LEDGER_UNAVAILABLE" : "EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    const execution = await this.options.ledger.query(binding);
    if (execution.state === "terminal" && observation.state === "discarded") {
      await this.deleteEvidenceBytes(binding);
      observation = await this.options.ledger.markEvidenceCleaned(binding, observation.factHash, observation.cleanupAuthorizationHash);
      if (observation.state === "cleaned") {
        await this.releaseSpoolAdmission(binding, binding.dispatch.sealed_input_projection_hash);
      }
    }
    if (observation.state === "cleaned") {
      return this.retentionResult(binding, "cleaned", "cleanup", observation.authorizationHash, observation.factHash, {
        kind: observation.sourceKind,
        hash: observation.sourceAuthorizationHash,
        connectorFactHash: observation.authorizationFactHash
      });
    }
    if (observation.state !== "discarded") {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_UNAVAILABLE");
    }
    return this.retentionResult(binding, "discarded", "discard", observation.authorizationHash, observation.factHash);
  }
  async submit(bindingInput, input) {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    const sealedInput = validateEvolutionEvalSealedInput(input, binding);
    const existing = await this.options.ledger.query(binding);
    if (existing.state === "accepted" || existing.state === "terminal") {
      await this.assertMaterializedProjection(binding, sealedInput.projectionHash);
      if (existing.state === "terminal")
        await this.reconcileSpoolAdmissions();
      return existing;
    }
    if (existing.state === "transient_unavailable" || existing.state === "ledger_corrupt")
      return existing;
    if (existing.state !== "proven_never_accepted" || !existing.replay_permitted)
      return existing;
    if (binding.dispatch.toolchain_profile_hash !== this.options.toolchainProfileHash) {
      return { ...evalCommon(binding, this.options.ledger.ledgerEpoch), state: "proven_never_accepted", replay_permitted: false };
    }
    const timeoutMs = effectiveEvolutionEvalTimeoutMs(binding, this.clock());
    const predecessor = this.spoolTail;
    const gate = Promise.withResolvers();
    this.spoolTail = gate.promise;
    await predecessor;
    let workspace;
    let accepted;
    let admissionOwnerCreated;
    let prepared;
    try {
      await this.reconcileSpoolAdmissions();
      admissionOwnerCreated = await this.reserveSpoolAdmission(binding, sealedInput.projectionHash);
      workspace = await this.materialize(binding, sealedInput);
      prepared = await this.options.execution.prepare?.({ workspace });
      await this.options.assertNewEffectReady?.();
      accepted = await this.options.ledger.markAccepted(binding, {
        executionState: "running",
        processIdentity: prepared?.identity
      });
      if (!accepted.accepted_now && prepared) {
        await prepared.close();
        prepared = undefined;
      }
    } catch (error) {
      await prepared?.close().catch(() => {
        return;
      });
      if (admissionOwnerCreated) {
        await this.releaseSpoolAdmission(binding, sealedInput.projectionHash, admissionOwnerCreated);
      }
      throw error;
    } finally {
      gate.resolve();
    }
    if (accepted.accepted_now && accepted.effect_owner_token) {
      const controller = new AbortController;
      const processStarted = Promise.withResolvers();
      const holder = {
        controller,
        settled: Promise.resolve(),
        ownerToken: accepted.effect_owner_token,
        processStarted: processStarted.promise,
        resolveProcessStarted: processStarted.resolve
      };
      holder.settled = this.execute(binding, sealedInput, workspace, timeoutMs, accepted.effect_owner_token, holder, prepared);
      this.active.set(binding.dispatch.connector_job_id, holder);
      holder.settled.finally(() => this.active.delete(binding.dispatch.connector_job_id));
    }
    return accepted.observation;
  }
  async cancel(bindingInput, reason) {
    const binding = validateCoreIssuedEvalBinding(bindingInput);
    const observation = await this.options.ledger.query(binding);
    if (observation.state !== "accepted")
      return observation;
    const active = this.active.get(binding.dispatch.connector_job_id);
    const stopAs = reason === "deadline" ? "timeout" : "cancelled";
    if (!await this.options.ledger.markStopRequested(binding, stopAs, active?.ownerToken)) {
      return {
        ...evalCommon(binding, this.options.ledger.ledgerEpoch),
        state: "ambiguous",
        effect_possible: true,
        error_code: "EVOLUTION_EVAL_STOP_UNCONFIRMED"
      };
    }
    if (active) {
      active.stopAs = stopAs;
      active.controller.abort(active.stopAs);
    }
    const identity = active?.identity ?? await this.options.ledger.getProcessIdentity(binding) ?? (active ? await Promise.race([
      active.processStarted,
      new Promise((resolve3) => setTimeout(() => resolve3(null), this.stopGraceMs))
    ]) : null);
    if (!identity)
      return { ...evalCommon(binding, this.options.ledger.ledgerEpoch), state: "ambiguous", effect_possible: true, error_code: "EVOLUTION_EVAL_STOP_UNCONFIRMED" };
    const confirmed = await this.stopAndConfirm(identity);
    if (!confirmed) {
      return {
        ...evalCommon(binding, this.options.ledger.ledgerEpoch),
        state: "ambiguous",
        effect_possible: true,
        error_code: "EVOLUTION_EVAL_STOP_UNCONFIRMED"
      };
    }
    if (active) {
      await Promise.race([active.settled, new Promise((resolve3) => setTimeout(resolve3, this.stopGraceMs))]);
      const current = await this.options.ledger.query(binding);
      if (current.state === "terminal")
        return current;
    }
    if (!await this.options.ledger.markProcessExitConfirmed(binding, identity, active?.ownerToken)) {
      return { ...evalCommon(binding, this.options.ledger.ledgerEpoch), state: "ambiguous", effect_possible: true, error_code: "EVOLUTION_EVAL_STOP_UNCONFIRMED" };
    }
    return this.options.ledger.markTerminalAfterConfirmedStop(binding, stopAs, stopAs === "timeout" ? "EVOLUTION_EVAL_DEADLINE_EXCEEDED" : "EVOLUTION_EVAL_CANCELLED");
  }
  jobWorkspace(binding) {
    return join2(this.root, "jobs", sha256(binding.dispatch.connector_job_id));
  }
  evidenceManifestPath(binding) {
    return join2(this.jobWorkspace(binding), "evidence-manifest.json");
  }
  async readEvidenceManifest(binding) {
    try {
      const path = this.evidenceManifestPath(binding);
      const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink() || details.size < 2 || details.size > 1024 * 1024) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      return assertConnectorEvidenceManifest(JSON.parse(await readFile2(path, "utf8")), binding);
    } catch (error) {
      if (error instanceof EvolutionEvalProtocolError)
        throw error;
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
  }
  async persistEvidenceManifest(binding, manifest) {
    const target = this.evidenceManifestPath(binding);
    try {
      const prior = await this.readEvidenceManifest(binding);
      if (canonicalEvolutionEvalHash(prior) !== canonicalEvolutionEvalHash(manifest)) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      return;
    } catch (error) {
      if (error instanceof EvolutionEvalProtocolError && error.code !== "EVOLUTION_EVAL_EVIDENCE_CORRUPT")
        throw error;
      try {
        await lstat(target);
        throw error;
      } catch (statError) {
        if (!(statError instanceof Error && ("code" in statError) && statError.code === "ENOENT"))
          throw error;
      }
    }
    const temporary = join2(dirname2(target), `.evidence-manifest-${crypto.randomUUID()}.tmp`);
    await writeFile2(temporary, JSON.stringify(manifest), { flag: "wx", mode: 384 });
    await syncFile(temporary);
    try {
      if (process.platform === "win32") {
        const outcome = windowsMoveWriteThrough(temporary, target);
        if (outcome === "exists") {
          const prior = await this.readEvidenceManifest(binding);
          if (canonicalEvolutionEvalHash(prior) !== canonicalEvolutionEvalHash(manifest)) {
            throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
          }
        }
      } else {
        try {
          await link(temporary, target);
        } catch (error) {
          if (!(error instanceof Error && ("code" in error) && error.code === "EEXIST"))
            throw error;
          const prior = await this.readEvidenceManifest(binding);
          if (canonicalEvolutionEvalHash(prior) !== canonicalEvolutionEvalHash(manifest)) {
            throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
          }
        }
      }
      await syncDirectory(dirname2(target));
    } finally {
      await unlink2(temporary).catch(() => {
        return;
      });
    }
  }
  async validateAndPersistEvidence(binding, workspace, evidence2) {
    if (evidence2.jobId !== binding.dispatch.connector_job_id || !Array.isArray(evidence2.entries) || evidence2.entries.length > EVOLUTION_EVAL_EVIDENCE_LIMITS.entries) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_LIMIT_EXCEEDED");
    }
    const outputDirectory = join2(workspace, "output");
    let outputDetails;
    try {
      outputDetails = await lstat(outputDirectory);
    } catch {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    if (!outputDetails.isDirectory() || outputDetails.isSymbolicLink()) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    const directoryNames = (await readdir2(outputDirectory)).sort();
    const reportedNames = evidence2.entries.map((entry) => entry.name).sort();
    if (JSON.stringify(directoryNames) !== JSON.stringify(reportedNames)) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    }
    const entries = [];
    const names = new Set;
    let totalBytes = 0;
    for (const reported of [...evidence2.entries].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (typeof reported.name !== "string" || !evidenceNameRe.test(reported.name) || names.has(reported.name) || reported.uri !== `workspace://${binding.dispatch.connector_job_id}/output/${reported.name}` || !/^[0-9a-f]{64}$/.test(String(reported.sha256)) || !Number.isSafeInteger(reported.sizeBytes) || reported.sizeBytes < 0 || reported.sizeBytes > EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes || !["application/json", "text/plain", "application/octet-stream"].includes(reported.mediaType) || evolutionEvidenceMediaType(reported.name) !== null && evolutionEvidenceMediaType(reported.name) !== reported.mediaType) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      names.add(reported.name);
      const path = join2(outputDirectory, reported.name);
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size !== reported.sizeBytes) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      const bytes = await readFile2(path);
      const after = await lstat(path);
      if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || bytes.byteLength !== reported.sizeBytes || sha256(bytes) !== reported.sha256) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      totalBytes += bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > EVOLUTION_EVAL_EVIDENCE_LIMITS.totalBytes) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_LIMIT_EXCEEDED");
      }
      entries.push({
        name: reported.name,
        sha256: reported.sha256,
        size_bytes: reported.sizeBytes,
        media_type: reported.mediaType,
        artifact_classification: evidenceArtifactClassification(reported.name),
        usage_classification: "evolution_eval_only"
      });
    }
    const canonical = {
      schema: "evolution-eval-connector-evidence-manifest.v1",
      eval_job_id: binding.dispatch.eval_job_id,
      connector_job_id: binding.dispatch.connector_job_id,
      dispatch_request_hash: binding.dispatch_request_hash,
      entries
    };
    const manifest = {
      ...canonical,
      manifest_hash: canonicalEvolutionEvalHash(canonical)
    };
    assertConnectorEvidenceManifest(manifest, binding);
    await this.persistEvidenceManifest(binding, manifest);
    return manifest;
  }
  async assertEvidenceReadable(binding) {
    if (await this.evidenceBytesPurged(binding)) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE");
    }
    const terminal2 = await this.options.ledger.query(binding);
    if (terminal2.state !== "terminal") {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE");
    }
    const retention = await this.options.ledger.getRetentionObservation(binding);
    if (!(retention.state === "pending_ack" || retention.state === "acknowledged")) {
      throw new EvolutionEvalProtocolError(retention.state === "unavailable" ? "EVOLUTION_EVAL_LEDGER_UNAVAILABLE" : retention.state === "corrupt" || retention.state === "quarantined" ? "EVOLUTION_EVAL_EVIDENCE_CORRUPT" : "EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE");
    }
  }
  async retentionResult(binding, state, authorizationKind, authorizationHash, connectorFactHash, source) {
    return {
      schema: "evolution-eval-retention-result.v1",
      binding,
      state,
      retryable: false,
      authorization_kind: authorizationKind,
      authorization_hash: authorizationHash,
      connector_fact_hash: connectorFactHash,
      source_authorization_kind: source?.kind ?? null,
      source_authorization_hash: source?.hash ?? null,
      source_connector_fact_hash: source?.connectorFactHash ?? null,
      error_code: null,
      physical_deleted: await this.evidenceBytesPurged(binding)
    };
  }
  async moveEvidenceToQuarantine(binding) {
    const workspace = this.jobWorkspace(binding);
    const source = join2(workspace, "output");
    const target = join2(workspace, "quarantine-output");
    try {
      const targetDetails = await lstat(target);
      if (!targetDetails.isDirectory() || targetDetails.isSymbolicLink()) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      try {
        await lstat(source);
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      } catch (error) {
        if (error instanceof EvolutionEvalProtocolError)
          throw error;
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          return;
        throw error;
      }
    } catch (error) {
      if (error instanceof EvolutionEvalProtocolError)
        throw error;
      if (!(error instanceof Error && ("code" in error) && error.code === "ENOENT"))
        throw error;
    }
    if (process.platform === "win32") {
      const outcome = windowsMoveWriteThrough(source, target);
      if (outcome === "exists")
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    } else {
      await rename(source, target);
    }
    await syncDirectory(workspace);
  }
  async deleteEvidenceBytes(binding) {
    const workspace = this.jobWorkspace(binding);
    await rm(join2(workspace, "output"), { recursive: true, force: true });
    await rm(join2(workspace, "quarantine-output"), { recursive: true, force: true });
    const tombstone = join2(workspace, "evidence-purged.json");
    try {
      await writeFile2(tombstone, JSON.stringify({
        schema: "evolution-eval-evidence-purged.v1",
        connector_job_id: binding.dispatch.connector_job_id,
        dispatch_request_hash: binding.dispatch_request_hash
      }), { flag: "wx", mode: 384 });
      await syncFile(tombstone);
    } catch (error) {
      if (!(error instanceof Error && ("code" in error) && error.code === "EEXIST"))
        throw error;
    }
    await syncDirectory(workspace);
  }
  async evidenceBytesPurged(binding) {
    try {
      const value = JSON.parse(await readFile2(join2(this.jobWorkspace(binding), "evidence-purged.json"), "utf8"));
      if (Reflect.ownKeys(value).length !== 3 || value.schema !== "evolution-eval-evidence-purged.v1" || value.connector_job_id !== binding.dispatch.connector_job_id || value.dispatch_request_hash !== binding.dispatch_request_hash) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
      }
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return false;
      throw error;
    }
  }
  async reconcileRetentionForBinding(binding) {
    const terminal2 = await this.options.ledger.query(binding);
    if (terminal2.state !== "terminal")
      return;
    let retention = await this.options.ledger.getRetentionObservation(binding);
    const absoluteDeleteAt = Date.parse(terminal2.terminal_at) + EVOLUTION_EVAL_EVIDENCE_LIMITS.absoluteRetentionMs;
    if (retention.state === "pending_ack" && this.clock().getTime() >= absoluteDeleteAt) {
      retention = await this.options.ledger.markEvidenceExpired(binding);
    }
    if (retention.state === "acknowledged" && this.clock().getTime() >= absoluteDeleteAt) {
      await this.deleteEvidenceBytes(binding);
      await this.releaseSpoolAdmission(binding, binding.dispatch.sealed_input_projection_hash);
    } else if (retention.state === "expired" || retention.state === "quarantined" && this.clock().getTime() >= Math.min(Date.parse(retention.deleteBy), absoluteDeleteAt)) {
      await this.deleteEvidenceBytes(binding);
      await this.releaseSpoolAdmission(binding, binding.dispatch.sealed_input_projection_hash);
    }
    if (retention.state === "discarded") {
      await this.deleteEvidenceBytes(binding);
      retention = await this.options.ledger.markEvidenceCleaned(binding, retention.factHash, retention.cleanupAuthorizationHash);
    }
    if (retention.state === "cleaned") {
      await this.deleteEvidenceBytes(binding);
      await this.releaseSpoolAdmission(binding, binding.dispatch.sealed_input_projection_hash);
    }
    await this.scheduleRetentionForBinding(binding, terminal2.terminal_at, retention);
  }
  async scheduleRetentionForBinding(binding, terminalAt, retention) {
    const key = binding.dispatch.connector_job_id;
    const prior = this.retentionTimers.get(key);
    if (prior)
      clearTimeout(prior);
    this.retentionTimers.delete(key);
    if (await this.evidenceBytesPurged(binding))
      return;
    const absoluteDeleteAt = Date.parse(terminalAt) + EVOLUTION_EVAL_EVIDENCE_LIMITS.absoluteRetentionMs;
    const deleteAt = retention.state === "quarantined" ? Math.min(Date.parse(retention.deleteBy), absoluteDeleteAt) : retention.state === "pending_ack" || retention.state === "acknowledged" || retention.state === "expired" ? absoluteDeleteAt : null;
    if (deleteAt === null)
      return;
    const delay = Math.max(0, Math.min(deleteAt - this.clock().getTime(), 2147483647));
    const timer = setTimeout(() => {
      this.retentionTimers.delete(key);
      this.reconcileRetentionForBinding(binding).catch(() => {
        return;
      });
    }, delay);
    timer.unref();
    this.retentionTimers.set(key, timer);
  }
  async execute(binding, sealedInput, workspace, timeoutMs, ownerToken, holder, prepared) {
    const deadlineAt = Date.parse(binding.dispatch.deadline_at);
    const requestTimeout = Math.max(0, Math.min(timeoutMs, deadlineAt - this.clock().getTime()));
    const deadlineTimer = setTimeout(() => {
      this.options.ledger.markStopRequested(binding, "timeout", ownerToken).then((durable) => {
        if (!durable)
          return;
        holder.stopAs = "timeout";
        holder.controller.abort("timeout");
      });
    }, requestTimeout);
    try {
      let result;
      try {
        const onBeforeLaunch = async () => {
          try {
            await this.options.assertNewEffectReady?.();
          } catch {
            holder.controller.abort("toolchain_readiness_drift");
            return false;
          }
          const expired = this.clock().getTime() >= deadlineAt;
          if (expired && await this.options.ledger.markStopRequested(binding, "timeout", ownerToken)) {
            holder.stopAs = "timeout";
            holder.controller.abort("timeout");
          }
          const stopObservation = await this.options.ledger.getStopObservation(binding);
          if (stopObservation.state === "stop_requested") {
            holder.stopAs = stopObservation.reason;
            holder.controller.abort(stopObservation.reason);
          } else if (stopObservation.state !== "absent") {
            holder.controller.abort("launch_gate_unavailable");
          }
          return !holder.controller.signal.aborted && !expired && stopObservation.state === "absent";
        };
        if (prepared) {
          const launchPermitted = await this.options.ledger.markProcessStarted(binding, prepared.identity, ownerToken);
          const recorded = launchPermitted ? prepared.identity : await this.options.ledger.getProcessIdentity(binding);
          if (!recorded || recorded.pid !== prepared.identity.pid || recorded.processGroupId !== prepared.identity.processGroupId || recorded.startToken !== prepared.identity.startToken) {
            holder.resolveProcessStarted(null);
            await prepared.close();
            throw new Error("EVOLUTION_EVAL_PROCESS_IDENTITY_UNAVAILABLE");
          }
          holder.identity = recorded;
          holder.resolveProcessStarted(recorded);
        }
        result = prepared ? await prepared.execute({
          binding,
          sealedInput,
          workspace,
          timeoutMs,
          signal: holder.controller.signal,
          onBeforeLaunch
        }) : await this.options.execution.execute({
          binding,
          sealedInput,
          workspace,
          timeoutMs,
          signal: holder.controller.signal,
          onProcessStarted: async (identity) => {
            const launchPermitted = await this.options.ledger.markProcessStarted(binding, identity, ownerToken);
            const recorded = launchPermitted ? identity : await this.options.ledger.getProcessIdentity(binding);
            if (!recorded || recorded.pid !== identity.pid || recorded.processGroupId !== identity.processGroupId || recorded.startToken !== identity.startToken) {
              holder.resolveProcessStarted(null);
              return false;
            }
            holder.identity = recorded;
            holder.resolveProcessStarted(recorded);
            const expired = this.clock().getTime() >= deadlineAt;
            if (expired && await this.options.ledger.markStopRequested(binding, "timeout", ownerToken)) {
              holder.stopAs = "timeout";
              holder.controller.abort("timeout");
            }
            const stopObservation = await this.options.ledger.getStopObservation(binding);
            if (stopObservation.state === "stop_requested") {
              holder.stopAs = stopObservation.reason;
              holder.controller.abort(stopObservation.reason);
            } else if (stopObservation.state !== "absent") {
              holder.controller.abort("launch_gate_unavailable");
            }
            return launchPermitted && !holder.controller.signal.aborted && !expired && stopObservation.state === "absent";
          },
          onBeforeLaunch
        });
      } catch {
        result = { terminalState: "failed", errorCode: "EVOLUTION_EVAL_EXECUTION_FAILED" };
      }
      holder.resolveProcessStarted(holder.identity ?? null);
      if (result.terminalState === "timeout" && await this.options.ledger.markStopRequested(binding, "timeout", ownerToken)) {
        holder.stopAs = "timeout";
        holder.controller.abort("timeout");
      }
      const terminalState = holder.stopAs ?? result.terminalState;
      const errorCode = holder.stopAs === "timeout" ? "EVOLUTION_EVAL_DEADLINE_EXCEEDED" : holder.stopAs === "cancelled" ? "EVOLUTION_EVAL_CANCELLED" : result.errorCode ?? null;
      if (!holder.identity)
        return;
      let verifiedTerminalState = terminalState;
      let verifiedErrorCode = errorCode;
      if (!this.processTreeStopped(holder.identity)) {
        const stopped = await this.stopAndConfirm(holder.identity);
        if (!stopped)
          return;
        if (!holder.stopAs) {
          verifiedTerminalState = "failed";
          verifiedErrorCode = "EVOLUTION_EVAL_ORPHAN_PROCESS";
        }
      }
      if (!await this.options.ledger.markProcessExitConfirmed(binding, holder.identity, ownerToken))
        return;
      let retainedOutput = false;
      let retentionFence = await this.options.ledger.getRetentionObservation(binding);
      if (result.evidence && retentionFence.state !== "discarded" && retentionFence.state !== "cleaned") {
        try {
          const manifest = await this.validateAndPersistEvidence(binding, workspace, result.evidence);
          const totalBytes = manifest.entries.reduce((total, entry) => total + entry.size_bytes, 0);
          retainedOutput = await this.options.ledger.markOutput(binding, {
            spoolManifestHash: manifest.manifest_hash,
            entryCount: manifest.entries.length,
            totalBytes
          }, ownerToken);
          if (!retainedOutput) {
            const afterOutputRace = await this.options.ledger.getRetentionObservation(binding);
            if (!(afterOutputRace.state === "discarded" || afterOutputRace.state === "cleaned"))
              return;
            retentionFence = afterOutputRace;
            await this.deleteEvidenceBytes(binding);
          }
        } catch {
          verifiedTerminalState = "failed";
          verifiedErrorCode = "EVOLUTION_EVAL_EVIDENCE_CORRUPT";
          await rm(join2(workspace, "output"), { recursive: true, force: true });
        }
      }
      const terminal2 = await this.options.ledger.markTerminal(binding, { terminalState: verifiedTerminalState, errorCode: verifiedErrorCode }, ownerToken);
      if (terminal2.state === "terminal" && retentionFence.state === "discarded") {
        await this.deleteEvidenceBytes(binding);
        const cleaned = await this.options.ledger.markEvidenceCleaned(binding, retentionFence.factHash, retentionFence.cleanupAuthorizationHash);
        if (cleaned.state === "cleaned") {
          await this.releaseSpoolAdmission(binding, sealedInput.projectionHash);
        }
        return;
      }
      if (terminal2.state === "terminal" && !retainedOutput) {
        await this.releaseSpoolAdmission(binding, sealedInput.projectionHash);
      } else if (terminal2.state === "terminal") {
        await this.reconcileRetentionForBinding(binding);
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
  }
  processTreeStopped(identity) {
    if (this.options.processSupervisor)
      return this.options.processSupervisor.isTreeStopped(identity);
    try {
      process.kill(process.platform === "win32" ? identity.pid : -identity.processGroupId, 0);
      return false;
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "ESRCH";
    }
  }
  async ownsProcessIdentity(identity) {
    if (this.options.processSupervisor)
      return this.options.processSupervisor.ownsIdentity(identity);
    if (this.processTreeStopped(identity))
      return true;
    return await readProcessStartToken(identity.pid) === identity.startToken;
  }
  async stopAndConfirm(identity) {
    if (this.options.processSupervisor) {
      if (!await this.options.processSupervisor.ownsIdentity(identity))
        return false;
      return this.options.processSupervisor.stopAndConfirm(identity, this.stopGraceMs);
    }
    if (!await this.ownsProcessIdentity(identity))
      return false;
    if (!this.processTreeStopped(identity)) {
      if (process.platform === "win32") {
        const killed = spawnSync2("taskkill", ["/PID", String(identity.pid), "/T", "/F"], { stdio: "ignore" });
        if (killed.status !== 0 && !this.processTreeStopped(identity))
          return false;
      } else {
        try {
          process.kill(-identity.processGroupId, "SIGTERM");
        } catch {}
      }
    }
    const deadline = Date.now() + this.stopGraceMs;
    while (Date.now() < deadline) {
      if (this.processTreeStopped(identity))
        return true;
      await new Promise((resolve3) => setTimeout(resolve3, 10));
    }
    if (process.platform !== "win32") {
      try {
        process.kill(-identity.processGroupId, "SIGKILL");
      } catch {}
      const forceDeadline = Date.now() + Math.min(this.stopGraceMs, 1000);
      while (Date.now() < forceDeadline) {
        if (this.processTreeStopped(identity))
          return true;
        await new Promise((resolve3) => setTimeout(resolve3, 10));
      }
    }
    return this.processTreeStopped(identity);
  }
  async materialize(binding, input) {
    const jobs = join2(this.root, "jobs");
    const key = sha256(binding.dispatch.connector_job_id);
    const target = join2(jobs, key);
    const temporary = join2(jobs, `${key}.staging-${crypto.randomUUID()}`);
    await mkdir2(jobs, { recursive: true, mode: 448 });
    try {
      const prior = JSON.parse(await readFile2(join2(target, "binding.json"), "utf8"));
      if (prior.dispatch_request_hash !== binding.dispatch_request_hash || prior.sealed_input_projection_hash !== input.projectionHash) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_BINDING_CONFLICT");
      }
      return target;
    } catch (error) {
      if (error instanceof EvolutionEvalProtocolError)
        throw error;
      if (error instanceof Error && "code" in error && error.code !== "ENOENT")
        throw error;
    }
    await mkdir2(join2(temporary, "input"), { recursive: true, mode: 448 });
    try {
      for (let index = 0;index < input.files.length; index += 1) {
        const file = input.files[index];
        const manifestFile = input.manifest.files.find((candidate) => candidate.path === file.path);
        const path = join2(temporary, "input", file.path);
        await mkdir2(dirname2(path), { recursive: true, mode: 448 });
        const handle = await open(path, "wx", 384);
        try {
          await handle.writeFile(file.content);
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (manifestFile.read_only)
          await chmod2(path, 256);
      }
      const bindingPath = join2(temporary, "binding.json");
      await writeFile2(bindingPath, JSON.stringify({
        dispatch_request_hash: binding.dispatch_request_hash,
        workspace_manifest_hash: binding.dispatch.workspace_manifest_hash,
        sealed_input_projection_hash: input.projectionHash
      }), { flag: "wx", mode: 384 });
      await syncFile(bindingPath);
      await syncDirectory(temporary);
      if (process.platform === "win32") {
        const outcome = windowsMoveWriteThrough(temporary, target);
        if (outcome === "exists") {
          await rm(temporary, { recursive: true, force: true });
          return this.assertMaterializedProjection(binding, input.projectionHash).then(() => target);
        }
      } else {
        await rename(temporary, target);
      }
      await syncDirectory(jobs);
      return target;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  async spoolBytes() {
    const admissions = await this.readSpoolAdmissions();
    return admissions.length * EVOLUTION_EVAL_ADMISSION_BYTES;
  }
  async readSpoolAdmissions() {
    const directory = join2(this.root, "admissions");
    try {
      const details = await lstat(directory);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_CORRUPT");
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
    const admissions = [];
    const seenJobs = new Set;
    for (let slot = 0;slot < EVOLUTION_EVAL_ADMISSION_SLOTS; slot += 1) {
      try {
        const value = JSON.parse(await readFile2(join2(directory, `slot-${slot}.json`), "utf8"));
        const ownerProcess = value.owner_process;
        if (Reflect.ownKeys(value).length !== 7 || value.schema !== "evolution-eval-spool-admission.v2" || typeof value.connector_job_id !== "string" || !idRe2.test(value.connector_job_id) || typeof value.dispatch_request_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.dispatch_request_hash) || typeof value.sealed_input_projection_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.sealed_input_projection_hash) || !ownerProcess || Reflect.ownKeys(ownerProcess).length !== 2 || !Number.isSafeInteger(ownerProcess.pid) || Number(ownerProcess.pid) < 1 || typeof ownerProcess.start_token !== "string" || !/^[0-9a-f]{64}$/.test(ownerProcess.start_token) || value.reserved_bytes !== EVOLUTION_EVAL_ADMISSION_BYTES) {
          throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_CORRUPT");
        }
        if (seenJobs.has(value.connector_job_id)) {
          throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_CORRUPT");
        }
        seenJobs.add(value.connector_job_id);
        const admissionBinding = validateCoreIssuedEvalBinding(value.binding);
        if (admissionBinding.dispatch.connector_job_id !== value.connector_job_id || admissionBinding.dispatch_request_hash !== value.dispatch_request_hash || admissionBinding.dispatch.sealed_input_projection_hash !== value.sealed_input_projection_hash) {
          throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_CORRUPT");
        }
        admissions.push({
          slot,
          connector_job_id: value.connector_job_id,
          dispatch_request_hash: value.dispatch_request_hash,
          sealed_input_projection_hash: value.sealed_input_projection_hash,
          owner_process: { pid: Number(ownerProcess.pid), start_token: ownerProcess.start_token },
          binding: admissionBinding
        });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          continue;
        if (error instanceof EvolutionEvalProtocolError)
          throw error;
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_CORRUPT");
      }
    }
    return admissions;
  }
  async resolveExistingAdmission(prior, binding, projectionHash, ownerProcess) {
    if (prior.dispatch_request_hash !== binding.dispatch_request_hash || prior.sealed_input_projection_hash !== projectionHash) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_BINDING_CONFLICT");
    }
    if (prior.owner_process.pid === ownerProcess.pid && prior.owner_process.start_token === ownerProcess.start_token)
      return "owned";
    const ownerState = await admissionOwnerState(prior.owner_process);
    if (ownerState !== "gone") {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    }
    const ledgerState = await this.options.ledger.query(binding);
    if (ledgerState.state !== "proven_never_accepted" || !ledgerState.replay_permitted) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    }
    await this.releaseSpoolAdmission(binding, projectionHash, prior.owner_process);
    return "reclaimed";
  }
  async reserveSpoolAdmission(binding, projectionHash) {
    const directory = join2(this.root, "admissions");
    const temporaryDirectory = join2(directory, "tmp");
    await mkdir2(temporaryDirectory, { recursive: true, mode: 448 });
    const ownerProcess = await currentAdmissionOwner();
    const existing = await this.readSpoolAdmissions();
    const prior = existing.find((item) => item.connector_job_id === binding.dispatch.connector_job_id);
    if (prior) {
      if (await this.resolveExistingAdmission(prior, binding, projectionHash, ownerProcess) === "owned") {
        return;
      }
    }
    const payload = JSON.stringify({
      schema: "evolution-eval-spool-admission.v2",
      connector_job_id: binding.dispatch.connector_job_id,
      dispatch_request_hash: binding.dispatch_request_hash,
      sealed_input_projection_hash: projectionHash,
      reserved_bytes: EVOLUTION_EVAL_ADMISSION_BYTES,
      owner_process: ownerProcess,
      binding
    });
    const temporary = join2(temporaryDirectory, `${sha256(binding.dispatch.connector_job_id)}-${crypto.randomUUID()}.json`);
    await writeFile2(temporary, payload, { flag: "wx", mode: 384 });
    await syncFile(temporary);
    const start = Number.parseInt(sha256(binding.dispatch.connector_job_id).slice(0, 8), 16) % EVOLUTION_EVAL_ADMISSION_SLOTS;
    try {
      for (let offset = 0;offset < EVOLUTION_EVAL_ADMISSION_SLOTS; offset += 1) {
        const slot = (start + offset) % EVOLUTION_EVAL_ADMISSION_SLOTS;
        try {
          const slotPath = join2(directory, `slot-${slot}.json`);
          if (process.platform === "win32") {
            if (windowsMoveWriteThrough(temporary, slotPath) === "exists") {
              const conflict = new Error("slot exists");
              conflict.code = "EEXIST";
              throw conflict;
            }
          } else {
            await link(temporary, slotPath);
          }
          if (process.platform !== "win32") {
            try {
              await syncDirectory(directory);
            } catch (error) {
              try {
                await unlink2(slotPath);
                await syncDirectory(directory);
              } catch {}
              throw error;
            }
          }
          return ownerProcess;
        } catch (error) {
          if (!(error instanceof Error && ("code" in error) && error.code === "EEXIST"))
            throw error;
          const raced = (await this.readSpoolAdmissions()).find((item) => item.connector_job_id === binding.dispatch.connector_job_id);
          if (raced) {
            if (await this.resolveExistingAdmission(raced, binding, projectionHash, ownerProcess) === "owned") {
              return;
            }
            offset -= 1;
          }
        }
      }
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_SPOOL_FULL");
    } finally {
      try {
        await unlink2(temporary);
      } catch {}
    }
  }
  async releaseSpoolAdmission(binding, projectionHash, expectedOwner) {
    const directory = join2(this.root, "admissions");
    const prior = (await this.readSpoolAdmissions()).find((item) => item.connector_job_id === binding.dispatch.connector_job_id);
    if (!prior)
      return;
    if (prior.dispatch_request_hash !== binding.dispatch_request_hash || prior.sealed_input_projection_hash !== projectionHash) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_BINDING_CONFLICT");
    }
    if (expectedOwner && (prior.owner_process.pid !== expectedOwner.pid || prior.owner_process.start_token !== expectedOwner.start_token)) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    }
    const slotPath = join2(directory, `slot-${prior.slot}.json`);
    if (process.platform === "win32") {
      const temporaryDirectory = join2(directory, "tmp");
      await mkdir2(temporaryDirectory, { recursive: true, mode: 448 });
      await syncDirectory(temporaryDirectory);
      const tombstone = join2(temporaryDirectory, `released-${crypto.randomUUID()}.json`);
      if (windowsMoveWriteThrough(slotPath, tombstone) !== "created") {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_LEDGER_UNAVAILABLE");
      }
      await unlink2(tombstone);
    } else {
      try {
        await unlink2(slotPath);
      } catch (error) {
        if (!(error instanceof Error && ("code" in error) && error.code === "ENOENT"))
          throw error;
      }
    }
    await syncDirectory(directory);
  }
  async reconcileSpoolAdmissions() {
    for (const admission of await this.readSpoolAdmissions()) {
      const observation = await this.options.ledger.query(admission.binding);
      if (observation.state === "terminal") {
        const retention = await this.options.ledger.getRetentionObservation(admission.binding);
        if (retention.state === "absent") {
          await this.releaseSpoolAdmission(admission.binding, admission.sealed_input_projection_hash);
        } else {
          await this.reconcileRetentionForBinding(admission.binding);
        }
        continue;
      }
      if (observation.state === "proven_never_accepted" && observation.replay_permitted && await admissionOwnerState(admission.owner_process) === "gone") {
        await this.releaseSpoolAdmission(admission.binding, admission.sealed_input_projection_hash);
      }
    }
  }
  async assertMaterializedProjection(binding, projectionHash) {
    const key = sha256(binding.dispatch.connector_job_id);
    try {
      const stored = JSON.parse(await readFile2(join2(this.root, "jobs", key, "binding.json"), "utf8"));
      if (stored.dispatch_request_hash !== binding.dispatch_request_hash || stored.sealed_input_projection_hash !== projectionHash) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_BINDING_CONFLICT");
      }
    } catch (error) {
      if (error instanceof EvolutionEvalProtocolError)
        throw error;
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_BINDING_CONFLICT");
    }
  }
}

class WorkerRuntime {
  endpoint;
  root;
  execution;
  clock;
  registration;
  discovery;
  active = 0;
  leaseExpiresAt;
  jobs = new Map;
  jobBindings = new Map;
  keys = new Map;
  pending = [];
  evolutionEval;
  constructor(o) {
    this.endpoint = copy(o.endpoint);
    this.root = o.workspaceRoot;
    this.execution = o.execution ?? unavailableExecution;
    this.clock = o.now ?? (() => new Date);
    this.evolutionEval = o.evolutionEval ? new EvolutionEvalWorker(o.evolutionEval) : undefined;
    if (!idRe2.test(this.endpoint.connector_id) || this.endpoint.protocol_version !== REMOTE_SCHEMA_VERSION || this.endpoint.max_concurrency < 1)
      throw new Error("CONFIG_INVALID");
  }
  discoveryReady() {
    const advertisesEvolutionEval = this.discovery?.capabilities.some((capability) => capability.runClasses.includes("evolution_eval")) === true;
    return this.discovery?.license_status === "available" && this.discovery.capabilities.length > 0 && this.discovery.unsupported?.length === undefined && (!advertisesEvolutionEval || validEvolutionEvalRemoteAttestation(this.discovery));
  }
  leaseReady() {
    const ready = this.registration?.registration_state === "ready" && this.leaseExpiresAt !== undefined && this.clock().getTime() < this.leaseExpiresAt;
    if (!ready && this.registration?.registration_state === "ready") {
      this.registration = { ...this.registration, registration_state: "offline" };
    }
    return ready;
  }
  hasDrift(discovery) {
    return discovery.connector_protocol_version !== this.endpoint.protocol_version || discovery.toolchain_profile_hash !== this.endpoint.toolchain_profile_hash || this.endpoint.expected_capability_map_version !== undefined && discovery.capability_map_version !== this.endpoint.expected_capability_map_version || this.endpoint.expected_part_catalog_hash !== undefined && discovery.part_catalog_hash !== this.endpoint.expected_part_catalog_hash || this.endpoint.expected_sdk_worker_build_hash !== undefined && discovery.sdk_worker_build_hash !== this.endpoint.expected_sdk_worker_build_hash || discovery.license_status !== "available";
  }
  async handle(request) {
    if (request.method !== "POST")
      return responseError("METHOD_NOT_ALLOWED", "POST required", 405);
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json")
      return responseError("UNSUPPORTED_MEDIA_TYPE", "application/json required", 415);
    const pathname = new URL(request.url).pathname;
    let e;
    try {
      e = pathname.startsWith("/evolution-eval/") ? await boundedJson(request, EVOLUTION_EVAL_HTTP_BODY_MAX_BYTES) : await request.json();
    } catch (error) {
      if (error instanceof EvolutionEvalProtocolError)
        return responseError(error.code, error.message, error.code === "EVOLUTION_EVAL_RESOURCE_LIMIT" ? 413 : 400);
      return responseError("INVALID_JSON", "request body must be JSON", 400);
    }
    const invalid = this.validateEnvelope(e);
    if (invalid)
      return invalid;
    if (pathname.startsWith("/evolution-eval/") && (!exactObjectKeys(e, ["actor", "capability_version", "classification", "correlation_id", "idempotency_key", "payload", "project_id", "schema_version"], ["causation_id"]) || !exactObjectKeys(e.actor, ["actor_id", "actor_type"])))
      return responseError("EVOLUTION_EVAL_INVALID_REQUEST", "non-canonical envelope", 400);
    const fingerprint = sha256(JSON.stringify({ ...e, correlation_id: undefined }));
    const key = `${e.project_id}:${e.classification}:${e.actor.actor_type}:${e.actor.actor_id}:${e.idempotency_key}`;
    const evalRoute = pathname.startsWith("/evolution-eval/");
    const expectedAttestation = pathname === "/evolution-eval/reserve" || pathname === "/evolution-eval/submit" ? {
      active_config_sha256: request.headers.get(EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER) ?? "",
      worker_process_instance_id: request.headers.get(EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER) ?? "",
      vivado_toolchain_attestation_sha256: request.headers.get(EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER) ?? ""
    } : undefined;
    const prior = evalRoute ? undefined : this.keys.get(key);
    if (prior)
      return prior.fingerprint === fingerprint ? Response.json(prior.body, { status: prior.status }) : responseError("IDEMPOTENCY_CONFLICT", "idempotency key was used with a different request", 409);
    try {
      if (pathname === "/evolution-eval/evidence/entry")
        return await this.evolutionEvalEntryResponse(e);
      const out = await this.route(pathname, e, expectedAttestation);
      if (!evalRoute)
        this.keys.set(key, { fingerprint, status: out.status, body: out.body });
      return this.ok(out.body, out.status);
    } catch (cause) {
      const code = cause instanceof EvolutionEvalProtocolError ? cause.code : cause instanceof Error ? cause.message : "WORKER_ERROR";
      const status = code === "JOB_NOT_FOUND" || code === "EVIDENCE_NOT_AVAILABLE" || code === "NOT_FOUND" || code === "EVOLUTION_EVAL_EVIDENCE_NOT_AVAILABLE" ? 404 : code === "EVIDENCE_CORRUPT" || code === "EVOLUTION_EVAL_EVIDENCE_CORRUPT" ? 422 : code === "EVIDENCE_LIMIT_EXCEEDED" || code === "EVOLUTION_EVAL_RESOURCE_LIMIT" || code === "EVOLUTION_EVAL_EVIDENCE_LIMIT_EXCEEDED" ? 413 : code === "UNSUPPORTED_VIVADO" ? 501 : code === "IDEMPOTENCY_CONFLICT" || code.includes("BINDING_CONFLICT") || code === "EVOLUTION_EVAL_REMOTE_ATTESTATION_MISMATCH" ? 409 : code === "EVOLUTION_EVAL_SPOOL_FULL" || code === "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE" ? 503 : code === "PROJECT_NOT_ALLOWED" || code === "CLASSIFICATION_NOT_ALLOWED" ? 403 : 400;
      return responseError(code, code, status);
    }
  }
  validateEnvelope(v) {
    if (!v || typeof v !== "object")
      return responseError("INVALID_ENVELOPE", "object required", 400);
    const e = v;
    if (e.schema_version !== REMOTE_SCHEMA_VERSION)
      return responseError("UNSUPPORTED_PROTOCOL", "connector.remote.v1 required", 400);
    if (!good(e.correlation_id) || !good(e.idempotency_key) || !good(e.project_id) || !good(e.capability_version))
      return responseError("INVALID_ENVELOPE", "required envelope fields are missing", 400);
    if (!e.actor || e.actor.actor_type !== "user" && e.actor.actor_type !== "service" || !good(e.actor.actor_id))
      return responseError("INVALID_ENVELOPE", "actor is invalid", 400);
    if (!classes.includes(e.classification))
      return responseError("INVALID_ENVELOPE", "classification is invalid", 400);
    if (!this.endpoint.project_scope.includes(e.project_id))
      return responseError("PROJECT_NOT_ALLOWED", "PROJECT_NOT_ALLOWED", 403);
    if (!this.endpoint.data_classification_scope.includes(e.classification))
      return responseError("CLASSIFICATION_NOT_ALLOWED", "CLASSIFICATION_NOT_ALLOWED", 403);
    return;
  }
  async route(path, e, expectedAttestation) {
    const p = e.payload && typeof e.payload === "object" && !Array.isArray(e.payload) ? e.payload : {};
    if (path.startsWith("/evolution-eval/"))
      return this.routeEvolutionEval(path, e, expectedAttestation);
    if (path === "/registration") {
      if (this.endpoint.registration_state === "revoked")
        throw new Error("ENDPOINT_REVOKED");
      this.registration = { ...copy(this.endpoint), registration_state: "approved" };
      return { status: 200, body: this.envelope(e, this.registration) };
    }
    if (path === "/discover") {
      this.discovery = await this.execution.discover();
      return { status: 200, body: this.envelope(e, this.discovery) };
    }
    if (path === "/heartbeat") {
      if (!this.registration)
        throw new Error("NOT_REGISTERED");
      if (this.endpoint.registration_state === "revoked")
        throw new Error("ENDPOINT_REVOKED");
      this.discovery = await this.execution.discover();
      const now = this.clock();
      const drift = this.hasDrift(this.discovery);
      const ready = this.discoveryReady() && !drift;
      this.leaseExpiresAt = now.getTime() + this.endpoint.lease_seconds * 1000;
      this.registration = { ...this.registration, registration_state: ready ? "ready" : "degraded", discovered: copy(this.discovery), last_heartbeat_at: now.toISOString(), lease_expires_at: new Date(this.leaseExpiresAt).toISOString(), capability_drift: drift };
      return { status: 200, body: this.envelope(e, this.registration) };
    }
    if (path === "/jobs/submit") {
      if (p.request?.runClass === "evolution_eval")
        throw new Error("EVOLUTION_EVAL_DEDICATED_ROUTE_REQUIRED");
      if (this.leaseExpiresAt !== undefined && this.clock().getTime() >= this.leaseExpiresAt) {
        this.registration = this.registration ? { ...this.registration, registration_state: "offline" } : this.registration;
        throw new Error("LEASE_EXPIRED");
      }
      return this.submit(e, p.request, p.approval);
    }
    const jobId = p.job_id;
    if (!good(jobId))
      throw new Error("INVALID_JOB_ID");
    const job = this.jobs.get(jobId);
    const binding = this.jobBindings.get(jobId);
    if (!job || !binding || binding.projectId !== e.project_id || binding.classification !== e.classification)
      throw new Error("JOB_NOT_FOUND");
    if (path === "/jobs/status")
      return { status: 200, body: this.envelope(e, copy(job)) };
    if (path === "/jobs/cancel") {
      if (!terminal.has(job.state))
        job.state = "cancelled";
      return { status: 200, body: this.envelope(e, copy(job)) };
    }
    if (path === "/jobs/evidence") {
      if (!job.evidence)
        throw new Error("EVIDENCE_NOT_AVAILABLE");
      this.assertEvidenceLimits(job.evidence);
      return { status: 200, body: this.envelope(e, copy(job.evidence)) };
    }
    if (path === "/jobs/evidence/content") {
      const name = p.name;
      if (typeof name !== "string" || !evidenceNameRe.test(name))
        throw new Error("EVIDENCE_NOT_AVAILABLE");
      return this.evidenceContent(e, job, name, p.complete === true);
    }
    throw new Error("NOT_FOUND");
  }
  async routeEvolutionEval(path, e, expectedAttestation) {
    if (!this.evolutionEval)
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    if (e.actor.actor_type !== "service" || e.actor.actor_id !== "synthia-core-evolution-eval-dispatcher") {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    }
    const request = validateEvolutionEvalRemoteRequest(e.payload, e.project_id);
    const routeBySchema = {
      "evolution-eval-preflight-request.v1": "/evolution-eval/preflight",
      "evolution-eval-query-request.v1": "/evolution-eval/query",
      "evolution-eval-reserve-request.v1": "/evolution-eval/reserve",
      "evolution-eval-submit-request.v1": "/evolution-eval/submit",
      "evolution-eval-cancel-request.v1": "/evolution-eval/cancel",
      "evolution-eval-spool-query.v1": "/evolution-eval/spool/query",
      "evolution-eval-retention-query-request.v1": "/evolution-eval/retention/query",
      "evolution-eval-evidence-manifest-request.v1": "/evolution-eval/evidence/manifest",
      "evolution-eval-evidence-entry-request.v1": "/evolution-eval/evidence/entry",
      "evolution-eval-evidence-ack-request.v1": "/evolution-eval/evidence/ack",
      "evolution-eval-evidence-corrupt-ack-request.v1": "/evolution-eval/evidence/corrupt-ack",
      "evolution-eval-evidence-cleanup-request.v1": "/evolution-eval/evidence/cleanup"
    };
    if (routeBySchema[request.schema] !== path)
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    if (request.schema === "evolution-eval-preflight-request.v1" || request.schema === "evolution-eval-reserve-request.v1" || request.schema === "evolution-eval-submit-request.v1") {
      this.discovery = await this.execution.discover();
    }
    if (request.schema === "evolution-eval-preflight-request.v1") {
      if (!validEvolutionEvalRemoteAttestation(this.discovery)) {
        throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
      }
      const capability2 = this.discovery?.capabilities.find((item) => item.operation === request.binding.dispatch.operation);
      const spool = await this.evolutionEval.querySpool(request.binding);
      const discoveryPolicy2 = evaluateEvolutionEvalDiscoveryPolicy(this.discovery?.capabilities ?? [], "vivado-batch-1");
      const eligible = this.leaseReady() && this.discovery?.license_status === "available" && this.discovery.toolchain_profile_hash === request.binding.dispatch.toolchain_profile_hash && capability2?.version === e.capability_version && capability2.runClasses.includes("evolution_eval") && discoveryPolicy2.eligible && spool.unacked_bytes < spool.hard_cap_bytes;
      return { status: 200, body: this.envelope(e, {
        schema: "evolution-eval-preflight-result.v1",
        eligible,
        operation: request.binding.dispatch.operation,
        capability_version: capability2?.version ?? null,
        license_available: this.discovery?.license_status === "available",
        active_config_sha256: this.discovery.active_config_sha256,
        worker_process_instance_id: this.discovery.worker_process_instance_id,
        vivado_toolchain_attestation_sha256: this.discovery.vivado_toolchain_attestation_sha256,
        live_mapping_health: this.discovery.live_mapping_health,
        unacked_spool_bytes: spool.unacked_bytes,
        hard_cap_bytes: spool.hard_cap_bytes,
        error_code: eligible ? null : spool.unacked_bytes >= spool.hard_cap_bytes ? "EVOLUTION_EVAL_SPOOL_FULL" : "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE"
      }) };
    }
    if (request.schema === "evolution-eval-query-request.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.query(request.binding)) };
    }
    if (request.schema === "evolution-eval-reserve-request.v1") {
      this.assertEvolutionEvalRemoteAttestation(expectedAttestation);
      return { status: 200, body: this.envelope(e, await this.evolutionEval.reserve(request.binding)) };
    }
    if (request.schema === "evolution-eval-spool-query.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.querySpool(request.binding)) };
    }
    if (request.schema === "evolution-eval-retention-query-request.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.queryRetention(request.binding)) };
    }
    if (request.schema === "evolution-eval-cancel-request.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.cancel(request.binding, request.reason)) };
    }
    if (request.schema === "evolution-eval-evidence-manifest-request.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.evidenceManifest(request.binding)) };
    }
    if (request.schema === "evolution-eval-evidence-entry-request.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.evidenceEntry(request.binding, request.name)) };
    }
    if (request.schema === "evolution-eval-evidence-ack-request.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.acknowledgeEvidence(request.binding, {
        connectorManifestHash: request.connector_manifest_hash,
        coreManifestHash: request.core_manifest_hash,
        coreAckFactHash: request.core_ack_fact_hash
      })) };
    }
    if (request.schema === "evolution-eval-evidence-corrupt-ack-request.v1") {
      return { status: 200, body: this.envelope(e, await this.evolutionEval.quarantineEvidence(request.binding, {
        errorFactHash: request.error_fact_hash,
        coreQuarantineFactHash: request.core_quarantine_fact_hash
      })) };
    }
    if (request.schema === "evolution-eval-evidence-cleanup-request.v1") {
      if (request.mode === "connector_authorized") {
        return { status: 200, body: this.envelope(e, await this.evolutionEval.cleanupEvidence(request.binding, request.connector_authorization_fact_hash, request.core_cleanup_fact_hash)) };
      }
      const discard = request.reason === "absolute_expiry" ? {
        reason: request.reason,
        coreManifestHash: request.core_manifest_hash,
        coreConclusionFactHash: request.core_conclusion_fact_hash,
        coreCleanupFactHash: request.core_cleanup_fact_hash,
        discardAuthorizationHash: request.discard_authorization_hash
      } : {
        reason: request.reason,
        coreConclusionFactHash: request.core_conclusion_fact_hash,
        coreCleanupFactHash: request.core_cleanup_fact_hash,
        discardAuthorizationHash: request.discard_authorization_hash
      };
      return { status: 200, body: this.envelope(e, await this.evolutionEval.discardEvidence(request.binding, discard)) };
    }
    this.assertEvolutionEvalRemoteAttestation(expectedAttestation);
    const capability = this.discovery.capabilities.find((item) => item.operation === request.binding.dispatch.operation);
    const discoveryPolicy = evaluateEvolutionEvalDiscoveryPolicy(this.discovery?.capabilities ?? [], "vivado-batch-1");
    if (!validEvolutionEvalRemoteAttestation(this.discovery) || !this.leaseReady() || this.discovery?.license_status !== "available" || this.discovery.toolchain_profile_hash !== request.binding.dispatch.toolchain_profile_hash || capability?.version !== e.capability_version || !capability.runClasses.includes("evolution_eval") || !discoveryPolicy.eligible) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    }
    const before = await this.evolutionEval.query(request.binding);
    const result = await this.evolutionEval.submit(request.binding, request.input);
    const replay = before.state === "accepted" || before.state === "terminal";
    return { status: replay ? 200 : 202, body: this.envelope(e, result) };
  }
  assertEvolutionEvalRemoteAttestation(expectedAttestation) {
    if (!validEvolutionEvalRemoteAttestation(this.discovery) || !expectedAttestation || expectedAttestation.active_config_sha256 !== this.discovery.active_config_sha256 || expectedAttestation.worker_process_instance_id !== this.discovery.worker_process_instance_id || expectedAttestation.vivado_toolchain_attestation_sha256 !== this.discovery.vivado_toolchain_attestation_sha256) {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_REMOTE_ATTESTATION_MISMATCH");
    }
  }
  async evolutionEvalEntryResponse(e) {
    if (!this.evolutionEval)
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    if (e.actor.actor_type !== "service" || e.actor.actor_id !== "synthia-core-evolution-eval-dispatcher") {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    }
    const request = validateEvolutionEvalRemoteRequest(e.payload, e.project_id);
    if (request.schema !== "evolution-eval-evidence-entry-request.v1") {
      throw new EvolutionEvalProtocolError("EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    }
    const descriptor = await this.evolutionEval.evidenceEntryDescriptor(request.binding, request.name);
    return new Response(Bun.file(descriptor.path), {
      status: 200,
      headers: {
        "content-type": descriptor.entry.media_type,
        "content-length": String(descriptor.entry.size_bytes),
        "x-synthia-schema": "evolution-eval-connector-evidence-entry-stream.v1",
        "x-synthia-correlation-id": e.correlation_id,
        "x-synthia-idempotency-key": e.idempotency_key,
        "x-synthia-project-id": e.project_id,
        "x-synthia-classification": e.classification,
        "x-synthia-capability-version": e.capability_version,
        "x-synthia-eval-job-id": descriptor.binding.dispatch.eval_job_id,
        "x-synthia-connector-job-id": descriptor.binding.dispatch.connector_job_id,
        "x-synthia-dispatch-request-hash": descriptor.binding.dispatch_request_hash,
        "x-synthia-evidence-name": descriptor.entry.name,
        "x-synthia-evidence-sha256": descriptor.entry.sha256
      }
    });
  }
  submit(e, request, approval) {
    const capability = this.discovery?.capabilities.find((c) => c.operation === request?.operation);
    if (!this.registration || this.registration.registration_state !== "ready" || this.registration.capability_drift === true)
      throw new Error("ENDPOINT_NOT_APPROVED");
    if (!request || request.projectId !== e.project_id || !good(request.idempotencyKey) || !good(request.operation) || !good(request.input) || !good(request.correlationId))
      throw new Error("INVALID_JOB_REQUEST");
    if (!this.endpoint.allowed_capability_ids.includes(request.operation) || !capability || capability.version !== e.capability_version || !capability.runClasses.includes(request.runClass))
      throw new Error("CAPABILITY_UNAVAILABLE");
    if (request.runClass === "gate_check" && !good(approval?.gateSubmissionId))
      throw new Error("GATE_SUBMISSION_REQUIRED");
    if (request.runClass === "formal" && (approval?.inputApproved !== true || !good(approval?.baselineId) && !good(approval?.approvedGateResultId)))
      throw new Error("FORMAL_GATE_REQUIRED");
    if (request.runClass === "formal" && request.input.startsWith("candidate:"))
      throw new Error("CANDIDATE_FORMAL_REJECTED");
    const jobId = request.jobId ?? `job-${crypto.randomUUID()}`;
    if (!idRe2.test(jobId))
      throw new Error("INVALID_JOB_ID");
    const fingerprint = sha256(JSON.stringify(request));
    const old = this.jobs.get(jobId);
    if (old) {
      const binding = this.jobBindings.get(jobId);
      if (!binding || binding.projectId !== e.project_id || binding.classification !== e.classification)
        throw new Error("JOB_NOT_FOUND");
      if (sha256(JSON.stringify(old.request)) !== fingerprint)
        throw new Error("IDEMPOTENCY_CONFLICT");
      return { status: 200, body: this.envelope(e, copy(old)) };
    }
    const job = { id: jobId, request: { ...request, jobId }, state: "submitted", inputSha256: sha256(request.input) };
    this.jobs.set(jobId, job);
    this.jobBindings.set(jobId, { projectId: e.project_id, classification: e.classification });
    this.pending.push(jobId);
    this.pump();
    return { status: 202, body: this.envelope(e, copy(job)) };
  }
  async pump() {
    while (this.active < this.endpoint.max_concurrency && this.pending.length) {
      const jobId = this.pending.shift();
      const job = this.jobs.get(jobId);
      if (!job || terminal.has(job.state))
        continue;
      this.active++;
      this.run(job).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
  async run(job) {
    const workspace = join2(this.root, job.id);
    try {
      await mkdir2(workspace, { recursive: true });
      await writeFile2(join2(workspace, "request-input.txt"), job.request.input, "utf8");
      job.state = "preparing";
      job.state = "running";
      const result = await this.execution.execute(copy(job.request), workspace);
      if (this.jobs.get(job.id)?.state === "cancelled")
        return;
      job.state = result.outcome === "success" ? "succeeded" : result.outcome === "timeout" ? "timeout" : result.outcome === "lost" ? "lost" : result.outcome === "unknown_effect" ? "unknown_effect" : "failed";
      if (result.error_code)
        job.errorCode = result.error_code;
      if (result.output !== undefined) {
        job.outputSha256 = sha256(result.output);
        const outputPath = join2(workspace, "output", "worker-result.json");
        await mkdir2(join2(workspace, "output"), { recursive: true });
        await writeFile2(outputPath, result.output, "utf8");
        const outputEntry = { name: "worker-result.json", uri: `workspace://${job.id}/output/worker-result.json`, sha256: job.outputSha256, sizeBytes: new TextEncoder().encode(result.output).byteLength, mediaType: "application/json" };
        job.evidence = { jobId: job.id, entries: [...result.evidence?.entries ?? [], outputEntry] };
      } else if (result.evidence)
        job.evidence = result.evidence;
    } catch {
      if (this.jobs.get(job.id)?.state === "cancelled")
        return;
      job.state = "failed";
      if (!job.errorCode)
        job.errorCode = "WORKER_EXECUTION_ERROR";
    }
  }
  async evidenceContent(e, job, name, complete = false) {
    if (!job.evidence)
      throw new Error("EVIDENCE_NOT_AVAILABLE");
    this.assertEvidenceLimits(job.evidence);
    const entry = job.evidence.entries.find((x) => x.name === name);
    if (!entry)
      throw new Error("EVIDENCE_NOT_AVAILABLE");
    const filePath = join2(this.root, job.id, "output", name);
    let buf;
    try {
      const details = await stat2(filePath);
      if (details.size > MAX_EVIDENCE_ENTRY_BYTES)
        throw new Error("EVIDENCE_LIMIT_EXCEEDED");
      if (!details.isFile() || details.size !== entry.sizeBytes)
        throw new Error("EVIDENCE_CORRUPT");
      buf = await readFile2(filePath);
    } catch (error) {
      if (error instanceof Error && error.message === "EVIDENCE_LIMIT_EXCEEDED")
        throw error;
      throw new Error("EVIDENCE_CORRUPT");
    }
    if (sha256(buf) !== entry.sha256)
      throw new Error("EVIDENCE_CORRUPT");
    let contentBytes = buf;
    let truncated = false;
    if (!complete && buf.byteLength > MAX_CONTENT_BYTES) {
      truncated = true;
      const omitted = buf.byteLength - CONTENT_WINDOW_BYTES * 2;
      contentBytes = Buffer.concat([buf.subarray(0, CONTENT_WINDOW_BYTES), Buffer.from(`
…[${omitted} bytes omitted]…
`, "utf8"), buf.subarray(buf.byteLength - CONTENT_WINDOW_BYTES)]);
    }
    return { status: 200, body: this.envelope(e, { name: entry.name, sha256: entry.sha256, sizeBytes: buf.byteLength, mediaType: entry.mediaType, content_base64: Buffer.from(contentBytes).toString("base64"), truncated }) };
  }
  assertEvidenceLimits(manifest) {
    if (manifest.entries.length > MAX_EVIDENCE_ENTRIES)
      throw new Error("EVIDENCE_LIMIT_EXCEEDED");
    let total = 0;
    for (const entry of manifest.entries) {
      if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > MAX_EVIDENCE_ENTRY_BYTES)
        throw new Error("EVIDENCE_LIMIT_EXCEEDED");
      total += entry.sizeBytes;
      if (!Number.isSafeInteger(total) || total > MAX_EVIDENCE_TOTAL_BYTES)
        throw new Error("EVIDENCE_LIMIT_EXCEEDED");
    }
  }
  envelope(e, payload) {
    return { schema_version: REMOTE_SCHEMA_VERSION, correlation_id: e.correlation_id, causation_id: e.correlation_id, idempotency_key: e.idempotency_key, actor: e.actor, project_id: e.project_id, classification: e.classification, capability_version: e.capability_version, payload };
  }
  jobIdFrom(v) {
    return v && typeof v === "object" && "id" in v && typeof v.id === "string" ? v.id : "worker";
  }
  ok(body, status) {
    return Response.json(body, { status });
  }
}

// connector/evolution-eval-ledger.ts
import { createHash as createHash5, randomBytes as randomBytes2 } from "node:crypto";
import { spawnSync as spawnSync3 } from "node:child_process";
import { lstatSync as lstatSync2 } from "node:fs";
import {
  link as link2,
  lstat as lstat2,
  mkdir as mkdir3,
  open as open2,
  readFile as readFile3,
  readdir as readdir3,
  unlink as unlink3
} from "node:fs/promises";
import { dirname as dirname3, join as join3, resolve as resolve3 } from "node:path";
var METADATA_SCHEMA = "evolution-eval-ledger-metadata.v2";
var INDEX_SCHEMA = "evolution-eval-ledger-binding-index.v1";
var RESERVATION_SCHEMA = "evolution-eval-ledger-reservation.v2";
var ACCEPTANCE_HEAD_SCHEMA = "evolution-eval-ledger-acceptance-head.v1";
var ACCEPTANCE_SCHEMA = "evolution-eval-ledger-acceptance.v2";
var PROCESS_SCHEMA = "evolution-eval-ledger-process.v1";
var STOP_INTENT_SCHEMA = "evolution-eval-ledger-stop-intent.v1";
var OUTPUT_SCHEMA = "evolution-eval-ledger-output.v1";
var ACK_SCHEMA = "evolution-eval-ledger-evidence-ack.v1";
var QUARANTINE_SCHEMA = "evolution-eval-ledger-evidence-quarantine.v1";
var EXPIRED_SCHEMA = "evolution-eval-ledger-evidence-expired.v1";
var DISCARD_SCHEMA = "evolution-eval-ledger-evidence-discard.v1";
var CLEANUP_SCHEMA = "evolution-eval-ledger-evidence-cleanup.v1";
var PROCESS_EXIT_SCHEMA = "evolution-eval-ledger-process-exit.v1";
var PROCESS_EXIT_HEAD_SCHEMA = "evolution-eval-ledger-process-exit-head.v1";
var TERMINAL_HEAD_SCHEMA = "evolution-eval-ledger-terminal-head.v1";
var TERMINAL_SCHEMA = "evolution-eval-ledger-terminal.v2";
var MAX_FACT_BYTES = 1024 * 1024;
var EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var ERROR_CODE_PATTERN2 = /^[A-Z][A-Z0-9_]{0,127}$/;
var TOKEN_PATTERN = /^[0-9a-f]{64}$/;
var WINDOWS_MOVE_WRITE_THROUGH2 = String.raw`
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SynthiaDurableMove {
  const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
  const uint OPEN_EXISTING = 3, FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION {
    public uint Attributes; public FILETIME CreationTime, LastAccessTime, LastWriteTime;
    public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
  }
  [DllImport("kernel32.dll", EntryPoint="MoveFileExW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool MoveFileExW(string source, string target, uint flags);
  [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(IntPtr handle, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  static bool Identity(string path, out uint volume, out uint high, out uint low) {
    volume = high = low = 0;
    IntPtr handle = CreateFileW(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
    if (handle == new IntPtr(-1)) return false;
    try {
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(handle, out info)) return false;
      volume = info.VolumeSerialNumber; high = info.FileIndexHigh; low = info.FileIndexLow;
      return high != 0 || low != 0;
    } finally { CloseHandle(handle); }
  }
  static bool Same(uint av, uint ah, uint al, uint bv, uint bh, uint bl) {
    return av == bv && ah == bh && al == bl;
  }
  public static int MoveNoReplace(string source, string target, string mutexName) {
    using (var mutex = new System.Threading.Mutex(false, mutexName)) {
      bool held = false;
      try {
        try { held = mutex.WaitOne(System.TimeSpan.FromMinutes(2)); }
        catch (System.Threading.AbandonedMutexException) { held = true; }
        if (!held) return 258;
        uint sv, sh, sl; if (!Identity(source, out sv, out sh, out sl)) return 6;
        if (MoveFileExW(source, target, 8)) {
          uint tv, th, tl;
          return Identity(target, out tv, out th, out tl) && Same(sv, sh, sl, tv, th, tl) ? 0 : 13;
        }
        int moveError = Marshal.GetLastWin32Error();
        if (moveError == 80 || moveError == 183) {
          uint rv, rh, rl, tv, th, tl;
          if (!Identity(source, out rv, out rh, out rl) || !Same(sv, sh, sl, rv, rh, rl)
            || !Identity(target, out tv, out th, out tl)) return 13;
        }
        return moveError;
      } finally {
        if (held) mutex.ReleaseMutex();
      }
    }
  }
}
'@
$code = [SynthiaDurableMove]::MoveNoReplace(
  $env:SYNTHIA_EVOLUTION_MOVE_SOURCE,
  $env:SYNTHIA_EVOLUTION_MOVE_TARGET,
  $env:SYNTHIA_EVOLUTION_MOVE_MUTEX)
if ($code -eq 0) { exit 0 }
if ($code -eq 80 -or $code -eq 183) { exit 17 }
[Console]::Error.Write($code)
exit 18
`;
function windowsMoveWriteThrough2(source, target) {
  const sourceWasDirectory = lstatSync2(source).isDirectory();
  const result = spawnSync3("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(WINDOWS_MOVE_WRITE_THROUGH2, "utf16le").toString("base64")
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      SYNTHIA_EVOLUTION_MOVE_SOURCE: source,
      SYNTHIA_EVOLUTION_MOVE_TARGET: target,
      SYNTHIA_EVOLUTION_MOVE_MUTEX: `Local\\SynthiaEvolutionMove-${createHash5("sha256").update(target).digest("hex")}`
    }
  });
  if (!result.error && result.stderr.trim() === "" && result.status === 0) {
    let sourceAbsent = false;
    try {
      lstatSync2(source);
    } catch (error) {
      sourceAbsent = isErrno(error, "ENOENT");
    }
    try {
      if (sourceAbsent && lstatSync2(target).isDirectory() === sourceWasDirectory)
        return "created";
    } catch {}
  }
  if (!result.error && result.stderr.trim() === "" && result.status === 17) {
    try {
      if (lstatSync2(source).isDirectory() === sourceWasDirectory) {
        lstatSync2(target);
        return "exists";
      }
    } catch {}
  }
  throw new LedgerUnavailableError(`MoveFileExW failed: ${result.stderr.trim() || result.error?.message || result.status}`);
}
var ERROR = Object.freeze({
  corrupt: "EVOLUTION_EVAL_LEDGER_CORRUPT",
  epochMismatch: "EVOLUTION_EVAL_LEDGER_EPOCH_MISMATCH",
  unavailable: "EVOLUTION_EVAL_LEDGER_UNAVAILABLE",
  bindingConflict: "EVOLUTION_EVAL_BINDING_CONFLICT",
  reservationConflict: "EVOLUTION_EVAL_LEDGER_RESERVATION_CONFLICT",
  acceptanceWithoutReservation: "EVOLUTION_EVAL_LEDGER_ACCEPTANCE_WITHOUT_RESERVATION",
  terminalWithoutAcceptance: "EVOLUTION_EVAL_LEDGER_TERMINAL_WITHOUT_ACCEPTANCE",
  terminalConflict: "EVOLUTION_EVAL_LEDGER_TERMINAL_CONFLICT",
  ownerMismatch: "EVOLUTION_EVAL_EFFECT_OWNER_MISMATCH",
  noProof: "EVOLUTION_EVAL_LEDGER_NO_PROOF"
});

class LedgerCorruptError extends Error {
}

class LedgerEpochMismatchError extends Error {
}

class LedgerUnavailableError extends Error {
}

class LedgerBindingConflictError extends Error {
}

class LedgerReservationConflictError extends Error {
}
function isErrno(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
function plain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exact(value, keys) {
  const own = Reflect.ownKeys(value);
  if (own.some((key) => typeof key !== "string"))
    return false;
  const actual = own.sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function validTimestamp(value) {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}
function validHash(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function copy2(value) {
  return structuredClone(value);
}
function rawSha256(value) {
  return createHash5("sha256").update(value, "utf8").digest("hex");
}
function hashedFact(payload) {
  return { ...payload, fact_hash: canonicalEvolutionEvalHash(payload) };
}
function verifiedFact(value, keysWithoutHash) {
  if (!plain(value) || !exact(value, [...keysWithoutHash, "fact_hash"]) || !validHash(value.fact_hash)) {
    throw new LedgerCorruptError;
  }
  const payload = {};
  for (const key of keysWithoutHash)
    payload[key] = value[key];
  if (canonicalEvolutionEvalHash(payload) !== value.fact_hash)
    throw new LedgerCorruptError;
  return value;
}
function common(binding, epoch) {
  return {
    schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA,
    connector_job_id: binding.dispatch.connector_job_id,
    connector_idempotency_key: binding.dispatch.connector_idempotency_key,
    dispatch_request_hash: binding.dispatch_request_hash,
    ledger_epoch: epoch
  };
}
function corrupt(binding, epoch, errorCode = ERROR.corrupt) {
  return {
    ...common(binding, epoch),
    state: "ledger_corrupt",
    replay_permitted: false,
    error_code: errorCode
  };
}
function unavailable(binding, epoch) {
  return {
    ...common(binding, epoch),
    state: "transient_unavailable",
    retryable: true,
    error_code: ERROR.unavailable
  };
}
function noProof(binding, epoch) {
  return {
    ...common(binding, epoch),
    state: "ambiguous",
    effect_possible: true,
    error_code: ERROR.noProof
  };
}
function acceptanceResult(observation) {
  return { observation, accepted_now: false };
}
function evolutionEvalLedgerRecordKey(identifier) {
  return rawSha256(identifier);
}

class FileEvolutionEvalLedger {
  root;
  facts;
  heads;
  indexes;
  clock;
  faultInjector;
  locks = new Map;
  initializationError;
  constructor(options) {
    this.root = resolve3(options.root);
    this.facts = join3(this.root, "facts");
    this.heads = join3(this.root, "heads");
    this.indexes = join3(this.root, "indexes");
    this.ledgerEpoch = options.ledgerEpoch;
    this.clock = options.now ?? (() => new Date);
    this.faultInjector = options.faultInjector;
  }
  ledgerEpoch;
  static async initialize(options) {
    const ledger = new FileEvolutionEvalLedger(options);
    if (!EPOCH_PATTERN.test(options.ledgerEpoch))
      throw new TypeError("ledgerEpoch is invalid");
    try {
      await mkdir3(ledger.root, { recursive: true, mode: 448 });
      await ledger.syncDirectory(dirname3(ledger.root));
      await ledger.assertDirectory(ledger.root);
      if ((await readdir3(ledger.root)).length !== 0)
        throw new LedgerCorruptError;
      const metadata = ledger.makeMetadata();
      const created = await ledger.atomicCreate(join3(ledger.root, "ledger.json"), metadata, "metadata", dirname3(ledger.root));
      if (!created)
        throw new LedgerCorruptError;
      await mkdir3(ledger.facts, { mode: 448 });
      await mkdir3(ledger.heads, { mode: 448 });
      await mkdir3(ledger.indexes, { mode: 448 });
      await ledger.syncDirectory(ledger.root);
    } catch (error) {
      ledger.initializationError = ledger.initializationCode(error);
    }
    return ledger;
  }
  static async reopen(options) {
    const ledger = new FileEvolutionEvalLedger(options);
    if (!EPOCH_PATTERN.test(options.ledgerEpoch))
      throw new TypeError("ledgerEpoch is invalid");
    try {
      await ledger.validateLayout();
    } catch (error) {
      ledger.initializationError = ledger.initializationCode(error);
    }
    return ledger;
  }
  async query(input) {
    const binding = validateCoreIssuedEvalBinding(input);
    return this.exclusive(binding.dispatch.connector_job_id, () => this.queryUnlocked(binding));
  }
  async queryOrReserve(input, options = {}) {
    const binding = validateCoreIssuedEvalBinding(input);
    const replayPermitted = options.replayPermitted ?? true;
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.queryUnlocked(binding);
      if (before.state === "proven_never_accepted") {
        return before.replay_permitted === replayPermitted ? before : corrupt(binding, this.ledgerEpoch, ERROR.reservationConflict);
      }
      if (before.state === "accepted" || before.state === "terminal" || before.state === "transient_unavailable") {
        return before;
      }
      if (before.state === "ledger_corrupt")
        return before;
      if (before.state === "ambiguous" && before.error_code !== ERROR.noProof)
        return before;
      try {
        await this.ensureReservation(binding, replayPermitted);
        return await this.queryUnlocked(binding);
      } catch (error) {
        return this.errorObservation(binding, error);
      }
    });
  }
  async markAccepted(input, acceptance) {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!["queued", "preparing", "running"].includes(acceptance.executionState)) {
      throw new TypeError("executionState is invalid");
    }
    if (acceptance.acceptedAt !== undefined && !validTimestamp(acceptance.acceptedAt)) {
      throw new TypeError("acceptedAt is invalid");
    }
    if (acceptance.processIdentity !== undefined && (!Number.isSafeInteger(acceptance.processIdentity.pid) || acceptance.processIdentity.pid < 1 || !Number.isSafeInteger(acceptance.processIdentity.processGroupId) || acceptance.processIdentity.processGroupId < 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(acceptance.processIdentity.startToken))) {
      throw new TypeError("processIdentity is invalid");
    }
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.queryUnlocked(binding);
      if (before.state === "accepted" || before.state === "terminal" || before.state === "transient_unavailable") {
        return acceptanceResult(before);
      }
      if (before.state === "proven_never_accepted" && !before.replay_permitted) {
        return acceptanceResult(corrupt(binding, this.ledgerEpoch, ERROR.acceptanceWithoutReservation));
      }
      if (before.state === "ambiguous") {
        return acceptanceResult(corrupt(binding, this.ledgerEpoch, ERROR.acceptanceWithoutReservation));
      }
      if (before.state === "ledger_corrupt" && before.error_code !== ERROR.corrupt) {
        return acceptanceResult(before);
      }
      try {
        const ownership = await this.ensureAcceptance(binding, acceptance);
        const observation = await this.queryUnlocked(binding);
        if (ownership.createdHead && ownership.ownerToken !== undefined && observation.state === "accepted" && rawSha256(ownership.ownerToken) === ownership.head.effect_owner_token_hash) {
          return { observation, accepted_now: true, effect_owner_token: ownership.ownerToken };
        }
        return acceptanceResult(observation);
      } catch (error) {
        return acceptanceResult(this.errorObservation(binding, error));
      }
    });
  }
  async markProcessStarted(input, identity, effectOwnerToken) {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!Number.isSafeInteger(identity.pid) || identity.pid < 1 || !Number.isSafeInteger(identity.processGroupId) || identity.processGroupId < 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(identity.startToken) || !TOKEN_PATTERN.test(effectOwnerToken)) {
      throw new TypeError("process ownership is invalid");
    }
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        if (rawSha256(effectOwnerToken) !== acceptance.effect_owner_token_hash)
          throw new LedgerBindingConflictError(ERROR.ownerMismatch);
        if (acceptance.process_pid !== undefined && (acceptance.process_pid !== identity.pid || acceptance.process_group_id !== identity.processGroupId || acceptance.process_start_token !== identity.startToken))
          throw new LedgerBindingConflictError;
        const planned = this.makeProcess(binding, acceptance, identity);
        await this.atomicCreate(this.factPath(binding, "process"), planned, "process");
        const stored = this.process(await this.readRequired(this.factPath(binding, "process")), binding, acceptance);
        if (stored.pid !== identity.pid || stored.process_group_id !== identity.processGroupId || stored.process_start_token !== identity.startToken)
          throw new LedgerBindingConflictError;
        const stopRaw = await this.readOptional(this.factPath(binding, "stop-intent"));
        if (stopRaw !== undefined) {
          this.stopIntent(stopRaw, binding, acceptance);
          return false;
        }
        return true;
      } catch {
        return false;
      }
    });
  }
  async getProcessIdentity(input) {
    const binding = validateCoreIssuedEvalBinding(input);
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const observation = await this.queryUnlocked(binding);
      if (observation.state !== "accepted")
        return null;
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        const processRaw = await this.readOptional(this.factPath(binding, "process"));
        if (processRaw === undefined && acceptance.process_pid !== undefined) {
          return {
            pid: acceptance.process_pid,
            processGroupId: acceptance.process_group_id,
            startToken: acceptance.process_start_token
          };
        }
        const process2 = this.process(processRaw, binding, acceptance);
        return { pid: process2.pid, processGroupId: process2.process_group_id, startToken: process2.process_start_token };
      } catch {
        return null;
      }
    });
  }
  async markStopRequested(input, reason, effectOwnerToken) {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!(reason === "cancelled" || reason === "timeout") || effectOwnerToken !== undefined && !TOKEN_PATTERN.test(effectOwnerToken)) {
      throw new TypeError("stop intent is invalid");
    }
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        if (effectOwnerToken !== undefined && rawSha256(effectOwnerToken) !== acceptance.effect_owner_token_hash)
          throw new LedgerBindingConflictError(ERROR.ownerMismatch);
        const planned = this.makeStopIntent(binding, acceptance, reason);
        const created = await this.atomicCreate(this.factPath(binding, "stop-intent"), planned, "stop_intent");
        const stored = this.stopIntent(await this.readRequired(this.factPath(binding, "stop-intent")), binding, acceptance);
        return created || stored.reason === reason;
      } catch {
        return false;
      }
    });
  }
  async getStopObservation(input) {
    const binding = validateCoreIssuedEvalBinding(input);
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        const raw = await this.readOptional(this.factPath(binding, "stop-intent"));
        return raw === undefined ? { state: "absent" } : { state: "stop_requested", reason: this.stopIntent(raw, binding, acceptance).reason };
      } catch (error) {
        return error instanceof LedgerUnavailableError || error instanceof Error && "code" in error ? { state: "unavailable" } : { state: "corrupt" };
      }
    });
  }
  async markTerminalAfterConfirmedStop(input, terminalState, errorCode) {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!(terminalState === "cancelled" || terminalState === "timeout") || !ERROR_CODE_PATTERN2.test(errorCode)) {
      throw new TypeError("confirmed stop terminal is invalid");
    }
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.queryUnlocked(binding);
      if (before.state === "terminal")
        return before;
      if (before.state !== "accepted")
        return before;
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        const stop = this.stopIntent(await this.readRequired(this.factPath(binding, "stop-intent")), binding, acceptance);
        if (stop.reason !== terminalState)
          throw new LedgerBindingConflictError;
        await this.ensureTerminal(binding, { terminalState, errorCode }, undefined, true);
        return this.queryUnlocked(binding);
      } catch (error) {
        return this.errorObservation(binding, error);
      }
    });
  }
  async markOutput(input, output, effectOwnerToken) {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!validHash(output.spoolManifestHash) || !Number.isSafeInteger(output.entryCount) || output.entryCount < 0 || output.entryCount > 128 || !Number.isSafeInteger(output.totalBytes) || output.totalBytes < 0 || output.totalBytes > 256 * 1024 * 1024 || !TOKEN_PATTERN.test(effectOwnerToken)) {
      throw new TypeError("output fact is invalid");
    }
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        if (rawSha256(effectOwnerToken) !== acceptance.effect_owner_token_hash)
          throw new LedgerBindingConflictError(ERROR.ownerMismatch);
        const process2 = this.process(await this.readRequired(this.factPath(binding, "process")), binding, acceptance);
        if (await this.readOptional(this.factPath(binding, "evidence-discard")) !== undefined)
          return false;
        const planned = this.makeOutput(binding, process2, output);
        const created = await this.atomicCreate(this.factPath(binding, "output"), planned, "output");
        const stored = this.output(await this.readRequired(this.factPath(binding, "output")), binding, process2);
        return created || stored.spool_manifest_hash === output.spoolManifestHash && stored.entry_count === output.entryCount && stored.total_bytes === output.totalBytes;
      } catch {
        return false;
      }
    });
  }
  async getOutputObservation(input) {
    const binding = validateCoreIssuedEvalBinding(input);
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        const process2 = this.process(await this.readRequired(this.factPath(binding, "process")), binding, acceptance);
        const raw = await this.readOptional(this.factPath(binding, "output"));
        if (raw === undefined)
          return { state: "absent" };
        const output = this.output(raw, binding, process2);
        return { state: "pending_ack", totalBytes: output.total_bytes };
      } catch (error) {
        return error instanceof LedgerUnavailableError || error instanceof Error && "code" in error ? { state: "unavailable" } : { state: "corrupt" };
      }
    });
  }
  async getRetentionObservation(input) {
    const binding = validateCoreIssuedEvalBinding(input);
    return this.exclusive(binding.dispatch.connector_job_id, () => this.getRetentionObservationUnlocked(binding));
  }
  async markEvidenceAcknowledged(input, hashes) {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!validHash(hashes.connectorManifestHash) || !validHash(hashes.coreManifestHash) || !validHash(hashes.coreAckFactHash))
      throw new TypeError("ack hashes are invalid");
    const expectedCoreAckFactHash = canonicalEvolutionEvalHash({
      schema: "evolution-eval-evidence-ack-intent.v1",
      eval_job_id: binding.dispatch.eval_job_id,
      manifest_hash: hashes.coreManifestHash
    });
    if (hashes.coreAckFactHash !== expectedCoreAckFactHash)
      return { state: "corrupt" };
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.getRetentionObservationUnlocked(binding);
      if (before.state === "acknowledged") {
        return before.manifestHash === hashes.connectorManifestHash && before.coreManifestHash === hashes.coreManifestHash && before.authorizationHash === hashes.coreAckFactHash ? before : { state: "corrupt" };
      }
      if (before.state === "cleaned" && before.sourceKind === "ack") {
        return before.sourceConnectorManifestHash === hashes.connectorManifestHash && before.sourceCoreManifestHash === hashes.coreManifestHash && before.sourceAuthorizationHash === hashes.coreAckFactHash ? before : { state: "corrupt" };
      }
      if (before.state !== "pending_ack")
        return before.state === "absent" ? { state: "corrupt" } : before;
      if (before.manifestHash !== hashes.connectorManifestHash)
        return { state: "corrupt" };
      try {
        const { output } = await this.loadOutputChain(binding);
        await this.loadTerminalFact(binding);
        const planned = this.makeEvidenceAck(binding, output, hashes);
        await this.atomicCreate(this.factPath(binding, "evidence-ack"), planned, "evidence_ack");
        return this.getRetentionObservationUnlocked(binding);
      } catch (error) {
        return this.retentionErrorObservation(error);
      }
    });
  }
  async markEvidenceQuarantined(input, hashes) {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!validHash(hashes.errorFactHash) || !validHash(hashes.coreQuarantineFactHash))
      throw new TypeError("quarantine hashes are invalid");
    const expectedCoreQuarantineFactHash = canonicalEvolutionEvalHash({
      schema: "evolution-eval-evidence-quarantine-intent.v1",
      eval_job_id: binding.dispatch.eval_job_id,
      error_fact_hash: hashes.errorFactHash
    });
    if (hashes.coreQuarantineFactHash !== expectedCoreQuarantineFactHash)
      return { state: "corrupt" };
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.getRetentionObservationUnlocked(binding);
      if (before.state === "quarantined") {
        return before.errorFactHash === hashes.errorFactHash && before.authorizationHash === hashes.coreQuarantineFactHash ? before : { state: "corrupt" };
      }
      if (before.state === "cleaned" && before.sourceKind === "quarantine") {
        return before.sourceErrorFactHash === hashes.errorFactHash && before.sourceAuthorizationHash === hashes.coreQuarantineFactHash ? before : { state: "corrupt" };
      }
      if (before.state !== "pending_ack")
        return before.state === "absent" ? { state: "corrupt" } : before;
      try {
        const { output } = await this.loadOutputChain(binding);
        await this.loadTerminalFact(binding);
        const planned = this.makeEvidenceQuarantine(binding, output, hashes);
        await this.atomicCreate(this.factPath(binding, "evidence-quarantine"), planned, "evidence_quarantine");
        return this.getRetentionObservationUnlocked(binding);
      } catch (error) {
        return this.retentionErrorObservation(error);
      }
    });
  }
  async markEvidenceExpired(input) {
    const binding = validateCoreIssuedEvalBinding(input);
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.getRetentionObservationUnlocked(binding);
      if (before.state === "expired" || before.state === "cleaned")
        return before;
      if (before.state !== "pending_ack")
        return before.state === "absent" ? { state: "corrupt" } : before;
      try {
        const { output } = await this.loadOutputChain(binding);
        const terminal2 = await this.loadTerminalFact(binding);
        if (this.clock().getTime() < Date.parse(terminal2.terminal_at) + 7 * 24 * 60 * 60 * 1000) {
          return before;
        }
        const planned = this.makeEvidenceExpired(binding, output, terminal2);
        await this.atomicCreate(this.factPath(binding, "evidence-expired"), planned, "evidence_expired");
        return this.getRetentionObservationUnlocked(binding);
      } catch (error) {
        return this.retentionErrorObservation(error);
      }
    });
  }
  async markEvidenceDiscarded(input, discard) {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!validHash(discard.coreConclusionFactHash) || !validHash(discard.coreCleanupFactHash) || !validHash(discard.discardAuthorizationHash))
      throw new TypeError("discard hashes are invalid");
    if (discard.reason === "absolute_expiry" && !validHash(discard.coreManifestHash)) {
      throw new TypeError("discard hashes are invalid");
    }
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      try {
        const before = await this.getRetentionObservationUnlocked(binding);
        if (before.state === "acknowledged" || before.state === "quarantined" || before.state === "cleaned" && before.sourceKind !== "discard")
          return { state: "corrupt" };
        const { reservation } = await this.loadReservationChain(binding);
        let expectedAuthorization;
        if (discard.reason === "unavailable_at_deadline") {
          if (this.clock().getTime() < Date.parse(binding.dispatch.deadline_at))
            return { state: "corrupt" };
          const expectedConclusion = canonicalEvolutionEvalHash({
            schema: "evolution-eval-evidence-deadline.v1",
            eval_job_id: binding.dispatch.eval_job_id,
            deadline_at: binding.dispatch.deadline_at,
            error_code: "EVOLUTION_EVAL_EVIDENCE_UNAVAILABLE_AT_DEADLINE"
          });
          if (discard.coreConclusionFactHash !== expectedConclusion)
            return { state: "corrupt" };
          expectedAuthorization = evolutionEvalDiscardAuthorizationHash(binding, { reason: discard.reason });
        } else {
          const { output } = await this.loadOutputChain(binding);
          const terminal2 = await this.loadTerminalFact(binding);
          if (this.clock().getTime() < Date.parse(terminal2.terminal_at) + 7 * 24 * 60 * 60 * 1000) {
            return { state: "corrupt" };
          }
          expectedAuthorization = evolutionEvalDiscardAuthorizationHash(binding, {
            reason: discard.reason,
            connectorManifestHash: output.spool_manifest_hash,
            terminalAt: terminal2.terminal_at
          });
          const expectedConclusion = canonicalEvolutionEvalHash({
            schema: "evolution-eval-evidence-expired.v1",
            eval_job_id: binding.dispatch.eval_job_id,
            manifest_hash: discard.coreManifestHash,
            terminal_at: terminal2.terminal_at
          });
          if (discard.coreConclusionFactHash !== expectedConclusion)
            return { state: "corrupt" };
        }
        const expectedCleanup = canonicalEvolutionEvalHash({
          schema: "evolution-eval-evidence-cleanup.v1",
          eval_job_id: binding.dispatch.eval_job_id,
          cause_fact_hash: discard.coreConclusionFactHash
        });
        if (discard.discardAuthorizationHash !== expectedAuthorization || discard.coreCleanupFactHash !== expectedCleanup)
          return { state: "corrupt" };
        const planned = this.makeEvidenceDiscard(binding, reservation, discard);
        await this.atomicCreate(this.factPath(binding, "evidence-discard"), planned, "evidence_discard");
        const stored = this.evidenceDiscard(await this.readRequired(this.factPath(binding, "evidence-discard")), binding, reservation);
        if (stored.reason !== discard.reason || stored.core_conclusion_fact_hash !== discard.coreConclusionFactHash || stored.core_cleanup_fact_hash !== discard.coreCleanupFactHash || stored.discard_authorization_hash !== discard.discardAuthorizationHash)
          return { state: "corrupt" };
        return this.getRetentionObservationUnlocked(binding);
      } catch (error) {
        return this.retentionErrorObservation(error);
      }
    });
  }
  async markEvidenceCleaned(input, authorizationFactHash, coreCleanupFactHash) {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!validHash(authorizationFactHash) || !validHash(coreCleanupFactHash))
      throw new TypeError("cleanup hashes are invalid");
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.getRetentionObservationUnlocked(binding);
      if (before.state === "cleaned") {
        return before.authorizationFactHash === authorizationFactHash && before.authorizationHash === coreCleanupFactHash ? before : { state: "corrupt" };
      }
      if (!(before.state === "acknowledged" || before.state === "quarantined" || before.state === "discarded")) {
        return before.state === "absent" || before.state === "pending_ack" ? { state: "corrupt" } : before;
      }
      if (before.factHash !== authorizationFactHash)
        return { state: "corrupt" };
      try {
        await this.loadReservationChain(binding);
        await this.loadTerminalFact(binding);
        const causeFactHash = before.state === "acknowledged" ? canonicalEvolutionEvalHash({
          schema: "evolution-eval-evidence-acknowledged.v1",
          eval_job_id: binding.dispatch.eval_job_id,
          manifest_hash: before.coreManifestHash,
          connector_fact_hash: before.factHash
        }) : before.state === "quarantined" ? before.errorFactHash : before.coreConclusionFactHash;
        const expectedCoreCleanupFactHash = canonicalEvolutionEvalHash({
          schema: "evolution-eval-evidence-cleanup.v1",
          eval_job_id: binding.dispatch.eval_job_id,
          cause_fact_hash: causeFactHash
        });
        if (coreCleanupFactHash !== expectedCoreCleanupFactHash)
          return { state: "corrupt" };
        const planned = this.makeEvidenceCleanup(binding, authorizationFactHash, coreCleanupFactHash);
        await this.atomicCreate(this.factPath(binding, "evidence-cleanup"), planned, "evidence_cleanup");
        return this.getRetentionObservationUnlocked(binding);
      } catch (error) {
        return this.retentionErrorObservation(error);
      }
    });
  }
  async markProcessExitConfirmed(input, identity, effectOwnerToken) {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!Number.isSafeInteger(identity.pid) || identity.pid < 1 || !Number.isSafeInteger(identity.processGroupId) || identity.processGroupId < 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(identity.startToken) || effectOwnerToken !== undefined && !TOKEN_PATTERN.test(effectOwnerToken))
      throw new TypeError("process exit is invalid");
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      try {
        const { reservation } = await this.loadReservationChain(binding);
        const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
        const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
        if (effectOwnerToken !== undefined && rawSha256(effectOwnerToken) !== acceptance.effect_owner_token_hash)
          throw new LedgerBindingConflictError(ERROR.ownerMismatch);
        let processRaw = await this.readOptional(this.factPath(binding, "process"));
        if (processRaw === undefined && acceptance.process_pid !== undefined && acceptance.process_pid === identity.pid && acceptance.process_group_id === identity.processGroupId && acceptance.process_start_token === identity.startToken) {
          await this.atomicCreate(this.factPath(binding, "process"), this.makeProcess(binding, acceptance, identity), "process");
          processRaw = await this.readRequired(this.factPath(binding, "process"));
        }
        const process2 = this.process(processRaw, binding, acceptance);
        if (process2.pid !== identity.pid || process2.process_group_id !== identity.processGroupId || process2.process_start_token !== identity.startToken)
          throw new LedgerBindingConflictError;
        const planned = this.makeProcessExit(binding, process2);
        await this.atomicCreate(this.factPath(binding, "process-exit"), planned, "process_exit");
        const stored = this.processExit(await this.readRequired(this.factPath(binding, "process-exit")), binding, process2);
        const exitHead = this.makeProcessExitHead(binding, process2, stored);
        const exitHeadPath = this.headPath(binding, "process-exit");
        const existingHead = await this.readOptional(exitHeadPath);
        try {
          await this.atomicCreate(exitHeadPath, exitHead, "process_exit_head");
        } catch (error) {
          if (existingHead === undefined) {
            await unlink3(exitHeadPath).catch(() => {
              return;
            });
            await this.syncDirectory(this.heads).catch(() => {
              return;
            });
          }
          throw error;
        }
        this.processExitHead(await this.readRequired(this.headPath(binding, "process-exit")), binding, process2, stored);
        return true;
      } catch {
        return false;
      }
    });
  }
  async markTerminal(input, terminal2, effectOwnerToken) {
    const binding = validateCoreIssuedEvalBinding(input);
    if (!["succeeded", "failed", "cancelled", "timeout"].includes(terminal2.terminalState)) {
      throw new TypeError("terminalState is invalid");
    }
    if (terminal2.errorCode !== undefined && terminal2.errorCode !== null && !ERROR_CODE_PATTERN2.test(terminal2.errorCode)) {
      throw new TypeError("errorCode is invalid");
    }
    if (terminal2.terminalAt !== undefined && !validTimestamp(terminal2.terminalAt)) {
      throw new TypeError("terminalAt is invalid");
    }
    return this.exclusive(binding.dispatch.connector_job_id, async () => {
      const before = await this.queryUnlocked(binding);
      if (before.state === "terminal") {
        return before.terminal_state === terminal2.terminalState && before.error_code === (terminal2.errorCode ?? null) ? before : corrupt(binding, this.ledgerEpoch, ERROR.terminalConflict);
      }
      if (before.state === "transient_unavailable")
        return before;
      if (!TOKEN_PATTERN.test(effectOwnerToken))
        return corrupt(binding, this.ledgerEpoch, ERROR.ownerMismatch);
      if (before.state !== "accepted" && !(before.state === "ledger_corrupt" && before.error_code === ERROR.corrupt)) {
        return corrupt(binding, this.ledgerEpoch, ERROR.terminalWithoutAcceptance);
      }
      try {
        await this.ensureTerminal(binding, terminal2, effectOwnerToken);
        const after = await this.queryUnlocked(binding);
        if (after.state !== "terminal")
          return after;
        return after.terminal_state === terminal2.terminalState && after.error_code === (terminal2.errorCode ?? null) ? after : corrupt(binding, this.ledgerEpoch, ERROR.terminalConflict);
      } catch (error) {
        return this.errorObservation(binding, error);
      }
    });
  }
  async queryUnlocked(binding) {
    if (this.initializationError !== undefined) {
      return this.initializationError === ERROR.unavailable ? unavailable(binding, this.ledgerEpoch) : corrupt(binding, this.ledgerEpoch, this.initializationError);
    }
    try {
      const metadata = await this.validateLayout();
      const indexRaw = await this.readOptional(this.indexPath(binding));
      const terminalHeadRaw = await this.readOptional(this.headPath(binding, "terminal"));
      const terminalRaw = await this.readOptional(this.factPath(binding, "terminal"));
      const acceptanceHeadRaw = await this.readOptional(this.headPath(binding, "acceptance"));
      let acceptanceRaw = await this.readOptional(this.factPath(binding, "accepted"));
      const processRaw = await this.readOptional(this.factPath(binding, "process"));
      const stopIntentRaw = await this.readOptional(this.factPath(binding, "stop-intent"));
      const outputRaw = await this.readOptional(this.factPath(binding, "output"));
      const processExitRaw = await this.readOptional(this.factPath(binding, "process-exit"));
      const processExitHeadRaw = await this.readOptional(this.headPath(binding, "process-exit"));
      const reservationRaw = await this.readOptional(this.factPath(binding, "reservation"));
      if (indexRaw === undefined) {
        if ([terminalHeadRaw, terminalRaw, acceptanceHeadRaw, acceptanceRaw, processRaw, stopIntentRaw, outputRaw, processExitRaw, processExitHeadRaw, reservationRaw].some((value) => value !== undefined)) {
          throw new LedgerCorruptError;
        }
        return noProof(binding, this.ledgerEpoch);
      }
      const index = this.bindingIndex(indexRaw, binding, metadata);
      await this.durabilityFence(this.indexes, "binding_index");
      if (reservationRaw === undefined)
        throw new LedgerCorruptError;
      const reservation = this.reservation(reservationRaw, binding, metadata, index);
      await this.durabilityFence(this.facts, "reservation");
      if (acceptanceHeadRaw === undefined) {
        if ([terminalHeadRaw, terminalRaw, acceptanceRaw, processRaw, stopIntentRaw, outputRaw, processExitRaw, processExitHeadRaw].some((value) => value !== undefined))
          throw new LedgerCorruptError;
        return validateEvalLedgerQuery({
          ...common(binding, this.ledgerEpoch),
          state: "proven_never_accepted",
          replay_permitted: reservation.replay_permitted
        }, binding, this.ledgerEpoch);
      }
      const acceptanceHead = this.acceptanceHead(acceptanceHeadRaw, binding, reservation);
      if (acceptanceRaw === undefined) {
        const reconstructed = this.makeAcceptance(binding, reservation, acceptanceHead.execution_state, acceptanceHead.accepted_at, acceptanceHead.effect_owner_token_hash, acceptanceHead.process_pid === undefined ? undefined : {
          pid: acceptanceHead.process_pid,
          processGroupId: acceptanceHead.process_group_id,
          startToken: acceptanceHead.process_start_token
        });
        if (reconstructed.fact_hash !== acceptanceHead.acceptance_fact_hash)
          throw new LedgerCorruptError;
        await this.atomicCreate(this.factPath(binding, "accepted"), reconstructed, "acceptance");
        acceptanceRaw = await this.readRequired(this.factPath(binding, "accepted"));
      }
      const acceptance = this.acceptance(acceptanceRaw, binding, reservation, acceptanceHead);
      await this.durabilityFence(this.heads, "acceptance_head");
      await this.durabilityFence(this.facts, "acceptance");
      let process2;
      let processExit;
      if (stopIntentRaw !== undefined) {
        this.stopIntent(stopIntentRaw, binding, acceptance);
        await this.durabilityFence(this.facts, "stop_intent");
      }
      if (processRaw === undefined) {
        if (outputRaw !== undefined || processExitRaw !== undefined || processExitHeadRaw !== undefined)
          throw new LedgerCorruptError;
      } else {
        process2 = this.process(processRaw, binding, acceptance);
        await this.durabilityFence(this.facts, "process");
        if (outputRaw !== undefined) {
          this.output(outputRaw, binding, process2);
          await this.durabilityFence(this.facts, "output");
        }
        if (processExitHeadRaw !== undefined && processExitRaw === undefined)
          throw new LedgerCorruptError;
        if (processExitRaw !== undefined) {
          const candidate = this.processExit(processExitRaw, binding, process2);
          if (processExitHeadRaw !== undefined) {
            this.processExitHead(processExitHeadRaw, binding, process2, candidate);
            await this.durabilityFence(this.heads, "process_exit_head");
            await this.durabilityFence(this.facts, "process_exit");
            processExit = candidate;
          }
        }
      }
      if (terminalHeadRaw === undefined) {
        if (terminalRaw !== undefined)
          throw new LedgerCorruptError;
        return validateEvalLedgerQuery({
          ...common(binding, this.ledgerEpoch),
          state: "accepted",
          execution_state: acceptance.execution_state,
          accepted_at: acceptance.accepted_at
        }, binding, this.ledgerEpoch);
      }
      if (process2 === undefined || processExit === undefined)
        throw new LedgerCorruptError;
      const terminalHead = this.terminalHead(terminalHeadRaw, binding, processExit);
      if (terminalRaw === undefined)
        throw new LedgerCorruptError;
      const terminal2 = this.terminal(terminalRaw, binding, processExit, terminalHead);
      await this.durabilityFence(this.heads, "terminal_head");
      await this.durabilityFence(this.facts, "terminal");
      return validateEvalLedgerQuery({
        ...common(binding, this.ledgerEpoch),
        state: "terminal",
        terminal_state: terminal2.terminal_state,
        process_stopped: true,
        terminal_at: terminal2.terminal_at,
        error_code: terminal2.error_code
      }, binding, this.ledgerEpoch);
    } catch (error) {
      return this.errorObservation(binding, error);
    }
  }
  async ensureReservation(binding, replayPermitted) {
    const metadata = await this.validateLayout();
    let indexRaw = await this.readOptional(this.indexPath(binding));
    let index;
    if (indexRaw === undefined) {
      const reservedAt = this.isoNow();
      const reservation2 = this.makeReservation(binding, metadata, replayPermitted, reservedAt);
      const planned = this.makeBindingIndex(binding, metadata, reservation2);
      await this.atomicCreate(this.indexPath(binding), planned, "binding_index");
      indexRaw = await this.readRequired(this.indexPath(binding));
      index = this.bindingIndex(indexRaw, binding, metadata);
    } else {
      index = this.bindingIndex(indexRaw, binding, metadata);
    }
    if (index.replay_permitted !== replayPermitted)
      throw new LedgerReservationConflictError;
    const reservation = this.makeReservation(binding, metadata, index.replay_permitted, index.reserved_at);
    if (reservation.fact_hash !== index.reservation_fact_hash)
      throw new LedgerCorruptError;
    const existing = await this.readOptional(this.factPath(binding, "reservation"));
    if (existing === undefined)
      await this.atomicCreate(this.factPath(binding, "reservation"), reservation, "reservation");
    this.reservation(await this.readRequired(this.factPath(binding, "reservation")), binding, metadata, index);
  }
  async ensureAcceptance(binding, acceptance) {
    const { reservation } = await this.loadReservationChain(binding);
    let headRaw = await this.readOptional(this.headPath(binding, "acceptance"));
    const existingFact = await this.readOptional(this.factPath(binding, "accepted"));
    let createdHead = false;
    let ownerToken;
    let head;
    if (headRaw === undefined) {
      if (existingFact !== undefined)
        throw new LedgerCorruptError;
      ownerToken = randomBytes2(32).toString("hex");
      const fact2 = this.makeAcceptance(binding, reservation, acceptance.executionState, acceptance.acceptedAt ?? this.isoNow(), rawSha256(ownerToken), acceptance.processIdentity);
      const planned = this.makeAcceptanceHead(binding, reservation, fact2);
      createdHead = await this.atomicCreate(this.headPath(binding, "acceptance"), planned, "acceptance_head");
      headRaw = await this.readRequired(this.headPath(binding, "acceptance"));
      head = this.acceptanceHead(headRaw, binding, reservation);
      if (!createdHead || head.effect_owner_token_hash !== rawSha256(ownerToken))
        ownerToken = undefined;
    } else {
      head = this.acceptanceHead(headRaw, binding, reservation);
    }
    const fact = this.makeAcceptance(binding, reservation, head.execution_state, head.accepted_at, head.effect_owner_token_hash, head.process_pid === undefined ? undefined : {
      pid: head.process_pid,
      processGroupId: head.process_group_id,
      startToken: head.process_start_token
    });
    if (fact.fact_hash !== head.acceptance_fact_hash)
      throw new LedgerCorruptError;
    const current = await this.readOptional(this.factPath(binding, "accepted"));
    if (current === undefined)
      await this.atomicCreate(this.factPath(binding, "accepted"), fact, "acceptance");
    this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
    return ownerToken === undefined ? { createdHead, head } : { createdHead, ownerToken, head };
  }
  async ensureTerminal(binding, terminal2, effectOwnerToken, allowConfirmedStop = false) {
    const { reservation } = await this.loadReservationChain(binding);
    const acceptanceHeadRaw = await this.readRequired(this.headPath(binding, "acceptance"));
    const acceptanceHead = this.acceptanceHead(acceptanceHeadRaw, binding, reservation);
    const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, acceptanceHead);
    const ownerHash = effectOwnerToken === undefined ? acceptance.effect_owner_token_hash : rawSha256(effectOwnerToken);
    if (effectOwnerToken === undefined && !allowConfirmedStop)
      throw new LedgerBindingConflictError(ERROR.ownerMismatch);
    if (ownerHash !== acceptance.effect_owner_token_hash)
      throw new LedgerBindingConflictError(ERROR.ownerMismatch);
    const process2 = this.process(await this.readRequired(this.factPath(binding, "process")), binding, acceptance);
    const processExit = this.processExit(await this.readRequired(this.factPath(binding, "process-exit")), binding, process2);
    this.processExitHead(await this.readRequired(this.headPath(binding, "process-exit")), binding, process2, processExit);
    if (terminal2.terminalState === "cancelled" || terminal2.terminalState === "timeout") {
      const stop = this.stopIntent(await this.readRequired(this.factPath(binding, "stop-intent")), binding, acceptance);
      if (stop.reason !== terminal2.terminalState)
        throw new LedgerBindingConflictError;
    }
    let headRaw = await this.readOptional(this.headPath(binding, "terminal"));
    const existingFact = await this.readOptional(this.factPath(binding, "terminal"));
    let head;
    if (headRaw === undefined) {
      if (existingFact !== undefined)
        throw new LedgerCorruptError;
      const fact2 = this.makeTerminal(binding, processExit, terminal2.terminalState, terminal2.terminalAt ?? this.isoNow(), terminal2.errorCode ?? null);
      const planned = this.makeTerminalHead(binding, processExit, fact2);
      await this.atomicCreate(this.headPath(binding, "terminal"), planned, "terminal_head");
      headRaw = await this.readRequired(this.headPath(binding, "terminal"));
      head = this.terminalHead(headRaw, binding, processExit);
    } else {
      head = this.terminalHead(headRaw, binding, processExit);
    }
    if (head.effect_owner_token_hash !== ownerHash)
      throw new LedgerBindingConflictError(ERROR.ownerMismatch);
    if (head.terminal_state !== terminal2.terminalState || head.error_code !== (terminal2.errorCode ?? null)) {
      throw new LedgerReservationConflictError(ERROR.terminalConflict);
    }
    const fact = this.makeTerminal(binding, processExit, head.terminal_state, head.terminal_at, head.error_code);
    if (fact.fact_hash !== head.terminal_fact_hash)
      throw new LedgerCorruptError;
    const current = await this.readOptional(this.factPath(binding, "terminal"));
    if (current === undefined)
      await this.atomicCreate(this.factPath(binding, "terminal"), fact, "terminal");
    this.terminal(await this.readRequired(this.factPath(binding, "terminal")), binding, processExit, head);
  }
  async loadReservationChain(binding) {
    const metadata = await this.validateLayout();
    const index = this.bindingIndex(await this.readRequired(this.indexPath(binding)), binding, metadata);
    const reservation = this.reservation(await this.readRequired(this.factPath(binding, "reservation")), binding, metadata, index);
    return { metadata, index, reservation };
  }
  async loadProcessChain(binding) {
    const { reservation } = await this.loadReservationChain(binding);
    const head = this.acceptanceHead(await this.readRequired(this.headPath(binding, "acceptance")), binding, reservation);
    const acceptance = this.acceptance(await this.readRequired(this.factPath(binding, "accepted")), binding, reservation, head);
    const process2 = this.process(await this.readRequired(this.factPath(binding, "process")), binding, acceptance);
    return { acceptance, process: process2 };
  }
  async loadOutputChain(binding) {
    const { acceptance, process: process2 } = await this.loadProcessChain(binding);
    const output = this.output(await this.readRequired(this.factPath(binding, "output")), binding, process2);
    return { acceptance, process: process2, output };
  }
  async loadTerminalFact(binding) {
    const { process: process2 } = await this.loadProcessChain(binding);
    const processExit = this.processExit(await this.readRequired(this.factPath(binding, "process-exit")), binding, process2);
    const processExitHead = this.processExitHead(await this.readRequired(this.headPath(binding, "process-exit")), binding, process2, processExit);
    if (processExitHead.process_exit_fact_hash !== processExit.fact_hash)
      throw new LedgerCorruptError;
    const head = this.terminalHead(await this.readRequired(this.headPath(binding, "terminal")), binding, processExit);
    return this.terminal(await this.readRequired(this.factPath(binding, "terminal")), binding, processExit, head);
  }
  async getRetentionObservationUnlocked(binding) {
    if (this.initializationError !== undefined) {
      return this.initializationError === ERROR.unavailable ? { state: "unavailable" } : { state: "corrupt" };
    }
    try {
      const paths = {
        output: this.factPath(binding, "output"),
        ack: this.factPath(binding, "evidence-ack"),
        quarantine: this.factPath(binding, "evidence-quarantine"),
        expired: this.factPath(binding, "evidence-expired"),
        discard: this.factPath(binding, "evidence-discard"),
        cleanup: this.factPath(binding, "evidence-cleanup")
      };
      const [outputRaw, ackRaw, quarantineRaw, expiredRaw, discardRaw, cleanupRaw] = await Promise.all([
        this.readOptional(paths.output),
        this.readOptional(paths.ack),
        this.readOptional(paths.quarantine),
        this.readOptional(paths.expired),
        this.readOptional(paths.discard),
        this.readOptional(paths.cleanup)
      ]);
      if (outputRaw === undefined) {
        if ([ackRaw, quarantineRaw, expiredRaw].some((value) => value !== undefined)) {
          throw new LedgerCorruptError;
        }
        if (discardRaw === undefined) {
          if (cleanupRaw !== undefined)
            throw new LedgerCorruptError;
          return { state: "absent" };
        }
        const { reservation: reservation2 } = await this.loadReservationChain(binding);
        const discard2 = this.evidenceDiscard(discardRaw, binding, reservation2);
        if (cleanupRaw !== undefined) {
          const cleanup = this.evidenceCleanup(cleanupRaw, binding, discard2);
          return {
            state: "cleaned",
            authorizationFactHash: cleanup.authorization_fact_hash,
            authorizationHash: cleanup.core_cleanup_fact_hash,
            sourceKind: "discard",
            sourceAuthorizationHash: discard2.discard_authorization_hash,
            sourceConnectorManifestHash: null,
            sourceCoreManifestHash: null,
            sourceErrorFactHash: null,
            factHash: cleanup.fact_hash,
            cleanedAt: cleanup.cleaned_at
          };
        }
        return {
          state: "discarded",
          reason: discard2.reason,
          authorizationHash: discard2.discard_authorization_hash,
          coreConclusionFactHash: discard2.core_conclusion_fact_hash,
          cleanupAuthorizationHash: discard2.core_cleanup_fact_hash,
          factHash: discard2.fact_hash,
          discardedAt: discard2.discarded_at
        };
      }
      const { output } = await this.loadOutputChain(binding);
      const ack = ackRaw === undefined ? undefined : this.evidenceAck(ackRaw, binding, output);
      const quarantine = quarantineRaw === undefined ? undefined : this.evidenceQuarantine(quarantineRaw, binding, output);
      let expired;
      if (expiredRaw !== undefined) {
        const terminal2 = await this.loadTerminalFact(binding);
        expired = this.evidenceExpired(expiredRaw, binding, output, terminal2);
      }
      const { reservation } = await this.loadReservationChain(binding);
      const discard = discardRaw === undefined ? undefined : this.evidenceDiscard(discardRaw, binding, reservation);
      const allAuthorizations = [ack, quarantine, expired, discard].filter((value) => value !== undefined);
      const localExpirySuperseded = allAuthorizations.length === 2 && expired !== undefined && discard?.reason === "absolute_expiry";
      if (allAuthorizations.length > 1 && !localExpirySuperseded)
        throw new LedgerCorruptError;
      const authorizations = localExpirySuperseded ? [discard] : allAuthorizations;
      if (cleanupRaw !== undefined) {
        if (authorizations.length !== 1)
          throw new LedgerCorruptError;
        const cleanup = this.evidenceCleanup(cleanupRaw, binding, authorizations[0]);
        return {
          state: "cleaned",
          authorizationFactHash: cleanup.authorization_fact_hash,
          authorizationHash: cleanup.core_cleanup_fact_hash,
          sourceKind: authorizations[0].schema === ACK_SCHEMA ? "ack" : authorizations[0].schema === QUARANTINE_SCHEMA ? "quarantine" : authorizations[0].schema === DISCARD_SCHEMA ? "discard" : "expiry",
          sourceAuthorizationHash: authorizations[0].schema === ACK_SCHEMA ? authorizations[0].core_ack_fact_hash : authorizations[0].schema === QUARANTINE_SCHEMA ? authorizations[0].core_quarantine_fact_hash : authorizations[0].schema === DISCARD_SCHEMA ? authorizations[0].discard_authorization_hash : authorizations[0].fact_hash,
          sourceConnectorManifestHash: authorizations[0].schema === ACK_SCHEMA ? authorizations[0].connector_manifest_hash : null,
          sourceCoreManifestHash: authorizations[0].schema === ACK_SCHEMA ? authorizations[0].core_manifest_hash : null,
          sourceErrorFactHash: authorizations[0].schema === QUARANTINE_SCHEMA ? authorizations[0].error_fact_hash : null,
          factHash: cleanup.fact_hash,
          cleanedAt: cleanup.cleaned_at
        };
      }
      if (quarantine !== undefined) {
        return {
          state: "quarantined",
          errorFactHash: quarantine.error_fact_hash,
          authorizationHash: quarantine.core_quarantine_fact_hash,
          factHash: quarantine.fact_hash,
          quarantinedAt: quarantine.quarantined_at,
          deleteBy: quarantine.delete_by
        };
      }
      if (discard !== undefined) {
        return {
          state: "discarded",
          reason: discard.reason,
          authorizationHash: discard.discard_authorization_hash,
          coreConclusionFactHash: discard.core_conclusion_fact_hash,
          cleanupAuthorizationHash: discard.core_cleanup_fact_hash,
          factHash: discard.fact_hash,
          discardedAt: discard.discarded_at
        };
      }
      if (expired !== undefined) {
        return {
          state: "expired",
          manifestHash: expired.manifest_hash,
          factHash: expired.fact_hash,
          expiredAt: expired.expired_at
        };
      }
      if (ack !== undefined) {
        return {
          state: "acknowledged",
          manifestHash: ack.connector_manifest_hash,
          coreManifestHash: ack.core_manifest_hash,
          authorizationHash: ack.core_ack_fact_hash,
          factHash: ack.fact_hash,
          acknowledgedAt: ack.acknowledged_at
        };
      }
      return { state: "pending_ack", manifestHash: output.spool_manifest_hash, totalBytes: output.total_bytes };
    } catch (error) {
      return this.retentionErrorObservation(error);
    }
  }
  retentionErrorObservation(error) {
    return error instanceof LedgerUnavailableError || error instanceof Error && "code" in error ? { state: "unavailable" } : { state: "corrupt" };
  }
  makeMetadata() {
    return hashedFact({ schema: METADATA_SCHEMA, ledger_epoch: this.ledgerEpoch });
  }
  makeReservation(binding, metadata, replayPermitted, reservedAt) {
    return hashedFact({
      schema: RESERVATION_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      binding: copy2(binding),
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      replay_permitted: replayPermitted,
      reserved_at: reservedAt,
      parent_fact_hash: metadata.fact_hash
    });
  }
  makeBindingIndex(binding, metadata, reservation) {
    return hashedFact({
      schema: INDEX_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      eval_job_id: binding.dispatch.eval_job_id,
      project_id: binding.project_id,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      replay_permitted: reservation.replay_permitted,
      reserved_at: reservation.reserved_at,
      reservation_fact_hash: reservation.fact_hash,
      parent_fact_hash: metadata.fact_hash
    });
  }
  makeAcceptance(binding, reservation, executionState, acceptedAt, ownerHash, processIdentity) {
    return hashedFact({
      schema: ACCEPTANCE_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      execution_state: executionState,
      accepted_at: acceptedAt,
      effect_owner_token_hash: ownerHash,
      ...processIdentity === undefined ? {} : {
        process_pid: processIdentity.pid,
        process_group_id: processIdentity.processGroupId,
        process_start_token: processIdentity.startToken
      },
      parent_fact_hash: reservation.fact_hash
    });
  }
  makeAcceptanceHead(binding, reservation, acceptance) {
    return hashedFact({
      schema: ACCEPTANCE_HEAD_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      execution_state: acceptance.execution_state,
      accepted_at: acceptance.accepted_at,
      effect_owner_token_hash: acceptance.effect_owner_token_hash,
      ...acceptance.process_pid === undefined ? {} : {
        process_pid: acceptance.process_pid,
        process_group_id: acceptance.process_group_id,
        process_start_token: acceptance.process_start_token
      },
      parent_fact_hash: reservation.fact_hash,
      acceptance_fact_hash: acceptance.fact_hash
    });
  }
  makeProcess(binding, acceptance, identity) {
    return hashedFact({
      schema: PROCESS_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      pid: identity.pid,
      process_group_id: identity.processGroupId,
      process_start_token: identity.startToken,
      started_at: this.isoNow(),
      effect_owner_token_hash: acceptance.effect_owner_token_hash,
      parent_fact_hash: acceptance.fact_hash
    });
  }
  makeStopIntent(binding, acceptance, reason) {
    return hashedFact({
      schema: STOP_INTENT_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      reason,
      requested_at: this.isoNow(),
      effect_owner_token_hash: acceptance.effect_owner_token_hash,
      parent_fact_hash: acceptance.fact_hash
    });
  }
  makeOutput(binding, process2, output) {
    return hashedFact({
      schema: OUTPUT_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      spool_manifest_hash: output.spoolManifestHash,
      entry_count: output.entryCount,
      total_bytes: output.totalBytes,
      retention_state: "pending_ack",
      created_at: this.isoNow(),
      effect_owner_token_hash: process2.effect_owner_token_hash,
      parent_fact_hash: process2.fact_hash
    });
  }
  makeEvidenceAck(binding, output, hashes) {
    return hashedFact({
      schema: ACK_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      connector_manifest_hash: hashes.connectorManifestHash,
      core_manifest_hash: hashes.coreManifestHash,
      core_ack_fact_hash: hashes.coreAckFactHash,
      acknowledged_at: this.isoNow(),
      parent_fact_hash: output.fact_hash
    });
  }
  makeEvidenceQuarantine(binding, output, hashes) {
    const quarantinedAt = this.isoNow();
    return hashedFact({
      schema: QUARANTINE_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      error_fact_hash: hashes.errorFactHash,
      core_quarantine_fact_hash: hashes.coreQuarantineFactHash,
      quarantined_at: quarantinedAt,
      delete_by: new Date(Date.parse(quarantinedAt) + 24 * 60 * 60 * 1000).toISOString(),
      parent_fact_hash: output.fact_hash
    });
  }
  makeEvidenceExpired(binding, output, terminal2) {
    return hashedFact({
      schema: EXPIRED_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      manifest_hash: output.spool_manifest_hash,
      terminal_fact_hash: terminal2.fact_hash,
      expired_at: this.isoNow(),
      parent_fact_hash: output.fact_hash
    });
  }
  makeEvidenceDiscard(binding, reservation, input) {
    return hashedFact({
      schema: DISCARD_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      reason: input.reason,
      core_conclusion_fact_hash: input.coreConclusionFactHash,
      core_cleanup_fact_hash: input.coreCleanupFactHash,
      discard_authorization_hash: input.discardAuthorizationHash,
      discarded_at: this.isoNow(),
      parent_fact_hash: reservation.fact_hash
    });
  }
  makeEvidenceCleanup(binding, authorizationFactHash, coreCleanupFactHash) {
    return hashedFact({
      schema: CLEANUP_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      authorization_fact_hash: authorizationFactHash,
      core_cleanup_fact_hash: coreCleanupFactHash,
      cleaned_at: this.isoNow(),
      parent_fact_hash: authorizationFactHash
    });
  }
  makeProcessExit(binding, process2) {
    return hashedFact({
      schema: PROCESS_EXIT_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      pid: process2.pid,
      process_group_id: process2.process_group_id,
      process_start_token: process2.process_start_token,
      stopped_at: this.isoNow(),
      effect_owner_token_hash: process2.effect_owner_token_hash,
      parent_fact_hash: process2.fact_hash
    });
  }
  makeProcessExitHead(binding, process2, processExit) {
    return hashedFact({
      schema: PROCESS_EXIT_HEAD_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      effect_owner_token_hash: process2.effect_owner_token_hash,
      parent_fact_hash: process2.fact_hash,
      process_exit_fact_hash: processExit.fact_hash
    });
  }
  makeTerminal(binding, processExit, terminalState, terminalAt, errorCode) {
    return hashedFact({
      schema: TERMINAL_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      terminal_state: terminalState,
      process_stopped: true,
      terminal_at: terminalAt,
      error_code: errorCode,
      effect_owner_token_hash: processExit.effect_owner_token_hash,
      parent_fact_hash: processExit.fact_hash
    });
  }
  makeTerminalHead(binding, processExit, terminal2) {
    return hashedFact({
      schema: TERMINAL_HEAD_SCHEMA,
      ledger_epoch: this.ledgerEpoch,
      connector_job_id: binding.dispatch.connector_job_id,
      connector_idempotency_key: binding.dispatch.connector_idempotency_key,
      dispatch_request_hash: binding.dispatch_request_hash,
      binding_fingerprint: evolutionEvalBindingFingerprint(binding),
      terminal_state: terminal2.terminal_state,
      process_stopped: true,
      terminal_at: terminal2.terminal_at,
      error_code: terminal2.error_code,
      effect_owner_token_hash: terminal2.effect_owner_token_hash,
      parent_fact_hash: processExit.fact_hash,
      terminal_fact_hash: terminal2.fact_hash
    });
  }
  metadata(value) {
    const fact = verifiedFact(value, ["ledger_epoch", "schema"]);
    if (fact.schema !== METADATA_SCHEMA)
      throw new LedgerCorruptError;
    if (fact.ledger_epoch !== this.ledgerEpoch)
      throw new LedgerEpochMismatchError;
    return fact;
  }
  bindingIndex(value, binding, metadata) {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "eval_job_id",
      "ledger_epoch",
      "parent_fact_hash",
      "project_id",
      "replay_permitted",
      "reservation_fact_hash",
      "reserved_at",
      "schema"
    ]);
    if (fact.schema !== INDEX_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== metadata.fact_hash || !validHash(fact.reservation_fact_hash) || typeof fact.replay_permitted !== "boolean" || !validTimestamp(fact.reserved_at))
      throw new LedgerCorruptError;
    if (!this.factBindingMatches(fact, binding, true))
      throw new LedgerBindingConflictError;
    return fact;
  }
  reservation(value, binding, metadata, index) {
    const fact = verifiedFact(value, [
      "binding",
      "binding_fingerprint",
      "ledger_epoch",
      "parent_fact_hash",
      "replay_permitted",
      "reserved_at",
      "schema"
    ]);
    if (fact.schema !== RESERVATION_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== metadata.fact_hash || fact.fact_hash !== index.reservation_fact_hash || fact.replay_permitted !== index.replay_permitted || fact.reserved_at !== index.reserved_at) {
      throw new LedgerCorruptError;
    }
    let storedBinding;
    try {
      storedBinding = validateCoreIssuedEvalBinding(fact.binding);
    } catch {
      throw new LedgerCorruptError;
    }
    const fingerprint = evolutionEvalBindingFingerprint(binding);
    if (fact.binding_fingerprint !== fingerprint || evolutionEvalBindingFingerprint(storedBinding) !== fingerprint) {
      throw new LedgerBindingConflictError;
    }
    return { ...fact, binding: storedBinding };
  }
  acceptanceHead(value, binding, reservation) {
    const record2 = value;
    const hasProcessIdentity = record2?.process_pid !== undefined || record2?.process_group_id !== undefined || record2?.process_start_token !== undefined;
    const fact = verifiedFact(value, [
      "acceptance_fact_hash",
      "accepted_at",
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "execution_state",
      "ledger_epoch",
      "parent_fact_hash",
      ...hasProcessIdentity ? ["process_group_id", "process_pid", "process_start_token"] : [],
      "schema"
    ]);
    if (fact.schema !== ACCEPTANCE_HEAD_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== reservation.fact_hash || !validHash(fact.acceptance_fact_hash) || !validHash(fact.effect_owner_token_hash) || !validTimestamp(fact.accepted_at) || hasProcessIdentity && (!Number.isSafeInteger(fact.process_pid) || Number(fact.process_pid) < 1 || !Number.isSafeInteger(fact.process_group_id) || Number(fact.process_group_id) < 1 || typeof fact.process_start_token !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(fact.process_start_token)) || !["queued", "preparing", "running"].includes(fact.execution_state)) {
      throw new LedgerCorruptError;
    }
    if (!this.factBindingMatches(fact, binding))
      throw new LedgerBindingConflictError;
    return fact;
  }
  acceptance(value, binding, reservation, head) {
    const record2 = value;
    const hasProcessIdentity = record2?.process_pid !== undefined || record2?.process_group_id !== undefined || record2?.process_start_token !== undefined;
    const fact = verifiedFact(value, [
      "accepted_at",
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "execution_state",
      "ledger_epoch",
      "parent_fact_hash",
      ...hasProcessIdentity ? ["process_group_id", "process_pid", "process_start_token"] : [],
      "schema"
    ]);
    if (fact.schema !== ACCEPTANCE_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== reservation.fact_hash || fact.fact_hash !== head.acceptance_fact_hash || fact.accepted_at !== head.accepted_at || fact.execution_state !== head.execution_state || fact.effect_owner_token_hash !== head.effect_owner_token_hash || !validHash(fact.effect_owner_token_hash) || fact.process_pid !== head.process_pid || fact.process_group_id !== head.process_group_id || fact.process_start_token !== head.process_start_token || hasProcessIdentity && (!Number.isSafeInteger(fact.process_pid) || Number(fact.process_pid) < 1 || !Number.isSafeInteger(fact.process_group_id) || Number(fact.process_group_id) < 1 || typeof fact.process_start_token !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(fact.process_start_token)) || !validTimestamp(fact.accepted_at) || !["queued", "preparing", "running"].includes(fact.execution_state)) {
      throw new LedgerCorruptError;
    }
    if (!this.factBindingMatches(fact, binding))
      throw new LedgerBindingConflictError;
    return fact;
  }
  terminalHead(value, binding, processExit) {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "error_code",
      "ledger_epoch",
      "parent_fact_hash",
      "process_stopped",
      "schema",
      "terminal_at",
      "terminal_fact_hash",
      "terminal_state"
    ]);
    if (fact.schema !== TERMINAL_HEAD_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== processExit.fact_hash || fact.process_stopped !== true || fact.effect_owner_token_hash !== processExit.effect_owner_token_hash || !validHash(fact.terminal_fact_hash) || !validTimestamp(fact.terminal_at) || !["succeeded", "failed", "cancelled", "timeout"].includes(fact.terminal_state) || fact.error_code !== null && (typeof fact.error_code !== "string" || !ERROR_CODE_PATTERN2.test(fact.error_code))) {
      throw new LedgerCorruptError;
    }
    if (!this.factBindingMatches(fact, binding))
      throw new LedgerBindingConflictError;
    return fact;
  }
  process(value, binding, acceptance) {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "ledger_epoch",
      "parent_fact_hash",
      "pid",
      "process_group_id",
      "process_start_token",
      "schema",
      "started_at"
    ]);
    if (fact.schema !== PROCESS_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== acceptance.fact_hash || fact.effect_owner_token_hash !== acceptance.effect_owner_token_hash || !Number.isSafeInteger(fact.pid) || Number(fact.pid) < 1 || !Number.isSafeInteger(fact.process_group_id) || Number(fact.process_group_id) < 1 || typeof fact.process_start_token !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(fact.process_start_token) || acceptance.process_pid !== undefined && (fact.pid !== acceptance.process_pid || fact.process_group_id !== acceptance.process_group_id || fact.process_start_token !== acceptance.process_start_token) || !validTimestamp(fact.started_at))
      throw new LedgerCorruptError;
    if (!this.factBindingMatches(fact, binding))
      throw new LedgerBindingConflictError;
    return fact;
  }
  stopIntent(value, binding, acceptance) {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "ledger_epoch",
      "parent_fact_hash",
      "reason",
      "requested_at",
      "schema"
    ]);
    if (fact.schema !== STOP_INTENT_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== acceptance.fact_hash || fact.effect_owner_token_hash !== acceptance.effect_owner_token_hash || !(fact.reason === "cancelled" || fact.reason === "timeout") || !validTimestamp(fact.requested_at))
      throw new LedgerCorruptError;
    if (!this.factBindingMatches(fact, binding))
      throw new LedgerBindingConflictError;
    return fact;
  }
  output(value, binding, process2) {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "created_at",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "entry_count",
      "ledger_epoch",
      "parent_fact_hash",
      "retention_state",
      "schema",
      "spool_manifest_hash",
      "total_bytes"
    ]);
    if (fact.schema !== OUTPUT_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== process2.fact_hash || fact.effect_owner_token_hash !== process2.effect_owner_token_hash || !validHash(fact.spool_manifest_hash) || !Number.isSafeInteger(fact.entry_count) || Number(fact.entry_count) < 0 || Number(fact.entry_count) > 128 || !Number.isSafeInteger(fact.total_bytes) || Number(fact.total_bytes) < 0 || Number(fact.total_bytes) > 256 * 1024 * 1024 || fact.retention_state !== "pending_ack" || !validTimestamp(fact.created_at))
      throw new LedgerCorruptError;
    if (!this.factBindingMatches(fact, binding))
      throw new LedgerBindingConflictError;
    return fact;
  }
  evidenceAck(value, binding, output) {
    const fact = verifiedFact(value, [
      "acknowledged_at",
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "connector_manifest_hash",
      "core_ack_fact_hash",
      "core_manifest_hash",
      "dispatch_request_hash",
      "ledger_epoch",
      "parent_fact_hash",
      "schema"
    ]);
    if (fact.schema !== ACK_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== output.fact_hash || fact.connector_manifest_hash !== output.spool_manifest_hash || !validHash(fact.core_manifest_hash) || !validHash(fact.core_ack_fact_hash) || !validTimestamp(fact.acknowledged_at) || Date.parse(String(fact.acknowledged_at)) < Date.parse(output.created_at))
      throw new LedgerCorruptError;
    if (!this.factBindingMatches(fact, binding))
      throw new LedgerBindingConflictError;
    return fact;
  }
  evidenceQuarantine(value, binding, output) {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "delete_by",
      "core_quarantine_fact_hash",
      "dispatch_request_hash",
      "error_fact_hash",
      "ledger_epoch",
      "parent_fact_hash",
      "quarantined_at",
      "schema"
    ]);
    if (fact.schema !== QUARANTINE_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== output.fact_hash || !validHash(fact.error_fact_hash) || !validHash(fact.core_quarantine_fact_hash) || !validTimestamp(fact.quarantined_at) || !validTimestamp(fact.delete_by) || Date.parse(String(fact.quarantined_at)) < Date.parse(output.created_at) || Date.parse(String(fact.delete_by)) !== Date.parse(String(fact.quarantined_at)) + 24 * 60 * 60 * 1000) {
      throw new LedgerCorruptError;
    }
    if (!this.factBindingMatches(fact, binding))
      throw new LedgerBindingConflictError;
    return fact;
  }
  evidenceExpired(value, binding, output, terminal2) {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "expired_at",
      "ledger_epoch",
      "manifest_hash",
      "parent_fact_hash",
      "schema",
      "terminal_fact_hash"
    ]);
    if (fact.schema !== EXPIRED_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== output.fact_hash || fact.manifest_hash !== output.spool_manifest_hash || fact.terminal_fact_hash !== terminal2.fact_hash || !validTimestamp(fact.expired_at) || Date.parse(String(fact.expired_at)) < Date.parse(terminal2.terminal_at) + 7 * 24 * 60 * 60 * 1000) {
      throw new LedgerCorruptError;
    }
    if (!this.factBindingMatches(fact, binding))
      throw new LedgerBindingConflictError;
    return fact;
  }
  evidenceDiscard(value, binding, reservation) {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "core_cleanup_fact_hash",
      "core_conclusion_fact_hash",
      "discard_authorization_hash",
      "discarded_at",
      "dispatch_request_hash",
      "ledger_epoch",
      "parent_fact_hash",
      "reason",
      "schema"
    ]);
    if (fact.schema !== DISCARD_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== reservation.fact_hash || !(fact.reason === "unavailable_at_deadline" || fact.reason === "absolute_expiry") || !validHash(fact.core_conclusion_fact_hash) || !validHash(fact.core_cleanup_fact_hash) || !validHash(fact.discard_authorization_hash) || !validTimestamp(fact.discarded_at)) {
      throw new LedgerCorruptError;
    }
    if (!this.factBindingMatches(fact, binding))
      throw new LedgerBindingConflictError;
    return fact;
  }
  evidenceCleanup(value, binding, authorization) {
    const fact = verifiedFact(value, [
      "authorization_fact_hash",
      "binding_fingerprint",
      "cleaned_at",
      "connector_idempotency_key",
      "core_cleanup_fact_hash",
      "connector_job_id",
      "dispatch_request_hash",
      "ledger_epoch",
      "parent_fact_hash",
      "schema"
    ]);
    const authorizationAt = authorization.schema === ACK_SCHEMA ? authorization.acknowledged_at : authorization.schema === QUARANTINE_SCHEMA ? authorization.quarantined_at : authorization.schema === EXPIRED_SCHEMA ? authorization.expired_at : authorization.discarded_at;
    if (fact.schema !== CLEANUP_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.authorization_fact_hash !== authorization.fact_hash || fact.parent_fact_hash !== authorization.fact_hash || !validHash(fact.core_cleanup_fact_hash) || !validTimestamp(fact.cleaned_at) || Date.parse(String(fact.cleaned_at)) < Date.parse(authorizationAt))
      throw new LedgerCorruptError;
    if (!this.factBindingMatches(fact, binding))
      throw new LedgerBindingConflictError;
    return fact;
  }
  processExit(value, binding, process2) {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "ledger_epoch",
      "parent_fact_hash",
      "pid",
      "process_group_id",
      "process_start_token",
      "schema",
      "stopped_at"
    ]);
    if (fact.schema !== PROCESS_EXIT_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== process2.fact_hash || fact.effect_owner_token_hash !== process2.effect_owner_token_hash || fact.pid !== process2.pid || fact.process_group_id !== process2.process_group_id || fact.process_start_token !== process2.process_start_token || !validTimestamp(fact.stopped_at))
      throw new LedgerCorruptError;
    if (!this.factBindingMatches(fact, binding))
      throw new LedgerBindingConflictError;
    return fact;
  }
  processExitHead(value, binding, process2, processExit) {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "ledger_epoch",
      "parent_fact_hash",
      "process_exit_fact_hash",
      "schema"
    ]);
    if (fact.schema !== PROCESS_EXIT_HEAD_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== process2.fact_hash || fact.effect_owner_token_hash !== process2.effect_owner_token_hash || fact.process_exit_fact_hash !== processExit.fact_hash)
      throw new LedgerCorruptError;
    if (!this.factBindingMatches(fact, binding))
      throw new LedgerBindingConflictError;
    return fact;
  }
  terminal(value, binding, processExit, head) {
    const fact = verifiedFact(value, [
      "binding_fingerprint",
      "connector_idempotency_key",
      "connector_job_id",
      "dispatch_request_hash",
      "effect_owner_token_hash",
      "error_code",
      "ledger_epoch",
      "parent_fact_hash",
      "process_stopped",
      "schema",
      "terminal_at",
      "terminal_state"
    ]);
    if (fact.schema !== TERMINAL_SCHEMA || fact.ledger_epoch !== this.ledgerEpoch || fact.parent_fact_hash !== processExit.fact_hash || fact.fact_hash !== head.terminal_fact_hash || fact.process_stopped !== true || fact.terminal_state !== head.terminal_state || fact.terminal_at !== head.terminal_at || fact.error_code !== head.error_code || fact.effect_owner_token_hash !== processExit.effect_owner_token_hash || fact.effect_owner_token_hash !== head.effect_owner_token_hash || !validTimestamp(fact.terminal_at) || !["succeeded", "failed", "cancelled", "timeout"].includes(fact.terminal_state) || fact.error_code !== null && (typeof fact.error_code !== "string" || !ERROR_CODE_PATTERN2.test(fact.error_code))) {
      throw new LedgerCorruptError;
    }
    if (!this.factBindingMatches(fact, binding))
      throw new LedgerBindingConflictError;
    return fact;
  }
  factBindingMatches(fact, binding, includeEvalAndProject = false) {
    return fact.connector_job_id === binding.dispatch.connector_job_id && fact.connector_idempotency_key === binding.dispatch.connector_idempotency_key && fact.dispatch_request_hash === binding.dispatch_request_hash && fact.binding_fingerprint === evolutionEvalBindingFingerprint(binding) && (!includeEvalAndProject || fact.eval_job_id === binding.dispatch.eval_job_id && fact.project_id === binding.project_id);
  }
  errorObservation(binding, error) {
    if (error instanceof LedgerEpochMismatchError)
      return corrupt(binding, this.ledgerEpoch, ERROR.epochMismatch);
    if (error instanceof LedgerBindingConflictError) {
      const code = ERROR_CODE_PATTERN2.test(error.message) ? error.message : ERROR.bindingConflict;
      return corrupt(binding, this.ledgerEpoch, code);
    }
    if (error instanceof LedgerReservationConflictError) {
      const code = ERROR_CODE_PATTERN2.test(error.message) ? error.message : ERROR.reservationConflict;
      return corrupt(binding, this.ledgerEpoch, code);
    }
    if (error instanceof LedgerCorruptError)
      return corrupt(binding, this.ledgerEpoch, ERROR.corrupt);
    return unavailable(binding, this.ledgerEpoch);
  }
  initializationCode(error) {
    if (error instanceof LedgerEpochMismatchError)
      return ERROR.epochMismatch;
    if (error instanceof LedgerCorruptError)
      return ERROR.corrupt;
    return ERROR.unavailable;
  }
  async validateLayout() {
    await this.assertDirectory(this.root);
    const metadata = this.metadata(await this.readRequired(join3(this.root, "ledger.json")));
    await this.assertDirectory(this.facts);
    await this.assertDirectory(this.heads);
    await this.assertDirectory(this.indexes);
    return metadata;
  }
  async assertDirectory(path) {
    let details;
    try {
      details = await lstat2(path);
    } catch (error) {
      if (isErrno(error, "ENOENT"))
        throw new LedgerCorruptError;
      throw new LedgerUnavailableError;
    }
    if (!details.isDirectory() || details.isSymbolicLink())
      throw new LedgerCorruptError;
  }
  indexPath(binding) {
    return join3(this.indexes, `${evolutionEvalLedgerRecordKey(binding.dispatch.eval_job_id)}.json`);
  }
  factPath(binding, kind) {
    const key = evolutionEvalLedgerRecordKey(binding.dispatch.connector_job_id);
    return join3(this.facts, `${key}.${kind}.json`);
  }
  headPath(binding, kind) {
    const key = evolutionEvalLedgerRecordKey(binding.dispatch.connector_job_id);
    return join3(this.heads, `${key}.${kind}.json`);
  }
  isoNow() {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new TypeError("ledger clock is invalid");
    return now.toISOString();
  }
  async readRequired(path) {
    const value = await this.readOptional(path);
    if (value === undefined)
      throw new LedgerCorruptError;
    return value;
  }
  async readOptional(path) {
    let details;
    try {
      details = await lstat2(path);
    } catch (error) {
      if (isErrno(error, "ENOENT"))
        return;
      throw new LedgerUnavailableError;
    }
    if (!details.isFile() || details.isSymbolicLink() || details.size < 2 || details.size > MAX_FACT_BYTES) {
      throw new LedgerCorruptError;
    }
    let body;
    try {
      body = await readFile3(path, "utf8");
    } catch {
      throw new LedgerUnavailableError;
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new LedgerCorruptError;
    }
  }
  async atomicCreate(path, value, factKind, temporaryDirectory = dirname3(path)) {
    const directory = dirname3(path);
    const temporary = join3(temporaryDirectory, `.evolution-eval-${crypto.randomUUID()}.tmp`);
    const body = `${canonicalEvolutionEvalJson(value)}
`;
    if (Buffer.byteLength(body, "utf8") > MAX_FACT_BYTES)
      throw new LedgerCorruptError;
    let handle;
    try {
      handle = await open2(temporary, "wx", 384);
      await this.inject("temp_write", factKind);
      await handle.writeFile(body, "utf8");
      await this.inject("file_fsync", factKind);
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (process.platform === "win32") {
        await this.inject("link", factKind);
        await this.inject("directory_fsync", factKind);
        const outcome = windowsMoveWriteThrough2(temporary, path);
        if (outcome === "exists") {
          return false;
        }
        return true;
      }
      try {
        await this.inject("link", factKind);
        await link2(temporary, path);
      } catch (error) {
        if (isErrno(error, "EEXIST")) {
          await this.inject("directory_fsync", factKind);
          await this.syncDirectory(directory);
          return false;
        }
        throw error;
      }
      await this.inject("directory_fsync", factKind);
      await this.syncDirectory(directory);
      return true;
    } finally {
      if (handle !== undefined)
        await handle.close().catch(() => {
          return;
        });
      await unlink3(temporary).catch(() => {
        return;
      });
    }
  }
  async inject(operation, factKind) {
    await this.faultInjector?.({ operation, factKind });
  }
  async durabilityFence(path, factKind) {
    await this.inject("directory_fsync", factKind);
    await this.syncDirectory(path);
  }
  async syncDirectory(path) {
    if (process.platform === "win32") {
      const details = await lstat2(path);
      if (!details.isDirectory() || details.isSymbolicLink())
        throw new LedgerUnavailableError;
      return;
    }
    const handle = await open2(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async exclusive(key, operation) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = () => {
      return;
    };
    const gate = new Promise((resolveGate) => {
      release = resolveGate;
    });
    const queued = previous.then(() => gate);
    this.locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued)
        this.locks.delete(key);
    }
  }
}

// connector/toolchain-attestation.ts
import { createHash as createHash6 } from "node:crypto";
import { readFile as readFile4 } from "node:fs/promises";
import { lstat as lstat3, readdir as readdir4 } from "node:fs/promises";
import { createReadStream as createReadStream2 } from "node:fs";
import { join as join4 } from "node:path";
var VIVADO_TOOLCHAIN_ATTESTATION_SCHEMA = "synthia-vivado-toolchain-attestation.v1";
var FULL_TREE_MANIFEST_SCHEMA = "synthia-vivado-full-tree-manifest.v1";
var HASH = /^[0-9a-f]{64}$/;
var EXPECTED_PART = "xc7k70tfbv676-1";
var OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function record2(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}`);
  return value;
}
function exact2(value, keys, label) {
  const candidate = record2(value, label);
  const actual = Object.keys(candidate).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}:shape`);
  }
  return candidate;
}
function hash2(value, label) {
  if (typeof value !== "string" || !HASH.test(value))
    throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}`);
  return value;
}
function text(value, label, maximum = 512) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum || /[\u0000-\u001f\u007f]/u.test(value) || hasLoneSurrogate2(value) || value.normalize("NFC") !== value) {
    throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}`);
  }
  return value;
}
function hasLoneSurrogate2(value) {
  for (let index = 0;index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 55296 && code <= 56319) {
      if (index + 1 >= value.length)
        return true;
      const next = value.charCodeAt(index + 1);
      if (next < 56320 || next > 57343)
        return true;
      index += 1;
    } else if (code >= 56320 && code <= 57343)
      return true;
  }
  return false;
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}`);
  return Number(value);
}
function timestamp2(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z"))
    throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}`);
  return parsed;
}
function windowsPathEqual(left, right) {
  return left.replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase() === right.replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase();
}
function portableRelativePath(value, label) {
  const path = text(value, label, 4096);
  if (path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}`);
  }
  return path;
}
function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function validateFullTreeManifest(value) {
  const manifest = exact2(value, ["schema", "canonicalization", "entries", "entry_count", "file_count", "total_bytes", "canonical_sha256"], "full_tree");
  if (manifest.schema !== FULL_TREE_MANIFEST_SCHEMA)
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:schema");
  if (manifest.canonicalization !== "RFC8785/JCS+NFC")
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:canonicalization");
  if (!Array.isArray(manifest.entries))
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:entries");
  let files = 0;
  let directories = 0;
  let bytes = 0;
  const folded = new Set;
  let previous;
  for (const raw of manifest.entries) {
    const entry = exact2(raw, ["path", "type", "size_bytes", "sha256"], "full_tree:entry");
    const path = portableRelativePath(entry.path, "full_tree:path");
    if (previous !== undefined && compareUtf8(previous, path) >= 0)
      throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:order");
    previous = path;
    const collisionKey = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(collisionKey))
      throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:path_collision");
    folded.add(collisionKey);
    if (entry.type === "regular_file") {
      files += 1;
      bytes += integer(entry.size_bytes, "full_tree:file_size");
      hash2(entry.sha256, "full_tree:file_hash");
    } else if (entry.type === "directory") {
      directories += 1;
      if (entry.size_bytes !== 0 || entry.sha256 !== null)
        throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:directory");
    } else {
      throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:type");
    }
  }
  if (manifest.entry_count !== manifest.entries.length || manifest.file_count !== files || manifest.total_bytes !== bytes || manifest.entries.length !== files + directories || manifest.entries.length < 1 || files < 1 || bytes < 1) {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:summary");
  }
  const canonical = hash2(manifest.canonical_sha256, "full_tree:canonical_hash");
  const body = { ...manifest };
  delete body.canonical_sha256;
  if (canonicalEvolutionEvalHash(body) !== canonical)
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:canonical_hash");
  return structuredClone(value);
}
async function hashFile(path) {
  const digest = createHash6("sha256");
  for await (const chunk of createReadStream2(path))
    digest.update(chunk);
  return digest.digest("hex");
}
async function buildFullTreeManifest(root) {
  const rootFacts = await lstat3(root);
  if (rootFacts.isSymbolicLink())
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:reparse");
  if (!rootFacts.isDirectory())
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:root");
  const entries = [];
  const walk = async (directory, prefix) => {
    for (const name of await readdir4(directory)) {
      text(name, "full_tree:name", 4096);
      const relative = prefix ? `${prefix}/${name}` : name;
      portableRelativePath(relative, "full_tree:path");
      const absolute = join4(directory, name);
      const facts = await lstat3(absolute);
      if (facts.isSymbolicLink())
        throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:reparse");
      if (facts.isDirectory()) {
        entries.push({ path: relative, type: "directory", size_bytes: 0, sha256: null });
        await walk(absolute, relative);
      } else if (facts.isFile()) {
        entries.push({ path: relative, type: "regular_file", size_bytes: facts.size, sha256: await hashFile(absolute) });
      } else {
        throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:unknown_entry");
      }
    }
  };
  await walk(root, "");
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  const body = {
    schema: FULL_TREE_MANIFEST_SCHEMA,
    canonicalization: "RFC8785/JCS+NFC",
    entries,
    entry_count: entries.length,
    file_count: entries.filter((entry) => entry.type === "regular_file").length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0)
  };
  return validateFullTreeManifest({ ...body, canonical_sha256: canonicalEvolutionEvalHash(body) });
}
function deriveVivadoToolchainProfileHash(attestation) {
  return canonicalEvolutionEvalHash({
    schema: "synthia-vivado-toolchain-profile-derivation.v1",
    capability_map_version: attestation.toolchain_profile.capability_map_version,
    semantic_profile_sha256: attestation.toolchain_profile.semantic_profile_sha256,
    full_tree_manifest_sha256: attestation.full_tree_manifest.canonical_sha256,
    volume_identity_canonical_sha256: attestation.attachment.volume.identity_canonical_sha256,
    binary_relative_path: attestation.vivado.binary_relative_path,
    version: attestation.vivado.version,
    sw_build: attestation.vivado.sw_build,
    ip_build: attestation.vivado.ip_build,
    part_catalog_sha256: attestation.vivado.part_catalog_sha256,
    target_part: attestation.vivado.target_part,
    part_probe_stdout_sha256: attestation.vivado.part_probe_stdout_sha256,
    license_probe_stdout_sha256: attestation.vivado.license.stdout_sha256,
    synth_input_sha256: attestation.vivado.minimal_synth.input_sha256,
    synth_stdout_sha256: attestation.vivado.minimal_synth.stdout_sha256
  });
}
function validateVivadoToolchainAttestation(value, options = {}) {
  const attestation = exact2(value, ["schema", "gate_id", "issued_at", "not_before", "expires_at", "vhdx", "attachment", "full_tree_manifest", "vivado", "toolchain_profile", "canonical_attestation_sha256"], "root");
  if (attestation.schema !== VIVADO_TOOLCHAIN_ATTESTATION_SCHEMA)
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:schema");
  const gateId = text(attestation.gate_id, "gate_id", 64);
  if (!OPAQUE.test(gateId))
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:gate_id");
  const issued = timestamp2(attestation.issued_at, "issued_at");
  const notBefore = timestamp2(attestation.not_before, "not_before");
  const expires = timestamp2(attestation.expires_at, "expires_at");
  const now = (options.now ?? new Date).getTime();
  if (issued > notBefore || expires <= notBefore || expires - notBefore > 4 * 60 * 60 * 1000 || now < notBefore || now >= expires) {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:validity");
  }
  const vhdx = exact2(attestation.vhdx, ["path", "sha256", "size_bytes", "file_identity", "backing_parent"], "vhdx");
  const vhdxPath = text(vhdx.path, "vhdx:path");
  hash2(vhdx.sha256, "vhdx:sha256");
  integer(vhdx.size_bytes, "vhdx:size", 1);
  const preIdentity = exact2(vhdx.file_identity, ["volume_serial_number", "file_id"], "vhdx:file_identity");
  text(preIdentity.volume_serial_number, "vhdx:volume_serial_number", 128);
  text(preIdentity.file_id, "vhdx:file_id", 128);
  const parent = exact2(vhdx.backing_parent, ["path", "owner_sid", "acl_sha256", "protected"], "vhdx:backing_parent");
  text(parent.path, "vhdx:backing_parent:path");
  text(parent.owner_sid, "vhdx:backing_parent:owner_sid", 184);
  hash2(parent.acl_sha256, "vhdx:backing_parent:acl_sha256");
  if (parent.protected !== true)
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:vhdx:backing_parent:protected");
  const attachment = exact2(attestation.attachment, ["image_path", "attached", "read_only", "disk", "partition", "volume", "write_probe", "backing_file_identity"], "attachment");
  if (!windowsPathEqual(text(attachment.image_path, "attachment:image_path"), vhdxPath) || attachment.attached !== true || attachment.read_only !== true || attachment.write_probe !== "access_denied") {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:attachment");
  }
  const attachedIdentity = exact2(attachment.backing_file_identity, ["volume_serial_number", "file_id"], "attachment:file_identity");
  if (attachedIdentity.volume_serial_number !== preIdentity.volume_serial_number || attachedIdentity.file_id !== preIdentity.file_id) {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:attachment:file_identity");
  }
  const disk = exact2(attachment.disk, ["number", "unique_id"], "attachment:disk");
  integer(disk.number, "attachment:disk:number");
  text(disk.unique_id, "attachment:disk:unique_id", 256);
  const partition = exact2(attachment.partition, ["number", "guid"], "attachment:partition");
  integer(partition.number, "attachment:partition:number", 1);
  text(partition.guid, "attachment:partition:guid", 128);
  const volume = exact2(attachment.volume, ["guid", "serial_number", "file_system", "mount_path", "identity_canonical_sha256"], "attachment:volume");
  text(volume.guid, "attachment:volume:guid", 128);
  text(volume.serial_number, "attachment:volume:serial_number", 128);
  if (volume.file_system !== "NTFS")
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:attachment:volume:file_system");
  text(volume.mount_path, "attachment:volume:mount_path");
  const volumeIdentityHash = hash2(volume.identity_canonical_sha256, "attachment:volume:identity_hash");
  if (volumeIdentityHash !== canonicalEvolutionEvalHash({
    guid: volume.guid,
    serial_number: volume.serial_number,
    file_system: volume.file_system,
    mount_path: volume.mount_path
  }))
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:attachment:volume:identity_hash");
  const tree = exact2(attestation.full_tree_manifest, ["schema", "canonical_sha256", "entry_count", "file_count", "total_bytes"], "full_tree_manifest");
  if (tree.schema !== FULL_TREE_MANIFEST_SCHEMA)
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree_manifest");
  hash2(tree.canonical_sha256, "full_tree_manifest:canonical_sha256");
  for (const name of ["entry_count", "file_count", "total_bytes"])
    integer(tree[name], `full_tree_manifest:${name}`);
  if (Number(tree.file_count) > Number(tree.entry_count) || Number(tree.file_count) < 1 || Number(tree.entry_count) < 1 || Number(tree.total_bytes) < 1)
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree_manifest:counts");
  const vivado = exact2(attestation.vivado, ["binary_relative_path", "version", "sw_build", "ip_build", "version_probe_stdout_sha256", "part_catalog_sha256", "target_part", "part_present", "part_probe_stdout_sha256", "license", "minimal_synth"], "vivado");
  portableRelativePath(vivado.binary_relative_path, "vivado:binary_relative_path");
  if (vivado.version !== "2021.1" || vivado.sw_build !== "3247384" || vivado.ip_build !== "3246043" || vivado.target_part !== EXPECTED_PART || vivado.part_present !== true)
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:vivado:facts");
  for (const name of ["version_probe_stdout_sha256", "part_catalog_sha256", "part_probe_stdout_sha256"])
    hash2(vivado[name], `vivado:${name}`);
  const license = exact2(vivado.license, ["status", "stdout_sha256", "exit_code"], "vivado:license");
  if (license.status !== "passed" || license.exit_code !== 0)
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:vivado:license");
  hash2(license.stdout_sha256, "vivado:license:stdout_sha256");
  const synth = exact2(vivado.minimal_synth, ["status", "input_sha256", "stdout_sha256", "exit_code"], "vivado:minimal_synth");
  if (synth.status !== "passed" || synth.exit_code !== 0)
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:vivado:minimal_synth");
  hash2(synth.input_sha256, "vivado:minimal_synth:input_sha256");
  hash2(synth.stdout_sha256, "vivado:minimal_synth:stdout_sha256");
  const profile = exact2(attestation.toolchain_profile, ["capability_map_version", "semantic_profile_sha256", "derived_sha256"], "toolchain_profile");
  text(profile.capability_map_version, "toolchain_profile:capability_map_version", 128);
  hash2(profile.semantic_profile_sha256, "toolchain_profile:semantic_profile_sha256");
  const derived = hash2(profile.derived_sha256, "toolchain_profile:derived_sha256");
  const typedBody = { ...attestation };
  delete typedBody.canonical_attestation_sha256;
  if (deriveVivadoToolchainProfileHash(typedBody) !== derived) {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:toolchain_profile:derived_sha256");
  }
  const canonicalHash = hash2(attestation.canonical_attestation_sha256, "canonical_attestation_sha256");
  if (canonicalEvolutionEvalHash(typedBody) !== canonicalHash)
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:canonical_attestation_sha256");
  if (options.expectedRawSha256 !== undefined) {
    const expected = hash2(options.expectedRawSha256, "raw_sha256");
    if (!options.rawBytes || createHash6("sha256").update(options.rawBytes).digest("hex") !== expected) {
      throw new Error("TOOLCHAIN_ATTESTATION_INVALID:raw_sha256");
    }
  }
  return structuredClone(value);
}
async function loadVivadoToolchainAttestation(path, expectedRawSha256, now = new Date) {
  const bytes = await readFile4(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:json");
  }
  return {
    attestation: validateVivadoToolchainAttestation(value, { now, expectedRawSha256, rawBytes: bytes }),
    rawSha256: createHash6("sha256").update(bytes).digest("hex")
  };
}
function finalizeVivadoToolchainAttestation(value, now = new Date) {
  const draft = structuredClone(record2(value, "root"));
  if (draft.attachment?.volume && typeof draft.attachment.volume === "object") {
    draft.attachment.volume.identity_canonical_sha256 = canonicalEvolutionEvalHash({
      guid: draft.attachment.volume.guid,
      serial_number: draft.attachment.volume.serial_number,
      file_system: draft.attachment.volume.file_system,
      mount_path: draft.attachment.volume.mount_path
    });
  }
  if (draft.toolchain_profile && typeof draft.toolchain_profile === "object") {
    draft.toolchain_profile.derived_sha256 = deriveVivadoToolchainProfileHash(draft);
  }
  const body = { ...draft };
  delete body.canonical_attestation_sha256;
  draft.canonical_attestation_sha256 = canonicalEvolutionEvalHash(body);
  return validateVivadoToolchainAttestation(draft, { now });
}

// connector/server.ts
var HASH_PATTERN2 = /^[0-9a-f]{64}$/;
var OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var execFileAsync = promisify(execFile);
var failedBackingLocks = new WeakSet;
function boundedIdentity(value, maximum) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}
function required(value, name) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`CONFIG_INVALID:${name}`);
  return value;
}
function workerRequestBindingMatches(request, candidate, toolchainProfileHash, configured) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return false;
  const binding = candidate;
  const identityBinding = binding.jobId === request.jobId && binding.projectId === request.projectId && binding.operation === request.operation && binding.runClass === request.runClass;
  const inputBinding = request.runClass === "formal" ? binding.inputHash === request.input : binding.inputHash === undefined || binding.inputHash === request.input;
  const toolchainBinding = request.runClass !== "formal" || binding.toolchainHash === toolchainProfileHash;
  const nested = binding.toolchain === undefined ? undefined : binding.toolchain && typeof binding.toolchain === "object" && !Array.isArray(binding.toolchain) ? binding.toolchain : null;
  if (nested === null)
    return false;
  const profileBinding = nested?.profileHash === undefined || nested.profileHash === toolchainProfileHash;
  const configuredBinding = configured === undefined || (nested?.vivadoBinary === undefined || nested.vivadoBinary === configured.vivadoBinary) && (nested?.part === undefined || nested.part === configured.part) && (binding.part === undefined || binding.part === configured.part);
  return identityBinding && inputBinding && toolchainBinding && profileBinding && configuredBinding;
}
function validateWorkerConfig(config) {
  for (const name of ["connector_id", "endpoint_url", "protocol_version", "transport_mode", "auth_mode", "workspace_root", "evidence_root", "server_certificate_path", "server_private_key_path", "trusted_client_ca_path", "vivado_binary", "vivado_part", "toolchain_profile_hash", "part_catalog_hash", "sdk_worker_build_hash"])
    required(config[name], name);
  if (config.protocol_version !== REMOTE_SCHEMA_VERSION || config.transport_mode !== "direct_https" || config.auth_mode !== "mtls")
    throw new Error("CONFIG_INVALID:protocol");
  if (!Number.isInteger(config.listen_port) || config.listen_port < 1 || config.listen_port > 65535)
    throw new Error("CONFIG_INVALID:listen_port");
  if (config.evolution_eval_enabled !== undefined && typeof config.evolution_eval_enabled !== "boolean") {
    throw new Error("CONFIG_INVALID:evolution_eval_enabled");
  }
  if (config.evolution_eval_enabled === true) {
    for (const name of ["evolution_eval_ledger_root", "evolution_eval_ledger_epoch", "evolution_eval_spool_root", "evolution_eval_log_root", "vivado_toolchain_attestation_path", "vivado_toolchain_attestation_sha256", "vivado_toolchain_lock_handoff_path"])
      required(config[name], name);
    if (!HASH_PATTERN2.test(config.vivado_toolchain_attestation_sha256))
      throw new Error("CONFIG_INVALID:vivado_toolchain_attestation_sha256");
    if (config.evolution_eval_ledger_mode !== "initialize" && config.evolution_eval_ledger_mode !== "reopen")
      throw new Error("CONFIG_INVALID:evolution_eval_ledger_mode");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.evolution_eval_ledger_epoch) || config.evolution_eval_ledger_epoch === "REPLACE_WITH_M4F_DEPLOYMENT_EPOCH") {
      throw new Error("CONFIG_INVALID:evolution_eval_ledger_epoch");
    }
    const roots = [config.workspace_root, config.evidence_root, config.evolution_eval_ledger_root, config.evolution_eval_spool_root, config.evolution_eval_log_root].map((value) => value.toLowerCase().replace(/[\\/]+$/, ""));
    const overlaps = roots.some((root, index) => roots.some((candidate, candidateIndex) => index !== candidateIndex && (root === candidate || root.startsWith(`${candidate}/`) || root.startsWith(`${candidate}\\`))));
    if (overlaps)
      throw new Error("CONFIG_INVALID:evolution_eval_roots");
  }
  return config;
}
async function readWorkerConfig(path) {
  const bytes = await readFile5(path);
  return {
    config: validateWorkerConfig(JSON.parse(bytes.toString("utf8"))),
    sha256: createHash7("sha256").update(bytes).digest("hex")
  };
}
async function loadWorkerConfig(path = process.env.SYNTHIA_WORKER_CONFIG ?? "D:/synthia-worker/config.json") {
  return (await readWorkerConfig(path)).config;
}
function assertToolchainAttestationMatchesConfig(config, attestation) {
  if (attestation.toolchain_profile.derived_sha256 !== config.toolchain_profile_hash)
    throw new Error("CONFIG_INVALID:toolchain_profile_hash");
  if (attestation.toolchain_profile.capability_map_version !== config.capability_map_version)
    throw new Error("CONFIG_INVALID:capability_map_version");
  if (attestation.vivado.part_catalog_sha256 !== config.part_catalog_hash)
    throw new Error("CONFIG_INVALID:part_catalog_hash");
  if (attestation.vivado.target_part !== config.vivado_part)
    throw new Error("CONFIG_INVALID:vivado_part");
  const mountedBinary = `${attestation.attachment.volume.mount_path.replace(/[\\/]+$/u, "")}\\${attestation.vivado.binary_relative_path.replaceAll("/", "\\")}`;
  const normalize = (value) => value.replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase();
  if (normalize(mountedBinary) !== normalize(config.vivado_binary))
    throw new Error("CONFIG_INVALID:vivado_binary");
}
async function assertLiveWindowsToolchainMapping(attestation) {
  if (process.platform !== "win32")
    return;
  const script = [
    "$ErrorActionPreference='Stop'",
    "$image=Get-DiskImage -ImagePath $args[0]",
    "if(-not $image.Attached-or -not ([IO.Path]::GetFullPath([string]$image.ImagePath)).Equals([IO.Path]::GetFullPath($args[0]),[StringComparison]::OrdinalIgnoreCase)){exit 11}",
    "$disk=$image|Get-Disk",
    "if(-not $disk.IsReadOnly-or [string]$disk.Number-cne$args[1]-or [string]$disk.UniqueId-cne$args[2]){exit 12}",
    "$part=Get-Partition -DiskNumber $disk.Number -PartitionNumber ([int]$args[3])",
    "if([string]$part.Guid-cne$args[4]){exit 13}",
    "$vol=$part|Get-Volume",
    "if([string]$vol.UniqueId-cne$args[5]-or [string]$vol.SerialNumber-cne$args[6]-or [string]$vol.FileSystem-cne'NTFS'-or [uint64]$vol.SizeRemaining-lt[uint64](10GB)){exit 14}",
    "$mount=$args[7].TrimEnd('\\')+'\\'",
    "$actualPaths=@($part.AccessPaths|%{$_.TrimEnd('\\')+'\\'}|Sort-Object -Unique)",
    "$expectedPaths=@($mount,([string]$args[5]).TrimEnd('\\')+'\\')|Sort-Object -Unique",
    "if(@(Compare-Object $actualPaths $expectedPaths).Count-ne 0){exit 15}",
    "$fileId=((& fsutil.exe file queryfileid $args[0] 2>$null)|Out-String)",
    "if($LASTEXITCODE-ne 0-or $fileId-notmatch$args[8]){exit 16}",
    "$backingRoot=[IO.Path]::GetPathRoot([IO.Path]::GetFullPath($args[0])).TrimEnd('\\')",
    `$backingVolume=Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='"+$backingRoot+"'")`,
    "if([string]$backingVolume.VolumeSerialNumber-cne$args[9]-or [uint64]$backingVolume.FreeSpace-lt([uint64]$args[13]+[uint64](20GB))){exit 17}",
    "$parent=[IO.Path]::GetFullPath((Split-Path -Parent $args[0]))",
    "if(-not $parent.Equals([IO.Path]::GetFullPath($args[10]),[StringComparison]::OrdinalIgnoreCase)){exit 18}",
    "$acl=Get-Acl -LiteralPath $parent",
    "$owner=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value",
    "$sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)",
    "$sha=[Security.Cryptography.SHA256]::Create()",
    "$aclHash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sddl)))).Replace('-','').ToLowerInvariant()",
    "if(-not $acl.AreAccessRulesProtected-or $owner-cne$args[11]-or $aclHash-cne$args[12]){exit 19}"
  ].join(";");
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
      attestation.vhdx.path,
      String(attestation.attachment.disk.number),
      attestation.attachment.disk.unique_id,
      String(attestation.attachment.partition.number),
      attestation.attachment.partition.guid,
      attestation.attachment.volume.guid,
      attestation.attachment.volume.serial_number,
      attestation.attachment.volume.mount_path,
      attestation.vhdx.file_identity.file_id,
      attestation.vhdx.file_identity.volume_serial_number,
      attestation.vhdx.backing_parent.path,
      attestation.vhdx.backing_parent.owner_sid,
      attestation.vhdx.backing_parent.acl_sha256,
      String(attestation.full_tree_manifest.total_bytes)
    ], { windowsHide: true, timeout: 30000 });
  } catch {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:live_mapping");
  }
}
async function holdProtectedVhdxBacking(attestation) {
  if (process.platform !== "win32")
    return;
  const script = [
    "$ErrorActionPreference='Stop'",
    "$stream=[IO.File]::Open($args[0],[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)",
    "$sha=[Security.Cryptography.SHA256]::Create()",
    "$digest=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()",
    "$length=$stream.Length",
    "$identity=((& fsutil.exe file queryfileid $args[0] 2>$null)|Out-String)",
    "if($LASTEXITCODE-ne 0){exit 18}",
    "[Console]::Out.WriteLine(('LOCKED|{0}|{1}|{2}'-f$digest,$length,($identity-replace'[\\r\\n]+',' ')))",
    "[Console]::Out.Flush()",
    "while($true){$line=[Console]::In.ReadLine();if($null-eq$line-or$line-eq'STOP'){break};Start-Sleep -Milliseconds 100}",
    "$stream.Dispose()"
  ].join(";");
  const child = spawn2("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, attestation.vhdx.path], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.once("error", () => failedBackingLocks.add(child));
  child.once("exit", () => failedBackingLocks.add(child));
  child.once("close", () => failedBackingLocks.add(child));
  const line = await new Promise((resolve4, reject2) => {
    let output = "";
    const timeout = setTimeout(() => reject2(new Error("TOOLCHAIN_ATTESTATION_INVALID:backing_lock_timeout")), 120000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const newline = output.indexOf(`
`);
      if (newline >= 0) {
        clearTimeout(timeout);
        resolve4(output.slice(0, newline).trim());
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject2(error);
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject2(new Error("TOOLCHAIN_ATTESTATION_INVALID:backing_lock"));
    });
  });
  const [marker, digest, size, identity] = line.split("|", 4);
  if (marker !== "LOCKED" || digest !== attestation.vhdx.sha256 || Number(size) !== attestation.vhdx.size_bytes || !identity?.includes(attestation.vhdx.file_identity.file_id)) {
    child.kill();
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:backing_lock_identity");
  }
  child.unref();
  child.stdin?.unref?.();
  child.stdout?.destroy();
  child.stderr?.destroy();
  return child;
}
async function acknowledgeToolchainLockHandoff(config, attestation, workerProcessInstanceId) {
  if (process.platform !== "win32")
    return;
  const path = required(config.vivado_toolchain_lock_handoff_path, "vivado_toolchain_lock_handoff_path");
  let request;
  try {
    request = JSON.parse(await readFile5(path, "utf8"));
  } catch {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:lock_handoff");
  }
  const keys = Object.keys(request).sort().join(",");
  if (keys !== "file_id,nonce,pipe_name,schema,supervisor_pid,supervisor_start_token,vivado_toolchain_attestation_sha256,volume_serial_number" || request.schema !== "synthia-vivado-toolchain-lock-handoff.v1" || request.vivado_toolchain_attestation_sha256 !== config.vivado_toolchain_attestation_sha256 || request.volume_serial_number !== attestation.vhdx.file_identity.volume_serial_number || request.file_id !== attestation.vhdx.file_identity.file_id || typeof request.pipe_name !== "string" || !OPAQUE_ID_PATTERN.test(request.pipe_name) || !Number.isSafeInteger(request.supervisor_pid) || Number(request.supervisor_pid) < 1 || typeof request.supervisor_start_token !== "string" || !HASH_PATTERN2.test(request.supervisor_start_token) || typeof request.nonce !== "string" || !OPAQUE_ID_PATTERN.test(request.nonce)) {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:lock_handoff");
  }
  const ackPath = `${path}.ack.json`;
  const ack = {
    schema: "synthia-vivado-toolchain-lock-handoff-ack.v1",
    nonce: request.nonce,
    worker_process_instance_id: workerProcessInstanceId,
    vivado_toolchain_attestation_sha256: config.vivado_toolchain_attestation_sha256
  };
  const handle = await open3(ackPath, "r+");
  try {
    await handle.truncate(0);
    await handle.writeFile(`${JSON.stringify(ack)}
`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function pingToolchainCeremonyLock(config, attestation) {
  if (process.platform !== "win32")
    return;
  const path = required(config.vivado_toolchain_lock_handoff_path, "vivado_toolchain_lock_handoff_path");
  let request;
  try {
    request = JSON.parse(await readFile5(path, "utf8"));
  } catch {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:lock_handoff");
  }
  if (Object.keys(request).sort().join(",") !== "file_id,nonce,pipe_name,schema,supervisor_pid,supervisor_start_token,vivado_toolchain_attestation_sha256,volume_serial_number" || request.schema !== "synthia-vivado-toolchain-lock-handoff.v1" || request.vivado_toolchain_attestation_sha256 !== config.vivado_toolchain_attestation_sha256 || request.volume_serial_number !== attestation.vhdx.file_identity.volume_serial_number || request.file_id !== attestation.vhdx.file_identity.file_id || typeof request.pipe_name !== "string" || !OPAQUE_ID_PATTERN.test(request.pipe_name) || !Number.isSafeInteger(request.supervisor_pid) || Number(request.supervisor_pid) < 1 || typeof request.supervisor_start_token !== "string" || !HASH_PATTERN2.test(request.supervisor_start_token) || typeof request.nonce !== "string" || !OPAQUE_ID_PATTERN.test(request.nonce)) {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:lock_handoff");
  }
  const response = await new Promise((resolve4, reject2) => {
    const socket = createConnection(`\\\\.\\pipe\\${request.pipe_name}`);
    let output = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject2(new Error("TOOLCHAIN_ATTESTATION_INVALID:lock_helper_timeout"));
    }, 1e4);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`PING|${request.nonce}
`));
    socket.on("data", (chunk) => {
      output += chunk;
      const newline = output.indexOf(`
`);
      if (newline >= 0) {
        clearTimeout(timeout);
        socket.end();
        resolve4(output.slice(0, newline).trim());
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject2(error);
    });
  });
  const expected = [
    "HEALTHY",
    request.nonce,
    request.vivado_toolchain_attestation_sha256,
    attestation.vhdx.sha256,
    String(attestation.vhdx.size_bytes),
    attestation.vhdx.file_identity.volume_serial_number,
    attestation.vhdx.file_identity.file_id,
    String(request.supervisor_pid),
    request.supervisor_start_token
  ].join("|");
  if (response !== expected)
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:lock_helper_identity");
}
async function verifyVivadoToolchainAttestationFromConfig(configPath) {
  const loaded = await loadExecutionConfig(configPath, true);
  if (loaded.config.evolution_eval_enabled !== true || !loaded.toolchain) {
    throw new Error("CONFIG_INVALID:vivado_toolchain_attestation_required");
  }
  await pingToolchainCeremonyLock(loaded.config, loaded.toolchain.attestation);
  await assertLiveWindowsToolchainMapping(loaded.toolchain.attestation);
  return loaded.toolchain.rawSha256;
}
async function loadExecutionConfig(path, verifyToolchain = false) {
  const loaded = await readWorkerConfig(path);
  if (loaded.config.evolution_eval_enabled === true) {
    const expected = process.env.SYNTHIA_WORKER_CONFIG_SHA256;
    if (!expected || !HASH_PATTERN2.test(expected) || expected !== loaded.sha256) {
      throw new Error("CONFIG_INVALID:active_config_sha256");
    }
    if (verifyToolchain) {
      const toolchain = await loadVivadoToolchainAttestation(required(loaded.config.vivado_toolchain_attestation_path, "vivado_toolchain_attestation_path"), required(loaded.config.vivado_toolchain_attestation_sha256, "vivado_toolchain_attestation_sha256"));
      assertToolchainAttestationMatchesConfig(loaded.config, toolchain.attestation);
      return { ...loaded, toolchain };
    }
  }
  return loaded;
}
function assertEvolutionLedgerReady(ledger) {
  const error = ledger.initializationError;
  if (error !== undefined)
    throw new Error(`CONFIG_INVALID:evolution_eval_ledger:${error}`);
}
async function openEvolutionEvalLedger(config) {
  const ledgerOptions = {
    root: required(config.evolution_eval_ledger_root, "evolution_eval_ledger_root"),
    ledgerEpoch: required(config.evolution_eval_ledger_epoch, "evolution_eval_ledger_epoch")
  };
  const ledger = config.evolution_eval_ledger_mode === "initialize" ? await FileEvolutionEvalLedger.initialize(ledgerOptions) : await FileEvolutionEvalLedger.reopen(ledgerOptions);
  assertEvolutionLedgerReady(ledger);
  return ledger;
}
async function verifyConfiguredBundleIdentity(config, bundlePath) {
  const digest = createHash7("sha256").update(await readFile5(bundlePath)).digest("hex");
  if (config.sdk_worker_build_hash !== digest)
    throw new Error("CONFIG_INVALID:sdk_worker_build_hash");
  return digest;
}
async function initializeEvolutionEvalLedgerFromConfig(configPath) {
  const { config } = await loadExecutionConfig(configPath);
  if (config.evolution_eval_enabled !== true || config.evolution_eval_ledger_mode !== "initialize") {
    throw new Error("CONFIG_INVALID:evolution_eval_initialize_ceremony");
  }
  await verifyConfiguredBundleIdentity(config, process.argv[1] ?? "");
  await openEvolutionEvalLedger(config);
  return required(config.evolution_eval_ledger_epoch, "evolution_eval_ledger_epoch");
}
async function verifyEvolutionEvalLedgerFromConfig(configPath) {
  const { config } = await loadExecutionConfig(configPath);
  if (config.evolution_eval_enabled !== true || config.evolution_eval_ledger_mode !== "reopen") {
    throw new Error("CONFIG_INVALID:evolution_eval_reopen_ceremony");
  }
  await verifyConfiguredBundleIdentity(config, process.argv[1] ?? "");
  await openEvolutionEvalLedger(config);
  return required(config.evolution_eval_ledger_epoch, "evolution_eval_ledger_epoch");
}
async function verifyWorkerReleaseManifest(path) {
  const value = JSON.parse(await readFile5(path, "utf8"));
  const plain2 = (candidate) => candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
  const exact3 = (candidate, expected) => plain2(candidate) && Object.keys(candidate).sort().length === expected.length && Object.keys(candidate).sort().every((key, index) => key === [...expected].sort()[index]);
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "bundle",
    "expected",
    "git_commit",
    "git_status_sha256",
    "manifest_hash",
    "release_files",
    "runtime",
    "schema",
    "source_state",
    "sources"
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("RELEASE_MANIFEST_INVALID:shape");
  }
  if (value.schema !== "synthia-worker-release-manifest.v1" || typeof value.git_commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.git_commit) || value.source_state !== "clean" && value.source_state !== "dirty" || typeof value.git_status_sha256 !== "string" || !HASH_PATTERN2.test(value.git_status_sha256) || value.source_state === "clean" && value.git_status_sha256 !== createHash7("sha256").update("").digest("hex") || value.source_state === "dirty" && value.git_status_sha256 === createHash7("sha256").update("").digest("hex") || !exact3(value.bundle, ["path", "size_bytes", "sha256"]) || value.bundle.path !== "server.bundle.mjs" || !Number.isSafeInteger(value.bundle.size_bytes) || Number(value.bundle.size_bytes) < 1 || typeof value.bundle.sha256 !== "string" || !HASH_PATTERN2.test(value.bundle.sha256) || !exact3(value.runtime, ["kind", "version", "executable_name", "sha256"]) || value.runtime.kind !== "bun" || value.runtime.version !== "1.3.14" || value.runtime.executable_name !== "bun.exe" || typeof value.runtime.sha256 !== "string" || !HASH_PATTERN2.test(value.runtime.sha256) || !exact3(value.release_files, ["config_template_sha256", "launcher_sha256", "windows_certifier_sha256"]) || Object.values(value.release_files).some((hash3) => typeof hash3 !== "string" || !HASH_PATTERN2.test(hash3))) {
    throw new Error("RELEASE_MANIFEST_INVALID:shape");
  }
  if (!Array.isArray(value.sources) || value.sources.length < 1)
    throw new Error("RELEASE_MANIFEST_INVALID:sources");
  const sourcePaths = [];
  for (const source of value.sources) {
    if (!exact3(source, ["path", "sha256"]) || !boundedIdentity(source.path, 512) || source.path.startsWith("/") || source.path.includes("\\") || !/^[\x20-\x7e]+$/.test(source.path) || source.path.split("/").some((segment) => !segment || segment === "." || segment === "..") || typeof source.sha256 !== "string" || !HASH_PATTERN2.test(source.sha256)) {
      throw new Error("RELEASE_MANIFEST_INVALID:sources");
    }
    sourcePaths.push(source.path);
  }
  if (sourcePaths.some((source, index) => index > 0 && sourcePaths[index - 1] >= source)) {
    throw new Error("RELEASE_MANIFEST_INVALID:sources");
  }
  if (!exact3(value.expected, [
    "capabilities",
    "capability_map_version",
    "part",
    "part_catalog_hash",
    "protocol_version",
    "sdk_worker_build_hash",
    "toolchain_profile_hash",
    "vivado_patch",
    "vivado_version"
  ]) || value.expected.protocol_version !== "connector.remote.v1" || value.expected.sdk_worker_build_hash !== value.bundle.sha256 || !boundedIdentity(value.expected.capability_map_version, 128) || typeof value.expected.part_catalog_hash !== "string" || !HASH_PATTERN2.test(value.expected.part_catalog_hash) || typeof value.expected.toolchain_profile_hash !== "string" || !HASH_PATTERN2.test(value.expected.toolchain_profile_hash) || !boundedIdentity(value.expected.vivado_version, 64) || !boundedIdentity(value.expected.vivado_patch, 64) || !boundedIdentity(value.expected.part, 128) || !Array.isArray(value.expected.capabilities) || value.expected.capabilities.length === 0) {
    throw new Error("RELEASE_MANIFEST_INVALID:expected");
  }
  let previousOperation = "";
  for (const capability of value.expected.capabilities) {
    const runClasses = capability && typeof capability === "object" && "run_classes" in capability && Array.isArray(capability.run_classes) ? capability.run_classes : undefined;
    if (!exact3(capability, ["operation", "run_classes", "version"]) || typeof capability.operation !== "string" || !OPAQUE_ID_PATTERN.test(capability.operation) || capability.operation <= previousOperation || typeof capability.version !== "string" || !OPAQUE_ID_PATTERN.test(capability.version) || !runClasses || runClasses.length === 0 || runClasses.some((runClass, index) => typeof runClass !== "string" || !OPAQUE_ID_PATTERN.test(runClass) || index > 0 && typeof runClasses[index - 1] === "string" && runClasses[index - 1] >= runClass)) {
      throw new Error("RELEASE_MANIFEST_INVALID:capabilities");
    }
    previousOperation = capability.operation;
  }
  const manifestHash = value.manifest_hash;
  if (typeof manifestHash !== "string" || !HASH_PATTERN2.test(manifestHash)) {
    throw new Error("RELEASE_MANIFEST_INVALID:manifest_hash");
  }
  const body = { ...value };
  delete body.manifest_hash;
  if (canonicalEvolutionEvalHash(body) !== manifestHash) {
    throw new Error("RELEASE_MANIFEST_INVALID:canonical_hash");
  }
  return manifestHash;
}
async function assertCurrentVivadoToolchain(config, backingLock) {
  if (process.platform === "win32" && (!backingLock || failedBackingLocks.has(backingLock) || backingLock.killed || backingLock.exitCode !== null || backingLock.signalCode !== null)) {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:backing_lock");
  }
  const live = await loadVivadoToolchainAttestation(required(config.vivado_toolchain_attestation_path, "vivado_toolchain_attestation_path"), required(config.vivado_toolchain_attestation_sha256, "vivado_toolchain_attestation_sha256"));
  assertToolchainAttestationMatchesConfig(config, live.attestation);
  await pingToolchainCeremonyLock(config, live.attestation);
  await assertLiveWindowsToolchainMapping(live.attestation);
  return live;
}
function execution(config, identity) {
  const adapter = new VivadoBatchAdapter({ workspaceRoot: config.workspace_root, binary: config.vivado_binary, part: config.vivado_part, profileHash: config.toolchain_profile_hash });
  return {
    async discover() {
      let liveToolchain = identity.toolchain;
      if (config.evolution_eval_enabled === true) {
        try {
          liveToolchain = await assertCurrentVivadoToolchain(config, identity.backingLock);
        } catch {
          return { connector_id: config.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: config.capability_map_version, vivado_version: "unavailable", vivado_patch: "unavailable", part_catalog_hash: config.part_catalog_hash, sdk_worker_build_hash: config.sdk_worker_build_hash, active_config_sha256: identity.activeConfigSha256, worker_process_instance_id: identity.workerProcessInstanceId, vivado_toolchain_attestation_sha256: config.vivado_toolchain_attestation_sha256, live_mapping_health: "unavailable", capabilities: [], toolchain_profile_hash: config.toolchain_profile_hash, license_status: "unavailable", unsupported: ["vivado_toolchain_attestation"] };
        }
      }
      const remoteAttestation = {
        active_config_sha256: identity.activeConfigSha256,
        worker_process_instance_id: identity.workerProcessInstanceId,
        ...liveToolchain ? { vivado_toolchain_attestation_sha256: liveToolchain.rawSha256, live_mapping_health: "healthy" } : {}
      };
      try {
        await access2(config.vivado_binary, constants2.X_OK);
      } catch {
        return { connector_id: config.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: config.capability_map_version, vivado_version: "unavailable", vivado_patch: "unavailable", part_catalog_hash: config.part_catalog_hash, sdk_worker_build_hash: config.sdk_worker_build_hash, ...remoteAttestation, capabilities: [], toolchain_profile_hash: config.toolchain_profile_hash, license_status: "unavailable", unsupported: ["vivado_binary"] };
      }
      if (config.evolution_eval_enabled === true && !liveToolchain) {
        return { connector_id: config.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: config.capability_map_version, vivado_version: "unavailable", vivado_patch: "unavailable", part_catalog_hash: config.part_catalog_hash, sdk_worker_build_hash: config.sdk_worker_build_hash, ...remoteAttestation, capabilities: [], toolchain_profile_hash: config.toolchain_profile_hash, license_status: "unavailable", unsupported: ["vivado_toolchain_attestation"] };
      }
      const facts = liveToolchain?.attestation.vivado;
      return { connector_id: config.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: config.capability_map_version, vivado_version: facts?.version ?? "2021.1", vivado_patch: facts?.sw_build ?? "3247384", part_catalog_hash: facts?.part_catalog_sha256 ?? config.part_catalog_hash, sdk_worker_build_hash: config.sdk_worker_build_hash, ...remoteAttestation, capabilities: VIVADO_CAPABILITIES, toolchain_profile_hash: liveToolchain?.attestation.toolchain_profile.derived_sha256 ?? config.toolchain_profile_hash, license_status: facts?.license.status === "passed" || !liveToolchain ? "available" : "unavailable" };
    },
    async execute(request, _workspace) {
      const candidate = request.parameters;
      if (!candidate || typeof candidate !== "object")
        return { outcome: "failure", error_code: "VIVADO_PARAMETERS_REQUIRED", output: JSON.stringify({ status: "rejected", errorCode: "VIVADO_PARAMETERS_REQUIRED" }), evidence: { jobId: request.jobId ?? "worker", entries: [] } };
      if (!workerRequestBindingMatches(request, candidate, config.toolchain_profile_hash, { vivadoBinary: config.vivado_binary, part: config.vivado_part })) {
        const jobId = request.jobId ?? "worker";
        return { outcome: "failure", error_code: "FORMAL_BINDING_MISMATCH", output: JSON.stringify({ status: "rejected", jobId, errorCode: "FORMAL_BINDING_MISMATCH" }), evidence: { jobId, entries: [] } };
      }
      const vivadoRequest = {
        ...candidate,
        toolchain: {
          requiredLicense: candidate.toolchain?.requiredLicense,
          vivadoBinary: config.vivado_binary,
          part: config.vivado_part,
          profileHash: config.toolchain_profile_hash
        }
      };
      let result;
      try {
        result = await adapter.execute(vivadoRequest);
      } catch (error) {
        const message = error instanceof Error ? error.message : "VIVADO_EXECUTION_ERROR";
        const errorCode2 = message.startsWith("VIVADO_POLICY_REJECTED:") ? message : "VIVADO_EXECUTION_ERROR";
        const jobId = request.jobId ?? "worker";
        return { outcome: "failure", error_code: errorCode2, output: JSON.stringify({ status: "rejected", jobId, errorCode: errorCode2 }), evidence: { jobId, entries: [] } };
      }
      const outcome = result.status === "succeeded" ? "success" : result.status === "timeout" ? "timeout" : result.status === "lost" ? "lost" : result.status === "unknown_effect" ? "unknown_effect" : "failure";
      const meta = { jobId: result.jobId, operation: result.operation, status: result.status, command: result.command, inputSha256: result.inputSha256, workspace: result.workspace, toolchain: result.toolchain };
      if (result.exitCode !== undefined)
        meta.exitCode = result.exitCode;
      if (result.phase !== undefined)
        meta.phase = result.phase;
      if (result.phaseExitCode !== undefined)
        meta.phaseExitCode = result.phaseExitCode;
      if (result.simulatorStdout !== undefined)
        meta.simulatorStdout = result.simulatorStdout;
      if (result.stdout !== undefined)
        meta.stdout = result.stdout;
      if (result.stderr !== undefined)
        meta.stderr = result.stderr;
      if (result.errorCode !== undefined)
        meta.errorCode = result.errorCode;
      if (result.timeoutMs !== undefined)
        meta.timeoutMs = result.timeoutMs;
      if (result.timedOut !== undefined)
        meta.timedOut = result.timedOut;
      if (result.signal !== undefined)
        meta.signal = result.signal;
      if (result.unsupportedReason !== undefined)
        meta.unsupportedReason = result.unsupportedReason;
      if (result.output && typeof result.output === "object") {
        const o = result.output;
        if (o.stdout !== undefined)
          meta.output = o;
      }
      const errorCode = result.errorCode ?? (result.status === "unsupported" ? result.unsupportedReason ?? "VIVADO_UNSUPPORTED" : undefined);
      return { outcome, error_code: errorCode, output: JSON.stringify(meta, null, 2), evidence: result.evidence, stdout: result.stdout, stderr: result.stderr };
    }
  };
}
async function startWorker(configPath) {
  const resolvedConfigPath = configPath ?? process.env.SYNTHIA_WORKER_CONFIG ?? "D:/synthia-worker/config.json";
  const loaded = await loadExecutionConfig(resolvedConfigPath, true);
  const config = loaded.config;
  const workerProcessInstanceId = randomUUID2();
  if (config.evolution_eval_enabled === true || process.env.SYNTHIA_WORKER_VERIFY_BUNDLE === "1") {
    await verifyConfiguredBundleIdentity(config, process.argv[1] ?? "");
  }
  const privateKey = config.server_private_key_path.toLowerCase().endsWith(".pfx") || config.server_private_key_path.toLowerCase().endsWith(".p12");
  const tls = privateKey ? { pfx: await readFile5(config.server_private_key_path), passphrase: required(process.env.SYNTHIA_WORKER_PFX_PASSWORD, "SYNTHIA_WORKER_PFX_PASSWORD"), ca: await readFile5(config.trusted_client_ca_path), requestCert: true, rejectUnauthorized: true } : { cert: await readFile5(config.server_certificate_path), key: await readFile5(config.server_private_key_path), ca: await readFile5(config.trusted_client_ca_path), requestCert: true, rejectUnauthorized: true };
  let backingLock;
  let evolutionEval;
  if (config.evolution_eval_enabled === true) {
    if (config.evolution_eval_ledger_mode !== "reopen") {
      throw new Error("CONFIG_INVALID:evolution_eval_initialize_requires_admin");
    }
    const ledger = await openEvolutionEvalLedger(config);
    const adapter = new VivadoBatchAdapter({
      workspaceRoot: required(config.evolution_eval_spool_root, "evolution_eval_spool_root"),
      binary: config.vivado_binary,
      part: config.vivado_part,
      profileHash: config.toolchain_profile_hash
    });
    evolutionEval = {
      ledger,
      spoolRoot: required(config.evolution_eval_spool_root, "evolution_eval_spool_root"),
      toolchainProfileHash: config.toolchain_profile_hash,
      assertNewEffectReady: async () => {
        await assertCurrentVivadoToolchain(config, backingLock);
      },
      execution: {
        async prepare({ workspace }) {
          let launchGate;
          const guardian = await createVivadoProcessGuardian(workspace, undefined, undefined, undefined, () => launchGate?.() ?? false);
          return {
            identity: guardian.identity,
            async execute({ binding, sealedInput, timeoutMs, signal, onBeforeLaunch }) {
              try {
                launchGate = onBeforeLaunch;
                const files = new Map(sealedInput.files.map((file) => [file.path, file]));
                const parameters = binding.dispatch.parameters;
                const sources = parameters.source_paths.map((path) => {
                  const file = files.get(path);
                  if (!file)
                    throw new Error("EVOLUTION_EVAL_BINDING_CONFLICT");
                  return { path, content: file.content, mediaType: file.media_type };
                });
                const common2 = {
                  schema: "evolution-eval-vivado-request.v1",
                  evalJobId: binding.dispatch.eval_job_id,
                  jobId: binding.dispatch.connector_job_id,
                  projectId: binding.project_id,
                  runClass: "evolution_eval",
                  dispatchRequestHash: binding.dispatch_request_hash,
                  workspaceManifestHash: binding.dispatch.workspace_manifest_hash,
                  sealedInputProjectionHash: binding.dispatch.sealed_input_projection_hash,
                  toolchainProfileHash: binding.dispatch.toolchain_profile_hash,
                  deadlineAt: binding.dispatch.deadline_at,
                  timeoutMs
                };
                const request = parameters.operation === "validate_sources" ? { ...common2, operation: parameters.operation, sources, top: parameters.top } : parameters.operation === "simulate" ? { ...common2, operation: parameters.operation, sources, top: parameters.top, testbench: parameters.testbench } : parameters.operation === "synthesize" ? { ...common2, operation: parameters.operation, sources, top: parameters.top, part: parameters.part } : {
                  ...common2,
                  operation: parameters.operation,
                  sources,
                  top: parameters.top,
                  part: parameters.part,
                  generateTrialBitstream: parameters.generate_trial_bitstream,
                  constraints: parameters.constraint_paths.map((path) => {
                    const file = files.get(path);
                    if (!file)
                      throw new Error("EVOLUTION_EVAL_BINDING_CONFLICT");
                    return { path, content: file.content, mediaType: file.media_type };
                  })
                };
                const result = await adapter.executeEvolutionEval(request, signal, undefined, workspace, guardian.run);
                for (const entry of result.evidence.entries) {
                  const handle = await open3(join5(result.workspace, "output", entry.name), "r+");
                  try {
                    await handle.sync();
                  } finally {
                    await handle.close();
                  }
                }
                if (process.platform === "win32") {
                  if (!(await stat3(join5(result.workspace, "output"))).isDirectory())
                    throw new Error("EVOLUTION_EVAL_OUTPUT_UNAVAILABLE");
                } else {
                  const outputDirectory = await open3(join5(result.workspace, "output"), "r");
                  try {
                    await outputDirectory.sync();
                  } finally {
                    await outputDirectory.close();
                  }
                }
                return {
                  terminalState: result.status === "succeeded" ? "succeeded" : result.status === "timeout" ? "timeout" : "failed",
                  errorCode: result.status === "timeout" ? "EVOLUTION_EVAL_DEADLINE_EXCEEDED" : result.errorCode ?? (result.status === "unsupported" ? `VIVADO_${result.unsupportedReason}` : null),
                  evidence: result.evidence
                };
              } finally {
                await guardian.close();
              }
            },
            close: () => guardian.close()
          };
        },
        async execute() {
          throw new Error("EVOLUTION_EVAL_PREPARED_EXECUTION_REQUIRED");
        }
      }
    };
  }
  backingLock = loaded.toolchain ? await holdProtectedVhdxBacking(loaded.toolchain.attestation) : undefined;
  try {
    if (loaded.toolchain) {
      await pingToolchainCeremonyLock(config, loaded.toolchain.attestation);
      await acknowledgeToolchainLockHandoff(config, loaded.toolchain.attestation, workerProcessInstanceId);
    }
  } catch (error) {
    backingLock?.kill();
    throw error;
  }
  const options = {
    endpoint: config,
    workspaceRoot: config.workspace_root,
    execution: execution(config, {
      activeConfigSha256: loaded.sha256,
      workerProcessInstanceId,
      toolchain: loaded.toolchain,
      backingLock
    }),
    evolutionEval
  };
  const runtime = new WorkerRuntime(options);
  const handler = runtime.handle.bind(runtime);
  const server = createServer(tls, async (req, res) => {
    const chunks = [];
    let received = 0;
    const evalRoute = (req.url ?? "").startsWith("/evolution-eval/");
    const declared = req.headers["content-length"];
    if (evalRoute && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > EVOLUTION_EVAL_HTTP_BODY_MAX_BYTES)) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error_code: "EVOLUTION_EVAL_RESOURCE_LIMIT" }));
      return;
    }
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      received += bytes.byteLength;
      if (evalRoute && received > EVOLUTION_EVAL_HTTP_BODY_MAX_BYTES) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error_code: "EVOLUTION_EVAL_RESOURCE_LIMIT" }));
        req.destroy();
        return;
      }
      chunks.push(bytes);
    }
    const request = new Request(`https://${req.headers.host ?? `${config.listen_host}:${config.listen_port}`}${req.url ?? "/"}`, { method: req.method, headers: Object.entries(req.headers).filter((entry) => typeof entry[1] === "string"), body: chunks.length ? Buffer.concat(chunks) : undefined });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  try {
    await new Promise((resolve4, reject2) => {
      server.once("error", reject2);
      server.listen(config.listen_port, config.listen_host, resolve4);
    });
  } catch (error) {
    backingLock?.kill();
    throw error;
  }
  return { server, config };
}
if (__require.main == __require.module) {
  const [command, configPath, outputPath] = process.argv.slice(2);
  const run = command === "--initialize-evolution-ledger" ? initializeEvolutionEvalLedgerFromConfig(configPath ?? process.env.SYNTHIA_WORKER_CONFIG ?? "").then((epoch) => console.log(`synthia-worker evolution ledger initialized epoch=${epoch}`)) : command === "--verify-evolution-ledger" ? verifyEvolutionEvalLedgerFromConfig(configPath ?? process.env.SYNTHIA_WORKER_CONFIG ?? "").then((epoch) => console.log(`synthia-worker evolution ledger verified epoch=${epoch}`)) : command === "--verify-release-manifest" ? verifyWorkerReleaseManifest(configPath ?? "").then((hash3) => console.log(`synthia-worker release manifest verified hash=${hash3}`)) : command === "--verify-vivado-toolchain-attestation" ? verifyVivadoToolchainAttestationFromConfig(configPath ?? process.env.SYNTHIA_WORKER_CONFIG ?? "").then((hash3) => console.log(`synthia-worker Vivado toolchain attestation verified raw_sha256=${hash3}`)) : command === "--verify-vivado-toolchain-attestation-file" ? loadVivadoToolchainAttestation(required(configPath, "toolchain_attestation_path"), required(outputPath, "toolchain_attestation_sha256")).then(({ attestation }) => console.log(`synthia-worker Vivado toolchain attestation verified canonical_sha256=${attestation.canonical_attestation_sha256}`)) : command === "--build-vivado-full-tree-manifest" ? buildFullTreeManifest(required(configPath, "full_tree_root")).then(async (manifest) => {
    await writeFile3(required(outputPath, "full_tree_output"), `${JSON.stringify(manifest)}
`, { flag: "wx", mode: 384 });
    console.log(`synthia-worker Vivado full-tree manifest built hash=${manifest.canonical_sha256}`);
  }) : command === "--finalize-vivado-toolchain-attestation" ? readFile5(required(configPath, "toolchain_attestation_draft"), "utf8").then((bytes) => finalizeVivadoToolchainAttestation(JSON.parse(bytes))).then(async (attestation) => {
    await writeFile3(required(outputPath, "toolchain_attestation_output"), `${JSON.stringify(attestation)}
`, { flag: "wx", mode: 384 });
    console.log(`synthia-worker Vivado toolchain attestation finalized canonical_sha256=${attestation.canonical_attestation_sha256}`);
  }) : command === undefined ? startWorker().then(({ config }) => console.log(`synthia-worker listening on ${config.listen_host}:${config.listen_port} connector=${config.connector_id}`)) : Promise.reject(new Error("CONFIG_INVALID:command"));
  run.catch((error) => {
    console.error(`synthia-worker failed: ${error instanceof Error ? error.message : "startup"}`);
    process.exitCode = 1;
  });
}
export {
  workerRequestBindingMatches,
  verifyWorkerReleaseManifest,
  verifyVivadoToolchainAttestationFromConfig,
  verifyEvolutionEvalLedgerFromConfig,
  verifyConfiguredBundleIdentity,
  startWorker,
  loadWorkerConfig,
  initializeEvolutionEvalLedgerFromConfig
};
