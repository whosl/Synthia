import { StringDecoder } from "node:string_decoder";

export const MAX_PROCESS_OUTPUT_BYTES = 5 * 1024 * 1024;
const TRUNCATION_NOTE = "\n[TRUNCATED: output capped at 5 MiB]\n";
const CONTENT_BUDGET = MAX_PROCESS_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTE);

/** Preserve H32's bounded capture when rebuilding the canonical Worker bundle. */
export function createOutputCapture() {
  const decoder = new StringDecoder("utf8");
  let content = "";
  let accepted = 0;
  let truncated = false;
  return {
    append(chunk: Buffer): void {
      const remaining = Math.max(0, CONTENT_BUDGET - accepted);
      const take = Math.min(remaining, chunk.length);
      if (take > 0) { content += decoder.write(chunk.subarray(0, take)); accepted += take; }
      if (take < chunk.length) truncated = true;
    },
    text(): string {
      return content + (truncated ? TRUNCATION_NOTE : "");
    },
  };
}

export function capOutput(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_PROCESS_OUTPUT_BYTES) return text;
  const capture = createOutputCapture();
  capture.append(Buffer.from(text, "utf8"));
  return capture.text();
}
