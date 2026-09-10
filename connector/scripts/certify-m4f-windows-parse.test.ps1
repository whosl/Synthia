[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CertifierPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$resolved = (Resolve-Path -LiteralPath $CertifierPath -ErrorAction Stop).Path
$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
  $resolved,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($null -eq $parseErrors) { throw "CERTIFIER_FULL_PARSE_ERRORS_UNAVAILABLE" }
if ($parseErrors.Count -ne 0) {
  $first = $parseErrors[0]
  throw ("CERTIFIER_FULL_PARSE_FAILED:{0}:{1}:{2}" -f $first.Extent.StartLineNumber, $first.Extent.StartColumnNumber, $first.Message)
}
if ($null -eq $tokens -or $tokens.Count -lt 1) { throw "CERTIFIER_FULL_PARSE_TOKENS_MISSING" }

[pscustomobject]@{
  schema = "synthia-m4f-certifier-full-parse-test.v1"
  status = "passed"
  parser = "System.Management.Automation.Language.Parser.ParseFile"
  token_count = [int]$tokens.Count
} | ConvertTo-Json -Compress
