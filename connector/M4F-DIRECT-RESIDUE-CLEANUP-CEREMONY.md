# M4F Direct Diagnostic Residue Cleanup Ceremony

## Status

This is a review-only destructive-operation design. The implementation and
tests do not authorize a remote attempt. No command in this document has been
executed against Windows. Execution requires a newly generated immutable plan
and the user's exact plan-bound confirmation.

The first production attempt (`m4f-direct-residue-cleanup-prod-20260828-01`)
is permanently frozen as `unknown` and must never be retried. PowerShell 5.1
rejected three generated `foreach` statements during `ScriptBlock.Create`
because the `in` keyword was not delimited from `$c.t`; it emitted no start
marker and performed no recorded termination. A later read-only observation
found all 16 target PIDs still present. The first-attempt correction fixes that
grammar and adds a regression assertion. The loader also uses terminating error semantics
so any future construction failure returns a failed process rather than exit
zero. Any later attempt requires a new ceremony ID,
new plan hash, new evidence directory, and new explicit user confirmation.
The implementation permanently rejects that consumed ID at both config
validation and plan derivation, before any network attempt can begin.

The second production attempt (`m4f-direct-residue-cleanup-prod-20260828-02`)
is also permanently frozen as `unknown` and must never be retried. Its complete
all-target CIM preflight matched all 16 targets, then the first handle check
reported `none_handle_start_changed` before any `Kill`. The check compared a
WMI/CIM `CreationDate`, whose DMTF representation supplies microseconds, with
the 100-nanosecond `FILETIME` exposed by `System.Diagnostics.Process.StartTime`
as seven-digit round-trip strings. A non-zero final FILETIME tick therefore
causes a false mismatch even for the same process. The replacement check
converts both values to UTC ticks, truncates both to the exact one-microsecond
CIM boundary, and then requires equality. It does not use a tolerance window.
The source rejects target evidence that claims sub-microsecond CIM precision.
The consumed second ID is rejected alongside the first ID.

The first production handle-start diagnostic
(`m4f-direct-handle-start-prod-20260828-01`) is permanently frozen as
`unknown` and must never be retried. Its immutable evidence is under
`/private/tmp/synthia-m4f-direct-handle-start-consumed-prod-20260828-01/`
`m4f-direct-handle-start-prod-20260828-01`. The process exited 1 with zero
stdout, no parsed observation, and stderr SHA-256
`1c7886a76cf2282426898e4744c667de6dec4bb5f19e32fe594f65256536eabc`.
PowerShell 5.1 resolved the short helper call `H (...)` through its built-in
case-insensitive alias `h` (`Get-History`) instead of the intended function,
then failed parameter conversion before emitting diagnostic JSON. The attempt
performed no process termination, file mutation, Vivado action or hardware
action. Its diagnostic ID is rejected permanently at config validation and
again during plan derivation, independently of the consumed evidence directory.

The diagnostic SHA-256 helper now uses the unique long name
`Invoke-SynthiaM4fHandleStartDiagnosticSha256Exact`. Regression tests enumerate
the Windows PowerShell 5.1 built-in alias namespace (including `h`), relevant
cmdlet names and automatic-variable names, and require every diagnostic helper
to avoid them. Short single-letter helper names are forbidden in this
diagnostic script.

Before any later cleanup can be considered, this source provides a separate
plan-bound handle-start diagnostic. It is not a cleanup execution mode and it
cannot consume a cleanup confirmation. Its immutable plan binds a frozen
cleanup plan file, Admission config, this source, the direct transport source,
and the audited SSH effective configuration. It requires a distinct diagnostic
ID and exact confirmation:

~~~text
SYNTHIA_M4F_OBSERVE_HANDLE_START_TICKS_READ_ONLY:<diagnostic-id>:<diagnostic-plan-sha256>:16
~~~

Its only remote attempt reads the current Windows identity and PID; the
existence and core CIM tuple of the 16 frozen targets; the exact ordinal-one
expected tuple and start token; ordinal one's current CIM creation ISO/ticks;
one `System.Diagnostics.Process` handle's ID, `HasExited`, start ISO/ticks,
tick delta and one-microsecond-normalized ticks; and existence facts for PID
13644 and `sshd.exe`. Tick values are decimal strings so JSON cannot lose
64-bit precision. It does not query event logs, operating-system resources,
ACLs, Vivado, hardware, or hardware-manager state. It contains no `Kill`,
`Stop-Process`, file write, service mutation, Vivado or hardware command.
Execution is one attempt with empty stdin, no retry, and a new immutable local
evidence directory. Invalid or incomplete output remains `unknown` while every
mutation flag stays false. No diagnostic execution is authorized merely by
this document or its tests.

The local validator does not trust remote self-reported consistency flags. It
parses seven-fraction-digit .NET UTC timestamps directly into 100-nanosecond
ticks using the proleptic Gregorian calendar and the `0001-01-01` epoch; it
does not pass them through JavaScript `Date`, which would lose sub-millisecond
precision. It independently proves each CIM ISO/tick pair, the handle
ISO/tick pair, expected plan ticks, signed tick delta, both floor-to-10-tick
values, their equality result, and the handle/CIM/expected PID identity. An
observation can be `observed` only when ordinal one's core tuple still exactly
matches, the handle is available, its ID is the expected/current CIM PID,
`HasExited=false`, and the independently calculated normalized ticks are
equal. An unavailable or exited handle, a false core match, a contradictory
field, a negative/out-of-range tick, or a true cross-microsecond difference is
recorded as `unknown`, never as successful diagnostic evidence.

Diagnostic failures use the separate
`synthia-m4f-direct-handle-start-diagnostic-failure.v1` schema and
`M4F_DIRECT_HANDLE_START_DIAGNOSTIC_*` codes. The diagnostic ID may not equal
its cleanup ceremony ID and may not reuse any permanently retired cleanup ID.
For structural replay prevention, config and plan bind an existing owner-only
mode-0700 consumed-evidence root by path, device and inode. The only permitted
evidence path is `<consumed-evidence-root>/<diagnostic-id>`. Execution creates
that directory atomically before local SSH validation; its existence consumes
the diagnostic ID even if the later read-only attempt fails or becomes
unknown. Reusing the ID or choosing another evidence path fails before a
network attempt. Selecting another root changes the diagnostic plan hash and
therefore requires a different exact user confirmation.

The ceremony addresses only the eight `powershell.exe`/`conhost.exe` pairs
that the successful production residue observation correlates one-to-one with
the eight timed-out stages in the frozen staged diagnostic. It intentionally
does not clean older or merely suspicious processes.

## Bound evidence

The v2 plan generator requires exact SHA-256, owner, mode, link count, inode,
device, size, mtime and ctime binding for four inputs. The fourth input is the
single successful handle-start `diagnostic-record.json`; its path and raw-file
SHA-256 are mandatory v2 config fields, not an operator note or sidecar
reference:

| Input | Frozen production artifact | SHA-256 |
|---|---|---|
| admission | `/private/tmp/synthia-m4f-direct-admission-prod-20260828-06.json` | `55732d57bd9c91c61d5a09982928a726754bb8b78e43fee6464dbbd1b62c10c9` |
| residue observation | `/private/tmp/synthia-m4f-direct-identity-residue-prod-20260828-04-evidence/diagnostic-record.json` | `f568ebb8f2febc5896dcdf238c4f3f15f63056766426445eb4bc7852c5353618` |
| staged diagnostic | `/private/tmp/synthia-m4f-direct-staged-diagnostic-prod-20260828-01-evidence/diagnostic-record.json` | `232ed0fd81c67b56f45a5bcbbef83145a4396a96c11d20b979a06a110c0e3213` |
| successful handle-start diagnostic | `<consumed-evidence-root>/<successful-diagnostic-id>/diagnostic-record.json` | `<reviewed-raw-record-sha256>` |

The handle-start record is accepted only with its exact v1 record schema,
`status=observed`, attempt 1, retry disabled, exit zero, no signal/error/
timeout/ambiguity, and empty stderr. Both the record and its observation must
state that process termination, file mutation, Vivado action and hardware
action were false. The record plan SHA must equal the observation diagnostic
plan SHA, and its cleanup plan SHA must equal the observation cleanup plan SHA.

The validator independently compares all 16 diagnostic target core tuples to
the newly derived cleanup targets. For ordinal one it rechecks the exact
expected tuple and start token, decimal CIM and handle ticks, signed delta
within the single unresolved 100-nanosecond digit, and equality after both are
floored to the 10-tick CIM boundary. PID 13644 must be reported present. The
observed computer, identity name and SID must equal Admission. Diagnostic
transport facts must be identical before/after and equal a fresh local capture.
Both diagnostic bound-input facts must be identical before/after; each file is
reopened as a single owner-only mode-0600 file and must still have the same
device, inode, size, timestamps and SHA-256. This includes the frozen cleanup
plan that the diagnostic actually observed.

The v2 plan core and therefore the exact user confirmation bind the diagnostic
record's complete file fact (path, device, inode, owner UID, mode, link count,
size, mtime, ctime and raw SHA-256), diagnostic ID, diagnostic-plan and prior
cleanup-plan SHAs, a semantic SHA over the newly derived cleanup operation, a
SHA over all 16 target core tuples, identity, transport/bound-input hashes,
ordinal-one tick facts, PID-13644 existence and all four false mutation facts.
Replacing the record with identical bytes on another inode, or changing only
its timestamps, invalidates the plan and confirmation before any network
attempt. Replacing the record or changing any other bound fact likewise
requires a newly reviewed plan and a new confirmation. The record and every
referenced bound input are reopened during initial planning, immediately
before the remote attempt, and after the attempt.
Drift before the attempt prevents termination; drift after it is frozen as
partial or unknown and can never be reported as not started.

The residue record is usable only when its eight markers have the fixed
ordinal/phase order, every marker is observed, its remote process exited zero
without a signal, error, timeout or stderr, both `whoami-user` and
`windows-identity` exactly match the admitted name and SID, `complete=true`,
and the CIM current-PID/process payload has the exact expected schema. A
top-level `status=observed` alone is not evidence. The record must also state
that it performed no process termination or hardware action.

The staged record must have the fixed ten-stage order (`wrapper-smoke`, the
eight named timeout stages, and `processes` in its planned position). Only
`wrapper-smoke` and `processes` may be observed. The fixed eight stages must
each be unknown with attempt 1, no retry, invalid output, `ETIMEDOUT`,
`SIGKILL`, and zero stdout/stderr bytes. Filtering for any eight unknown
records is not sufficient.

## Exact target derivation

For each timed-out stage, the generator admits exactly one PowerShell and one
conhost fact whose creation time is between the recorded stage start and 15
seconds after it. The pair must have the same parent PID. Zero, one or more
than two candidates; duplicate PID use; a different name; a missing creation
time or command hash; or more than one command hash per process type makes the
plan invalid.

The current production evidence derives this exact target set:

| Order | Stage | PID | Parent | Peer | Name | Creation UTC |
|---:|---|---:|---:|---:|---|---|
| 1 | identity | 67504 | 57736 | 22844 | powershell.exe | 2026-08-28T04:58:40.2848080Z |
| 2 | volumes | 61560 | 34440 | 61792 | powershell.exe | 2026-08-28T04:59:40.8741360Z |
| 3 | acl-01 | 49588 | 4120 | 49424 | powershell.exe | 2026-08-28T05:00:41.0239510Z |
| 4 | acl-02 | 67232 | 67000 | 66952 | powershell.exe | 2026-08-28T05:01:40.6062450Z |
| 5 | acl-03 | 14444 | 52508 | 49044 | powershell.exe | 2026-08-28T05:02:40.3772930Z |
| 6 | listeners | 45188 | 65484 | 52856 | powershell.exe | 2026-08-28T05:03:42.8926620Z |
| 7 | vivado-fact | 54852 | 33804 | 6696 | powershell.exe | 2026-08-28T05:04:43.8325900Z |
| 8 | bun-fact | 44400 | 25536 | 57848 | powershell.exe | 2026-08-28T05:05:44.3912860Z |
| 9 | identity | 22844 | 57736 | 67504 | conhost.exe | 2026-08-28T04:58:40.2628560Z |
| 10 | volumes | 61792 | 34440 | 61560 | conhost.exe | 2026-08-28T04:59:40.8523060Z |
| 11 | acl-01 | 49424 | 4120 | 49588 | conhost.exe | 2026-08-28T05:00:41.0003760Z |
| 12 | acl-02 | 66952 | 67000 | 67232 | conhost.exe | 2026-08-28T05:01:40.5834390Z |
| 13 | acl-03 | 49044 | 52508 | 14444 | conhost.exe | 2026-08-28T05:02:40.3544660Z |
| 14 | listeners | 52856 | 65484 | 45188 | conhost.exe | 2026-08-28T05:03:42.8693690Z |
| 15 | vivado-fact | 6696 | 33804 | 54852 | conhost.exe | 2026-08-28T05:04:43.8108770Z |
| 16 | bun-fact | 57848 | 25536 | 44400 | conhost.exe | 2026-08-28T05:05:44.3685060Z |

The admitted PowerShell command hash is
`8666564baaf3aa762b67d0eb4b8d288ab2f2611bad85e0046dc5b07455a0b5fc`.
The admitted conhost command hash is
`417222c4a0ecb4d60a457ebe8e26fddf3d5406bffb16a5c59af8eeb241beca51`.
Every plan target also carries a start token calculated over PID, parent PID,
name, creation UTC, command hash and process class. The exact start tokens are
emitted by `--plan`; they are not shortened in the confirmation boundary.

## Hard protection set

No `sshd.exe` is a cleanup target in either plan schema. The plan marks the OpenSSH service
root PID 5720, every other sshd PID present in prod04, and the prod04 observer
process as protected. The executing PowerShell and its complete live ancestor
chain are dynamically protected again at execution time.

PID 13644 (`node.exe`, created
`2026-08-14T08:02:31.2903580Z`) is hard-coded into the protected plan as the
old port-8443 Worker. The only permitted target names are `powershell.exe` and
`conhost.exe`; Node termination is structurally impossible in this ceremony.

The older 03:52/03:55 PowerShell pairs and the 04:07/04:20/04:30 sshd trees are
out of scope. Their presence is not sufficient attribution. Including them
would require a separate read-only observation with a complete parent chain
and a new reviewed plan.

## Effect configuration

The immutable plan declares:

- exactly 16 targets and one remote attempt;
- a 45-second local deadline and empty stdin;
- PowerShell targets before conhost targets;
- `System.Diagnostics.Process.GetProcessById`, handle `StartTime`, `Kill`, and
  bounded `WaitForExit`, rather than a name-wide process command;
- `terminated_exact_handle` as the only accepted PowerShell result;
- either `terminated_exact_handle` or, only for a conhost that was present and
  fully bound during the all-target preflight, `exited_after_preflight` as an
  accepted conhost result;
- all-target preflight before the first effect;
- immediate revalidation before every individual effect;
- stop after the first missing, changed or failed target;
- no retry, replacement target, wildcard, recursive descendant selection or
  broader cleanup after an unknown result;
- no sshd/service, file, registry, ACL, Vivado, bitstream, hardware manager,
  download or programming operation.

The process handle is obtained only after CIM still exactly matches PID,
parent PID, peer relationship, name, creation UTC, command SHA-256 and
`session` class. The handle's independent UTC start time and the plan's CIM
creation UTC are each normalized to UTC ticks at CIM's one-microsecond
precision and must then be exactly equal immediately before `Kill`. This is
the PID-reuse defense: the comparison discards only the single 100-nanosecond
digit that the bound CIM evidence cannot represent, with no wider time window.

The remote script emits strict flushed NDJSON markers for start, pre-identity,
all-target preflight, each exact target, postflight, post-identity and complete.
Local success requires all 22 markers in exact order, all 16 plan-bound start
tokens, an empty trailing fragment, empty stderr and process exit zero.

Only complete newline-terminated NDJSON lines are parsed. A final truncated
line never discards earlier complete markers: its byte length and SHA-256 are
recorded separately as `trailing_fragment_length` and
`trailing_fragment_sha256`, with `stdout_truncated_line=true`. Partial target
markers prove effects only as a continuous prefix of the immutable plan with
exact ordinal, PID, start token and permitted effect. A duplicate, gap,
reorder, wrong token or illegal effect invalidates attribution; an incomplete
run remains `process_termination_state=unknown` even when the separately
listed prefix proves one or more effects.

The record keeps three distinct lists: `kill_performed_pids`,
`already_exited_pids`, and their union `resolved_target_pids`. It never calls a
preflight-bound conhost natural exit a termination. Once the cleanup SSH
attempt begins, any later source, bound-evidence, configuration or transport
drift is frozen as `remote_effect_state=partial_or_unknown`, together with the
remote process evidence, parsed marker prefix and trailing-fragment facts. It
can never be downgraded to `not_started`.

## Expected impact and recoverability

If the exact plan still matches, the intended impact is termination of eight
orphaned diagnostic PowerShell processes followed by resolution of their eight
orphaned conhost peers. A conhost may be terminated by its exact handle, or it
may already have exited naturally after its bound PowerShell peer was
terminated. No production Worker, OpenSSH service or current SSH session is an
intended target.

Process termination is not reversible or resumable. Recovery would mean
starting a new session, but this ceremony is explicitly forbidden from doing
so. These targets are failed read-only diagnostics and carry no durable work
that the ceremony attempts to preserve. If execution becomes unknown after
the preflight marker, operators must inspect the immutable marker evidence and
perform a new read-only observation; they must not replay this confirmation.

## Plan and confirmation schema

The input config has an exact-key schema; unknown fields are rejected. The
plan hashes the two permitted conhost outcomes as part of its effect
configuration:

~~~json
{
  "schema": "synthia-m4f-direct-residue-cleanup-config.v2",
  "ceremony_id": "m4f-direct-residue-cleanup-review-example",
  "admission_config_path": "/private/tmp/synthia-m4f-direct-admission-prod-20260828-06.json",
  "admission_config_sha256": "55732d57bd9c91c61d5a09982928a726754bb8b78e43fee6464dbbd1b62c10c9",
  "residue_record_path": "/private/tmp/synthia-m4f-direct-identity-residue-prod-20260828-04-evidence/diagnostic-record.json",
  "residue_record_sha256": "f568ebb8f2febc5896dcdf238c4f3f15f63056766426445eb4bc7852c5353618",
  "staged_record_path": "/private/tmp/synthia-m4f-direct-staged-diagnostic-prod-20260828-01-evidence/diagnostic-record.json",
  "staged_record_sha256": "232ed0fd81c67b56f45a5bcbbef83145a4396a96c11d20b979a06a110c0e3213",
  "handle_start_diagnostic_record_path": "<consumed-evidence-root>/<successful-diagnostic-id>/diagnostic-record.json",
  "handle_start_diagnostic_record_sha256": "<reviewed-raw-record-sha256>",
  "expected_source_sha256": "<reviewed-cleanup-source-sha256>",
  "expected_transport_source_sha256": "7d85d67480bb58532c8b1c30b80697305a5b470115cbae944c2cf762384ff5df",
  "expected_effective_config_sha256": "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90"
}
~~~

`--plan` is local-only. It returns the exact targets above, every start token,
the effect configuration, protected processes, successful diagnostic binding,
plan SHA-256 and a confirmation with this exact form:

~~~text
SYNTHIA_M4F_RESOLVE_EXACT_DIAGNOSTIC_RESIDUE_ALLOW_PREFLIGHT_BOUND_CONHOST_EXIT:<ceremony-id>:<plan-sha256>:16
~~~

Changing one target, token, evidence digest, source digest, identity, permitted
effect (including the conhost natural-exit rule), setting or protected process
changes the plan hash and invalidates the old confirmation. By approving the
exact confirmation, the user approves exact-handle termination for every
still-matching target and accepts a preflight-bound conhost natural exit as
resolved without representing it as a kill.

Legacy `synthia-m4f-direct-residue-cleanup-config.v1` and
`synthia-m4f-direct-residue-cleanup-plan.v1` remain parseable for historical
audit and for freezing the pre-diagnostic target plan. They cannot enter
`--execute-cleanup`: destructive execution requires config/plan v2 and its
explicit successful-diagnostic binding.

## Review and approval points

1. Reviewer checks the four frozen evidence hashes, including the raw
   successful diagnostic record, and the final source hash.
2. Operator runs local `--plan`; this performs no SSH/network attempt.
3. Reviewer compares all 16 targets, protected PIDs, diagnostic binding,
   effect configuration, recovery statement, plan hash and exact confirmation
   with this document.
4. User explicitly approves that exact confirmation. Approval of the design,
   tests or generic word “cleanup” is not execution approval.
5. Only then may an operator run the one-shot execution form with a new empty
   evidence directory. The confirmation is single-attempt by policy; any
   unknown result requires a new read-only observation and a newly reviewed
   plan.

Local plan form:

~~~text
bun connector/scripts/m4f-direct-residue-cleanup-ceremony.ts \
  --plan --config /absolute/private/cleanup-config.json
~~~

Plan-bound read-only handle-start diagnostic forms:

~~~text
bun connector/scripts/m4f-direct-residue-cleanup-ceremony.ts \
  --plan-handle-start-diagnostic --config /absolute/private/diagnostic-config.json

bun connector/scripts/m4f-direct-residue-cleanup-ceremony.ts \
  --execute-handle-start-diagnostic \
  --config /absolute/private/diagnostic-config.json \
  --confirmation '<exact-read-only-diagnostic-confirmation>' \
  --evidence '<consumed-evidence-root>/<diagnostic-id>'
~~~

Destructive execution form, documented but not authorized:

~~~text
bun connector/scripts/m4f-direct-residue-cleanup-ceremony.ts \
  --execute-cleanup --config /absolute/private/cleanup-config.json \
  --confirmation '<exact-plan-confirmation>' \
  --evidence /private/tmp/new-cleanup-evidence
~~~

Local verification:

~~~text
bun test connector/m4f-direct-residue-cleanup-ceremony.test.ts
bunx tsc --noEmit -p connector/tsconfig.json
git diff --check -- \
  connector/scripts/m4f-direct-residue-cleanup-ceremony.ts \
  connector/m4f-direct-residue-cleanup-ceremony.test.ts \
  connector/M4F-DIRECT-RESIDUE-CLEANUP-CEREMONY.md
~~~

Passing these checks authorizes review only. It does not authorize SSH,
process termination, Vivado or hardware access.
