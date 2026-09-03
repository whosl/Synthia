import type { AgentTool, AgentToolResult, ToolExecContext } from "./agent-types.ts";
import { normalizeWorkspacePath } from "./task-workspace-client.ts";
import { createDocxFromMarkdown, inspectDocx, replaceDocxText } from "./ooxml-docx.ts";
import { isRecord, matchesPath } from "./utils.ts";

const DEFAULT_PROJECT_READ_PATHS = ["doc/**"] as const;
const DEFAULT_PROJECT_WRITE_PATHS = ["doc/**"] as const;
const MAX_MARKDOWN_CHARS = 512 * 1024;
const MAX_REPLACEMENT_CHARS = 128 * 1024;
const MAX_INSPECTION_CHARS = 40_000;

function authorized(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => matchesPath(pattern, path));
}

function normalizeDocxPath(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("synthia_word_document 参数 path 必须是字符串");
  const path = normalizeWorkspacePath(raw);
  if (!path.toLowerCase().endsWith(".docx")) {
    throw new Error("synthia_word_document 只允许 .docx 工作区路径");
  }
  return path;
}

async function readDocxBytes(ctx: ToolExecContext, path: string): Promise<Uint8Array> {
  const file = ctx.taskKind === "side"
    ? await ctx.workspace!.readFile(path)
    : await ctx.governance.readWorkspaceFile(path);
  return file.encoding === "base64"
    ? Buffer.from(file.contentBase64 ?? "", "base64")
    : new TextEncoder().encode(file.content ?? "");
}

async function writeDocxBytes(
  ctx: ToolExecContext,
  path: string,
  bytes: Uint8Array,
  reason: string,
): Promise<AgentToolResult> {
  const contentBase64 = Buffer.from(bytes).toString("base64");
  if (ctx.taskKind === "side") {
    if (!ctx.workspace || !ctx.taskId || !ctx.workspaceId) {
      return { content: "Word 写入失败：侧边任务缺少 Core-issued 隔离工作区能力。", isError: true };
    }
    const write = await ctx.workspace.writeFiles({
      files: [{ path, contentBase64 }],
      changeReason: reason,
      artifactType: "DETAILED_DESIGN",
    });
    const entry = write.registered[0] ?? write.unchanged[0];
    if (!entry) return { content: "Word 写入后 Core 未返回文件身份。", isError: true };
    return {
      content: JSON.stringify({
        schema: "synthia-word-document-result.v1",
        operation: reason,
        path: entry.path,
        bytes: bytes.byteLength,
        content_hash: entry.contentHash,
        commit: write.commit,
        isolated: true,
        adopted: false,
      }),
    };
  }
  const write = await ctx.governance.writeWorkspaceFiles({
    files: [{ path, contentBase64 }],
    changeReason: reason,
    artifactType: "DETAILED_DESIGN",
  });
  const entry = write.registered[0] ?? write.unchanged[0];
  if (!entry) return { content: "Word 写入后 Core 未返回修订身份。", isError: true };
  return {
    content: JSON.stringify({
      schema: "synthia-word-document-result.v1",
      operation: reason,
      path: entry.path,
      bytes: bytes.byteLength,
      content_hash: entry.contentHash,
      commit: write.commit,
      revision_id: entry.revisionId,
      version: entry.version,
      candidate: true,
      isolated: false,
    }),
  };
}

export function assembleWordDocumentTool(): AgentTool {
  return {
    name: "synthia_word_document",
    description: [
      "在 Core 治理的工作区中创建、检查或编辑真实 OOXML .docx 文件。",
      "create_from_markdown 生成可由 Microsoft Word 打开的 DOCX；inspect_text 提取段落；replace_text 能跨 Word run 替换同一段落中的文本。",
      "所有写入都经过工作区权限、原始字节 SHA-256、脏文件保护和 Git/修订登记；Side Agent 仅写自己的隔离副本。",
      "不得用本工具生成批准签名或伪造评审、测试、发布结论。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["create_from_markdown", "inspect_text", "replace_text"],
        },
        path: { type: "string", description: "获授权的工作区 .docx 相对路径，例如 doc/specification.docx。" },
        markdown: { type: "string", description: "create_from_markdown 的 Markdown 正文。" },
        title: { type: "string", description: "可选文档标题/OOXML 元数据标题。" },
        find: { type: "string", description: "replace_text 要查找的精确文字。" },
        replace: { type: "string", description: "replace_text 的替换文字。" },
        replace_all: { type: "boolean", description: "是否替换全部匹配；默认 false。" },
        max_chars: { type: "integer", minimum: 1, maximum: MAX_INSPECTION_CHARS },
      },
      required: ["operation", "path"],
      additionalProperties: false,
    },
    async execute(args: unknown, ctx: ToolExecContext): Promise<AgentToolResult> {
      if (!isRecord(args) || typeof args.operation !== "string") {
        return { content: "synthia_word_document 参数必须是含 operation/path 的对象。", isError: true };
      }
      let path: string;
      try {
        path = normalizeDocxPath(args.path);
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
      const readPaths = ctx.authorization?.read_paths ?? DEFAULT_PROJECT_READ_PATHS;
      const writePaths = ctx.authorization?.write_paths ?? DEFAULT_PROJECT_WRITE_PATHS;
      const needsRead = args.operation !== "create_from_markdown";
      const needsWrite = args.operation !== "inspect_text";
      if (needsRead && !authorized(readPaths, path)) {
        return { content: `Word 读取被拒绝：${path} 不在 Core-issued read_paths 中。`, isError: true };
      }
      if (needsWrite && !authorized(writePaths, path)) {
        return { content: `Word 写入被拒绝：${path} 不在 Core-issued write_paths 中。`, isError: true };
      }
      if (ctx.taskKind === "side" && !ctx.workspace) {
        return { content: "Word 操作失败：侧边任务缺少 Core-issued 隔离工作区能力。", isError: true };
      }

      try {
        if (args.operation === "create_from_markdown") {
          if (typeof args.markdown !== "string" || args.markdown.length > MAX_MARKDOWN_CHARS) {
            return { content: `markdown 必须是至多 ${MAX_MARKDOWN_CHARS} 字符的字符串。`, isError: true };
          }
          const title = typeof args.title === "string" ? args.title : undefined;
          return await writeDocxBytes(
            ctx,
            path,
            createDocxFromMarkdown(args.markdown, title),
            "word document create_from_markdown",
          );
        }
        const bytes = await readDocxBytes(ctx, path);
        if (args.operation === "inspect_text") {
          const inspection = inspectDocx(bytes);
          const maxChars = typeof args.max_chars === "number"
            && Number.isSafeInteger(args.max_chars)
            && args.max_chars > 0
            ? Math.min(args.max_chars, MAX_INSPECTION_CHARS)
            : 20_000;
          const text = inspection.text.slice(0, maxChars);
          return {
            content: JSON.stringify({
              schema: "synthia-word-document-inspection.v1",
              path,
              paragraphs: inspection.paragraphs.length,
              characters: inspection.characters,
              truncated: text.length < inspection.text.length,
              text,
            }),
          };
        }
        if (args.operation === "replace_text") {
          if (
            typeof args.find !== "string"
            || typeof args.replace !== "string"
            || args.replace.length > MAX_REPLACEMENT_CHARS
          ) {
            return { content: "replace_text 要求 find/replace 为合法字符串。", isError: true };
          }
          const edited = replaceDocxText(bytes, args.find, args.replace, args.replace_all === true);
          const result = await writeDocxBytes(ctx, path, edited.bytes, "word document replace_text");
          if (result.isError) return result;
          const payload = JSON.parse(result.content) as Record<string, unknown>;
          return { content: JSON.stringify({ ...payload, replacements: edited.replacements }) };
        }
        return { content: `不支持的 Word 操作：${args.operation}`, isError: true };
      } catch (error) {
        return {
          content: `Word 操作失败（fail-closed）：${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}
