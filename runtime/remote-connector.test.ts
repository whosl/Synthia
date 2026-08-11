import { describe, expect, test } from "bun:test";
import { RemoteConnectorError } from "../connector/remote.ts";
import { RemoteVivadoConnector, type ConnectorLifecycleEvent } from "./remote-connector.ts";
import { FailClosedError, FAKE_CAPABILITIES } from "./loop.ts";
import type { VivadoSubmission } from "./types.ts";

// ---------------------------------------------------------------------------
// MockRemoteClient — faithfully simulates the FROZEN RemoteConnectorClient's
// lease semantics: once `lease` is set and expires, state is permanently
// "offline" on THAT instance; only a fresh instance (via factory) can recover.
// ---------------------------------------------------------------------------

interface MockSharedState {
  /** When true, the NEXT discover() call on any instance sets drift=true. */
  driftOnNextDiscover: boolean;
}

class MockRemoteClient {
  private _state = "registering";
  private _drift = false;
  private _lease: number | undefined = undefined;
  private readonly _leaseMs: number;
  private readonly _now: () => number;
  private readonly _shared: MockSharedState;

  constructor(opts: { leaseMs: number; now: () => number; shared: MockSharedState }) {
    this._leaseMs = opts.leaseMs;
    this._now = opts.now;
    this._shared = opts.shared;
  }

  get state(): string {
    if (this._lease !== undefined && this._now() >= this._lease && this._state !== "revoked") return "offline";
    return this._state;
  }

  get hasCapabilityDrift(): boolean { return this._drift; }

  async register(): Promise<{ connector_id: string; registration_state: string }> {
    // Frozen client: register sets this.s but does NOT clear this.lease.
    this._state = "approved";
    return { connector_id: "mock-66", registration_state: "approved" };
  }

  async heartbeat(): Promise<{ connector_id: string; registration_state: string; lease_expires_at: string }> {
    // Frozen client: heartbeat refuses when state is "offline".
    if (this.state === "offline") throw new RemoteConnectorError("LEASE_EXPIRED");
    this._state = "ready";
    this._lease = this._now() + this._leaseMs;
    return {
      connector_id: "mock-66",
      registration_state: "ready",
      lease_expires_at: new Date(this._lease).toISOString(),
    };
  }

  async discover(): Promise<{
    connector_id: string; connector_protocol_version: string; capability_map_version: string;
    vivado_version: string; vivado_patch: string; part_catalog_hash: string; sdk_worker_build_hash: string;
    capabilities: typeof FAKE_CAPABILITIES; toolchain_profile_hash: string; license_status: string;
  }> {
    if (this._shared.driftOnNextDiscover) { this._drift = true; this._shared.driftOnNextDiscover = false; }
    return {
      connector_id: "mock-66", connector_protocol_version: "connector.remote.v1",
      capability_map_version: "mock", vivado_version: "2021.1", vivado_patch: "3247384",
      part_catalog_hash: "mock", sdk_worker_build_hash: "mock",
      capabilities: FAKE_CAPABILITIES, toolchain_profile_hash: "mock", license_status: "available",
    };
  }

  async submit(request: { jobId: string; operation: string }): Promise<{ id: string; state: string; errorCode?: string; request: unknown }> {
    if (this.state === "offline") throw new RemoteConnectorError("LEASE_EXPIRED");
    if (this._state !== "ready") throw new RemoteConnectorError("ENDPOINT_NOT_APPROVED");
    if (this._drift) throw new RemoteConnectorError("CAPABILITY_DRIFT");
    return { id: request.jobId, state: "succeeded", request };
  }

  async status(id: string): Promise<{ id: string; state: string; errorCode?: string }> { return { id, state: "succeeded" }; }
  async evidence(id: string): Promise<{ jobId: string; entries: Array<{ name: string; sha256: string; sizeBytes: number; mediaType: string }> }> {
    return { jobId: id, entries: [{ name: "result.txt", sha256: "a".repeat(64), sizeBytes: 1, mediaType: "text/plain" }] };
  }
  async cancel(id: string): Promise<{ id: string; state: string }> { return { id, state: "cancelled" }; }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function makeSubmission(): VivadoSubmission {
  return {
    operation: "validate_sources", runClass: "exploratory", projectId: "p1",
    sources: [{ path: "top.v", content: "module top; endmodule\n" }], top: "top", part: "xc7k70tfbv676-1",
  };
}

function makeHarness(opts: { leaseMs?: number; shared?: MockSharedState } = {}) {
  let clock = 0;
  const shared: MockSharedState = opts.shared ?? { driftOnNextDiscover: false };
  const leaseMs = opts.leaseMs ?? 30_000;
  const lifecycle: ConnectorLifecycleEvent[] = [];
  let instancesCreated = 0;
  const clientFactory = () => { instancesCreated++; return new MockRemoteClient({ leaseMs, now: () => clock, shared }) as never; };
  const conn = new RemoteVivadoConnector({
    clientFactory, connectorId: "mock-66", projectId: "p1",
    now: () => clock, sleep: async () => {},
    onLifecycle: (e) => lifecycle.push(e),
  });
  return {
    conn, lifecycle, shared,
    advance: (ms: number) => { clock += ms; },
    getClock: () => clock,
    instancesCreated: () => instancesCreated,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RemoteVivadoConnector lease/reconnect", () => {
  test("normal flow: initial priming via fresh client, then proactive heartbeat keeps lease alive", async () => {
    const h = makeHarness({ leaseMs: 60_000 });
    const caps = await h.conn.discover();
    expect(caps.length).toBeGreaterThan(0);
    expect(h.instancesCreated()).toBe(1); // one client for priming

    // Second discover: proactive heartbeat refreshes lease (no reconnect needed)
    await h.conn.discover();
    expect(h.instancesCreated()).toBe(1); // still the same client
    const heartbeats = h.lifecycle.filter(e => e.action === "heartbeat");
    expect(heartbeats.length).toBe(1); // one proactive heartbeat on second call
  });

  test("lease expired before call → proactive heartbeat fails → fresh client reconnect → success", async () => {
    const h = makeHarness({ leaseMs: 30_000 });

    // Prime: register→heartbeat→discover on client #1 (lease valid until +30s)
    await h.conn.discover();
    expect(h.instancesCreated()).toBe(1);

    // Simulate LLM taking 40s to generate TB — lease expires
    h.advance(40_000);

    // Next operation: proactive heartbeat sees expired lease → reconnect
    const caps = await h.conn.discover();
    expect(caps.length).toBeGreaterThan(0);

    // Fresh client was created for reconnect
    expect(h.instancesCreated()).toBe(2);

    // Lifecycle recorded the reconnect
    const reconnects = h.lifecycle.filter(e => e.action === "reconnect");
    expect(reconnects.length).toBe(1);
    expect(reconnects[0]!.detail).toContain("lease expired");
    // drift check passed
    const driftChecks = h.lifecycle.filter(e => e.action === "drift_check" && e.result === "ok");
    expect(driftChecks.length).toBeGreaterThanOrEqual(1);
  });

  test("lease expired mid-submit → submit throws LEASE_EXPIRED → fresh client reconnect → retry succeeds", async () => {
    const h = makeHarness({ leaseMs: 30_000 });
    await h.conn.discover(); // prime
    expect(h.instancesCreated()).toBe(1);

    // Submit while lease is still valid (proactive heartbeat refreshes it)
    const result = await h.conn.submit(makeSubmission());
    expect(result.status).toBe("succeeded");
    expect(h.instancesCreated()).toBe(1); // no reconnect needed

    // Now expire the lease and try submit again
    h.advance(40_000);
    const result2 = await h.conn.submit(makeSubmission());
    expect(result2.status).toBe("succeeded");
    // Reconnect created a fresh client
    expect(h.instancesCreated()).toBe(2);
  });

  test("reconnect discovers drift → fail-closed, no submit attempted", async () => {
    const h = makeHarness({ leaseMs: 30_000 });
    await h.conn.discover(); // prime
    expect(h.instancesCreated()).toBe(1);

    // Configure: next discover on the fresh client will report drift
    h.shared.driftOnNextDiscover = true;
    // Expire the lease
    h.advance(40_000);

    // discover should reconnect → discover drift → fail-closed
    await expect(h.conn.discover()).rejects.toThrow(FailClosedError);
    expect(h.instancesCreated()).toBe(2); // fresh client was created

    // Lifecycle recorded the drift_check fail_closed
    const driftFails = h.lifecycle.filter(e => e.action === "drift_check" && e.result === "fail_closed");
    expect(driftFails.length).toBe(1);
  });

  test("lifecycle events accumulate in lifecycleEvents array", async () => {
    const h = makeHarness({ leaseMs: 30_000 });
    await h.conn.discover();

    // Initial priming: drift_check on constructor-created client (no reconnect)
    expect(h.conn.lifecycleEvents.filter(e => e.action === "reconnect")).toHaveLength(0);
    expect(h.conn.lifecycleEvents.filter(e => e.action === "drift_check" && e.result === "ok")).toHaveLength(1);

    h.advance(40_000);
    await h.conn.discover();

    // Lease expiry triggered a reconnect (fresh client) + drift_check
    expect(h.conn.lifecycleEvents.filter(e => e.action === "reconnect")).toHaveLength(1);
    expect(h.conn.lifecycleEvents.filter(e => e.action === "drift_check" && e.result === "ok")).toHaveLength(2);
  });
});
