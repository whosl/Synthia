import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { DISABLED_CORE_FEATURE_FLAGS } from "../src/api/feature-flags.ts";
import type { HandlerResult, RequestContext } from "../src/api/handlers.ts";
import {
  approveP4GateHandler,
  confirmP4FormalInputHandler,
  confirmP4ReadinessHandler,
  createP4ChangeRequestHandler,
  createP4GateEvaluationHandler,
  createP4GateSubmissionHandler,
  freezeP4EvidenceHandler,
  getP4DeliveryContentHandler,
  getP4DeliveryManifestHandler,
  getP4DeliveryReleaseHandler,
  getP4EvidenceContentHandler,
  getP4EvidenceHandler,
  getP4FormalInputApprovalHandler,
  getP4FormalJobHandler,
  getP4ProcessProfileHandler,
  getP4ProcessStateHandler,
  getP4WorkVersionHandler,
  listP4BitstreamsHandler,
  listP4ChangeRequestsHandler,
  listP4DeliveryReleasesHandler,
  listP4GateEvaluationsHandler,
  listP4ReadinessHandler,
  prepareP4ReadinessHandler,
  previewP4FormalInputHandler,
  submitP4FormalJobHandler,
  submitP4GateSubmissionHandler,
  withdrawP4ChangeRequestHandler,
} from "../src/api/p4-handlers.ts";

type P4Handler = (ctx: RequestContext) => Promise<HandlerResult | Response>;

const params = {
  projectId: "project-feature-off",
  processVersionId: "GJB_REF_V1",
  readinessId: "readiness-feature-off",
  subId: "submission-feature-off",
  approvalId: "approval-feature-off",
  jobId: "job-feature-off",
  releaseId: "release-feature-off",
  changeRequestId: "change-feature-off",
  workVersionId: "work-feature-off",
};

function context(pool: Pool, url = "http://local/api/v1/feature-off"): RequestContext {
  const request = new Request(url, { method: "POST", body: "{}" });
  return {
    pool,
    identity: {
      actorType: "human",
      actorId: "feature-off-user",
      userId: "user-feature-off",
      scopes: ["core:admin", "core:read", "core:write", "core:approve"],
    },
    method: "POST",
    url: new URL(request.url),
    request,
    params,
    body: {},
    correlationId: "correlation-feature-off",
    idempotencyKey: "idempotency-feature-off",
    classification: "D1",
    connector: {
      connectorId: "connector-must-not-be-called",
      async discover() {
        throw new Error("FEATURE_OFF_WRITE_REACHED_CONNECTOR");
      },
    } as never,
    runtimeActorId: "runtime-feature-off",
    featureFlags: DISABLED_CORE_FEATURE_FLAGS,
  };
}

describe("P4 formal-delivery feature-off matrix", () => {
  test("every P4 write entry fails with 503 before database or Connector work", async () => {
    let queries = 0;
    const pool = {
      async query() {
        queries += 1;
        throw new Error("FEATURE_OFF_WRITE_REACHED_DATABASE");
      },
    } as unknown as Pool;
    const writes: Array<[string, P4Handler]> = [
      ["prepare readiness", prepareP4ReadinessHandler],
      ["confirm readiness", confirmP4ReadinessHandler],
      ["create gate submission", createP4GateSubmissionHandler],
      ["evaluate gate", createP4GateEvaluationHandler],
      ["submit gate", submitP4GateSubmissionHandler],
      ["preview formal input", previewP4FormalInputHandler],
      ["confirm formal input", confirmP4FormalInputHandler],
      ["submit formal job", submitP4FormalJobHandler],
      ["freeze evidence and derive bitstream", freezeP4EvidenceHandler],
      ["approve G4 and seal release", approveP4GateHandler],
      ["create change request", createP4ChangeRequestHandler],
      ["withdraw change request", withdrawP4ChangeRequestHandler],
    ];

    for (const [name, handler] of writes) {
      try {
        await handler(context(pool));
        throw new Error(`${name} unexpectedly succeeded while the feature was disabled`);
      } catch (error) {
        expect(error, name).toMatchObject({
          code: "capability_unavailable",
          httpStatus: 503,
          message: "FORMAL_DELIVERY_DISABLED",
        });
      }
    }
    expect(queries).toBe(0);
  });

  test("every P4 read entry reaches persisted facts while the feature is disabled", async () => {
    const marker = new Error("FEATURE_OFF_READ_REACHED_DATABASE");
    let queries = 0;
    const pool = {
      async query() {
        queries += 1;
        throw marker;
      },
    } as unknown as Pool;
    const reads: Array<[string, P4Handler, string?]> = [
      ["process profile", getP4ProcessProfileHandler],
      ["process state", getP4ProcessStateHandler],
      ["readiness list", listP4ReadinessHandler],
      ["gate evaluation list", listP4GateEvaluationsHandler],
      ["formal input approval", getP4FormalInputApprovalHandler],
      ["formal job", getP4FormalJobHandler],
      ["frozen evidence", getP4EvidenceHandler],
      ["frozen evidence content", getP4EvidenceContentHandler, "http://local/api/v1/feature-off?name=stdout.log"],
      ["bitstream list", listP4BitstreamsHandler],
      ["delivery release list", listP4DeliveryReleasesHandler],
      ["delivery release", getP4DeliveryReleaseHandler],
      ["delivery manifest", getP4DeliveryManifestHandler],
      ["delivery content", getP4DeliveryContentHandler, "http://local/api/v1/feature-off?path=rtl%2Ftop.sv"],
      ["change request list", listP4ChangeRequestsHandler],
      ["work version", getP4WorkVersionHandler],
    ];

    for (const [name, handler, url] of reads) {
      try {
        await handler(context(pool, url));
        throw new Error(`${name} did not query persisted facts`);
      } catch (error) {
        expect(error, name).toBe(marker);
      }
    }
    expect(queries).toBe(reads.length);
  });
});
