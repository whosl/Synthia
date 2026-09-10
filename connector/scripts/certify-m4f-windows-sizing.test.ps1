[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CertifierPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$source = (Get-Content -LiteralPath $CertifierPath -Raw -Encoding UTF8).Replace("`r`n", "`n")
$functionStart = $source.IndexOf("function Fail")
$executionStart = $source.IndexOf("`nInitialize-AllowedWriterSids`nResolve-ReleaseFiles")
if ($functionStart -lt 0 -or $executionStart -le $functionStart) { throw "SIZING_TEST_CERTIFIER_LAYOUT_INVALID" }
Invoke-Expression $source.Substring($functionStart, $executionStart - $functionStart)

function Assert-Equal([uint64]$Actual, [uint64]$Expected, [string]$Name) {
  if ($Actual -ne $Expected) { throw ("SIZING_TEST_MISMATCH:{0}:{1}:{2}" -f $Name, $Actual, $Expected) }
}

function Expect-Failure([string]$Code, [scriptblock]$Action) {
  try { & $Action }
  catch {
    if ($_.Exception.Message -ceq $Code) { return }
    throw
  }
  throw "SIZING_TEST_EXPECTED_FAILURE:$Code"
}

$alignment = [uint64](1MB)
$reserve = [uint64](20GB)
$observedSource = [uint64]::Parse("80403135352")
$observedExpected = [uint64]::Parse("101878595584")
$observed = Get-ToolchainVirtualSize $observedSource
Assert-Equal $observed $observedExpected "observed_source"
if (($observed % $alignment) -ne 0 -or $observed -lt [uint64]($observedSource + $reserve)) {
  throw "SIZING_TEST_ALIGNMENT_OR_MINIMUM_FAILED"
}

$alignedSource = $alignment
Assert-Equal (Get-ToolchainVirtualSize $alignedSource) ([uint64]($reserve + $alignment)) "already_aligned"
Assert-Equal (Get-ToolchainVirtualSize ([uint64]1)) ([uint64]($reserve + $alignment)) "round_up_one_byte"

$maximumAligned = [uint64]::Parse("18446744073708503040")
$safeLargeSource = [uint64]::Parse("18446744052233666560")
Assert-Equal (Get-ToolchainVirtualSize $safeLargeSource) $maximumAligned "largest_safe_aligned"

$overflowSource = [uint64]::Parse("18446744052234715135")
Expect-Failure "M4F_TOOLCHAIN_SIZE_OVERFLOW" { Get-ToolchainVirtualSize $overflowSource }
Expect-Failure "M4F_TOOLCHAIN_SIZE_INVALID" { Get-ToolchainVirtualSize ([int64]-1) }

[pscustomobject]@{
  schema = "synthia-m4f-certifier-sizing-test.v1"
  status = "passed"
  alignment_bytes = [uint64]$alignment
  reserve_bytes = [uint64]$reserve
  cases = 6
} | ConvertTo-Json -Compress
