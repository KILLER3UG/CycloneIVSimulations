import { describe, it, expect } from "vitest";
import { buildVcd } from "./vcdExport.js";

const signals = [
    { name: "clk", width: 1, type: "reg" },
    { name: "led", width: 4, type: "reg" },
];
const cycles = [
    { time: 0, values: { clk: 0, led: 0b0000 } },
    { time: 20, values: { clk: 1, led: 0b1010 } },
    { time: 40, values: { clk: 0, led: 0b1010 } },
];

describe("buildVcd", () => {
    it("emits a standard header and per-cycle changes", () => {
        const vcd = buildVcd(signals, cycles, { timescaleNs: 20, durationNs: 40 });
        expect(vcd).toContain("`timescale 1 ns");
        expect(vcd).toContain("$var reg 1");
        expect(vcd).toContain("$var reg 4");
        expect(vcd).toContain("$enddefinitions $end");
        expect(vcd).toContain("#0");
        expect(vcd).toContain("#20");
        expect(vcd).toContain("b1010");
    });

    it("only emits changed values", () => {
        const vcd = buildVcd(signals, cycles);
        const ledChanges = vcd.split("\n").filter((l) => l.startsWith("b1010"));
        expect(ledChanges.length).toBe(1);
    });

    it("handles empty input", () => {
        const vcd = buildVcd([], []);
        expect(vcd).toContain("$enddefinitions $end");
        expect(vcd).toContain("#0");
    });

    it("formats X/Z and vector widths", () => {
        const vcd = buildVcd(
            [{ name: "s", width: 4, type: "wire" }],
            [{ time: 0, values: { s: "XZ" } }],
        );
        expect(vcd).toContain("b00XZ");
    });
});