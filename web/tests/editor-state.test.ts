import { describe, expect, test } from "bun:test";
import {
  deriveReadonlyReason,
  FALLBACK_LANGUAGE,
  isDocPreviewLanguage,
  languageFromExtension,
  languageFromPath,
  monacoThemeFor,
  type ReadonlyInput,
} from "../src/domain/editor-state.ts";

/** 简化的终态判定 mock：与 domain/tasks.ts:isTerminalStatus 语义一致，但不依赖它。 */
function isAgentTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "fail_closed" || status === "interrupted";
}

/** 默认可编辑的一份入参：盘上的工作区文件、候选版本、agent 已停。逐项覆盖来测各条只读原因。 */
function readonly(over: Partial<ReadonlyInput> = {}): ReadonlyInput {
  return { revisionState: "candidate", agentStatus: "succeeded", inWorkspace: true, contentSource: "workspace", ...over };
}

describe("deriveReadonlyReason", () => {
  test("盘上的工作区文件、候选版本、agent 已停 → 可编辑（null）", () => {
    expect(deriveReadonlyReason(readonly(), isAgentTerminal)).toBeNull();
    expect(deriveReadonlyReason(readonly({ agentStatus: "failed" }), isAgentTerminal)).toBeNull();
    expect(deriveReadonlyReason(readonly({ agentStatus: "fail_closed" }), isAgentTerminal)).toBeNull();
    expect(deriveReadonlyReason(readonly({ agentStatus: "interrupted" }), isAgentTerminal)).toBeNull();
  });

  test("项目尚无 run（agentStatus=null）→ 可编辑", () => {
    expect(deriveReadonlyReason(readonly({ agentStatus: null }), isAgentTerminal)).toBeNull();
  });

  test("盘上有、还没登记（revisionState=null）→ 可编辑，不是只读", () => {
    // 人刚新建的文件没有任何修订，但正文就在盘上、没有治理状态挡着。
    // 老版本这里是 `revisionState === null → null`（意思是"没打开文件"），
    // 现在 null 有了实义，判成只读会让新建的文件一打开就敲不进字。
    expect(deriveReadonlyReason(readonly({ revisionState: null }), isAgentTerminal)).toBeNull();
  });

  test("已批准版本 → approved（优先级最高，不看其余三项）", () => {
    expect(deriveReadonlyReason(readonly({ revisionState: "approved", agentStatus: "running" }), isAgentTerminal)).toBe("approved");
    expect(deriveReadonlyReason(readonly({ revisionState: "approved", agentStatus: null }), isAgentTerminal)).toBe("approved");
    expect(deriveReadonlyReason(readonly({ revisionState: "approved", inWorkspace: false }), isAgentTerminal)).toBe("approved");
  });

  test("run 运行中（非终态）→ agent-running，压过后面两条能力原因", () => {
    expect(deriveReadonlyReason(readonly({ agentStatus: "running" }), isAgentTerminal)).toBe("agent-running");
    expect(deriveReadonlyReason(readonly({ agentStatus: "awaiting_approval" }), isAgentTerminal)).toBe("agent-running");
    // 治理原因说得比能力原因更准：agent 在跑时，「不在工作区」不是人现在该关心的事。
    expect(deriveReadonlyReason(readonly({ agentStatus: "running", inWorkspace: false }), isAgentTerminal)).toBe("agent-running");
  });

  test("产物不在工作区（流水线产出的 art-*）→ not-in-workspace", () => {
    // 保存只能写工作区文件。这类产物从没落过盘，放开编辑等于收下敲进去的字再丢掉。
    expect(deriveReadonlyReason(readonly({ inWorkspace: false }), isAgentTerminal)).toBe("not-in-workspace");
    expect(deriveReadonlyReason(readonly({ inWorkspace: false, revisionState: null }), isAgentTerminal)).toBe("not-in-workspace");
  });

  test("正文取自某一版修订而非盘上字节 → historical", () => {
    // 写回去等于拿旧版覆盖盘上的新改动，是一次没人要求过的静默回滚。
    expect(deriveReadonlyReason(readonly({ contentSource: "revision" }), isAgentTerminal)).toBe("historical");
  });

  test("不在工作区排在历史版本之前：两条都成立时说更根本的那条", () => {
    // `art-*` 的正文只可能来自修订，两个条件必然同时成立。说「历史版本 · 只读」
    // 会让人以为切回最新版就能改，可它压根没有盘上的那一份。
    expect(deriveReadonlyReason(readonly({ inWorkspace: false, contentSource: "revision" }), isAgentTerminal)).toBe("not-in-workspace");
  });

  test("rejected/superseded/invalidated 等非 approved 状态一律走后面的判定规则", () => {
    expect(deriveReadonlyReason(readonly({ revisionState: "rejected", agentStatus: "running" }), isAgentTerminal)).toBe("agent-running");
    expect(deriveReadonlyReason(readonly({ revisionState: "superseded" }), isAgentTerminal)).toBeNull();
    expect(deriveReadonlyReason(readonly({ revisionState: "invalidated", inWorkspace: false }), isAgentTerminal)).toBe("not-in-workspace");
  });
});

describe("languageFromExtension", () => {
  test("Verilog / SystemVerilog", () => {
    expect(languageFromExtension("v")).toBe("verilog");
    expect(languageFromExtension("vh")).toBe("verilog");
    expect(languageFromExtension("sv")).toBe("systemverilog");
    expect(languageFromExtension("svh")).toBe("systemverilog");
  });

  test("Tcl / XDC 均映射到 tcl", () => {
    expect(languageFromExtension("tcl")).toBe("tcl");
    expect(languageFromExtension("xdc")).toBe("tcl");
  });

  test("markdown / json / yaml", () => {
    expect(languageFromExtension("md")).toBe("markdown");
    expect(languageFromExtension("json")).toBe("json");
    expect(languageFromExtension("yaml")).toBe("yaml");
    expect(languageFromExtension("yml")).toBe("yaml");
  });

  test("大小写不敏感", () => {
    expect(languageFromExtension("V")).toBe("verilog");
    expect(languageFromExtension("MD")).toBe("markdown");
  });

  test("未知扩展名兜底 plaintext", () => {
    expect(languageFromExtension("txt")).toBe(FALLBACK_LANGUAGE);
    expect(languageFromExtension("")).toBe(FALLBACK_LANGUAGE);
  });
});

describe("languageFromPath", () => {
  test("按路径最后一段扩展名判断", () => {
    expect(languageFromPath("rtl/uart_tx.v")).toBe("verilog");
    expect(languageFromPath("tb/uart_tb.sv")).toBe("systemverilog");
    expect(languageFromPath("prj/constr/uart.xdc")).toBe("tcl");
    expect(languageFromPath("doc/架构设计.md")).toBe("markdown");
  });

  test("路径含多个点时取最后一个扩展名", () => {
    expect(languageFromPath("rtl/uart_tx.gen.v")).toBe("verilog");
  });

  test("无路径（null）兜底 plaintext", () => {
    expect(languageFromPath(null)).toBe(FALLBACK_LANGUAGE);
  });

  test("无扩展名 / 以点结尾兜底 plaintext", () => {
    expect(languageFromPath("rtl/Makefile")).toBe(FALLBACK_LANGUAGE);
    expect(languageFromPath("rtl/uart_tx.")).toBe(FALLBACK_LANGUAGE);
  });
});

describe("isDocPreviewLanguage", () => {
  test("markdown → true", () => {
    expect(isDocPreviewLanguage("markdown")).toBe(true);
  });

  test("其余语言 → false", () => {
    expect(isDocPreviewLanguage("verilog")).toBe(false);
    expect(isDocPreviewLanguage("json")).toBe(false);
    expect(isDocPreviewLanguage(FALLBACK_LANGUAGE)).toBe(false);
  });
});

describe("monacoThemeFor", () => {
  test("dark → vs-dark", () => {
    expect(monacoThemeFor("dark")).toBe("vs-dark");
  });

  test("light → vs", () => {
    expect(monacoThemeFor("light")).toBe("vs");
  });
});
