# M4-F Gate-root candidate-10 staged read-only diagnostic

Candidate 10 is a new diagnostic lineage after candidate 09 timed out with no
stdout. It must not reuse candidate 09's config, approval, execution evidence,
or confirmation. Its only topology is direct Mac to
`admin@100.96.223.49` (`DESKTOP-DVFFB09`). Candidate 10 observes candidate
09's actual frozen target, so `gate_id` remains `prod-20260828-03`; only the
diagnostic ID, confirmation, config, and evidence directory are new.

The business script uses one SSH attempt and a 30-second local deadline. Every
potentially blocking stage emits a strict NDJSON `begin` marker, immediately
flushes it, then emits and flushes an `end` marker if the synchronous call
returns. Identity is the first stage, so even a blocked `WindowsIdentity` call
leaves a checkpoint. The remaining stages isolate the initial process
observation, C and D volume facts, both target existence checks, C and D
ancestor walks, the in-memory Root-Acl template, the
`C:\Windows\Temp` stream probe, and the final process observation. Ordinary
read failures emit `failed` and continue to distinct stages; an identity
mismatch is fail-closed. A local parser enforces exact stage order and
phase/status pairs. It accepts a strict complete prefix, including one ending
at a `begin` marker, while ignoring only an incomplete final byte tail.

Process observations are limited to `powershell.exe`, `conhost.exe`, and
`sshd.exe`. They return PID, parent PID, creation/start token, command-line
presence, and a lowercase command-line SHA-256. Raw command lines are never
returned. Candidate-09 attribution is deliberately `possible_not_proven`: a
PowerShell start inside the frozen candidate-09 attempt window is the primary
signal, parent/child links extend it to conhost/sshd, and wrapper-command hashes
are supporting evidence only. This avoids treating every historical generic
stdin wrapper as candidate 09 and avoids missing sessions whose Windows command
line represents an outer default-shell command.

The remote program contains no filesystem, ACL, service, process, Vivado, or
hardware mutation command. It checks a 20-second deadline between synchronous
stages. This is not hard cancellation: Windows PowerShell 5.1 cannot interrupt
a hung synchronous CIM, storage, or ACL provider call without a separate
runspace/process or a termination operation. Both are forbidden here.
Therefore `remote_synchronous_call_cancellation` and
`local_timeout_may_leave_remote_process` are deliberately `UNKNOWN`. The
local timeout captures partial markers and never retries; it cannot prove the
remote PowerShell stopped. A transcript is `observed` only if every stage has
one `begin` and one successful `observed` end, followed by the terminal marker
and a clean process exit. A terminal marker containing any failed stage remains
`partial_unknown`.

Before the remote attempt, the executor captures and validates the private key
and known-hosts inputs using the direct-transport policy. Owner, mode, link
count, file hash, host token, and host-key fingerprint are checked. Inputs are
captured again immediately before the remote call and after it. Pre-remote
drift fails closed; post-remote drift makes the result an error. The SSH
effective config is separately audited and hash-pinned.

The candidate config freezes the diagnostic source, its test source, the
Gate-root source, direct transport source, admission config, effective SSH
config, candidate-09 diagnostic hash, and the candidate-09 start/end window.
The exact confirmation binds the candidate ID, canonical config hash,
canonical plan hash, diagnostic source hash, and test source hash. Planning is
local-only. The `--execute-read-only` entry requires that exact confirmation
and a new evidence directory. The directory is created exclusively with mode
0700; every file is created without overwrite with mode 0600. Timeout and
failure paths preserve raw stdout/stderr, process facts, parsed markers (or a
parse-failure record), source/config/effective-config hashes, transport-input
facts, and the remote script. This implementation and its CLI are tested
offline here; no candidate-10 plan or execution has been invoked.

Local verification:

~~~text
bun test connector/m4f-direct-gate-roots-staged-diagnostic.test.ts
bunx tsc --noEmit -p connector/tsconfig.json
~~~
