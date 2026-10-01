/** Text offsets count UTF-16 code units, matching JavaScript string slicing. */
export interface EvidenceRange {
  readonly offset: number;
  readonly limit: number;
}
export interface EvidencePage extends EvidenceRange {
  readonly totalChars: number;
  readonly nextOffset: number | null;
}
export class EvidenceRangeError extends Error {
  readonly code = "EVIDENCE_RANGE_INVALID";
  constructor(message: string) { super(`EVIDENCE_RANGE_INVALID: ${message}`); }
}
export const MAX_EVIDENCE_PAGE_CHARS = 262_144;
export const DEFAULT_EVIDENCE_PAGE_CHARS = 65_536;

export function parseEvidenceRange(value: unknown): EvidenceRange {
  const row = value as Partial<EvidenceRange> | null;
  if (!row || typeof row !== "object" || Array.isArray(row)
    || !Number.isSafeInteger(row.offset) || row.offset! < 0
    || !Number.isSafeInteger(row.limit) || row.limit! < 1 || row.limit! > MAX_EVIDENCE_PAGE_CHARS) {
    throw new EvidenceRangeError("offset must be >=0 and limit must be 1–262144 UTF-16 characters");
  }
  return { offset: row.offset!, limit: row.limit! };
}

export function evidenceTextPage(text: string, range: EvidenceRange): { content: string; range: EvidencePage } {
  parseEvidenceRange(range);
  if (range.offset > text.length) throw new EvidenceRangeError("offset exceeds totalChars");
  const isHigh = (i: number) => text.charCodeAt(i) >= 0xd800 && text.charCodeAt(i) <= 0xdbff;
  const isLow = (i: number) => text.charCodeAt(i) >= 0xdc00 && text.charCodeAt(i) <= 0xdfff;
  if (range.offset > 0 && isLow(range.offset) && isHigh(range.offset - 1)) throw new EvidenceRangeError("offset splits a Unicode character");
  let end = Math.min(text.length, range.offset + range.limit);
  if (end < text.length && isHigh(end - 1) && isLow(end)) end--;
  if (end === range.offset && end < text.length) throw new EvidenceRangeError("limit must be >=2 for this Unicode character");
  return { content: text.slice(range.offset, end), range: { ...range, totalChars: text.length, nextOffset: end < text.length ? end : null } };
}
