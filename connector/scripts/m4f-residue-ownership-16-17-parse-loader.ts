import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const HASH = /^[0-9a-f]{64}$/u;
const PARSE_COMMAND_LIMIT = 7_000;

export interface ResidueOwnershipParseCommand {
  compressed: Buffer;
  loader: string;
  command: string;
}

export function lintResidueOwnershipParseLoader(loader: string): void {
  const operators = "eq|ne|replace|and|or";
  if (new RegExp("[^\\s]-(?:" + operators + ")\\b", "iu").test(loader)
    || new RegExp("-(?:" + operators + ")[^\\s]", "iu").test(loader)
    || /[^\s]\||\|[^\s]/u.test(loader)
    || /[^\s]&|&[^\s]/u.test(loader)
    || /\b(?:if|else|foreach|while)\(/iu.test(loader)
    || loader.includes("&{") || loader.includes("ScriptBlock]::Create")
    || loader.includes(".Invoke(") || loader.includes("& $s")) {
    throw new Error("M4F_RESIDUE_PARSE_LOADER_TOKEN_BOUNDARY_INVALID");
  }
}

export function buildResidueOwnershipParseCommand(
  source: string,
  targetCommandSha256: string,
): ResidueOwnershipParseCommand {
  if (!HASH.test(targetCommandSha256)) throw new Error("M4F_RESIDUE_PARSE_TARGET_COMMAND_HASH_INVALID");
  const compressed = gzipSync(Buffer.from(source, "utf8"), { level: 9 });
  const payload = compressed.toString("base64");
  const loader = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';"
    + "$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('"
    + payload + "')),[IO.Compression.CompressionMode]0);"
    + "$s=[IO.StreamReader]::new($g).ReadToEnd();$t=$null;$e=$null;"
    + "$a=[Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e);"
    + "$h=([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash([Text.Encoding]::UTF8.GetBytes($s))) -replace '-','').ToLower();"
    + "$x=[ordered]@{schema='synthia-m4f-direct-residue-ownership-parse-result.v1';status=$(if ($e.Count) {'parse_rejected'} else {'parsed_not_invoked'});target_script_sha256=$h;target_script_length=[Text.Encoding]::UTF8.GetByteCount($s);target_command_sha256='"
    + targetCommandSha256 + "';parse_error_count=$e.Count;parser_ast_type=$a.GetType().FullName;parser_end_block_present=($null -ne $a.EndBlock);powershell_edition=$PSVersionTable.PSEdition;powershell_version=$PSVersionTable.PSVersion.ToString();target_body_not_invoked=$true;process_mutation_performed=$false;file_mutation_performed=$false;vivado_action_performed=$false;hardware_action_performed=$false;cleanup_performed=$false};"
    + "[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$x | ConvertTo-Json -Compress;if ($e.Count) {exit 2}";
  lintResidueOwnershipParseLoader(loader);
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"& { "
    + loader + " }\"";
  if (command.length > PARSE_COMMAND_LIMIT) throw new Error("M4F_RESIDUE_PARSE_COMMAND_TOO_LONG");
  return { compressed, loader, command };
}

export function parseCommandSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
