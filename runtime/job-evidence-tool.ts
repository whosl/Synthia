import { DEFAULT_EVIDENCE_PAGE_CHARS, MAX_EVIDENCE_PAGE_CHARS, evidenceTextPage, parseEvidenceRange } from "../core/src/domain/evidence-range.ts";
/**
 * Read-only job-evidence capability for Project Agents and Side Agents.
 *
 * Tool-run results surface evidence as `workspace://<jobId>/output/<name>`
 * URIs, but the workspace read tool is gated to source directories and job
 * evidence lives behind the connector — until now the model had no legal way
 * to fetch what its own jobs produced (ledger H30). This tool closes that
 * gap: manifest listing plus named-content fetch, both routed through the
 * project-bound connector so cross-project jobs stay unreachable.
 */

import type { AgentTool, ToolExecContext } from "./agent-types.ts";
import { isRecord } from "./utils.ts";

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EVIDENCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const MAX_MODEL_CONTENT_CHARS = MAX_EVIDENCE_PAGE_CHARS;

function parseJobId(value: unknown): string | null {
  return typeof value === "string" && JOB_ID_RE.test(value) ? value : null;
}

function parseEvidenceName(value: unknown): string | null {
  return typeof value === "string" && EVIDENCE_NAME_RE.test(value) ? value : null;
}

export function assembleJobEvidenceTool(): AgentTool {
  return {
    name: "synthia_job_evidence",
    description: [
      "读取本任务已提交 Vivado 作业的证据（evidence）。",
      "省略 name 时返回该作业的证据清单（manifest：每项含 name/uri/mediaType/sizeBytes）；",
      "给出 name 时分块读取文本，offset/limit 按 UTF-16 字符计数，默认 65536 字符，最多 262144。返回总大小、totalChars 与 nextOffset；有 nextOffset 时继续读，sha256 始终指整份文件。",
      "job_id 取自作业结果的 jobId；name 取自证据清单条目（uri 形如 workspace://<jobId>/output/<name>）。",
      "只能读取本任务所属项目提交的作业；worker 侧按项目绑定拒绝越权读取。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "作业 ID（作业结果中的 jobId，形如 job-…）。",
        },
        offset: { type: "integer", minimum: 0, description: "文本起始字符偏移，默认 0。" },
        limit: { type: "integer", minimum: 1, maximum: MAX_EVIDENCE_PAGE_CHARS, description: "每次读取字符数，默认 65536。" },
        name: {
          type: "string",
          description: "证据文件名（证据清单条目的 name 字段）。省略则返回整份证据清单。",
        },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
    async execute(args: unknown, ctx: ToolExecContext) {
      if (!isRecord(args)) {
        return { content: "job_evidence 参数必须是对象。", isError: true };
      }
      const jobId = parseJobId(args.job_id);
      if (!jobId) {
        return { content: "job_evidence 参数 job_id 无效（应为作业结果中的 jobId）。", isError: true };
      }
      const name = args.name === undefined ? null : parseEvidenceName(args.name);
      if (args.name !== undefined && !name) {
        return { content: "job_evidence 参数 name 无效（应为证据清单条目的 name 字段）。", isError: true };
      }
      let range;
      try {
        range = parseEvidenceRange({ offset: args.offset ?? 0, limit: args.limit ?? DEFAULT_EVIDENCE_PAGE_CHARS });
        if (name === null && (args.offset !== undefined || args.limit !== undefined)) throw new Error("offset/limit 需要 name");
      } catch (error) { return { content: (error as Error).message, isError: true }; }
      const connector = ctx.connector;
      if (!connector) {
        return { content: "读取失败（fail-closed）：当前无可用 Vivado connector。", isError: true };
      }

      try {
        if (name === null) {
          if (!connector.fetchEvidenceManifest) {
            return {
              content: "读取失败（fail-closed）：当前 connector 不支持证据清单读取。",
              isError: true,
            };
          }
          const manifest = await connector.fetchEvidenceManifest(jobId);
          return {
            content: JSON.stringify({
              schema: "synthia-job-evidence-manifest.v1",
              project_id: ctx.projectId,
              job_id: manifest.jobId,
              total_size_bytes: manifest.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
              max_limit_chars: MAX_EVIDENCE_PAGE_CHARS,
              default_limit_chars: DEFAULT_EVIDENCE_PAGE_CHARS,
              entries: manifest.entries.map((e) => ({
                name: e.name,
                sha256: e.sha256,
                uri: e.uri,
                mediaType: e.mediaType,
                sizeBytes: e.sizeBytes,
              })),
            }),
          };
        }
        const content = await connector.fetchEvidenceContent(jobId, name, range);
        if (content.mediaType === "application/octet-stream") {
          return {
            content: `读取失败：${name} 是二进制证据（${content.mediaType}），不进入模型上下文；请在报告/清单中引用其 uri 与 sha256。`,
            isError: true,
          };
        }
        if (!content.range && content.truncated) {
          return { content: "当前 connector 返回了省略预览，不能可靠分页；请更新 Worker 的 range 支持后按 offset/limit 分块读取。", isError: true };
        }
        const page = content.range ? { content: content.content, range: content.range } : evidenceTextPage(content.content, range);
        if (page.content.length > MAX_MODEL_CONTENT_CHARS) return { content: "证据分页响应超过 limit；请缩小 limit 并检查 connector 的 range 支持。", isError: true };
        return {
          content: JSON.stringify({
            schema: "synthia-job-evidence-content.v1",
            project_id: ctx.projectId,
            job_id: jobId,
            name,
            mediaType: content.mediaType,
            sha256: content.sha256,
            sizeBytes: content.sizeBytes ?? (content.range ? undefined : Buffer.byteLength(content.content, "utf8")),
            range: page.range,
            truncated: page.range.nextOffset !== null || page.range.offset > 0,
            next_read: page.range.nextOffset === null ? null : { job_id: jobId, name, offset: page.range.nextOffset, limit: range.limit },
            content: page.content,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: `job_evidence 失败：${message}（作业不存在、尚未终态或证据已不可得时均可能；若为重启后失联的历史作业，请如实记录并在报告中引用作业结果中已有的摘要信息）`,
          isError: true,
        };
      }
    },
  };
}
