# M4-F Candidate 18/19 Exact Six-Process Cleanup

## Status and authority

This document is an implementation design, not an execution authorization.
Candidate 18 is a Windows PowerShell 5.1 parse-only gate. Candidate 19 builds
the exact cleanup business script and its decoded outer loader. Neither local
tests nor Candidate 18 may invoke either body. Production config, freeze,
network, SSH, cleanup and gate-root creation are outside this implementation
stage.

The only admitted ownership lineage is the C17 local adjudication record SHA
`f575dae6bafa812de57cf3d82d1b920ec96bc74e6c7ad2e0fedbac018b27f3a7`
and its independent review SHA
`9cd47bff11c7c8c635c23411cd5d966079b6387c69e3139e8c2a47e85d303447`.
The bound observation semantic SHA is
`269ac2c43af54fee3c7aa1e9d49e1848bb8bf310f10a3165182f7b6773e6f1b3`.
The review permits a separate cleanup production freeze only; it does not
authorize execution.

The protected-worker baseline additionally binds Admission v2 production
record SHA
`856edffdde9094c95e76aba062b8919c47b44cdeaae60a388cba11b3f7b5657e`
and its protection-only independent review SHA
`4628ad24fb22fedf4d3989ec9482be79ea3316a18b3b76b3a52328d61c369150`.
That review admits only the PID-13644 and port-8443 protection baseline; it
does not authorize cleanup execution.

## Exact target set and order

Candidate 19 admits exactly these six identities and this order:

1. candidate09 `powershell.exe`, PID 44768, parent 56576, creation
   `2026-08-28T16:25:51.0137884Z`;
2. candidate09 `cmd.exe`, PID 56576, parent 6100, creation
   `2026-08-28T16:25:50.9870650Z`;
3. candidate09 `conhost.exe`, PID 64484, parent 56576, creation
   `2026-08-28T16:25:50.9908927Z`;
4. candidate10 `powershell.exe`, PID 58908, parent 67048, creation
   `2026-08-28T17:12:52.5233863Z`;
5. candidate10 `cmd.exe`, PID 67048, parent 24260, creation
   `2026-08-28T17:12:52.4952390Z`;
6. candidate10 `conhost.exe`, PID 66316, parent 67048, creation
   `2026-08-28T17:12:52.5009297Z`.

All six are session zero. Command-line hashes are fixed by role: PowerShell
`8666564baaf3aa762b67d0eb4b8d288ab2f2611bad85e0046dc5b07455a0b5fc`,
cmd `5bc4c97b1fd21194056191199161af8371483e645131cf7c32a83018ae5be99e`,
and conhost
`417222c4a0ecb4d60a457ebe8e26fddf3d5406bffb16a5c59af8eeb241beca51`.
No PID, descendant, name match, replacement process or broader residue may be
added at runtime.

The order closes one tree before touching the other:
candidate09 PowerShell, cmd, conhost, then candidate10 PowerShell, cmd,
conhost. Before every candidate09 effect, all three retained candidate10
processes must still be live. Before candidate10 PowerShell, both candidate10
console peers must still be live. Any earlier candidate10 exit is a partial
stop.

## Retained-handle preflight

Before the first effect, one complete `Win32_Process` snapshot must prove all
six PID/name/creation/session/parent/command-hash tuples and the exact two-tree
graph. Each target is passed to `Process.GetProcessById` exactly once. The
implementation reads `Process.SafeHandle`, rejects `IsInvalid` or `IsClosed`,
calls `DangerousAddRef`, records the raw handle value, and retains both the
same `Process` instance and OS handle until `finally` calls
`DangerousRelease`. It does not call `Refresh`, `Dispose`, or
`GetProcessById` again.

The retained OS handle plus exact handle start time is the PID-reuse defence.
`Process.Kill` is called on the same retained `Process` instance. The design
does not claim that the .NET implementation necessarily uses the retained raw
handle internally.

Handle and CIM UTC ticks are compared only after exact flooring to CIM's
one-microsecond boundary. There is no tolerance window. All six retained
handles must be valid before the first effect.

## Protection boundary

The complete current-process ancestor chain and all `sshd.exe` identities in
the preflight snapshot are protected. PID 13644 is protected by exact PID,
parent PID 2712, name `node.exe`, executable path
`D:\softwares\Nodejs\node.exe`, creation time, a separately retained
`SafeHandle`, and a command hash observed as a same-run stability fact (not a
historical authorization identity). Port 8443 is read only through the
`MSFT_NetTCPConnection` CIM class using the normative MIB listen state 2. The
listener set must equal exactly `[{0.0.0.0,8443,13644}]`; zero rows, extra
rows, address drift, port drift, or owner drift fail closed.
`Get-NetTCPConnection`, `Get-CimClass`, `netstat`, `findstr`, service APIs and
network probes are forbidden.

The local marker validator independently reconstructs the reported current
process ancestry to PID zero, rejects missing/cyclic chains and rejects any
ancestry through a target or PID 13644. It also validates the exact reported
worker and listener facts. A marker stream alone cannot prove that the remote
snapshot enumerated every `sshd.exe`; that completeness claim remains bound
to the frozen business-script semantics plus the raw execution evidence and
must not be inferred from marker contents alone.

Targets may not overlap or connect to the protected set. The business script
contains no file, registry, service, Vivado or hardware operation and creates
no gate root. It contains no wildcard/name-wide termination, recursive tree
kill or replacement-target logic.

Both historically absent external cmd parent PIDs, 6100 and 24260, must still
be absent at preflight. The only allowed target-to-target edges are each cmd
to its same-candidate PowerShell and conhost children; every other child of a
target, cross-tree edge, protected edge, or reused external-parent PID causes
a zero-effect stop.

## Effects, natural exit and evidence boundary

Natural-exit inspection occurs before `effect_start`. It is accepted only for
candidate09 cmd/conhost after candidate09 PowerShell has a completed
`effect_result`, or candidate10 cmd/conhost after candidate10 PowerShell has a
completed `effect_result`. Acceptance is proven through the originally
retained handle. PowerShell natural exit, cross-tree natural exit, an exit
after `effect_start`, or PID reuse is an immediate partial stop.

All payload construction and checks occur before `effect_start`. The flushed
`effect_start` marker and the same-instance `Process.Kill()` call are adjacent
in source, with no query, hash, formatting, assignment or other fallible step
between them. `effect_start` alone does not prove an effect occurred, but it
does permanently make the one-shot result partial and non-retryable. After a
bounded `WaitForExit`, `effect_result` is flushed immediately.

The parser preserves complete marker-prefix information and the exact trailing
fragment. A timeout, missing result marker, invalid tail, transport failure or
post-effect ambiguity is partial/unknown and never retryable.

Postflight requires all six retained handles exited and all six original
identities absent from a new CIM snapshot. A reused PID is never touched and
prevents success. The original current/ancestor/sshd identities, the retained
PID-13644 worker identity and all 8443 listener ownership must remain intact.

## Candidate 18 parse-only gate

Candidate 19 has two config layers to avoid a hash cycle. An immutable script
config is frozen first and generates the final business script and decoded
outer loader. Candidate 18 binds that config plus Candidate 19 source and test
hashes, and independently calls Windows PowerShell 5.1
`Parser.ParseInput` on both exact strings. It requires zero errors, full
`ScriptBlockAst`/`EndBlock` results, exact lengths/hashes, and
`target_body_not_invoked=true` for both. Candidate 18 does not claim runtime
validation.

Only after Candidate 18 success is independently reviewed may a Candidate 19
execution config embed the unchanged script config and bind Candidate 18
evidence. It must rebuild both strings byte-for-byte; Candidate 18 evidence
cannot authorize a changed loader or business script.

All helper functions use long `SynthiaM4f...` names. Static tests compare them
case-insensitively against the Windows PowerShell 5.1 alias/cmdlet/automatic
variable collision set and reject short function names.
