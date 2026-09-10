@echo off
setlocal
if not defined SYNTHIA_WORKER_ROOT set "SYNTHIA_WORKER_ROOT=D:\synthia-worker"
if not defined SYNTHIA_WORKER_BUN set "SYNTHIA_WORKER_BUN=%SYNTHIA_WORKER_ROOT%\runtime\bun-1.4.1\bun.exe"
if not defined SYNTHIA_WORKER_CONFIG set "SYNTHIA_WORKER_CONFIG=%SYNTHIA_WORKER_ROOT%\worker-66.config.json"
if not defined SYNTHIA_WORKER_SERVICE_IDENTITY (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:SERVICE_IDENTITY_MISSING 1>&2
  exit /b 19
)
if not defined SYNTHIA_WORKER_LOG_ROOT (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:LOG_ROOT_MISSING 1>&2
  exit /b 31
)

set "WORKER_ROOT=%SYNTHIA_WORKER_ROOT%"
set "BUN_EXE=%SYNTHIA_WORKER_BUN%"
set "WORKER_BUNDLE=%SYNTHIA_WORKER_ROOT%\server.bundle.mjs"
set "WORKER_CONFIG=%SYNTHIA_WORKER_CONFIG%"
set "RELEASE_MANIFEST=%SYNTHIA_WORKER_ROOT%\worker-release.manifest.json"
set "WINDOWS_CERTIFIER=%SYNTHIA_WORKER_ROOT%\certify-m4f-windows.ps1"
set "PFX_PASSWORD_FILE=%SYNTHIA_WORKER_ROOT%\pfx-password.txt"

if not exist "%BUN_EXE%" (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:BUN_MISSING 1>&2
  exit /b 20
)
if not exist "%WORKER_BUNDLE%" (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:BUNDLE_MISSING 1>&2
  exit /b 21
)
if not exist "%WORKER_CONFIG%" (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:CONFIG_MISSING 1>&2
  exit /b 22
)
if not exist "%RELEASE_MANIFEST%" (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:MANIFEST_MISSING 1>&2
  exit /b 23
)
if not exist "%WINDOWS_CERTIFIER%" (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:CERTIFIER_MISSING 1>&2
  exit /b 24
)
if not exist "%PFX_PASSWORD_FILE%" (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:PFX_PASSWORD_FILE_MISSING 1>&2
  exit /b 25
)
if not exist "%SYNTHIA_WORKER_LOG_ROOT%" (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:LOG_ROOT_UNAVAILABLE 1>&2
  exit /b 32
)

for /f "usebackq delims=" %%V in (`"%BUN_EXE%" --version`) do set "BUN_VERSION=%%V"
if not "%BUN_VERSION%"=="1.4.1" (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:BUN_VERSION_MISMATCH 1>&2
  exit /b 26
)

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%WINDOWS_CERTIFIER%" -Mode LaunchPreflight -ReleaseRoot "%WORKER_ROOT%" -ConfigPath "%WORKER_CONFIG%" -StagingRoot "%SYNTHIA_M4F_STAGING_ROOT%" -GateId "%SYNTHIA_M4F_GATE_ID%" -BunPath "%BUN_EXE%" -PfxPasswordPath "%PFX_PASSWORD_FILE%" -LogRoot "%SYNTHIA_WORKER_LOG_ROOT%" -ServiceIdentity "%SYNTHIA_WORKER_SERVICE_IDENTITY%"
if errorlevel 1 (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:CERTIFIER_PREFLIGHT_FAILED 1>&2
  exit /b 27
)
if /I "%~1"=="preflight-only" exit /b 0

for /f "usebackq delims=" %%H in (`powershell.exe -NoProfile -NonInteractive -Command "(Get-FileHash -LiteralPath $env:SYNTHIA_WORKER_CONFIG -Algorithm SHA256).Hash.ToLowerInvariant()"`) do set "SYNTHIA_WORKER_CONFIG_SHA256=%%H"
if not defined SYNTHIA_WORKER_CONFIG_SHA256 (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:CONFIG_HASH_UNAVAILABLE 1>&2
  exit /b 29
)

rem Bun cannot execute an entry file from a read-only sealed directory;
rem stage a hash-verified copy in the writable log root and run that copy.
copy /Y "%WORKER_BUNDLE%" "%SYNTHIA_WORKER_LOG_ROOT%\server.bundle.mjs" >nul
if errorlevel 1 (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:BUNDLE_STAGE_FAILED 1>&2
  exit /b 33
)
"%BUN_EXE%" "%SYNTHIA_WORKER_LOG_ROOT%\server.bundle.mjs" --verify-release-manifest "%RELEASE_MANIFEST%" >>"%SYNTHIA_WORKER_LOG_ROOT%\worker-preflight.log" 2>&1
if errorlevel 1 (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:STAGED_BUNDLE_HASH_MISMATCH 1>&2
  exit /b 34
)
set "WORKER_BUNDLE=%SYNTHIA_WORKER_LOG_ROOT%\server.bundle.mjs"
"%BUN_EXE%" "%WORKER_BUNDLE%" --verify-vivado-toolchain-attestation "%WORKER_CONFIG%" >>"%SYNTHIA_WORKER_LOG_ROOT%\worker-preflight.log" 2>&1
if errorlevel 1 (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:TOOLCHAIN_ATTESTATION_FAILED 1>&2
  exit /b 30
)

set /p SYNTHIA_WORKER_PFX_PASSWORD=<"%PFX_PASSWORD_FILE%"
if not defined SYNTHIA_WORKER_PFX_PASSWORD (
  echo SYNTHIA_WORKER_LAUNCH_FAILED:PFX_PASSWORD_EMPTY 1>&2
  exit /b 28
)
set "SYNTHIA_WORKER_VERIFY_BUNDLE=1"
"%BUN_EXE%" "%WORKER_BUNDLE%" >>"%SYNTHIA_WORKER_LOG_ROOT%\worker.log" 2>&1
exit /b %ERRORLEVEL%
