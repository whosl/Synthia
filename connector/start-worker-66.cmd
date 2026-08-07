@echo off
setlocal
set /p SYNTHIA_WORKER_PFX_PASSWORD=<D:\synthia-worker\pfx-password.txt
set SYNTHIA_WORKER_CONFIG=D:\synthia-worker\worker-66.config.json
D:\softwares\Nodejs\node.exe D:\synthia-worker\server.bundle.mjs >>D:\synthia-worker\worker.log 2>&1
