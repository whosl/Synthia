import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type BoundJumpPhaseResult,
  CeremonyFailure,
  invokeBoundJumpPhase,
  runCeremony,
} from "./m4f-bound-jump-transport.ts";

const SOURCE_PATH = resolve(import.meta.dir, "create-m4f-jump-bootstrap-root.ps1");
const EXPECTED_SOURCE_SHA256 = "56a20e05580b25022466187a58ecb5840134f11c0a78e5655e7ba5dd771799c5";

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  phase: string,
  evidence: Record<string, unknown>,
): void {
  if (Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) {
    throw new CeremonyFailure({
      schema: "synthia-m4f-jump-bootstrap-failure.v1",
      code: "M4F_JUMP_BOOTSTRAP_OUTPUT_INVALID",
      phase,
      ...evidence,
    });
  }
}

function isInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

export interface JumpBootstrapCeremonyResult {
  schema: "synthia-m4f-jump-bootstrap-ceremony.v1";
  status: "passed";
  parse: BoundJumpPhaseResult;
  execute: BoundJumpPhaseResult;
}

export function runJumpBootstrapCeremony(
  invoke: (phase: string, script: string) => BoundJumpPhaseResult = invokeBoundJumpPhase,
): JumpBootstrapCeremonyResult {
  const sourceBytes = readFileSync(SOURCE_PATH);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  if (sourceSha256 !== EXPECTED_SOURCE_SHA256) {
    throw new CeremonyFailure({ schema: "synthia-m4f-jump-bootstrap-failure.v1", code: "M4F_JUMP_BOOTSTRAP_SOURCE_HASH_MISMATCH" });
  }

  const sourceBase64 = sourceBytes.toString("base64");
  const parserHarness = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$sourceBytes = [Convert]::FromBase64String("${sourceBase64}")
$source = [Text.UTF8Encoding]::new($false, $true).GetString($sourceBytes)
$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput(
  $source,
  "create-m4f-jump-bootstrap-root.ps1",
  [ref]$tokens,
  [ref]$parseErrors
)
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $hashBytes = $sha256.ComputeHash($sourceBytes)
  $hash = [BitConverter]::ToString($hashBytes).Replace("-", "").ToLowerInvariant()
} finally { $sha256.Dispose() }
$valid = $null -ne $parseErrors -and $parseErrors.Count -eq 0 -and
  $null -ne $tokens -and $tokens.Count -gt 0
[Console]::Out.WriteLine(([ordered]@{
  schema = "synthia-m4f-powershell-parse.v1"
  status = if ($valid) { "passed" } else { "failed" }
  source_sha256 = $hash
  token_count = if ($null -eq $tokens) { 0 } else { [int]$tokens.Count }
  error_count = if ($null -eq $parseErrors) { -1 } else { [int]$parseErrors.Count }
} | ConvertTo-Json -Compress))
if (-not $valid) { throw "M4F_JUMP_BOOTSTRAP_REMOTE_PARSE_FAILED" }
`;
  const parsePhase = invoke("jump-bootstrap:parse", parserHarness);
  const parse = parsePhase.payload;
  exactKeys(
    parse,
    ["schema", "status", "source_sha256", "token_count", "error_count"],
    "parse",
    { parse: parsePhase },
  );
  if (parse.schema !== "synthia-m4f-powershell-parse.v1"
    || parse.status !== "passed"
    || parse.source_sha256 !== EXPECTED_SOURCE_SHA256
    || !isInteger(parse.token_count, 1)
    || parse.error_count !== 0) {
    throw new CeremonyFailure({
      schema: "synthia-m4f-jump-bootstrap-failure.v1",
      code: "M4F_JUMP_BOOTSTRAP_OUTPUT_INVALID",
      phase: "parse",
      parse: parsePhase,
    });
  }

  let executePhase: BoundJumpPhaseResult;
  try {
    executePhase = invoke("jump-bootstrap:execute", sourceBytes.toString("utf8"));
  } catch (error) {
    throw new CeremonyFailure({
      schema: "synthia-m4f-jump-bootstrap-failure.v1",
      code: "M4F_JUMP_BOOTSTRAP_EXECUTE_TRANSPORT_FAILED",
      phase: "execute",
      parse: parsePhase,
      execute_failure: error instanceof CeremonyFailure
        ? error.detail
        : { reason: String(error) },
    });
  }
  const execute = executePhase.payload;
  exactKeys(execute, [
    "alternate_streams",
    "bootstrap_root",
    "disk_number",
    "disk_unique_id",
    "empty",
    "explicit_ace_count",
    "logical_volume_serial",
    "owner_sid",
    "partition_number",
    "protected",
    "reparse",
    "schema",
    "status",
    "volume_serial_number",
    "volume_unique_id",
  ], "execute", { parse: parsePhase, execute: executePhase });
  if (execute.schema !== "synthia-m4f-jump-bootstrap-root.v1"
    || execute.status !== "passed"
    || execute.bootstrap_root !== "C:\\Windows\\Temp\\synthia-m4f-jump-bootstrap-20260827-03"
    || execute.owner_sid !== "S-1-5-32-544"
    || typeof execute.logical_volume_serial !== "string" || execute.logical_volume_serial.length === 0
    || typeof execute.volume_unique_id !== "string" || execute.volume_unique_id.length === 0
    || typeof execute.volume_serial_number !== "string" || execute.volume_serial_number.length === 0
    || execute.volume_serial_number !== execute.logical_volume_serial
    || !isInteger(execute.disk_number, 0)
    || !isInteger(execute.partition_number, 1)
    || typeof execute.disk_unique_id !== "string" || execute.disk_unique_id.length === 0
    || execute.protected !== true
    || execute.explicit_ace_count !== 2
    || execute.empty !== true
    || execute.reparse !== false
    || execute.alternate_streams !== false) {
    throw new CeremonyFailure({
      schema: "synthia-m4f-jump-bootstrap-failure.v1",
      code: "M4F_JUMP_BOOTSTRAP_OUTPUT_INVALID",
      phase: "execute",
      parse: parsePhase,
      execute: executePhase,
    });
  }

  return {
    schema: "synthia-m4f-jump-bootstrap-ceremony.v1",
    status: "passed",
    parse: parsePhase,
    execute: executePhase,
  };
}

if (import.meta.main) {
  runCeremony(() => {
    process.stdout.write(`${JSON.stringify(runJumpBootstrapCeremony())}\n`);
  });
}
