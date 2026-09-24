import { describe, expect, test } from "bun:test";
import { changeIndex, parseVcd, signalValue, MAX_VCD_BYTES } from "../src/domain/vcd.ts";
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
  test("bounded parsing rejects excessive changes and signal declarations", () => {
    expect(() => parseVcd(header + "0!\n".repeat(500001))).toThrow("50 万");
    expect(() => parseVcd("$var wire 1 ! clk $end\n".repeat(4097))).toThrow("4096");
  });
});
