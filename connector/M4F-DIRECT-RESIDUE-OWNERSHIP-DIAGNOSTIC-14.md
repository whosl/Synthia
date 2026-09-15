# M4-F Candidate-14 direct residue-ownership diagnostic

Candidate 14 is a new, read-only lineage after the frozen Candidate-13
failure. Candidate 13 reached its start and complete markers, but its process
projection ended with `ParameterBindingValidationException`. Its remote script
defined a one-letter `H` function and invoked `H $s`. In Windows PowerShell
5.1, the default case-insensitive `h` alias resolves to `Get-History` ahead of
the same-named function. The invocation therefore entered `Get-History`
parameter binding rather than the intended SHA-256 helper.

Candidate 14 removes both contributing paths:

1. The helper has the unique name `Get-SynthiaHash`, declares
   `param([AllowNull()][object]$Value)`, and is always called with `-Value`.
2. A null `CommandLine` never calls the helper. It is projected as
   `readable=false`, `length=null`, and `sha256=null`. Empty and normal readable
   strings retain exact length and SHA-256.
3. Only the two frozen PowerShell PIDs receive a private wrapper proof. The
   entire command must match the exact unquoted PowerShell prefix and contain
   one constrained `-EncodedCommand` token; that token must be canonical
   Base64, decode strictly as UTF-16LE, round-trip byte-for-byte, and hash to
   the frozen decoded UTF-8 SHA-256. The remote output contains only booleans
   and the decoded hash, never the command, Base64 token, or decoded text.

The historical unquoted full-command hash `f70c...` is supporting evidence
only. A local reconstruction produced `9a291f...`, so the historical value is
explicitly not a successful-attribution condition. A full wrapper proof plus
the exact PID/name/creation, corresponding SSH tree/session, and absence of
unknown descendants is required before the local result can be `observed`.

The remote boundary remains minimal. One direct
`powershell.exe ... -EncodedCommand` receives empty stdin, writes and flushes
the static start marker, evaluates
`$all=@(Get-CimInstance Win32_Process)` exactly once, projects the in-memory
snapshot, and writes the complete zero-mutation marker. There is no retry,
gzip, stdin reader, dynamic ScriptBlock, filesystem probe, service mutation,
cleanup, Vivado, bitstream, or hardware action.

If a remote stage fails, the unknown marker may contain only a fixed substage
code, the exception type, and SHA-256 of
`substage|exception-type|FullyQualifiedErrorId`. It cannot
contain an exception message, stack, position message, raw command line, or
decoded command. The accepted compact substage codes are `c` for CIM snapshot,
`r` for command projection, `d` for post-snapshot deadline, and `e` for
snapshot emission.

The local parser binds the four historical target identities by exact PID,
name, and 100ns-precision creation UTC. It derives direct parent facts, bounded
ancestors to the nearest `sshd.exe`, session and pair-tree connectivity,
cross-candidate connectivity, and descendants. Ancestor depth is capped at 8
and each derived closure at 32 rows. Missing, reused, disconnected, cyclic,
overflowed, unknown, or malformed facts remain `partial_unknown`.

Candidate 14 binds the Candidate-12 successful evidence and the complete
Candidate-13 failure evidence by SHA-256. Its config also freezes the only
permitted future evidence directory. Evidence creation, if separately and
exactly authorized later, remains exclusive and records one attempt, empty
stdin, raw streams and hashes, initial/pre/post transport facts, markers,
derived facts, and `cleanup_derivation_permitted=false`.

Candidate 14 is currently a local plan only. No SSH or remote execution is
authorized by this document or its frozen config/plan/confirmation.

Local verification only:

~~~text
bun test connector/m4f-direct-residue-ownership-diagnostic-14.test.ts
bunx tsc --noEmit -p connector/tsconfig.json
git diff --check -- connector/scripts/m4f-direct-residue-ownership-diagnostic-14.ts connector/m4f-direct-residue-ownership-diagnostic-14.test.ts connector/M4F-DIRECT-RESIDUE-OWNERSHIP-DIAGNOSTIC-14.md
~~~
