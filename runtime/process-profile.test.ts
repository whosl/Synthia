import { describe, expect, test } from "bun:test";
import { hashPayload } from "../core/src/hashing.ts";
import { GJB_REF_V1_PROFILE } from "../core/src/services/process-profile.ts";
import { loadModernProcessProfile, parseProcessProfile, ProcessProfileValidationError } from "./process-profile.ts";

function cloneProfile(): Record<string, unknown> {
  return structuredClone(GJB_REF_V1_PROFILE) as unknown as Record<string, unknown>;
}

function rehash(profile: Record<string, unknown>): void {
  const { profileHash: _profileHash, ...body } = profile;
  profile.profileHash = hashPayload(body);
}

describe("process-profile.v1 parser", () => {
  test("accepts the authoritative Core profile and verifies its canonical hash", () => {
    const profile = parseProcessProfile(cloneProfile(), "GJB_REF_V1");
    expect(profile.schema).toBe("process-profile.v1");
    expect(profile.id).toBe("GJB_REF_V1");
    expect(profile.nodes.map((node) => [node.id, node.ordinal])).toEqual([
      ["G0", 0], ["G1", 1], ["G2", 2], ["G3", 3], ["G4", 4],
    ]);
    expect(profile.nodes[4]!.activities).toContain("implement");
    expect(profile.profileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("canonical hashing is independent of JSON object key order", () => {
    const source = cloneProfile();
    const reordered = {
      profileHash: source.profileHash,
      nodes: source.nodes,
      name: source.name,
      version: source.version,
      id: source.id,
      schema: source.schema,
    };
    expect(parseProcessProfile(reordered).profileHash).toBe(source.profileHash);
  });

  test("rejects a changed body when profileHash was not recomputed", () => {
    const profile = cloneProfile();
    profile.name = "tampered";
    expect(() => parseProcessProfile(profile)).toThrow("canonical profile body");
  });

  test("rejects unknown activities and checks even with a recomputed hash", () => {
    const unknownActivity = cloneProfile();
    const activityNodes = unknownActivity.nodes as Array<Record<string, unknown>>;
    activityNodes[4]!.activities = [...activityNodes[4]!.activities as string[], "program_device"];
    rehash(unknownActivity);
    expect(() => parseProcessProfile(unknownActivity)).toThrow("not a known activity");

    const unknownCheck = cloneProfile();
    const checkNodes = unknownCheck.nodes as Array<Record<string, unknown>>;
    checkNodes[4]!.requiredChecks = [
      ...checkNodes[4]!.requiredChecks as unknown[],
      { code: "device.programmed", severity: "hard" },
    ];
    rehash(unknownCheck);
    expect(() => parseProcessProfile(unknownCheck)).toThrow("not a known process check");
  });

  test("rejects missing, duplicate, reordered, and post-G4 nodes", () => {
    const variants: Record<string, unknown>[] = [];
    const missing = cloneProfile();
    (missing.nodes as unknown[]).pop();
    rehash(missing);
    variants.push(missing);

    const duplicate = cloneProfile();
    const duplicateNodes = duplicate.nodes as Array<Record<string, unknown>>;
    duplicateNodes[2]!.id = "G1";
    rehash(duplicate);
    variants.push(duplicate);

    const reordered = cloneProfile();
    const reorderedNodes = reordered.nodes as unknown[];
    [reorderedNodes[1], reorderedNodes[2]] = [reorderedNodes[2], reorderedNodes[1]];
    rehash(reordered);
    variants.push(reordered);

    const extended = cloneProfile();
    (extended.nodes as unknown[]).push({
      id: "G5",
      kind: "gate",
      ordinal: 5,
      name: "legacy",
      goal: "must not enter a modern profile",
      activities: ["delivery"],
      requiredChecks: [{ code: "delivery.manifest_sealed", severity: "hard" }],
      milestoneBaseline: null,
    });
    rehash(extended);
    variants.push(extended);

    for (const profile of variants) expect(() => parseProcessProfile(profile)).toThrow(ProcessProfileValidationError);
  });

  test("rejects duplicate activities/checks and incorrect milestone placement", () => {
    const duplicateActivity = cloneProfile();
    const activityNodes = duplicateActivity.nodes as Array<Record<string, unknown>>;
    activityNodes[1]!.activities = [...activityNodes[1]!.activities as string[], "prepare_project"];
    rehash(duplicateActivity);
    expect(() => parseProcessProfile(duplicateActivity)).toThrow("exactly one gate");

    const duplicateCheck = cloneProfile();
    const checkNodes = duplicateCheck.nodes as Array<Record<string, unknown>>;
    const checks = checkNodes[1]!.requiredChecks as unknown[];
    checkNodes[1]!.requiredChecks = [...checks, structuredClone(checks[0])];
    rehash(duplicateCheck);
    expect(() => parseProcessProfile(duplicateCheck)).toThrow("must be unique");

    const milestone = cloneProfile();
    const milestoneNodes = milestone.nodes as Array<Record<string, unknown>>;
    milestoneNodes[2]!.milestoneBaseline = "B2";
    rehash(milestone);
    expect(() => parseProcessProfile(milestone)).toThrow("milestone baselines");
  });

  test("does not accept a weakened known activity/check set with a valid recomputed hash", () => {
    const missingActivity = cloneProfile();
    const activityNodes = missingActivity.nodes as Array<Record<string, unknown>>;
    activityNodes[4]!.activities = (activityNodes[4]!.activities as string[]).filter((activity) => activity !== "delivery");
    rehash(missingActivity);
    expect(() => parseProcessProfile(missingActivity)).toThrow("activity set");

    const missingCheck = cloneProfile();
    const checkNodes = missingCheck.nodes as Array<Record<string, unknown>>;
    checkNodes[4]!.requiredChecks = (checkNodes[4]!.requiredChecks as Array<Record<string, unknown>>)
      .filter((check) => check.code !== "timing.met");
    rehash(missingCheck);
    expect(() => parseProcessProfile(missingCheck)).toThrow("hard-check set");

    const advisory = cloneProfile();
    const advisoryNodes = advisory.nodes as Array<Record<string, unknown>>;
    (advisoryNodes[4]!.requiredChecks as Array<Record<string, unknown>>)[0]!.severity = "advisory";
    rehash(advisory);
    expect(() => parseProcessProfile(advisory)).toThrow("hard-check set");
  });

  test("rejects unexpected fields and a response for another requested version", () => {
    const extra = cloneProfile();
    extra.status = "active";
    expect(() => parseProcessProfile(extra)).toThrow("unexpected or missing fields");
    expect(() => parseProcessProfile(cloneProfile(), "OTHER_V1")).toThrow("requested process version");
  });

  test("keeps legacy mocks compatible but never lets a modern project run without a profile", async () => {
    const legacyReader = {};
    await expect(loadModernProcessProfile(legacyReader, {
      projectType: "engineering",
      processVersionId: "LEGACY_COMPAT",
      processProfileId: "LEGACY_COMPAT",
      processProfileVersion: "LEGACY_COMPAT",
    })).resolves.toBeNull();
    await expect(loadModernProcessProfile(legacyReader, {
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileVersion: "GJB_REF_V1",
    })).rejects.toMatchObject({ code: "PROCESS_PROFILE_UNAVAILABLE" });
    await expect(loadModernProcessProfile({
      getProcessProfile: async () => parseProcessProfile(cloneProfile()),
    }, {
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileVersion: "GJB_REF_V1",
    })).resolves.toMatchObject({ id: "GJB_REF_V1" });
  });
});
