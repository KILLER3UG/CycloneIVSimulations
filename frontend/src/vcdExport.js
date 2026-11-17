// vcdExport.js — build a standard VCD from the captured waveform.
//
// Pure string generation (no DOM), so it is unit-testable. The simulator
// already samples cycles at the board clock; exporting them as VCD lets a
// student open the exact run in GTKWave/other VCD viewers.

const HEADER_TIMESCALE_NS = 1;

function vcdId(index) {
    // Printable ASCII identifiers, base-94 (VCD allows any non-space).
    let n = index + 1;
    let out = "";
    do {
        out = String.fromCharCode(33 + (n % 94)) + out;
        n = Math.floor(n / 94) - 1;
    } while (n >= 0);
    return out || "!";
}

function formatBits(value, width) {
    if (typeof value === "string") {
        const v = value.trim();
        if (/^[01XZHWULxzhwul-]+$/.test(v)) {
            return v.length >= width ? v.slice(-width) : v.padStart(width, "0");
        }
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return "x".repeat(Math.max(1, width));
    let bits = (Math.trunc(n) >>> 0).toString(2);
    if (bits.length > width) bits = bits.slice(-width);
    return bits.padStart(width, "0");
}

/**
 * @param {Array<{name:string,width?:number,type?:string}>} signals
 * @param {Array<{time:number, values:Object}>} cycles
 * @param {{timescaleNs?:number, durationNs?:number}} [options]
 * @returns {string} VCD text
 */
export function buildVcd(signals, cycles, { timescaleNs = 20, durationNs = 0 } = {}) {
    const list = Array.isArray(signals) ? signals : [];
    const samples = Array.isArray(cycles) ? cycles : [];
    const ids = list.map((_, i) => vcdId(i));
    const lines = [];
    lines.push("`timescale 1 ns");
    lines.push("$date");
    lines.push("    Cyclone IV Studio waveform export");
    lines.push("$end");
    lines.push("$version Cyclone IV Studio 0.1.0 $end");
    lines.push(`$timescale ${timescaleNs} ns $end`);
    lines.push("$scope module cyclone $end");
    list.forEach((s, i) => {
        const width = Math.max(1, Number(s.width) || 1);
        const kind = /reg/i.test(s.type || "") ? "reg" : "wire";
        lines.push(`$var ${kind} ${width} ${ids[i]} ${s.name} $end`);
    });
    lines.push("$upscope $end");
    lines.push("$enddefinitions $end");

    const prev = new Array(list.length).fill(null);
    const emit = (t, values) => {
        lines.push(`#${Math.max(0, Math.round(t))}`);
        list.forEach((s, i) => {
            const width = Math.max(1, Number(s.width) || 1);
            const bits = formatBits(values?.[s.name], width);
            if (bits !== prev[i]) {
                lines.push(`b${bits} ${ids[i]}`);
                prev[i] = bits;
            }
        });
    };

    emit(0, samples[0]?.values || {});
    for (const c of samples) emit(c.time, c.values);

    const end = Number.isFinite(durationNs) && durationNs > 0
        ? durationNs
        : (samples.length ? samples[samples.length - 1].time : 0);
    lines.push(`#${Math.max(0, Math.round(end))}`);
    return lines.join("\n") + "\n";
}