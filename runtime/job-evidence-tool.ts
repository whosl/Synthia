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
const MAX_MODEL_CONTENT_CHARS = 256 * 1024;

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
      "给出 name 时返回该证据文件的文本内容（超过 256KB 时中段省略并以 truncated 标注）。",
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
              entries: manifest.entries.map((e) => ({
                name: e.name,
                uri: e.uri,
                mediaType: e.mediaType,
                sizeBytes: e.sizeBytes,
              })),
            }),
          };
        }
        const content = await connector.fetchEvidenceContent(jobId, name);
        if (content.mediaType === "application/octet-stream") {
          return {
            content: `读取失败：${name} 是二进制证据（${content.mediaType}），不进入模型上下文；请在报告/清单中引用其 uri 与 sha256。`,
            isError: true,
          };
        }
        if (content.content.length > MAX_MODEL_CONTENT_CHARS) {
          return {
            content: `读取失败（fail-closed）：${name} 为 ${content.content.length} 字符，超过模型单次读取上限 ${MAX_MODEL_CONTENT_CHARS}。`,
            isError: true,
          };
        }
        return {
          content: JSON.stringify({
            schema: "synthia-job-evidence-content.v1",
            project_id: ctx.projectId,
            job_id: jobId,
            name,
            mediaType: content.mediaType,
            sha256: content.sha256,
            truncated: content.truncated,
            content: content.content,
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
