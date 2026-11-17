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
    // Drop the power-on interval and the truncated tail, then take the median
    // of the core: a 1.31 ms capture still measures 800 Hz correctly.
    const core = halves.length >= 3 ? halves.slice(1, -1) : [];
    if (!core.length) return base;
    const ordered = [...core].sort((a, b) => a - b);
    const mid = Math.floor(ordered.length / 2);
    const half = ordered.length % 2
        ? ordered[mid]
        : (ordered[mid - 1] + ordered[mid]) / 2;
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
/**
 * Detect a loaded down-counter generically (no signal-name filter).
 *
 * For every internal integer signal we measure the dominant negative step
 * per clock and the longest run of that step. ``cycles = terminal / step`` is
 * the note length. The longest candidate wins, so ``cnt_delay``,
 * ``sec_counter`` or any other name works.
 *
 * @returns {{name:string, terminal:number, step:number, cycles:number, run:number}|null}
 */
export function detectDownCounter(cycles, minTerminal = 1000) {
    if (!Array.isArray(cycles) || cycles.length < 3) return null;
    const names = new Set();
    for (const c of cycles) {
        for (const k of Object.keys(c.values || {})) names.add(k);
    }
    const candidates = [];
    for (const name of names) {
        const values = cycles.map((c) => Number(c.values?.[name]));
        if (values.some((v) => !Number.isFinite(v))) continue;
        const steps = [];
        const counts = new Map();
        for (let i = 0; i < values.length - 1; i += 1) {
            const s = values[i + 1] - values[i]; // down-counter -> negative
            steps.push(s);
            if (s < 0) counts.set(s, (counts.get(s) || 0) + 1);
        }
        if (!counts.size) continue;
        let step = null;
        let bestCount = -1;
        for (const [s, c] of counts) {
            if (c > bestCount) { step = s; bestCount = c; }
        }
        let run = 0;
        let bestRun = 0;
        let bestStart = 0;
        let start = 0;
        for (let i = 0; i < steps.length; i += 1) {
            if (steps[i] === step) {
                if (run === 0) start = i;
                run += 1;
                if (run > bestRun) { bestRun = run; bestStart = start; }
            } else {
                run = 0;
            }
        }
        if (bestRun < 2) continue;
        const terminal = values[bestStart];
        if (!Number.isFinite(terminal) || terminal < minTerminal) continue;
        const stepMag = Math.abs(step);
        // +1: the load cycle is part of the note.
        const noteCycles = Math.round(terminal / stepMag) + 1;
        if (noteCycles > 0) {
            candidates.push({ name, terminal, step: stepMag, cycles: noteCycles, run: bestRun });
        }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.cycles - a.cycles || b.run - a.run);
    return candidates[0];
}

/** Seconds of tone for a counter descriptor or a raw terminal cycle count. */
export function noteSeconds(counter, clockNs = DEFAULT_CLOCK_NS) {
    const cycles = typeof counter === "object" && counter !== null
        ? (counter.cycles ?? counter.terminal)
        : counter;
    const n = Number(cycles);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return (n * clockNs) / 1e9;
}