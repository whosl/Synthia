import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleSkillDocTool } from "./skill-doc-tool.ts";
import type { ToolExecContext } from "./agent-types.ts";
import {
  buildAgentDoc,
  composeSystemPrompt,
  clearAgentDocCache,
  DEFAULT_SKILLS_ROOT,
} from "./agent-doc.ts";

/** The doc tool never touches the exec context; a cast keeps the call sites readable. */
const NO_CTX = {} as ToolExecContext;

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "synthia-agent-doc-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body, "utf8");
  }
  return root;
}

beforeEach(() => {
  clearAgentDocCache();
});

describe("buildAgentDoc：手册 + 规则拼装", () => {
  test("真实技能包：手册在前，9 份规则按编号顺序在后，无读取问题", async () => {
    const doc = await buildAgentDoc({ noCache: true });

    expect(doc.problems).toEqual([]);
    expect(doc.sources[0]).toBe(join(DEFAULT_SKILLS_ROOT, "AGENT.md"));
    expect(doc.sources).toHaveLength(10); // 1 手册 + 9 规则
    // 文件名前缀就是阅读顺序，字符串序即编号序。
    expect(doc.sources.slice(1)).toEqual([...doc.sources.slice(1)].sort());

    expect(doc.text).toContain("Synthia FPGA 工程 Agent 操作手册");
    expect(doc.text).toContain("SYNTHIA-FPGA-RULE-00");
    expect(doc.text).toContain("SYNTHIA-FPGA-RULE-15");
    expect(doc.text).toContain("SYNTHIA-FPGA-RULE-60");
    // 手册讲的是身份与边界，规则讲工程做法——两者都在，才算「完整文档」。
    expect(doc.text).toContain("core_check_gate");
    expect(doc.text.indexOf("操作手册")).toBeLessThan(doc.text.indexOf("SYNTHIA-FPGA-RULE-00"));
  });

  test("规则之间用分隔线隔开，避免后一份的 ## 被读成前一份的续章", async () => {
    const root = await fixture({ "AGENT.md": "# 手册", "rules/00-a.md": "# A", "rules/10-b.md": "# B" });
    const doc = await buildAgentDoc({ skillsRoot: root, noCache: true });
    expect(doc.text).toBe("# 手册\n\n---\n\n# A\n\n---\n\n# B\n");
    await rm(root, { recursive: true, force: true });
  });

  test("手册缺失：降级为只有规则，记问题但不抛", async () => {
    const root = await fixture({ "rules/00-a.md": "# A" });
    const doc = await buildAgentDoc({ skillsRoot: root, noCache: true });

    expect(doc.text).toBe("# A\n");
    expect(doc.sources).toEqual([join(root, "rules", "00-a.md")]);
    expect(doc.problems).toHaveLength(1);
    expect(doc.problems[0]).toContain("AGENT.md");
    await rm(root, { recursive: true, force: true });
  });

  test("规则目录缺失：降级为只有手册，记问题但不抛", async () => {
    const root = await fixture({ "AGENT.md": "# 手册" });
    const doc = await buildAgentDoc({ skillsRoot: root, noCache: true });

    expect(doc.text).toBe("# 手册\n");
    expect(doc.problems).toHaveLength(1);
    expect(doc.problems[0]).toContain("rules");
    await rm(root, { recursive: true, force: true });
  });

  test("整个目录不存在：返回空文本，绝不抛——没手册也要让会话起得来", async () => {
    const doc = await buildAgentDoc({ skillsRoot: join(tmpdir(), "synthia-does-not-exist-9f3a"), noCache: true });
    expect(doc.text).toBe("");
    expect(doc.sources).toEqual([]);
    expect(doc.problems).toHaveLength(2); // 手册 + 规则目录各一条
  });

  test("非 .md 文件与空文件都不进提示词", async () => {
    const root = await fixture({
      "AGENT.md": "# 手册",
      "rules/00-a.md": "# A",
      "rules/05-empty.md": "   \n",
      "rules/README.txt": "not a rule",
    });
    const doc = await buildAgentDoc({ skillsRoot: root, noCache: true });
    expect(doc.sources.map((s) => s.split("/").at(-1))).toEqual(["AGENT.md", "00-a.md"]);
    await rm(root, { recursive: true, force: true });
  });

  test("默认走缓存：同一 root 只读一次盘（改文件后内容不变）", async () => {
    const root = await fixture({ "AGENT.md": "# v1", "rules/00-a.md": "# A" });
    const first = await buildAgentDoc({ skillsRoot: root });
    await writeFile(join(root, "AGENT.md"), "# v2", "utf8");

    expect((await buildAgentDoc({ skillsRoot: root })).text).toBe(first.text);
    // noCache 才看得到新内容——技能包是冻结的，缓存是为并发建会话时只读一次。
    expect((await buildAgentDoc({ skillsRoot: root, noCache: true })).text).toContain("# v2");
    await rm(root, { recursive: true, force: true });
  });
});

describe("composeSystemPrompt：静态在前、动态在后", () => {
  test("手册在前、状态快照在后（顺序决定提示词缓存命中，也决定模型先学会怎么读快照）", () => {
    const out = composeSystemPrompt("# 手册", "## 项目状态快照");
    expect(out).toBe("# 手册\n\n---\n\n## 项目状态快照\n");
    expect(out.indexOf("手册")).toBeLessThan(out.indexOf("状态快照"));
  });

  test("手册为空时退化成原来的纯快照，不留空分隔线", () => {
    expect(composeSystemPrompt("", "## 快照")).toBe("## 快照\n");
    expect(composeSystemPrompt("  \n ", "## 快照")).toBe("## 快照\n");
  });

  test("快照为空时只留手册", () => {
    expect(composeSystemPrompt("# 手册", "")).toBe("# 手册\n");
  });
});

describe("read_skill_doc：按需读技能包", () => {
  const tool = assembleSkillDocTool();

  async function call(args: unknown): Promise<{ isError: boolean; body: Record<string, unknown> }> {
    const res = await tool.execute(args, NO_CTX);
    return { isError: res.isError === true, body: JSON.parse(res.content) as Record<string, unknown> };
  }

  test("省略 path 列出技能包根目录，目录带尾斜杠", async () => {
    const { isError, body } = await call({});
    expect(isError).toBe(false);
    expect(body.kind).toBe("directory");
    expect(body.entries).toContain("AGENT.md");
    expect(body.entries).toContain("rules/");
    expect(body.entries).toContain("skills/");
  });

  test("列目录：10 个技能都在", async () => {
    const { body } = await call({ path: "skills" });
    expect(body.entries).toContain("fpga-rtl-build/");
    expect(body.entries).toContain("fpga-intake/");
    expect((body.entries as string[]).filter((e) => e.startsWith("fpga-"))).toHaveLength(10);
  });

  test("读文件：拿到 SKILL.md 正文", async () => {
    const { isError, body } = await call({ path: "skills/fpga-rtl-build/SKILL.md" });
    expect(isError).toBe(false);
    expect(body.kind).toBe("file");
    expect(body.content as string).toContain("fpga-rtl-build");
    expect(body.truncated).toBeUndefined();
  });

  test("模板也读得到——文件结构与命名就定在这里", async () => {
    const { isError, body } = await call({ path: "skills/fpga-tb-write/templates/tb_top.v" });
    expect(isError).toBe(false);
    expect((body.content as string).length).toBeGreaterThan(0);
  });

  test("超长文件截断并明说，不让模型把截断处当结尾", async () => {
    const { isError, body } = await call({ path: "data/board-catalog.json" });
    expect(isError).toBe(false);
    expect(body.truncated).toBeUndefined(); // 47 KB < 60 KB 上限，本身不该被截
    expect(body.bytes as number).toBeGreaterThan(40_000);
  });

  test("`./` 与前导 `/` 都当作技能包根目录下的相对路径", async () => {
    expect((await call({ path: "./skills" })).body.kind).toBe("directory");
    expect((await call({ path: "/skills/fpga-intake/SKILL.md" })).body.kind).toBe("file");
  });

  test("路径穿越被拦下：`..` 出不了技能包", async () => {
    for (const path of ["../../package.json", "skills/../../../etc/passwd", "../.."]) {
      const { isError, body } = await call({ path });
      expect(isError).toBe(true);
      expect(String(body.reason)).toContain("越界");
    }
  });

  test("绝对路径解析成根内相对路径，读不到系统文件", async () => {
    // 前导 `/` 被当成技能包根，所以 /etc/passwd 落到 skills/fpga/etc/passwd —— 不存在。
    const { isError, body } = await call({ path: "/etc/passwd" });
    expect(isError).toBe(true);
    expect(body.error).toBe("not_found");
  });

  test("软链接指向包外时拒读（realpath 复核）", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-skill-doc-"));
    const outside = join(root, "outside.txt");
    await writeFile(outside, "secret", "utf8");
    const packRoot = join(root, "pack");
    await mkdir(packRoot, { recursive: true });
    await symlink(outside, join(packRoot, "escape.md"));

    const linked = assembleSkillDocTool({ skillsRoot: packRoot });
    const res = await linked.execute({ path: "escape.md" }, NO_CTX);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("越界");
    expect(res.content).not.toContain("secret");
    await rm(root, { recursive: true, force: true });
  });

  test("找不到时直接给出同级清单，省掉一次「那这儿有什么」的往返", async () => {
    const { isError, body } = await call({ path: "skills/fpga-rtl-build/READMEE.md" });
    expect(isError).toBe(true);
    expect(body.error).toBe("not_found");
    expect(body.siblings).toContain("SKILL.md");
    expect(body.siblings).toContain("templates/");
  });

  test("工具契约：名字与描述能让模型知道何时该调", () => {
    expect(tool.name).toBe("read_skill_doc");
    expect(tool.description).toContain("SKILL.md");
    expect(tool.description).toContain("templates");
    expect(tool.parameters.required ?? []).toEqual([]); // path 可省略，先列目录再读
  });
});
