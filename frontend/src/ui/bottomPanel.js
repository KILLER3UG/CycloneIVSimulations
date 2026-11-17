// bottomPanel.js — bottom tabbed panel: Console, Problems, Serial Terminal,
// VGA monitor, LCD view and the Waveform viewer.

import { icon } from "./icons.js";
import { createWaveformView } from "./waveform.js";

const TABS = [
    { id: "console", label: "Console", icon: "terminal" },
    { id: "wave", label: "Waveform", icon: "activity" },
    { id: "serial", label: "Serial", icon: "cable" },
    { id: "vga", label: "VGA", icon: "monitor" },
    { id: "lcd", label: "LCD", icon: "lcd" },
];

const TAGS = { info: "INFO", ok: "OK", warn: "WARN", error: "ERR", cmd: "CMD" };

export function createBottomPanel(root, h) {
    root.classList.add("bottom-panel");
    root.innerHTML = `
        <div class="bp-tabs" role="tablist">
            ${TABS.map((t, i) => `
                <button class="bp-tab ${i === 0 ? "active" : ""}" data-tab="${t.id}" role="tab" aria-selected="${i === 0}">
                    ${icon(t.icon)}<span>${t.label}</span><em class="bp-badge hidden" data-badge="${t.id}">0</em>
                </button>`).join("")}
            <span class="bp-flex"></span>
            <button class="icon-btn" data-act="collapse" title="Collapse bottom panel">${icon("chevron")}</button>
        </div>
        <div class="bp-body">
            <div class="bp-main">
                <div class="bp-pane hidden" data-pane="wave">
                    <div class="probe-bar" id="probe-bar">
                        <span class="probe-hint">Click a pin on the 3D board to probe it.</span>
                        <span class="bp-flex"></span>
                        <button type="button" class="btn bp-btn" id="bp-export-vcd" title="Download the captured waveform as VCD">${icon("download")}<span>Export VCD</span></button>
                    </div>
                    <div class="wave-wrap" id="wave-wrap"></div>
                </div>
                <div class="bp-pane hidden" data-pane="serial">
                    <div class="bp-pane-tools">
                        <span class="baud-badge" id="serial-baud">baud: --</span>
                        <label><input type="radio" name="serfmt" value="hex" checked> HEX</label>
                        <label><input type="radio" name="serfmt" value="ascii"> ASCII</label>
                        <span class="bp-flex"></span>
                        <span class="serial-frames" id="serial-frames">0 frames</span>
                    </div>
                    <div class="serial-out" id="serial-out"><div class="bp-empty">No UART traffic yet \u2014 run a design that transmits on UART_TXD.</div></div>
                    <div class="serial-send">
                        <input type="text" id="serial-tx" placeholder="UART RX injection requires backend support" disabled
                            aria-label="UART send (disabled)" title="UART RX injection requires backend support">
                        <button class="btn" disabled title="UART RX injection requires backend support">Send</button>
                    </div>
                </div>
                <div class="bp-pane hidden" data-pane="vga">
                    <div class="vga-wrap">
                        <canvas id="vga-canvas" width="640" height="480"></canvas>
                        <div class="vga-nosignal" id="vga-nosignal">no signal \u2014 run a design that drives VGA_HSYNC / VGA_VSYNC</div>
                    </div>
                </div>
                <div class="bp-pane hidden" data-pane="lcd">
                    <div class="lcd-panel">
                        <div class="lcd-screen" id="lcd-screen">
                            <div class="lcd-line" id="lcd-line0">&nbsp;</div>
                            <div class="lcd-line" id="lcd-line1">&nbsp;</div>
                        </div>
                        <div class="lcd-note" id="lcd-note">1602 character display (HD44780) \u2014 LCD_RS/RW/E + LCD_D[7..0]</div>
                    </div>
                </div>
            </div>
            <div class="bp-dock" data-pane="console">
                <div class="bp-pane-tools">
                    <label><input type="checkbox" data-lf="info" checked> INFO</label>
                    <label><input type="checkbox" data-lf="ok" checked> OK</label>
                    <label><input type="checkbox" data-lf="warn" checked> WARN</label>
                    <label><input type="checkbox" data-lf="error" checked> ERR</label>
                    <label><input type="checkbox" data-lf="cmd" checked> CMD</label>
                    <span class="bp-flex"></span>
                    <button class="btn" data-act="clearlog">Clear</button>
                </div>
                <div class="console-log" id="console-log" role="log"></div>
            </div>
        </div>
    `;

    const panes = {};
    root.querySelectorAll(".bp-pane").forEach((p) => { panes[p.dataset.pane] = p; });
    const badges = {};
    root.querySelectorAll(".bp-badge").forEach((b) => { badges[b.dataset.badge] = b; });
    const dock = root.querySelector(".bp-dock");

    const wave = createWaveformView(root.querySelector("#wave-wrap"), { onValuesAt: h.onValuesAt });
    root.classList.add("solo-console"); // boot state: Console tab = full-width console

    // ---------------------------------------------------------------- tabs --
    let active = "console";
    root.querySelector(".bp-tabs").addEventListener("click", (e) => {
        const tab = e.target.closest(".bp-tab");
        if (tab) { showTab(tab.dataset.tab); return; }
        if (e.target.closest('[data-act="collapse"]')) {
            const section = root.closest("#bottom") || root.parentElement;
            section.classList.toggle("collapsed");
            h.onCollapsed?.(section.classList.contains("collapsed"));
            setTimeout(() => wave.resize(), 60);
        }
    });

    function showTab(id) {
        active = id;
        root.querySelectorAll(".bp-tab").forEach((t) => {
            t.classList.toggle("active", t.dataset.tab === id);
            t.setAttribute("aria-selected", String(t.dataset.tab === id));
        });
        for (const [key, pane] of Object.entries(panes)) {
            pane.classList.toggle("hidden", key !== id);
        }
        // Console is the pinned right dock: selecting it gives it the full
        // width; any other tab splits the body [pane | console].
        const soloConsole = id === "console";
        root.classList.toggle("solo-console", soloConsole);
        dock.classList.toggle("hidden", false);
        if (id === "wave") setTimeout(() => wave.resize(), 30);
    }

    // ------------------------------------------------------------ console --
    const logEl = root.querySelector("#console-log");
    const filters = { info: true, ok: true, warn: true, error: true, cmd: true };
    const logRows = [];
    root.querySelectorAll("[data-lf]").forEach((cb) => {
        cb.addEventListener("change", () => {
            filters[cb.dataset.lf] = cb.checked;
            logRows.forEach((r) => {
                r.el.classList.toggle("hidden", !filters[r.level]);
            });
        });
    });
    root.querySelector('[data-act="clearlog"]').addEventListener("click", () => {
        logEl.innerHTML = "";
        logRows.length = 0;
    });
    root.querySelector("#bp-export-vcd")?.addEventListener("click", () => h.onExportVcd?.());

    function stamp() {
        const d = new Date();
        const p = (n, w = 2) => String(n).padStart(w, "0");
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    }

    function log(text, level = "info") {
        const row = document.createElement("div");
        row.className = `log-line log-${level}`;
        row.innerHTML = `<span class="log-time">${stamp()}</span><span class="log-tag">${TAGS[level] || "INFO"}</span><span class="log-text"></span>`;
        row.querySelector(".log-text").textContent = String(text);
        row.classList.toggle("hidden", !filters[level]);
        logEl.appendChild(row);
        logRows.push({ el: row, level });
        while (logRows.length > 600) {
            const old = logRows.shift();
            old.el.remove();
        }
        logEl.scrollTop = logEl.scrollHeight;
    }

    // ----------------------------------------------------------- problems --
    // Compile diagnostics live in the right workbench Messages panel; the
    // bottom drawer no longer duplicates them. `setProblems` stays as a
    // no-op for API compatibility.
    function setProblems() { }

    // ------------------------------------------------------------- serial --
    const serialOut = root.querySelector("#serial-out");
    const baudEl = root.querySelector("#serial-baud");
    const framesEl = root.querySelector("#serial-frames");
    let uart = { bytes: [], baud: null, frames: 0 };
    function setUart(u) {
        uart = u || { bytes: [], baud: null, frames: 0 };
        baudEl.textContent = `baud: ${uart.baud ?? "--"}`;
        framesEl.textContent = `${uart.frames || 0} frames`;
        if (!uart.bytes || !uart.bytes.length) {
            serialOut.innerHTML = `<div class="bp-empty">No UART traffic yet \u2014 run a design that transmits on UART_TXD.</div>`;
            return;
        }
        const hexMode = root.querySelector('input[name="serfmt"]:checked').value === "hex";
        serialOut.innerHTML = uart.bytes.slice(0, 4096).map((b) => {
            if (hexMode) return `<span class="ser-byte">0x${(b & 0xff).toString(16).toUpperCase().padStart(2, "0")}</span>`;
            const ch = b >= 32 && b < 127 ? String.fromCharCode(b) : "\u00b7";
            return `<span class="ser-char">${ch.replace(/</g, "<").replace(/>/g, ">").replace(/ /g, "&nbsp;")}</span>`;
        }).join("");
    }
    root.querySelectorAll('input[name="serfmt"]').forEach((r) => r.addEventListener("change", () => setUart(uart)));

    // ---------------------------------------------------------------- vga --
    const vgaCanvas = root.querySelector("#vga-canvas");
    const vgaCtx = vgaCanvas.getContext("2d");
    const vgaNoSig = root.querySelector("#vga-nosignal");
    function setVga(vga) {
        vgaCtx.fillStyle = "#000";
        vgaCtx.fillRect(0, 0, 640, 480);
        const samples = vga?.samples || {};
        const cols = Object.keys(samples);
        if (!cols.length || vga?.frame === false) {
            vgaNoSig.classList.remove("hidden");
            return;
        }
        vgaNoSig.classList.add("hidden");
        for (const k of cols) {
            const col = Number(k);
            const [r, g, b] = samples[k];
            vgaCtx.fillStyle = `rgb(${(r || 0) * 255},${(g || 0) * 255},${(b || 0) * 255})`;
            vgaCtx.fillRect(col, 0, 64, 480);
        }
    }
    setVga(null);

    // ---------------------------------------------------------------- lcd --
    const probeBar = root.querySelector("#probe-bar");
    function addProbeChip(probe, onRemove) {
        probeBar.querySelector(".probe-hint")?.remove();
        const chip = document.createElement("span");
        chip.className = "probe-chip";
        chip.innerHTML = `<b>${probe.label || probe.pinId}</b><code>${probe.pinId}</code><button type="button" aria-label="Remove probe ${probe.pinId}">\u00d7</button>`;
        chip.querySelector("button").addEventListener("click", () => {
            chip.remove();
            onRemove?.();
            if (!probeBar.querySelector(".probe-chip")) {
                probeBar.innerHTML = `<span class="probe-hint">Click a pin on the 3D board to probe it.</span>`;
            }
        });
        probeBar.appendChild(chip);
    }

    const lcdLines = [root.querySelector("#lcd-line0"), root.querySelector("#lcd-line1")];
    function setLcd(text) {
        const raw = String(text ?? "").replace(/\r/g, "");
        if (!raw.trim()) {
            lcdLines[0].textContent = "\u00a0";
            lcdLines[1].textContent = "\u00a0";
            return;
        }
        const lines = raw.split("\n").map((l) => l.replace(/\t/g, " ").trimEnd());
        lcdLines[0].textContent = (lines[0] || "").slice(0, 16) || "\u00a0";
        lcdLines[1].textContent = (lines[1] || "").slice(0, 16) || "\u00a0";
    }
    setLcd("");

    return {
        showTab, log, setProblems, setUart, setVga, setLcd, wave, addProbeChip,
        get active() { return active; },
        root,
    };
}
