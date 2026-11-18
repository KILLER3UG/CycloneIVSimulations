// pinPlanner.js — Quartus-like Pin Planner model: board pin catalog (sourced
// from board.json), per-bit port expansion, board defaults helper, validation,
// QSF import/export, and localStorage persistence.

export const IO_STANDARDS = ["3.3-V LVTTL", "3.3-V LVCMOS", "2.5 V", "1.8 V"];
const STORAGE_KEY = "c4_pin_planner_v1";
// Canonical EQFP-144 package of the default EP4CE6E22C8N target. Every actual
// board pin still comes from the active profile (board.json); this is only the
// package-wide fallback catalog boundary, never a board-specific pin map.
const PACKAGE_PIN_MAX = 144;

export function normalizePin(raw) {
    const t = String(raw || "").trim().toUpperCase();
    if (!t) return "";
    if (/^\d+$/.test(t)) return `PIN_${t}`;
    if (/^P(?:IN)?[-_ ]?([A-Za-z0-9]+)$/i.test(t)) {
        const m = t.match(/^P(?:IN)?[-_ ]?([A-Za-z0-9]+)$/i);
        return `PIN_${m[1].toUpperCase()}`;
    }
    return t;
}

export function isValidEqfpPin(pin) {
    const m = /^PIN_(\d+)$/.exec(String(pin || "").trim().toUpperCase());
    if (!m) return false;
    const n = Number(m[1]);
    return n >= 1 && n <= PACKAGE_PIN_MAX;
}

// Build labeled pin catalog strictly from profile (/api/board -> board/board.json).
export function buildPinCatalog(profile) {
    const byPin = new Map();
    const b = profile?.board || {};
    const pm = profile?.pinMap || {};

    const reg = (rawPin, label, dir, extra = {}) => {
        const pin = normalizePin(rawPin);
        if (!pin) return;
        const prev = byPin.get(pin);
        if (prev && prev.priority >= (extra.priority || 1)) return;
        byPin.set(pin, {
            pin,
            label,
            dir, // "in" | "out" | "inout"
            peripheral: extra.peripheral || "",
            role: extra.role || extra.peripheral || "io",
            index: extra.index ?? null,
            aliases: Array.isArray(extra.aliases) ? [...extra.aliases] : [],
            priority: extra.priority || 1,
        });
    };

    if (b.clockPin) {
        reg(b.clockPin, `${b.clockPort || "CLOCK_50"} (50 MHz oscillator)`, "in", { peripheral: "clock", priority: 10 });
    }
    if (b.clock2Pin) {
        // CLK2 / DIFFCLK_1p is a dedicated input-only clock pin.
        reg(b.clock2Pin, "CLK2 / DIFFCLK_1p (dedicated clock input, P1 pin 34)", "in", { peripheral: "clock", priority: 9 });
    }
    if (b.resetPin) {
        reg(b.resetPin, `RESET key (active-${b.resetActiveLow === false ? "high" : "low"})`, "in", { peripheral: "reset", priority: 10 });
    }
    (b.leds?.pins || []).forEach((pin, i) => {
        const diode = b.leds?.diodes?.[i];
        const net = b.leds?.nets?.[i];
        const dual = diode && net ? ` / ${diode} (net ${net})` : "";
        reg(pin, `LED${i + 1}${dual} (${b.leds?.activeLow ? "active-low " : ""}red)`, "out", {
            peripheral: "led", index: i, priority: 10, aliases: [`LED[${i}]`],
        });
    });
    (b.buttons?.pins || []).forEach((pin, i) => {
        reg(pin, `KEY${i + 1} / SW${i + 1} (${b.buttons?.activeLow ? "active-low " : ""}input)`, "in", {
            peripheral: "button", role: "button", index: i, priority: 10,
        });
    });
    // Independent switches (DE0-Nano SW[0..3]): sharedWithButtons === false
    // means these are separate input-only nets and must appear in the catalog
    // as role "switch" instead of being merged into the KEY/button entries.
    if (b.switches && b.switches.sharedWithButtons === false) {
        (b.switches.pins || []).forEach((pin, i) => {
            reg(pin, `SW${i + 1} (${b.switches?.activeLow ? "active-low" : "active-high"} DIP switch)`, "in", {
                peripheral: "switch", role: "switch", index: i, priority: 10, aliases: [`SW[${i}]`],
            });
        });
    }
    const segNames = ["a", "b", "c", "d", "e", "f", "g", "dp"];
    (b.displays?.pins?.SEG || []).forEach((pin, i) => {
        reg(pin, `SEG${i} (segment ${segNames[i] || i}, active-low)`, "out", { peripheral: "segment", index: i, priority: 10 });
    });
    const digPos = ["rightmost D4", "D3", "D2", "leftmost D1"];
    (b.displays?.pins?.DIG || []).forEach((pin, i) => {
        const dl = b.displays?.digitLabels?.[i];
        const extra = dl ? `, ${dl.resistor}, ${dl.diode}` : "";
        reg(pin, `DIG${i} (digit ${i + 1} ${digPos[i] || ""}${extra}, active-low)`, "out", { peripheral: "digit", index: i, priority: 10 });
    });
    if (b.buzzer?.pin) {
        reg(b.buzzer.pin, "BUZZER SP1 (active-low)", "out", { peripheral: "buzzer", priority: 10 });
    }
    if (b.uart?.pins) {
        if (b.uart.pins.UART_TXD) reg(b.uart.pins.UART_TXD, "UART_TXD (MAX3232E TX)", "out", { peripheral: "uart", priority: 9 });
        if (b.uart.pins.UART_RXD) reg(b.uart.pins.UART_RXD, "UART_RXD (MAX3232E RX)", "in", { peripheral: "uart", priority: 9 });
    }
    if (b.vga?.pins) {
        for (const [sig, pin] of Object.entries(b.vga.pins)) {
            reg(pin, `${sig} (VGA DB15)`, "out", { peripheral: "vga", priority: 9 });
        }
    }
    if (b.infrared?.pin) {
        reg(b.infrared.pin, "IR_RXD (infrared receiver)", "in", { peripheral: "ir", priority: 9 });
    }
    if (b.ps2?.pins) {
        for (const [sig, pin] of Object.entries(b.ps2.pins)) {
            reg(pin, `${sig} (PS/2)`, "inout", { peripheral: "ps2", priority: 8 });
        }
    }
    for (const bus of b.i2c?.buses || []) {
        if (bus.scl) reg(bus.scl, `I2C_SCL (${bus.name || "I2C"})`, "inout", { peripheral: "i2c", priority: 8 });
        if (bus.sda) reg(bus.sda, `I2C_SDA (${bus.name || "I2C"})`, "inout", { peripheral: "i2c", priority: 8 });
    }
    (b.headerIo || []).forEach((h) => {
        if (!h.pin) return;
        reg(h.pin, `Header I/O (${h.header || "header"} pin ${h.headerPin ?? "?"}${h.fpga ? ", " + h.fpga : ""})`, "inout", { peripheral: "io", priority: 8 });
    });

    // Declarative SDK manifests may carry an explicit pin list (number/name/
    // role/input_only). Register those before the generic pinMap fallback so
    // switching boards shows the active board's full catalog.
    for (const entry of (Array.isArray(b.pins) ? b.pins : [])) {
        const rawPin = entry.number ?? entry.pin ?? entry.name;
        if (!rawPin) continue;
        const role = String(entry.role || "io").toLowerCase();
        const dir = entry.dir || entry.direction
            || (entry.input_only === true ? "in"
                : /^(clock|reset|key|button|switch|uart_rxd|ir)/i.test(role) ? "in"
                    : /^(led|seg|dig|buzzer|vga|uart_txd)/i.test(role) ? "out" : "inout");
        reg(rawPin, `${entry.name || role} (${role})`, dir, {
            peripheral: role, role, priority: entry.priority ?? 8,
        });
    }

    for (const [sig, val] of Object.entries(pm)) {
        const list = Array.isArray(val) ? val : [val];
        const outDir = /^(LED|SEG|DIG|VGA|UART_TXD|LCD_E|LCD_RS|LCD_RW|FPGA_BUZZER|SDRAM_)/i.test(sig)
            ? "out"
            : /^(KEY|SW|RESET|CLK|CLOCK|FPGA_RST|UART_RXD|IR)/i.test(sig)
                ? "in"
                : "inout";
        list.forEach((pin, idx) => {
            const label = list.length > 1 ? `${sig}[${idx}]` : sig;
            reg(pin, label, outDir, { peripheral: "board", priority: 5 });
        });
    }

    // Complete the remaining package pins as General I/O
    for (let n = 1; n <= PACKAGE_PIN_MAX; n += 1) {
        const pin = `PIN_${n}`;
        if (!byPin.has(pin)) {
            byPin.set(pin, { pin, label: "User I/O / Header", dir: "inout", peripheral: "io", role: "io", index: null, priority: 0 });
        }
    }

    const list = Array.from(byPin.values()).sort((a, b2) => {
        if ((b2.priority > 0) !== (a.priority > 0)) return b2.priority > 0 ? 1 : -1;
        return Number(a.pin.slice(4)) - Number(b2.pin.slice(4));
    });
    return { byPin, list };
}

function stripComments(code, fileName) {
    if (/\.(v|sv)$/i.test(fileName || "")) {
        return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*/g, "");
    }
    return code.replace(/--.*/g, "");
}

// Parse entities/modules AND their port lists directly in browser JS so the
// Pin Planner updates immediately on file switch or port edits before compile.
export function parseEntitiesWithPorts(code, fileName = "design.vhd") {
    const clean = stripComments(String(code || ""), fileName);
    const isVerilog = /\.(v|sv)$/i.test(fileName) || (
        /\bmodule\s+[A-Za-z_]\w*/i.test(clean) && !/\bentity\s+[A-Za-z_]\w*\s+is\b/i.test(clean)
    );
    return isVerilog ? parseVerilogPorts(clean) : parseVhdlPorts(clean);
}

function parseVhdlPorts(clean) {
    const entities = [];
    const entRe = /\bentity\s+([A-Za-z][A-Za-z0-9_]*)\s+is\b([\s\S]*?)\bend\s+(?:entity\s+)?\1?\s*;/gi;
    let m;
    while ((m = entRe.exec(clean)) !== null) {
        const name = m[1];
        const body = m[2];
        const ports = [];
        const portIdx = body.search(/\bport\s*\(/i);
        if (portIdx >= 0) {
            const openParen = body.indexOf("(", portIdx);
            const closeParen = findBalanced(body, openParen, "(", ")");
            if (closeParen > openParen) {
                const inside = body.slice(openParen + 1, closeParen);
                for (const item of splitTopLevel(inside, ";")) {
                    const colon = item.indexOf(":");
                    if (colon < 0) continue;
                    const namesPart = item.slice(0, colon);
                    const rhs = item.slice(colon + 1).trim();
                    const dirM = /^(in|out|inout|buffer|linkage)\b\s*([\s\S]*)$/i.exec(rhs);
                    if (!dirM) continue;
                    const direction = dirM[1].toLowerCase() === "buffer" ? "out" : dirM[1].toLowerCase();
                    const typeText = dirM[2].replace(/:=[\s\S]*$/, "").trim();
                    const rngM = /\(\s*(\d+)\s+(downto|to)\s+(\d+)\s*\)/i.exec(typeText);
                    let width = 1;
                    if (rngM) width = Math.abs(Number(rngM[1]) - Number(rngM[3])) + 1;
                    for (const rawName of namesPart.split(",")) {
                        const pname = rawName.trim();
                        if (!pname) continue;
                        ports.push({
                            name: pname,
                            direction,
                            type: typeText,
                            width,
                            isVector: width > 1,
                        });
                    }
                }
            }
        }
        entities.push({ name, ports });
    }
    return entities;
}

function parseVerilogPorts(clean) {
    const entities = [];
    const modRe = /\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)\s*(?:#\s*\([\s\S]*?\))?\s*(?:\(([\s\S]*?)\))?\s*;([\s\S]*?)\bendmodule\b/g;
    let m;
    while ((m = modRe.exec(clean)) !== null) {
        const name = m[1];
        const header = m[2] || "";
        const body = m[3] || "";
        const ports = [];
        const ansi = /\b(input|output|inout)\b/.test(header);
        if (ansi) {
            let curDir = "in";
            let curWidth = 1;
            let curType = "wire";
            for (const raw of splitTopLevel(header, ",")) {
                let s = raw.trim();
                if (!s) continue;
                const dM = /^(input|output|inout)\b(.*)$/.exec(s);
                if (dM) {
                    curDir = dM[1] === "input" ? "in" : dM[1] === "output" ? "out" : "inout";
                    s = dM[2].replace(/\b(wire|reg|logic|signed|unsigned)\b/g, " ").trim();
                    const rM = /^\[\s*(\d+)\s*:\s*(\d+)\s*\](.*)$/.exec(s);
                    if (rM) {
                        const msb = Number(rM[1]);
                        const lsb = Number(rM[2]);
                        curWidth = Math.abs(msb - lsb) + 1;
                        curType = `std_logic_vector(${msb} ${msb >= lsb ? "downto" : "to"} ${lsb})`;
                        s = rM[3].trim();
                    } else {
                        curWidth = 1;
                        curType = "std_logic";
                    }
                }
                const pname = s.replace(/=.*$/, "").trim();
                if (pname && /^[A-Za-z_]\w*$/.test(pname)) {
                    ports.push({ name: pname, direction: curDir, type: curType, width: curWidth, isVector: curWidth > 1 });
                }
            }
        } else {
            const headerNames = header.split(",").map((x) => x.trim()).filter(Boolean);
            const decls = new Map();
            const declRe = /\b(input|output|inout)\b(?:\s+(?:wire|reg|logic|signed|unsigned))*\s*(?:\[\s*(\d+)\s*:\s*(\d+)\s*\])?\s*([^;]+);/g;
            let dm;
            while ((dm = declRe.exec(body)) !== null) {
                const dir = dm[1] === "input" ? "in" : dm[1] === "output" ? "out" : "inout";
                const msb = dm[2] !== undefined ? Number(dm[2]) : null;
                const lsb = dm[3] !== undefined ? Number(dm[3]) : null;
                const width = msb !== null ? Math.abs(msb - lsb) + 1 : 1;
                const ttext = msb !== null ? `std_logic_vector(${msb} ${msb >= lsb ? "downto" : "to"} ${lsb})` : "std_logic";
                for (const item of dm[4].split(",")) {
                    const pn = item.replace(/=.*$/, "").trim();
                    if (pn) decls.set(pn, { name: pn, direction: dir, type: ttext, width, isVector: width > 1 });
                }
            }
            for (const pn of headerNames) {
                if (decls.has(pn)) ports.push(decls.get(pn));
            }
            if (!ports.length) ports.push(...decls.values());
        }
        entities.push({ name, ports });
    }
    return entities;
}

function findBalanced(str, start, openCh, closeCh) {
    let depth = 0;
    for (let i = start; i < str.length; i += 1) {
        if (str[i] === openCh) depth += 1;
        else if (str[i] === closeCh) {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function splitTopLevel(str, sep) {
    const out = [];
    let cur = "";
    let depth = 0;
    for (let i = 0; i < str.length; i += 1) {
        const ch = str[i];
        if (ch === "(" || ch === "[" || ch === "{") depth += 1;
        else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
        if (ch === sep && depth === 0) {
            out.push(cur);
            cur = "";
        } else {
            cur += ch;
        }
    }
    if (cur.trim()) out.push(cur);
    return out;
}

export function expandEntityNodes(entity) {
    if (!entity?.ports?.length) return [];
    const nodes = [];
    for (const port of entity.ports) {
        const dir = port.direction === "in" ? "input" : port.direction === "inout" ? "inout" : "output";
        const w = Math.max(1, port.width || 1);
        const rng = /\(\s*(\d+)\s+(downto|to)\s+(\d+)\s*\)/i.exec(port.type || "")
            || /\[\s*(\d+)\s*:\s*(\d+)\s*\]/.exec(port.type || "");
        if (w <= 1 && !rng) {
            nodes.push({
                nodeName: port.name,
                portName: port.name,
                bit: null,
                bitOffset: 0,
                width: 1,
                direction: dir,
            });
            continue;
        }
        let left = w - 1;
        let right = 0;
        let downto = true;
        if (rng) {
            if (rng.length === 4) {
                left = Number(rng[1]);
                downto = rng[2].toLowerCase() === "downto";
                right = Number(rng[3]);
            } else {
                left = Number(rng[1]);
                right = Number(rng[2]);
                downto = left >= right;
            }
        }
        const low = Math.min(left, right);
        const step = downto ? -1 : 1;
        const count = Math.abs(left - right) + 1;
        for (let k = 0; k < count; k += 1) {
            const bit = left + k * step;
            nodes.push({
                nodeName: count === 1 && !rng ? port.name : `${port.name}[${bit}]`,
                portName: port.name,
                bit,
                bitOffset: Math.abs(bit - low),
                width: count,
                direction: dir,
            });
        }
    }
    return nodes;
}

export function loadPlannerStore() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

export function savePlannerStore(store) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
        // Ignore storage quota errors in restricted sandboxes.
    }
}

export function getEntityAssignments(store, entityName) {
    if (!entityName) return {};
    return { ...(store[String(entityName).toLowerCase()] || {}) };
}

export function setEntityAssignments(store, entityName, map) {
    if (!entityName) return store;
    const key = String(entityName).toLowerCase();
    store[key] = { ...map };
    savePlannerStore(store);
    return store;
}

// Fill assignments for well-known trainer port names ONLY when requested via "Apply board defaults".
export function suggestBoardDefaults(nodes, profile, existing = {}) {
    const b = profile?.board || {};
    const next = { ...existing };
    const usedPins = new Set(
        Object.values(next).map((v) => normalizePin(v?.location)).filter(Boolean),
    );
    const assign = (nodeName, pin) => {
        const p = normalizePin(pin);
        if (!p || next[nodeName]?.location || usedPins.has(p)) return;
        next[nodeName] = { location: p, ioStandard: next[nodeName]?.ioStandard || "3.3-V LVTTL" };
        usedPins.add(p);
    };

    const ledPins = b.leds?.pins || [];
    const btnPins = b.buttons?.pins || [];
    const segPins = b.displays?.pins?.SEG || [];
    const digPins = b.displays?.pins?.DIG || [];

    for (const node of nodes) {
        const base = node.portName.toLowerCase();
        const off = node.bitOffset || 0;
        if (node.direction === "input" && /^(clk|clock|clk_?50|clock_?50|fpga_?clk|sysclk)$/.test(base) && off === 0) {
            assign(node.nodeName, b.clockPin);
        } else if (node.direction === "input" && /^(rst|reset|rst_?n|reset_?n|fpga_?rst|nrst|nreset)$/.test(base) && off === 0) {
            assign(node.nodeName, b.resetPin);
        } else if (node.direction !== "input" && /^leds?(\d+)?$/.test(base)) {
            const numM = /^leds?(\d+)$/.exec(base);
            const idx = numM ? Number(numM[1]) - (Number(numM[1]) >= 1 && numM[1] <= 4 && !/led0/i.test(base) ? 1 : 0) : off;
            if (idx >= 0 && idx < ledPins.length) assign(node.nodeName, ledPins[idx]);
        } else if (node.direction === "input" && /^(?:keys?|sw|switch|switches|btns?|dip|ckey)[_]?(\d+)?$|^([sk][1-4])$/.test(base)) {
            const skM = /^[sk]([1-4])$/.exec(base) || /^(?:key|sw|btn)_?([1-4])$/.exec(base);
            const idx = skM ? Number(skM[1]) - 1 : off;
            if (idx >= 0 && idx < btnPins.length) assign(node.nodeName, btnPins[idx]);
        } else if (node.direction !== "input" && /^(?:seven_?seg|seg|segs|hex|disp|display)\d*$/.test(base)) {
            if (off < segPins.length) assign(node.nodeName, segPins[off]);
        } else if (node.direction !== "input" && /^(?:dig|digit|dtube|an|sel|tube)\d*$/.test(base)) {
            if (off < digPins.length) assign(node.nodeName, digPins[off]);
        } else if (node.direction !== "input" && /^(?:buzzerb?|beep|fpga_?buzzer|spk)(?:_?\d+)?$/.test(base) && off === 0) {
            assign(node.nodeName, b.buzzer?.pin);
        } else if (node.direction !== "input" && /^(?:uart_?txd?|txd|tx)$/.test(base) && off === 0) {
            assign(node.nodeName, b.uart?.pins?.UART_TXD);
        } else if (node.direction === "input" && /^(?:uart_?rxd?|rxd|rx)$/.test(base) && off === 0) {
            assign(node.nodeName, b.uart?.pins?.UART_RXD);
        } else if (node.direction !== "input" && /^(?:vga_?hsync|hsync)$/.test(base) && off === 0) {
            assign(node.nodeName, b.vga?.pins?.VGA_HSYNC);
        } else if (node.direction !== "input" && /^(?:vga_?vsync|vsync)$/.test(base) && off === 0) {
            assign(node.nodeName, b.vga?.pins?.VGA_VSYNC);
        } else if (node.direction !== "input" && /^vga_?r$/.test(base) && off === 0) {
            assign(node.nodeName, b.vga?.pins?.VGA_R);
        } else if (node.direction !== "input" && /^vga_?g$/.test(base) && off === 0) {
            assign(node.nodeName, b.vga?.pins?.VGA_G);
        } else if (node.direction !== "input" && /^vga_?b$/.test(base) && off === 0) {
            assign(node.nodeName, b.vga?.pins?.VGA_B);
        }
    }
    return next;
}

export function validateAssignments(nodes, assignments, catalog) {
    const errors = [];
    const warnings = [];
    const pinToNode = new Map();
    const validByNode = new Map();
    let assignedCount = 0;
    let unassignedCount = 0;

    for (const n of nodes) {
        const entry = assignments?.[n.nodeName] || {};
        const raw = String(entry.location || "").trim();
        if (!raw) {
            unassignedCount += 1;
            warnings.push({
                file: "pin_planner",
                line: 1,
                column: 1,
                severity: "warning",
                message: `Unassigned port '${n.nodeName}' (${n.direction}) has no pin assignment and will do nothing on the board.`,
            });
            continue;
        }
        assignedCount += 1;
        const pin = normalizePin(raw);
        if (!isValidEqfpPin(pin)) {
            errors.push({
                file: "pin_planner",
                line: 1,
                column: 1,
                severity: "error",
                message: `Nonexistent pin '${raw}' assigned to '${n.nodeName}' (EP4CE6E22C8N supports PIN_1..PIN_${PACKAGE_PIN_MAX}).`,
            });
            continue;
        }
        if (pinToNode.has(pin)) {
            errors.push({
                file: "pin_planner",
                line: 1,
                column: 1,
                severity: "error",
                message: `Duplicate pin conflict: ${pin} is assigned to both '${pinToNode.get(pin)}' and '${n.nodeName}'.`,
            });
            continue;
        }
        const cat = catalog?.byPin?.get(pin);
        if (cat && cat.dir !== "inout" && n.direction !== "inout") {
            const catNeed = cat.dir === "in" ? "input" : "output";
            if (n.direction !== catNeed) {
                errors.push({
                    file: "pin_planner",
                    line: 1,
                    column: 1,
                    severity: "error",
                    message: `Direction conflict on ${pin} (${cat.label}): cannot assign ${n.direction} '${n.nodeName}' to ${catNeed}-only pin.`,
                });
                continue;
            }
        }
        pinToNode.set(pin, n.nodeName);
        validByNode.set(n.nodeName, pin);
    }
    return { errors, warnings, assignedCount, unassignedCount, pinToNode, validByNode };
}

export function parseQsfToPlanner(qsfText, nodes = []) {
    const out = {};
    const nodeByLower = new Map(nodes.map((n) => [n.nodeName.toLowerCase(), n.nodeName]));
    const scalarByLower = new Map();
    for (const n of nodes) {
        if (n.bit === null) scalarByLower.set(n.portName.toLowerCase(), n.nodeName);
    }

    for (const rawLine of String(qsfText || "").split(/\r?\n/)) {
        const line = rawLine.replace(/--.*$|#.*$/, "").trim();
        if (!line) continue;
        const locM = /^set_location_assignment\s+(\S+)\s+-to\s+(\S+)/i.exec(line);
        if (locM) {
            const pin = normalizePin(locM[1]);
            const rawTarget = locM[2].replace(/^"|"$/g, "");
            const targetKey = nodeByLower.get(rawTarget.toLowerCase())
                || scalarByLower.get(rawTarget.toLowerCase())
                || rawTarget;
            out[targetKey] = {
                location: pin,
                ioStandard: out[targetKey]?.ioStandard || "3.3-V LVTTL",
            };
            continue;
        }
        const ioM = /^set_instance_assignment\s+-name\s+IO_STANDARD\s+("[^"]+"|\S+)\s+-to\s+(\S+)/i.exec(line);
        if (ioM) {
            const std = ioM[1].replace(/^"|"$/g, "");
            const rawTarget = ioM[2].replace(/^"|"$/g, "");
            const targetKey = nodeByLower.get(rawTarget.toLowerCase())
                || scalarByLower.get(rawTarget.toLowerCase())
                || rawTarget;
            out[targetKey] = {
                location: out[targetKey]?.location || "",
                ioStandard: std,
            };
        }
    }
    return out;
}

export function exportPlannerToQsf(entityName, nodes, assignments, quartusDevice = "EP4CE6E22C8") {
    const lines = [
        "# Generated by Cyclone IV Studio Pin Planner",
        `set_global_assignment -name FAMILY "Cyclone IV E"`,
        `set_global_assignment -name DEVICE ${quartusDevice}`,
        entityName ? `set_global_assignment -name TOP_LEVEL_ENTITY ${entityName}` : "",
        "",
    ].filter(Boolean);

    for (const n of nodes) {
        const a = assignments?.[n.nodeName];
        const pin = normalizePin(a?.location);
        if (!pin) continue;
        lines.push(`set_location_assignment ${pin} -to ${n.nodeName}`);
        const std = a?.ioStandard || "3.3-V LVTTL";
        lines.push(`set_instance_assignment -name IO_STANDARD "${std}" -to ${n.nodeName}`);
    }
    return lines.join("\n") + "\n";
}
