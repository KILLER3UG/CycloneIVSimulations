// Unit tests for the pure layout data + pin index (no three.js involved).
import { describe, it, expect } from "vitest";
import { PCB_OUTLINE, LAYOUT, buildPinIndex, parseHeaderNote, SEG_GLYPHS } from "./layout.js";

const profile = {
    pinMap: {
        "LED[0]": ["PIN_87"],
        "LED[1]": ["PIN_86"],
        "KEY[0]": ["PIN_88"],
        "SEG[0]": ["PIN_128"],
        "SEG[1]": ["PIN_121"],
        "DIG[0]": ["PIN_133"],
        "DIG[3]": ["PIN_137"],
        FPGA_BUZZER: ["PIN_110"],
        SDRAM_DQ: ["PIN_28"],
    },
    board: {
        leds: { pins: ["PIN_87", "PIN_86", "PIN_85", "PIN_84"], activeLow: true },
        buttons: { pins: ["PIN_88", "PIN_89", "PIN_90", "PIN_91"], activeLow: true },
        switches: { pins: ["PIN_88", "PIN_89", "PIN_90", "PIN_91"], activeLow: true },
        displays: {
            pins: {
                SEG: ["PIN_128", "PIN_121", "PIN_125", "PIN_129", "PIN_132", "PIN_126", "PIN_124", "PIN_127"],
                DIG: ["PIN_133", "PIN_135", "PIN_136", "PIN_137"],
            },
            segmentActiveLow: true,
            digitActiveLow: true,
            segBitMap: { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, dp: 7 },
        },
        buzzer: { pin: "PIN_110", activeLow: true },
        headers: {
            P1: { note: "header pins 1/2 = GND; 3=BEEP(110), 4=111, 5=SCL(112), 35/36=3.3 V, 37/38=5 V" },
        },
        config: { jtag: "TCK TDO TMS TDI", as: "DCLK CONF_DONE nCONFIG" },
    },
};

describe("LAYOUT", () => {
    it("has the 58 parts.md rows", () => {
        expect(LAYOUT).toHaveLength(58);
    });

    it("keeps the PCB outline at 136 × 106 mm", () => {
        expect(PCB_OUTLINE.w).toBe(136);
        expect(PCB_OUTLINE.d).toBe(106);
    });

    it("positions match parts.md (spot checks)", () => {
        const fpga = LAYOUT.find((r) => r.id === "U5");
        expect(fpga.pos).toEqual([49, 57]);
        expect(fpga.body).toEqual([22, 22]);
        const p2 = LAYOUT.find((r) => r.id === "P2");
        expect(p2.size).toEqual([55.9, 5.8]);
        expect(p2.cols).toBe(22);
        const vga = LAYOUT.find((r) => r.id === "VGA");
        expect(vga.pos).toEqual([129, 85]);
    });
});

describe("parseHeaderNote", () => {
    it("parses slot assignments: rails, named pins, bare pins", () => {
        const out = parseHeaderNote("header pins 1/2 = GND; 3=BEEP(110), 4=111, 5=SCL(112), 6/7=3.3 V");
        expect(out[0]).toMatchObject({ slot: 1, rail: "GND" });
        expect(out[1]).toMatchObject({ slot: 2, rail: "GND" });
        expect(out[2]).toMatchObject({ slot: 3, label: "BEEP", pins: [110] });
        expect(out[3]).toMatchObject({ slot: 4, label: "111", pins: [111] });
        expect(out[4]).toMatchObject({ slot: 5, label: "SCL", pins: [112] });
        expect(out[5]).toMatchObject({ slot: 6, rail: "3V3" });
        expect(out[6]).toMatchObject({ slot: 7, rail: "3V3" });
    });

    it("expands slot ranges with name lists and pin lists", () => {
        const out = parseHeaderNote("11-18=SEG1/6/2/5/7/0/3/4 (121,124,125,126,127,128,129,132), 19-22=DIG1-4 (133,135,136,137)");
        expect(out).toHaveLength(12);
        expect(out[0]).toMatchObject({ slot: 11, label: "SEG1", pins: [121] });
        expect(out[5]).toMatchObject({ slot: 16, label: "SEG0", pins: [128] });
        expect(out[8]).toMatchObject({ slot: 19, label: "DIG1", pins: [133] });
        expect(out[11]).toMatchObject({ slot: 22, label: "DIG4", pins: [137] });
    });

    it("expands SDRAM breakout groups with dotted ranges", () => {
        const out = parseHeaderNote("pins 7-42 = SDRAM breakout (A 76,77; BS 73,74; DQ 28,30..32)");
        expect(out[0]).toMatchObject({ slot: 7, label: "A0", pins: [76] });
        expect(out[2]).toMatchObject({ slot: 9, label: "BS0", pins: [73] });
        expect(out[4]).toMatchObject({ slot: 11, label: "DQ0", pins: [28] });
        expect(out[6]).toMatchObject({ slot: 13, label: "DQ2", pins: [31] });
    });
});

describe("buildPinIndex", () => {
    const idx = buildPinIndex(profile);

    it("maps LED pins with active-low polarity", () => {
        const e = idx.index.get("PIN_87");
        expect(e.componentId).toBe("LED1");
        expect(e.kind).toBe("led");
        expect(e.polarity).toBe("active-low");
    });

    it("maps SEG/DIG pins to the display with bit indices", () => {
        expect(idx.index.get("PIN_121")).toMatchObject({ componentId: "DISP1", kind: "segment", elementIndex: 1 });
        expect(idx.index.get("PIN_137")).toMatchObject({ componentId: "DISP1", kind: "digit", elementIndex: 3 });
    });

    it("records shared KEY/DIP nets on pins 88-91", () => {
        const e = idx.index.get("PIN_88");
        expect(e.kind).toBe("button");
        expect(e.shared).toHaveLength(2); // button + switch on the same net
    });

    it("maps the buzzer", () => {
        expect(idx.index.get("PIN_110")).toMatchObject({ componentId: "SP1", kind: "buzzer", polarity: "active-low" });
    });

    it("labels header slots from the profile note", () => {
        const p1 = idx.headerLayouts.P1;
        expect(p1.entries).toHaveLength(38);
        expect(p1.entries[0]).toMatchObject({ rail: "GND" }); // pins 1/2 = GND
        expect(p1.entries[2]).toMatchObject({ label: "BEEP", pinId: "PIN_110" });
        expect(p1.entries[3]).toMatchObject({ pinId: "PIN_111" }); // bare GPIO → number label
        expect(p1.entries[3].label).toBe("111");
        expect(p1.entries[34]).toMatchObject({ rail: "3V3" }); // 35/36 = 3.3 V
        expect(p1.entries[36]).toMatchObject({ rail: "5V" }); // 37/38 = 5 V
    });

    it("falls back to an empty index without a profile", () => {
        const empty = buildPinIndex(null);
        expect(empty.index.size).toBe(0);
        expect(empty.headerLayouts.P1.entries).toHaveLength(38);
    });
});

describe("SEG_GLYPHS", () => {
    it("covers the demo digits", () => {
        expect(SEG_GLYPHS["0"]).toBe("abcdef");
        expect(SEG_GLYPHS["8"]).toBe("abcdefg");
    });
});
