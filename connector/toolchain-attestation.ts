import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { lstat, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { canonicalRequestHash as canonicalEvolutionEvalHash } from "../core/src/hashing.ts";

export const VIVADO_TOOLCHAIN_ATTESTATION_SCHEMA = "synthia-vivado-toolchain-attestation.v1" as const;
export const FULL_TREE_MANIFEST_SCHEMA = "synthia-vivado-full-tree-manifest.v1" as const;
const HASH = /^[0-9a-f]{64}$/;
const EXPECTED_PART = "xc7k70tfbv676-1";
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface FullTreeManifestEntryV1 {
  readonly path: string;
  readonly type: "regular_file" | "directory";
  readonly size_bytes: number;
  readonly sha256: string | null;
}

export interface FullTreeManifestV1 {
  readonly schema: typeof FULL_TREE_MANIFEST_SCHEMA;
  readonly canonicalization: "RFC8785/JCS+NFC";
  readonly entries: readonly FullTreeManifestEntryV1[];
  readonly entry_count: number;
  readonly file_count: number;
  readonly total_bytes: number;
  readonly canonical_sha256: string;
}

export interface VivadoToolchainAttestationV1 {
  readonly schema: typeof VIVADO_TOOLCHAIN_ATTESTATION_SCHEMA;
  readonly gate_id: string;
  readonly issued_at: string;
  readonly not_before: string;
  readonly expires_at: string;
  readonly vhdx: {
    readonly path: string;
    readonly sha256: string;
    readonly size_bytes: number;
    readonly file_identity: { readonly volume_serial_number: string; readonly file_id: string };
    readonly backing_parent: { readonly path: string; readonly owner_sid: string; readonly acl_sha256: string; readonly protected: true };
  };
  readonly attachment: {
    readonly image_path: string;
    readonly attached: true;
    readonly read_only: true;
    readonly disk: { readonly number: number; readonly unique_id: string };
    readonly partition: { readonly number: number; readonly guid: string };
    readonly volume: {
      readonly guid: string;
      readonly serial_number: string;
      readonly file_system: "NTFS";
      readonly mount_path: string;
      readonly identity_canonical_sha256: string;
    };
    readonly write_probe: "access_denied";
    readonly backing_file_identity: { readonly volume_serial_number: string; readonly file_id: string };
  };
  readonly full_tree_manifest: {
    readonly schema: typeof FULL_TREE_MANIFEST_SCHEMA;
    readonly canonical_sha256: string;
    readonly entry_count: number;
    readonly file_count: number;
    readonly total_bytes: number;
  };
  readonly vivado: {
    readonly binary_relative_path: string;
    readonly version: "2021.1";
    readonly sw_build: "3247384";
    readonly ip_build: "3246043";
    readonly version_probe_stdout_sha256: string;
    readonly part_catalog_sha256: string;
    readonly target_part: typeof EXPECTED_PART;
    readonly part_present: true;
    readonly part_probe_stdout_sha256: string;
    readonly license: { readonly status: "passed"; readonly stdout_sha256: string; readonly exit_code: 0 };
    readonly minimal_synth: { readonly status: "passed"; readonly input_sha256: string; readonly stdout_sha256: string; readonly exit_code: 0 };
  };
  readonly toolchain_profile: {
    readonly capability_map_version: string;
    readonly semantic_profile_sha256: string;
    readonly derived_sha256: string;
  };
  readonly canonical_attestation_sha256: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const candidate = record(value, label);
  const actual = Object.keys(candidate).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}:shape`);
  }
  return candidate;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}`);
  return value;
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum
    || /[\u0000-\u001f\u007f]/u.test(value) || hasLoneSurrogate(value) || value.normalize("NFC") !== value) {
    throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}`);
  }
  return value;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}`);
  return Number(value);
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !value.endsWith("Z")) throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}`);
  return parsed;
}

function windowsPathEqual(left: string, right: string): boolean {
  return left.replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase()
    === right.replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase();
}

function portableRelativePath(value: unknown, label: string): string {
  const path = text(value, label, 4096);
  if (path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/u.test(path)
    || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`TOOLCHAIN_ATTESTATION_INVALID:${label}`);
  }
  return path;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function validateFullTreeManifest(value: unknown): FullTreeManifestV1 {
  const manifest = exact(value, ["schema", "canonicalization", "entries", "entry_count", "file_count", "total_bytes", "canonical_sha256"], "full_tree");
  if (manifest.schema !== FULL_TREE_MANIFEST_SCHEMA) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:schema");
  if (manifest.canonicalization !== "RFC8785/JCS+NFC") throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:canonicalization");
  if (!Array.isArray(manifest.entries)) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:entries");
  let files = 0;
  let directories = 0;
  let bytes = 0;
  const folded = new Set<string>();
  let previous: string | undefined;
  for (const raw of manifest.entries) {
    const entry = exact(raw, ["path", "type", "size_bytes", "sha256"], "full_tree:entry");
    const path = portableRelativePath(entry.path, "full_tree:path");
    if (previous !== undefined && compareUtf8(previous, path) >= 0) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:order");
    previous = path;
    const collisionKey = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(collisionKey)) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:path_collision");
    folded.add(collisionKey);
    if (entry.type === "regular_file") {
      files += 1;
      bytes += integer(entry.size_bytes, "full_tree:file_size");
      hash(entry.sha256, "full_tree:file_hash");
    } else if (entry.type === "directory") {
      directories += 1;
      if (entry.size_bytes !== 0 || entry.sha256 !== null) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:directory");
    } else {
      throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:type");
    }
  }
  if (manifest.entry_count !== manifest.entries.length || manifest.file_count !== files
    || manifest.total_bytes !== bytes || manifest.entries.length !== files + directories
    || manifest.entries.length < 1 || files < 1 || bytes < 1) {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:summary");
  }
  const canonical = hash(manifest.canonical_sha256, "full_tree:canonical_hash");
  const body = { ...manifest };
  delete body.canonical_sha256;
  if (canonicalEvolutionEvalHash(body) !== canonical) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:canonical_hash");
  return structuredClone(value) as FullTreeManifestV1;
}

async function hashFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

export async function buildFullTreeManifest(root: string): Promise<FullTreeManifestV1> {
  const rootFacts = await lstat(root);
  if (rootFacts.isSymbolicLink()) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:reparse");
  if (!rootFacts.isDirectory()) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:root");
  const entries: FullTreeManifestEntryV1[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      text(name, "full_tree:name", 4096);
      const relative = prefix ? `${prefix}/${name}` : name;
      portableRelativePath(relative, "full_tree:path");
      const absolute = join(directory, name);
      const facts = await lstat(absolute);
      if (facts.isSymbolicLink()) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:reparse");
      if (facts.isDirectory()) {
        entries.push({ path: relative, type: "directory", size_bytes: 0, sha256: null });
        await walk(absolute, relative);
      } else if (facts.isFile()) {
        entries.push({ path: relative, type: "regular_file", size_bytes: facts.size, sha256: await hashFile(absolute) });
      } else {
        throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree:unknown_entry");
      }
    }
  };
  await walk(root, "");
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  const body = {
    schema: FULL_TREE_MANIFEST_SCHEMA,
    canonicalization: "RFC8785/JCS+NFC" as const,
    entries,
    entry_count: entries.length,
    file_count: entries.filter((entry) => entry.type === "regular_file").length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
  };
  return validateFullTreeManifest({ ...body, canonical_sha256: canonicalEvolutionEvalHash(body) });
}

export function deriveVivadoToolchainProfileHash(attestation: Omit<VivadoToolchainAttestationV1, "canonical_attestation_sha256">): string {
  return canonicalEvolutionEvalHash({
    schema: "synthia-vivado-toolchain-profile-derivation.v1",
    capability_map_version: attestation.toolchain_profile.capability_map_version,
    semantic_profile_sha256: attestation.toolchain_profile.semantic_profile_sha256,
    full_tree_manifest_sha256: attestation.full_tree_manifest.canonical_sha256,
    volume_identity_canonical_sha256: attestation.attachment.volume.identity_canonical_sha256,
    binary_relative_path: attestation.vivado.binary_relative_path,
    version: attestation.vivado.version,
    sw_build: attestation.vivado.sw_build,
    ip_build: attestation.vivado.ip_build,
    part_catalog_sha256: attestation.vivado.part_catalog_sha256,
    target_part: attestation.vivado.target_part,
    part_probe_stdout_sha256: attestation.vivado.part_probe_stdout_sha256,
    license_probe_stdout_sha256: attestation.vivado.license.stdout_sha256,
    synth_input_sha256: attestation.vivado.minimal_synth.input_sha256,
    synth_stdout_sha256: attestation.vivado.minimal_synth.stdout_sha256,
  });
}

export function validateVivadoToolchainAttestation(
  value: unknown,
  options: { readonly now?: Date; readonly expectedRawSha256?: string; readonly rawBytes?: Uint8Array } = {},
): VivadoToolchainAttestationV1 {
  const attestation = exact(value, ["schema", "gate_id", "issued_at", "not_before", "expires_at", "vhdx", "attachment", "full_tree_manifest", "vivado", "toolchain_profile", "canonical_attestation_sha256"], "root");
  if (attestation.schema !== VIVADO_TOOLCHAIN_ATTESTATION_SCHEMA) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:schema");
  const gateId = text(attestation.gate_id, "gate_id", 64);
  if (!OPAQUE.test(gateId)) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:gate_id");
  const issued = timestamp(attestation.issued_at, "issued_at");
  const notBefore = timestamp(attestation.not_before, "not_before");
  const expires = timestamp(attestation.expires_at, "expires_at");
  const now = (options.now ?? new Date()).getTime();
  if (issued > notBefore || expires <= notBefore || expires - notBefore > 4 * 60 * 60 * 1000 || now < notBefore || now >= expires) {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:validity");
  }
  const vhdx = exact(attestation.vhdx, ["path", "sha256", "size_bytes", "file_identity", "backing_parent"], "vhdx");
  const vhdxPath = text(vhdx.path, "vhdx:path");
  hash(vhdx.sha256, "vhdx:sha256");
  integer(vhdx.size_bytes, "vhdx:size", 1);
  const preIdentity = exact(vhdx.file_identity, ["volume_serial_number", "file_id"], "vhdx:file_identity");
  text(preIdentity.volume_serial_number, "vhdx:volume_serial_number", 128);
  text(preIdentity.file_id, "vhdx:file_id", 128);
  const parent = exact(vhdx.backing_parent, ["path", "owner_sid", "acl_sha256", "protected"], "vhdx:backing_parent");
  text(parent.path, "vhdx:backing_parent:path");
  text(parent.owner_sid, "vhdx:backing_parent:owner_sid", 184);
  hash(parent.acl_sha256, "vhdx:backing_parent:acl_sha256");
  if (parent.protected !== true) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:vhdx:backing_parent:protected");

  const attachment = exact(attestation.attachment, ["image_path", "attached", "read_only", "disk", "partition", "volume", "write_probe", "backing_file_identity"], "attachment");
  if (!windowsPathEqual(text(attachment.image_path, "attachment:image_path"), vhdxPath)
    || attachment.attached !== true || attachment.read_only !== true || attachment.write_probe !== "access_denied") {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:attachment");
  }
  const attachedIdentity = exact(attachment.backing_file_identity, ["volume_serial_number", "file_id"], "attachment:file_identity");
  if (attachedIdentity.volume_serial_number !== preIdentity.volume_serial_number || attachedIdentity.file_id !== preIdentity.file_id) {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:attachment:file_identity");
  }
  const disk = exact(attachment.disk, ["number", "unique_id"], "attachment:disk");
  integer(disk.number, "attachment:disk:number");
  text(disk.unique_id, "attachment:disk:unique_id", 256);
  const partition = exact(attachment.partition, ["number", "guid"], "attachment:partition");
  integer(partition.number, "attachment:partition:number", 1);
  text(partition.guid, "attachment:partition:guid", 128);
  const volume = exact(attachment.volume, ["guid", "serial_number", "file_system", "mount_path", "identity_canonical_sha256"], "attachment:volume");
  text(volume.guid, "attachment:volume:guid", 128);
  text(volume.serial_number, "attachment:volume:serial_number", 128);
  if (volume.file_system !== "NTFS") throw new Error("TOOLCHAIN_ATTESTATION_INVALID:attachment:volume:file_system");
  text(volume.mount_path, "attachment:volume:mount_path");
  const volumeIdentityHash = hash(volume.identity_canonical_sha256, "attachment:volume:identity_hash");
  if (volumeIdentityHash !== canonicalEvolutionEvalHash({
    guid: volume.guid,
    serial_number: volume.serial_number,
    file_system: volume.file_system,
    mount_path: volume.mount_path,
  })) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:attachment:volume:identity_hash");

  const tree = exact(attestation.full_tree_manifest, ["schema", "canonical_sha256", "entry_count", "file_count", "total_bytes"], "full_tree_manifest");
  if (tree.schema !== FULL_TREE_MANIFEST_SCHEMA) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree_manifest");
  hash(tree.canonical_sha256, "full_tree_manifest:canonical_sha256");
  for (const name of ["entry_count", "file_count", "total_bytes"] as const) integer(tree[name], `full_tree_manifest:${name}`);
  if (Number(tree.file_count) > Number(tree.entry_count) || Number(tree.file_count) < 1
    || Number(tree.entry_count) < 1 || Number(tree.total_bytes) < 1) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:full_tree_manifest:counts");

  const vivado = exact(attestation.vivado, ["binary_relative_path", "version", "sw_build", "ip_build", "version_probe_stdout_sha256", "part_catalog_sha256", "target_part", "part_present", "part_probe_stdout_sha256", "license", "minimal_synth"], "vivado");
  portableRelativePath(vivado.binary_relative_path, "vivado:binary_relative_path");
  if (vivado.version !== "2021.1" || vivado.sw_build !== "3247384" || vivado.ip_build !== "3246043"
    || vivado.target_part !== EXPECTED_PART || vivado.part_present !== true) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:vivado:facts");
  for (const name of ["version_probe_stdout_sha256", "part_catalog_sha256", "part_probe_stdout_sha256"] as const) hash(vivado[name], `vivado:${name}`);
  const license = exact(vivado.license, ["status", "stdout_sha256", "exit_code"], "vivado:license");
  if (license.status !== "passed" || license.exit_code !== 0) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:vivado:license");
  hash(license.stdout_sha256, "vivado:license:stdout_sha256");
  const synth = exact(vivado.minimal_synth, ["status", "input_sha256", "stdout_sha256", "exit_code"], "vivado:minimal_synth");
  if (synth.status !== "passed" || synth.exit_code !== 0) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:vivado:minimal_synth");
  hash(synth.input_sha256, "vivado:minimal_synth:input_sha256");
  hash(synth.stdout_sha256, "vivado:minimal_synth:stdout_sha256");

  const profile = exact(attestation.toolchain_profile, ["capability_map_version", "semantic_profile_sha256", "derived_sha256"], "toolchain_profile");
  text(profile.capability_map_version, "toolchain_profile:capability_map_version", 128);
  hash(profile.semantic_profile_sha256, "toolchain_profile:semantic_profile_sha256");
  const derived = hash(profile.derived_sha256, "toolchain_profile:derived_sha256");
  const typedBody = { ...attestation } as unknown as VivadoToolchainAttestationV1;
  delete (typedBody as unknown as Record<string, unknown>).canonical_attestation_sha256;
  if (deriveVivadoToolchainProfileHash(typedBody as Omit<VivadoToolchainAttestationV1, "canonical_attestation_sha256">) !== derived) {
    throw new Error("TOOLCHAIN_ATTESTATION_INVALID:toolchain_profile:derived_sha256");
  }
  const canonicalHash = hash(attestation.canonical_attestation_sha256, "canonical_attestation_sha256");
  if (canonicalEvolutionEvalHash(typedBody) !== canonicalHash) throw new Error("TOOLCHAIN_ATTESTATION_INVALID:canonical_attestation_sha256");
  if (options.expectedRawSha256 !== undefined) {
    const expected = hash(options.expectedRawSha256, "raw_sha256");
    if (!options.rawBytes || createHash("sha256").update(options.rawBytes).digest("hex") !== expected) {
      throw new Error("TOOLCHAIN_ATTESTATION_INVALID:raw_sha256");
    }
  }
  return structuredClone(value) as VivadoToolchainAttestationV1;
}

export async function loadVivadoToolchainAttestation(
  path: string,
  expectedRawSha256: string,
  now = new Date(),
): Promise<{ readonly attestation: VivadoToolchainAttestationV1; readonly rawSha256: string }> {
  const bytes = await readFile(path);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("TOOLCHAIN_ATTESTATION_INVALID:json"); }
  return {
    attestation: validateVivadoToolchainAttestation(value, { now, expectedRawSha256, rawBytes: bytes }),
    rawSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function finalizeVivadoToolchainAttestation(value: unknown, now = new Date()): VivadoToolchainAttestationV1 {
  const draft = structuredClone(record(value, "root")) as unknown as VivadoToolchainAttestationV1;
  if (draft.attachment?.volume && typeof draft.attachment.volume === "object") {
    (draft.attachment.volume as { identity_canonical_sha256: string }).identity_canonical_sha256 = canonicalEvolutionEvalHash({
      guid: draft.attachment.volume.guid,
      serial_number: draft.attachment.volume.serial_number,
      file_system: draft.attachment.volume.file_system,
      mount_path: draft.attachment.volume.mount_path,
    });
  }
  if (draft.toolchain_profile && typeof draft.toolchain_profile === "object") {
    (draft.toolchain_profile as { derived_sha256: string }).derived_sha256 = deriveVivadoToolchainProfileHash(draft);
  }
  const body = { ...draft } as unknown as Record<string, unknown>;
  delete body.canonical_attestation_sha256;
  (draft as { canonical_attestation_sha256: string }).canonical_attestation_sha256 = canonicalEvolutionEvalHash(body);
  return validateVivadoToolchainAttestation(draft, { now });
}
