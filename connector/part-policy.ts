export type PartPolicy = string | readonly string[];

const PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validatePartPolicy(value: unknown): PartPolicy {
  if (value === "any") return value;
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.length > 4096 || values.some((part) => typeof part !== "string" || !PART_PATTERN.test(part) || part.toLowerCase() === "any")
    || new Set(values).size !== values.length) throw new Error("CONFIG_INVALID:vivado_part");
  return Array.isArray(value) ? [...values] : values[0];
}

export function resolveJobPart(policy: PartPolicy, candidate: Record<string, unknown>): string {
  const part = candidate.part;
  if (typeof part !== "string" || !PART_PATTERN.test(part) || part.toLowerCase() === "any") throw new Error("PART_REQUIRED");
  if (policy !== "any" && !(Array.isArray(policy) ? policy : [policy]).includes(part)) throw new Error("PART_NOT_ALLOWED");
  const nested = candidate.toolchain;
  if (nested && typeof nested === "object" && "part" in nested && nested.part !== part) throw new Error("FORMAL_BINDING_MISMATCH");
  return part;
}
