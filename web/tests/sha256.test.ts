import { describe, expect, test } from "bun:test";
import { sha256Bytes, sha256Hex } from "../src/util/sha256.ts";

const VECTORS: [string, string][] = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
];

describe("sha256Bytes（纯 JS 实现）", () => {
  for (const [input, expected] of VECTORS) {
    test(`SHA-256(${JSON.stringify(input.slice(0, 12))}…)`, () => {
      expect(sha256Bytes(new TextEncoder().encode(input))).toBe(expected);
    });
  }

  test("长输入（跨多块）", () => {
    const input = "a".repeat(1_000_000);
    expect(sha256Bytes(new TextEncoder().encode(input))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });
});

describe("sha256Hex（WebCrypto 路径）", () => {
  for (const [input, expected] of VECTORS) {
    test(`与标准向量一致：${JSON.stringify(input.slice(0, 12))}`, async () => {
      expect(await sha256Hex(input)).toBe(expected);
    });
  }
});
