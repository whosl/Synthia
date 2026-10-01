import { expect, test } from "bun:test";
import { evidenceTextPage } from "../src/domain/evidence-range.ts";

test("H37 pagination retains Unicode and never splits a surrogate pair", () => {
  const text = "a😀中文b";
  const first = evidenceTextPage(text, { offset: 0, limit: 2 });
  expect(first.content).toBe("a");
  expect(first.range.nextOffset).toBe(1);
  const second = evidenceTextPage(text, { offset: 1, limit: 2 });
  expect(second.content).toBe("😀");
  expect(second.range.nextOffset).toBe(3);
  expect(() => evidenceTextPage(text, { offset: 2, limit: 2 })).toThrow("splits a Unicode character");
  expect(() => evidenceTextPage(text, { offset: 1, limit: 1 })).toThrow("limit must be >=2");
  expect(evidenceTextPage(text, { offset: text.length, limit: 1 }).range.nextOffset).toBeNull();
});
