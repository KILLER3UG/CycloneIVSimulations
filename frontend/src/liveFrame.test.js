import { describe, it, expect } from "vitest";
import {
    frameToBoardState,
    ledPerceivedDuty,
    classifyValue,
    buildRoutes,
} from "./liveFrame.js";

describe("ledPerceivedDuty", () => {
    it("maps 0 -> 0 and 1 -> 1", () => {
        expect(ledPerceivedDuty(0)).toBe(0);
        expect(ledPerceivedDuty(1)).toBe(1);
    });
    it("keeps mid duties clearly visible (perceptual power law)", () => {
        const quarter = ledPerceivedDuty(0.25);
        expect(quarter).toBeGreaterThan(0.4);
        expect(quarter).toBeLessThan(0.7);
        expect(ledPerceivedDuty(0.5)).toBeGreaterThan(ledPerceivedDuty(0.25));
    });
});

describe("classifyValue", () => {
    it("expands integer values into bits", () => {
        const c = classifyValue(5, 4);
        expect(c.kind).toBe("bits");
        expect(c.bits).toEqual([1, 0, 1, 0]);
        expect(c.meta).toBeNull();
    });
    it("keeps meta characters per bit", () => {
        const c = classifyValue("U01Z", 4);
        expect(c.kind).toBe("meta");
        expect(c.meta).toEqual(["U", "0", "1", "Z"]);
    });
});

describe("frameToBoardState", () => {
    const routes = {
        leds: [
            { port: "LED", bit: 0, index: 0 },
            { port: "LED", bit: 1, index: 1 },
        ],
        segments: [
            { port: "SEG", bit: 0, cell: 0 },
            { port: "SEG", bit: 1, cell: 1 },
        ],
        digits: [{ port: "DIG", bit: 0, index: 0 }],
        buzzer: { port: "BEEP", bit: 0 },
    };

    it("converts duty permille into perceptual LED brightness", () => {
        const frame = {
            values: { LED: 1 },
            duty: { LED: [1000, 250] },
            cycles: 10,
            timeNs: 100,
            buzzer: { toggles: 0, activeCycles: 0 },
        };
        const s = frameToBoardState(frame, routes);
        expect(s.leds[0].duty).toBe(1);
        expect(s.leds[1].duty).toBeCloseTo(Math.pow(0.25, 0.45), 5);
        expect(s.leds[0].meta).toBeNull();
    });

    it("flags U/X/Z outputs as meta and never lights them", () => {
        const frame = {
            values: { LED: "UX" },
            duty: { LED: [500, 500] },
            cycles: 10,
            buzzer: { toggles: 0, activeCycles: 0 },
        };
        const s = frameToBoardState(frame, routes);
        expect(s.leds[0].meta).toBe("U");
        expect(s.leds[0].duty).toBe(0);
        expect(s.leds[1].meta).toBe("X");
        expect(s.metas).toEqual([
            { port: "LED", bit: 0, char: "U" },
            { port: "LED", bit: 1, char: "X" },
        ]);
    });

    it("computes 7-seg coincidence duty per (digit, segment) cell", () => {
        const frame = {
            values: { SEG: 3, DIG: 1 },
            duty: { SEG: [1000, 1000, 500], DIG: [250] },
            coin: [250, 250, 125],   // exact DIG×SEG coincidence from VHDL
            cycles: 10,
            buzzer: { toggles: 0, activeCycles: 0 },
        };
        const s = frameToBoardState(frame, routes, { digits: 1, segments: 3 });
        expect(s.segments[0]).toBe(0.25);
        expect(s.segments[1]).toBe(0.25);
        expect(s.segments[2]).toBe(0.125);
    });

    it("falls back to min(seg, dig) when no coincidence array exists", () => {
        const frame = {
            values: { SEG: 3, DIG: 1 },
            duty: { SEG: [1000, 1000, 500], DIG: [250] },
            cycles: 10,
            buzzer: { toggles: 0, activeCycles: 0 },
        };
        const s = frameToBoardState(frame, routes, { digits: 1, segments: 3 });
        expect(s.segments[0]).toBe(0.25);
        expect(s.segments[2]).toBe(0.25);
    });

    it("derives buzzer tone frequency from toggle counts", () => {
        const frame = {
            values: { BEEP: 0 },
            duty: { BEEP: [500] },
            cycles: 100,
            buzzer: { toggles: 100, activeCycles: 50 },
        };
        const s = frameToBoardState(frame, routes, { clockPeriodNs: 10 });
        expect(s.buzzer.mode).toBe("tone");
        // 100 toggles / (2 * 100 cycles * 10 ns) = 50 MHz
        expect(s.buzzer.freq).toBeCloseTo(50e6, -3);
    });

    it("reports DC drive for a steady active level with no toggles", () => {
        const frame = {
            values: { BEEP: 0 },
            duty: { BEEP: [1000] },
            cycles: 50,
            buzzer: { toggles: 0, activeCycles: 50 },
        };
        const s = frameToBoardState(frame, routes, { clockPeriodNs: 10 });
        expect(s.buzzer.mode).toBe("dc");
        expect(s.buzzer.duty).toBe(1);
    });

    it("turns the buzzer off when the pin is idle", () => {
        const frame = {
            values: { BEEP: 1 },
            duty: { BEEP: [0] },
            cycles: 50,
            buzzer: { toggles: 0, activeCycles: 0 },
        };
        const s = frameToBoardState(frame, routes, { clockPeriodNs: 10 });
        expect(s.buzzer.mode).toBe("off");
    });
});

describe("buildRoutes", () => {
    it("maps board pins to element routes through the pin index", () => {
        const pinIndex = {
            index: new Map([
                ["PIN_87", { kind: "led", elementIndex: 0 }],
                ["PIN_128", { kind: "segment", elementIndex: 0 }],
                ["PIN_133", { kind: "digit", elementIndex: 0 }],
                ["PIN_110", { kind: "buzzer", elementIndex: 0 }],
            ]),
        };
        const boardMap = {
            leds: [], segments: [], digits: [],
            pins: {
                LED: ["PIN_87"],
                SEG: ["PIN_128"],
                DIG: ["PIN_133"],
                BEEP: ["PIN_110"],
            },
        };
        const r = buildRoutes(pinIndex, boardMap);
        expect(r.leds).toEqual([{ port: "LED", bit: 0, index: 0 }]);
        expect(r.segments).toEqual([{ port: "SEG", bit: 0, cell: 0 }]);
        expect(r.digits).toEqual([{ port: "DIG", bit: 0, index: 0 }]);
        expect(r.buzzer).toEqual({ port: "BEEP", bit: 0 });
    });
});
