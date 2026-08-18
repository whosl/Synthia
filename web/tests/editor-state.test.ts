import { describe, expect, test } from "bun:test";
import {
  deriveReadonlyReason,
  FALLBACK_LANGUAGE,
  isDocPreviewLanguage,
  languageFromExtension,
  languageFromPath,
  monacoThemeFor,
} from "../src/domain/editor-state.ts";

/** 简化的终态判定 mock：与 domain/tasks.ts:isTerminalStatus 语义一致，但不依赖它。 */
function isRunTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "fail_closed" || status === "interrupted";
}

describe("deriveReadonlyReason", () => {
  test("未打开文件（无版本）→ null", () => {
    expect(deriveReadonlyReason(null, "running", isRunTerminal)).toBeNull();
    expect(deriveReadonlyReason(null, null, isRunTerminal)).toBeNull();
  });

  test("已批准版本 → approved（优先级最高，不看 run 状态）", () => {
    expect(deriveReadonlyReason("approved", "running", isRunTerminal)).toBe("approved");
    expect(deriveReadonlyReason("approved", null, isRunTerminal)).toBe("approved");
    expect(deriveReadonlyReason("approved", "succeeded", isRunTerminal)).toBe("approved");
  });

  test("候选版本 + run 运行中（非终态）→ agent-running", () => {
    expect(deriveReadonlyReason("candidate", "running", isRunTerminal)).toBe("agent-running");
    expect(deriveReadonlyReason("in_review", "awaiting_approval", isRunTerminal)).toBe("agent-running");
  });

  test("候选版本 + run 已到终态 → 可编辑（null）", () => {
    expect(deriveReadonlyReason("candidate", "succeeded", isRunTerminal)).toBeNull();
    expect(deriveReadonlyReason("candidate", "failed", isRunTerminal)).toBeNull();
    expect(deriveReadonlyReason("candidate", "fail_closed", isRunTerminal)).toBeNull();
    expect(deriveReadonlyReason("candidate", "interrupted", isRunTerminal)).toBeNull();
  });

  test("候选版本 + 项目尚无 run（runStatus=null）→ 可编辑（null）", () => {
    expect(deriveReadonlyReason("candidate", null, isRunTerminal)).toBeNull();
  });

  test("rejected/superseded/invalidated 等非 approved 状态一律走候选分支的判定规则", () => {
    expect(deriveReadonlyReason("rejected", "running", isRunTerminal)).toBe("agent-running");
    expect(deriveReadonlyReason("superseded", "succeeded", isRunTerminal)).toBeNull();
    expect(deriveReadonlyReason("invalidated", "running", isRunTerminal)).toBe("agent-running");
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
