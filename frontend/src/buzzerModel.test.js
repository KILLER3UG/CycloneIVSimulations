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
    it("finds a down-counter and its loaded terminal value", () => {
        const cycles = [];
        for (let i = 0; i < 5; i += 1) {
            cycles.push({ cycle: i, time: i * 20, values: { clk: i & 1, sec_counter: 100 - i } });
        }
        const found = detectDownCounter(cycles, 10);
        expect(found?.name).toBe("sec_counter");
        expect(found?.terminal).toBe(100);
        expect(noteSeconds(found.terminal, 20)).toBeCloseTo(0.000002, 9);
    });

    it("ignores non-counters and counters that do not decrement by one", () => {
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
});