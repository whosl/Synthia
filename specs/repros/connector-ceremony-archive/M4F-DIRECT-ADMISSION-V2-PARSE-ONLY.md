# M4-F Direct Admission v2 PowerShell Parse-Only Gate

This gate verifies the exact generated Admission v2 target script with the
real Windows PowerShell 5.1 parser before a new read-only admission attempt.
It is direct-only: `admin@100.96.223.49` / `DESKTOP-DVFFB09`. It never uses the
retired 140 jump host or any retired evidence as authorization.

The consumed production parse ID
`m4f-direct-admission-v2-parse-prod-20260828-01` is permanently retired after
its successful evidence was frozen. It cannot authorize a later generator
revision or Admission ID. Every successor requires a new parse ID, plan,
confirmation and evidence directory.

The target script is generated locally from an exact-mode, SHA-bound Admission
v2 config and its bound base admission config. The gate binds its own source,
the Admission v2 generator source, and the direct transport source. It audits
the same `ssh -G`, private key, known-hosts entry, target identity and host-key
fingerprint used by Admission v2.

On Windows, the source is decompressed in memory and passed to
`System.Management.Automation.Language.Parser.ParseInput`. If parsing has no
errors, `ScriptBlock.Create` constructs the script block. The block is never
invoked: the loader contains no `&$b`, `.Invoke`, dot-source, file write,
process termination, Vivado, hardware-manager, download or programming path.
Success requires Windows PowerShell Desktop 5.1, exact source length and
SHA-256, zero parse errors, both AST types, and
`target_body_not_invoked=true`.

Execution is a single, empty-stdin, 30-second read-only SSH attempt. Timeout,
transport ambiguity, stderr, source/input drift or malformed output is frozen
with no retry. Evidence is a new 0700 directory with 0600 config, target source,
loader, effective SSH output, raw streams, process record and result/failure.

## Configuration contract

Create a repository-external exact-mode 0600 file. It binds the raw Admission
v2 wrapper config and all three executable trust-base sources:

```json
{
  "schema": "synthia-m4f-direct-admission-v2-parse-only-config.v1",
  "parse_id": "m4f-direct-admission-v2-parse-prod-20260828-02",
  "admission_v2_config_path": "/private/tmp/new-admission-v2.json",
  "admission_v2_config_sha256": "<raw-wrapper-sha256>",
  "expected_source_sha256": "<parse-gate-source-sha256>",
  "expected_admission_v2_source_sha256": "<admission-v2-source-sha256>",
  "expected_transport_source_sha256": "<direct-transport-source-sha256>"
}
```

The wrapper must itself bind a new, non-retired Admission v2 ID and an
exact-mode 0600 base-admission config with the frozen direct target, account,
SID, host-key fingerprint and effective SSH hash. Planning freezes both bound
file facts, all trust-base hashes, target-source hash/length, compressed and
loader hashes, command hash/length, timeout and exact confirmation. Planning
does not create evidence or start a process.

On execution, both config files, all sources, private key, known-hosts file and
effective SSH configuration are revalidated before the remote parse and again
after it. Success and failure records freeze the before/after config facts and
transport inputs, effective and remote process facts, `attempt=1`,
`timeout_ms=30000`, `stdin_length=0`, source identity and the explicit
no-invocation/no-hardware/no-termination claims. A parser result with exit 2,
zero stderr and exact `parse_rejected` JSON is recorded as a deterministic
target parse rejection, not a transport failure. Other nonzero exits remain
transport failures.

Local plan:

```text
bun connector/scripts/m4f-direct-admission-v2-parse-only.ts \
  --plan --config /private/tmp/new-parse-config.json
```

Execute only after source review:

```text
bun connector/scripts/m4f-direct-admission-v2-parse-only.ts \
  --execute-parse-only --config /private/tmp/new-parse-config.json \
  --confirmation '<exact-plan-confirmation>' \
  --evidence /private/tmp/new-parse-evidence
```

Passing this gate authorizes only a separately planned read-only Admission v2
attempt. It does not authorize cleanup, Gate-root creation, Worker launch,
Vivado, bitstream generation or hardware access.

Local verification:

```text
bun test connector/m4f-direct-admission-v2-parse-only.test.ts \
  connector/m4f-direct-admission-v2.test.ts
bunx tsc --noEmit -p connector/tsconfig.json
```
