/**
 * Synthia Core — 工作区位置与路径契约（SYNTHIA-FPGA-RULE-25）
 *
 * 每个项目在磁盘上有一个真实的工作区目录，布局由 `skills/fpga/rules/25-workspace-layout.md`
 * 规定：`rtl/` 可综合 RTL、`tb/` TestBench、`sim/` 仿真产物、`doc/` 分析/规范/交接文档、
 * `prj/constr/` 约束。这里把那份规则**编码成代码**——规则文档只能约束模型的自觉，
 * 这里的校验才是真正拦得住的那道（人手改文件、agent 写文件、编辑器写回都过这一关）。
 *
 * 位置刻意放在仓库之外（`~/.synthia/workspaces/<projectId>/`）：工作区是**工作树**
 * 不是归档，不该混进 Synthia 自己的 git 历史。`SYNTHIA_WORKSPACES_DIR` 可覆盖，
 * 约定与 `runtime/agent-state.ts` 的 `SYNTHIA_RUNS_DIR` 一致。
 */

import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** 工作区根目录。测试与多实例部署用 `SYNTHIA_WORKSPACES_DIR` 覆盖。 */
export function workspacesRoot(): string {
  const override = process.env.SYNTHIA_WORKSPACES_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), ".synthia", "workspaces");
}

/**
 * 工作区错误。带稳定 code，由 `mapServiceError` 映射成 API 错误——
 * 本模块刻意不 import `api/errors.ts`，好让路径契约能脱离 HTTP 层单测。
 */
export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export type WorkspaceErrorCode =
  /** 路径违反 RULE-25（越界、绝对路径、目录不对、doc/ 下放源码…）→ 400 */
  | "WORKSPACE_PATH_INVALID"
  /** 工作区里没有这个文件 → 404 */
  | "WORKSPACE_FILE_NOT_FOUND"
  /** 目标文件带有未登记的人工改动，拒绝覆盖 → 409 */
  | "WORKSPACE_FILE_DIRTY"
  /** git 命令失败 → 500 */
  | "WORKSPACE_GIT_FAILED"
  /** 内容与 content_hash 对不上（git 历史被改写/对象损坏）→ 500 */
  | "CONTENT_HASH_MISMATCH";

/** RULE-25 §1 的五个顶层目录。`prj` 下目前只允许 `constr`。 */
export const WORKSPACE_DIRS: readonly string[] = ["rtl", "tb", "sim", "doc", "prj/constr"];

const TOP_LEVEL_DIRS: ReadonlySet<string> = new Set(["rtl", "tb", "sim", "doc", "prj"]);

/** RULE-25 §3：`doc/` 只放分析/规范/交接，任何 HDL 源码扩展名都不允许。 */
const HDL_EXT = /\.(?:v|sv|vh|svh|vhd|vhdl)$/i;

/** RULE-25 §2 明令禁止的平台前缀（含 MSYS/Cygwin 风格）。 */
const PLATFORM_PREFIX = /^(?:[A-Za-z]:|\/cygdrive\/|\/[a-zA-Z]\/)/;

/**
 * `sim/` 下的东西是**证据**不是产物：RULE-25 §1 说仿真/工具运行产物以
 * EvidenceManifest 登记，工作区内只留相对路径引用。所以它落盘、进 .gitignore，
 * 但永远不会被「一键登记」变成 artifact revision。
 */
export function isRegisterablePath(rel: string): boolean {
  return !rel.startsWith("sim/");
}

/**
 * 校验并规范化一个工作区相对路径。通过则返回规范形式（去掉 `./` 前缀），
 * 否则抛 `WORKSPACE_PATH_INVALID`。
 *
 * 这里的每一条都对应 RULE-25 的一句话，改动前请先改规则文档。
 */
export function validateWorkspacePath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new WorkspaceError("WORKSPACE_PATH_INVALID", "path 必须是非空字符串");
  }
  if (input.includes("\0")) {
    throw new WorkspaceError("WORKSPACE_PATH_INVALID", "path 含 NUL 字符");
  }
  // 反斜杠在本领域里只可能是 Windows 路径漏出来（RULE-25 §2 禁止平台相关前缀）。
  if (input.includes("\\")) {
    throw new WorkspaceError("WORKSPACE_PATH_INVALID", `path 不得含反斜杠（平台相关路径）：${input}`);
  }
  if (PLATFORM_PREFIX.test(input) || input.startsWith("/")) {
    throw new WorkspaceError(
      "WORKSPACE_PATH_INVALID",
      `path 必须是工作区相对路径，不得使用绝对路径或平台前缀（/d/、C:\\、/cygdrive/）：${input}`,
    );
  }

  const rel = input.startsWith("./") ? input.slice(2) : input;
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new WorkspaceError("WORKSPACE_PATH_INVALID", `path 含空段或 . / .. 越界段：${input}`);
  }
  if (segments.length < 2) {
    throw new WorkspaceError(
      "WORKSPACE_PATH_INVALID",
      `path 必须落在 ${WORKSPACE_DIRS.join(" / ")} 之一下，不得直接放在工作区根目录：${input}`,
    );
  }

  const [top, second] = segments as [string, string, ...string[]];
  if (!TOP_LEVEL_DIRS.has(top)) {
    throw new WorkspaceError(
      "WORKSPACE_PATH_INVALID",
      `顶层目录必须是 ${[...TOP_LEVEL_DIRS].join(" / ")} 之一（RULE-25 §1）：${input}`,
    );
  }
  if (top === "prj" && (second !== "constr" || segments.length < 3)) {
    throw new WorkspaceError(
      "WORKSPACE_PATH_INVALID",
      `约束候选统一放 prj/constr/ 下（RULE-25 §1）：${input}`,
    );
  }
  if (top === "doc" && HDL_EXT.test(rel)) {
    throw new WorkspaceError(
      "WORKSPACE_PATH_INVALID",
      `doc/ 只放分析/规范/交接文档，RTL 写 rtl/、TB 写 tb/（RULE-25 §3）：${input}`,
    );
  }
  return rel;
}

/** 项目 id 只允许出现在单层目录名里——挡住 `../` 和分隔符伪造的越界。 */
export function validateProjectId(projectId: unknown): string {
  if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 128) {
    throw new WorkspaceError("WORKSPACE_PATH_INVALID", "projectId 必须是 1..128 字符的字符串");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(projectId) || projectId === "." || projectId === "..") {
    throw new WorkspaceError("WORKSPACE_PATH_INVALID", `projectId 含非法字符：${projectId}`);
  }
  return projectId;
}

/** 该项目工作区的绝对路径（不保证已存在，见 `store.ensureWorkspace`）。 */
export function projectWorkspaceDir(projectId: string): string {
  return join(workspacesRoot(), validateProjectId(projectId));
}

/**
 * 拼出工作区内某文件的绝对路径，并复核它确实落在工作区里。
 * `validateWorkspacePath` 已经挡掉了 `..`，这里是第二道（防御 resolve 的意外行为）。
 */
export function absoluteWorkspacePath(projectId: string, rel: string): string {
  const root = projectWorkspaceDir(projectId);
  const abs = resolve(root, validateWorkspacePath(rel));
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new WorkspaceError("WORKSPACE_PATH_INVALID", `path 越出工作区：${rel}`);
  }
  return abs;
}

// ─── content_location 编解码 ─────────────────────────────────────────────────

/** 内容位置：`git://<commitSha>/<workspace 相对路径>`，与既有 `db://…` 同构。 */
export interface GitLocation {
  readonly commit: string;
  readonly path: string;
}

export function formatGitLocation(commit: string, path: string): string {
  return `git://${commit}/${path}`;
}

/** 解析 `git://<sha>/<path>`；不是 git scheme 或格式不对时返回 null（调用方据此走 db 分支）。 */
export function parseGitLocation(location: string): GitLocation | null {
  if (!location.startsWith("git://")) return null;
  const rest = location.slice("git://".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const commit = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  // commit 必须是 git 对象名（40 位 sha1 或 64 位 sha256），否则整条 location 可疑。
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(commit) || path.length === 0) return null;
  return { commit, path };
}

/**
 * 由「项目 + 工作区路径」推导 artifact id。
 *
 * 路径就是文件的身份：同一条路径无论被 agent 写还是被人改，都必须落到**同一个**
 * artifact 上、版本递增，否则「同一个文件的历史」会被拆成两条互不相干的链。
 * 老数据（`fpga-p1-fpga-rtl-build-rtl-pwm.v` 之类）id 不同但已被 FK 引用改不得，
 * 靠 `artifact.title = 路径` 这条精确匹配来接上（见 store.findArtifactByPath）。
 */
export function artifactIdForPath(projectId: string, rel: string): string {
  return `ws-${projectId}-${rel}`.replace(/[^A-Za-z0-9._-]/g, "-");
}
