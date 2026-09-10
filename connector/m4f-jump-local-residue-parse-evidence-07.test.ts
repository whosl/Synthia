import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_SHA256,
  BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
  BOUND_JUMP_RECEIVER_SOURCE_SHA256,
  MAX_BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  type MasterAuditEvidence,
  type ProcessObservation,
} from "./scripts/m4f-bound-jump-transport.ts";
import {
  JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
  JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256,
} from "./scripts/invoke-m4f-jump-local-residue-observation-06.ts";
import {
  JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT,
  JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_LENGTH,
  JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_SHA256,
} from "./scripts/invoke-m4f-jump-local-residue-parse-gate-06.ts";
import { verifyJumpLocalResidueParseEvidence07 } from
  "./scripts/verify-m4f-jump-local-residue-parse-evidence-07.ts";

const MASTER_HASH = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const CHILD_HASH = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
const NETWORK_HASH = "02c94dce4f86ac0627bb4d1a960ff8fb1dd6cfc1bcb6f77cfaccb20387c7d6f1";

describe("M4-F retained parse evidence verifier _07", () => {
  test("verifies parsed_not_invoked only with identity CRLF payload CRLF", () => {
    const fixture = retainedLog();
    const result = verifyJumpLocalResidueParseEvidence07(fixture);
    expect(result.status).toBe("parsed_not_invoked_verified");
    expect(result.stdout_framing).toBe("identity_crlf_payload_crlf");
    expect(result.target_artifact_length).toBe(17_481);
    expect(result.target_artifact_sha256)
      .toBe("c723d9a02308faa0ea1540f8fb32933a2d7da1f7cd0a4ba8f93588a167a03d7a");
    expect(result.parse_gate_artifact_length).toBe(29_299);
    expect(result.parse_gate_artifact_sha256)
      .toBe("2ab9fef7e00e16535abe3f009036a938a88e19b5862cb7cd8e7532b874e3fc2b");
  });

  test("rejects LF-only receiver stdout and semantic/evidence drift", () => {
    for (const mutate of [
      (value: Record<string, unknown>) => {
        const observation = value.observation as Record<string, unknown>;
        const processEvidence = observation.process as Record<string, unknown>;
        processEvidence.stdout_base64 = Buffer.from(
          `${JSON.stringify(observation.identity)}\n${JSON.stringify(observation.payload)}\n`,
          "utf8",
        ).toString("base64");
      },
      (value: Record<string, unknown>) => {
        const observation = value.observation as Record<string, unknown>;
        (observation.payload as Record<string, unknown>).status = "parse_rejected";
      },
      (value: Record<string, unknown>) => {
        const observation = value.observation as Record<string, unknown>;
        (observation.input as Record<string, unknown>).artifact_sha256 = "0".repeat(64);
      },
      (value: Record<string, unknown>) => {
        const observation = value.observation as Record<string, unknown>;
        (observation.master_after as Record<string, unknown>).master_pid = 1;
      },
      (value: Record<string, unknown>) => {
        (value.cause as Record<string, unknown>).unknown = true;
      },
      (value: Record<string, unknown>) => {
        (value.observation as Record<string, unknown>).unknown = true;
      },
      (value: Record<string, unknown>) => {
        const observation = value.observation as Record<string, unknown>;
        (observation.process as Record<string, unknown>).target_body_invoked = true;
      },
      (value: Record<string, unknown>) => {
        const observation = value.observation as Record<string, unknown>;
        (observation.input as Record<string, unknown>).unknown = true;
      },
      (value: Record<string, unknown>) => {
        const observation = value.observation as Record<string, unknown>;
        (observation.identity as Record<string, unknown>).unknown = true;
      },
      (value: Record<string, unknown>) => {
        const observation = value.observation as Record<string, unknown>;
        (observation.payload as Record<string, unknown>).unknown = true;
      },
      (value: Record<string, unknown>) => {
        const observation = value.observation as Record<string, unknown>;
        for (const key of ["master_before", "master_after"]) {
          (observation[key] as Record<string, unknown>).unknown = true;
        }
      },
      (value: Record<string, unknown>) => {
        const observation = value.observation as Record<string, unknown>;
        for (const key of ["master_before", "master_after"]) {
          const masterEvidence = observation[key] as Record<string, unknown>;
          (masterEvidence.network_process as Record<string, unknown>).unknown = true;
        }
      },
      (value: Record<string, unknown>) => {
        const observation = value.observation as Record<string, unknown>;
        for (const key of ["master_before", "master_after"]) {
          const masterEvidence = observation[key] as Record<string, unknown>;
          (masterEvidence.network_connection as Record<string, unknown>).unknown = true;
        }
      },
      (value: Record<string, unknown>) => {
        const observation = value.observation as Record<string, unknown>;
        for (const key of ["master_before", "master_after"]) {
          const masterEvidence = observation[key] as Record<string, unknown>;
          (masterEvidence.network_process as Record<string, unknown>).timed_out = true;
        }
      },
      (value: Record<string, unknown>) => {
        const observation = value.observation as Record<string, unknown>;
        for (const key of ["master_before", "master_after"]) {
          const masterEvidence = observation[key] as Record<string, unknown>;
          (masterEvidence.network_process as Record<string, unknown>).stdout_base64 = "eA==";
        }
      },
      (value: Record<string, unknown>) => {
        const observation = value.observation as Record<string, unknown>;
        for (const key of ["master_before", "master_after"]) {
          const masterEvidence = observation[key] as Record<string, unknown>;
          (masterEvidence.network_connection as Record<string, unknown>).remote_address = "203.0.113.9";
        }
      },
      (value: Record<string, unknown>) => { value.unknown = true; },
    ]) {
      const envelope = retainedEnvelope();
      mutate(envelope);
      expect(() => verifyJumpLocalResidueParseEvidence07(
        Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8"),
      )).toThrow("M4F_JUMP_LOCAL_RESIDUE_PARSE_EVIDENCE_07_INVALID");
    }
  });

  test("is bounded, one-line, local-data-only, and has no frozen evidence path", () => {
    expect(() => verifyJumpLocalResidueParseEvidence07(Buffer.alloc(0)))
      .toThrow("M4F_JUMP_LOCAL_RESIDUE_PARSE_EVIDENCE_07_INVALID");
    expect(() => verifyJumpLocalResidueParseEvidence07(Buffer.alloc(1_048_577, 0x61)))
      .toThrow("M4F_JUMP_LOCAL_RESIDUE_PARSE_EVIDENCE_07_INVALID");
    expect(() => verifyJumpLocalResidueParseEvidence07(`${retainedLog().toString("utf8")}\n`))
      .toThrow("M4F_JUMP_LOCAL_RESIDUE_PARSE_EVIDENCE_07_INVALID");
    expect(verifyJumpLocalResidueParseEvidence07.toString())
      .not.toMatch(/private\/tmp|ssh|fetch|http|socket|vivado/iu);
  });
});

function processObservation(): ProcessObservation {
  return {
    exit_status: 0,
    signal: null,
    error_code: null,
    stdout_base64: "",
    stderr_base64: "",
    timed_out: false,
    outcome_ambiguous: false,
    retry_permitted: false,
  };
}

function master(): MasterAuditEvidence {
  const networkProcess = processObservation();
  networkProcess.stdout_base64 = Buffer.from(
    "p87062\ncssh\nf3\ntIPv4\nPTCP\nn100.123.31.75:65322->100.66.198.60:22\nTST=ESTABLISHED\nTQR=0\nTQS=0\n",
    "utf8",
  ).toString("base64");
  return {
    schema: "synthia-m4f-bound-master-audit.v1",
    master_pid: 87_062,
    master_socket: "/private/tmp/synthia-m4f-jump.sock",
    known_hosts_path: "/Users/wenzhuolin/.ssh/known_hosts",
    host_key_fingerprint: "SHA256:I37M/4mZJwdlChfZyay+GSbhTuRKEQthOZW7sHmugh8",
    ssh_executable: "/usr/bin/ssh",
    master_effective_config_sha256: MASTER_HASH,
    child_effective_config_sha256: CHILD_HASH,
    network_sha256: NETWORK_HASH,
    network_process: networkProcess,
    network_connection: {
      fd: 3,
      protocol: "TCP",
      local_address: "100.123.31.75",
      local_port: 65_322,
      remote_address: "100.66.198.60",
      remote_port: 22,
      state: "ESTABLISHED",
    },
  };
}

function parsedPayload(): Record<string, unknown> {
  const ast = "System.Management.Automation.Language.ScriptBlockAst";
  return {
    schema: "synthia-m4f-jump-local-residue-parse-gate.v1",
    status: "parsed_not_invoked",
    target_artifact_length: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
    target_artifact_sha256: JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256,
    target_source_character_length: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
    target_source_utf8_length: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
    target_source_sha256: JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256,
    powershell_edition: "Desktop",
    powershell_version: "5.1.22621.6133",
    process_bitness: 64,
    language_mode: "FullLanguage",
    parser_ast_type: ast,
    parser_extent_start_offset: 0,
    parser_extent_end_offset: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
    parser_extent_character_length: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
    parser_extent_utf8_length: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
    parser_extent_sha256: JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256,
    parse_error_count: 0,
    parse_errors_truncated: false,
    parse_errors: [],
    target_scriptblock_constructed: true,
    constructed_ast_type: ast,
    constructed_extent_start_offset: 0,
    constructed_extent_end_offset: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
    constructed_extent_character_length: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
    constructed_extent_utf8_length: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
    constructed_extent_sha256: JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256,
    scriptblock_create_exception: null,
    target_body_not_invoked: true,
  };
}

function retainedEnvelope(): Record<string, unknown> {
  const identity = {
    schema: "synthia-m4f-jump-identity.v1",
    computer_name: "DESKTOP-E380LR7",
    identity_name: "desktop-e380lr7\\administrator",
    identity_sid: "S-1-5-21-3442870711-319385569-2277832987-500",
  };
  const payload = parsedPayload();
  const stdin = Buffer.from(
    `${Buffer.from(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT, "utf8").toString("base64")}\n`,
    "ascii",
  );
  const observation = {
    schema: "synthia-m4f-bound-phase.v1",
    phase: "jump-local-residue-parse-gate-06:parse",
    identity,
    payload,
    process: {
      ...processObservation(),
      stdout_base64: Buffer.from(
        `${JSON.stringify(identity)}\r\n${JSON.stringify(payload)}\r\n`,
        "utf8",
      ).toString("base64"),
    },
    input: {
      artifact_length: JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_LENGTH,
      artifact_sha256: JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_SHA256,
      stdin_length: stdin.length,
      stdin_sha256: createHash("sha256").update(stdin).digest("hex"),
      receiver_source_length: BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
      receiver_source_sha256: BOUND_JUMP_RECEIVER_SOURCE_SHA256,
      receiver_encoded_length: BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
      receiver_encoded_sha256: BOUND_JUMP_RECEIVER_ENCODED_SHA256,
      receiver_command_length: BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
      receiver_command_maximum: MAX_BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
    },
    master_before: master(),
    master_after: master(),
  };
  return {
    schema: "synthia-m4f-jump-local-residue-parse-gate-failure.v1",
    code: "M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID",
    current_stage: "validation",
    retry_permitted: false,
    observation,
    cause: {
      schema: "synthia-m4f-jump-local-residue-parse-gate-failure.v1",
      code: "M4F_JUMP_LOCAL_RESIDUE_PARSE_EVIDENCE_INVALID",
      current_stage: "validation",
      retry_permitted: false,
      observation: null,
      cause: null,
    },
  };
}

function retainedLog(): Buffer {
  return Buffer.from(`${JSON.stringify(retainedEnvelope())}\n`, "utf8");
}
