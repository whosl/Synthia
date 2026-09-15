import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type BoundJumpRuntime,
  type PathFacts,
  type RawProcessResult,
  CeremonyFailure,
  JUMP_COMPUTER,
  JUMP_HOST,
  JUMP_IDENTITY_NAME,
  JUMP_IDENTITY_SID,
  KNOWN_HOSTS_PATH,
  MASTER_PID,
  MASTER_SOCKET,
  SCP_PATH,
  SSH_PATH,
  BOUND_JUMP_RECEIVER_ENCODED,
  BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_SHA256,
  BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  BOUND_JUMP_RECEIVER_SOURCE,
  BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
  BOUND_JUMP_RECEIVER_SOURCE_SHA256,
  buildBoundJumpPhaseInput,
  canonicalizeBoundJumpIdentityName,
  createBoundJumpTransport,
  decodeBoundJumpReceiverInput,
} from "./scripts/m4f-bound-jump-transport.ts";

const MASTER_COMMAND = "ssh -N -M -S /private/tmp/synthia-m4f-jump.sock -o ControlMaster=yes -o ControlPersist=45m -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes -o ForwardAgent=no Administrator@100.66.198.60";
const KNOWN_HOST = "100.66.198.60 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGUuWduKR03JrMJvZ7Cg+QL1toVoMdfSCPPx6Xw5JG8c\n";
const MASTER_EFFECTIVE_CONFIG = [
  "host 100.66.198.60",
  "user Administrator",
  "hostname 100.66.198.60",
  "controlmaster true",
  "controlpersist 2700",
  "clearallforwardings no",
  "permitlocalcommand no",
  "controlpath /private/tmp/synthia-m4f-jump.sock",
  "forwardagent no",
  "",
].join("\n");
const CHILD_EFFECTIVE_CONFIG = [
  "host 100.66.198.60",
  "user Administrator",
  "hostname 100.66.198.60",
  "controlmaster false",
  "controlpersist no",
  "clearallforwardings yes",
  "permitlocalcommand no",
  "controlpath /private/tmp/synthia-m4f-jump.sock",
  "forwardagent no",
  "",
].join("\n");
const MASTER_CONFIG_SHA256 = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const CHILD_CONFIG_SHA256 = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
const MASTER_NETWORK = [
  "p87062",
  "cssh",
  "f3",
  "tIPv4",
  "PTCP",
  "n100.123.31.75:65322->100.66.198.60:22",
  "TST=ESTABLISHED",
  "TQR=0",
  "TQS=0",
  "",
].join("\n");

interface Call {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxBuffer: number;
  stdin?: Uint8Array;
}

function raw(
  stdout = "",
  stderr = "",
  status: number | null = 0,
  signal: NodeJS.Signals | null = null,
  errorCode: string | null = null,
): RawProcessResult {
  return {
    status,
    signal,
    errorCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

function remoteOutput(
  payload: Record<string, unknown> = { schema: "test-payload.v1", status: "passed" },
  identity: Record<string, unknown> = {
    schema: "synthia-m4f-jump-identity.v1",
    computer_name: JUMP_COMPUTER,
    identity_name: JUMP_IDENTITY_NAME,
    identity_sid: JUMP_IDENTITY_SID,
  },
): string {
  return `${JSON.stringify(identity)}\r\n${JSON.stringify(payload)}\r\n`;
}

function fixture(options: {
  knownHostsFacts?: Partial<PathFacts>;
  lsof?: string;
  lsofNetwork?: string;
  remote?: (index: number) => RawProcessResult;
  scp?: RawProcessResult;
  check?: RawProcessResult;
  masterEffectiveConfig?: RawProcessResult;
  childEffectiveConfig?: RawProcessResult;
} = {}): { runtime: BoundJumpRuntime; calls: Call[] } {
  const calls: Call[] = [];
  let remoteIndex = 0;
  const runtime: BoundJumpRuntime = {
    uid: () => 501,
    pathFacts: (path) => {
      if (path === MASTER_SOCKET) {
        return {
          isSocket: true,
          isSymbolicLink: false,
          isRegularFile: false,
          uid: 501,
          mode: 0o600,
        };
      }
      if (path === KNOWN_HOSTS_PATH) {
        return {
          isSocket: false,
          isSymbolicLink: false,
          isRegularFile: true,
          uid: 501,
          mode: 0o600,
          ...options.knownHostsFacts,
        };
      }
      throw new Error(`unexpected path ${path}`);
    },
    readText: (path) => {
      if (path !== KNOWN_HOSTS_PATH) throw new Error(`unexpected read ${path}`);
      return KNOWN_HOST;
    },
    sha256: (bytes) => {
      const text = Buffer.from(bytes).toString("utf8");
      if (text === MASTER_EFFECTIVE_CONFIG) return MASTER_CONFIG_SHA256;
      if (text === CHILD_EFFECTIVE_CONFIG) return CHILD_CONFIG_SHA256;
      return createHash("sha256").update(bytes).digest("hex");
    },
    spawn: (executable, args, timeoutMs, maxBuffer, stdin) => {
      calls.push({ executable, args, timeoutMs, maxBuffer, stdin });
      if (executable === SSH_PATH && args.includes("-G")) {
        return args.includes("-M")
          ? options.masterEffectiveConfig ?? raw(MASTER_EFFECTIVE_CONFIG)
          : options.childEffectiveConfig ?? raw(CHILD_EFFECTIVE_CONFIG);
      }
      if (executable === SSH_PATH && args.includes("-O")) {
        return options.check ?? raw("", `Master running (pid=${MASTER_PID})\r\n`);
      }
      if (executable === "/bin/ps") return raw(`501 ${MASTER_COMMAND}\n`);
      if (executable === "/usr/sbin/lsof") {
        if (args.includes("-iTCP")) return raw(options.lsofNetwork ?? MASTER_NETWORK);
        return raw(options.lsof ?? `p${MASTER_PID}\nfcwd\nn/usr/bin/ssh\nn/usr/lib/dyld\n`);
      }
      if (executable === SSH_PATH) {
        const result = options.remote?.(remoteIndex) ?? raw(remoteOutput());
        remoteIndex += 1;
        return result;
      }
      if (executable === SCP_PATH) return options.scp ?? raw();
      throw new Error(`unexpected executable ${executable}`);
    },
  };
  return { runtime, calls };
}

function failure(operation: () => unknown): CeremonyFailure {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CeremonyFailure);
    return error as CeremonyFailure;
  }
  throw new Error("expected CeremonyFailure");
}

function expectNoFallback(args: readonly string[]): void {
  for (const value of [
    "IdentityAgent=none",
    "IdentityFile=/dev/null",
    "ClearAllForwardings=yes",
    "PubkeyAuthentication=no",
    "PasswordAuthentication=no",
    "KbdInteractiveAuthentication=no",
    "GSSAPIAuthentication=no",
    "HostbasedAuthentication=no",
    "PreferredAuthentications=none",
    "PermitLocalCommand=no",
    "ProxyCommand=none",
    "ProxyJump=none",
  ]) expect(args).toContain(value);
  expect(args).not.toContain("PreferredAuthentications=publickey");
}

describe("M4-F bound jump transport", () => {
  test("audits before and after one phase and preserves exact process evidence", () => {
    const { runtime, calls } = fixture({
      remote: () => raw(remoteOutput({ schema: "answer.v1", value: 7 }), "", 0, null, null),
    });
    const result = createBoundJumpTransport(runtime).invokeBoundJumpPhase("test:phase", "Write-Output ok");
    expect(result.payload).toEqual({ schema: "answer.v1", value: 7 });
    expect(result.process).toEqual({
      exit_status: 0,
      signal: null,
      error_code: null,
      stdout_base64: Buffer.from(remoteOutput({ schema: "answer.v1", value: 7 })).toString("base64"),
      stderr_base64: "",
      timed_out: false,
      outcome_ambiguous: false,
      retry_permitted: false,
    });
    expect(calls.map((call) => call.executable)).toEqual([
      SSH_PATH, SSH_PATH,
      SSH_PATH, "/bin/ps", "/usr/sbin/lsof", "/usr/sbin/lsof",
      SSH_PATH,
      SSH_PATH, SSH_PATH,
      SSH_PATH, "/bin/ps", "/usr/sbin/lsof", "/usr/sbin/lsof",
    ]);
    const phaseCall = calls[6]!;
    expect(phaseCall.args).toContain(JUMP_HOST);
    expectNoFallback(phaseCall.args);
  });

  test("timeout is effect-ambiguous, not retried, and still performs post-audit", () => {
    const observed = raw("partial-out", "partial-err", null, "SIGTERM", "ETIMEDOUT");
    const { runtime, calls } = fixture({ remote: () => observed });
    const error = failure(() => createBoundJumpTransport(runtime).invokeBoundJumpPhase("test:timeout", "x"));
    expect(error.detail.code).toBe("M4F_BOUND_PHASE_OUTCOME_AMBIGUOUS");
    expect(error.detail.process).toEqual({
      exit_status: null,
      signal: "SIGTERM",
      error_code: "ETIMEDOUT",
      stdout_base64: Buffer.from("partial-out").toString("base64"),
      stderr_base64: Buffer.from("partial-err").toString("base64"),
      timed_out: true,
      outcome_ambiguous: true,
      retry_permitted: false,
    });
    expect(error.detail.input).toEqual(buildBoundJumpPhaseInput("x").evidence);
    expect(calls.filter((call) => call.executable === SSH_PATH
      && !call.args.includes("-O")
      && !call.args.includes("-G"))).toHaveLength(1);
    expect(calls.slice(-5).map((call) => call.executable)).toEqual([
      SSH_PATH, SSH_PATH, "/bin/ps", "/usr/sbin/lsof", "/usr/sbin/lsof",
    ]);
  });

  test("rejects identity and strict two-line framing with complete evidence", () => {
    const wrongIdentity = {
      schema: "synthia-m4f-jump-identity.v1",
      computer_name: "OTHER",
      identity_name: JUMP_IDENTITY_NAME,
      identity_sid: JUMP_IDENTITY_SID,
    };
    let scenario = 0;
    const { runtime } = fixture({
      remote: () => scenario++ === 0
        ? raw(remoteOutput({}, wrongIdentity))
        : raw(`${remoteOutput()}\r\n`),
    });
    const transport = createBoundJumpTransport(runtime);
    const identityFailure = failure(() => transport.invokeBoundJumpPhase("test:identity", "x"));
    expect(identityFailure.detail.code).toBe("M4F_BOUND_REMOTE_IDENTITY_MISMATCH");
    expect(identityFailure.detail.process).toBeDefined();
    const framingFailure = failure(() => transport.invokeBoundJumpPhase("test:framing", "x"));
    expect(framingFailure.detail.code).toBe("M4F_BOUND_PHASE_OUTPUT_INVALID");
    expect(framingFailure.detail.process).toBeDefined();
  });

  test("requires exact ControlMaster check framing and retains its observation", () => {
    const { runtime } = fixture({ check: raw("Master running (pid=87062)\n", "") });
    const error = failure(() => createBoundJumpTransport(runtime).auditMaster());
    expect(error.detail.code).toBe("M4F_BOUND_MASTER_CHECK_FAILED");
    expect(error.detail.process).toEqual(expect.objectContaining({
      exit_status: 0,
      stdout_base64: Buffer.from("Master running (pid=87062)\n").toString("base64"),
      stderr_base64: "",
    }));
  });

  test("fails closed when effective SSH config contains any forwarding or proxy route", () => {
    for (const unsafeLine of [
      "localcommand echo unsafe",
      "proxycommand /tmp/proxy",
      "proxyjump relay.example",
      "localforward 127.0.0.1:1 127.0.0.1:2",
      "remoteforward 127.0.0.1:1 127.0.0.1:2",
      "dynamicforward 127.0.0.1:1080",
    ]) {
      const { runtime } = fixture({
        masterEffectiveConfig: raw(`${MASTER_EFFECTIVE_CONFIG}${unsafeLine}\n`),
      });
      const error = failure(() => createBoundJumpTransport(runtime).auditMaster());
      expect(error.detail.code).toBe("M4F_BOUND_EFFECTIVE_CONFIG_AUDIT_FAILED");
      expect(error.detail.process).toBeDefined();
    }
  });

  test("pins the complete master and child effective SSH config byte hashes", () => {
    const { runtime } = fixture({
      childEffectiveConfig: raw(`${CHILD_EFFECTIVE_CONFIG}# drift\n`),
    });
    const error = failure(() => createBoundJumpTransport(runtime).auditMaster());
    expect(error.detail.code).toBe("M4F_BOUND_EFFECTIVE_CONFIG_HASH_MISMATCH");
    expect(error.detail.kind).toBe("child");
    expect(error.detail.expected_sha256).toBe(CHILD_CONFIG_SHA256);
    expect(error.detail.actual_sha256).toBeString();
    expect(error.detail.actual_sha256).not.toBe(CHILD_CONFIG_SHA256);
    expect(error.detail.process).toBeDefined();
  });

  test("binds the master to exactly one fixed established TCP connection", () => {
    const valid = fixture();
    const evidence = createBoundJumpTransport(valid.runtime).auditMaster();
    const networkCall = valid.calls.find((call) => call.executable === "/usr/sbin/lsof"
      && call.args.includes("-iTCP"));
    expect(networkCall?.args).toEqual([
      "-nP",
      "-a",
      "-p", "87062",
      "-iTCP",
      "-FpcfPtTn",
    ]);
    expect(evidence.network_connection).toEqual({
      fd: 3,
      protocol: "TCP",
      local_address: "100.123.31.75",
      local_port: 65322,
      remote_address: "100.66.198.60",
      remote_port: 22,
      state: "ESTABLISHED",
    });
    expect(evidence.network_sha256).toBe(
      createHash("sha256").update(MASTER_NETWORK).digest("hex"),
    );
    expect(evidence.network_process).toEqual(expect.objectContaining({
      exit_status: 0,
      stdout_base64: Buffer.from(MASTER_NETWORK).toString("base64"),
    }));

    for (const unsafe of [
      MASTER_NETWORK.replace("TST=ESTABLISHED", "TST=LISTEN"),
      MASTER_NETWORK.replace("100.66.198.60:22", "100.66.198.61:22"),
      `${MASTER_NETWORK}f4\ntIPv4\nPTCP\nn100.123.31.75:65323->100.66.198.60:22\nTST=ESTABLISHED\nTQR=0\nTQS=0\n`,
    ]) {
      const scenario = fixture({ lsofNetwork: unsafe });
      const error = failure(() => createBoundJumpTransport(scenario.runtime).auditMaster());
      expect(error.detail.code).toBe("M4F_BOUND_MASTER_NETWORK_AUDIT_FAILED");
      expect(error.detail.process).toBeDefined();
    }
  });

  test("streams an exact CmdletBinding artifact through fixed base64 stdin without argv interpolation", () => {
    const artifact = "[CmdletBinding()]\nparam()\n[Console]::Out.WriteLine('{\"quote\":\"$`;&|<>\"}')\n";
    const { runtime, calls } = fixture();
    const result = createBoundJumpTransport(runtime).invokeBoundJumpPhase("test:param", artifact);
    const phaseCall = calls.find((call) => call.executable === SSH_PATH && call.args.includes("-EncodedCommand"));
    expect(phaseCall).toBeDefined();
    expect(phaseCall!.args).toContain("-T");
    const encodedIndex = phaseCall!.args.indexOf("-EncodedCommand") + 1;
    expect(phaseCall!.args[encodedIndex]).toBe(BOUND_JUMP_RECEIVER_ENCODED);
    expect(phaseCall!.args.join(" ")).not.toContain(artifact);
    expect(phaseCall!.stdin).toEqual(buildBoundJumpPhaseInput(artifact).stdin);
    expect(decodeBoundJumpReceiverInput(phaseCall!.stdin!)).toEqual(Buffer.from(artifact));
    expect(result.input).toEqual(buildBoundJumpPhaseInput(artifact).evidence);
    expect(result.input).toEqual(expect.objectContaining({
      receiver_source_length: BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
      receiver_source_sha256: BOUND_JUMP_RECEIVER_SOURCE_SHA256,
      receiver_encoded_length: BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
      receiver_encoded_sha256: BOUND_JUMP_RECEIVER_ENCODED_SHA256,
    }));
    expect(BOUND_JUMP_RECEIVER_COMMAND_LENGTH).toBe(3_346);
    expect(32_767 - BOUND_JUMP_RECEIVER_COMMAND_LENGTH).toBeGreaterThan(24_575);
    expect(BOUND_JUMP_RECEIVER_SOURCE).toContain("[Console]::In.ReadToEnd()");
    expect(BOUND_JUMP_RECEIVER_SOURCE).toContain("[ScriptBlock]::Create($artifactSource)");
    expect(BOUND_JUMP_RECEIVER_SOURCE).toContain("$identity.Name.ToLowerInvariant()");
    expect(BOUND_JUMP_RECEIVER_SOURCE).toContain("$identity.User.Value");
  });

  test("canonicalizes raw Windows identity case but keeps exact frozen identity matching", () => {
    expect(canonicalizeBoundJumpIdentityName("DESKTOP-E380LR7\\Administrator"))
      .toBe(JUMP_IDENTITY_NAME);
    expect(canonicalizeBoundJumpIdentityName("desktop-e380lr7\\administrator"))
      .toBe(JUMP_IDENTITY_NAME);
    expect(canonicalizeBoundJumpIdentityName("DESKTOP-E380LR8\\Administrator"))
      .not.toBe(JUMP_IDENTITY_NAME);
    expect(canonicalizeBoundJumpIdentityName("DESKTOP-E380LR7\\Administrators"))
      .not.toBe(JUMP_IDENTITY_NAME);

    const { runtime } = fixture({
      remote: () => raw(remoteOutput({}, {
        schema: "synthia-m4f-jump-identity.v1",
        computer_name: JUMP_COMPUTER,
        identity_name: canonicalizeBoundJumpIdentityName("DESKTOP-E380LR7\\Administrator"),
        identity_sid: JUMP_IDENTITY_SID,
      })),
    });
    expect(createBoundJumpTransport(runtime).invokeBoundJumpPhase("test:canonical", "x").identity.identity_name)
      .toBe(JUMP_IDENTITY_NAME);

    const nearMiss = fixture({
      remote: () => raw(remoteOutput({}, {
        schema: "synthia-m4f-jump-identity.v1",
        computer_name: JUMP_COMPUTER,
        identity_name: canonicalizeBoundJumpIdentityName("DESKTOP-E380LR7\\Administrators"),
        identity_sid: JUMP_IDENTITY_SID,
      })),
    });
    expect(failure(() => createBoundJumpTransport(nearMiss.runtime)
      .invokeBoundJumpPhase("test:near-miss", "x")).detail.code)
      .toBe("M4F_BOUND_REMOTE_IDENTITY_MISMATCH");
  });

  test("audits known_hosts lstat before spawning and permits dyld beside one ssh executable", () => {
    const invalid = fixture({ knownHostsFacts: { mode: 0o622 } });
    const error = failure(() => createBoundJumpTransport(invalid.runtime).auditMaster());
    expect(error.detail.code).toBe("M4F_BOUND_KNOWN_HOSTS_AUDIT_FAILED");
    expect(invalid.calls).toHaveLength(0);

    const valid = fixture({ lsof: `p${MASTER_PID}\nftxt\nn/usr/bin/ssh\nftxt\nn/usr/lib/dyld\n` });
    expect(createBoundJumpTransport(valid.runtime).auditMaster().ssh_executable).toBe(SSH_PATH);

    const duplicate = fixture({ lsof: "n/usr/bin/ssh\nn/opt/local/bin/ssh\nn/usr/lib/dyld\n" });
    const duplicateError = failure(() => createBoundJumpTransport(duplicate.runtime).auditMaster());
    expect(duplicateError.detail.code).toBe("M4F_BOUND_MASTER_EXECUTABLE_AUDIT_FAILED");
    expect(duplicateError.detail.process).toBeDefined();
  });

  test("SCP is single-shot with identity and master verification around it", () => {
    const { runtime, calls } = fixture();
    const result = createBoundJumpTransport(runtime).copyBoundJumpFiles(
      ["/private/tmp/orchestrator.ps1"],
      "C:\\Windows\\Temp\\synthia-m4f-stage-01",
    );
    expect(result.status).toBe("passed");
    const scpCalls = calls.filter((call) => call.executable === SCP_PATH);
    expect(scpCalls).toHaveLength(1);
    expectNoFallback(scpCalls[0]!.args);
    expect(calls.filter((call) => call.executable === SSH_PATH
      && !call.args.includes("-O")
      && !call.args.includes("-G"))).toHaveLength(2);
    expect(result.identity_before.identity.identity_sid).toBe(JUMP_IDENTITY_SID);
    expect(result.identity_after.identity.identity_sid).toBe(JUMP_IDENTITY_SID);
  });

  test("SCP timeout is ambiguous and never retried", () => {
    const { runtime, calls } = fixture({
      scp: raw("copied?", "timeout", null, "SIGTERM", "ETIMEDOUT"),
    });
    const error = failure(() => createBoundJumpTransport(runtime).copyBoundJumpFiles(
      ["/private/tmp/orchestrator.ps1"],
      "C:\\Windows\\Temp\\synthia-m4f-stage-01",
    ));
    expect(error.detail.code).toBe("M4F_BOUND_COPY_OUTCOME_AMBIGUOUS");
    expect(error.detail.process).toEqual(expect.objectContaining({
      timed_out: true,
      outcome_ambiguous: true,
      retry_permitted: false,
      stdout_base64: Buffer.from("copied?").toString("base64"),
      stderr_base64: Buffer.from("timeout").toString("base64"),
      signal: "SIGTERM",
    }));
    expect(calls.filter((call) => call.executable === SCP_PATH)).toHaveLength(1);
    expect(calls.slice(-5).map((call) => call.executable)).toEqual([
      SSH_PATH, SSH_PATH, "/bin/ps", "/usr/sbin/lsof", "/usr/sbin/lsof",
    ]);
  });
});
