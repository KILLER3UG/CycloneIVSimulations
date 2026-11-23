import { describe, expect, it } from "vitest";
import {
    accumulateBuzzerFreq,
    createBuzzerFreqWindow,
    resetBuzzerFreqWindow,
    windowBuzzerFreq,
} from "./buzzerFreq.js";

const CLK = 20; // ns — 50 MHz studio clock

// Toggle counts a 200k-cycle frame produces for a steady tone.
function framesFor(freqHz, count, cycles = 200_000) {
    // toggles per frame = 2 * freq * cycles * T  (exact rational)
    const exact = 2 * freqHz * cycles * (CLK * 1e-9);
    const out = [];
    let acc = 0;
    for (let i = 0; i < count; i += 1) {
        acc += exact;
        const t = Math.floor(acc);
        acc -= t;
        out.push(t);
    }
    return out;
}

describe("buzzerFreq window", () => {
    it("is exact for steady tones that quantize badly per frame", () => {
        // 1600 Hz: 12.8 toggles/frame — per-frame estimates flicker 1500/1625.
        const win = createBuzzerFreqWindow();
        let freq = 0;
        for (const t of framesFor(1600, 24)) {
            freq = accumulateBuzzerFreq(win, t, 200_000, CLK);
        }
        expect(freq).toBeGreaterThan(1600 * 0.98);
        expect(freq).toBeLessThan(1600 * 1.02);
    });

    it("stays within ±2% across the audible range, low tones included", () => {
        for (const hz of [100, 200, 500, 800, 1000, 1600, 5000]) {
            const win = createBuzzerFreqWindow();
            let freq = 0;
            for (const t of framesFor(hz, 150)) {
                freq = accumulateBuzzerFreq(win, t, 200_000, CLK);
            }
            expect(Math.abs(freq - hz)).toBeLessThanOrEqual(hz * 0.02);
        }
    });

    it("follows a mid-hold tone switch within a few frames", () => {
        const win = createBuzzerFreqWindow();
        for (const t of framesFor(500, 12)) accumulateBuzzerFreq(win, t, 200_000, CLK);
        expect(windowBuzzerFreq(win, CLK)).toBeCloseTo(500, -1);
        // Design switches to 800 Hz: 16 toggles per 200k-cycle frame.
        let freq = 0;
        for (const t of framesFor(800, 4)) {
            freq = accumulateBuzzerFreq(win, t, 200_000, CLK);
        }
        expect(Math.abs(freq - 800)).toBeLessThanOrEqual(800 * 0.02);
    });

    it("reports 0 for an empty window and survives silence resets", () => {
        const win = createBuzzerFreqWindow();
        expect(windowBuzzerFreq(win, CLK)).toBe(0);
        accumulateBuzzerFreq(win, 20, 200_000, CLK);
        resetBuzzerFreqWindow(win);
        expect(windowBuzzerFreq(win, CLK)).toBe(0);
        expect(win.samples).toHaveLength(0);
    });

    it("ignores single-frame deviations (quantization, not a switch)", () => {
        const win = createBuzzerFreqWindow();
        for (const t of framesFor(1600, 12)) accumulateBuzzerFreq(win, t, 200_000, CLK);
        // one wildly-off frame (6 toggles instead of ~13) must not reset the
        // window — only a SUSTAINED deviation indicates a tone switch
        accumulateBuzzerFreq(win, 6, 200_000, CLK);
        expect(win.samples.length).toBe(12);
        const after = windowBuzzerFreq(win, CLK);
        expect(after).toBeGreaterThan(1600 * 0.9);
        expect(after).toBeLessThan(1600 * 1.1);
    });
});
