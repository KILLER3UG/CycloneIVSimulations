// displayModel.js — pure A3 seven-segment maths (no three.js / DOM).
//
// The rendered tube image is driven by simulated time, never frame counts:
//   * `pov` is the per-(tube,segment) duty cycle over the capture (0..1).
//   * scan >= 60 Hz -> persistence of vision (steady, duty-proportional).
//   * scan <  60 Hz -> instantaneous scan phase (visible stepping/flicker).
//   * `ghosts` are the faint bleed samples produced when segment lines and
//     digit selects change on the same edge without dead-time blanking.

export const PERSISTENCE_MIN_HZ = 60;
export const GHOST_MAX = 0.25;

/** True when the display scan is slow enough that the eye does NOT integrate. */
export function isInstantaneousScan(scanHz) {
    const hz = Number(scanHz);
    return Number.isFinite(hz) && hz > 0 && hz < PERSISTENCE_MIN_HZ;
}

/** Normalize a backend POV image (duty floats, or legacy 0/1 bits) to 0..1. */
export function normalizePov(pov, bits, count = 32) {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
        const raw = Number(pov?.[i]);
        out[i] = Number.isFinite(raw)
            ? Math.min(1, Math.max(0, raw))
            : (bits?.[i] ? 1 : 0);
    }
    return out;
}

/** Build the faint ghost overlay from `[digit, bit, t_ns, intensity]` samples. */
export function ghostOverlay(ghosts, count = 32) {
    const out = new Float32Array(count);
    if (!Array.isArray(ghosts)) return out;
    for (const ghost of ghosts) {
        const [dig, bit, , intensity] = ghost;
        const i = dig * 8 + bit;
        if (i >= 0 && i < count) {
            const v = Math.min(GHOST_MAX, Math.max(0, Number(intensity) || 0));
            out[i] = Math.max(out[i], v);
        }
    }
    return out;
}

/** Final segment brightness: duty plus the (live-only) ghost bleed, clamped. */
export function brightness(duty, ghost = 0, live = true) {
    const d = Number.isFinite(duty) ? Math.min(1, Math.max(0, duty)) : 0;
    const g = live && Number.isFinite(ghost) ? Math.min(GHOST_MAX, Math.max(0, ghost)) : 0;
    return Math.min(1, d + g);
}