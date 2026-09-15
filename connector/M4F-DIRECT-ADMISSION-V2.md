# M4-F direct admission v2

This is a review-only replacement transport for the original stdin-based
direct admission. It does not authorize a production run.

The first production v2 attempt
(`m4f-direct-admission-v2-prod-20260828-01`) is permanently frozen as
`read_only_unknown` and must never be retried. Windows PowerShell 5.1 rejected
an undelimited `return[ordered]` expression during `ScriptBlock.Create`, before
the business script executed. This source delimits both return expressions.
Any later attempt requires a new admission ID, new plan, and new evidence
directory, and must first pass a real Windows PowerShell 5.1 parse-only gate.

The second production attempt (`m4f-direct-admission-v2-prod-20260828-02`)
is also permanently frozen as `read_only_unknown` and cannot be reused. Its
complete read-only snapshot exposed that .NET `FileSystemRights` is a signed
32-bit flags value: legitimate high-bit ACL rights are emitted as negative
integers. The old validator incorrectly required non-negative rights. The
validator now accepts the exact signed 32-bit domain and rejects values outside
it. Any successor uses a new admission ID and a new parse-only predecessor.

`prod-04` proved the direct compressed transport on the real Windows
PowerShell 5.1 target: all eight diagnostic phases were observed in 2.023
seconds, stderr was empty, and fixed whoami plus WindowsIdentity exactly matched
the admitted account and SID. Admission v2 reuses that exact in-memory
gzip/base64 loader implementation and binds the loader source SHA-256.

## Identity authority

The single target script performs identity checks before every business query:

1. Require environment `COMPUTERNAME=DESKTOP-DVFFB09` and `USERNAME=admin`.
   `USERDOMAIN` is recorded only as an environment fact; `WORKGROUP` is not a
   login authority.
2. Require case-insensitive `SystemRoot=C:\Windows` and the fixed absolute
   executable `C:\Windows\System32\whoami.exe`.
3. Execute only `whoami.exe /user /fo csv /nh`; require exit zero and exactly
   one explicitly parsed CSV row.
4. Require exact lowercase `desktop-dvffb09\admin` and the exact admitted SID.

WindowsIdentity is intentionally absent from v2. It was useful corroborating
evidence in `prod-04`, but omitting it makes it impossible for WindowsIdentity
to substitute for a missing or incorrect whoami result.

## One-session business snapshot

After identity succeeds, the same PowerShell process captures the listed
business facts from the original v1 admission:

- C: and D: volume type, free/total bytes and filesystem;
- each ACL root's existence, owner SID, protection/reparse flags and every
  sorted access rule including SID, type, rights and inheritance metadata;
- listeners on ports 8443 and 18443;
- relevant Bun, Node, Vivado and hardware-server processes, including PID,
  parent PID, executable path and UTC creation time;
- Vivado and Bun executable existence, length, SHA-256 and file version.

The target emits compact exact-shape JSON to keep the encoded Windows command
bounded. The Mac expands it into the full
`synthia-m4f-direct-target-admission-snapshot.v2` schema, then applies strict
semantic validation. Object key order is deliberately irrelevant, but every
object must have the exact allowed key set. The ACL-root array has the exact
approved length and path order; volumes must be the closed unique C:/D: set;
listener and process arrays are closed to the approved ports and process names,
while their order is not an authorization fact. The target sorts these arrays
for deterministic evidence. Every ACL rule is expanded without truncation.
Missing, extra-key, out-of-scope or malformed data fails closed.

This compaction preserves every listed ACL, volume, listener, process and
Vivado/Bun file field. It intentionally does not preserve v1
`stage_elapsed_ms`: v2 is one compressed business query rather than the v1
per-stage stopwatch transport, and records only total remote elapsed time.

The layout is deliberately production-specific and must exactly match:

~~~text
C:\Windows\Temp
D:\synthia-worker
D:\Xilinx\Vivado\2021.1
D:\Xilinx\Vivado\2021.1\bin\vivado.bat
D:\synthia-worker\runtime\bun-1.3.14\bun.exe
~~~

Hard-coding these already validated values removes an unnecessary remote config
decoder and keeps all path facts inside the 6,500-character command boundary.
Any layout drift is rejected locally before SSH.

## Transport and safety boundary

- Direct target only: `admin@100.96.223.49 / DESKTOP-DVFFB09`.
- One remote SSH attempt, one compressed `EncodedCommand`, stdin exactly empty.
- 240-second local deadline with `SIGKILL`; no retry. Timeout or any ambiguous
  process result remains `read_only_unknown`.
- Progress, Information, Verbose, Debug and Warning streams are silenced by the
  `prod-04` loader before decompression. The business script uses Stop semantics
  and UTF-8 stdout.
- For the production layout and admitted SID, the generated script is 2,880
  bytes, gzip payload 1,441 bytes, loader 2,240 characters and command 6,066
  characters. Generation fails closed above 6,500, leaving at least 1,691
  characters below the Windows 8,191 boundary; this concrete command leaves
  2,125 characters.
- Read-only queries only. No remote file/registry/service/ACL mutation, process
  termination, cleanup, Vivado invocation, bitstream generation, hardware
  manager, download or programming.

## Binding and evidence

The v2 config binds three exact source files: the v2 implementation, original
direct SSH transport, and `prod-04` loader implementation. The original v1
admission config is opened once and bound by SHA-256, device, inode, owner, mode,
link count, size, mtime and ctime. Key and single-entry known-hosts facts plus
the audited `ssh -G` output remain mandatory and are checked again around the
remote attempt.

Execution requires the exact plan confirmation and a new evidence directory.
The directory is 0700 and every artifact is 0600. It freezes the canonical v2
config, target script, loader, compressed payload, effective-config stdout and
stderr, remote stdout and stderr, both process records, and either the full
admission record or failure record. Raw compact stdout is retained even though
the record contains the expanded full snapshot.

Failure evidence also freezes transport inputs and the bound base-admission
config before and after any remote attempt (or explicit `null` after-values
when execution never reached that observation), so an independent reviewer can
verify drift handling from the evidence bundle alone.

## Configuration and review-only commands

### Mandatory Windows PowerShell 5.1 parse-only predecessor

Every new production Admission v2 ID must first pass
`m4f-direct-admission-v2-parse-only.ts` for the exact generated target script.
Its exact-mode 0600 config binds the raw Admission v2 wrapper config plus the
parse-gate, Admission v2 generator and direct-transport source hashes:

~~~json
{
  "schema": "synthia-m4f-direct-admission-v2-parse-only-config.v1",
  "parse_id": "m4f-direct-admission-v2-parse-prod-20260828-02",
  "admission_v2_config_path": "/private/tmp/new-admission-v2.json",
  "admission_v2_config_sha256": "<raw-wrapper-sha256>",
  "expected_source_sha256": "<parse-gate-source-sha256>",
  "expected_admission_v2_source_sha256": "<admission-v2-source-sha256>",
  "expected_transport_source_sha256": "<direct-transport-source-sha256>"
}
~~~

Planning freezes the two bound config-file facts, three trust-base hashes,
target source/hash, compressed payload, loader and command. It does not start a
process. Execution is one 30-second, empty-stdin direct SSH parse and
`ScriptBlock.Create`; the constructed target is never invoked. Success requires
Desktop PowerShell 5.1, zero parse errors, exact source identity and
`target_body_not_invoked=true`:

~~~text
bun connector/scripts/m4f-direct-admission-v2-parse-only.ts \
  --plan --config /private/tmp/new-parse-config.json

bun connector/scripts/m4f-direct-admission-v2-parse-only.ts \
  --execute-parse-only --config /private/tmp/new-parse-config.json \
  --confirmation '<exact-plan-confirmation>' \
  --evidence /private/tmp/new-parse-evidence
~~~

The 0700/0600 evidence freezes effective and remote process facts, both config
facts and transport inputs before/after, all source identities, attempt,
timeout, empty-stdin and the parse result/failure. A deterministic
`parse_rejected` result is separate from a transport failure. Neither result
authorizes target-script execution. The full contract is in
`connector/M4F-DIRECT-ADMISSION-V2-PARSE-ONLY.md`.

~~~json
{
  "schema": "synthia-m4f-direct-admission-v2-config.v1",
  "admission_id": "m4f-direct-admission-v2-prod-20260828-03",
  "admission_config_path": "/absolute/private/path/m4f-direct-admission.json",
  "admission_config_sha256": "<exact-sha256>",
  "expected_source_sha256": "<reviewed-v2-source-sha256>",
  "expected_transport_source_sha256": "<reviewed-v1-transport-source-sha256>",
  "expected_loader_source_sha256": "<reviewed-prod04-loader-source-sha256>"
}
~~~

Local plan only:

~~~text
bun connector/scripts/m4f-direct-admission-v2.ts \
  --plan --config /absolute/private/admission-v2.json
~~~

The execution form exists for a separately reviewed maintenance window only:

~~~text
bun connector/scripts/m4f-direct-admission-v2.ts \
  --execute-read-only --config /absolute/private/admission-v2.json \
  --confirmation '<exact-plan-confirmation>' \
  --evidence /private/tmp/new-admission-v2-evidence
~~~

Local verification:

~~~text
bun test connector/m4f-direct-admission-v2.test.ts \
  connector/m4f-direct-identity-residue-followup.test.ts \
  connector/m4f-gate-admission-transport.test.ts
bunx tsc --noEmit -p connector/tsconfig.json
git diff --check -- \
  connector/scripts/m4f-direct-admission-v2.ts \
  connector/m4f-direct-admission-v2.test.ts \
  connector/M4F-DIRECT-ADMISSION-V2.md
~~~

Passing these checks authorizes review only, not residue cleanup, admission
execution, Vivado, bitstream or hardware access.
