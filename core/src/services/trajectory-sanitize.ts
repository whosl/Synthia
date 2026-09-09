/** Deterministic redaction for source-derived Distiller inputs. */

import { canonicalRequestHash, sha256Hex } from "../hashing.ts";

const PRIVATE_CONTENT = /\b(?:confidential|proprietary|private[- ]project|customer[- ]specific|internal[- ]only)\b/i;
const SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|client[_-]?secret|credential|password|private[_-]?key|refresh[_-]?token|secret|token)(?:$|[_-])/i;
const SOURCE_REF_KEY = /(?:^|[_-])(?:project|task|episode|application|evidence|workspace|tool[_-]?run|turn)(?:[_-]?(?:id|ref|key))?(?:$|[_-])/i;

function marker(kind: string, value: unknown): string {
  return `[REDACTED:${kind}:${canonicalRequestHash(value).slice(0, 16)}]`;
}

/**
 * Redacts sensitive spans without relying on ambient project state. The hash in
 * each marker is deliberately stable so repeated observations remain
 * correlatable without disclosing the source value.
 */
export function sanitizeTrajectoryText(value: string): string {
  if (PRIVATE_CONTENT.test(value)) return marker("PRIVATE_CONTENT", value);
  return value
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
      (secret) => marker("SECRET", secret),
    )
    .replace(/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, (secret) => marker("SECRET", secret))
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, (secret) => marker("SECRET", secret))
    .replace(
      /\b(?:api[\s_-]?key|access[\s_-]?token|client[\s_-]?secret|refresh[\s_-]?token|aws[\s_-]?secret[\s_-]?access[\s_-]?key|authorization|password|credential|secret|token)\b\s*[:=]\s*(?:(?:Basic|Bearer)\s+)?["']?[^\s,"'}\]]{4,}["']?/gi,
      (secret) => marker("SECRET", secret),
    )
    .replace(/(?:^|[\s"'=(,:])(?:\/(?!\/)[^\s"'`<>{}\[\]]+|[A-Za-z]:\\[^\s"'`<>{}\[\]]*)/gm, (path) => {
      const prefix = /^\s/.test(path) ? path[0]! : "";
      const raw = prefix ? path.slice(1) : path;
      return `${prefix}${marker("ABSOLUTE_PATH", raw)}`;
    })
    .replace(
      /\b(?:project|task|episode|application|evidence|workspace|tool[_-]?run|turn)[_-](?:[A-Za-z0-9][A-Za-z0-9_.:-]{4,})\b/gi,
      (ref) => marker("SOURCE_REF", ref),
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (email) => marker("CONTACT", email));
}

/** Recursively sanitizes JSON-like values and sorts object keys deterministically. */
export function sanitizeTrajectoryValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return marker("SECRET", value);
  if (SOURCE_REF_KEY.test(key)) return marker("SOURCE_REF", value);
  if (typeof value === "string") return sanitizeTrajectoryText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeTrajectoryValue(item, key));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((childKey) => [
          childKey,
          sanitizeTrajectoryValue((value as Record<string, unknown>)[childKey], childKey),
        ]),
    );
  }
  return marker("NON_JSON_VALUE", String(value));
}

export function sanitizeTrajectoryRef(kind: string, value: string): string {
  return marker(kind, value);
}

export function rawTrajectoryHash(value: unknown): string {
  return typeof value === "string" ? sha256Hex(value) : canonicalRequestHash(value);
}
