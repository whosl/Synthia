import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  BOUND_JUMP_RECEIVER_ENCODED,
  BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_SHA256,
  BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  BOUND_JUMP_RECEIVER_SOURCE,
  BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
  BOUND_JUMP_RECEIVER_SOURCE_SHA256,
  CeremonyFailure,
  JUMP_COMPUTER,
  JUMP_HOST,
  JUMP_IDENTITY_NAME,
  JUMP_IDENTITY_SID,
  KNOWN_HOSTS_PATH,
  MASTER_PID,
  MASTER_SOCKET,
  MAX_BOUND_JUMP_ARTIFACT_BYTES,
  MAX_BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  MAX_BOUND_JUMP_RECEIVER_STDIN_BYTES,
  SSH_PATH,
  buildBoundJumpPhaseInput,
  canonicalizeBoundJumpIdentityName,
  createBoundJumpTransport,
  decodeBoundJumpReceiverInput,
  type BoundJumpRuntime,
  type PathFacts,
  type RawProcessResult,
} from "./scripts/m4f-bound-jump-transport.ts";

const scripts = new URL("./scripts/", import.meta.url);
const WINDOWS_COMMAND_LINE_MAXIMUM = 32_767;
const REQUIRED_WINDOWS_MARGIN = 24_575;
const MASTER_CONFIG_SHA256 = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const CHILD_CONFIG_SHA256 = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
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

interface SpawnCall {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxBuffer: number;
  stdin: Buffer | null;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
  payload: Record<string, unknown> = {
    schema: "stdin-regression.v1",
    status: "passed",
  },
  identity: Record<string, unknown> = {
    schema: "synthia-m4f-jump-identity.v1",
    computer_name: JUMP_COMPUTER,
    identity_name: JUMP_IDENTITY_NAME,
    identity_sid: JUMP_IDENTITY_SID,
  },
): string {
  return `${JSON.stringify(identity)}\r\n${JSON.stringify(payload)}\r\n`;
}

function pathFacts(path: string): PathFacts {
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
    };
  }
  throw new Error(`unexpected path ${path}`);
}

function fixture(remote: RawProcessResult = raw(remoteOutput())): {
  runtime: BoundJumpRuntime;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const runtime: BoundJumpRuntime = {
    uid: () => 501,
    pathFacts,
    readText: (path) => {
      if (path !== KNOWN_HOSTS_PATH) throw new Error(`unexpected read ${path}`);
      return KNOWN_HOST;
    },
    sha256: (bytes) => {
      const text = Buffer.from(bytes).toString("utf8");
      if (text === MASTER_EFFECTIVE_CONFIG) return MASTER_CONFIG_SHA256;
      if (text === CHILD_EFFECTIVE_CONFIG) return CHILD_CONFIG_SHA256;
      return sha256(bytes);
    },
    spawn: (executable, args, timeoutMs, maxBuffer, stdin) => {
      calls.push({
        executable,
        args,
        timeoutMs,
        maxBuffer,
        stdin: stdin === undefined ? null : Buffer.from(stdin),
      });
      if (executable === SSH_PATH && args.includes("-G")) {
        return raw(args.includes("-M") ? MASTER_EFFECTIVE_CONFIG : CHILD_EFFECTIVE_CONFIG);
      }
      if (executable === SSH_PATH && args.includes("-O")) {
        return raw("", `Master running (pid=${MASTER_PID})\r\n`);
      }
      if (executable === "/bin/ps") return raw(`501 ${MASTER_COMMAND}\n`);
      if (executable === "/usr/sbin/lsof") {
        return args.includes("-iTCP")
          ? raw(MASTER_NETWORK)
          : raw(`p${MASTER_PID}\nftxt\nn/usr/bin/ssh\nftxt\nn/usr/lib/dyld\n`);
      }
      if (executable === SSH_PATH) return remote;
      throw new Error(`unexpected executable ${executable}`);
    },
  };
  return { runtime, calls };
}

function phaseCalls(calls: readonly SpawnCall[]): SpawnCall[] {
  return calls.filter((call) => call.executable === SSH_PATH
    && !call.args.includes("-G")
    && !call.args.includes("-O"));
}

function captureFailure(operation: () => unknown): CeremonyFailure {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CeremonyFailure);
    return error as CeremonyFailure;
  }
  throw new Error("expected CeremonyFailure");
}

describe("M4-F bound jump stdin receiver regression", () => {
  test("keeps the real 9,686-byte creator out of argv with a large UTF-16 command margin", async () => {
    const artifact = await readFile(new URL("create-m4f-jump-bootstrap-root.ps1", scripts));
    expect(artifact.byteLength).toBe(9_686);
    const artifactText = artifact.toString("utf8");
    const artifactBase64 = artifact.toString("base64");
    const { runtime, calls } = fixture();

    const result = createBoundJumpTransport(runtime)
      .invokeBoundJumpPhase("stdin:real-creator", artifactText);
    const remoteCalls = phaseCalls(calls);
    expect(remoteCalls).toHaveLength(1);
    const call = remoteCalls[0]!;
    expect(call.args[0]).toBe("-T");
    expect(call.args).not.toContain("-t");
    expect(call.args).not.toContain("-tt");
    expect(call.args).toContain(JUMP_HOST);
    expect(call.args).toContain("powershell.exe");
    expect(call.args).toContain("-EncodedCommand");
    expect(call.args).toContain(BOUND_JUMP_RECEIVER_ENCODED);
    expect(call.args.some((argument) => argument.includes(artifactText))).toBe(false);
    expect(call.args.some((argument) => argument.includes(artifactBase64))).toBe(false);

    const hostIndex = call.args.indexOf(JUMP_HOST);
    const remoteArgv = call.args.slice(hostIndex + 1);
    expect(remoteArgv[0]).toBe("powershell.exe");
    const remoteCommand = remoteArgv.join(" ");
    const utf16CodeUnits = Buffer.byteLength(remoteCommand, "utf16le") / 2;
    expect(utf16CodeUnits).toBe(result.input.receiver_command_length);
    expect(BOUND_JUMP_RECEIVER_COMMAND_LENGTH).toBe(3_346);
    expect(utf16CodeUnits).toBeLessThan(MAX_BOUND_JUMP_RECEIVER_COMMAND_LENGTH);
    expect(WINDOWS_COMMAND_LINE_MAXIMUM - utf16CodeUnits)
      .toBeGreaterThan(REQUIRED_WINDOWS_MARGIN);
    expect(result.input.receiver_encoded_length)
      .toBe(Buffer.byteLength(BOUND_JUMP_RECEIVER_ENCODED, "ascii"));
    expect(BOUND_JUMP_RECEIVER_SOURCE_LENGTH).toBe(1_220);
    expect(BOUND_JUMP_RECEIVER_SOURCE_SHA256)
      .toBe("bdb544d7befe5dc6e162c7bcf98e314096b8ffa4e331c12a0b75248d05ad1e00");
    expect(BOUND_JUMP_RECEIVER_ENCODED_LENGTH).toBe(3_256);
    expect(BOUND_JUMP_RECEIVER_ENCODED_SHA256)
      .toBe("ec4bb477e8e7bd0c08551837b21ad90e06aaa3bab11e95b44cef5dee0b6a22bb");

    const transportSource = await readFile(
      new URL("m4f-bound-jump-transport.ts", scripts),
      "utf8",
    );
    expect(transportSource).toContain("spawnSync(executable, [...args], {");
    expect(transportSource).not.toContain("shell: true");
  });

  test("sends exact canonical stdin bytes and records exact length and hash", async () => {
    const artifact = await readFile(new URL("create-m4f-jump-bootstrap-root.ps1", scripts));
    const artifactText = artifact.toString("utf8");
    const expectedStdin = Buffer.from(`${artifact.toString("base64")}\n`, "ascii");
    const built = buildBoundJumpPhaseInput(artifactText);
    expect(built.stdin.equals(expectedStdin)).toBe(true);
    expect(decodeBoundJumpReceiverInput(built.stdin).equals(artifact)).toBe(true);

    const { runtime, calls } = fixture();
    const result = createBoundJumpTransport(runtime)
      .invokeBoundJumpPhase("stdin:exact", artifactText);
    const call = phaseCalls(calls)[0]!;
    expect(call.stdin?.equals(expectedStdin)).toBe(true);
    expect(result.input).toEqual(built.evidence);
    expect(result.input.artifact_length).toBe(artifact.byteLength);
    expect(result.input.artifact_sha256).toBe(sha256(artifact));
    expect(result.input.stdin_length).toBe(expectedStdin.byteLength);
    expect(result.input.stdin_sha256).toBe(sha256(expectedStdin));
    expect(result.input.receiver_source_length)
      .toBe(Buffer.byteLength(BOUND_JUMP_RECEIVER_SOURCE, "utf8"));
    expect(result.input.receiver_source_sha256)
      .toBe(sha256(Buffer.from(BOUND_JUMP_RECEIVER_SOURCE, "utf8")));
  });

  test("fixed receiver framing rejects malformed base64, invalid UTF-8, and both bounds", () => {
    const valid = Buffer.from("Write-Output ok\n", "utf8");
    const canonical = Buffer.from(`${valid.toString("base64")}\n`, "ascii");
    expect(decodeBoundJumpReceiverInput(canonical).equals(valid)).toBe(true);

    for (const malformed of [
      Buffer.from(valid.toString("base64"), "ascii"),
      Buffer.from(`${valid.toString("base64")}\r\n`, "ascii"),
      Buffer.from(`${valid.toString("base64")}\n\n`, "ascii"),
      Buffer.from(` ${valid.toString("base64")}\n`, "ascii"),
      Buffer.from("****\n", "ascii"),
      Buffer.from("YQ=\n", "ascii"),
    ]) expect(() => decodeBoundJumpReceiverInput(malformed)).toThrow(
      "M4F_BOUND_RECEIVER_STDIN_INVALID",
    );

    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    expect(() => decodeBoundJumpReceiverInput(Buffer.from(
      `${invalidUtf8.toString("base64")}\n`,
      "ascii",
    ))).toThrow("M4F_BOUND_RECEIVER_ARTIFACT_UTF8_INVALID");

    const oversizedArtifact = Buffer.alloc(MAX_BOUND_JUMP_ARTIFACT_BYTES + 1, 0x61);
    expect(() => decodeBoundJumpReceiverInput(Buffer.from(
      `${oversizedArtifact.toString("base64")}\n`,
      "ascii",
    ))).toThrow("M4F_BOUND_RECEIVER_ARTIFACT_INVALID");
    expect(() => decodeBoundJumpReceiverInput(
      Buffer.alloc(MAX_BOUND_JUMP_RECEIVER_STDIN_BYTES + 1, 0x41),
    )).toThrow("M4F_BOUND_RECEIVER_STDIN_INVALID");

    expect(BOUND_JUMP_RECEIVER_SOURCE).toContain("[Console]::In.ReadToEnd()");
    expect(BOUND_JUMP_RECEIVER_SOURCE).toContain("[Text.UTF8Encoding]::new($false, $true)");
    expect(BOUND_JUMP_RECEIVER_SOURCE).toContain("$artifactBytes.Length -gt 1048576");
    expect(BOUND_JUMP_RECEIVER_SOURCE).toContain("$encodedArtifact.Length -gt 2000000");
  });

  test("lowercases only the observed Windows account name and rejects identity near misses", () => {
    expect(BOUND_JUMP_RECEIVER_SOURCE)
      .toContain("identity_name = $identity.Name.ToLowerInvariant()");
    expect(BOUND_JUMP_RECEIVER_SOURCE)
      .toContain("identity_sid = $identity.User.Value");
    expect(BOUND_JUMP_RECEIVER_SOURCE)
      .not.toContain("$identity.User.Value.ToLowerInvariant()");
    expect(BOUND_JUMP_RECEIVER_SOURCE)
      .not.toMatch(/identity_sid\s*=.*ToLowerInvariant/u);

    const uppercaseObserved = "DESKTOP-E380LR7\\Administrator";
    expect(canonicalizeBoundJumpIdentityName(uppercaseObserved)).toBe(JUMP_IDENTITY_NAME);
    const canonicalIdentity = {
      schema: "synthia-m4f-jump-identity.v1",
      computer_name: JUMP_COMPUTER,
      identity_name: canonicalizeBoundJumpIdentityName(uppercaseObserved),
      identity_sid: JUMP_IDENTITY_SID,
    };
    const payload = { schema: "stdin-regression.v1", status: "passed" };
    const canonical = fixture(raw(remoteOutput(payload, canonicalIdentity)));
    expect(createBoundJumpTransport(canonical.runtime)
      .invokeBoundJumpPhase("stdin:uppercase-identity", "x")
      .identity.identity_name).toBe(JUMP_IDENTITY_NAME);

    for (const nearMiss of [
      "DESKTOP-E380LR8\\Administrator",
      "DESKTOP-E380LR7\\Administrators",
    ]) {
      const identity = {
        ...canonicalIdentity,
        identity_name: canonicalizeBoundJumpIdentityName(nearMiss),
      };
      expect(identity.identity_name).not.toBe(JUMP_IDENTITY_NAME);
      const scenario = fixture(raw(remoteOutput(payload, identity)));
      expect(captureFailure(() => createBoundJumpTransport(scenario.runtime)
        .invokeBoundJumpPhase("stdin:identity-near-miss", "x")).detail.code)
        .toBe("M4F_BOUND_REMOTE_IDENTITY_MISMATCH");
    }
  });

  test("timeout preserves partial evidence and exact input while forbidding retry", async () => {
    const artifact = await readFile(new URL("create-m4f-jump-bootstrap-root.ps1", scripts));
    const expectedInput = buildBoundJumpPhaseInput(artifact.toString("utf8"));
    const observed = raw("partial-out", "partial-err", null, "SIGTERM", "ETIMEDOUT");
    const { runtime, calls } = fixture(observed);
    const error = captureFailure(() => createBoundJumpTransport(runtime)
      .invokeBoundJumpPhase("stdin:timeout", artifact.toString("utf8")));

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
    expect(error.detail.input).toEqual(expectedInput.evidence);
    const remoteCalls = phaseCalls(calls);
    expect(remoteCalls).toHaveLength(1);
    expect(remoteCalls[0]!.stdin?.equals(expectedInput.stdin)).toBe(true);
  });
});
