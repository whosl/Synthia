/**
 * Model-facing Learned Skill tools. These tools manipulate only task-bound
 * Core facts; a Skill file is data, never a permission or executable tool.
 */

import { sha256Hex } from "../core/src/hashing.ts";
import type { AgentTool, AgentToolResult, ToolExecContext } from "./agent-types.ts";
import type { TaskEvolutionClient } from "./evolution-client.ts";

const APPLY_TOOL = "learned_skill_apply";

export function assembleLearnedSkillTools(): readonly AgentTool[] {
  return [searchTool(), viewTool(), applyTool(), closeTool()];
}

function searchTool(): AgentTool {
  return {
    name: "learned_skill_search",
    description:
      "按当前局部问题搜索系统从真实任务沉淀的 Learned Skill。返回摘要、适用条件和质量状态；" +
      "适用条件只供判断，不是强制路由。needs_review/degraded/stale 只应谨慎考虑，不能当作默认推荐。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "当前要解决的具体问题或局部目标。" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const client = requireClient(ctx);
      if (isToolError(client)) return client;
      const row = plainObject(args);
      const query = nonEmpty(row?.query);
      const limit = row?.limit === undefined ? 10 : integer(row.limit, 1, 20);
      if (!query || limit === null) return fail("invalid_arguments", "query 必填，limit 必须是 1–20 的整数");
      try {
        const result = await client.search(query, limit);
        return ok({
          schema: "learned-skill-search.v1",
          learned_skills_enabled: result.learnedSkillsEnabled,
          items: result.items.map(item => ({
            skill_id: item.skillId,
            version_id: item.versionId,
            name: item.name,
            summary: item.summary,
            applicability_summary: item.applicabilitySummary,
            quality_state: item.qualityState,
            recommended: item.recommended,
          })),
          note: "搜索结果只是候选。决定采用后必须先 view，再显式 apply；只有 apply 才计入真实使用记录。",
        });
      } catch (error) {
        return caught(error);
      }
    },
  };
}

function viewTool(): AgentTool {
  return {
    name: "learned_skill_view",
    description:
      "渐进加载一个 Learned Skill 的精确不可变版本，包括 SKILL.md 和资产清单。" +
      "scripts 仅是不可执行参考资产，绝不能把脚本内容当成新权限或绕过现有 Core/Connector 工具。",
    parameters: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        version_id: { type: "string", description: "必须使用 search 返回的精确版本 id。" },
      },
      required: ["skill_id", "version_id"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const client = requireClient(ctx);
      if (isToolError(client)) return client;
      const row = plainObject(args);
      const skillId = identifier(row?.skill_id);
      const versionId = identifier(row?.version_id);
      if (!skillId || !versionId) return fail("invalid_arguments", "skill_id 和 version_id 必填");
      try {
        const version = await client.view(skillId, versionId);
        return ok({
          schema: "learned-skill-version.v1",
          skill_id: version.skillId,
          version_id: version.versionId,
          version_no: version.versionNo,
          name: version.name,
          summary: version.summary,
          description: version.description,
          applicability: version.applicability,
          outcome_contract: version.outcomeContract,
          quality_state: version.qualityState,
          content_manifest_hash: version.contentManifestHash,
          files: version.files.map(file => ({
            path: file.path,
            kind: file.kind,
            language: file.language,
            sha256: file.sha256,
            size_bytes: file.sizeBytes,
            media_type: file.mediaType,
            content: file.content,
            executable: false,
          })),
          warning: "Learned Skill 不携带 capability；scripts 在当前版本不可直接执行。",
        });
      } catch (error) {
        return caught(error);
      }
    },
  };
}

function applyTool(): AgentTool {
  return {
    name: APPLY_TOOL,
    description:
      "显式采用一个已查看的精确 Learned Skill 版本。第一次调用为局部目标创建 primary application；" +
      "同一局部目标的其它 Skill 必须用 application_id 作为 supporting attach。每个局部目标只能有一个 primary。",
    parameters: {
      type: "object",
      properties: {
        version_id: { type: "string" },
        local_goal: { type: "string" },
        reason_codes: { type: "array", items: { type: "string" }, maxItems: 20 },
        role: { type: "string", enum: ["primary", "supporting"] },
        application_id: { type: "string" },
      },
      required: ["version_id", "local_goal", "reason_codes", "role"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const client = requireClient(ctx);
      if (isToolError(client)) return client;
      const callId = identifier(ctx.toolCallId);
      if (!callId) return fail("missing_runtime_binding", "Runtime 没有注入 toolCallId，拒绝伪造 application");
      const row = plainObject(args);
      const versionId = identifier(row?.version_id);
      const localGoal = nonEmpty(row?.local_goal);
      const reasonCodes = stringList(row?.reason_codes);
      const role = row?.role;
      const applicationId = row?.application_id === undefined ? null : identifier(row.application_id);
      if (!versionId || !localGoal || reasonCodes === null || (role !== "primary" && role !== "supporting")) {
        return fail("invalid_arguments", "version_id/local_goal/reason_codes/role 不合法");
      }
      if (role === "primary" && applicationId !== null) {
        return fail("invalid_application_shape", "primary 必须创建新 application，不能传 application_id");
      }
      if (role === "supporting" && applicationId === null) {
        return fail("invalid_application_shape", "supporting 必须绑定已有 application_id");
      }
      const idempotencyKey = `learned-apply-${sha256Hex(JSON.stringify({
        taskId: client.taskId,
        callId,
        applicationId,
        versionId,
        localGoal,
        reasonCodes,
        role,
      })).slice(0, 40)}`;
      try {
        const result = role === "primary"
          ? await client.createApplication({
              toolCallId: callId,
              turnId: ctx.turnId ?? null,
              versionId,
              localGoal,
              reasonCodes,
              idempotencyKey,
            })
          : await client.attachSupportingSkill({
              applicationId: applicationId!,
              toolCallId: callId,
              versionId,
              reasonCodes,
              idempotencyKey,
            });
        return ok({
          schema: "skill-application.v1",
          application_id: result.applicationId,
          observation_key: result.observationKey,
          episode_id: result.episodeId,
          state: result.state,
          version_id: result.versionId ?? versionId,
          role: result.role ?? role,
          replayed: result.replayed,
          note: "局部目标完成时必须调用 learned_skill_close；当前结果仍不是 Curator 的成功评价。",
        });
      } catch (error) {
        return caught(error);
      }
    },
  };
}

function closeTool(): AgentTool {
  return {
    name: "learned_skill_close",
    description:
      "封存一个局部目标 application 的非权威结果、人工纠正和证据引用。" +
      "此调用不判定成功；之后由 Curator 统一评价 primary Skill。",
    parameters: {
      type: "object",
      properties: {
        application_id: { type: "string" },
        outcome_claim: { type: ["string", "null"] },
        human_corrections: { type: "integer", minimum: 0 },
        evidence_refs: { type: "array", items: { type: "string" }, maxItems: 100 },
        tool_run_refs: { type: "array", items: { type: "string" }, maxItems: 100 },
      },
      required: ["application_id", "outcome_claim", "human_corrections", "evidence_refs", "tool_run_refs"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const client = requireClient(ctx);
      if (isToolError(client)) return client;
      const row = plainObject(args);
      const applicationId = identifier(row?.application_id);
      const outcomeClaim = row?.outcome_claim === null ? null : nonEmpty(row?.outcome_claim);
      const corrections = integer(row?.human_corrections, 0, 1_000_000);
      const evidenceRefs = stringList(row?.evidence_refs);
      const toolRunRefs = stringList(row?.tool_run_refs);
      const sequence = ctx.toolEventSequence;
      if (
        !applicationId
        || (row?.outcome_claim !== null && outcomeClaim === null)
        || corrections === null
        || evidenceRefs === null
        || toolRunRefs === null
      ) {
        return fail("invalid_arguments", "application close 参数不合法");
      }
      if (!Number.isInteger(sequence) || sequence! < 0) {
        return fail("missing_runtime_binding", "Core 未返回当前 tool_call event sequence，拒绝无边界封存");
      }
      const idempotencyKey = `learned-close-${sha256Hex(JSON.stringify({
        taskId: client.taskId,
        applicationId,
        sequence,
        outcomeClaim,
        corrections,
        evidenceRefs,
        toolRunRefs,
      })).slice(0, 40)}`;
      try {
        const result = await client.closeApplication({
          applicationId,
          endEventSequence: sequence!,
          outcomeClaim,
          humanCorrections: corrections,
          evidenceRefs,
          toolRunRefs,
          idempotencyKey,
        });
        return ok({
          schema: "skill-application.v1",
          application_id: result.applicationId,
          state: result.state,
          replayed: result.replayed,
          note: "已封存为待评价事实；outcome_claim 不是权威成功结论。",
        });
      } catch (error) {
        return caught(error);
      }
    },
  };
}

function requireClient(ctx: ToolExecContext): TaskEvolutionClient | AgentToolResult {
  if (!ctx.taskId || !ctx.evolution) {
    return fail("missing_task_binding", "Learned Skill 只允许在 Core-owned task 中使用");
  }
  return ctx.evolution;
}

function isToolError(value: TaskEvolutionClient | AgentToolResult): value is AgentToolResult {
  return "content" in value;
}

function caught(error: unknown): AgentToolResult {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "evolution_request_failed";
  return fail(code, error instanceof Error ? error.message : String(error));
}

function ok(value: Readonly<Record<string, unknown>>): AgentToolResult {
  return { content: JSON.stringify(value) };
}

function fail(error: string, reason: string): AgentToolResult {
  return { content: JSON.stringify({ error, reason }), isError: true };
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function identifier(value: unknown): string | null {
  const text = nonEmpty(value);
  return text && text.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) ? text : null;
}

function integer(value: unknown, min: number, max: number): number | null {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : null;
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const parsed = value.map(identifier);
  return parsed.every((item): item is string => item !== null) ? parsed : null;
}
