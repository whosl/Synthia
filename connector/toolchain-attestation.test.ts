import { describe, expect, test } from "bun:test";
import { canonicalEvolutionEvalHash } from "./evolution-eval.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveVivadoToolchainProfileHash,
  loadVivadoToolchainAttestation,
  validateFullTreeManifest,
  validateVivadoToolchainAttestation,
  type VivadoToolchainAttestationV1,
} from "./toolchain-attestation.ts";

const h = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

function tree(entries = [
  { path: "Vivado", type: "directory" as const, size_bytes: 0, sha256: null },
  { path: "Vivado/bin/vivado.bat", type: "regular_file" as const, size_bytes: 3, sha256: h("bat") },
]) {
  const body = {
    schema: "synthia-vivado-full-tree-manifest.v1" as const,
    canonicalization: "RFC8785/JCS+NFC" as const,
    entries,
    entry_count: entries.length,
    file_count: entries.filter((entry) => entry.type === "regular_file").length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
  };
  return { ...body, canonical_sha256: canonicalEvolutionEvalHash(body) };
}

function attestation() {
  const body = {
    schema: "synthia-vivado-toolchain-attestation.v1" as const,
    gate_id: "m4f-test",
    issued_at: "2026-08-27T00:00:00.000Z",
    not_before: "2026-08-27T00:00:00.000Z",
    expires_at: "2026-08-27T04:00:00.000Z",
    vhdx: {
      path: "D:\\synthia-toolchain\\vivado-2021.1.vhdx",
      sha256: h("vhdx"),
      size_bytes: 1,
      file_identity: { volume_serial_number: "D-SERIAL", file_id: "0x1234" },
      backing_parent: { path: "D:\\synthia-toolchain", owner_sid: "S-1-5-18", acl_sha256: h("acl"), protected: true as const },
    },
    attachment: {
      image_path: "D:\\synthia-toolchain\\vivado-2021.1.vhdx",
      attached: true as const,
      read_only: true as const,
      disk: { number: 4, unique_id: "disk-unique" },
      partition: { number: 1, guid: "partition-guid" },
      volume: {
        guid: "volume-guid",
        serial_number: "VOL-SERIAL",
        file_system: "NTFS" as const,
        mount_path: "V:\\",
        identity_canonical_sha256: canonicalEvolutionEvalHash({ guid: "volume-guid", serial_number: "VOL-SERIAL", file_system: "NTFS", mount_path: "V:\\" }),
      },
      write_probe: "access_denied" as const,
      backing_file_identity: { volume_serial_number: "D-SERIAL", file_id: "0x1234" },
    },
    full_tree_manifest: {
      schema: "synthia-vivado-full-tree-manifest.v1" as const,
      canonical_sha256: tree().canonical_sha256,
      entry_count: 2,
      file_count: 1,
      total_bytes: 3,
    },
    vivado: {
      binary_relative_path: "Vivado/bin/vivado.bat",
      version: "2021.1" as const,
      sw_build: "3247384" as const,
      ip_build: "3246043" as const,
      version_probe_stdout_sha256: h("version"),
      part_catalog_sha256: h("parts"),
      target_part: "xc7k70tfbv676-1" as const,
      part_present: true as const,
      part_probe_stdout_sha256: h("part"),
      license: { status: "passed" as const, stdout_sha256: h("license"), exit_code: 0 as const },
      minimal_synth: { status: "passed" as const, input_sha256: h("synth-input"), stdout_sha256: h("synth-output"), exit_code: 0 as const },
    },
    toolchain_profile: {
      capability_map_version: "vivado-2021.1-1",
      semantic_profile_sha256: h("semantics"),
      derived_sha256: "",
    },
  };
  body.toolchain_profile.derived_sha256 = deriveVivadoToolchainProfileHash(body as Omit<VivadoToolchainAttestationV1, "canonical_attestation_sha256">);
  return { ...body, canonical_attestation_sha256: canonicalEvolutionEvalHash(body) };
}

describe("Vivado toolchain attestation", () => {
  test("accepts only the exact signed schema and recomputes both derived hashes", () => {
    const value = attestation();
    expect(validateVivadoToolchainAttestation(value, { now: new Date("2026-08-27T02:00:00.000Z") }))
      .toEqual(value);
    expect(() => validateVivadoToolchainAttestation({ ...value, surprise: true }, { now: new Date("2026-08-27T02:00:00.000Z") }))
      .toThrow("TOOLCHAIN_ATTESTATION_INVALID:root:shape");
    expect(() => validateVivadoToolchainAttestation({ ...value, attachment: { ...value.attachment, read_only: false } }, { now: new Date("2026-08-27T02:00:00.000Z") }))
      .toThrow("TOOLCHAIN_ATTESTATION_INVALID:attachment");
    expect(() => validateVivadoToolchainAttestation({ ...value, expires_at: "2026-08-27T04:00:00.001Z" }, { now: new Date("2026-08-27T02:00:00.000Z") }))
      .toThrow("TOOLCHAIN_ATTESTATION_INVALID:validity");
  });

  test("loader binds raw file bytes and rejects expiry", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-toolchain-attestation-"));
    try {
      const bytes = `${JSON.stringify(attestation())}\n`;
      const path = join(root, "attestation.json");
      await writeFile(path, bytes);
      expect((await loadVivadoToolchainAttestation(path, h(bytes), new Date("2026-08-27T03:59:59.999Z"))).rawSha256).toBe(h(bytes));
      await expect(loadVivadoToolchainAttestation(path, "f".repeat(64), new Date("2026-08-27T03:00:00.000Z")))
        .rejects.toThrow("TOOLCHAIN_ATTESTATION_INVALID:raw_sha256");
      await expect(loadVivadoToolchainAttestation(path, h(bytes), new Date("2026-08-27T04:00:00.000Z")))
        .rejects.toThrow("TOOLCHAIN_ATTESTATION_INVALID:validity");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("full-tree canonicalization rejects ordering, traversal, collisions, and summary drift", () => {
    expect(validateFullTreeManifest(tree())).toEqual(tree());
    for (const invalid of [
      tree([tree().entries[1]!, tree().entries[0]!]),
      tree([{ path: "../Vivado", type: "directory", size_bytes: 0, sha256: null }]),
      { ...tree(), entries: [{ path: `Vivado/${String.fromCharCode(0xd800)}`, type: "directory", size_bytes: 0, sha256: null }], entry_count: 1, file_count: 0, total_bytes: 0 },
      tree([
        { path: "Vivado/A", type: "regular_file", size_bytes: 1, sha256: h("a") },
        { path: "vivado/a", type: "regular_file", size_bytes: 1, sha256: h("b") },
      ]),
      { ...tree(), total_bytes: 4 },
    ]) expect(() => validateFullTreeManifest(invalid)).toThrow("TOOLCHAIN_ATTESTATION_INVALID");
  });

  test("portable paths accept multibyte names beyond 512 bytes through 4096 and reject 4097", () => {
    const name513 = "界".repeat(171);
    const path4096 = `${"a".repeat(3582)}/${name513}`;
    expect(Buffer.byteLength(name513)).toBe(513);
    expect(Buffer.byteLength(path4096)).toBe(4096);
    expect(validateFullTreeManifest(tree([
      { path: name513, type: "regular_file", size_bytes: 1, sha256: h("long") },
    ])).entries[0]!.path).toBe(name513);
    expect(validateFullTreeManifest(tree([
      { path: path4096, type: "regular_file", size_bytes: 1, sha256: h("max") },
    ])).entries[0]!.path).toBe(path4096);
    expect(() => validateFullTreeManifest(tree([
      { path: `${path4096}a`, type: "regular_file", size_bytes: 1, sha256: h("too-long") },
    ]))).toThrow("TOOLCHAIN_ATTESTATION_INVALID:full_tree:path");
  });
});
