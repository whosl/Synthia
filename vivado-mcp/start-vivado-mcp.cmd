@echo off
setlocal EnableExtensions
rem Vivado MCP launcher (style follows connector/start-worker-66.cmd:
rem fail-closed env preflight + stable VIVADO_MCP_LAUNCH_FAILED:<CODE> on stderr).

set "VIVADO_MCP_ROOT=%~dp0"
if defined SYNTHIA_VIVADO_MCP_ROOT set "VIVADO_MCP_ROOT=%SYNTHIA_VIVADO_MCP_ROOT%"

set "BUN_EXE=bun.exe"
if defined SYNTHIA_VIVADO_MCP_BUN set "BUN_EXE=%SYNTHIA_VIVADO_MCP_BUN%"

if not defined VIVADO_MCP_TOKEN (
  1>&2 echo VIVADO_MCP_LAUNCH_FAILED:TOKEN_MISSING
  exit /b 2
)
if "%VIVADO_MCP_TOKEN%"=="" (
  1>&2 echo VIVADO_MCP_LAUNCH_FAILED:TOKEN_EMPTY
  exit /b 2
)
if not defined VIVADO_BINARY (
  1>&2 echo VIVADO_MCP_LAUNCH_FAILED:VIVADO_BINARY_MISSING
  1>&2 echo Set VIVADO_BINARY to the absolute vivado.bat path, e.g. D:\Xilinx\Vivado\2021.1\bin\vivado.bat
  exit /b 2
)

where "%BUN_EXE%" >nul 2>&1
if errorlevel 1 (
  1>&2 echo VIVADO_MCP_LAUNCH_FAILED:BUN_UNAVAILABLE
  exit /b 3
)

if not exist "%VIVADO_BINARY%" (
  1>&2 echo VIVADO_MCP_LAUNCH_FAILED:VIVADO_BINARY_NOT_FOUND
  exit /b 4
)

if not exist "%VIVADO_MCP_ROOT%src\index.ts" if not exist "%VIVADO_MCP_ROOT%dist\vivado-mcp.bundle.mjs" (
  1>&2 echo VIVADO_MCP_LAUNCH_FAILED:BUNDLE_MISSING
  1>&2 echo Run bun install and bun run build in the vivado-mcp directory first.
  exit /b 5
)

if exist "%VIVADO_MCP_ROOT%dist\vivado-mcp.bundle.mjs" (
  "%BUN_EXE%" "%VIVADO_MCP_ROOT%dist\vivado-mcp.bundle.mjs"
) else (
  "%BUN_EXE%" run "%VIVADO_MCP_ROOT%src\index.ts"
)
if errorlevel 1 (
  1>&2 echo VIVADO_MCP_LAUNCH_FAILED:SERVER_EXITED
  exit /b 6
)
exit /b 0
