# M4-F Gate-root candidate-11 direct EncodedCommand diagnostic

Candidate 11 is a new diagnostic lineage after candidate 10 timed out before
its first marker. It does not reuse candidate 10's config, confirmation, or
evidence directory. It observes the same frozen Gate-root targets identified
by `gate_id=prod-20260828-03` through the direct Mac-to-66 topology only.

The diagnostic deliberately removes the stdin execution chain. SSH receives
an exactly empty stdin and invokes one short
`powershell.exe ... -EncodedCommand` command. There is no gzip loader,
`Console.In.ReadToEnd`, or `ScriptBlock.Create`. The decoded script's first
line writes a static `start` NDJSON marker and immediately flushes stdout.
This distinguishes failure to start the direct encoded PowerShell command from
failures inside later probes.

Candidate 11 is intentionally narrow. After the start marker it performs only:

1. A native `Get-Process` probe for `powershell`, `sshd`, and `conhost`,
   excluding the current PowerShell. It returns PID, process name, start token,
   and whether the start is inside the frozen candidate-09 or candidate-10
   attempt window. It does not request or return command lines.
2. `Test-Path` for the two frozen target paths:
   `C:\Windows\Temp\synthia-m4f-prod-20260828-03` and
   `D:\synthia-m4f-toolchain-prod-20260828-03`.
3. A terminal complete marker with explicit zero-mutation facts.

Each probe writes and flushes a begin marker before the read and an observed or
unknown end marker afterward. Ordinary probe failures are reported as unknown
and the next distinct probe continues. The remote deadline is a cooperative
15-second boundary check; the local process has a 25-second timeout with
`SIGKILL`. Neither mechanism authorizes retry or process cleanup.

The local parser validates more than marker ordering. It requires exact payload
keys and types for start, process rows, the two frozen target paths, unknown
errors, and the terminal zero-mutation declaration. A syntactically valid
marker cannot claim success with a malformed payload or a true mutation flag.
Any non-empty bytes after the final complete newline make the result
`partial_unknown`; their length and SHA-256 are preserved.

The generated command must be no longer than 6,000 characters, leaving at
least 2,191 characters beneath the Windows 8,191 command boundary for the
OpenSSH/default-shell prefix. Tests decode the exact base64 command back to the
reviewed script and freeze this margin.

Execution, when separately confirmed, permits one SSH attempt only. Evidence
uses an exclusive 0700 directory and exclusive 0600 files. The process and
result records state `attempt_count=1`, start/end UTC times, `stdin_length=0`,
raw stdout/stderr hashes, and `retry_permitted=false`. The exact remote command
length and hash and all three transport-input captures (initial, immediately
before remote, and immediately after remote) are also frozen. Raw streams,
process facts, and transport facts remain available on post-attempt drift or
parse failure.

Candidate 11 contains no Volume, ACL, stream, ancestor, service, process
mutation, Vivado, bitstream, or hardware action. Volume and filesystem
diagnostics remain deferred until this direct-start chain is proven.

Local verification only:

~~~text
bun test connector/m4f-direct-gate-roots-encoded-diagnostic.test.ts
bunx tsc --noEmit -p connector/tsconfig.json
git diff --check -- connector/scripts/m4f-direct-gate-roots-encoded-diagnostic.ts connector/m4f-direct-gate-roots-encoded-diagnostic.test.ts connector/M4F-DIRECT-GATE-ROOTS-ENCODED-DIAGNOSTIC.md
~~~
