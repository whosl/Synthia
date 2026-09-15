# M4-F direct Gate admission transport

The only authorized admission topology is:

~~~text
Mac -> admin@100.96.223.49 (DESKTOP-DVFFB09)
~~~

The previous intermediate-host topology is retired. This tool contains no intermediate host, intermediate private-key path, multiplexed historical session, or old evidence dependency. It never reads, modifies, queries, cleans, or reclassifies an earlier evidence directory.

## Safety boundary

- The target address is fixed to 100.96.223.49, port 22, user admin, and Windows hostname DESKTOP-DVFFB09.
- The configuration must supply the exact lowercase Windows login identity, its SID, a dedicated local private-key path, a dedicated one-entry local known_hosts path, and the independently reviewed SSH host-key fingerprint.
- Both local input files must be regular, non-symlink, single-link files owned by the current macOS user with exact mode 0600. Each read is bound to one open file handle, and complete bytes, device, inode, owner, mode, link count, size, mtime, and ctime are recorded before and after the one network attempt and must remain equal.
- The dedicated known_hosts file must contain exactly one unhashed entry for 100.96.223.49. The key blob is decoded and its SHA-256 fingerprint must equal the reviewed configuration.
- Before any network action, ssh -G output is recorded and checked for the exact host, port, user, identity, known-hosts sources, timeout, attempt count, disabled keepalive, zero password prompts, disabled identity agent, identities-only, public-key-only authentication, disabled password/keyboard-interactive/GSSAPI/hostbased authentication, strict host-key checking, no forwarding, no multiplexing/persistence, no weak-crypto warning, and no TTY. `ServerAliveInterval=0` disables SSH keepalive completely. `ServerAliveCountMax=4` remains explicitly pinned and audited but is inert while the interval is zero. The `-04` attempt ended near 30 seconds under 10/2, but its stderr was not frozen. The `-05` attempt ended about 152 seconds after evidence-directory creation under 30/4 and froze OpenSSH's `server not responding` stderr. The `-05` facts strongly bind the local termination to the keepalive cutoff, while remote completion remains unknown. The implementation therefore no longer uses SSH response probes as a deadline. The only execution deadline is the single local 240-second process timeout. `WarnWeakCrypto=no` prevents a macOS SSH warning from contaminating the otherwise-empty stderr evidence. On macOS OpenSSH, explicitly disabled `ProxyCommand=none` and `ProxyJump=none` are omitted from `ssh -G`; absence is required, while any emitted proxycommand or proxyjump value is rejected.
- The first approved observation may set expected_effective_config_sha256 to null. Its reviewed hash must be pinned for every later Gate.
- The only remote program is admission_snapshot. Windows OpenSSH does not reliably execute script input with `PowerShell -Command -`, so SSH starts a fixed, short `EncodedCommand` wrapper instead. Only this 409-byte reviewed wrapper is encoded; it sets fail-closed and silent stream preferences plus UTF-8 output, reads the reviewed ASCII program with `Console.In.ReadToEnd()`, and executes it with `ScriptBlock.Create`. The wrapper SHA-256 (`21ea7ae211c4433bced41512d6b54d37b259a7700ae3dffe63147c6ab5178407`), wrapper length, 1182-character command length, input length, and input SHA-256 are recorded. The business program remains on stdin, avoiding the Windows command-line length limit. It checks the exact Windows hostname/name/SID before reading C:/D: disk facts, configured ACL paths, listeners on 8443/18443, relevant Worker/Vivado processes, and configured Vivado/Bun file facts.
- The remote program contains no general command input, filesystem write, Vivado launch, bitstream generation, hardware connection, download, or programming operation.
- There is exactly one network attempt. Timeout, signal, missing exit status, nonzero exit, stderr, malformed output, input drift, or identity drift is unknown and never retried automatically.
- The single read-only network attempt has a 240-second local timeout. This is
  based on observed Windows startup, three sequential ACL reads, CIM disk and
  process queries, listener inspection, and Vivado file hashing; the earlier
  90-second limit was below the measured aggregate upper bound. The final and
  still unique JSON object includes nonnegative elapsed milliseconds for
  identity, volumes, ACL, listeners, relevant processes, Vivado, Bun, and the
  total before serialization. No progress lines or partial JSON are emitted.

## Configuration

Create a repository-external JSON file. All angle-bracket values must come from separately reviewed facts and must not be guessed.

~~~json
{
  "schema": "synthia-m4f-direct-admission-config.v1",
  "gate_id": "m4f-direct-admission-20260828-01",
  "target": {
    "host": "100.96.223.49",
    "port": 22,
    "user": "admin",
    "computer_name": "DESKTOP-DVFFB09",
    "identity_name": "desktop-dvffb09\\admin",
    "identity_sid": "<reviewed-target-sid>",
    "identity_file": "/absolute/private/path/to/dedicated-target-key",
    "known_hosts_file": "/absolute/private/path/to/target-known-hosts-single-entry",
    "known_hosts_host_token": "100.96.223.49",
    "host_key_fingerprint": "<reviewed-target-sha256-fingerprint>",
    "expected_effective_config_sha256": null,
    "acl_paths": [
      "C:\\Windows\\Temp",
      "D:\\synthia-worker",
      "D:\\Xilinx\\Vivado\\2021.1"
    ],
    "vivado_executable": "D:\\Xilinx\\Vivado\\2021.1\\bin\\vivado.bat",
    "bun_executable": "D:\\synthia-worker\\runtime\\bun-1.3.14\\bun.exe"
  }
}
~~~

The target ACL output must correspond one-for-one, in configuration order, to acl_paths. Empty, missing, duplicated, reordered, or extra paths are rejected.

## Execute

Do not execute until a reviewer has approved the exact configuration, local input facts, and a fresh repository-external evidence directory name.

~~~text
bun connector/scripts/m4f-gate-admission-transport.ts \
  --execute-admission \
  --config /absolute/private/path/m4f-direct-admission.json \
  --evidence /private/tmp/new-m4f-direct-admission-evidence
~~~

The evidence directory must not already exist. It is created as 0700 and contains 0600 files:

- admission-record.json
- admission-config.canonical.json
- direct-ssh-effective-config.txt
- powershell-stdin-wrapper.ps1
- target-admission-stdin.ps1
- target-admission-snapshot.json

On failure, `admission-failure.json` is written with `retry_permitted=false`.
When the failure comes directly from either SSH invocation, the exact stderr
already bounded by the 8 MiB process-output limit is additionally frozen as
`ssh-stderr.raw` with mode 0600. Its byte length and SHA-256 must match the
`process` fields in `admission-failure.json`; otherwise evidence creation fails
closed. This file may contain host/user/path diagnostics and therefore remains
inside the 0700 evidence directory. It never contains or duplicates the
PowerShell business stdin. Never rerun automatically after an ambiguous network
outcome.

## Local verification

~~~text
bun test connector/m4f-gate-admission-transport.test.ts
bunx tsc --noEmit -p connector/tsconfig.json
~~~

## Residual risks

- The transport has not yet been executed against 100.96.223.49. Local tests prove policy construction and validation, not reachability, the real host key, the real Windows SID, or PowerShell behavior on that host.
- Same-handle and pre/post POSIX file facts detect local input drift but do not create an immutable filesystem snapshot. A process already holding the same macOS user authority could theoretically replace and restore a pathname between checks. Run from a controlled account with a protected parent directory; a future hardening can pass sealed descriptors through a small reviewed native launcher.
- The first effective-config hash still requires independent human review before pinning.
- Admission evidence is read-only preflight evidence. It does not establish Worker release, mTLS, Vivado license/toolchain attestation, self-evolution correctness, or production Gate completion.
