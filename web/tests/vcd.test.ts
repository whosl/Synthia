import { describe, expect, test } from "bun:test";
import { changeIndex, parseVcd, signalValue, MAX_VCD_BYTES, MAX_VCD_SIGNALS } from "../src/domain/vcd.ts";
const header = `$timescale 10 ps $end
$scope module tb $end
$var wire 1 ! clk $end
$var wire 8 # data [7:0] $end
$scope module dut $end
$var wire 1 ! clock_alias $end
$upscope $end
$upscope $end
$enddefinitions $end
`;
const fixture = header + `$dumpvars\n0!\nbx #\n$end\n#5\n1!\nb101 #\n#10\n0!\nbz #\n#15\n1!\n`;
describe("VCD waveform values", () => {
  test("hierarchy, alias identifiers, timescale and initial values", () => {
    const v = parseVcd(fixture);
    expect(v.timescale).toBe(10); expect(v.unit).toBe("ps"); expect(v.endTime).toBe(15);
    expect(v.signals.map((s) => s.name)).toEqual(["tb.clk", "tb.data[7:0]", "tb.dut.clock_alias"]);
    expect(v.signals[0]!.changes).toBe(v.signals[2]!.changes);
    expect(signalValue(v.signals[1]!, 0, "hex")).toBe("xxxxxxxx");
    expect(signalValue(v.signals[1]!, 5, "bin")).toBe("00000101");
    expect(signalValue(v.signals[1]!, 5, "dec")).toBe("5");
    expect(signalValue(v.signals[1]!, 10, "hex")).toBe("zzzzzzzz");
  });
  test("cursor boundaries, same-time updates and wide buses retain exact values", () => {
    const v = parseVcd(header + "#3\n0!\n1!\n#5\n0!\n");
    expect(signalValue(v.signals[0]!, 2, "bin")).toBe("—");
    expect(signalValue(v.signals[0]!, 3, "bin")).toBe("1");
    expect(changeIndex(v.signals[0]!.changes, 4)).toBe(0);
    expect(changeIndex(v.signals[0]!.changes, 5)).toBe(1);
    const wide = parseVcd(`$var wire 64 ! bus $end $enddefinitions $end b${"1".repeat(64)} ! #1`);
    expect(signalValue(wide.signals[0]!, 0, "hex")).toBe("FFFFFFFFFFFFFFFF");
    expect(signalValue(wide.signals[0]!, 0, "dec")).toBe("18446744073709551615");
  });
  test("capture limit does not extend recorded values to later timestamps", () => {
    const v = parseVcd(fixture + "$comment VCD file size limit reached $end #1000");
    expect(v.endTime).toBe(15); expect(v.warnings[0]).toContain("大小上限");
  });
  test("malformed, partial, backwards and unsafe timestamps fail explicitly", () => {
    for (const body of ["garbage", header, header + "b101", header + "0missing", header + "#4 0! #3", header + "#9007199254740992 0!", "$timescale 1ns", "a".repeat(MAX_VCD_BYTES + 1)]) {
      expect(() => parseVcd(body)).toThrow();
    }
  });
  test("real values and absent timescale are explicit", () => {
    const v = parseVcd("$var real 64 ! temp $end $enddefinitions $end r-1.25 ! #5 r2.5 !");
    expect(signalValue(v.signals[0]!, 0, "hex")).toBe("-1.25");
    expect(v.unit).toBe("tick"); expect(v.warnings.length).toBe(1);
  });
  test("XSim zero-width parameters infer width without dropping digital traces", () => {
    const v = parseVcd(`$timescale 1ps $end
$var reg 1 ! clk $end
$var parameter 0 a! PIXDIV $end
$var parameter 0 b! FIFO_AW $end
$enddefinitions $end
0! b100 a! b100 b! #5 1!`);
    expect(v.signals.map(s => s.width)).toEqual([1, 3, 3]);
    expect(signalValue(v.signals[1]!, 0, "dec")).toBe("4");
    expect(v.signals[0]!.changes.length).toBe(2);
    expect(() => parseVcd("$var wire 0 ! invalid $end $enddefinitions $end 0!")).toThrow();
    expect(() => parseVcd(`$var parameter 0 ! p $end $enddefinitions $end b${"1".repeat(4097)} !`)).toThrow("4096");
  });
  test("bounded parsing previews excessive changes and rejects excessive declarations", () => {
    const limited = parseVcd(header + "0!\n" + "#1\n1!\n#2\n" + "0!\n".repeat(500001) + "#100 1!");
    expect(limited.endTime).toBe(1);
    expect(limited.warnings.some(w => w.includes("50 万"))).toBe(true);
    expect(limited.signals[0]!.changes).toEqual([{ time: 0, value: "0" }, { time: 1, value: "1" }]);
    expect(() => parseVcd("$var wire 1 ! clk $end\n".repeat(MAX_VCD_SIGNALS + 1))).toThrow(String(MAX_VCD_SIGNALS));
  });
  test("large designs retain every signal and aliases beyond the old declaration limit", () => {
    const declarations = Array.from({ length: 20_000 }, (_, i) => `$var wire 1 s${i} signal_${i} $end`).join("\n");
    const values = Array.from({ length: 20_000 }, (_, i) => `0s${i}`).join("\n");
    const v = parseVcd(`$timescale 1ps $end\n${declarations}\n$var wire 1 s19999 last_alias $end\n$enddefinitions $end\n${values}\n#5\n1s19999`);
    expect(v.signals).toHaveLength(20_001);
    expect(signalValue(v.signals[19_999]!, 0, "bin")).toBe("0");
    expect(signalValue(v.signals[19_999]!, 5, "bin")).toBe("1");
    expect(v.signals[20_000]!.changes).toBe(v.signals[19_999]!.changes);
    expect(v.endTime).toBe(5);
  });
});
