# Scheduled Task action: powershell.exe -NoProfile -File <this script> -Launcher <start-worker-66.cmd> -ConfigPath <worker config>
# Task Scheduler MultipleInstancesPolicy should also be IgnoreNew. This mutex is
# held until the foreground launcher exits, including during process cleanup.
param(
  [Parameter(Mandatory=$true)][string]$Launcher,
  [Parameter(Mandatory=$true)][string]$ConfigPath
)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$port = [int]$config.listen_port
if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid Worker port' }
$launcherPath = (Resolve-Path -LiteralPath $Launcher).Path
$workerRoot = Split-Path -Parent $launcherPath
# Both the sealed release and the staged bundle are valid launch targets.
$bundlePaths = @((Join-Path $workerRoot 'server.bundle.mjs'))
if ($config.evolution_eval_log_root) { $bundlePaths += Join-Path $config.evolution_eval_log_root 'server.bundle.mjs' }
if ($env:SYNTHIA_WORKER_LOG_ROOT) { $bundlePaths += Join-Path $env:SYNTHIA_WORKER_LOG_ROOT 'server.bundle.mjs' }
$patterns = @($bundlePaths | ForEach-Object { '(?i)(?:^|[\s"''])' + [regex]::Escape($_) + '(?:$|[\s"''])' })
$mutex = New-Object System.Threading.Mutex($false, "Global\SynthiaWorkerPort-$port")
$held = $false
try {
  try { $held = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held = $true }
  if (-not $held) { Write-Output 'Worker supervisor already running'; exit 0 }
  $workers = @(Get-CimInstance Win32_Process | Where-Object {
    $process = $_
    $process.Name -in @('node.exe', 'bun.exe') -and $process.CommandLine -and
      @($patterns | Where-Object { $process.CommandLine -match $_ }).Count -gt 0
  })
  $workerIds = @($workers | ForEach-Object { [int]$_.ProcessId })
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    if ([int]$listener.OwningProcess -notin $workerIds) { throw "Port $port is owned by an unrelated process; refusing cleanup" }
  }
  foreach ($worker in $workers) {
    Write-Output "Stopping stale Worker PID=$($worker.ProcessId), created=$($worker.CreationDate)"
    Stop-Process -Id $worker.ProcessId -Force -ErrorAction Stop
    Wait-Process -Id $worker.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
  }
  if (@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue).Count -ne 0) { throw "Worker port $port did not become free" }
  $env:SYNTHIA_WORKER_CONFIG = (Resolve-Path -LiteralPath $ConfigPath).Path
  $env:SYNTHIA_WORKER_ROOT = $workerRoot
  & $env:ComSpec /d /c "`"$launcherPath`""
  exit $LASTEXITCODE
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
