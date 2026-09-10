import { describe, expect, test } from "bun:test";
import type { GateCheckEvaluationV1, ProcessProfileV1, ProcessStateV1 } from "../src/api/types.ts";
import {
  bitstreamClassText,
  deliveryContentBytes,
  deliveryContentMatchesHash,
  deliveryManifestBytes,
  deliveryManifestMatchesHash,
  deriveG4Checks,
  formalInputBlockers,
  latestPassedEvaluation,
  resolveFormalInputContext,
  shouldPrepareReadiness,
} from "../src/domain/formal-delivery.ts";
import { sha256Bytes } from "../src/util/sha256.ts";

const state: ProcessStateV1 = {
  schema: "process-state.v1",
  projectId: "p1",
  processInstanceId: "pi-1",
  profileId: "GJB_REF_V1",
  profileHash: "a".repeat(64),
  workVersionId: "wv-1",
  currentGate: "G4",
  completed: false,
  readiness: {
    id: "ready-1",
    status: "confirmed",
    ready: true,
    readinessHash: "b".repeat(64),
    targetPart: "xc7k70t",
    boardRef: "kc705",
    workspaceReady: true,
    dataScopeRecorded: true,
    sourceMaterialsRecorded: true,
    pinConstraintsComplete: true,
    electricalConstraintsComplete: true,
    clockConstraintsComplete: true,
    constraintsComplete: true,
    toolchainProfileHash: "c".repeat(64),
    constraintRevisionIds: ["rev-xdc"],
    generatedBy: { type: "service", id: "core" },
    confirmedBy: { id: "human-1", at: "2026-08-24T00:00:00.000Z" },
  },
};

describe("formal input context", () => {
  test("only resolves from confirmed readiness + work version + G4 snapshot + main task", () => {
    const context = resolveFormalInputContext({
      state,
      readinessRows: [{ id: "ready-1", work_version_id: "wv-1", state: "ready", status: "confirmed" }],
      submissions: [{
        id: "sub-g4",
        gate: "G4",
        state: "checking",
        snapshot_id: "snap-g4",
        process_instance_id: "pi-1",
        work_version_id: "wv-1",
        submitter_id: "runtime",
        submitted_at: null,
        created_at: "2026-08-24T00:00:00.000Z",
      }],
      authorizedTaskId: "task-main-1",
    });
    expect(context).toEqual({
      workVersionId: "wv-1",
      snapshotId: "snap-g4",
      readinessId: "ready-1",
      authorizedTaskId: "task-main-1",
    });
    expect(formalInputBlockers(state, context)).toEqual([]);
  });

  test("missing facts and incomplete constraints remain explicit blockers", () => {
    const incomplete: ProcessStateV1 = {
      ...state,
      readiness: { ...state.readiness!, constraintsComplete: false, clockConstraintsComplete: false },
    };
    expect(formalInputBlockers(incomplete, null)).toEqual([
      "引脚、电气或时钟约束尚不完整",
      "当前工作版本、G4 快照或主任务尚未形成完整绑定",
    ]);
    expect(formalInputBlockers(null, null)).toEqual(["Core 流程状态尚不可用"]);
    expect(shouldPrepareReadiness(incomplete)).toBe(true);
    expect(shouldPrepareReadiness(state)).toBe(false);
    expect(shouldPrepareReadiness(null)).toBe(true);
  });
});

describe("G4 checks and immutable delivery presentation", () => {
  const profile = {
    nodes: [{
      id: "G4",
      requiredChecks: [
        { code: "bitstream.formal", severity: "hard" },
        { code: "timing.met", severity: "hard" },
      ],
    }],
  } as unknown as ProcessProfileV1;

  test("missing evaluation items never become passed", () => {
    const evaluation = {
      items: [{ check_code: "bitstream.formal", passed: true, details: {}, severity: "hard" }],
    } as unknown as GateCheckEvaluationV1;
    expect(deriveG4Checks(profile, evaluation).map((row) => [row.code, row.status])).toEqual([
      ["bitstream.formal", "passed"],
      ["timing.met", "missing"],
    ]);
    expect(deriveG4Checks(profile, null).every((row) => row.status === "missing")).toBe(true);
  });

  test("modern approval selects only the latest passed evaluation for the exact snapshot", () => {
    const evaluation = (id: string, snapshotId: string, passed: boolean, evaluatedAt: string) => ({
      id,
      snapshot_id: snapshotId,
      passed,
      evaluated_at: evaluatedAt,
    }) as GateCheckEvaluationV1;
    const selected = latestPassedEvaluation([
      evaluation("eval-wrong", "snap-other", true, "2026-08-24T03:00:00.000Z"),
      evaluation("eval-failed", "snap-4", false, "2026-08-24T04:00:00.000Z"),
      evaluation("eval-old", "snap-4", true, "2026-08-24T01:00:00.000Z"),
      evaluation("eval-new", "snap-4", true, "2026-08-24T02:00:00.000Z"),
    ], "snap-4");
    expect(selected?.id).toBe("eval-new");
    expect(latestPassedEvaluation([], "snap-4")).toBeNull();
  });

  test("trial/formal labels are never ambiguous", () => {
    expect(bitstreamClassText("trial")).toBe("试验码流");
    expect(bitstreamClassText("formal")).toBe("正式码流");
  });

  test("delivery content decodes utf8 and base64 without changing sealed bytes", () => {
    expect(new TextDecoder().decode(deliveryContentBytes({
      path: "doc/a.txt",
      content: "交付",
      encoding: "utf8",
      media_type: "text/plain",
      sha256: "a".repeat(64),
      file_name: "a.txt",
    }))).toBe("交付");
    expect([...deliveryContentBytes({
      path: "build/a.bit",
      content: "AAEC/w==",
      encoding: "base64",
      media_type: "application/octet-stream",
      sha256: "b".repeat(64),
      file_name: "a.formal.bit",
    })]).toEqual([0, 1, 2, 255]);
  });

  test("delivery download verifies the bytes instead of trusting the response digest", () => {
    const hello = {
      path: "doc/hello.txt",
      content: "hello",
      encoding: "utf8" as const,
      media_type: "text/plain",
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      file_name: "hello.txt",
    };
    expect(deliveryContentMatchesHash(hello, hello.sha256)).toBe(true);
    expect(deliveryContentMatchesHash({ ...hello, content: "tampered" }, hello.sha256)).toBe(false);
    expect(deliveryContentMatchesHash(hello, "a".repeat(64))).toBe(false);
  });

  test("manifest download reproduces the exact canonical bytes sealed by Core", () => {
    const unsigned = {
      schema: "delivery-manifest.v1" as const,
      project_id: "p1",
      release_id: "rel-1",
      version: 1,
      work_version_id: "wv-1",
      input_hash: "a".repeat(64),
      items: [],
      manifest_hash: "",
    };
    const sealed = {
      ...unsigned,
      manifest_hash: sha256Bytes(deliveryManifestBytes(unsigned)),
    };
    expect(new TextDecoder().decode(deliveryManifestBytes(sealed))).toBe(
      `{"input_hash":"${"a".repeat(64)}","items":[],"project_id":"p1","release_id":"rel-1","schema":"delivery-manifest.v1","version":1,"work_version_id":"wv-1"}`,
    );
    expect(deliveryManifestMatchesHash(sealed)).toBe(true);
    expect(deliveryManifestMatchesHash({ ...sealed, version: 2 })).toBe(false);
  });
});
