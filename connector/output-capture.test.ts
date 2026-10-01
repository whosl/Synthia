import { expect, test } from "bun:test";
import { capOutput, createOutputCapture, MAX_PROCESS_OUTPUT_BYTES } from "./output-capture.ts";

test("H32 canonical output capture bounds repeated writes and evidence to 5 MiB", () => {
  const capture = createOutputCapture();
  const chunk = Buffer.from("中".repeat(100_000));
  for (let i = 0; i < 100; i++) capture.append(chunk);
  expect(Buffer.byteLength(capture.text())).toBeLessThanOrEqual(MAX_PROCESS_OUTPUT_BYTES);
  expect(capture.text()).toContain("TRUNCATED");
  expect(Buffer.byteLength(capOutput("x".repeat(MAX_PROCESS_OUTPUT_BYTES * 2)))).toBeLessThanOrEqual(MAX_PROCESS_OUTPUT_BYTES);
  expect(capOutput("short")).toBe("short");
});

test("UTF-8 split across output chunks retains text", () => {
  const bytes = Buffer.from("中😀文");
  const capture = createOutputCapture();
  for (const byte of bytes) capture.append(Buffer.from([byte]));
  expect(capture.text()).toBe("中😀文");
});
