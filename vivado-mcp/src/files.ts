import { createServer } from "node:net";

const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;

function reject(code: string): never { throw new Error(`VIVADO_MCP_${code}`); }

/** A workspace id is exactly one portable path segment (`<workspaceRoot>/<id>`). */
export function assertWorkspaceId(id: string): void {
  if (typeof id !== "string" || !WORKSPACE_ID_RE.test(id)) reject("INVALID_WORKSPACE");
  if (id === "." || id === ".." || /[ .]$/.test(id)) reject("INVALID_WORKSPACE");
  const deviceName = id.split(".", 1)[0]!.replace(/[ .]+$/u, "");
  if (WINDOWS_RESERVED_NAME.test(deviceName)) reject("INVALID_WORKSPACE");
}

/**
 * Portable relative-path policy, ported from connector/vivado.ts `safePath`
 * (not exported there). Accepts multi-segment relative paths only.
 */
export function assertSafeRelativePath(path: string): void {
  if (typeof path !== "string"
    || !path
    || Buffer.byteLength(path, "utf8") > 512
    || path !== path.normalize("NFC")
    || path.startsWith("/")
    || path.startsWith("\\")
    || path.includes("\\")
    || path.includes("\0")) reject("INVALID_PATH");
  const segments = path.split("/");
  if (segments.length === 0 || segments.length > 32) reject("INVALID_PATH");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".."
      || Buffer.byteLength(segment, "utf8") > 255
      || /[\x00-\x1f\x7f:*?"<>|]/u.test(segment)
      || /[ .]$/.test(segment)) reject("INVALID_PATH");
    const deviceName = segment.split(".", 1)[0]!.replace(/[ .]+$/u, "");
    if (WINDOWS_RESERVED_NAME.test(deviceName)) reject("INVALID_PATH");
  }
}

export interface Truncation { readonly text: string; readonly truncatedBytes: number }

/**
 * Keep head and tail of oversized tool output. Full untruncated output always
 * lands in the workspace `output/` logs; this only bounds what returns over MCP.
 */
export function truncateMiddle(text: string, maxBytes: number): Truncation {
  if (maxBytes <= 0) return { text: "", truncatedBytes: Buffer.byteLength(text, "utf8") };
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return { text, truncatedBytes: 0 };
  const marker = `\n...[truncated ${bytes.byteLength - maxBytes} bytes; full output in workspace output/ logs]...\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  const headBytes = Math.floor(budget * 0.75);
  const tailBytes = budget - headBytes;
  const sliced = Buffer.concat([bytes.subarray(0, headBytes), Buffer.from(marker, "utf8"), bytes.subarray(bytes.byteLength - tailBytes)]);
  return { text: sliced.toString("utf8"), truncatedBytes: bytes.byteLength - maxBytes };
}

/** Reserve an ephemeral port (tests pick a free port before server.start). */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port ? resolve(port) : rejectPromise(new Error("VIVADO_MCP_PORT_UNAVAILABLE"))));
    });
  });
}
