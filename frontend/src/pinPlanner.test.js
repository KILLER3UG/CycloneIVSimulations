import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    buildPinCatalog,
    expandEntityNodes,
    exportPlannerToQsf,
    normalizePin,
    parseEntitiesWithPorts,
    parseQsfToPlanner,
    suggestBoardDefaults,
    validateAssignments,
} from "./pinPlanner.js";

const boardProfile = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../board/board.json"), "utf8"),
);

describe("pinPlanner", () => {
    it("expands VHDL [3:0] downto and [1:4] to ranges per bit", () => {
        const vhdl = `
library IEEE;
use IEEE.STD_LOGIC_1164.ALL;
entity demo is
    port (
        clk  : in  std_logic;
        led  : out std_logic_vector(3 downto 0);
        busA : in  std_logic_vector(1 to 4);
        revB : out std_logic_vector(4 downto 1)
    );
end entity demo;`;
        const [ent] = parseEntitiesWithPorts(vhdl, "demo.vhd");
        expect(ent.name).toBe("demo");

        const nodes = expandEntityNodes(ent);
        expect(nodes.map((n) => n.nodeName)).toEqual([
            "clk",
            "led[3]", "led[2]", "led[1]", "led[0]",
            "busA[1]", "busA[2]", "busA[3]", "busA[4]",
            "revB[4]", "revB[3]", "revB[2]", "revB[1]",
        ]);

        const led0 = nodes.find((n) => n.nodeName === "led[0]");
        const led3 = nodes.find((n) => n.nodeName === "led[3]");
        expect(led0.bitOffset).toBe(0);
        expect(led3.bitOffset).toBe(3);

        const rev4 = nodes.find((n) => n.nodeName === "revB[4]");
        const rev1 = nodes.find((n) => n.nodeName === "revB[1]");
        expect(rev1.bitOffset).toBe(0);
        expect(rev4.bitOffset).toBe(3);
        expect(rev1.direction).toBe("output");
    });

    it("parses Verilog ANSI and non-ANSI module ports and expands bit ranges", () => {
        const verilog = `
module blink_v (
    input wire clk,
    input wire [3:0] sw,
    output reg [3:0] led,
    output wire [6:0] seven_seg
);
endmodule`;
        const [ent] = parseEntitiesWithPorts(verilog, "blink_v.v");
        expect(ent.name).toBe("blink_v");
        const nodes = expandEntityNodes(ent);
        expect(nodes.filter((n) => n.portName === "sw").map((n) => n.nodeName)).toEqual([
            "sw[3]", "sw[2]", "sw[1]", "sw[0]",
        ]);
        expect(nodes.filter((n) => n.portName === "seven_seg")).toHaveLength(7);

        const nonAnsi = `
module legacy_v(a, b, y);
    input a;
    input [4:1] b;
    output y;
endmodule`;
        const [ent2] = parseEntitiesWithPorts(nonAnsi, "legacy_v.v");
        const nodes2 = expandEntityNodes(ent2);
        expect(nodes2.map((n) => n.nodeName)).toEqual([
            "a", "b[4]", "b[3]", "b[2]", "b[1]", "y",
        ]);
    });

    it("suggestBoardDefaults leaves existing pins intact and fills known trainer ports", () => {
        const [ent] = parseEntitiesWithPorts(`
module top(
    input clk,
    input s1,
    input s2,
    output [3:0] led
);
endmodule`, "top.v");
        const nodes = expandEntityNodes(ent);
        const existing = { "led[0]": { location: "PIN_10", ioStandard: "3.3-V LVTTL" } };
        const suggested = suggestBoardDefaults(nodes, boardProfile, existing);

        expect(suggested.clk.location).toBe("PIN_23");
        expect(suggested.s1.location).toBe("PIN_88");
        expect(suggested.s2.location).toBe("PIN_89");
        expect(suggested["led[0]"].location).toBe("PIN_10");
        expect(suggested["led[1]"].location).toBe("PIN_86");
        expect(suggested["led[2]"].location).toBe("PIN_85");
        expect(suggested["led[3]"].location).toBe("PIN_84");
    });

    it("validates unassigned warnings, duplicate pins, nonexistent pins, and direction conflicts", () => {
        const catalog = buildPinCatalog(boardProfile);
        const [ent] = parseEntitiesWithPorts(`
module check(
    input clk,
    input k1,
    input bad_in,
    output led1,
    output led2,
    output bad_out
);
endmodule`, "check.v");
        const nodes = expandEntityNodes(ent);
        // k1 left unassigned -> warning
        const assignments = {
            clk: { location: "PIN_87", ioStandard: "3.3-V LVTTL" }, // direction conflict: input -> LED output pin
            bad_in: { location: "PIN_999", ioStandard: "3.3-V LVTTL" }, // nonexistent pin
            led1: { location: "PIN_86", ioStandard: "3.3-V LVTTL" },
            led2: { location: "PIN_86", ioStandard: "3.3-V LVTTL" }, // duplicate PIN_86
            bad_out: { location: "PIN_88", ioStandard: "3.3-V LVTTL" }, // direction conflict: output -> KEY input pin
        };
        const res = validateAssignments(nodes, assignments, catalog);
        expect(res.unassignedCount).toBe(1);
        expect(res.warnings).toHaveLength(1);
        expect(res.warnings[0].message).toMatch(/k1.*unassigned|Unassigned port 'k1'/i);

        expect(res.errors).toHaveLength(4);
        const msgs = res.errors.map((e) => e.message).join("\n");
        expect(msgs).toMatch(/Direction conflict.*clk/);
        expect(msgs).toMatch(/Nonexistent pin 'PIN_999'.*bad_in/);
        expect(msgs).toMatch(/Duplicate pin conflict.*PIN_86.*led1.*led2/);
        expect(msgs).toMatch(/Direction conflict.*bad_out/);
    });

    it("round-trips pin assignments cleanly through QSF export and import", () => {
        const [ent] = parseEntitiesWithPorts(`
entity rt is
    port (
        clk : in std_logic;
        sw  : in std_logic_vector(1 downto 0);
        led : out std_logic_vector(1 downto 0)
    );
end entity rt;`, "rt.vhd");
        const nodes = expandEntityNodes(ent);
        const original = {
            clk: { location: "PIN_23", ioStandard: "3.3-V LVTTL" },
            "sw[0]": { location: "PIN_88", ioStandard: "3.3-V LVCMOS" },
            "led[1]": { location: "PIN_85", ioStandard: "3.3-V LVTTL" },
            "led[0]": { location: "", ioStandard: "3.3-V LVTTL" },
        };
        const qsf = exportPlannerToQsf("rt", nodes, original, "EP4CE6E22C8");
        expect(qsf).toContain("set_global_assignment -name TOP_LEVEL_ENTITY rt");
        expect(qsf).toContain("set_location_assignment PIN_23 -to clk");
        expect(qsf).toContain("set_location_assignment PIN_88 -to sw[0]");
        expect(qsf).toContain("set_location_assignment PIN_85 -to led[1]");
        expect(qsf).not.toContain("-to led[0]");

        const reimported = parseQsfToPlanner(qsf, nodes);
        expect(reimported.clk).toEqual({ location: "PIN_23", ioStandard: "3.3-V LVTTL" });
        expect(reimported["sw[0]"]).toEqual({ location: "PIN_88", ioStandard: "3.3-V LVCMOS" });
        expect(reimported["led[1]"]).toEqual({ location: "PIN_85", ioStandard: "3.3-V LVTTL" });
        expect(reimported["sw[1]"]).toBeUndefined();
        expect(normalizePin("87")).toBe("PIN_87");
    });
});
