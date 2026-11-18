// layout.js — pure board-layout data for the RZ-EasyFPGA A2.2 (EP4CE6E22C8N).
//
// Every row mirrors one row of board/fidelity/parts.md (58 rows total):
// positions are millimetres from the PCB top-left corner (x right, y down in
// the reference photo orientation), sizes are [w, d] mm (w along x unless the
// entry says otherwise). This module is PURE: no three.js import, so Vitest
// can unit-test it directly.

export const PCB_OUTLINE = Object.freeze({
    w: 132,
    d: 104,
    thickness: 1.6,
    cornerRadius: 3,
});

// World-space helpers (three.js scene uses mm; board centered on origin,
// PCB top surface at y = BOARD_TOP, ground plane at y = 0).
export const BOARD_TOP = PCB_OUTLINE.thickness;
export const worldX = (mm) => mm - PCB_OUTLINE.w / 2;
export const worldZ = (mm) => mm - PCB_OUTLINE.d / 2;

// Physical segment order for the 3461BS-style display: SEG0=a … SEG7=dp
// (verified against the Display sheet: SEG0→R52→pin 11 = segment a).
// This is the SINGLE fallback definition — board.json `displays.segBitMap`
// always wins. With no profile there are no pin routes, so this fallback only
// gives the unconfigured board geometry; it cannot drive any hardware.
export const SEG_BIT_MAP_FALLBACK = Object.freeze({
    a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, dp: 7,
});

export const KIND = Object.freeze({
    FPGA: "fpga",
    HEADER: "header",
    BOXED_HEADER: "boxed-header",
    DISPLAY: "display",
    TRIMMER: "trimmer",
    LCD_SOCKET: "lcd-socket",
    PS2: "ps2",
    DB9: "db9",
    VGA: "vga",
    POWER_SWITCH: "power-switch",
    DC_JACK: "dc-jack",
    USB_B: "usb-b",
    REGULATOR: "regulator",
    IC: "ic",
    IR: "ir",
    OSCILLATOR: "oscillator",
    BUZZER: "buzzer",
    DIP: "dip",
    RESET_KEY: "reset-key",
    BUTTON: "button",
    LED: "led",
    STANDOFF: "standoff",
    ELECTROLYTIC: "electrolytic",
    PASSIVES: "passives",
});

// status/source strings are carried verbatim from parts.md.
const S = {
    A: "ASSUMED",
    DS: "FROM DATASHEET (size), ASSUMED pos",
};

const row = (id, kind, pos, size, extra = {}) => ({ id, kind, pos, size, ...extra });

// ---------------------------------------------------------------------------
// Main components (parts.md "Main components" table)
// ---------------------------------------------------------------------------
export const LAYOUT = [
    row("U5", KIND.FPGA, [49, 57], [26, 24], {
        body: [22, 22], package: "EQFP-144", pins: 144, leadPitch: 0.5,
        marking: ["ALTERA", "Cyclone IV", "EP4CE6E22C8N"], color: "chip",
        label: "U5", source: "photo + board_spec", status: "ASSUMED (identity CONFIRMED)",
    }),
    row("P1", KIND.HEADER, [47, 33], [48.3, 5.8], {
        rows: 2, cols: 19, pitch: 2.54, axis: "x", color: "yellow",
        label: "P1", source: "photo + board_spec", status: "ASSUMED (size CONFIRMED)",
    }),
    row("P2", KIND.HEADER, [51, 78], [55.9, 5.8], {
        rows: 2, cols: 22, pitch: 2.54, axis: "x", color: "yellow",
        label: "P2", source: "photo + board_spec", status: "ASSUMED (size CONFIRMED)",
    }),
    row("P3", KIND.HEADER, [75, 56], [5.0, 25.2], {
        rows: 2, cols: 10, pitch: 2.54, axis: "y", color: "yellow",
        label: "P3", source: "photo + board_spec", status: "ASSUMED (size CONFIRMED)",
    }),
    row("DISP1", KIND.DISPLAY, [94, 10], [30, 16], {
        digits: 4, segmentsPerDigit: 8, color: "dark",
        label: "DISP1", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("RW", KIND.TRIMMER, [114, 19], [8.7, 12.1], {
        color: "blue", label: "RW (10k contrast)", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("LCD1", KIND.LCD_SOCKET, [61, 1], [54.3, 8.7], {
        pins: 20, overhang: "top", color: "black",
        label: "LCD", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("PS2", KIND.PS2, [132, 14], [17.6, 19.1], {
        mount: "right-edge", overhang: 8, color: "silver",
        label: "PS", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("DB9", KIND.DB9, [133, 44], [33, 25], {
        mount: "right-edge", overhang: 8, color: "black",
        label: "RS232", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("VGA", KIND.VGA, [129, 85], [38, 29], {
        mount: "right-edge", overhang: 8, color: "blue",
        label: "VGA", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("SW1", KIND.POWER_SWITCH, [11, 1], [9.4, 11], {
        color: "red", label: "Power switch", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("J1", KIND.DC_JACK, [3, 1], [11, 11.8], {
        color: "black", label: "5V socket", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("USB1", KIND.USB_B, [27, 1], [15, 16.3], {
        color: "silver", label: "USB供电 (power only)", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("U1", KIND.REGULATOR, [21, 21], [6.5, 7], {
        package: "SOT-223", marking: "1117-3.3", color: "chip",
        label: "U1", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("U2", KIND.REGULATOR, [30, 21], [6.5, 7], {
        package: "SOT-223", marking: "1117-1.2", color: "chip",
        label: "U2", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("U3", KIND.REGULATOR, [39, 21], [6.5, 7], {
        package: "SOT-223", marking: "1117-2.5", color: "chip",
        label: "U3", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("U4", KIND.IC, [112, 45], [10.3, 7.5], {
        package: "SOIC-16", marking: "SP3232", fn: "uart", color: "chip",
        label: "U4", source: "photo + board_spec", status: S.DS + " (MAX3232E pin-compatible)",
    }),
    row("U6", KIND.IC, [60, 92], [22.2, 11.8], {
        package: "TSOP-II-54", marking: "HY57V641620", fn: "sdram", color: "chip",
        label: "U6", source: "photo + board_spec", status: S.DS,
    }),
    row("U7", KIND.IC, [22, 52], [10.3, 7.5], {
        package: "SOIC-16", marking: "EPCS16", fn: "config-flash", color: "chip",
        label: "U7", source: "photo + board_spec", status: S.DS + " (M25P16-compatible footprint)",
    }),
    row("U8", KIND.IC, [87, 51], [5.2, 7.5], {
        package: "SOIC-8", marking: "AT24C08", fn: "i2c-eeprom", color: "chip",
        label: "U8", source: "photo + board_spec", status: S.DS,
    }),
    row("U9", KIND.IC, [115, 51], [5.2, 7.5], {
        package: "SOIC-8", marking: "LM75A", fn: "i2c-temp", color: "chip",
        label: "U9", source: "photo + board_spec", status: S.DS,
    }),
    row("U10", KIND.IR, [124, 97], [10, 5], {
        pins: 3, color: "black", label: "U10", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("X1", KIND.OSCILLATOR, [23, 65], [13.1, 7.9], {
        marking: "50.000", color: "silver", label: "X1", source: "photo + board_spec",
        status: "ASSUMED (marking CONFIRMED)",
    }),
    row("SP1", KIND.BUZZER, [97, 60], [15, 15], {
        dia: 15, h: 9, color: "black", label: "SP", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("SW2", KIND.DIP, [92, 71], [12.6, 11], {
        positions: 4, color: "red", label: "SW (ON DIP)", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("RESET", KIND.RESET_KEY, [8, 88], [7, 8.7], {
        color: "black", label: "RESET", source: "photo + board_spec", status: "ASSUMED",
    }),
    // Key positions re-measured on Foto_Rz-EasyFPGA_A2.2.jpg (vp_bottom crop):
    // the row spans x ≈ 92.5…115 mm at ≈7.3 mm pitch — parts.md's 109…146 put
    // S3/S4 off the 132 mm board. Sizes ≈ tact 6×6 + metal shell ≈ 8 × 9.
    row("S1", KIND.BUTTON, [93, 91], [8, 9], {
        color: "black", label: "S1", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("S2", KIND.BUTTON, [101, 91], [8, 9], {
        color: "black", label: "S2", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("S3", KIND.BUTTON, [109, 91], [8, 9], {
        color: "black", label: "S3", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("S4", KIND.BUTTON, [117, 91], [8, 9], {
        color: "black", label: "S4", source: "photo + board_spec", status: "ASSUMED",
    }),
    // LED row measured at x ≈ 73…83 mm (packed 0805s, ≈3.2 mm pitch), left of S1.
    row("LED1", KIND.LED, [73.5, 89], [2, 1.6], {
        color: "white", label: "LED1", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("LED2", KIND.LED, [76.7, 89], [2, 1.6], {
        color: "white", label: "LED2", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("LED3", KIND.LED, [79.9, 89], [2, 1.6], {
        color: "white", label: "LED3", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("LED4", KIND.LED, [83.1, 89], [2, 1.6], {
        color: "white", label: "LED4", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("JTAG", KIND.BOXED_HEADER, [11, 94], [25.4, 10.2], {
        rows: 2, cols: 5, pitch: 2.54, axis: "y", signals: ["TCK", "TDO", "TMS", "TDI"],
        color: "black", label: "JTAG", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("AS", KIND.BOXED_HEADER, [11, 61], [25.4, 10.2], {
        rows: 2, cols: 5, pitch: 2.54, axis: "y",
        signals: ["DCLK", "CONF_DONE", "nCONFIG", "DATA", "ASDI", "nCE", "nCSO"],
        color: "black", label: "AS", source: "photo + board_spec", status: "ASSUMED",
    }),
    row("MP", KIND.STANDOFF, [[1, 0], [131, 1], [1, 101], [132, 101]], [8, 8], {
        dia: 8, h: 11, color: "brass", label: "M3 standoff ×4",
        source: "photo (board_v3 shows case)", status: "ASSUMED",
    }),
];

// ---------------------------------------------------------------------------
// Electrolytic capacitors (parts.md table 2)
// ---------------------------------------------------------------------------
LAYOUT.push(
    row("C_E1", KIND.ELECTROLYTIC, [49, 6], [6.6, 6.6], {
        dia: 6.6, h: 11.8, color: "electrolytic", label: "C_E1", source: "photo", status: "ASSUMED (visible)",
    }),
    row("C_E2", KIND.ELECTROLYTIC, [61, 22], [4, 4], {
        dia: 4, h: 7, color: "electrolytic", label: "C_E2 (2.5V rail)", source: "photo", status: "ASSUMED (visible)",
    }),
    row("C_E3", KIND.ELECTROLYTIC, [12, 11], [6, 6], {
        dia: 6, h: 11, color: "electrolytic", label: "C_E3", source: "seed", status: "ASSUMED (not clearly resolved)",
    }),
);

// ---------------------------------------------------------------------------
// Resistor / capacitor clusters (parts.md table 3). `items` lists the parts in
// the cluster; builders lay them out deterministically around the cluster pos.
// ---------------------------------------------------------------------------
const cluster = (id, pos, items, label, status = "ASSUMED") =>
    row(id, KIND.PASSIVES, pos, [0, 0], { items, label, source: "photo + board_spec", status });

LAYOUT.push(
    cluster("R30_33", [78, 96], [{ t: "R", n: 4, size: "0805" }], "R30 R31 R32 R33"),
    cluster("R34_37", [93, 83], [{ t: "R", n: 4, size: "0805" }], "R34 R35 R36 R37"),
    cluster("R38_45", [104, 82], [{ t: "R", n: 8, size: "0805" }], "R38…R45"),
    cluster("Q1_4", [74, 10], [{ t: "Q", n: 4, size: "SOT-23", marking: "8550" }], "Q1…Q4 (+R46…R49 bases)"),
    cluster("R50_57", [94, 22], [{ t: "R", n: 8, size: "0805" }], "R50…R57"),
    cluster("R12_16", [109, 73], [{ t: "R", n: 5, size: "0805" }], "R12…R16"),
    cluster("R17_19", [83, 71], [{ t: "R", n: 3, size: "0805" }], "R17 R18 R19"),
    cluster("R21_24", [122, 27], [{ t: "R", n: 4, size: "0805" }], "R21…R24"),
    cluster("R25_28", [101, 51], [{ t: "R", n: 4, size: "0805" }], "R25…R28"),
    cluster("R1_D1", [15, 11], [{ t: "R", n: 1, size: "0805" }, { t: "LED", n: 1, size: "0805" }], "R1, D1"),
    cluster("R2_C10", [20, 86], [{ t: "R", n: 1, size: "0805" }, { t: "C", n: 1, size: "0805" }], "R2, C10"),
    cluster("R7_R11", [13, 45], [{ t: "R", n: 2, size: "0805" }], "R7, R11"),
    cluster("R8_10", [14, 70], [{ t: "R", n: 3, size: "0805" }], "R8 R9 R10"),
    cluster("R3_6", [33, 62], [{ t: "R", n: 4, size: "0805" }], "R3…R6"),
    cluster("C41_44", [106, 55], [{ t: "C", n: 4, size: "0805" }], "C41…C44"),
    cluster("C2_8", [29, 21], [{ t: "T", n: 5, size: "tantalum" }], "C2/C4/C6/C7/C8"),
    cluster("FB1_2", [37, 73], [{ t: "R", n: 2, size: "0805" }, { t: "C", n: 2, size: "0805" }], "FB1 FB2 C11 C13"),
    cluster("C9", [24, 67], [{ t: "C", n: 1, size: "0805" }], "C9"),
);

// ---------------------------------------------------------------------------
// Pin index — maps every FPGA pin id in the board profile to the 3D element
// that shows it: {componentId, elementIndex, polarity, kind}.
// ---------------------------------------------------------------------------

const RAIL_RE = /^(3\.3\s*V|5\s*V|GND)$/i;

/**
 * Parse a header "note" string from board.json into slot assignments.
 * Handles the audited per-pin syntax:
 *   "header pins 1/2 = GND; 3=BEEP(110), 4=111, 11-18=SEG1/6/2/5/7/0/3/4
 *    (121,124,...), 19-22=DIG1-4 (133,...), 23-33=LCD2/1/... (138,...),
 *    34=24 (free GPIO), 35/36=3.3 V, 37/38=5 V (zoom_p1_pins.png)"
 *   "pins 7-42 = SDRAM breakout (A 76,77,...; BS 73,74; DQ 28,30..44; ...)"
 *   "left column 3=LED1(84), ...; right column 4=LED2(85), ..."
 * Returns entries { slot (1-based), label, pins:[n], rail? }.
 */
export function parseHeaderNote(note) {
    if (!note) return [];
    // Strip citation parens that carry no digits: (zoom_p1_pins.png), (free GPIO)
    const str = String(note).replace(/\((?![^)]*\d)[^)]*\)/g, " ");
    const out = [];
    let sawSlot = false;

    const nums = (s) => String(s).split(/[,\s/]+/).flatMap((t) => {
        const r = t.match(/^(\d+)\.\.(\d+)$/);
        if (r) { const a = []; for (let i = +r[1]; i <= +r[2]; i += 1) a.push(i); return a; }
        const n = Number(t);
        return Number.isFinite(n) ? [n] : [];
    });
    const railOf = (v) => (/gnd/i.test(v) ? "GND" : /3\.3/.test(v) ? "3V3" : /5\s*V/i.test(v) ? "5V" : null);
    const namesFor = (spec, n) => {
        const range = String(spec).match(/^([A-Za-z_]+)(\d+)\s*-\s*(\d+)$/);
        if (range) {
            const names = [];
            for (let i = +range[2]; i <= +range[3]; i += 1) names.push(range[1] + i);
            return names;
        }
        const names = [];
        let base = "";
        for (const tok of String(spec).split(/[/\s]+/).filter(Boolean)) {
            const m = tok.match(/^([A-Za-z_]*)(\d+)$/);
            if (m) { base = m[1] || base; names.push(base + m[2]); }
            else { base = tok; names.push(tok); }
        }
        while (names.length < n) names.push(names[names.length - 1] ?? "");
        return names.slice(0, n);
    };

    const assign = (slotsSpec, value) => {
        let slots = [];
        const pair = slotsSpec.match(/^(\d+)\s*-\s*(\d+)$/);
        if (pair && +pair[2] > +pair[1]) {
            for (let i = +pair[1]; i <= +pair[2]; i += 1) slots.push(i);
        } else {
            slots = nums(slotsSpec);
        }
        slots = slots.filter((s) => s >= 1);
        if (!slots.length) return;
        const v = value.trim();
        const rail = railOf(v);
        if (rail) {
            slots.forEach((s) => out.push({ slot: s, label: rail, pins: [], rail }));
            sawSlot = true;
            return;
        }
        if (/not connected/i.test(v)) { sawSlot = true; return; }
        const m = v.match(/^([A-Za-z_][\w\s/-]*?)\s*\(([^)]+)\)\s*$/);
        if (m && /breakout/i.test(v)) {
            // "SDRAM breakout (A 76,77,...; BS 73,74; DQ 28,30..44; ...)"
            const items = [];
            for (const part of m[2].split(";")) {
                const pm = part.trim().match(/^([A-Za-z_]+)\s+([\d,.\s/]+)$/);
                if (pm) items.push({ name: pm[1], pins: nums(pm[2]) });
            }
            let k = 0;
            for (const item of items) {
                for (let i = 0; i < item.pins.length && k < slots.length; i += 1, k += 1) {
                    const multi = item.pins.length > 1;
                    out.push({
                        slot: slots[k],
                        label: multi ? `${item.name}${i}` : item.name,
                        pins: [item.pins[i]],
                    });
                }
            }
            sawSlot = true;
            return;
        }
        if (m) {
            const pins = nums(m[2]);
            const names = namesFor(m[1], Math.max(pins.length, slots.length));
            slots.forEach((s, i) => out.push({
                slot: s,
                label: names[i] ?? m[1].trim(),
                pins: [pins[i]].filter(Number.isFinite),
            }));
            sawSlot = true;
            return;
        }
        const bare = nums(v);
        if (bare.length) {
            slots.forEach((s, i) => out.push({
                slot: s,
                label: String(bare[i] ?? bare[0]),
                pins: [bare[i] ?? bare[0]],
            }));
            sawSlot = true;
        }
    };

    // Split into clauses on ';' (paren-aware), then assignments on top-level commas.
    let depth = 0, tok = "";
    const clauses = [];
    for (const ch of str) {
        if (ch === "(") depth += 1;
        if (ch === ")") depth -= 1;
        if (ch === ";" && depth === 0) { clauses.push(tok); tok = ""; }
        else tok += ch;
    }
    clauses.push(tok);

    for (const clause of clauses) {
        const c = clause.replace(/^\s*header\s+/i, "").trim();
        if (!c) continue;
        const parts = [];
        let d = 0, t = "";
        for (const ch of c) {
            if (ch === "(") d += 1;
            if (ch === ")") d -= 1;
            if (ch === "," && d === 0) { parts.push(t); t = ""; }
            else t += ch;
        }
        parts.push(t);
        for (const part of parts) {
            const p = part.trim();
            if (!p) continue;
            const eq = p.indexOf("=");
            if (eq > 0) {
                assign(p.slice(0, eq).replace(/^pins?\s*/i, "").replace(/^left\s+column\s*|^right\s+column\s*/i, "").trim(), p.slice(eq + 1));
            } else if (RAIL_RE.test(p)) {
                // stray rail without slot: skip (slot syntax carries its own)
            }
        }
    }
    return sawSlot ? out : [];
}

const pinKey = (pinId) => {
    const s = String(pinId).trim().toUpperCase();
    return s.startsWith("PIN_") ? s : "PIN_" + s.replace(/^PIN/i, "");
};

function componentForPort(port) {
    if (/^LED/.test(port)) return "LED" + (Number((port.match(/\d+/) || [0])[0]) + 1);
    if (/^SEG/.test(port)) return "DISP1";
    if (/^DIG/.test(port)) return "DISP1";
    if (/^KEY/.test(port)) return "S" + (Number((port.match(/\d+/) || [0])[0]) + 1);
    if (/SDRAM|LDQM|UDQM/.test(port)) return "U6";
    if (/^VGA/.test(port)) return "VGA";
    if (/^LCD/.test(port)) return "LCD1";
    if (/^UART/.test(port)) return "DB9";
    if (/^PS_/.test(port)) return "PS2";
    if (/^I2C_/.test(port)) return "U8";
    if (/^FPGA_S[CD]/.test(port)) return "U9";
    if (/BUZZER/.test(port)) return "SP1";
    if (/^IR$/.test(port)) return "U10";
    if (/CLK/.test(port)) return "X1";
    if (/RST/.test(port)) return "RESET";
    return null;
}

/**
 * buildPinIndex(profile) → { index: Map<pinKey, entry>, list, headerLayouts }.
 * entry = { pinId, pinNumber, componentId, elementIndex, polarity, kind, label }
 *
 * Reads pins + polarities ONLY from the profile (board.json shape):
 *   profile.board.leds/buttons/switches/displays/buzzer, profile.pinMap,
 *   profile.board.headers.{P1,P2,P3}.
 * Never hard-coded: with no profile the index is empty and the board renders
 * unprofiled (generic header labels, default polarities).
 */
export function buildPinIndex(profile) {
    const index = new Map();
    const list = [];
    const b = (profile && (profile.board || profile)) || {};

    const add = (pinId, entry) => {
        if (pinId === undefined || pinId === null || pinId === "") return;
        const key = pinKey(pinId);
        const pinNumber = Number(key.slice(4));
        const full = {
            pinId: key,
            pinNumber: Number.isFinite(pinNumber) ? pinNumber : null,
            componentId: null,
            elementIndex: null,
            polarity: null,
            kind: "io",
            label: null,
            ...entry,
        };
        const existing = index.get(key);
        if (existing) {
            // Shared nets (KEY[n] / DIP[n] on pins 88-91): keep both, first wins.
            existing.shared = existing.shared || [existing];
            existing.shared.push(full);
            list.push(full);
            return;
        }
        index.set(key, full);
        list.push(full);
    };

    const pol = (flag, dflt = true) => (flag === undefined ? (dflt ? "active-low" : "active-high")
        : flag ? "active-low" : "active-high");

    // LEDs / buttons / DIP / display / buzzer from the structured blocks.
    (b.leds?.pins || []).forEach((p, i) => add(p, {
        componentId: "LED" + (i + 1), elementIndex: i, kind: "led", polarity: pol(b.leds?.activeLow),
    }));
    (b.buttons?.pins || []).forEach((p, i) => add(p, {
        componentId: "S" + (i + 1), elementIndex: i, kind: "button", polarity: pol(b.buttons?.activeLow),
    }));
    (b.switches?.pins || []).forEach((p, i) => add(p, {
        componentId: "SW2", elementIndex: i, kind: "switch", polarity: pol(b.switches?.activeLow),
    }));
    const segPins = b.displays?.pins?.SEG || [];
    // board.json is the only source of the bit map; the fallback is the single
    // exported constant above (no duplicate map literal here).
    const segMap = b.displays?.segBitMap || SEG_BIT_MAP_FALLBACK;
    const bitToName = Object.fromEntries(Object.entries(segMap).map(([n, bit]) => [bit, n]));
    segPins.forEach((p, i) => add(p, {
        componentId: "DISP1", elementIndex: i, kind: "segment",
        polarity: pol(b.displays?.segmentActiveLow), label: bitToName[i] || null,
    }));
    (b.displays?.pins?.DIG || b.displays?.digitPins || []).forEach((p, i) => add(p, {
        componentId: "DISP1", elementIndex: i, kind: "digit",
        polarity: pol(b.displays?.digitActiveLow),
    }));
    if (b.buzzer?.pin) add(b.buzzer.pin, {
        componentId: "SP1", elementIndex: 0, kind: "buzzer", polarity: pol(b.buzzer?.activeLow),
    });

    // Everything else in pinMap (SDRAM, VGA, LCD, UART, PS2, I2C, clock, reset…)
    // that isn't already bound to a specific element above.
    const pinMap = profile?.pinMap || {};
    for (const [port, pins] of Object.entries(pinMap)) {
        const arr = Array.isArray(pins) ? pins : [pins];
        arr.forEach((p, i) => {
            if (index.has(pinKey(p))) return; // specific element wins
            add(p, {
                componentId: componentForPort(port),
                elementIndex: i,
                kind: "io",
                polarity: port === "IR" ? "active-low" : null,
                label: port,
            });
        });
    }

    // Header layouts: positional slot → label / rail, resolved from the
    // profile's header notes (never hard-coded pin orders).
    const headerLayouts = {};
    const headers = b.headers || {};
    for (const hid of ["P1", "P2", "P3"]) {
        const def = headers[hid] || {};
        const layoutEntry = LAYOUT.find((r) => r.id === hid);
        const slots = [];
        const note = def.note || "";
        const parsed = parseHeaderNote(note);

        const total = layoutEntry.rows * layoutEntry.cols;
        if (parsed.some((e) => e.slot)) {
            // Explicit per-pin note: place each entry at its 1-based slot.
            for (const e of parsed) {
                const i = (e.slot ?? 0) - 1;
                if (i < 0 || i >= total || slots[i]) continue;
                if (e.rail) slots[i] = { rail: e.rail, label: e.label };
                else if (e.pins && e.pins.length) slots[i] = { label: e.label, pin: e.pins[0] };
                else slots[i] = { label: e.label };
            }
        } else {
            // Legacy prose note: fill sequentially in note order.
            let k = 0;
            for (const e of parsed) {
                if (e.rail) { if (k < total) slots[k++] = { rail: e.rail, label: e.label }; continue; }
                for (const p of e.pins) { if (k < total) slots[k++] = { label: e.label, pin: p }; }
            }
        }
        while (slots.length < total) slots.push({ label: null });

        // Resolve each slot's pin id through the index.
        const entries = slots.map((s) => {
            if (s.pin !== undefined) {
                const key = pinKey(s.pin);
                const entry = index.get(key);
                return {
                    label: s.label || (entry ? entry.label : null) || String(s.pin),
                    pinId: key,
                    pinNumber: s.pin,
                    rail: null,
                    entry: entry || null,
                };
            }
            if (s.rail) return { label: s.label, pinId: null, pinNumber: null, rail: s.rail, entry: null };
            return { label: null, pinId: null, pinNumber: null, rail: null, entry: null };
        });
        headerLayouts[hid] = { id: hid, rows: layoutEntry.rows, cols: layoutEntry.cols, axis: layoutEntry.axis, entries };
    }

    // JTAG / AS boxed headers: signal names only (no FPGA pin numbers in the
    // profile), labels resolved from board.config when available.
    const cfg = b.config || {};
    headerLayouts.JTAG = {
        id: "JTAG", rows: 2, cols: 5, axis: "y",
        entries: (cfg.jtag || "TCK TDO TMS TDI").split(/[\s,/]+/).filter(Boolean)
            .map((label) => ({ label, pinId: null, pinNumber: null, rail: null, entry: null })),
    };
    headerLayouts.AS = {
        id: "AS", rows: 2, cols: 5, axis: "y",
        entries: (cfg.as || "DCLK CONF_DONE nCONFIG DATA ASDI nCE nCSO").split(/[\s,/]+/).filter(Boolean)
            .map((label) => ({ label, pinId: null, pinNumber: null, rail: null, entry: null })),
    };

    return { index, list, headerLayouts };
}

// ---------------------------------------------------------------------------
// Dynamic multi-board model. The canonical constants above stay untouched so
// layout.test.js keeps its 58-row / 132×104 baseline; imported boards (e.g.
// DE0-Nano with 8 LEDs and 2 buttons) are described entirely by layout3d.
// ---------------------------------------------------------------------------
function modelCount(node, fallback) {
    const n = node?.count ?? (Array.isArray(node?.pins) ? node.pins.length : undefined) ?? fallback;
    const v = Number(n);
    return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback;
}

function modelPositions(layout3d, key, count, origin, step = 3.2) {
    const raw = Array.isArray(layout3d[key]) ? layout3d[key] : null;
    return Array.from({ length: count }, (_, i) => {
        const p = raw?.[i];
        if (Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))) {
            return [Number(p[0]), Number(p[1])];
        }
        return [origin[0] + i * step, origin[1]];
    });
}

/**
 * buildDynamicBoardModel(profile) → geometry + component layout for ANY board.
 * `isDefault` tells the 3D scene whether to keep the canonical hand-authored
 * 58-part board; every other profile is built from this model.
 */
export function buildDynamicBoardModel(profile) {
    const b = (profile && (profile.board || profile)) || {};
    const l = (b.layout3d && typeof b.layout3d === "object" ? b.layout3d : null)
        || (profile?.layout3d && typeof profile.layout3d === "object" ? profile.layout3d : null)
        || {};
    const id = String(b.id || profile?.id || "").toLowerCase();
    const isDefault = !id || id === "rz-easyfpga-a2.2";
    const pcb = { ...PCB_OUTLINE, ...(l.pcb && typeof l.pcb === "object" ? l.pcb : {}) };
    const w = Number(pcb.w) || PCB_OUTLINE.w;
    const d = Number(pcb.d) || PCB_OUTLINE.d;

    const ledCount = modelCount(b.leds, 4);
    const keyCount = modelCount(b.buttons, 4);
    const dipCount = modelCount(b.switches, 4);
    const displayCount = modelCount(b.displays, 4);
    const buzzerPresent = Boolean(b.buzzer?.pin || l.buzzerPos);

    const mk = (idPrefix, kind, pos, size, extra = {}) => ({
        id: `${idPrefix}${extra.index !== undefined ? extra.index + 1 : ""}`,
        kind, pos, size, ...extra,
    });

    const leds = modelPositions(l, "ledPositions", ledCount, [w * 0.22, d - 8], 3.2)
        .map((pos, i) => mk("LED", KIND.LED, pos, [2, 1.6], { index: i }));
    const keys = modelPositions(l, "buttonPositions", keyCount, [w - 18, d - 10], 8)
        .map((pos, i) => mk("S", KIND.BUTTON, pos, [8, 9], { index: i }));
    const dip = modelPositions(l, "dipPositions", dipCount > 0 ? 1 : 0, [w * 0.5, d * 0.65], 0)
        .map((_, i) => mk("SW", KIND.DIP, Array.isArray(l.dipPos) ? l.dipPos : [w * 0.5, d * 0.65], [12.6, 11], { index: i, positions: dipCount }));

    const displayPos = Array.isArray(l.displayPos) ? l.displayPos : [w * 0.72, d * 0.18];
    const buzzerPos = Array.isArray(l.buzzerPos) ? l.buzzerPos : [w * 0.18, d * 0.28];
    const fpgaPos = Array.isArray(l.fpgaPos) ? l.fpgaPos : [w * 0.46, d * 0.5];
    const powerPos = Array.isArray(l.powerPos) ? l.powerPos : [Math.min(w - 10, Math.max(10, w * 0.34)), 8.5];
    const resetPos = Array.isArray(l.resetPos) ? l.resetPos : [13, Math.min(d - 8, d * 0.62)];

    return {
        id,
        name: String(b.name || id || "custom board"),
        isDefault,
        pcb,
        pcbColor: String(l.pcbColor || "#141619"),
        fpga: {
            pos: fpgaPos,
            size: [22, 22],
            label: Array.isArray(l.fpgaLabel) ? l.fpgaLabel.slice() : ["ALTERA", "Cyclone IV", String(b.fpga || "")],
        },
        leds,
        keys,
        dip,
        powerPos,
        resetPos,
        display: { pos: displayPos, size: [30, 16], count: displayCount > 0 ? 4 : 0 },
        buzzer: { pos: buzzerPos, size: [15, 15], present: buzzerPresent },
        segBitMap: b.displays?.segBitMap || SEG_BIT_MAP_FALLBACK,
        mountHoles: [
            [5.5, 4.5], [w - 5.5, 4.5], [5.5, d - 4.5], [w - 5.5, d - 4.5],
        ],
    };
}

// Standard 7-segment glyph patterns (a..g), used by demos/tests — display
// polarity/segment order still comes from the profile at runtime.
export const SEG_GLYPHS = Object.freeze({
    "0": "abcdef", "1": "bc", "2": "abdeg", "3": "abcdg", "4": "bcfg",
    "5": "acdfg", "6": "acdefg", "7": "abc", "8": "abcdefg", "9": "abcdfg",
    "-": "g", " ": "", "E": "adefg", "r": "eg", "o": "cdeg", "d": "bcdeg",
    "L": "def", "H": "bcefg", "P": "abefg", "F": "aefg",
});
