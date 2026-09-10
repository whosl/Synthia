# M4-F Candidate-15 direct residue-ownership diagnostic

Candidate 15 is a new, read-only lineage after the frozen Candidate-14 parser
failure. Candidate 14 completed one zero-mutation remote attempt and returned a
full CIM snapshot, but its local parser correctly rejected PID 0. Candidate 15
does not reinterpret that failed result as success. It binds all sixteen
Candidate-14 evidence files by SHA-256, requires the recorded parser error and
attempt count, and independently validates the relevant Candidate-14 raw
marker semantics before any network call.

## Frozen identities

The only admitted residue targets are the Candidate-09 and Candidate-10
PowerShell/conhost pairs already frozen by Candidate 12. Their PIDs and
100-nanosecond `Get-Process.StartTime` tokens are constants in the v3 config
validator. The corresponding command parents are fixed as:

| Candidate | cmd PID | upstream PID | cmd creation UTC |
|---|---:|---:|---|
| Candidate 09 | 56576 | 6100 | `2026-08-28T16:25:50.9870650Z` |
| Candidate 10 | 67048 | 24260 | `2026-08-28T17:12:52.4952390Z` |

The raw command-line SHA-256 values are also fixed:

- PowerShell: `8666564baaf3aa762b67d0eb4b8d288ab2f2611bad85e0046dc5b07455a0b5fc`
- conhost: `417222c4a0ecb4d60a457ebe8e26fddf3d5406bffb16a5c59af8eeb241beca51`
- cmd: `5bc4c97b1fd21194056191199161af8371483e645131cf7c32a83018ae5be99e`

Candidate 14's raw snapshot must itself prove these six historical process
facts, exact direct-child sets, absent upstream PIDs, sessions, creation times,
and command hashes. Its PID-0 row must be present, explaining the frozen local
parser failure rather than being silently discarded after the fact.

## Single remote observation

The generated command is one direct, encoded Windows PowerShell command with
empty stdin, one attempt, a 25-second local kill deadline, and a 15-second
cooperative remote deadline. It performs exactly one
`Get-CimInstance Win32_Process` call. The exported graph contains only
`[PID,parent PID]` edges, excludes PID 0, and declares `n` from the filtered
edge count. Detailed CIM projections are restricted to the four targets and
either currently present fixed cmd PID, for a maximum of six objects.

Only the four target PIDs are opened with `Get-Process`. Each handle projection
contains its ID, name, `HasExited`, and
`StartTime.ToUniversalTime().ToString("o")`. Local acceptance requires the
handle token to equal Candidate 12 at all seven fractional digits. The CIM
token must carry the same first six fractional digits and a discarded seventh
digit of zero; this prevents the earlier CIM precision loss from weakening the
handle identity.

The PowerShell wrapper proof accepts only the unquoted literal
`powershell.exe`, followed by exactly two ASCII U+0020 spaces, followed by the
exact ordered arguments with one ASCII space between each argument. Unicode
whitespace, quotes, reordered or duplicate arguments, extra
`-EncodedCommand` tokens, trailing characters, and non-canonical Base64 all
fail. The token must strictly decode and byte-round-trip as UTF-16LE, and the
decoded UTF-8 SHA-256 must equal
`21ea7ae211c4433bced41512d6b54d37b259a7700ae3dffe63147c6ab5178407`.
The full raw PowerShell hash must simultaneously equal the frozen `866656...`
value.

## Ownership result

`ownership_observed` is possible through either of two explicit branches:

1. The fixed cmd PID is still present with exact name, parent, creation,
   session, raw command hash, and exact current child set.
2. The cmd process has naturally exited. Its PID must be completely absent
   from the current graph, while Candidate 14 supplies the exact historical cmd
   fact and child set. The target CIM rows must still name that fixed cmd PID as
   parent.

Both branches require exact live target handles, identical expected session,
cmd creation inside the corresponding frozen attempt window and earlier than
both children, absent upstream PID with no PID reuse, no target descendants,
no unknown cmd descendants, no closure overflow, and no cross-candidate
connection. Any malformed, missing, reused, cyclic, overflowing, or
inconsistent fact remains `partial_unknown`.

An ownership result never authorizes cleanup. Every plan, complete marker,
observation, and result keeps `cleanup_derivation_permitted=false`. Termination
would require a separate reviewed implementation, plan, evidence directory,
and exact user authorization.

The remote script contains no process, file, ACL, service, Vivado, bitstream,
or hardware mutation. Error markers expose only a fixed stage code, exception
type, and SHA-256 of bounded diagnostic fields; exception messages, command
lines, encoded payloads, decoded scripts, stacks, and position messages are
not returned.

Candidate 15 remains a local reviewed candidate until a final source/test/doc
freeze, an independently reviewed production config and plan, and a new exact
confirmation. No earlier Candidate-14 or draft Candidate-15 confirmation is
reusable.

Local verification only:

~~~text
bun test connector/m4f-direct-residue-ownership-diagnostic-15.test.ts
bunx tsc --noEmit -p connector/tsconfig.json
git diff --check -- connector/scripts/m4f-direct-residue-ownership-diagnostic-15.ts connector/m4f-direct-residue-ownership-diagnostic-15.test.ts connector/M4F-DIRECT-RESIDUE-OWNERSHIP-DIAGNOSTIC-15.md
~~~
