import { sha256Hex } from "../core/src/hashing.ts";

export type RuntimeWorkspaceFileInput =
  | {
      readonly path: string;
      readonly content: string;
      readonly contentBase64?: never;
    }
  | {
      readonly path: string;
      readonly content?: never;
      readonly contentBase64: string;
    };

export interface EncodedWorkspaceContent {
  readonly encoding: "utf8" | "base64";
  readonly content: string | null;
  readonly contentBase64: string | null;
  readonly bytes: number;
}

export function workspaceInputBytes(file: RuntimeWorkspaceFileInput): Uint8Array {
  return typeof file.content === "string"
    ? new TextEncoder().encode(file.content)
    : Buffer.from(file.contentBase64, "base64");
}

export function workspaceInputHash(file: RuntimeWorkspaceFileInput): string {
  return sha256Hex(workspaceInputBytes(file));
}

export function encodeWorkspaceBytes(bytes: Uint8Array): EncodedWorkspaceContent {
  try {
    return {
      encoding: "utf8",
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      contentBase64: null,
      bytes: bytes.byteLength,
    };
  } catch {
    return {
      encoding: "base64",
      content: null,
      contentBase64: Buffer.from(bytes).toString("base64"),
      bytes: bytes.byteLength,
    };
  }
}

export function isCanonicalBase64(value: string): boolean {
  if (value === "") return true;
  if (value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

export function parseWorkspaceResponse(data: Record<string, unknown>, path: string): EncodedWorkspaceContent {
  const encoding = data.encoding;
  if (encoding === "utf8" && typeof data.content === "string") {
    const bytes = new TextEncoder().encode(data.content);
    return { encoding, content: data.content, contentBase64: null, bytes: bytes.byteLength };
  }
  if (
    encoding === "base64"
    && typeof data.content_base64 === "string"
    && isCanonicalBase64(data.content_base64)
  ) {
    const bytes = Buffer.from(data.content_base64, "base64");
    return { encoding, content: null, contentBase64: data.content_base64, bytes: bytes.byteLength };
  }
  // Compatibility with pre-binary Core responses that did not expose encoding.
  if (encoding === undefined && typeof data.content === "string") {
    const bytes = new TextEncoder().encode(data.content);
    return { encoding: "utf8", content: data.content, contentBase64: null, bytes: bytes.byteLength };
  }
  throw new Error(`workspace file response is invalid for ${path}`);
}
