import { describe, expect, test } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { createDocxFromMarkdown, inspectDocx, replaceDocxText } from "./ooxml-docx.ts";

describe("OOXML DOCX operations", () => {
  test("creates a real Word package with headings, numbered lists and bullets", () => {
    const bytes = createDocxFromMarkdown("# UART 规格\n\n正文\n\n1. 第一项\n- 检查项", "UART 规格");
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    const files = unzipSync(bytes);
    expect(files["[Content_Types].xml"]).toBeDefined();
    expect(files["word/document.xml"]).toBeDefined();
    expect(files["word/styles.xml"]).toBeDefined();
    expect(files["word/numbering.xml"]).toBeDefined();

    const inspection = inspectDocx(bytes);
    expect(inspection.text).toContain("UART 规格");
    expect(inspection.text).toContain("第一项");
    expect(inspection.text).toContain("检查项");
  });

  test("replace_text handles a match split across Word runs", () => {
    const base = createDocxFromMarkdown("AlphaBeta");
    const files = unzipSync(base);
    const documentXml = strFromU8(files["word/document.xml"]!);
    files["word/document.xml"] = strToU8(documentXml.replace(
      '<w:r><w:t xml:space="preserve">AlphaBeta</w:t></w:r>',
      '<w:r><w:t xml:space="preserve">Alpha</w:t></w:r><w:r><w:t xml:space="preserve">Beta</w:t></w:r>',
    ));
    const split = zipSync(files);

    const edited = replaceDocxText(split, "AlphaBeta", "UART", false);
    expect(edited.replacements).toBe(1);
    expect(inspectDocx(edited.bytes).text).toBe("UART");
  });

  test("fails closed when replacement text is absent or package is malformed", () => {
    const bytes = createDocxFromMarkdown("known text");
    expect(() => replaceDocxText(bytes, "missing", "x", false)).toThrow(/not found/);
    expect(() => inspectDocx(Uint8Array.from([1, 2, 3]))).toThrow(/ZIP\/OOXML/);
    const files = unzipSync(bytes);
    files["word/document.xml"] = strToU8("<w:document><w:body><w:p></w:body></w:document>");
    expect(() => inspectDocx(zipSync(files))).toThrow(/malformed/);
  });
});
