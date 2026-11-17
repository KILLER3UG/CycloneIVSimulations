import { describe, it, expect } from "vitest";
import {
    detectDownCounter,
    measureBuzzer,
    noteSeconds,
} from "./buzzerModel.js";

describe("measureBuzzer", () => {
    it("measures the buzz1 800 Hz half period in simulated 50 MHz cycles", () => {
        // 31,250 cycles half period at 20 ns = 625,000 ns; full period 1.25 ms.
        const edges = [
            [0, 1],
            [625_000, 0],
            [1_250_000, 1],
            [1_875_000, 0],
            [2_500_000, 1],
        ];
        const m = measureBuzzer(edges, 20, true);
        expect(m.tone).toBe(true);
        expect(m.frequency).toBe(800);
        expect(m.cyclesPerPeriod).toBe(62_500);
        expect(m.duty).toBeCloseTo(0.5, 3);
    });

    it("is silent for a steady HIGH (transistor off)", () => {
        expect(measureBuzzer([[0, 1]], 20, true).tone).toBe(false);
        expect(measureBuzzer([[0, 1], [1_000_000, 1]], 20, true).tone).toBe(false);
    });

    it("is silent for a steady LOW (passive speaker, no oscillator)", () => {
        expect(measureBuzzer([[0, 0], [1_000_000, 0]], 20, true).tone).toBe(false);
    });

    it("ignores out-of-range frequencies", () => {
        // 10 Hz: 50 ms half period
        expect(measureBuzzer([[0, 1], [50_000_000, 0], [100_000_000, 1]], 20, true).tone).toBe(false);
    });
});

describe("detectDownCounter", () => {
    it("finds a down-counter by slope, regardless of signal name", () => {
        const cycles = [];
        for (let i = 0; i < 5; i += 1) {
            cycles.push({ cycle: i, time: i * 20, values: { clk: i & 1, cnt_delay: 100 - i, gate_en: 1 } });
        }
        const found = detectDownCounter(cycles, 10);
        expect(found?.name).toBe("cnt_delay");
        expect(found?.terminal).toBe(100);
        expect(found?.step).toBe(1);
        expect(found?.terminal).toBe(100);
        expect(found?.cycles).toBe(101); // 100 decrements + the load cycle
        expect(noteSeconds(found, 20)).toBeCloseTo(0.00000202, 9);
    });

    it("handles a 25M-cycle 0.5 s countdown with arbitrary names", () => {
        const cycles = [];
        for (let i = 0; i < 4; i += 1) {
            cycles.push({ cycle: i, time: i * 20, values: { tone_acc: 31249 - i, cnt_delay: 25_000_000 - i } });
        }
        const found = detectDownCounter(cycles, 1000);
        expect(found?.name).toBe("cnt_delay");
        expect(found?.cycles).toBe(25_000_001); // load + 25M decrements
        expect(noteSeconds(found, 20)).toBeCloseTo(0.50000002, 9);
    });

    it("measures the decrement step (a /2 counter has half the cycles)", () => {
        const cycles = [];
        for (let i = 0; i < 5; i += 1) {
            cycles.push({ cycle: i, time: i * 20, values: { div2: 1000 - i * 2 } });
        }
        const found = detectDownCounter(cycles, 10);
        expect(found?.step).toBe(2);
        expect(found?.cycles).toBe(501); // 500 decrements + load
        expect(noteSeconds(found, 20)).toBeCloseTo(0.00001002, 9);
    });

    it("detects hold_window (no cnt/count substring) with step 2", () => {
        const cycles = [];
        for (let i = 0; i < 5; i += 1) {
            cycles.push({
                cycle: i, time: i * 20,
                values: { hold_window: 12_500_000 - i * 2, tone: 31_249 - i },
            });
        }
        const found = detectDownCounter(cycles, 1000);
        expect(found?.name).toBe("hold_window");
        expect(found?.step).toBe(2);
        expect(found?.cycles).toBe(6_250_001);
        expect(noteSeconds(found, 20)).toBeCloseTo(0.12500002, 9);
        // the detector must not depend on cnt/count name substrings
        expect(/cnt|count/i.test(found?.name || "")).toBe(false);
    });

    it("ignores non-monotonic signals", () => {
        const cycles = [0, 1, 2, 3].map((i) => ({
            cycle: i, time: i * 20,
            values: { cnt: i, other: 10 + i },
        }));
        expect(detectDownCounter(cycles, 10)).toBeNull();
    });
});

describe("noteSeconds", () => {
    it("converts 50,000,000 cycles at 50 MHz to 1.0 s", () => {
        expect(noteSeconds(50_000_000, 20)).toBeCloseTo(1.0, 9);
    });
    it("accepts a counter descriptor", () => {
        expect(noteSeconds({ cycles: 25_000_000, terminal: 25_000_000, step: 1 }, 20)).toBeCloseTo(0.5, 9);
    });
});