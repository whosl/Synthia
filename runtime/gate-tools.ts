/**
 * Synthia Runtime — GJB gate tools for the free-agent mode (spec 001-agent-freedom).
 *
 * Three model-selectable tools that give the free agent real milestone-gate
 * enforcement power (the spec gap: the model could only *say* "waiting for
 * approval" with no system-level gate machinery):
 *
 * - `core_create_snapshot` → GovernanceClient.createSnapshot (+ records members
 *   in the session registry for the conformity pre-check).
 * - `core_submit_gate`     → runs the content-conformity gate on the snapshot's
 *   artifacts (topic / name / port), then createGateSubmission + submitGate,
 *   then **locks the session** into the awaiting-approval state. Conformity
 *   failure is returned as an error with the diff detail so the model can fix
 *   and re-register (version increments already exist in the skill tools).
 * - `core_check_gate`      → getGateSubmissionState; on `approved` it unlocks the
 *   session, on `rejected`/`withdrawn` it stays locked and tells the model.
 *
 * The lock is enforced at the tool-execution layer in `free-agent.ts`
 * (hard-block every tool except `core_check_gate` while locked) — not a prompt
 * request.
 *
 * All three fail closed: a missing controller, a malformed argument, or a Core
 * error surfaces as an `isError` result and never fakes success.
 */

import type { AgentTool, AgentToolResult, ToolExecContext } from "./agent-types.ts";
import type { GateId, GateSubmissionState, GjbGate } from "./types.ts";
import { GJB_GATES } from "./types.ts";
import { checkGateConformity, collectKeywordSources, type ConformityArtifact } from "./conformity.ts";

/** Stable marker for snapshots created by the free-agent (always exploratory). */
const FREE_AGENT_TOOL_MODEL_POLICY_HASH = "synthia:free-agent:exploratory:v1";

/** Tools exempt from conformity (intake-side / non-design gates). */
const CONFORMITY_GATES: Readonly<Record<string, true>> = { G3: true, G4: true };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asGjbGate(gate: unknown): GjbGate | null {
  return typeof gate === "string" && (GJB_GATES as readonly string[]).includes(gate)
    ? (gate as GjbGate)
    : null;
}

// ---------------------------------------------------------------------------
// core_create_snapshot
// ---------------------------------------------------------------------------

function buildCreateSnapshotTool(): AgentTool {
  return {
    name: "core_create_snapshot",
    description:
      "冻结一份配置快照（ConfigurationSnapshot）：把指定的一组候选修订（member_revision_ids，" +
      "由 skill 工具登记时返回的 revisionId）固化为不可变快照，供后续门禁提交审阅。" +
      "入参 member_revision_ids=修订 id 数组。返回 snapshotId。须在 core_submit_gate 前调用。",
    parameters: {
      type: "object",
      properties: {
        member_revision_ids: {
          type: "array",
          items: { type: "string" },
          description: "纳入快照的候选修订 revisionId 列表（来自 skill 工具的登记返回）。",
        },
      },
      required: ["member_revision_ids"],
    },

    async execute(args: unknown, ctx: ToolExecContext): Promise<AgentToolResult> {
      const ctrl = ctx.freeAgent;
      if (!ctrl) {
        return {
          content: JSON.stringify({ error: "no_session", reason: "core_create_snapshot 仅在自由 Agent 会话内可用" }),
          isError: true,
        };
      }
      const argObj = isPlainObject(args) ? args : {};
      const raw = argObj.member_revision_ids;
      if (!Array.isArray(raw) || raw.length === 0 || !raw.every((r) => typeof r === "string")) {
        return {
          content: JSON.stringify({ error: "bad_args", reason: "member_revision_ids 须为非空字符串数组" }),
          isError: true,
        };
      }
      const memberRevisionIds = raw as readonly string[];

      let snapshotId: string;
      try {
        const res = await ctx.governance.createSnapshot({
          memberRevisionIds,
          toolModelPolicyHash: FREE_AGENT_TOOL_MODEL_POLICY_HASH,
        });
        snapshotId = res.snapshotId;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return {
          content: JSON.stringify({ error: "create_snapshot_failed", reason }),
          isError: true,
        };
      }

      ctrl.recordSnapshot(snapshotId, memberRevisionIds);
      return {
        content: JSON.stringify({
          snapshotId,
          memberRevisionIds,
          note: "快照已冻结。调用 core_submit_gate(gate, snapshot_id) 提交审阅；提交后会话进入等待批准态。",
        }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// core_submit_gate
// ---------------------------------------------------------------------------

function buildSubmitGateTool(): AgentTool {
  return {
    name: "core_submit_gate",
    description:
      "提交里程碑门禁审阅（G1–G4）：对快照产物先强制运行内容符合性校验（主题/名称/端口，" +
      "G3/G4），通过后创建 GateSubmission 并提交审阅（preparing→in_review）。" +
      "提交成功后会话**进入等待批准态**：在人工批准前，除 core_check_gate 轮询与纯对话外，" +
      "一切 skill/vivado 工具调用被系统硬拦。入参 gate∈G1..G4、snapshot_id（来自 core_create_snapshot）。" +
      "返回 submissionId 与 state。符合性不通过返回 error+差异明细，可修复后重新登记（版本递增）再提交。",
    parameters: {
      type: "object",
      properties: {
        gate: { type: "string", enum: ["G1", "G2", "G3", "G4"], description: "目标里程碑门禁。" },
        snapshot_id: { type: "string", description: "core_create_snapshot 返回的 snapshotId。" },
      },
      required: ["gate", "snapshot_id"],
    },

    async execute(args: unknown, ctx: ToolExecContext): Promise<AgentToolResult> {
      const ctrl = ctx.freeAgent;
      if (!ctrl) {
        return {
          content: JSON.stringify({ error: "no_session", reason: "core_submit_gate 仅在自由 Agent 会话内可用" }),
          isError: true,
        };
      }
      const argObj = isPlainObject(args) ? args : {};
      const gate = asGjbGate(argObj.gate);
      if (!gate) {
        return {
          content: JSON.stringify({ error: "bad_args", reason: "gate 须为 G1/G2/G3/G4 之一" }),
          isError: true,
        };
      }
      const snapshotId = typeof argObj.snapshot_id === "string" ? argObj.snapshot_id.trim() : "";
      if (!snapshotId) {
        return {
          content: JSON.stringify({ error: "bad_args", reason: "snapshot_id 必填（来自 core_create_snapshot）" }),
          isError: true,
        };
      }

      // --- content-conformity pre-check (G3/G4) on the snapshot's artifacts ---
      if (CONFORMITY_GATES[gate] === true) {
        const members = ctrl.getSnapshotMembers(snapshotId);
        const artifacts: ConformityArtifact[] = [];
        if (members) {
          for (const revId of members) {
            const info = ctrl.getArtifact(revId);
            if (info) {
              artifacts.push({
                artifactType: info.artifactType,
                content: info.content,
                contentLocation: info.contentLocation,
                title: info.title,
              });
            }
          }
        }
        const keywordSources = collectKeywordSources(ctrl.artifacts);
        const conformity = checkGateConformity(gate, artifacts, keywordSources);
        if (!conformity.ok) {
          return {
            content: JSON.stringify({
              error: "content_conformity_failed",
              gate,
              problems: conformity.problems,
              note: "制品未通过内容符合性校验，未提交门禁。请据差异明细修复制品、重新登记（skill 工具版本递增）、重建快照后再提交。",
            }),
            isError: true,
          };
        }
      }

      // --- create submission + submit for review ---
      let submissionId: string;
      try {
        const created = await ctx.governance.createGateSubmission({
          processInstanceId: ctrl.processInstanceId,
          gate: gate as GateId,
          snapshotId,
        });
        submissionId = created.submissionId;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return {
          content: JSON.stringify({ error: "create_submission_failed", reason }),
          isError: true,
        };
      }

      let state: GateSubmissionState;
      try {
        const submitted = await ctx.governance.submitGate(submissionId);
        state = submitted.state;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return {
          content: JSON.stringify({ error: "submit_gate_failed", submissionId, reason }),
          isError: true,
        };
      }

      // --- lock semantics ---
      if (state === "approved") {
        // No-governance / auto-approve path: do not lock.
        return {
          content: JSON.stringify({
            submissionId,
            state,
            note: "门禁已自动批准（无人工审批模式）；会话未锁定，可继续。",
          }),
        };
      }

      // Real review path: lock the session until human approval.
      ctrl.lockForGate(gate as GateId, submissionId);
      return {
        content: JSON.stringify({
          submissionId,
          state,
          locked: true,
          note:
            `门禁 ${gate} 已提交审阅（${state}）。会话进入「等待批准」态：在人工批准前，` +
            `除 core_check_gate 轮询与纯对话外，一切 skill/vivado 工具调用被系统硬拦。` +
            `请用 core_check_gate(submission_id) 查询状态；approved 后自动解锁。`,
        }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// core_check_gate
// ---------------------------------------------------------------------------

function buildCheckGateTool(): AgentTool {
  return {
    name: "core_check_gate",
    description:
      "查询门禁提交审阅状态（poll getGateSubmissionState）。" +
      "approved → 会话解锁，恢复 skill/vivado 工具；rejected/withdrawn → 保持锁定并告知；" +
      "preparing/submitted/checking/in_review → 仍在审阅，保持锁定。" +
      "入参 submission_id（来自 core_submit_gate 返回）。返回 state。",
    parameters: {
      type: "object",
      properties: {
        submission_id: { type: "string", description: "core_submit_gate 返回的 submissionId。" },
      },
      required: ["submission_id"],
    },

    async execute(args: unknown, ctx: ToolExecContext): Promise<AgentToolResult> {
      const ctrl = ctx.freeAgent;
      if (!ctrl) {
        return {
          content: JSON.stringify({ error: "no_session", reason: "core_check_gate 仅在自由 Agent 会话内可用" }),
          isError: true,
        };
      }
      const argObj = isPlainObject(args) ? args : {};
      const submissionId = typeof argObj.submission_id === "string" ? argObj.submission_id.trim() : "";
      if (!submissionId) {
        return {
          content: JSON.stringify({ error: "bad_args", reason: "submission_id 必填" }),
          isError: true,
        };
      }

      let state: GateSubmissionState;
      try {
        const res = await ctx.governance.getGateSubmissionState(submissionId);
        state = res.state;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return {
          content: JSON.stringify({ error: "check_gate_failed", submissionId, reason }),
          isError: true,
        };
      }

      if (state === "approved") {
        ctrl.unlockGate();
        return {
          content: JSON.stringify({
            submissionId,
            state,
            locked: false,
            note: "门禁已批准，会话已解锁。skill/vivado 工具恢复可用，可继续推进项目。",
          }),
        };
      }

      // rejected / withdrawn / in_review / preparing / submitted / checking → stay locked.
      const terminal = state === "rejected" || state === "withdrawn";
      return {
        content: JSON.stringify({
          submissionId,
          state,
          locked: true,
          ...(terminal ? { terminal: true } : {}),
          note: terminal
            ? `门禁已被 ${state}，会话保持锁定（不自动解锁）。需人工重新开启流程或用户介入。`
            : `门禁仍在审阅（${state}），会话保持锁定。请等待人工批准后再次查询。`,
        }),
        ...(terminal ? { isError: true } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble the three GJB gate tools for the free-agent toolset.
 * Combine with skill tools + the vivado tool in the session assembly.
 */
export function assembleGateTools(): AgentTool[] {
  return [buildCreateSnapshotTool(), buildSubmitGateTool(), buildCheckGateTool()];
}
