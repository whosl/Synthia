import { describe, expect, test } from "bun:test";
import {
  checkGjb9764Docs,
  checkGjb9764DocumentText,
  checkGjbStandardReferences,
} from "../scripts/check-gjb9764-docs.ts";

describe("GJB 9764 Golden 文档检查", () => {
  test("真实 UART 文档集满足确定性结构契约", async () => {
    expect(await checkGjb9764Docs()).toEqual([]);
  });

  test("GJB 9764 与 GJB 438B 权威扫描件及检索转写完整", async () => {
    expect(await checkGjbStandardReferences()).toEqual([]);
  });

  test("缺少通用结构、正文或状态时返回可定位问题", () => {
    const issues = checkGjb9764DocumentText(
      {
        file: "sample.md",
        documentId: "DOC-001",
        titleMarker: "（PLDSRS）",
        sections: ["1 范围", "2 引用文档"],
      },
      "# 不完整文档\n\n## 2 引用文档\n",
    );

    expect(issues.some((issue) => issue.message.includes("封面"))).toBe(true);
    expect(issues.some((issue) => issue.message.includes("1 范围"))).toBe(true);
    expect(issues.some((issue) => issue.message.includes("候选或未批准"))).toBe(true);
  });
});
