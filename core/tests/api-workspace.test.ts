/**
 * Synthia Core — 工作区落盘 + 内容读写走 git（真实 PostgreSQL + 真实 git）
 *
 * 阶段 1/2/3 的 API 侧验收：
 *   1. `POST /projects` 之后磁盘上真有一个按 SYNTHIA-FPGA-RULE-25 布局的 git 工作区；
 *      不能当目录名的项目 id 在**建库之前**就被拒。
 *   2. `version` 可省略、由服务端递增（自由 agent 出第二版的前提）。
 *   3. `GET .../content` 按 content_location 的 scheme 分派：git 取字节并复核 sha256，
 *      篡改可见（500），git 读不到时回落 DB 归档副本。
 *   4. 审批建立基线后，成员修订的正文被冻结回 DB。
 *   5. 工作区四条 API：树 / 读文件 / 写回 / 一键登记（一次 commit → N 条候选修订）。
 *
 * 工作区根目录由 harness 指向临时目录，绝不碰操作员的 ~/.synthia。
 * 需要 DATABASE_URL；未设置时整个 suite 显式跳过（跳过不算通过）。
 */

import { beforeAll, beforeEach, afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Hex } from "../src/hashing.ts";
import { headSha, listTree } from "../src/workspace/git.ts";
import { formatGitLocation } from "../src/workspace/paths.ts";
import { writeAndCommit } from "../src/workspace/store.ts";
import type { ApiHarness } from "./support/api-harness.ts";
import { apiCall, setupApiHarness, teardownApiHarness, truncateDomainTables } from "./support/api-harness.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const AUTHOR = { name: "测试", email: "test@synthia.local" } as const;

describe.skipIf(!DATABASE_URL)("工作区 API（真实 PostgreSQL + git）", () => {
  let harness: ApiHarness;
  let baseUrl: string;
  let humanToken: string;
  let humanUid: string;

  beforeAll(async () => {
    harness = await setupApiHarness(DATABASE_URL);
    baseUrl = harness.baseUrl;
    humanToken = harness.ids.humanToken;
    humanUid = harness.ids.humanUid;
  });

  afterAll(async () => {
    if (harness) await teardownApiHarness(harness);
  });

  beforeEach(async () => {
    await truncateDomainTables(harness.client);
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  function envelopeData(json: unknown): Record<string, unknown> {
    const env = json as { data?: unknown };
    if (!env || typeof env !== "object" || !("data" in env)) throw new Error(`missing data envelope: ${JSON.stringify(json)}`);
    return env.data as Record<string, unknown>;
  }

  async function postProject(id: string): Promise<{ status: number; json: unknown }> {
    return apiCall(baseUrl, "/api/v1/projects", {
      method: "POST",
      body: { id, name: `Project ${id}` },
      token: humanToken,
      headers: { "idempotency-key": `k_${id}_${randomUUID()}` },
    });
  }

  async function newProject(): Promise<string> {
    const projectId = `proj_${randomUUID()}`;
    const res = await postProject(projectId);
    if (res.status !== 201) throw new Error(`createProject failed: ${JSON.stringify(res.json)}`);
    return projectId;
  }

  function workspaceOf(projectId: string): string {
    return join(harness.workspacesDir, projectId);
  }

  async function postRevision(
    projectId: string,
    artifactId: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: unknown }> {
    return apiCall(baseUrl, `/api/v1/projects/${projectId}/artifacts/${artifactId}/revisions`, {
      method: "POST",
      body,
      token: humanToken,
      headers: { "idempotency-key": `k_rev_${randomUUID()}` },
    });
  }

  /** 把内容写进工作区并提交，再登记成一条指向该 commit 的修订。 */
  async function commitAndRegister(
    projectId: string,
    artifactId: string,
    path: string,
    content: string,
  ): Promise<{ revisionId: string; commit: string }> {
    const out = await writeAndCommit(projectId, [{ path, content }], `写 ${path}`, AUTHOR);
    const revisionId = `rev_${randomUUID()}`;
    const res = await postRevision(projectId, artifactId, {
      id: revisionId,
      content_hash: sha256Hex(content),
      content_location: formatGitLocation(out.commit!, path),
      title: path,
    });
    if (res.status !== 201) throw new Error(`createRevision failed: ${JSON.stringify(res.json)}`);
    return { revisionId, commit: out.commit! };
  }

  function getContent(projectId: string, artifactId: string, revisionId: string) {
    return apiCall(baseUrl, `/api/v1/projects/${projectId}/artifacts/${artifactId}/revisions/${revisionId}/content`, {
      token: humanToken,
    });
  }

  // ── 工作区 API helpers ─────────────────────────────────────────────────────

  function getTree(projectId: string) {
    return apiCall(baseUrl, `/api/v1/projects/${projectId}/workspace/tree`, { token: humanToken });
  }

  function getFile(projectId: string, path: string) {
    return apiCall(baseUrl, `/api/v1/projects/${projectId}/workspace/file?path=${encodeURIComponent(path)}`, {
      token: humanToken,
    });
  }

  function putFile(projectId: string, path: string, content: string) {
    return apiCall(baseUrl, `/api/v1/projects/${projectId}/workspace/file`, {
      method: "PUT",
      body: { path, content },
      token: humanToken,
    });
  }

  function register(projectId: string, body: Record<string, unknown> = {}, key = `k_reg_${randomUUID()}`) {
    return apiCall(baseUrl, `/api/v1/projects/${projectId}/workspace/register`, {
      method: "POST",
      body,
      token: humanToken,
      headers: { "idempotency-key": key },
    });
  }

  /** 绕开 API 直接改盘上的文件——模拟用户拿 vim / 编辑器动手。 */
  async function editOnDisk(projectId: string, path: string, content: string): Promise<void> {
    const abs = join(workspaceOf(projectId), path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  interface TreeFileRow {
    path: string;
    status: string;
    artifact_id: string | null;
    revision_id: string | null;
    version: number | null;
    content_hash: string | null;
  }

  async function treeFiles(projectId: string): Promise<Map<string, TreeFileRow>> {
    const res = await getTree(projectId);
    if (res.status !== 200) throw new Error(`tree failed: ${JSON.stringify(res.json)}`);
    const files = envelopeData(res.json).files as TreeFileRow[];
    return new Map(files.map((f) => [f.path, f]));
  }

  // ── 1. 建区 ────────────────────────────────────────────────────────────────

  test("建项目在磁盘上落出 RULE-25 布局的 git 工作区", async () => {
    const projectId = `proj_${randomUUID()}`;
    expect((await postProject(projectId)).status).toBe(201);

    const dir = workspaceOf(projectId);
    for (const sub of ["rtl", "tb", "sim", "doc", "prj/constr"]) {
      expect((await stat(join(dir, sub))).isDirectory()).toBe(true);
    }
    // 建区就有第一个 commit：后续每次登记都以它为父，历史从项目诞生那刻起是连续的。
    expect(await headSha(dir)).toMatch(/^[0-9a-f]{40}$/);
    expect(await listTree(dir, "HEAD")).toContain("rtl/.gitkeep");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain("sim/*");
  });

  test("重复建同一个项目不重置工作区（幂等）", async () => {
    const projectId = `proj_${randomUUID()}`;
    await postProject(projectId);
    const dir = workspaceOf(projectId);
    const before = await headSha(dir);

    expect((await postProject(projectId)).status).toBe(201);
    expect(await headSha(dir)).toBe(before);
  });

  test("不能当目录名的项目 id 在建库之前就被拒（400，且不留项目行）", async () => {
    for (const bad of ["../escape", "a/b", "p 1"]) {
      const res = await postProject(bad);
      expect(res.status).toBe(400);
      const { rows } = await harness.client.query("SELECT 1 FROM project WHERE id = $1", [bad]);
      expect(rows.length).toBe(0);
    }
  });

  // ── 2. 版本自动递增 ────────────────────────────────────────────────────────

  describe("版本自动递增", () => {
    test("省略 version 时同一产物连登三次得到 v1/v2/v3，不再 409", async () => {
      const projectId = await newProject();
      const artifactId = `art_${randomUUID()}`;
      const versions: number[] = [];
      for (const body of ["v1\n", "v2\n", "v3\n"]) {
        const res = await postRevision(projectId, artifactId, {
          id: `rev_${randomUUID()}`,
          content: body,
        });
        expect(res.status).toBe(201);
        versions.push(envelopeData(res.json).version as number);
      }
      expect(versions).toEqual([1, 2, 3]);
    });

    test("显式给 version 仍然照旧生效（老客户端不受影响）", async () => {
      const projectId = await newProject();
      const artifactId = `art_${randomUUID()}`;
      const explicit = await postRevision(projectId, artifactId, { id: `rev_${randomUUID()}`, version: 7, content: "x" });
      expect(envelopeData(explicit.json).version).toBe(7);
      // 之后省略 version 就接在 7 后面——服务端取的是当前最大版本 + 1，不是计数。
      const next = await postRevision(projectId, artifactId, { id: `rev_${randomUUID()}`, content: "y" });
      expect(envelopeData(next.json).version).toBe(8);
    });

    test("version 非正整数仍然是 400", async () => {
      const projectId = await newProject();
      const res = await postRevision(projectId, `art_${randomUUID()}`, { id: `rev_${randomUUID()}`, version: 0, content: "x" });
      expect(res.status).toBe(400);
    });
  });

  // ── 3. 内容按 scheme 分派 ──────────────────────────────────────────────────

  describe("内容读取按 content_location 分派", () => {
    test("git:// 的修订从工作区 git 里取到正文", async () => {
      const projectId = await newProject();
      const artifactId = `art_${randomUUID()}`;
      const content = "module pwm(input clk); endmodule\n";
      const { revisionId } = await commitAndRegister(projectId, artifactId, "rtl/pwm.v", content);

      const res = await getContent(projectId, artifactId, revisionId);
      expect(res.status).toBe(200);
      expect(envelopeData(res.json).content).toBe(content);
      expect(envelopeData(res.json).content_hash).toBe(sha256Hex(content));

      // DB 里没有正文副本：候选修订的内容只在 git 里。
      const { rows } = await harness.client.query("SELECT content FROM artifact_revision WHERE id = $1", [revisionId]);
      expect((rows[0] as { content: string | null }).content).toBeNull();
    });

    test("db:// 的修订照旧读 content 列（老数据零改动）", async () => {
      const projectId = await newProject();
      const artifactId = `art_${randomUUID()}`;
      const revisionId = `rev_${randomUUID()}`;
      await postRevision(projectId, artifactId, { id: revisionId, content: "内联正文\n" });
      const res = await getContent(projectId, artifactId, revisionId);
      expect(res.status).toBe(200);
      expect(envelopeData(res.json).content).toBe("内联正文\n");
    });

    test("git 里的字节与 content_hash 对不上 → 500，绝不返回坏内容", async () => {
      const projectId = await newProject();
      const artifactId = `art_${randomUUID()}`;
      const { revisionId } = await commitAndRegister(projectId, artifactId, "rtl/pwm.v", "真正的正文\n");
      // 模拟历史被改写：登记的 hash 换成别的内容的 hash。
      await harness.client.query("UPDATE artifact_revision SET content_hash = $1 WHERE id = $2", [
        sha256Hex("别的内容"),
        revisionId,
      ]);

      const res = await getContent(projectId, artifactId, revisionId);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.json)).toContain("CONTENT_HASH_MISMATCH");
    });

    test("git 对象读不到但有归档副本时回落到副本", async () => {
      const projectId = await newProject();
      const artifactId = `art_${randomUUID()}`;
      const content = "已批准的那一版\n";
      const { revisionId } = await commitAndRegister(projectId, artifactId, "rtl/pwm.v", content);
      // 归档副本已冻结（模拟基线冻结的结果），然后 git 目录整个没了。
      await harness.client.query("UPDATE artifact_revision SET content = $1 WHERE id = $2", [content, revisionId]);
      await rm(join(workspaceOf(projectId), ".git"), { recursive: true, force: true });

      const res = await getContent(projectId, artifactId, revisionId);
      expect(res.status).toBe(200);
      expect(envelopeData(res.json).content).toBe(content);
    });

    test("git 读不到且没有归档副本 → 404，如实报缺内容", async () => {
      const projectId = await newProject();
      const artifactId = `art_${randomUUID()}`;
      const { revisionId } = await commitAndRegister(projectId, artifactId, "rtl/pwm.v", "只在 git 里\n");
      await rm(join(workspaceOf(projectId), ".git"), { recursive: true, force: true });

      expect((await getContent(projectId, artifactId, revisionId)).status).toBe(404);
    });
  });

  // ── 4. 基线冻结 ────────────────────────────────────────────────────────────
  describe("已批准修订的正文冻结", () => {
    test("审批建立基线后，成员修订的正文从 git 冻回 DB", async () => {
      const projectId = await newProject();
      const artifactId = `art_${randomUUID()}`;
      const content = "module pwm(input clk); endmodule\n";
      const { revisionId } = await commitAndRegister(projectId, artifactId, "rtl/pwm.v", content);

      const processInstanceId = `proc_${randomUUID()}`;
      await apiCall(baseUrl, `/api/v1/projects/${projectId}/process-instances`, {
        method: "POST",
        body: { id: processInstanceId, gate_profile_version: "flow-v1", current_gate: "G1" },
        token: humanToken,
        headers: { "idempotency-key": `k_pi_${projectId}` },
      });
      await apiCall(baseUrl, `/api/v1/projects/${projectId}/role-assignments`, {
        method: "POST",
        body: { id: `role_${randomUUID()}`, actor_type: "human", actor_id: humanUid, role: "quality" },
        token: humanToken,
        headers: { "idempotency-key": `k_role_${projectId}` },
      });
      const snapshotId = `snap_${randomUUID()}`;
      await apiCall(baseUrl, `/api/v1/projects/${projectId}/snapshots`, {
        method: "POST",
        body: { id: snapshotId, member_revision_ids: [revisionId], tool_model_policy_hash: sha256Hex("policy") },
        token: humanToken,
        headers: { "idempotency-key": `k_snap_${projectId}` },
      });
      const submissionId = `sub_${randomUUID()}`;
      await apiCall(baseUrl, `/api/v1/projects/${projectId}/gate-submissions`, {
        method: "POST",
        body: { id: submissionId, process_instance_id: processInstanceId, gate: "G1", snapshot_id: snapshotId },
        token: humanToken,
        headers: { "idempotency-key": `k_sub_${projectId}` },
      });
      await apiCall(baseUrl, `/api/v1/projects/${projectId}/gate-submissions/${submissionId}/submit`, {
        method: "POST",
        body: {},
        token: humanToken,
        headers: { "idempotency-key": `k_submit_${projectId}` },
      });

      // 批准前：正文只在 git 里。
      const before = await harness.client.query("SELECT content FROM artifact_revision WHERE id = $1", [revisionId]);
      expect((before.rows[0] as { content: string | null }).content).toBeNull();

      const approve = await apiCall(baseUrl, `/api/v1/projects/${projectId}/gate-submissions/${submissionId}/approve`, {
        method: "POST",
        body: {
          configuration_snapshot_id: snapshotId,
          approved_gate_result_id: `agr_${randomUUID()}`,
          baseline_id: `bl_${randomUUID()}`,
          check_results_hash: sha256Hex("checks"),
          signed_at: new Date().toISOString(),
        },
        token: humanToken,
        headers: { "idempotency-key": `k_approve_${projectId}` },
      });
      expect(approve.status).toBe(200);

      // 批准后：同一份字节被固化进 DB，git 历史哪怕被改写也还原得出评审看过的那一版。
      const after = await harness.client.query("SELECT content FROM artifact_revision WHERE id = $1", [revisionId]);
      expect((after.rows[0] as { content: string | null }).content).toBe(content);
    });
  });

  // ── 5. 工作区四条 API ──────────────────────────────────────────────────────

  describe("GET /workspace/tree", () => {
    test("新项目的树是空的（占位与 .gitignore 不算文件）", async () => {
      const projectId = await newProject();
      const res = await getTree(projectId);
      expect(res.status).toBe(200);
      const data = envelopeData(res.json);
      expect(data.files).toEqual([]);
      expect(data.pending_count).toBe(0);
    });

    test("手改的文件是 untracked / dirty，登记后变 registered 并带上产物信息", async () => {
      const projectId = await newProject();
      await editOnDisk(projectId, "rtl/pwm.v", "module pwm; endmodule\n");

      // 新文件：untracked，还没有对应产物。
      let files = await treeFiles(projectId);
      expect(files.get("rtl/pwm.v")!.status).toBe("untracked");
      expect(files.get("rtl/pwm.v")!.artifact_id).toBeNull();
      expect((envelopeData((await getTree(projectId)).json)).pending_count).toBe(1);

      const reg = await register(projectId, { change_reason: "首版 PWM" });
      expect(reg.status).toBe(200);

      // 登记之后：与 HEAD 一致 → registered，并接上刚建出来的产物 v1。
      files = await treeFiles(projectId);
      const entry = files.get("rtl/pwm.v")!;
      expect(entry.status).toBe("registered");
      expect(entry.version).toBe(1);
      expect(entry.content_hash).toBe(sha256Hex("module pwm; endmodule\n"));
      expect((envelopeData((await getTree(projectId)).json)).pending_count).toBe(0);

      // 再改一次：已登记过的文件变 dirty，但仍指向 v1（v2 要等下一次登记）。
      await editOnDisk(projectId, "rtl/pwm.v", "module pwm; // 改了\nendmodule\n");
      const dirty = (await treeFiles(projectId)).get("rtl/pwm.v")!;
      expect(dirty.status).toBe("dirty");
      expect(dirty.version).toBe(1);
    });

    test("sim/ 下的东西是证据不是产物：标 ignored，且不计入待登记数", async () => {
      const projectId = await newProject();
      await editOnDisk(projectId, "sim/run.log", "INFO: done\n");
      const res = await getTree(projectId);
      const data = envelopeData(res.json);
      expect((data.files as TreeFileRow[])[0]).toMatchObject({ path: "sim/run.log", status: "ignored", artifact_id: null });
      expect(data.pending_count).toBe(0);
    });

    test("不存在的项目 → 404", async () => {
      expect((await getTree(`proj_${randomUUID()}`)).status).toBe(404);
    });
  });

  describe("GET / PUT /workspace/file", () => {
    test("PUT 只落盘不 commit，GET 立刻读得到（改动进入 dirty）", async () => {
      const projectId = await newProject();
      const content = "module top; endmodule\n";

      const put = await putFile(projectId, "rtl/top.v", content);
      expect(put.status).toBe(200);
      expect(envelopeData(put.json).changed).toBe(true);
      expect(envelopeData(put.json).content_hash).toBe(sha256Hex(content));

      // 真的写到盘上了，而不是只在库里。
      expect(await readFile(join(workspaceOf(projectId), "rtl/top.v"), "utf8")).toBe(content);
      // 没有 commit：HEAD 还是建区那一个，文件处于待登记状态。
      expect((await treeFiles(projectId)).get("rtl/top.v")!.status).toBe("untracked");

      const get = await getFile(projectId, "rtl/top.v");
      expect(get.status).toBe(200);
      expect(envelopeData(get.json).content).toBe(content);
    });

    test("PUT 同样内容第二次报 changed=false（UI 据此不必刷新）", async () => {
      const projectId = await newProject();
      await putFile(projectId, "doc/notes.md", "# 记事\n");
      const again = await putFile(projectId, "doc/notes.md", "# 记事\n");
      expect(envelopeData(again.json).changed).toBe(false);
    });

    test("违反 RULE-25 的路径被拒（400），越界路径不落盘", async () => {
      const projectId = await newProject();
      for (const bad of ["../escape.v", "/etc/passwd", "README.md", "doc/pwm.v", "prj/other/x.tcl"]) {
        const res = await putFile(projectId, bad, "x");
        expect(res.status).toBe(400);
      }
      // 工作区里一个文件也没多出来。
      expect((await treeFiles(projectId)).size).toBe(0);
    });

    test("GET 不存在的文件 → 404；缺 path 参数 → 400", async () => {
      const projectId = await newProject();
      expect((await getFile(projectId, "rtl/missing.v")).status).toBe(404);
      expect((await apiCall(baseUrl, `/api/v1/projects/${projectId}/workspace/file`, { token: humanToken })).status).toBe(400);
    });

    test("GET 报告这份字节是不是登记过的修订（登记后 → registered + 修订身份）", async () => {
      const projectId = await newProject();
      const content = "module pwm; endmodule\n";
      await editOnDisk(projectId, "rtl/pwm.v", content);
      const reg = await register(projectId, { change_reason: "首版" });
      const first = (envelopeData(reg.json).registered as Array<{ revision_id: string }>)[0]!;

      const get = envelopeData((await getFile(projectId, "rtl/pwm.v")).json);
      expect(get.registered).toBe(true);
      expect(get.revision_id).toBe(first.revision_id);
      expect(get.version).toBe(1);
      expect(get.content_hash).toBe(sha256Hex(content));
      // commit 取自那一版的 git:// 位置——「这份字节就是这个 commit 里的那份」。
      expect(get.commit).toBe(envelopeData(reg.json).commit);
    });

    test("带未登记改动时 registered=false 且不给 commit（HEAD 里根本没有这些字节）", async () => {
      const projectId = await newProject();
      await editOnDisk(projectId, "rtl/pwm.v", "module pwm; endmodule\n");
      await register(projectId);
      await editOnDisk(projectId, "rtl/pwm.v", "module pwm; // 人改的\nendmodule\n");

      const get = envelopeData((await getFile(projectId, "rtl/pwm.v")).json);
      expect(get.registered).toBe(false);
      expect(get.commit).toBeNull();
      expect(get.revision_id).toBeNull();
      expect(get.version).toBeNull();
      // 但内容照给——「当前是什么」和「它是不是一版」是两个问题。
      expect(get.content).toContain("人改的");
    });

    test("改坏又改回来 → 仍是已登记的那一版（按字节判定，不看编辑历史）", async () => {
      const projectId = await newProject();
      const original = "module pwm; endmodule\n";
      await editOnDisk(projectId, "rtl/pwm.v", original);
      const reg = await register(projectId);
      const first = (envelopeData(reg.json).registered as Array<{ revision_id: string }>)[0]!;

      await editOnDisk(projectId, "rtl/pwm.v", "module pwm; // 改坏了\nendmodule\n");
      await editOnDisk(projectId, "rtl/pwm.v", original);

      const get = envelopeData((await getFile(projectId, "rtl/pwm.v")).json);
      expect(get.registered).toBe(true);
      expect(get.revision_id).toBe(first.revision_id);
      // 也没凭空多出一版：改回去不是一次工程决定。
      expect((await register(projectId)).status).toBe(200);
      const { rows } = await harness.client.query(
        "SELECT count(*)::int AS n FROM artifact_revision WHERE project_id = $1",
        [projectId],
      );
      expect((rows[0] as { n: number }).n).toBe(1);
    });

    test("git 干净不等于已登记：commit 落了而 DB 没落时，registered 仍为 false", async () => {
      const projectId = await newProject();
      await editOnDisk(projectId, "rtl/pwm.v", "module pwm; endmodule\n");
      await register(projectId);

      // 只走 git、不登记——模拟「commit 成功而 DB 那步失败」留下的状态。
      await writeAndCommit(projectId, [{ path: "rtl/pwm.v", content: "module pwm(input clk); endmodule\n" }], "只提交不登记", AUTHOR);

      // git 的视角：工作树与 HEAD 一致，看上去清清爽爽。
      expect((await treeFiles(projectId)).get("rtl/pwm.v")!.status).toBe("registered");
      // 字节的视角：这份内容不是任何一条修订。拿 git status 判定就会在这里说谎。
      const get = envelopeData((await getFile(projectId, "rtl/pwm.v")).json);
      expect(get.registered).toBe(false);
      expect(get.revision_id).toBeNull();
      expect(get.commit).toBeNull();
    });

    test("未登记过的文件（只 PUT 没 register）registered=false", async () => {
      const projectId = await newProject();
      await putFile(projectId, "rtl/top.v", "module top; endmodule\n");
      const get = envelopeData((await getFile(projectId, "rtl/top.v")).json);
      expect(get.registered).toBe(false);
      expect(get.artifact_id).toBeNull();
      expect(get.commit).toBeNull();
    });
  });

  describe("POST /workspace/files（agent 写候选）", () => {
    function writeFiles(
      projectId: string,
      files: Array<{ path: string; content: string }>,
      body: Record<string, unknown> = {},
      key = `k_wf_${randomUUID()}`,
    ) {
      return apiCall(baseUrl, `/api/v1/projects/${projectId}/workspace/files`, {
        method: "POST",
        body: { files, ...body },
        token: harness.ids.serviceToken,
        headers: { "idempotency-key": key },
      });
    }

    test("落盘 + commit + 登记，一次拿到修订身份", async () => {
      const projectId = await newProject();
      const rtl = "module pwm(input clk); endmodule\n";
      const res = await writeFiles(projectId, [{ path: "rtl/pwm.v", content: rtl }], { change_reason: "生成 PWM" });

      expect(res.status).toBe(200);
      const data = envelopeData(res.json);
      const registered = data.registered as Array<{ path: string; version: number; content_hash: string }>;
      expect(registered.map((r) => r.path)).toEqual(["rtl/pwm.v"]);
      expect(registered[0]!.version).toBe(1);
      expect(registered[0]!.content_hash).toBe(sha256Hex(rtl));

      // 盘上是真文件，git 里是真 commit，库里指向那个 commit。
      expect(await readFile(join(workspaceOf(projectId), "rtl/pwm.v"), "utf8")).toBe(rtl);
      expect(await listTree(workspaceOf(projectId), "HEAD")).toContain("rtl/pwm.v");
      const { rows } = await harness.client.query(
        "SELECT content_location, content FROM artifact_revision WHERE project_id = $1",
        [projectId],
      );
      expect((rows[0] as { content_location: string }).content_location).toBe(
        formatGitLocation(data.commit as string, "rtl/pwm.v"),
      );
      // 候选的正文只在 git 里——DB 不留副本，进基线时才冻结。
      expect((rows[0] as { content: string | null }).content).toBeNull();
    });

    test("只登记点名的路径，人手边没写完的改动不被顺手署上 agent 的名字", async () => {
      const projectId = await newProject();
      await editOnDisk(projectId, "doc/notes.md", "# 我还在写\n");

      const res = await writeFiles(projectId, [{ path: "rtl/pwm.v", content: "module pwm; endmodule\n" }]);
      expect((envelopeData(res.json).registered as Array<{ path: string }>).map((r) => r.path)).toEqual(["rtl/pwm.v"]);

      // 人的文件既没被登记，也没被这次 commit 收走。
      const tree = await treeFiles(projectId);
      expect(tree.get("doc/notes.md")!.status).toBe("untracked");
      expect(tree.get("doc/notes.md")!.revision_id).toBeNull();
    });

    test("目标文件带未登记的人工改动 → 409 且点名，整批不落盘", async () => {
      const projectId = await newProject();
      await writeFiles(projectId, [{ path: "rtl/pwm.v", content: "module pwm; endmodule\n" }]);
      await editOnDisk(projectId, "rtl/pwm.v", "module pwm; // 人正在改\nendmodule\n");

      const res = await writeFiles(projectId, [
        { path: "rtl/pwm.v", content: "module pwm; // agent 覆盖\nendmodule\n" },
        { path: "tb/pwm_tb.v", content: "module pwm_tb; endmodule\n" },
      ]);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.json)).toContain("rtl/pwm.v");

      // 人的改动原样保留；同批的另一个文件也没被写出去（整批拒绝，不留半个状态）。
      expect(await readFile(join(workspaceOf(projectId), "rtl/pwm.v"), "utf8")).toContain("人正在改");
      await expect(stat(join(workspaceOf(projectId), "tb/pwm_tb.v"))).rejects.toThrow();
    });

    test("同一路径连写两版 → v1、v2（自由 agent 出第二版的前提）", async () => {
      const projectId = await newProject();
      await writeFiles(projectId, [{ path: "rtl/pwm.v", content: "module pwm; endmodule\n" }]);
      const second = await writeFiles(projectId, [
        { path: "rtl/pwm.v", content: "module pwm(input clk); endmodule\n" },
      ]);

      const registered = second.status === 200
        ? (envelopeData(second.json).registered as Array<{ version: number; artifact_id: string }>)
        : [];
      expect(second.status).toBe(200);
      expect(registered[0]!.version).toBe(2);
    });

    test("重发一模一样的内容：不出新版、不造 commit，但回报那是哪一版", async () => {
      const projectId = await newProject();
      const content = "module pwm; endmodule\n";
      const first = await writeFiles(projectId, [{ path: "rtl/pwm.v", content }]);
      const head = await headSha(workspaceOf(projectId));

      const again = await writeFiles(projectId, [{ path: "rtl/pwm.v", content }]);
      const data = envelopeData(again.json);
      expect(data.registered).toEqual([]);
      const unchanged = data.unchanged as Array<{ path: string; revision_id: string; version: number }>;
      expect(unchanged.map((u) => u.path)).toEqual(["rtl/pwm.v"]);
      expect(unchanged[0]!.revision_id).toBe(
        (envelopeData(first.json).registered as Array<{ revision_id: string }>)[0]!.revision_id,
      );
      expect(await headSha(workspaceOf(projectId))).toBe(head);
    });

    test("commit 成功而 DB 写失败：重发同样内容补得回来（以树为准）", async () => {
      const projectId = await newProject();
      const content = "module pwm; endmodule\n";
      const first = await writeFiles(projectId, [{ path: "rtl/pwm.v", content }]);
      const reg = (envelopeData(first.json).registered as Array<{ artifact_id: string; revision_id: string }>)[0]!;

      // 模拟「git 那步成功、DB 那步失败」。此刻工作区干净、内容也一字未变——
      // 只看 commit 的 changed 列表的实现在这里会两手空空。
      await harness.client.query("DELETE FROM artifact_revision WHERE id = $1", [reg.revision_id]);
      await harness.client.query("DELETE FROM artifact WHERE id = $1", [reg.artifact_id]);

      const retry = await writeFiles(projectId, [{ path: "rtl/pwm.v", content }]);
      const recovered = envelopeData(retry.json).registered as Array<{ path: string; version: number }>;
      expect(recovered.map((r) => r.path)).toEqual(["rtl/pwm.v"]);
      expect(recovered[0]!.version).toBe(1);
    });

    test("拒绝往 sim/ 写产物，也拒绝越界路径与重复路径（400，盘上不留痕）", async () => {
      const projectId = await newProject();
      const head = await headSha(workspaceOf(projectId));

      expect((await writeFiles(projectId, [{ path: "sim/run.log", content: "INFO\n" }])).status).toBe(400);
      expect((await writeFiles(projectId, [{ path: "../escape.v", content: "x" }])).status).toBe(400);
      expect((await writeFiles(projectId, [
        { path: "rtl/a.v", content: "module a; endmodule\n" },
        { path: "rtl/a.v", content: "module a2; endmodule\n" },
      ])).status).toBe(400);
      expect((await writeFiles(projectId, [])).status).toBe(400);

      expect(await headSha(workspaceOf(projectId))).toBe(head);
      expect((await treeFiles(projectId)).size).toBe(0);
    });

    test("缺 Idempotency-Key → 400；同 key 重放返回同一批修订", async () => {
      const projectId = await newProject();
      const files = [{ path: "rtl/pwm.v", content: "module pwm; endmodule\n" }];
      const noKey = await apiCall(baseUrl, `/api/v1/projects/${projectId}/workspace/files`, {
        method: "POST",
        body: { files },
        token: harness.ids.serviceToken,
      });
      expect(noKey.status).toBe(400);

      const key = `k_wf_${randomUUID()}`;
      const first = await writeFiles(projectId, files, {}, key);
      const replay = await writeFiles(projectId, files, {}, key);
      expect(envelopeData(replay.json)).toEqual(envelopeData(first.json));

      const { rows } = await harness.client.query(
        "SELECT count(*)::int AS n FROM artifact_revision WHERE project_id = $1",
        [projectId],
      );
      expect((rows[0] as { n: number }).n).toBe(1);
    });
  });

  describe("POST /workspace/register（一键登记）", () => {
    test("一次 commit → N 条候选修订，各自指向同一个 sha", async () => {
      const projectId = await newProject();
      await editOnDisk(projectId, "rtl/pwm.v", "module pwm; endmodule\n");
      await editOnDisk(projectId, "tb/pwm_tb.v", "module pwm_tb; endmodule\n");
      await editOnDisk(projectId, "prj/constr/pins.xdc", "set_property PACKAGE_PIN A1 [get_ports clk]\n");

      const res = await register(projectId, { change_reason: "手工补齐三个文件" });
      expect(res.status).toBe(200);
      const data = envelopeData(res.json);
      const registered = data.registered as Array<{ path: string; revision_id: string; version: number }>;
      expect(registered.map((r) => r.path).sort()).toEqual(["prj/constr/pins.xdc", "rtl/pwm.v", "tb/pwm_tb.v"]);
      expect(registered.every((r) => r.version === 1)).toBe(true);

      // 三条修订共享同一个 commit——「这一次登记」在 DB 侧是可回溯的。
      const { rows } = await harness.client.query(
        "SELECT content_location, content, created_by_type FROM artifact_revision WHERE id = ANY($1::text[])",
        [registered.map((r) => r.revision_id)],
      );
      const locations = new Set((rows as Array<{ content_location: string }>).map((r) => r.content_location.split("/")[2]));
      expect(locations.size).toBe(1);
      expect([...locations][0]).toBe(data.commit);
      // 候选修订的正文只在 git 里，且记在人头上。
      expect(rows.every((r) => (r as { content: string | null }).content === null)).toBe(true);
      expect(rows.every((r) => (r as { created_by_type: string }).created_by_type === "human")).toBe(true);

      // 产物类型按 RULE-25 的目录语义推断。
      const types = await harness.client.query(
        "SELECT title, artifact_type FROM artifact WHERE project_id = $1 ORDER BY title",
        [projectId],
      );
      expect(types.rows).toEqual([
        { title: "prj/constr/pins.xdc", artifact_type: "XDC_CANDIDATE" },
        { title: "rtl/pwm.v", artifact_type: "RTL_SOURCE_SET" },
        { title: "tb/pwm_tb.v", artifact_type: "TB_SOURCE_SET" },
      ]);
    });

    test("登记出的修订能通过 content 接口原样读回（git 往返 + hash 复核）", async () => {
      const projectId = await newProject();
      const content = "module pwm(input clk, output reg q); endmodule\n";
      await putFile(projectId, "rtl/pwm.v", content);
      const reg = await register(projectId);
      const first = (envelopeData(reg.json).registered as Array<{ artifact_id: string; revision_id: string }>)[0]!;

      const got = await getContent(projectId, first.artifact_id, first.revision_id);
      expect(got.status).toBe(200);
      expect(envelopeData(got.json).content).toBe(content);
    });

    test("连改连登得到 v1/v2/v3，且挂在同一个产物上、parent 串成链", async () => {
      const projectId = await newProject();
      const versions: number[] = [];
      const artifactIds = new Set<string>();
      const revisionIds: string[] = [];
      for (const body of ["v1\n", "v2\n", "v3\n"]) {
        await editOnDisk(projectId, "doc/plan.md", body);
        const res = await register(projectId, { change_reason: body.trim() });
        const registered = envelopeData(res.json).registered as Array<{ artifact_id: string; revision_id: string; version: number }>;
        expect(registered.length).toBe(1);
        versions.push(registered[0]!.version);
        artifactIds.add(registered[0]!.artifact_id);
        revisionIds.push(registered[0]!.revision_id);
      }
      expect(versions).toEqual([1, 2, 3]);
      expect(artifactIds.size).toBe(1);

      // parent_revision_id 串成一条真实的谱系，而不是三条互不相干的记录。
      const { rows } = await harness.client.query(
        "SELECT id, parent_revision_id FROM artifact_revision WHERE id = ANY($1::text[])",
        [revisionIds],
      );
      const parents = new Map((rows as Array<{ id: string; parent_revision_id: string | null }>).map((r) => [r.id, r.parent_revision_id]));
      expect(parents.get(revisionIds[0]!)).toBeNull();
      expect(parents.get(revisionIds[1]!)).toBe(revisionIds[0]!);
      expect(parents.get(revisionIds[2]!)).toBe(revisionIds[1]!);
    });

    test("内容改回历史上出现过的样子仍然出新版（回退是一次真实的工程决定）", async () => {
      const projectId = await newProject();
      await editOnDisk(projectId, "rtl/pwm.v", "A\n");
      await register(projectId);
      await editOnDisk(projectId, "rtl/pwm.v", "B\n");
      await register(projectId);
      await editOnDisk(projectId, "rtl/pwm.v", "A\n");
      const back = await register(projectId, { change_reason: "回退到 A" });

      const registered = envelopeData(back.json).registered as Array<{ version: number }>;
      expect(registered.length).toBe(1);
      expect(registered[0]!.version).toBe(3);
    });

    test("没有改动时登记是空操作：不造 commit、不出修订", async () => {
      const projectId = await newProject();
      await editOnDisk(projectId, "rtl/pwm.v", "module pwm; endmodule\n");
      const first = await register(projectId);
      const headAfterFirst = await headSha(workspaceOf(projectId));

      const second = await register(projectId);
      expect(second.status).toBe(200);
      const data = envelopeData(second.json);
      expect(data.registered).toEqual([]);
      // 没出新版，但仍要说清「那是哪一版」——调用方据此接回已有修订。
      const unchanged = data.unchanged as Array<{ path: string; version: number; revision_id: string }>;
      expect(unchanged.map((u) => u.path)).toEqual(["rtl/pwm.v"]);
      expect(unchanged[0]!.version).toBe(1);
      expect(unchanged[0]!.revision_id).toBe(
        (envelopeData(first.json).registered as Array<{ revision_id: string }>)[0]!.revision_id,
      );
      expect(data.commit).toBe(envelopeData(first.json).commit);
      expect(await headSha(workspaceOf(projectId))).toBe(headAfterFirst);
    });

    test("commit 成功但 DB 写丢了时，下一次登记补得回来（以 git 树为准而非 status）", async () => {
      const projectId = await newProject();
      await editOnDisk(projectId, "rtl/pwm.v", "module pwm; endmodule\n");
      const reg = await register(projectId);
      const first = (envelopeData(reg.json).registered as Array<{ artifact_id: string; revision_id: string }>)[0]!;

      // 模拟「commit 已落地、DB 那步失败了」：把修订和产物从库里抹掉，git 里仍在。
      await harness.client.query("DELETE FROM artifact_revision WHERE id = $1", [first.revision_id]);
      await harness.client.query("DELETE FROM artifact WHERE id = $1", [first.artifact_id]);
      // 此刻工作区是干净的——按 `git status` 登记的实现在这里会永远补不回来。

      const retry = await register(projectId);
      const recovered = envelopeData(retry.json).registered as Array<{ path: string; version: number }>;
      expect(recovered.map((r) => r.path)).toEqual(["rtl/pwm.v"]);
      expect(recovered[0]!.version).toBe(1);
    });

    test("同一个 Idempotency-Key 重放返回同一批修订，不会重复登记", async () => {
      const projectId = await newProject();
      await editOnDisk(projectId, "rtl/pwm.v", "module pwm; endmodule\n");
      const key = `k_reg_${randomUUID()}`;

      const first = await register(projectId, { change_reason: "首版" }, key);
      const replay = await register(projectId, { change_reason: "首版" }, key);
      expect(replay.status).toBe(200);
      expect(envelopeData(replay.json)).toEqual(envelopeData(first.json));

      const { rows } = await harness.client.query(
        "SELECT count(*)::int AS n FROM artifact_revision WHERE project_id = $1",
        [projectId],
      );
      expect((rows[0] as { n: number }).n).toBe(1);
    });

    test("sim/ 与工作区根目录下的文件永远不会被登记", async () => {
      const projectId = await newProject();
      await editOnDisk(projectId, "sim/run.log", "INFO\n");
      await editOnDisk(projectId, "README.md", "# 说明\n");
      await editOnDisk(projectId, "rtl/pwm.v", "module pwm; endmodule\n");

      const res = await register(projectId);
      const data = envelopeData(res.json);
      expect((data.registered as Array<{ path: string }>).map((r) => r.path)).toEqual(["rtl/pwm.v"]);
      // sim/ 被 .gitignore 挡在 commit 之外；README.md 进了 commit 但登记时按路径判无效。
      expect(data.skipped).toEqual([{ path: "README.md", reason: "invalid_path" }]);
      expect(await listTree(workspaceOf(projectId), "HEAD")).not.toContain("sim/run.log");
    });

    test("agent 登记过的文件被人改后再登记，接的是同一个产物（靠 git:// 位置认路径）", async () => {
      const projectId = await newProject();
      const artifactId = `art_${randomUUID()}`;
      // agent 侧的登记：产物标题是人话，不是路径。
      await commitAndRegister(projectId, artifactId, "rtl/pwm.v", "module pwm; endmodule\n");

      await editOnDisk(projectId, "rtl/pwm.v", "module pwm; // 人改的\nendmodule\n");
      const res = await register(projectId, { change_reason: "人工修正" });
      const registered = envelopeData(res.json).registered as Array<{ artifact_id: string; version: number }>;
      expect(registered.length).toBe(1);
      expect(registered[0]!.artifact_id).toBe(artifactId);
      expect(registered[0]!.version).toBe(2);
    });

    test("缺 Idempotency-Key → 400；不存在的项目 → 404，且不在盘上建工作区", async () => {
      const projectId = await newProject();
      await editOnDisk(projectId, "rtl/pwm.v", "module pwm; endmodule\n");
      const before = await headSha(workspaceOf(projectId));
      const noKey = await apiCall(baseUrl, `/api/v1/projects/${projectId}/workspace/register`, {
        method: "POST",
        body: {},
        token: humanToken,
      });
      expect(noKey.status).toBe(400);
      // 注定 400 的请求不该在 git 历史里留下痕迹。
      expect(await headSha(workspaceOf(projectId))).toBe(before);

      const ghost = `proj_${randomUUID()}`;
      expect((await register(ghost)).status).toBe(404);
      await expect(stat(workspaceOf(ghost))).rejects.toThrow();
    });
  });
});
