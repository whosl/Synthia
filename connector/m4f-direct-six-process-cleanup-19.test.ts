import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import {
  buildCandidate19BusinessScript,
  buildCandidate19GzipBindingProbe,
  buildCandidate19Payload,
  candidate19StartToken,
  CANDIDATE19_LISTENERS,
  CANDIDATE19_TARGETS,
  CANDIDATE19_WORKER,
  parseCandidate19MarkerPrefix,
  validateCandidate19GzipBindingProbeResult,
  type Candidate19ScriptConfig,
} from "./scripts/m4f-direct-six-process-cleanup-19.ts";

const HASH = "0".repeat(64);

function config(): Candidate19ScriptConfig {
  return {
    schema: "synthia-m4f-candidate19-script-config.v1",
    cleanup_id: "m4f-candidate19-test",
    target_computer: "DESKTOP-DVFFB09",
    target_identity_name: "desktop-dvffb09\\admin",
    target_identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001",
    adjudication_record_path: "/private/tmp/c17.json",
    adjudication_record_sha256: "f575dae6bafa812de57cf3d82d1b920ec96bc74e6c7ad2e0fedbac018b27f3a7",
    adjudication_review_path: "/private/tmp/c17-review.json",
    adjudication_review_sha256: "9cd47bff11c7c8c635c23411cd5d966079b6387c69e3139e8c2a47e85d303447",
    observation_semantic_sha256: "269ac2c43af54fee3c7aa1e9d49e1848bb8bf310f10a3165182f7b6773e6f1b3",
    admission_record_path: "/private/tmp/admission.json",
    admission_record_sha256: "856edffdde9094c95e76aba062b8919c47b44cdeaae60a388cba11b3f7b5657e",
    admission_review_path: "/private/tmp/admission-review.json",
    admission_review_sha256: "4628ad24fb22fedf4d3989ec9482be79ea3316a18b3b76b3a52328d61c369150",
    targets: structuredClone(CANDIDATE19_TARGETS),
    protected_worker: structuredClone(CANDIDATE19_WORKER),
    protected_listeners: structuredClone(CANDIDATE19_LISTENERS),
    effect_wait_ms: 5_000,
    remote_deadline_seconds: 35,
    expected_source_sha256: HASH,
    expected_test_source_sha256: "1".repeat(64),
    expected_transport_source_sha256: "2".repeat(64),
  };
}

function productionConfig(): Candidate19ScriptConfig {
  const value = config();
  value.cleanup_id = "m4f-direct-six-process-cleanup-prod-20260829-19";
  return value;
}

function protection(currentPid = 900, includeWorker = true, includeCurrent = true) {
  const runtimeHash = "a".repeat(64);
  const cores = [
    {
      pid: 4, parent_pid: 0, name: "system",
      creation_utc: "2026-08-01T00:00:00.0000000Z", session_id: 0,
      command_sha256: "c".repeat(64),
    },
    ...(includeCurrent ? [{
      pid: currentPid, parent_pid: 4, name: "powershell.exe",
      creation_utc: "2026-08-29T00:00:00.0000000Z", session_id: 0,
      command_sha256: "b".repeat(64),
    }] : []),
    ...(includeWorker ? [{
      pid: 13644, parent_pid: 2712, name: "node.exe",
      creation_utc: "2026-08-14T08:02:31.2903580Z", session_id: 0,
      command_sha256: runtimeHash,
    }] : []),
  ].sort((left, right) => left.pid - right.pid);
  const value = {
    cores,
    listeners: structuredClone(CANDIDATE19_LISTENERS),
    worker_raw_handle: "1234",
    worker_runtime_command_sha256: runtimeHash,
  };
  return {
    value,
    sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  };
}

function marker(phase: string, status: string, payload: Record<string, unknown>) {
  return JSON.stringify({
    schema: "synthia-m4f-candidate19-marker.v1",
    cleanup_id: config().cleanup_id,
    phase,
    status,
    observed_at_utc: "2026-08-29T00:00:00.0000000Z",
    payload,
  }) + "\r\n";
}

function completeStream(change?: (markers: Record<string, unknown>[]) => void): Buffer {
  const currentPid = 900;
  const protectedFact = protection(currentPid);
  const markers: Record<string, unknown>[] = [
    JSON.parse(marker("start", "observed", {
      current_pid: currentPid,
      target_count: 6,
      observation_semantic_sha256: config().observation_semantic_sha256,
      admission_record_sha256: config().admission_record_sha256,
    })),
    JSON.parse(marker("preflight", "observed", {
      target_count: 6,
      retained_handle_count: 6,
      protection: protectedFact.value,
      protection_sha256: protectedFact.sha256,
    })),
  ];
  for (const target of CANDIDATE19_TARGETS) {
    markers.push(JSON.parse(marker("effect_start", "started", {
      ordinal: target.ordinal,
      candidate: target.candidate,
      role: target.role,
      pid: target.pid,
      start_token: candidate19StartToken(target),
      raw_handle: String(2000 + target.ordinal),
      protection_sha256: protectedFact.sha256,
    })));
    markers.push(JSON.parse(marker("effect_result", "observed", {
      ordinal: target.ordinal,
      pid: target.pid,
      effect: "same_process_instance_kill_completed",
      has_exited: true,
      start_token: candidate19StartToken(target),
    })));
  }
  markers.push(JSON.parse(marker("postflight", "observed", {
    resolved_count: 6,
    protection_sha256: protectedFact.sha256,
  })));
  markers.push(JSON.parse(marker("complete", "complete", {
    cleanup_completed: true,
    resolved_count: 6,
    retry_permitted: false,
  })));
  change?.(markers);
  return Buffer.from(markers.map((value) => JSON.stringify(value) + "\r\n").join(""));
}

describe("M4-F Candidate 19 exact six-process cleanup", () => {
  test("binds reviewed lineage, exact worker/listener facts and rejects config drift", () => {
    const payload = buildCandidate19Payload(config());
    expect(payload.remote_command.length).toBeLessThanOrEqual(7_000);
    expect(payload.outer_loader).not.toContain(",0)");
    expect(payload.outer_loader).toContain(
      "[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($z),[IO.Compression.CompressionMode]::Decompress)",
    );
    expect(payload.outer_loader.match(
      /\[IO\.Compression\.CompressionMode\]::Decompress/gu,
    )).toHaveLength(1);
    const longestId = config();
    longestId.cleanup_id = "a9jxdmmpxq0cijig9l6xijay8sww0mrj236zuqgi4us4ltv1i7y7i8knjtvezl1hjl78wdq4v2n8hw4rjgbiaok4m3zt0q-i";
    expect(buildCandidate19Payload(longestId).remote_command.length).toBeLessThanOrEqual(7_000);
    const cases = [
      (value: Candidate19ScriptConfig) => { value.protected_worker.parent_pid = 1 as 2712; },
      (value: Candidate19ScriptConfig) => { value.protected_worker.executable_path = "C:\\bad.exe" as never; },
      (value: Candidate19ScriptConfig) => { value.protected_listeners[0]!.local_address = "127.0.0.1" as "0.0.0.0"; },
      (value: Candidate19ScriptConfig) => { value.admission_review_sha256 = HASH as never; },
      (value: Candidate19ScriptConfig) => { value.targets.reverse(); },
    ];
    for (const mutate of cases) {
      const value = config();
      mutate(value);
      expect(() => buildCandidate19Payload(value)).toThrow("M4F_CANDIDATE19_SCRIPT_CONFIG_INVALID");
    }
  });

  test("plans a target-free WinPS 5.1 runtime-binding probe for the explicit gzip overload", () => {
    const productionPayload = buildCandidate19Payload(productionConfig());
    const probe = buildCandidate19GzipBindingProbe(productionConfig());
    expect(probe).toMatchObject({
      probe_id: "m4f-candidate19-gzip-binding-probe-v2",
      status: "planned_not_executed",
      stdin_length: 4936,
      stdin_sha256: "beb0e6233bdab365c70306a49b7b698104176f8c604f99e9ed28ee015096b924",
      expected_business_length: 13856,
      expected_business_sha256: "fbfdfd670107f1cf438635b82bd396e20d8fe24d41b8009a93aa21023566ea4c",
      target_body_embedded: false,
      script_block_created: true,
      target_body_invoked: false,
      network_attempted: false,
      ssh_attempted: false,
      remote_execution_attempted: false,
      process_mutation_performed: false,
      file_mutation_performed: false,
      cleanup_performed: false,
    });
    expect(probe.command_length).toBeLessThanOrEqual(7_000);
    expect(probe.script).not.toContain(",0)");
    expect(probe.script).toContain(
      "[IO.Compression.GZipStream]::new($S19m,[IO.Compression.CompressionMode]::Decompress)",
    );
    expect(probe.script).not.toMatch(
      /Invoke-Expression|\.Invoke\s*\(|&\s*\$S19s|\.Kill\s*\(|Stop-Process|Get-CimInstance|MSFT_NetTCPConnection|Start-Process/iu,
    );
    expect(probe.script.match(/\[ScriptBlock\]::Create/gu)).toHaveLength(1);
    for (const target of CANDIDATE19_TARGETS) expect(probe.script).not.toContain(String(target.pid));
    const encoded = probe.command.split(" -EncodedCommand ")[1]!;
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(probe.script);
    expect(probe.stdin).toEqual(productionPayload.compressed_business_script);
    expect(probe.stdin.length).toBe(probe.stdin_length);
    expect(createHash("sha256").update(probe.stdin).digest("hex")).toBe(probe.stdin_sha256);
    const decompressed = gunzipSync(probe.stdin);
    expect(decompressed.length).toBe(probe.expected_business_length);
    expect(createHash("sha256").update(decompressed).digest("hex"))
      .toBe(probe.expected_business_sha256);
    const stdout = Buffer.from(JSON.stringify({
      s: "c19g2",
      z: "ok",
      e: "Desktop",
      v: "5.1.26100.9168",
      g: "System.IO.Compression.GZipStream",
      h: probe.expected_business_sha256,
      l: probe.expected_business_length,
      a: "System.Management.Automation.ScriptBlock",
      i: true,
    }) + "\r\n");
    expect(validateCandidate19GzipBindingProbeResult(stdout, probe)).toMatchObject({
      status: "gzip_constructor_and_decompress_bound",
      powershell_edition: "Desktop",
      powershell_version: "5.1.26100.9168",
      script_block_created: true,
      target_body_invoked: false,
      network_attempted: false,
      process_mutation_performed: false,
      file_mutation_performed: false,
      cleanup_performed: false,
    });
    for (const mutation of [
      stdout.toString("utf8").replace('"e":"Desktop"', '"e":"Core"'),
      stdout.toString("utf8").replace('"v":"5.1.26100.9168"', '"v":"7.5.0"'),
      stdout.toString("utf8").replace(probe.expected_business_sha256, "0".repeat(64)),
      stdout.toString("utf8").replace('"i":true', '"i":false'),
      stdout.toString("utf8") + "tail",
    ]) {
      expect(() => validateCandidate19GzipBindingProbeResult(Buffer.from(mutation), probe))
        .toThrow("M4F_CANDIDATE19_GZIP_BINDING_PROBE_RESULT_INVALID");
    }
    expect(() => buildCandidate19GzipBindingProbe(config()))
      .toThrow("M4F_CANDIDATE19_GZIP_BINDING_PROBE_PAYLOAD_MISMATCH");
  });

  test("keeps every effect behind retained handles, exact topology and protected CIM checks", () => {
    const source = buildCandidate19BusinessScript(config());
    expect(source).toContain("MSFT_NetTCPConnection -Filter 'LocalPort = 8443 AND State = 2' -ErrorAction Stop");
    expect(source).not.toMatch(/Get-CimClass|Get-NetTCPConnection|netstat|findstr|Stop-Process|taskkill|\.Refresh\(|\.Dispose\(/iu);
    expect(source).toContain("ContainsKey(6100)");
    expect(source).toContain("ContainsKey(24260)");
    expect(source).toContain("'TREE_CLOSURE'");
    expect(source).toContain("DangerousAddRef");
    expect(source).toContain("DangerousGetHandle().ToInt64()");
    expect(source).toContain("$S19v3.Add($S19v");
    expect(source).toMatch(/finally\{foreach\([^\n]+DangerousRelease\(\)/u);
    expect(source).toContain("-not $S19v");
    expect(source).toContain("'RETAINED_HANDLE_DRIFT'");
    expect(source).toContain("WaitForExit(");
    expect(source).toContain("-or -not $S19v");
    const effectLines = source.split("\n");
    const startIndex = effectLines.findIndex((line) => line.includes("'effect_start' 'started'"));
    expect(startIndex).toBeGreaterThan(0);
    expect(effectLines[startIndex + 1]).toMatch(/^\$S19v\d+\.process\.Kill\(\)$/u);
    expect(source.match(/\[Diagnostics\.Process\]::GetProcessById\(/gu)?.length).toBe(2);
  });

  test("accepts a complete exact stream and preserves an invalid raw tail byte-for-byte", () => {
    const complete = parseCandidate19MarkerPrefix(completeStream(), config());
    expect(complete.complete).toBe(true);
    expect(complete.effect_start_ordinals).toEqual([1, 2, 3, 4, 5, 6]);
    expect(complete.effect_result_ordinals).toEqual([1, 2, 3, 4, 5, 6]);
    const tail = Buffer.from([0xff, 0x00, 0x0a]);
    const raw = Buffer.concat([completeStream(), tail]);
    const parsed = parseCandidate19MarkerPrefix(raw, config());
    expect(parsed.complete).toBe(false);
    expect(parsed.valid_prefix).toEqual(completeStream());
    expect(parsed.trailing_fragment).toEqual(tail);
  });

  test("accepts only same-tree console natural exits after that tree's PowerShell result", () => {
    const protectedFact = protection();
    const natural = completeStream((markers) => {
      for (const ordinal of [2, 3, 5, 6]) {
        const startIndex = markers.findIndex((item) => item.phase === "effect_start"
          && (item.payload as Record<string, unknown>).ordinal === ordinal);
        const target = CANDIDATE19_TARGETS[ordinal - 1]!;
        markers.splice(startIndex, 2, JSON.parse(marker("natural_exit", "observed", {
          ordinal,
          pid: target.pid,
          after_ordinal: target.natural_exit_after_ordinal,
          start_token: candidate19StartToken(target),
          raw_handle: String(2000 + ordinal),
          protection_sha256: protectedFact.sha256,
        })));
      }
    });
    const parsed = parseCandidate19MarkerPrefix(natural, config());
    expect(parsed.complete).toBe(true);
    expect(parsed.effect_start_ordinals).toEqual([1, 4]);
    const crossTree = Buffer.from(natural.toString().replace('"after_ordinal":1', '"after_ordinal":4'));
    expect(parseCandidate19MarkerPrefix(crossTree, config()).complete).toBe(false);
  });

  test("rejects forged protection snapshots missing the current process or exact worker", () => {
    for (const fact of [protection(900, false, true), protection(900, true, false)]) {
      const raw = completeStream((markers) => {
        const payload = markers[1]!.payload as Record<string, unknown>;
        payload.protection = fact.value;
        payload.protection_sha256 = fact.sha256;
      });
      const parsed = parseCandidate19MarkerPrefix(raw, config());
      expect(parsed.markers.map((value) => value.phase)).toEqual(["start"]);
      expect(parsed.trailing_fragment.length).toBeGreaterThan(0);
    }
    const raw = completeStream((markers) => {
      const payload = markers[1]!.payload as Record<string, unknown>;
      const protectedFact = protection();
      (protectedFact.value.cores.find((core) => core.pid === 13644)!).parent_pid = 7;
      payload.protection = protectedFact.value;
      payload.protection_sha256 = createHash("sha256")
        .update(JSON.stringify(protectedFact.value)).digest("hex");
    });
    expect(parseCandidate19MarkerPrefix(raw, config()).markers).toHaveLength(1);
    const workerAsCurrent = completeStream((markers) => {
      const start = markers[0]!.payload as Record<string, unknown>;
      start.current_pid = 13644;
    });
    expect(parseCandidate19MarkerPrefix(workerAsCurrent, config()).markers).toHaveLength(0);
  });

  test("reconstructs current ancestry to PID zero and rejects missing, cyclic or forbidden links", () => {
    const cases = [
      (value: ReturnType<typeof protection>["value"]) => {
        value.cores = value.cores.filter((core) => core.pid !== 4);
      },
      (value: ReturnType<typeof protection>["value"]) => {
        value.cores.find((core) => core.pid === 4)!.parent_pid = 900;
      },
      (value: ReturnType<typeof protection>["value"]) => {
        value.cores.find((core) => core.pid === 900)!.parent_pid = CANDIDATE19_TARGETS[0]!.pid;
      },
      (value: ReturnType<typeof protection>["value"]) => {
        value.cores.find((core) => core.pid === 900)!.parent_pid = CANDIDATE19_WORKER.pid;
      },
    ];
    for (const mutate of cases) {
      const raw = completeStream((markers) => {
        const fact = protection();
        mutate(fact.value);
        const payload = markers[1]!.payload as Record<string, unknown>;
        payload.protection = fact.value;
        payload.protection_sha256 = createHash("sha256")
          .update(JSON.stringify(fact.value)).digest("hex");
      });
      const parsed = parseCandidate19MarkerPrefix(raw, config());
      expect(parsed.markers.map((value) => value.phase)).toEqual(["start"]);
    }
  });

  test("accepts failure markers only when pending state and phase match the parsed prefix", () => {
    const effectStart = completeStream();
    const firstResult = effectStart.indexOf(Buffer.from('"phase":"effect_result"'));
    const prefix = effectStart.subarray(0, effectStart.lastIndexOf(0x7b, firstResult));
    const validPending = Buffer.concat([prefix, Buffer.from(marker("failure", "partial_unknown", {
      phase: "effect_result_1",
      error_type: "System.IO.IOException",
      effect_result_pending: true,
      retry_permitted: false,
    }))]);
    const valid = parseCandidate19MarkerPrefix(validPending, config());
    expect(valid.effect_start_ordinals).toEqual([1]);
    expect(valid.markers.at(-1)?.phase).toBe("failure");
    for (const mutation of [
      { phase: "before_effect_1", effect_result_pending: true },
      { phase: "effect_result_1", effect_result_pending: false },
    ]) {
      const raw = Buffer.concat([prefix, Buffer.from(marker("failure", "partial_unknown", {
        ...mutation,
        error_type: "System.IO.IOException",
        retry_permitted: false,
      }))]);
      expect(parseCandidate19MarkerPrefix(raw, config()).markers.at(-1)?.phase).toBe("effect_start");
    }
    const complete = completeStream();
    const firstStart = complete.indexOf(Buffer.from('"phase":"effect_start"'));
    const beforeEffect = complete.subarray(0, complete.lastIndexOf(0x7b, firstStart));
    const validBefore = Buffer.concat([beforeEffect, Buffer.from(marker("failure", "partial_unknown", {
      phase: "before_effect_1",
      error_type: "System.InvalidOperationException",
      effect_result_pending: false,
      retry_permitted: false,
    }))]);
    expect(parseCandidate19MarkerPrefix(validBefore, config()).markers.at(-1)?.phase).toBe("failure");
  });

  test("treats effect_start without a flushed result as the authoritative partial prefix", () => {
    const raw = completeStream();
    const firstResult = raw.indexOf(Buffer.from('"phase":"effect_result"'));
    const firstResultLine = raw.lastIndexOf(0x7b, firstResult);
    const partial = Buffer.concat([raw.subarray(0, firstResultLine), Buffer.from("{\"truncated\":")]);
    const parsed = parseCandidate19MarkerPrefix(partial, config());
    expect(parsed.effect_start_ordinals).toEqual([1]);
    expect(parsed.effect_result_ordinals).toEqual([]);
    expect(parsed.complete).toBe(false);
    expect(parsed.trailing_fragment.toString()).toBe('{"truncated":');
  });
});
