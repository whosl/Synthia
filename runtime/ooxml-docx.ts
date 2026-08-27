import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

const MAX_ZIP_ENTRIES = 256;
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_XML_BYTES = 2 * 1024 * 1024;
const DOCX_MTIME = new Date("1980-01-01T00:00:00.000Z");

export class DocxError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "DocxError";
  }
}

export interface DocxInspection {
  readonly paragraphs: readonly string[];
  readonly text: string;
  readonly characters: number;
}

export interface DocxReplacement {
  readonly bytes: Uint8Array;
  readonly replacements: number;
}

export function inspectDocx(bytes: Uint8Array): DocxInspection {
  const files = openDocx(bytes);
  const xml = requiredXml(files, "word/document.xml");
  const paragraphs = paragraphRanges(xml).map(({ start, end }) => paragraphText(xml.slice(start, end)));
  return {
    paragraphs,
    text: paragraphs.join("\n"),
    characters: paragraphs.reduce((total, paragraph) => total + paragraph.length, 0),
  };
}

export function replaceDocxText(
  bytes: Uint8Array,
  find: string,
  replacement: string,
  replaceAll: boolean,
): DocxReplacement {
  if (find.length === 0) throw new DocxError("find must not be empty", "DOCX_FIND_EMPTY");
  const files = openDocx(bytes);
  const original = requiredXml(files, "word/document.xml");
  let xml = original;
  let replacements = 0;
  const allRanges = paragraphRanges(original);
  const ranges = replaceAll
    ? allRanges.reverse()
    : allRanges.filter((range) => paragraphText(original.slice(range.start, range.end)).includes(find)).slice(0, 1);
  for (const range of ranges) {
    if (!replaceAll && replacements > 0) break;
    const paragraph = original.slice(range.start, range.end);
    const edited = replaceInsideParagraph(paragraph, find, replacement, replaceAll, replacements > 0);
    if (edited.replacements === 0) continue;
    replacements += edited.replacements;
    xml = xml.slice(0, range.start) + edited.xml + xml.slice(range.end);
  }
  if (replacements === 0) {
    throw new DocxError(`DOCX text not found: ${find}`, "DOCX_TEXT_NOT_FOUND");
  }
  files["word/document.xml"] = strToU8(xml);
  return { bytes: writeDocx(files), replacements };
}

export function createDocxFromMarkdown(markdown: string, title?: string): Uint8Array {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const body: string[] = [];
  let inferredTitle = title?.trim() ?? "";
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      if (!inferredTitle && level === 1) inferredTitle = text;
      body.push(paragraphXml(text, `Heading${level}`));
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (numbered) {
      body.push(listParagraphXml(numbered[1]!, 1));
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      body.push(listParagraphXml(bullet[1]!, 0));
      continue;
    }
    body.push(paragraphXml(line));
  }
  if (!inferredTitle) inferredTitle = "Synthia 文档";
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body.join("")}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
  </w:body>
</w:document>`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(CONTENT_TYPES_XML),
    "_rels/.rels": strToU8(ROOT_RELS_XML),
    "docProps/core.xml": strToU8(corePropertiesXml(inferredTitle)),
    "docProps/app.xml": strToU8(APP_PROPERTIES_XML),
    "word/document.xml": strToU8(documentXml),
    "word/styles.xml": strToU8(STYLES_XML),
    "word/numbering.xml": strToU8(NUMBERING_XML),
    "word/settings.xml": strToU8(SETTINGS_XML),
    "word/_rels/document.xml.rels": strToU8(DOCUMENT_RELS_XML),
  };
  return writeDocx(files);
}

function openDocx(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new DocxError("DOCX is not a ZIP/OOXML package", "DOCX_ZIP_INVALID");
  }
  inspectZipDirectory(bytes);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new DocxError("DOCX ZIP package is malformed", "DOCX_ZIP_INVALID");
  }
  if (!files["[Content_Types].xml"] || !files["word/document.xml"]) {
    throw new DocxError("OOXML package is missing the Word document part", "DOCX_PART_MISSING");
  }
  return files;
}

function requiredXml(files: Record<string, Uint8Array>, path: string): string {
  const bytes = files[path];
  if (!bytes) throw new DocxError(`OOXML part is missing: ${path}`, "DOCX_PART_MISSING");
  if (bytes.byteLength > MAX_DOCUMENT_XML_BYTES) {
    throw new DocxError(`OOXML part is too large: ${path}`, "DOCX_PART_TOO_LARGE");
  }
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocxError(`OOXML part is not UTF-8: ${path}`, "DOCX_XML_INVALID");
  }
  if (path === "word/document.xml") validateDocumentXml(xml);
  return xml;
}

function validateDocumentXml(xml: string): void {
  if (
    !/<w:document(?=[\s>])/.test(xml)
    || !/<w:body(?=[\s>])/.test(xml)
    || !/<\/w:body>/.test(xml)
    || !/<\/w:document>/.test(xml)
    || countMatches(xml, /<w:p(?=[\s>])/g) !== countMatches(xml, /<\/w:p>/g)
    || countMatches(xml, /<w:t(?=[\s>])/g) !== countMatches(xml, /<\/w:t>/g)
  ) {
    throw new DocxError("word/document.xml is malformed", "DOCX_XML_INVALID");
  }
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function inspectZipDirectory(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowerBound = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new DocxError("DOCX ZIP directory is missing", "DOCX_ZIP_INVALID");
  const entries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entries > MAX_ZIP_ENTRIES || centralOffset + centralSize > bytes.byteLength) {
    throw new DocxError("DOCX ZIP directory exceeds safety limits", "DOCX_ZIP_LIMIT");
  }
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new DocxError("DOCX ZIP central directory is malformed", "DOCX_ZIP_INVALID");
    }
    const flags = view.getUint16(offset + 8, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if ((flags & 1) !== 0 || uncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new DocxError("Encrypted or oversized DOCX entries are not supported", "DOCX_ZIP_LIMIT");
    }
    total += uncompressed;
    if (total > MAX_UNCOMPRESSED_BYTES) {
      throw new DocxError("DOCX expanded size exceeds safety limit", "DOCX_ZIP_LIMIT");
    }
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) throw new DocxError("DOCX ZIP path is malformed", "DOCX_ZIP_INVALID");
    const name = strFromU8(bytes.subarray(nameStart, nameEnd));
    if (name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => part === "..")) {
      throw new DocxError("DOCX contains an unsafe ZIP path", "DOCX_ZIP_PATH_INVALID");
    }
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset !== centralOffset + centralSize) {
    throw new DocxError("DOCX ZIP directory length is inconsistent", "DOCX_ZIP_INVALID");
  }
}

function writeDocx(files: Record<string, Uint8Array>): Uint8Array {
  const zippable: Zippable = {};
  for (const path of Object.keys(files).sort()) {
    zippable[path] = [files[path]!, { mtime: DOCX_MTIME }];
  }
  return zipSync(zippable, { level: 6, mtime: DOCX_MTIME });
}

function paragraphRanges(xml: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const pattern = /<w:p(?=[\s>])[^>]*>[\s\S]*?<\/w:p>/g;
  for (const match of xml.matchAll(pattern)) {
    ranges.push({ start: match.index!, end: match.index! + match[0].length });
  }
  return ranges;
}

function textNodes(xml: string): Array<{ start: number; end: number; textStart: number; textEnd: number; text: string }> {
  const nodes: Array<{ start: number; end: number; textStart: number; textEnd: number; text: string }> = [];
  const pattern = /<w:t(?=[\s>])[^>]*>([\s\S]*?)<\/w:t>/g;
  for (const match of xml.matchAll(pattern)) {
    const raw = match[1]!;
    const rawOffset = match[0].indexOf(raw);
    nodes.push({
      start: match.index!,
      end: match.index! + match[0].length,
      textStart: match.index! + rawOffset,
      textEnd: match.index! + rawOffset + raw.length,
      text: unescapeXml(raw),
    });
  }
  return nodes;
}

function paragraphText(xml: string): string {
  return textNodes(xml).map((node) => node.text).join("");
}

function replaceInsideParagraph(
  paragraphXml: string,
  find: string,
  replacement: string,
  replaceAll: boolean,
  alreadyReplaced: boolean,
): { xml: string; replacements: number } {
  if (alreadyReplaced && !replaceAll) return { xml: paragraphXml, replacements: 0 };
  const nodes = textNodes(paragraphXml);
  const combined = nodes.map((node) => node.text).join("");
  const starts: number[] = [];
  let cursor = 0;
  while (cursor <= combined.length - find.length) {
    const index = combined.indexOf(find, cursor);
    if (index < 0) break;
    starts.push(index);
    if (!replaceAll) break;
    cursor = index + Math.max(find.length, 1);
  }
  if (starts.length === 0) return { xml: paragraphXml, replacements: 0 };

  const values = nodes.map((node) => node.text);
  const offsets: number[] = [];
  let total = 0;
  for (const value of values) {
    offsets.push(total);
    total += value.length;
  }
  for (const start of starts.reverse()) {
    const end = start + find.length;
    const first = nodeAtOffset(offsets, values, start);
    const last = nodeAtOffset(offsets, values, end - 1);
    if (first < 0 || last < 0) continue;
    const firstLocal = start - offsets[first]!;
    const lastLocalEnd = end - offsets[last]!;
    if (first === last) {
      values[first] = values[first]!.slice(0, firstLocal) + replacement + values[first]!.slice(lastLocalEnd);
    } else {
      const suffix = values[last]!.slice(lastLocalEnd);
      values[first] = values[first]!.slice(0, firstLocal) + replacement;
      for (let index = first + 1; index < last; index += 1) values[index] = "";
      values[last] = suffix;
    }
  }
  let xml = paragraphXml;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!;
    xml = xml.slice(0, node.textStart) + escapeXml(values[index]!) + xml.slice(node.textEnd);
  }
  return { xml, replacements: starts.length };
}

function nodeAtOffset(offsets: readonly number[], values: readonly string[], offset: number): number {
  for (let index = 0; index < values.length; index += 1) {
    if (offset >= offsets[index]! && offset < offsets[index]! + values[index]!.length) return index;
  }
  return -1;
}

function paragraphXml(text: string, style?: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  if (text === "") return `<w:p>${pPr}</w:p>`;
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function listParagraphXml(text: string, numberingId: number): string {
  return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numberingId}"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(value: string): string {
  return value.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|amp|lt|gt|quot|apos);/g, (entity, hex, decimal) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    return ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" } as Record<string, string>)[entity] ?? entity;
  });
}

function corePropertiesXml(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>Synthia</dc:creator><cp:lastModifiedBy>Synthia</cp:lastModifiedBy></cp:coreProperties>`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
const DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>`;
const APP_PROPERTIES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Synthia</Application><AppVersion>1.0</AppVersion></Properties>`;
const SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:defaultTabStop w:val="420"/></w:settings>`;
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="FangSong_GB2312"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style></w:styles>`;
const NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="0"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
