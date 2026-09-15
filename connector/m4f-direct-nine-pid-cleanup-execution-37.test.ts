import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  CANDIDATE35_CONFIG_PATH,
  CANDIDATE36_CONFIG_PATH,
  CANDIDATE36_EVIDENCE_DIRECTORY,
  CANDIDATE36_MANIFEST_PATH,
  CANDIDATE36_RECORD_PATH,
  CANDIDATE37_ID,
} from "./scripts/m4f-direct-nine-pid-cleanup-execution-37.ts";
import {
  buildCandidate35Payload,
  candidate35Confirmation,
  validateCandidate35Config,
} from "./scripts/m4f-direct-nine-pid-cleanup-runner-35.ts";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

describe("M4-F Candidate 37 exact cleanup execution binding", () => {
  test("binds the revised C35 payload and deterministic confirmation", () => {
    const config = validateCandidate35Config(JSON.parse(
      readFileSync(CANDIDATE35_CONFIG_PATH, "utf8"),
    ));
    const payload = buildCandidate35Payload(config);
    expect(config.target_host).toBe("100.96.223.49");
    expect(payload.remote_command).toMatch(/^[\x00-\x7f]*$/u);
    expect(payload.remote_command_length).toBeLessThanOrEqual(7_000);
    expect(payload.business_script_sha256).toBe(sha256(payload.business_script));
    expect(payload.remote_command_sha256).toBe(sha256(Buffer.from(payload.remote_command, "ascii")));
    expect(candidate35Confirmation(config)).toBe(candidate35Confirmation(config));
  });

  test("binds only the successful revised C36-R12 evidence set", () => {
    expect(CANDIDATE37_ID).toBe("m4f-direct-nine-pid-cleanup-execution-prod-20260831-37");
    expect(CANDIDATE36_CONFIG_PATH).toBe(
      "/private/tmp/synthia-m4f-direct-nine-pid-cleanup-parse-helper-gate-prod-20260901-36-r12.json",
    );
    expect(CANDIDATE36_EVIDENCE_DIRECTORY).toBe(
      "/private/tmp/m4f-direct-nine-pid-cleanup-parse-helper-gate-prod-20260901-36-r12-evidence",
    );
    expect(CANDIDATE36_RECORD_PATH).toBe(CANDIDATE36_EVIDENCE_DIRECTORY + "/gate-record.json");
    expect(CANDIDATE36_MANIFEST_PATH).toBe(CANDIDATE36_EVIDENCE_DIRECTORY + "-manifest.json");
    const record = JSON.parse(readFileSync(CANDIDATE36_RECORD_PATH, "utf8")) as Record<string, unknown>;
    expect(record.gate_id).toBe("m4f-direct-nine-pid-cleanup-parse-helper-gate-20260901-36-r12");
    expect(record.status).toBe("exact_target_parse_zero_and_pure_helpers_smoked");
    expect(record.target_body_invoked).toBe(false);
    expect(record.process_mutation_performed).toBe(false);
  });
});
