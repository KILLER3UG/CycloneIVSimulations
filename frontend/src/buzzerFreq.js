// buzzerFreq.js — exact live buzzer frequency from per-frame toggle counts.
//
// One live frame spans ~200k cycles, so a 1600 Hz tone toggles only ~12.8
// times per frame: a per-frame estimate flickers ±6% (1500/1625 Hz). The
// studio contract is ±2%, so toggles and cycles accumulate over a sliding
// window of frames. The window is toggle-aware: it keeps at least
// MIN_FRAMES frames (fast response for high tones) and grows until it holds
// MIN_TOGGLES counts (±1 toggle then stays inside ±2% for low tones), capped
// at MAX_FRAMES. A sustained per-frame deviation resets the window so a tone
// switch is heard within ~2 frames instead of smearing across the window.

export const BUZZER_MIN_FRAMES = 12;
export const BUZZER_MAX_FRAMES = 120;
export const BUZZER_MIN_TOGGLES = 64;
export const BUZZER_SWITCH_DEVIATION = 0.15;

export function createBuzzerFreqWindow() {
    return { samples: [], overshoots: 0 };
}

/** Frequency implied by the window totals (0 while empty/silent). */
export function windowBuzzerFreq(win, clockPeriodNs) {
    let toggles = 0;
    let cycles = 0;
    for (const s of win.samples) {
        toggles += s.toggles;
        cycles += s.cycles;
    }
    if (cycles <= 0 || toggles <= 0) return 0;
    return toggles / (2 * cycles * (clockPeriodNs * 1e-9));
}

/**
 * Feed one frame's buzzer counters; returns the windowed frequency.
 * `toggles`/`cycles` come from the frame's decoded B line, `clockPeriodNs`
 * from the active simulation clock period.
 */
export function accumulateBuzzerFreq(win, toggles, cycles, clockPeriodNs) {
    const safeCycles = Math.max(1, Number(cycles) || 1);
    const frameFreq = toggles > 3
        ? toggles / (2 * safeCycles * (clockPeriodNs * 1e-9))
        : null; // too few toggles to trust a single frame
    const current = windowBuzzerFreq(win, clockPeriodNs);
    if (frameFreq !== null && current > 0
            && Math.abs(frameFreq - current) > current * BUZZER_SWITCH_DEVIATION) {
        win.overshoots += 1;
    } else {
        win.overshoots = 0;
    }
    if (win.overshoots >= 2) {
        win.samples = [];
        win.overshoots = 0;
    }
    win.samples.push({ toggles, cycles: safeCycles });

    // Trim the oldest frames while the REMAINING window still satisfies the
    // freshness/count budgets: at most MAX_FRAMES frames, at least MIN_FRAMES
    // frames, and at least MIN_TOGGLES toggle counts for the ±2% contract.
    let total = 0;
    for (const s of win.samples) total += s.toggles;
    while (win.samples.length > 1) {
        const oldest = win.samples[0];
        if (win.samples.length <= BUZZER_MIN_FRAMES) break;
        if (win.samples.length > BUZZER_MAX_FRAMES
                || total - oldest.toggles >= BUZZER_MIN_TOGGLES) {
            win.samples.shift();
            total -= oldest.toggles;
        } else {
            break;
        }
    }
    return windowBuzzerFreq(win, clockPeriodNs);
}

/** Drop the window (silence, pause, stop, tone loss). */
export function resetBuzzerFreqWindow(win) {
    if (!win) return;
    win.samples = [];
    win.overshoots = 0;
}
