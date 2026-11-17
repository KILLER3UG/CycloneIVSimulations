// buzzerModel.js — pure buzzer maths for the RZ-EasyFPGA A2.2 (BEEP PIN_110).
//
// All timing is derived from **simulated** transition timestamps (ns) and the
// 50 MHz clock period (20 ns). Nothing here reads requestAnimationFrame or
// performance.now(), so a browser that cannot step 50 M cycles/s cannot
// pitch-shift the tone.

export const DEFAULT_CLOCK_NS = 20; // 50 MHz
export const MIN_TONE_HZ = 20;
export const MAX_TONE_HZ = 20_000;

/**
 * Measure a buzzer square wave from `[t_ns, level]` edges.
 * @returns {{tone:boolean, frequency:number, cyclesPerPeriod:number,
 *            duty:number, level:number, halfPeriodNs:number}}
 */
export function measureBuzzer(edges, clockNs = DEFAULT_CLOCK_NS, activeLow = true) {
    const transitions = [];
    let last = null;
    for (const edge of edges || []) {
        const t = Number(edge?.[0]);
        const v = Number(edge?.[1]) & 1;
        if (!Number.isFinite(t)) continue;
        if (last === null || v !== last) transitions.push([t, v]);
        last = v;
    }
    const base = {
        tone: false, frequency: 0, cyclesPerPeriod: 0, duty: 0,
        level: last ?? 0, halfPeriodNs: 0,
    };
    if (transitions.length < 2) return base;

    const halves = [];
    for (let i = 0; i < transitions.length - 1; i += 1) {
        const h = transitions[i + 1][0] - transitions[i][0];
        if (h > 0) halves.push(h);
    }
    if (!halves.length) return base;
    const half = halves.reduce((a, b) => a + b, 0) / halves.length;
    const frequency = 1e9 / (2 * half);
    const periodCycles = (2 * half) / (clockNs || DEFAULT_CLOCK_NS);

    const onLevel = activeLow ? 0 : 1;
    let active = 0;
    let total = 0;
    for (let i = 0; i < transitions.length - 1; i += 1) {
        const dt = transitions[i + 1][0] - transitions[i][0];
        if (dt <= 0) continue;
        total += dt;
        if (transitions[i][1] === onLevel) active += dt;
    }
    const duty = total > 0 ? Math.min(1, Math.max(0, active / total)) : 0;
    const tone = frequency >= MIN_TONE_HZ && frequency <= MAX_TONE_HZ;
    return {
        tone,
        frequency: Math.round(frequency),
        cyclesPerPeriod: Math.round(periodCycles * 1000) / 1000,
        duty: Math.round(duty * 1000) / 1000,
        level: last ?? 0,
        halfPeriodNs: Math.round(half * 1000) / 1000,
    };
}

/**
 * Detect a down-counter in the captured cycles (e.g. buzz1's `sec_counter`).
 * Returns `{name, terminal}` where terminal is the largest value seen — the
 * value loaded at the release edge. The note then lasts
 * `terminal * clockNs / 1e9` seconds. Returns null when no signal
 * decrements by exactly 1 per clock cycle.
 */
export function detectDownCounter(cycles, minTerminal = 1000) {
    if (!Array.isArray(cycles) || cycles.length < 3) return null;
    const names = new Set();
    for (const c of cycles) {
        for (const k of Object.keys(c.values || {})) names.add(k);
    }
    const candidates = [];
    for (const name of names) {
        if (!/counter|_cnt|cnt$|count/i.test(name)) continue;
        const values = cycles.map((c) => Number(c.values?.[name]));
        if (values.some((v) => !Number.isFinite(v))) continue;
        let run = 0;
        let best = 0;
        for (let i = 0; i < values.length - 1; i += 1) {
            if (values[i] - values[i + 1] === 1) {
                run += 1;
                best = Math.max(best, values[i]);
            } else if (values[i + 1] !== values[i]) {
                run = 0;
            }
        }
        if (run >= 2 && best >= minTerminal) {
            candidates.push({ name, terminal: best, run });
        }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.terminal - a.terminal || b.run - a.run);
    return { name: candidates[0].name, terminal: candidates[0].terminal };
}

/** Seconds of tone remaining for a loaded down-counter at the 50 MHz clock. */
export function noteSeconds(counterTerminal, clockNs = DEFAULT_CLOCK_NS) {
    const n = Number(counterTerminal);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return (n * clockNs) / 1e9;
}