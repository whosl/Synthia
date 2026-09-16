# M4-F direct staged read-only diagnostic

This diagnostic isolates admission failures without repeating the earlier
all-in-one admission command. Its only supported topology is:

~~~text
Mac -> admin@100.96.223.49 (DESKTOP-DVFFB09)
~~~

It contains no route through `100.66.198.60` or `192.168.31.66`, does not read
or reuse any earlier evidence, and must always write to a new evidence
directory. In particular, the ambiguous `-06` admission remains permanently
`UNKNOWN` with no retry; this tool produces a separate diagnostic record and
does not reinterpret `-06`.

## Safety boundary

- The default mode is `--plan`. Planning performs local validation only and
  prints the exact confirmation string required for execution.
- Execution requires `--execute-read-only` plus that exact confirmation. A
  wrong or stale confirmation is rejected before evidence creation or network
  access.
- The target, user, Windows computer/name/SID, private key, one-entry
  `known_hosts`, host-key fingerprint, ACL paths, Vivado path, and Bun path are
  inherited from a separately reviewed direct-admission configuration.
- The admission configuration is read through one file handle and bound to its
  SHA-256, device, inode, owner, mode, link count, size, mtime, and ctime. It,
  the private key, `known_hosts`, and the diagnostic source are checked for
  drift throughout execution.
- The diagnostic configuration carries the reviewed SHA-256 of this diagnostic
  source. The confirmation token binds that field, and execution rehashes the
  current source before evidence creation or network access; a stale token or
  changed implementation fails closed.
- The imported direct-transport implementation is independently bound by
  `expected_transport_source_sha256`. Its exact bytes are checked before
  evidence creation, before every remote stage, and at completion because it
  defines the SSH options, wrapper, input capture, and effective-config audit.
- The diagnostic configuration also carries the separately reviewed exact
  `ssh -G` output SHA-256. The local effective configuration must both pass the
  field audit and match that hash before the first remote stage.
- SSH keepalive is disabled (`ServerAliveInterval=0`). Every remote stage uses
  a new SSH process with a 60-second hard timeout, is attempted no more than
  once, and is never retried automatically. The local runner uses `SIGKILL` at
  the deadline so a process cannot extend the local wait by ignoring `SIGTERM`.
- The PowerShell whitelist only reads identity, volume, ACL, listener,
  process, and executable-file facts. It does not write the Windows
  filesystem, launch Vivado, generate a bitstream, connect to hardware,
  download data, or program a device.
- A stage timeout, nonzero exit, signal, stderr, malformed JSON, or invalid
  nested fact is recorded as `unknown`. The tool then proceeds to the next
  *different* fixed read-only stage. It never retries the unknown stage.
- Unexpected local drift or another top-level failure stops the remaining
  stages and freezes `diagnostic-failure.json` with the partial stage records.
  If a failure occurs after a stage process returns but before its normal
  record is complete, `current_stage_process` still binds the raw stdout and
  stderr lengths and SHA-256 values.

## Fixed stages and upper bounds

Stages are ordered as follows:

1. `wrapper-smoke`: prove that the fixed stdin wrapper can return one constant
   token; it intentionally does not call the Windows identity API.
2. `identity`: read and verify the exact computer name, login name, and SID.
3. `volumes`: read the `C:` and `D:` logical-volume facts.
4. One `acl-NN` stage per configured ACL path, preserving configuration order.
5. `listeners`: read TCP listeners on ports 8443 and 18443.
6. `processes`: read relevant Bun, Node, Vivado, Vivado Lab, and hardware-server
   process facts.
7. `vivado-fact`: read the configured Vivado executable's existence, size,
   SHA-256, and file version.
8. `bun-fact`: read the configured Bun executable's equivalent file facts.

At most 16 ACL paths are accepted, so there are at most 23 remote stages. With
the normal three ACL paths there are 10 remote connections and a maximum remote
elapsed time of 600 seconds. The absolute maximum is 1,380 seconds. The local
`ssh -G` effective-configuration audit is not a network connection.

## Configuration and planning

Create a repository-external 0600 JSON file which binds an already reviewed
direct-admission configuration:

~~~json
{
  "schema": "synthia-m4f-direct-staged-diagnostic-config.v1",
  "diagnostic_id": "m4f-direct-staged-20260828-01",
  "admission_config_path": "/absolute/private/path/m4f-direct-admission.json",
  "admission_config_sha256": "<sha256-of-exact-admission-config-bytes>",
  "expected_source_sha256": "<sha256-of-final-reviewed-diagnostic-source>",
  "expected_transport_source_sha256": "7d85d67480bb58532c8b1c30b80697305a5b470115cbae944c2cf762384ff5df",
  "expected_effective_config_sha256": "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90"
}
~~~

Plan without network access:

~~~text
bun connector/scripts/m4f-direct-admission-staged-diagnostic.ts \
  --plan \
  --config /absolute/private/path/m4f-direct-staged-diagnostic.json
~~~

Review the returned target, identity, stage list, admission-config fact, stage
count, worst-case elapsed time, and confirmation string before execution.

## Read-only execution

Use the exact confirmation emitted by the plan and a path that does not exist:

~~~text
bun connector/scripts/m4f-direct-admission-staged-diagnostic.ts \
  --execute-read-only \
  --config /absolute/private/path/m4f-direct-staged-diagnostic.json \
  --confirmation '<exact-plan-confirmation>' \
  --evidence /private/tmp/new-m4f-direct-staged-evidence
~~~

The root and each stage directory are mode 0700. All files are mode 0600. Each
stage directory contains:

- `stdin.ps1`: the exact ASCII program sent to the fixed wrapper;
- `stdout.raw` and `stderr.raw`: exact bounded process output bytes;
- `stage-record.json`: status, timing, script/wrapper facts, transport facts,
  exit/signal/timeout data, and stdout/stderr lengths and SHA-256 values.

The root also contains the canonical diagnostic config, fixed stage plan,
PowerShell wrapper, audited `ssh -G` output/process evidence, and either
`diagnostic-record.json` or `diagnostic-failure.json`. A completed record may
contain `unknown` stages; it is diagnostic evidence, not admission approval and
not authorization to run Vivado.

## Local verification

~~~text
bun test connector/m4f-direct-admission-staged-diagnostic.test.ts
bun test connector/m4f-gate-admission-transport.test.ts connector/m4f-direct-gate-roots.test.ts
bunx tsc --noEmit -p connector/tsconfig.json
~~~

## Interpretation

- `completed`: every stage produced a valid, identity-bound read-only fact.
- `completed_with_unknown`: all planned stages were attempted once, but one or
  more results were ambiguous or invalid. Do not retry them automatically.
- `diagnostic-failure.json`: local binding or orchestration failed before the
  plan completed. Preserve all partial evidence and review before any new run.

This result only identifies the admission boundary. It does not certify a
Worker release, Vivado license or synthesis, mTLS, the evaluation ledger, or a
self-evolution end-to-end flow.
