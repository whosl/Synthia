@echo off
setlocal EnableExtensions
rem vivado-mcp launcher on DESKTOP-DVFFB09 (66).
rem Runs under Node (bundle built with --target=node). Kept alive by the
rem "vivado-mcp" scheduled task (onlogon) - processes started directly over
rem SSH die with the session (Windows job object, see vault 2026-08-26).

set "ROOT=D:\vivado-mcp"

rem Idempotency: if something already listens on 8450, do not start a second copy.
netstat -ano | findstr /r /c:":8450 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [%DATE% %TIME%] vivado-mcp already listening on 8450, skip start >> "%ROOT%\server.log"
  exit /b 0
)

set /p VIVADO_MCP_TOKEN=<"%ROOT%\token.txt"
if "%VIVADO_MCP_TOKEN%"=="" (
  echo [%DATE% %TIME%] VIVADO_MCP_LAUNCH_FAILED:TOKEN_FILE_EMPTY >> "%ROOT%\server.log"
  exit /b 2
)
set "VIVADO_MCP_HOST=0.0.0.0"
set "VIVADO_MCP_PORT=8450"
set "VIVADO_BINARY=D:\Xilinx\Vivado\2021.1\bin\vivado.bat"
set "VIVADO_MCP_WORKSPACE_ROOT=%ROOT%\workspaces"
set "VIVADO_MCP_MAX_CONCURRENCY=1"

echo [%DATE% %TIME%] starting vivado-mcp >> "%ROOT%\server.log"
node "%ROOT%\vivado-mcp.bundle.mjs" >> "%ROOT%\server.log" 2>&1
echo [%DATE% %TIME%] vivado-mcp exited with %ERRORLEVEL% >> "%ROOT%\server.log"
exit /b %ERRORLEVEL%
