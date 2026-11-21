// liveFrame.js — pure translation of backend live-stepping frames into
// board-visual state. No three.js / DOM: unit-testable in vitest.
//
// A frame packet (from backend/live_session.py via the /ws "live_frame"
// message) carries:
//   values: {port: int|'U'|'X'|'Z'...}   final per-port values (meta kept)
//   duty:   {port: [permille per bit]}   exact within-frame high-duty
//   buzzer: {toggles, activeCycles}      buzzer pin counters over the frame
//   cycles: N                            clock cycles in the frame
//   timeNs / lcd / uartBytes / lcdEvents

export const META_CHARS = new Set(["U", "X", "Z", "W", "L", "H", "-"]);

/** Perceptual LED curve: duty 0..1 -> perceived brightness 0..1. */
export function ledPerceivedDuty(duty) {
    const d = Math.min(1, Math.max(0, Number(duty) || 0));
    if (d <= 0) return 0;
    // Stevens-style perceptual power law (exponent < 1): a 25 %-duty PWM LED
    // reads clearly lit (~0.53) instead of mud, 100 % saturates.
    return Math.pow(d, 0.45);
}

/** Classify one output-port value into {kind, bits, meta}. */
export function classifyValue(value, width) {
    if (typeof value === "number") {
        const bits = [];
        for (let b = 0; b < (width || 1); b += 1) bits.push((value >> b) & 1);
        return { kind: "bits", bits, meta: null };
    }
    const text = String(value ?? "").toUpperCase();
    const chars = [];
    for (let b = 0; b < (width || 1); b += 1) {
        const ch = text[b];
        // Meta strings keep their '0'/'1' characters intact — only real
        // metavalues are flagged.
        chars.push(ch && (META_CHARS.has(ch) || ch === "1") ? ch : "0");
    }
    return { kind: "meta", bits: chars.map((c) => (c === "1" ? 1 : 0)), meta: chars };
}

/**
 * Build the live board state from a frame.
 * `routes` describes the port→element binding:
 *   { leds: [{port, bit, index}], segments: [{port, bit, cell}],
 *     digits: [{port, bit, index}], buzzer: {port, bit} | null }
 */
export function frameToBoardState(frame, routes, opts = {}) {
    const out = {
        leds: [],            // {index, duty(0..1 perceived), meta}
        segments: [],        // per cell: duty 0..1 (coincidence-integrated)
        digitMeta: [],
        buzzer: { mode: "off", freq: 0, duty: 0 },
        metas: [],           // [{port, bit, char}] for probe tooltips
        timeNs: Number(frame?.timeNs) || 0,
        cycles: Number(frame?.cycles) || 0,
    };
    if (!frame) return out;

    const values = frame.values || {};
    const duty = frame.duty || {};
    const metas = out.metas;

    // --- LEDs: duty per bit, meta detection from the final value ---
    for (const route of routes.leds || []) {
        const raw = values[route.port];
        const cls = classifyValue(raw, 1);
        const cell = (duty[route.port] || [])[route.bit];
        let dutyPermille = typeof cell === "number" ? cell : (cls.bits[0] ? 1000 : 0);
        let meta = null;
        if (typeof raw === "string") {
            const ch = String(raw).toUpperCase()[route.bit] || "X";
            if (META_CHARS.has(ch)) meta = ch;
        }
        if (meta) {
            dutyPermille = 0; // meta outputs render in probe mode, not as lit
        }
        out.leds.push({
            index: route.index,
            duty: ledPerceivedDuty(dutyPermille / 1000),
            rawDuty: dutyPermille / 1000,
            meta,
        });
    }

    // --- 7-segment: coincidence duty per (digit, segment) cell ---
    const segCells = new Map();
    for (const route of routes.segments || []) {
        const cell = (duty[route.port] || [])[route.bit];
        if (typeof cell === "number") segCells.set(route.cell, cell);
    }
    const digCells = new Map();
    for (const route of routes.digits || []) {
        const cell = (duty[route.port] || [])[route.bit];
        if (typeof cell === "number") digCells.set(route.index, cell);
    }
    const nDig = opts.digits ?? 4;
    const nSeg = opts.segments ?? 8;
    if (Array.isArray(frame.coin) && frame.coin.length) {
        // Exact DIG×SEG coincidence duty, integrated in the VHDL wrapper.
        for (let i = 0; i < nDig * nSeg; i += 1) {
            const v = Number(frame.coin[i]) || 0;
            out.segments.push(Math.min(1, Math.max(0, v / 1000)));
        }
    } else {
        // Fallback: only the per-port marginals are known — approximate the
        // coincidence window with the smaller of the two duties.
        for (let dig = 0; dig < nDig; dig += 1) {
            const digPermille = digCells.has(dig) ? digCells.get(dig) : 1000;
            for (let bit = 0; bit < nSeg; bit += 1) {
                const segPermille = segCells.has(bit) ? segCells.get(bit) : 1000;
                const cell = Math.min(segPermille, digPermille);
                out.segments.push(Math.min(1, Math.max(0, cell / 1000)));
            }
        }
    }

    // --- Buzzer: passive tone (toggles) or steady DC drive ---
    const buzz = frame.buzzer;
    if (buzz && routes.buzzer) {
        const cycles = Math.max(1, Number(frame.cycles) || 1);
        const toggles = Number(buzz.toggles) || 0;
        const activeCycles = Number(buzz.activeCycles) || 0;
        if (toggles > 1) {
            out.buzzer = { mode: "tone", freq: toggles / 2 / (cycles * (opts.clockPeriodNs || 10) * 1e-9),
                           duty: Math.min(1, activeCycles / cycles) };
        } else if (activeCycles > cycles * 0.5) {
            out.buzzer = { mode: "dc", freq: 0, duty: activeCycles / cycles };
        } else {
            out.buzzer = { mode: "off", freq: 0, duty: 0 };
        }
    }

    // --- Meta probe list for every tracked output ---
    for (const [port, value] of Object.entries(values)) {
        if (typeof value !== "string") continue;
        const text = value.toUpperCase();
        for (let b = 0; b < text.length; b += 1) {
            if (META_CHARS.has(text[b])) metas.push({ port, bit: b, char: text[b] });
        }
    }
    return out;
}

/** Element routes derived from a Board3D-style pin index + board map. */
export function buildRoutes(pinIndex, boardMap) {
    const routes = { leds: [], segments: [], digits: [], buzzer: null };
    if (!boardMap || !pinIndex) return routes;
    const index = pinIndex.index || pinIndex;
    const ledList = boardMap.leds || [];
    let ledCursor = 0;
    for (const [port, pins] of Object.entries(boardMap.pins || {})) {
        const entries = [];
        for (let bit = 0; bit < (pins || []).length; bit += 1) {
            const pin = String(pins[bit] || "").toUpperCase();
            const entry = index.get(pin);
            if (!entry) continue;
            entries.push({ port, bit, entry });
        }
        for (const { port, bit, entry } of entries) {
            if (entry.kind === "led") {
                routes.leds.push({ port, bit, index: ledCursor });
                ledCursor += 1;
            } else if (entry.kind === "segment") {
                routes.segments.push({ port, bit, cell: entry.elementIndex });
            } else if (entry.kind === "digit") {
                routes.digits.push({ port, bit, index: entry.elementIndex });
            } else if (entry.kind === "buzzer") {
                routes.buzzer = { port, bit };
            }
        }
    }
    return routes;
}

/**
 * Reducer: accumulate the live VGA framebuffer from a frame's `vga.lines`
 * map ({lineIndex: packed8x3bit}). A line index smaller than the running
 * maximum means the design's vsync wrapped — the caller restarts the canvas.
 */
export function reduceLiveVga(state, lines) {
    const next = {
        fb: { ...(state?.fb || {}) },
        maxLine: Number(state?.maxLine) || 0,
        wraps: Number(state?.wraps) || 0,
    };
    for (const [lineStr, packed] of Object.entries(lines || {})) {
        const line = Number(lineStr);
        if (line < next.maxLine) next.wraps += 1;
        next.fb[line] = Number(packed) || 0;
        next.maxLine = Math.max(next.maxLine, line);
    }
    return next;
}

/** Reducer: append decoded live UART bytes (bounded ring). */
export function reduceUartBytes(prev, incoming, cap = 4096) {
    const merged = [...(prev || []), ...(incoming || [])].map((b) => Number(b) & 0xff);
    return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}
