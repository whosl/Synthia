# M4-F direct Gate-root ceremony

This ceremony creates exactly two new, gate-specific directories on the admitted Windows target:

~~~text
C:\Windows\Temp\synthia-m4f-<gate_id>
D:\synthia-m4f-toolchain-<gate_id>
~~~

The only authorized transport is direct SSH from the Mac to
`admin@100.96.223.49` (`DESKTOP-DVFFB09`). The ceremony does not import,
execute, or trust retired jump-host scripts or earlier evidence.

## Safety boundary

- `--plan` is the default review path. It reads and validates local admission
  inputs only; it does not spawn SSH or write on Windows.
- `--execute-create` requires a new evidence directory and the exact
  v3 confirmation `SYNTHIA_M4F_DIRECT_GATE_ROOTS_CREATE:<gate_id>:<admission_approval_sha256>:<roots_approval_sha256>:<roots_config_sha256>`.
  The final hash binds the complete canonical roots configuration, including
  the service SID, free-space thresholds, all admission artifact hashes and
  the independent roots approval. V1 and v2 are plan-only and fail before
  evidence-directory creation or process spawn if execution is requested.
- The ceremony has three strict, non-interchangeable config branches. Roots
  config v1 accepts only the original direct-admission config/record and
  `synthia-m4f-direct-admission-approval.v1`. Roots config v2 accepts only an
  Admission v2 wrapper config/record and the independent
  `synthia-m4f-direct-admission-v2-approval.v1`, but remains plan-only. Roots
  config v3 adds a separate `synthia-m4f-direct-gate-roots-approval.v1` and is
  the only executable schema. Cross-schema mixtures fail before SSH. Every
  referenced file is exact-mode 0600, SHA-256 bound, and read through one file
  handle.
- The v2/v3 branches separately bind the raw Admission v2 wrapper-config file hash,
  its canonical config hash, the raw base-admission config hash, `admission_id`,
  record hash, three source hashes, script/gzip/loader hashes, effective SSH
  hash, key/known-host facts, host-key fingerprint, environment identity and
  fixed-whoami identity. The later Gate-root WindowsIdentity must match that
  same account and SID; neither identity source can substitute for the other.
- The current private key and known-hosts files are recaptured before and after
  the network attempt. Their complete local facts and content hashes must match
  the approved v1 record's `local_inputs_after` or v2 record's
  `transport_inputs_after` facts exactly. The
  known-hosts entry and reviewed host-key fingerprint are parsed again, and the
  before/after facts are saved in the Gate-root record.
- The direct SSH policy is identical to admission: public-key only, dedicated
  key and known-hosts files, no password or keyboard fallback, no agent, proxy,
  forwarding, multiplexing, weak-crypto warning, or TTY. `WarnWeakCrypto=no`
  keeps stderr empty. `ssh -G` is checked again and its SHA-256
  must equal the independently approved admission hash.
- SSH starts the same fixed, short PowerShell `EncodedCommand` wrapper approved
  by admission and sends the reviewed ASCII business program over standard
  input. Only the 409-byte wrapper is encoded; it sets fail-closed/silent stream
  preferences and UTF-8 output, then uses `Console.In.ReadToEnd()` and
  `ScriptBlock.Create`. The wrapper SHA-256, wrapper and 1182-character command
  lengths, business-input length, and business-input SHA-256 are recorded.
- Before the first create, both target paths must not exist. C: and D: must be
  fixed NTFS volumes with sufficient free space and stable logical-volume,
  volume, partition, and disk identity before and after creation. Under Windows
  PowerShell 5.1 strict mode, both serialized volume-serial fields are sourced
  only from the required, non-empty
  `Win32_LogicalDisk.VolumeSerialNumber`; `Get-Volume` contributes its required
  non-empty `UniqueId` but is never assumed to expose a `SerialNumber`
  property. Disk and partition number, disk `UniqueId`, access-path, online,
  filesystem, drive-type and free-space gates remain mandatory.
- The C: staging ancestor chain has strict owner and replace/write ACL checks.
  The D: ancestor chain is deliberately record-only in this version because
  the existing D: root ACL is a reviewed environmental exception. The newly
  created D: directory receives the same strict exact ACL as the C: directory.
  Windows PowerShell 5.1 may expose localized account-name strings or
  `NTAccount` objects which cannot be translated back to a SID, including
  application-package authorities on `C:\Windows`. The ceremony never consumes
  those display representations. It asks each native ACL object for its owner
  with `GetOwner(SecurityIdentifier)` and for explicit plus inherited rules
  with `GetAccessRules(true, true, SecurityIdentifier)`, then requires every
  returned identity reference to be an exact `SecurityIdentifier`. The fixed
  TrustedInstaller SID is also constructed directly rather than translated
  from an account name. The complete strict owner and rule-rights checks still
  finish before the first directory creation. Directory classification does
  not rely on the provider-added `PSIsContainer` property: Windows PowerShell 5.1 may
  return a decorated object from the initial `Get-Item`, while `.Parent`
  exposes a raw `System.IO.DirectoryInfo` without that property. Every ancestor
  and each newly created root must instead satisfy the explicit CLR
  `System.IO.DirectoryInfo` type check; `FileInfo` and every other runtime type
  fail closed. Reparse, empty-directory, alternate-stream, owner and ACL checks
  remain unchanged.
  Recorded ancestor `FileSystemRights` values use the complete signed Int32
  range emitted by PowerShell's `[int]` conversion, including negative values;
  values outside that range are rejected.
- The `Ancestors` function emits individual fact objects through the normal
  PowerShell pipeline. Each of its four call sites captures that output with
  an explicit `[object[]]$value = @(Ancestors ...)` assignment. This avoids the
  `PSObject` wrapper introduced by `Write-Output -NoEnumerate`, preserves a
  one-element D: chain and a multi-element C: chain as clean flat JSON arrays,
  and leaves the result validator strict against unwrapped or nested values.
- Each new root is non-reparse, empty, has no alternate data stream, has
  inheritance disabled, and has exactly three explicit inheritable allow ACEs:
  Administrators full control, SYSTEM full control, and LocalService
  (`S-1-5-19`) read-and-execute plus synchronize. V2 and v3 accept no other
  service SID, and executable v3 repeats this check in the remote program.
  V1 retains its historical generic non-administrator SID shape for plan-only
  audit compatibility.
- The script contains no Vivado command, bitstream generation, hardware
  connection, hardware download/programming, or network retrieval.
- There is one write-capable network attempt and no retry. Timeout, signal,
  missing/nonzero exit, stderr, source/input drift, or malformed output is
  classified as an unknown remote-write state.
- Cleanup is prohibited. Partial creation is retained as evidence and requires
  a new gate ID plus a new independent review.

## Configuration

Create a repository-external exact-mode 0600 JSON file. The original v1 form
remains supported for plan and historical audit only:

~~~json
{
  "schema": "synthia-m4f-direct-gate-roots-config.v1",
  "gate_id": "m4f-direct-20260828-01",
  "service_identity_sid": "<historical-reviewed-service-sid>",
  "minimum_gate_free_bytes": 10737418240,
  "minimum_backing_free_bytes": 21474836480,
  "admission_config_path": "/absolute/private/direct-admission-config.json",
  "admission_config_sha256": "<sha256>",
  "admission_record_path": "/absolute/private/direct-admission-record.json",
  "admission_record_sha256": "<sha256>",
  "admission_approval_path": "/absolute/private/direct-admission-approval.json",
  "admission_approval_sha256": "<sha256>"
}
~~~

The approval schema is:

~~~json
{
  "schema": "synthia-m4f-direct-admission-approval.v1",
  "decision": "approved",
  "gate_id": "m4f-direct-20260828-01",
  "reviewer": "<independent-reviewer>",
  "approved_at_utc": "2026-08-28T00:00:00.000Z",
  "admission_config_sha256": "<sha256>",
  "admission_record_sha256": "<sha256>",
  "effective_config_sha256": "<approved-sha256>",
  "target_host": "100.96.223.49",
  "target_computer": "DESKTOP-DVFFB09"
}
~~~

For Admission v2 planning, use the same top-level fields with schema
`synthia-m4f-direct-gate-roots-config.v2`. In that branch,
`admission_config_path` and `admission_config_sha256` bind the raw Admission v2
wrapper config, not the base v1 config. V2 binds the complete current Gate-root
execution TCB but is not executable. The wrapper itself binds the base config:

~~~json
{
  "schema": "synthia-m4f-direct-gate-roots-config.v2",
  "gate_id": "m4f-direct-20260828-01",
  "service_identity_sid": "S-1-5-19",
  "minimum_gate_free_bytes": 10737418240,
  "minimum_backing_free_bytes": 21474836480,
  "admission_config_path": "/absolute/private/admission-v2-config.json",
  "admission_config_sha256": "<raw-admission-v2-config-sha256>",
  "admission_record_path": "/absolute/private/admission-v2-record.json",
  "admission_record_sha256": "<raw-admission-v2-record-sha256>",
  "admission_approval_path": "/absolute/private/admission-v2-approval.json",
  "admission_approval_sha256": "<raw-admission-v2-approval-sha256>",
  "expected_source_sha256": "<m4f-direct-gate-roots-source-sha256>",
  "expected_transport_source_sha256": "<m4f-gate-admission-transport-source-sha256>",
  "expected_admission_v2_source_sha256": "<m4f-direct-admission-v2-source-sha256>",
  "expected_wrapper_source_sha256": "<powershell-stdin-wrapper-source-sha256>",
  "expected_remote_script_sha256": "<generated-gate-roots-script-sha256>"
}
~~~

Executable v3 adds these two fields to the v2 shape:

~~~json
{
  "schema": "synthia-m4f-direct-gate-roots-config.v3",
  "roots_approval_path": "/absolute/private/gate-roots-approval.json",
  "roots_approval_sha256": "<raw-gate-roots-approval-sha256>"
}
~~~

The roots approval binds the v3 review preimage, which is the canonical v3
config with only `roots_approval_path` and `roots_approval_sha256` removed.
Excluding those two fields avoids an approval/config hash cycle; the final v3
config and user confirmation then bind the raw approval SHA:

The roots reviewer must be distinct from the Admission v2 reviewer. Reviewer
identifiers are compared after Unicode normalization, trimming, and
case-folding; a matching identifier fails before SSH. These identifiers remain
self-asserted ceremony metadata, so production-grade organizational identity
assurance still requires approvals issued or signed by a trusted identity
system.

~~~json
{
  "schema": "synthia-m4f-direct-gate-roots-approval.v1",
  "decision": "approved",
  "gate_id": "m4f-direct-20260828-01",
  "reviewer": "<independent-roots-reviewer>",
  "approved_at_utc": "2026-08-28T00:00:00.000Z",
  "roots_review_config_sha256": "<canonical-v3-review-preimage-sha256>",
  "gate_roots_source_sha256": "<m4f-direct-gate-roots-source-sha256>",
  "gate_roots_transport_source_sha256": "<m4f-gate-admission-transport-source-sha256>",
  "admission_v2_validator_source_sha256": "<m4f-direct-admission-v2-source-sha256>",
  "gate_roots_wrapper_source_sha256": "<powershell-stdin-wrapper-source-sha256>",
  "gate_roots_remote_script_sha256": "<generated-gate-roots-script-sha256>",
  "effect_binding_sha256": "<remote-effect-binding-sha256>",
  "target_host": "100.96.223.49",
  "target_user": "admin",
  "target_computer": "DESKTOP-DVFFB09",
  "target_identity_name": "desktop-dvffb09\\admin",
  "target_identity_sid": "<approved-admin-sid>"
}
~~~

The current transport and Admission v2 validator hashes must also equal the
source hashes in the independent Admission v2 approval. This distinguishes the
historical Admission evidence from the code that is currently about to perform
the Gate-root write.

The generated v2/v3 remote program carries an `effect_binding_sha256` over only
the immutable remote effect parameters and target identity. It does not embed
the final confirmation hash. This deliberate separation avoids a circular hash:
the exact remote-program SHA can first be reviewed and placed in the config,
then the review preimage, roots approval, final config hash and confirmation
bind that SHA. V1/v2 retain their existing plan representation for audit
compatibility, but neither can execute.

The independent v2 approval has this exact schema:

~~~json
{
  "schema": "synthia-m4f-direct-admission-v2-approval.v1",
  "decision": "approved",
  "gate_id": "m4f-direct-20260828-01",
  "admission_id": "m4f-direct-admission-v2-20260828-01",
  "reviewer": "<independent-reviewer>",
  "approved_at_utc": "2026-08-28T00:00:00.000Z",
  "admission_v2_config_sha256": "<raw-wrapper-config-sha256>",
  "admission_v2_config_canonical_sha256": "<record-config-sha256>",
  "base_admission_config_sha256": "<raw-base-config-sha256>",
  "admission_record_sha256": "<raw-v2-record-sha256>",
  "effective_config_sha256": "<approved-ssh-g-sha256>",
  "source_sha256": "<admission-v2-source-sha256>",
  "transport_source_sha256": "<direct-transport-source-sha256>",
  "loader_source_sha256": "<prod04-loader-source-sha256>",
  "remote_script_sha256": "<recorded-script-sha256>",
  "remote_compressed_sha256": "<recorded-gzip-sha256>",
  "remote_loader_sha256": "<recorded-loader-sha256>",
  "target_host": "100.96.223.49",
  "target_user": "admin",
  "target_computer": "DESKTOP-DVFFB09",
  "target_identity_name": "desktop-dvffb09\\admin",
  "target_identity_sid": "<approved-admin-sid>",
  "host_key_fingerprint": "<approved-host-key-fingerprint>"
}
~~~

The v2 plan prints `admission_contract`, `admission_id`, the raw wrapper hash,
canonical wrapper hash, raw base-config hash, all five Gate-root TCB hashes and
the effect binding. V3 additionally validates and prints the roots approval,
review-config hash, reviewer and approval time. Planning recomputes all values
and fails before any SSH process if one differs. Successful v3 execution emits
`synthia-m4f-direct-gate-roots-record.v3`, a v2 remote result, both approval
chains and the current transport/Admission-validator hashes.

## Plan

~~~text
bun connector/scripts/m4f-direct-gate-roots.ts \
  --plan \
  --config /absolute/private/direct-gate-roots-config.json
~~~

Review the printed paths, service SID, free-space thresholds, three admission
artifact hashes, five current execution-TCB hashes, effect binding, roots
configuration SHA-256, no-cleanup policy, and exact confirmation. Planning is
safe to repeat because it has no remote effect. Any source, transport,
Admission validator, wrapper, generated remote-script, v3 config or roots
approval replacement invalidates the reviewed chain before the first SSH spawn.

## Execute after independent approval

~~~text
bun connector/scripts/m4f-direct-gate-roots.ts \
  --execute-create \
  --config /absolute/private/direct-gate-roots-config.json \
  --confirmation 'SYNTHIA_M4F_DIRECT_GATE_ROOTS_CREATE:<gate_id>:<admission_approval_sha256>:<roots_approval_sha256>:<roots_config_sha256>' \
  --evidence /private/tmp/new-m4f-direct-gate-roots-evidence
~~~

The evidence directory must not already exist. It is created as 0700 and its
files are 0600:

- `gate-roots-record.json`
- `direct-ssh-effective-config.txt`
- `powershell-stdin-wrapper.ps1`
- `remote-gate-roots-script.ps1`
- `remote-gate-roots-result.json`

After any failed write-capable attempt, the recorder preserves every available
artifact on a best-effort basis without replacing the original failure:

- `gate-roots-failure.json`
- `remote-write-attempt.json`
- `direct-ssh-effective-config.txt`
- `powershell-stdin-wrapper.ps1`
- `remote-gate-roots-script.ps1`
- `remote-gate-roots-stdout.bin` and `remote-gate-roots-stderr.bin`, when the
  process returned raw streams
- `remote-gate-roots-process.json`, when process facts are available

If process invocation itself returns no result, the attempt marker explicitly
records that fact and the already-bound effective config and remote script are
still retained. Evidence-file write failures never replace the original
execution failure. Do not rerun or clean either target directory after any
ambiguous write-capable attempt.

## Local verification

~~~text
bun test connector/m4f-direct-gate-roots.test.ts
bun test connector/m4f-direct-admission-v2.test.ts
bun test connector/m4f-gate-admission-transport.test.ts
bunx tsc --noEmit -p connector/tsconfig.json
~~~

## Residual risks

- The ceremony has not yet been executed on the target. Local tests prove
  construction, fail-closed validation, and evidence handling, not the actual
  Windows ACL, PowerShell 5.1, storage, or administrative-token behavior.
- D: ancestor ACLs are evidence only in this version. A reviewer must accept
  that exception for the exact host before execution.
- POSIX same-handle and pre/post binding does not create an immutable snapshot
  against another process with the same local account authority. Run from a
  controlled account and protected parent directory.
- This creates empty governed roots only. It does not install the Worker,
  launch Vivado, generate a bitstream, connect to hardware, or establish the
  end-to-end self-evolution production flow.
