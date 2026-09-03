/**
 * Read-only workspace capability for Project Agents and Side Agents.
 *
 * Project Agents read the Core-owned project workspace through GovernanceClient;
 * Side Agents read only their Core-issued isolated workspace. The tool never
 * touches the local filesystem and enforces the frozen task read scope before
 * making either request.
 */

import type { AgentTool, ToolExecContext } from "./agent-types.ts";
import { normalizeWorkspacePath } from "./task-workspace-client.ts";
import { isRecord, matchesPath } from "./utils.ts";

const DEFAULT_PROJECT_READ_PATHS = [
  "rtl/**",
  "tb/**",
  "doc/**",
  "prj/constr/**",
] as const;

const MAX_MODEL_FILE_BYTES = 256 * 1024;

function readPatterns(ctx: ToolExecContext): readonly string[] {
  return ctx.authorization?.read_paths ?? DEFAULT_PROJECT_READ_PATHS;
}

export function assembleWorkspaceReadTool(): AgentTool {
  return {
    name: "synthia_workspace_read",
    description: [
      "读取当前 Synthia 任务获授权工作区中的一个文件，并返回正文与可追溯元数据。",
      "Project Agent 读取 Core 项目工作区；Side Agent 只读取自己的隔离工作区。",
      "只能读取 Core-issued read_paths 内的安全相对路径，不能读取本机任意路径、项目外目录或 golden 答案。",
      "在编制需求、设计、RTL、TB 或 XDC 前，应先用本工具读取已登记的输入正文，不得仅凭路径或项目名推断。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "工作区相对路径，例如 doc/01-可编程逻辑器件软件研制任务书.md 或 rtl/uart_top.v。",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args: unknown, ctx: ToolExecContext) {
      if (!isRecord(args) || typeof args.path !== "string") {
        return { content: "workspace_read 参数 path 必须是字符串。", isError: true };
      }

      let path: string;
      try {
        path = normalizeWorkspacePath(args.path);
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
      if (!readPatterns(ctx).some((pattern) => matchesPath(pattern, path))) {
        return {
          content: `读取被拒绝：${path} 不在 Core-issued read_paths 中。`,
          isError: true,
        };
      }

      try {
        const sideTask = ctx.taskKind === "side";
        if (sideTask && !ctx.workspace) {
          return {
            content: "读取失败（fail-closed）：侧边任务缺少 Core-issued 隔离工作区能力。",
            isError: true,
          };
        }
        const file = sideTask
          ? await ctx.workspace!.readFile(path)
          : await ctx.governance.readWorkspaceFile(path);
        if (file.encoding !== "utf8" || file.content === null) {
          return {
            content: `读取失败：${path} 是 ${file.encoding} 二进制文件。请使用 synthia_word_document 检查或编辑 DOCX。`,
            isError: true,
          };
        }
        const bytes = file.bytes;
        if (bytes > MAX_MODEL_FILE_BYTES) {
          return {
            content: `读取失败（fail-closed）：${path} 为 ${bytes} 字节，超过模型单文件读取上限 ${MAX_MODEL_FILE_BYTES}。`,
            isError: true,
          };
        }
        return {
          content: JSON.stringify({
            schema: "synthia-workspace-file.v1",
            project_id: ctx.projectId,
            ...(ctx.taskId ? { task_id: ctx.taskId } : {}),
            ...(ctx.workspaceId ? { workspace_id: ctx.workspaceId } : {}),
            path: file.path,
            content: file.content,
            content_hash: file.contentHash,
            bytes,
            ...(sideTask
              ? { isolated: true, commit: file.commit }
              : {
                  isolated: false,
                  registered: "registered" in file ? file.registered : undefined,
                  revision_id: "revisionId" in file ? file.revisionId : undefined,
                  version: "version" in file ? file.version : undefined,
                  commit: file.commit,
                }),
          }),
        };
      } catch (error) {
        return {
          content: `workspace_read 失败：${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}
