/**
 * 顶栏「运行校验/仿真/…」参数推导测试（domain/impl-run.ts）：
 * 源/约束分类、tb 目录启发式、悬空模块选顶层/testbench、失败人话。
 */
import { describe, expect, test } from "bun:test";
import { deriveJobInputs, moduleNames, operationNeeds } from "../src/domain/impl-run.ts";
import type { WorkspaceRunFile } from "../src/domain/impl-run.ts";

const DESIGN_A = `// 顶层设计 A
module calc_top (input clk, output [7:0] q);
  calc_alu u_alu (.clk(clk), .q(q));
endmodule`;

const DESIGN_B = `module calc_alu (input clk, output [7:0] q);
  assign q = 8'h00;
endmodule`;

const TB = `module tb_calc_top;
  reg clk = 0;
  wire [7:0] q;
  calc_top dut (.clk(clk), .q(q));
  calc_ref u_ref (.q(q));
endmodule`;

const TB_HELPER = `module calc_ref (output [7:0] q);
  assign q = 8'hff;
endmodule`;

function filesOf(...paths: string[]): WorkspaceRunFile[] {
  return paths.map(path => ({ path }));
}

function loader(sources: Record<string, string>) {
  return async (path: string) => {
    const content = sources[path];
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  };
}

const BENCH = loader({
  "rtl/calc_top.v": DESIGN_A,
  "rtl/calc_alu.v": DESIGN_B,
  "tb/tb_calc_top.v": TB,
  "tb/calc_ref.v": TB_HELPER,
  "prj/constr/top.xdc": "create_clock -period 10 [get_ports clk]",
  "doc/readme.md": "# 说明文档，不进作业",
});

describe("moduleNames", () => {
  test("剥注释与字符串后取声明；endmodule 不误报", () => {
    const text = `// module fake_in_comment\n/* module also_fake */\nmodule real_one; endmodule\nreg [7:0] x = "module in_string";`;
    expect(moduleNames(text)).toEqual(["real_one"]);
  });
});

describe("deriveJobInputs", () => {
  test("validate：源清单 + xdc，不含 md，不推模块名", async () => {
    const result = await deriveJobInputs(filesOf("rtl/calc_top.v", "rtl/calc_alu.v", "tb/tb_calc_top.v", "prj/constr/top.xdc", "doc/readme.md"), BENCH, {});
    if (!result.ok) throw new Error(`应当成功：${result.reason}`);
    expect(result.sources.map(s => s.path)).toEqual(["rtl/calc_top.v", "rtl/calc_alu.v", "tb/tb_calc_top.v"]);
    expect(result.constraints.map(c => c.path)).toEqual(["prj/constr/top.xdc"]);
    expect(result.top).toBeNull();
    expect(result.testbench).toBeNull();
  });

  test("synthesize：悬空模块当选设计顶层；xdc 进 constraints", async () => {
    const result = await deriveJobInputs(filesOf("rtl/calc_top.v", "rtl/calc_alu.v", "tb/tb_calc_top.v", "tb/calc_ref.v", "prj/constr/top.xdc"), BENCH, { deriveTop: true });
    if (!result.ok) throw new Error(`应当成功：${result.reason}`);
    expect(result.top).toBe("calc_top"); // calc_alu 被例化，tb 例化的 calc_top 不影响悬空判定
    expect(result.constraints.map(c => c.path)).toEqual(["prj/constr/top.xdc"]);
    expect(result.testbench).toBeNull();
  });

  test("simulate：tb 目录悬空模块当 testbench（例化掉的 helper 不参选）", async () => {
    const result = await deriveJobInputs(
      filesOf("rtl/calc_top.v", "rtl/calc_alu.v", "tb/tb_calc_top.v", "tb/calc_ref.v"),
      BENCH,
      { deriveTop: true, deriveTb: true },
    );
    if (!result.ok) throw new Error(`应当成功：${result.reason}`);
    expect(result.top).toBe("calc_top");
    expect(result.testbench).toBe("tb_calc_top");
  });

  test("工作区没有 RTL → 人话失败", async () => {
    const result = await deriveJobInputs(filesOf("doc/readme.md"), BENCH, {});
    expect(result).toEqual({ ok: false, reason: "工作区里没有 .v/.sv 源文件，无可运行内容" });
  });

  test("顶层不唯一 → 列出候选", async () => {
    const sources = loader({
      "rtl/a.v": "module alpha; endmodule",
      "rtl/b.v": "module beta; endmodule",
    });
    const result = await deriveJobInputs(filesOf("rtl/a.v", "rtl/b.v"), sources, { deriveTop: true });
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.reason).toContain("顶层模块不唯一（alpha、beta）");
  });

  test("tb 缺失 / tb 顶层不唯一 → 对应失败", async () => {
    const noTb = await deriveJobInputs(filesOf("rtl/calc_top.v", "rtl/calc_alu.v"), BENCH, { deriveTop: true, deriveTb: true });
    expect(noTb).toEqual({ ok: false, reason: "工作区里没有 testbench（应放在 tb/、test/ 等目录）" });

    const twoTops = loader({
      "rtl/top.v": "module top; endmodule",
      "tb/t1.v": "module t1; top u1(); endmodule",
      "tb/t2.v": "module t2; top u2(); endmodule",
    });
    const ambiguous = await deriveJobInputs(filesOf("rtl/top.v", "tb/t1.v", "tb/t2.v"), twoTops, { deriveTop: true, deriveTb: true });
    expect(ambiguous.ok).toBeFalse();
    if (!ambiguous.ok) expect(ambiguous.reason).toContain("testbench 顶层不唯一（t1、t2）");
  });

  test("读取文件失败 → 失败并携带路径", async () => {
    const result = await deriveJobInputs(filesOf("rtl/gone.v"), BENCH, {});
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.reason).toContain("读取源文件失败");
  });
});

describe("operationNeeds", () => {
  test("各操作对 top/tb 的依赖", () => {
    expect(operationNeeds("validate_sources")).toEqual({ top: false, tb: false });
    expect(operationNeeds("simulate")).toEqual({ top: true, tb: true });
    expect(operationNeeds("synthesize")).toEqual({ top: true, tb: false });
    expect(operationNeeds("implement")).toEqual({ top: true, tb: false });
    expect(operationNeeds("report_sta")).toEqual({ top: true, tb: false });
  });
});
