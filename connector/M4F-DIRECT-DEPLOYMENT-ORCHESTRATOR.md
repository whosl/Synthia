# M4-F direct deployment orchestrator

This orchestrator prepares the isolated Windows/Vivado Gate Worker after, and
only after, the reviewed direct Gate-root ceremony has created its two roots.
It targets only `admin@100.96.223.49` (`DESKTOP-DVFFB09`) and the isolated
`https://100.96.223.49:18443` sidecar. It never routes through the retired 140
jump host and never modifies the existing `D:\synthia-worker` deployment.

The implementation is
`connector/scripts/m4f-direct-deployment-orchestrator.ts`. `plan` is the
default review mode and performs no SSH/SCP call. This repository contains no
production deployment config, certificate, private key, password, or generated
evidence.

## Safety contract

- The config binds a successful
  `synthia-m4f-direct-gate-roots-record.v3`, the same gate ID, both exact root
  paths, the direct-admission config, every local artifact hash, the local
  orchestrator source hash, and the reviewed remote-program hash. The release
  layout is fixed to
  `C:\Windows\Temp\synthia-m4f-<gate-id>\release-<release-version>` and its
  active config to `worker-18443.active.json`; the backing root is fixed to
  `D:\synthia-m4f-toolchain-<gate-id>`. Windows paths accept only canonical
  absolute drive paths with `\` separators. Empty, `.`, `..`, ADS/extra-colon,
  mixed-separator, control/invalid-character, trailing-dot/space and reserved
  device-name segments are rejected before confirmation or transport.
- The plan prints the one required execution value:
  `SYNTHIA_M4F_DIRECT_DEPLOY:<deployment-id>:<config-sha256>:<plan-sha256>:<source-sha256>:<remote-program-sha256>`.
  Execution fails before transport unless the environment value
  `SYNTHIA_M4F_DIRECT_DEPLOYMENT_CONFIRMATION` equals it byte for byte.
- Direct SSH reuses the frozen host, user, dedicated mode-0600 key, one-entry
  known-hosts file, fingerprint, public-key-only authentication and
  no-proxy/no-forwarding policy. Upload uses the same direct identity and does
  not enable SCP's relaxed remote-name checking.
- The preflight is read-only. It proves that the reviewed Gate roots exist,
  the versioned release root and new task do not exist, port 18443 has no
  listener, and the old 8443 PID/start time/listener/task-definition hash are
  unchanged. The same old-Worker proof is repeated before every mutating
  phase and in final evidence. Each remote phase independently applies
  `GetFullPath`, reconstructs the exact reviewed layout and walks every
  existing ancestor to reject reparse points before mutation; the newly
  created release root is checked again immediately after creation.
- The first mutation exclusively creates the version root. Upload is allowed
  only below that new root. `worker-release.manifest.json`,
  `server.bundle.mjs`, `start-worker-66.cmd`,
  `certify-m4f-windows.ps1`, and `pfx-password.txt` retain the filenames that
  the frozen launcher expects.
- Every uploaded file is rehashed on Windows, changed to a protected ACL with
  Administrators/SYSTEM full control and LocalService read/execute, and then
  rehashed again. Source drift before/after each upload fails closed.
- The server PFX is opened with `EphemeralKeySet`. Public certification must
  match the exact `iPAddress SAN=100.96.223.49`, server-auth EKU
  `1.3.6.1.5.5.7.3.1`, issuer, certificate SHA-256 and expiration supplied in
  the reviewed config. A DNS SAN or CN alone is insufficient. The password,
  private-key bytes, secret file hashes and secret paths are not returned in
  plan, phase output, success evidence or failure evidence.
- The existing Windows certifier creates distinct initialize/reopen configs.
  The administrative initialize command runs exactly once and exits. Only
  after `PostInitialize` and a separate reopen verification does the
  orchestrator archive the initialize config and promote the reopen config.
  A service never listens with initialize mode.
- The 18443 task uses LocalService SID `S-1-5-19`, absolute release/Bun/config
  paths, limited run level, `IgnoreNew`, and restart count zero. Evidence binds
  its definition hash, wrapper hash, PID, creation time, owner SID, listener,
  active-config hash and ledger metadata/epoch.
- Any timeout, signal, nonzero exit, stderr, malformed result, hash drift or
  partial upload freezes the completed phases with `retry_permitted=false`.
  There is no automatic retry, rollback, cleanup, task removal, process kill,
  ledger deletion or spool deletion. A new attempt needs a new version/gate
  boundary and a new review.
- The deployment program neither invokes Vivado nor permits hardware actions.
  It rejects any newly observed `vivado.exe`, `vivado_lab.exe` or
  `hw_server.exe` process. It contains no `open_hw*`, `program_hw*` or
  `write_cfgmem` action. Starting the empty-ledger sidecar is not a Vivado
  evaluation.

## Phases

1. direct transport and read-only remote preflight;
2. exclusive version-root creation;
3. one upload for each hash-bound release/TLS/config artifact;
4. remote hash, ACL and TLS public-certificate seal;
5. isolated staging and one-shot ledger initialize;
6. proof that initialize stopped, `PostInitialize`, reopen verification and
   active-config promotion;
7. LocalService Scheduled Task registration and 18443 start;
8. process, listener, task, active-config and ledger evidence collection.

The phase order is immutable. Upload or later failures do not return to an
earlier phase.

## Local review and production execution

Create the config outside the repository with mode 0600. The two secret input
files (`server_pfx`, `pfx_password`) must be owner-only, regular, single-link
files. All ten artifact roles are mandatory. The config template must already
bind the exact 18443 origin, Gate-local mutable roots, uploaded TLS files and
uploaded toolchain attestation; it remains eval-disabled until the reviewed
StageCeremony creates its initialize/reopen variants.

The five mutable template roots are not free-form descendants. They are fixed
respectively to `<gate-root>\workspace`, `evidence`, `ledger`, `spool`, and
`logs`; traversal or aliasing in any one of them rejects the plan.

~~~sh
bun connector/scripts/m4f-direct-deployment-orchestrator.ts plan \
  /absolute/private/m4f-deployment-config.json
~~~

Review the complete plan and obtain an independent approval before setting the
printed confirmation. Execution also requires a new, nonexistent evidence
directory:

~~~sh
SYNTHIA_M4F_DIRECT_DEPLOYMENT_CONFIRMATION='<exact-plan-confirmation>' \
bun connector/scripts/m4f-direct-deployment-orchestrator.ts execute \
  /absolute/private/m4f-deployment-config.json \
  /absolute/new/m4f-deployment-evidence
~~~

Do not execute until the actual Gate-root record, public certificate
SAN/EKU/issuer/fingerprint, toolchain attestation, versioned Windows Bun
release, old 8443 PID/start/task-definition baseline, and independent review
are all frozen. A successful deployment record proves only the isolated F0
deployment boundary. It does not prove the canary, B v2 certification, real
Vivado positive flow, failure quarantine, recovery/retention, or final M4-F
Gate.
