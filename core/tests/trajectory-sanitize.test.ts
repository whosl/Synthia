import { describe, expect, test } from "bun:test";
import {
  rawTrajectoryHash,
  sanitizeTrajectoryRef,
  sanitizeTrajectoryText,
  sanitizeTrajectoryValue,
} from "../src/services/trajectory-sanitize.ts";

describe("Distiller trajectory sanitizer", () => {
  test("deterministically removes secrets, host paths, source refs and private content", () => {
    const source = {
      token: "super-secret-runtime-token",
      nested: {
        report: "/srv/customer-a/timing.rpt",
        note: "project_customer_alpha failed for owner@example.com",
      },
    };
    const first = sanitizeTrajectoryValue(source);
    const second = sanitizeTrajectoryValue(source);
    const serialized = JSON.stringify(first);
    expect(first).toEqual(second);
    expect(serialized).not.toContain("super-secret-runtime-token");
    expect(serialized).not.toContain("/srv/customer-a/timing.rpt");
    expect(serialized).not.toContain("project_customer_alpha");
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).toContain("[REDACTED:SECRET:");
    expect(serialized).toContain("[REDACTED:ABSOLUTE_PATH:");
    expect(serialized).toContain("[REDACTED:SOURCE_REF:");
  });

  test("redacts a private freeform field as a unit and exposes only stable provenance", () => {
    const privateText = "Confidential customer-specific workaround for Atlas";
    const sanitized = sanitizeTrajectoryText(privateText);
    expect(sanitized).not.toContain("Atlas");
    expect(sanitized).toBe(sanitizeTrajectoryText(privateText));
    expect(rawTrajectoryHash(privateText)).toMatch(/^[0-9a-f]{64}$/);
    expect(sanitizeTrajectoryRef("EVIDENCE_REF", "evidence_customer_123"))
      .not.toContain("evidence_customer_123");
  });

  test("redacts generic credential assignments and authorization headers without matching prose", () => {
    const secrets = [
      "token=super-secret-runtime-token",
      "secret: customer-password-value",
      "Authorization: Basic dXNlcjpwYXNz",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "credential=very-private-credential",
    ];
    for (const secret of secrets) {
      const sanitized = sanitizeTrajectoryText(`prefix ${secret} suffix`);
      expect(sanitized).not.toContain(secret);
      expect(sanitized).toContain("[REDACTED:SECRET:");
      expect(sanitized).toBe(sanitizeTrajectoryText(`prefix ${secret} suffix`));
    }
    expect(sanitizeTrajectoryText("keep the token budget within limits"))
      .toBe("keep the token budget within limits");
  });
});
