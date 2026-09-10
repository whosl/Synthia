# M4-F single-session identity and residue follow-up

This is a proposed read-only diagnostic for the first production staged run. It
is not an admission retry and does not read or reuse old evidence.

The first single-session production attempt (`prod-01`) is also permanently
`UNKNOWN/no-retry`. It exited in 0.718 seconds with status 1, empty stdout and
zero markers. Its 14 stderr bytes have SHA-256 prefix/suffix
`4b0c…1872`; exact GB18030 decoding is `命令行太长。\r\n`. That evidence is
preserved and is not opened, modified or reused by this revision.

The corrected compressed transport then completed all eight markers in
`prod-02`, so the direct SSH, in-memory loader and marker flush path are now
observed end to end. Phases 1, 2, 3, 7 and 8 were `observed`. Phase 4
(`cim-system-snapshot`) and phase 5 (`openssh-events`) returned
`ParameterBindingException`; phase 6 (`whoami-user`) returned
`RuntimeException`. The environment facts were `USERDOMAIN=WORKGROUP` and
`USERNAME=admin`, while WindowsIdentity still exactly matched
`desktop-dvffb09\admin` and the admitted SID. Stderr contained 1,024 bytes of
PowerShell progress CLIXML. The complete stdout was valid NDJSON, but the phase
exceptions and non-empty stderr keep the overall result `UNKNOWN/no-retry`.
The `prod-02` evidence is frozen and is not read, modified, retried or reused by
this revision.

`prod-03` is also permanently `UNKNOWN/no-retry`. Its exact UTF-8 progress
CLIXML showed that Windows PowerShell 5.1 resolved the helper call `H` to its
case-insensitive built-in `h` alias (`Get-History`). The phase-4 body exception
therefore entered `catch`, but `H $_.FullyQualifiedErrorId` failed again with
`CannotConvertArgumentNoMessage`; the error reporter emitted no `unknown`
marker and the script exited globally with status 1. This is a deterministic
PowerShell command-precedence defect, not evidence of another SSH hang.
`prod-03` evidence remains frozen and is not read, modified, retried or reused.

The proposed `prod-04` patch changes only that hash helper and its four calls to
the unique name `SynthiaHash`. Replacing all five `SynthiaHash` tokens (one
definition and four calls) with `H` recreates the exact frozen `prod-03` source
SHA-256 `a177b60d…34c50`; no other business-script or loader byte changed. A
frozen Windows PowerShell 5.1 alias-table
regression demonstrates that legacy `H`/`h` collides while all current helper
names do not. The name has no cmdlet-style `Verb-Noun` form and does not match a
built-in PowerShell 5.1 function; its explicit function definition precedes all
four calls. A simulated phase-body exception regression also requires the
`unknown` marker to be retained and execution to continue through `complete`.

## Current root-cause assessment

The production record shows `wrapper-smoke` observed in 3,216 ms and
`processes` observed in 3,095 ms with the exact computer, account and SID. The
other eight stages timed out at 60 seconds with empty stdout/stderr. The
successful process stage called `WindowsIdentity.GetCurrent()` before its
process query. It reported 44 `node.exe` processes, including the old port-8443
Worker PID 13644, and no Vivado or hardware-server process.

Therefore WindowsIdentity is not a deterministic root cause, though it may
still stall intermittently. The evidence also fits Windows OpenSSH/PowerShell
session stalls, CIM/provider contention or host resource pressure. The 44 Node
processes show load, not causation.

The earlier whitelist omitted sshd/PowerShell/conhost. Local `SIGKILL` bounds
the Mac SSH wait but does not prove every Windows descendant exited. Remote
residue is plausible but unproven.

## Single-session design

Six independent probes were rejected because they would create six new
SSH/PowerShell sessions and prevent one parent/child timeline. This design uses
exactly one SSH connection and one directly encoded PowerShell script. Stdin is
empty. Each phase writes one strict NDJSON marker and immediately flushes it.
On timeout, the parser preserves every strict complete line before the last
newline even if the next line was cut mid-write. The trailing fragment's length
and SHA-256 are recorded, and the overall result remains `UNKNOWN`.

The fixed phases are:

1. `start`: current PowerShell PID.
2. `env-identity`: environment computer/domain/user facts. `USERDOMAIN` is
   recorded but is not treated as a login authority or security identity.
3. `processes-native`: non-CIM sshd/PowerShell/conhost counts.
4. `cim-system-snapshot`: parent PID, UTC creation time, command-line SHA-256
   and classification for those processes; memory/process count; sshd service
   status/start type. Raw command lines are never returned.
5. `openssh-events`: metadata-only hash of at most 16 OpenSSH Operational
   records. Event messages are never returned.
6. `whoami-user`: fixed
   `C:\Windows\System32\whoami.exe /user /fo csv /nh` account and SID.
7. `windows-identity`: isolated `WindowsIdentity.GetCurrent()` account and SID.
8. `complete`: terminal marker.

A phase exception emits `unknown` with exception type, HRESULT, category, and
SHA-256 identifiers for the fully qualified error id and message; no raw error
message is returned. A hang cannot emit its marker; the single outer deadline
ends the only attempt.

## Safety boundary

- Direct topology only: `admin@100.96.223.49 / DESKTOP-DVFFB09`.
- One SSH attempt, 30-second hard local `SIGKILL` deadline, no retry.
- Direct `EncodedCommand` with an embedded gzip/base64 UTF-8 copy of the exact
  read-only business script. The loader decompresses to memory and executes the
  bound script; it does not use `Console.In.ReadToEnd` or write a remote file.
  Stdin remains exactly empty. Before decompression, it disables the Progress,
  Information, Verbose, Debug and Warning streams so PowerShell 5.1 progress
  CLIXML cannot silently turn a clean diagnostic into success.
- The generated business script is 3,087 bytes, compressed payload 1,514 bytes,
  loader 2,336 characters and current command 6,322 characters. Generation
  fails closed above 6,500, reserving at least 1,691 characters below the
  Windows 8,191-character boundary for OpenSSH/default-shell prefixes. The
  current concrete command leaves 178 characters before the hard local cap and
  1,869 characters of total Windows boundary headroom.
- Read-only queries only. No file/registry/ACL/service mutation, process kill or
  cleanup, Vivado, bitstream, hardware manager, download or programming.
- PowerShell and fixed whoami are diagnostic processes; CIM/event queries may
  activate providers. On timeout, remote state remains `read_only_unknown`.
- Source, imported transport, exact `ssh -G`, key and known-hosts are bound.
- Admission config uses one handle and is bound before/after by SHA-256, device,
  inode, UID, mode, link count, size, mtime and ctime. Identical-byte inode
  replacement fails closed.
- New evidence only: directory 0700, every file 0600. Raw output is bound by
  exact length and SHA-256, including post-attempt failures. The exact business
  script, loader and compressed payload are frozen separately with hashes.

## Interpretation

Interpret marker status before the last-marker table:

- If `complete` exists but any phase marker is `unknown`, use that specific
  phase exception as the conclusion. A terminal marker does not erase it.
- Structurally valid ordered markers are preserved even if a payload fails its
  admitted semantic check. Such a record remains `UNKNOWN`, but marker count and
  last phase are retained instead of being collapsed to zero.
- Only eight `observed` markers permit the “earlier fault was intermittent”
  interpretation.
- If `complete` is absent, use the last strict complete marker to locate the
  following phase where the session hung or was cut off.

| Last marker | Leading interpretation |
|---|---|
| none | SSH channel or PowerShell startup |
| `env-identity` | native process enumeration/session pressure |
| `processes-native` | CIM/WMI provider contention |
| `cim-system-snapshot` | OpenSSH event provider/log query |
| `openssh-events` | fixed child-process/token lookup path |
| `whoami-user` | WindowsIdentity/provider becomes leading suspect |
| `complete`, all eight observed | earlier fault was intermittent; review residue/resource facts |

Old descendants support a residue finding only when parent PID and start time
correlate with earlier sessions. Presence alone does not establish origin.

## Admission identity recommendation

In the same admitted session, compare environment computer and user with the
expected host/account and record `USERDOMAIN` only as an environment fact; a
value such as `WORKGROUP` is not a login authority. Then execute only the fixed
whoami command. Its fixed `C:\Windows\System32\whoami.exe` path is accepted only
when SystemRoot equals `C:\Windows` case-insensitively; require exit 0, exactly
one explicitly parsed CSV row, the expected lowercase account and exact SID.
WindowsIdentity remains an independent diagnostic and must also exactly match
the same admitted account and SID before the overall record can be `observed`.

Failure or timeout stays `UNKNOWN` and fails closed. There is no name-only
admission, guessed SID or fallback to WindowsIdentity. Host key, SSH account and
returned SID remain independently bound. Other observations remain separately
bounded because the first run also stalled outside identity.

## Configuration and review-only commands

~~~json
{
  "schema": "synthia-m4f-direct-identity-residue-followup-config.v2",
  "diagnostic_id": "m4f-direct-identity-residue-20260828-prod-04",
  "admission_config_path": "/absolute/private/path/m4f-direct-admission.json",
  "admission_config_sha256": "<exact-sha256>",
  "expected_source_sha256": "<final-reviewed-source-sha256>",
  "expected_transport_source_sha256": "7d85d67480bb58532c8b1c30b80697305a5b470115cbae944c2cf762384ff5df",
  "expected_effective_config_sha256": "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90"
}
~~~

Local plan only:

~~~text
bun connector/scripts/m4f-direct-identity-residue-followup.ts \
  --plan --config /absolute/private/followup.json
~~~

The execution form is documented for post-review use only:

~~~text
bun connector/scripts/m4f-direct-identity-residue-followup.ts \
  --execute-read-only --config /absolute/private/followup.json \
  --confirmation '<exact-plan-confirmation>' \
  --evidence /private/tmp/new-followup-evidence
~~~

Local verification:

~~~text
bun test connector/m4f-direct-identity-residue-followup.test.ts
bunx tsc --noEmit -p connector/tsconfig.json
git diff --check -- \
  connector/scripts/m4f-direct-identity-residue-followup.ts \
  connector/m4f-direct-identity-residue-followup.test.ts \
  connector/M4F-DIRECT-IDENTITY-RESIDUE-FOLLOWUP.md
~~~

Passing these checks authorizes review only, not remote execution, cleanup,
admission, Vivado or hardware access.
