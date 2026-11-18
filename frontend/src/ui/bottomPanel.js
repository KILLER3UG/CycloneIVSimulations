// bottomPanel.js — Zone 4: one collapsible bottom dock with four tabs.
// Terminal mounts the xterm controller; Diagnostics owns every compiler error
// and log line; Waveform keeps the VCD export; Displays holds UART/VGA/LCD.

import { icon } from "./icons.js";
import { createWaveformView } from "./waveform.js";

const TAGS = { info: "INFO", ok: "OK", warn: "WARN", error: "ERR", cmd: "CMD" };

export function createBottomPanel(root, h) {
    root.classList.add("bottom-panel");
    root.innerHTML = `
        <div class="bp-tabs" role="tablist" aria-label="Output dock views">
            <button class="bp-tab" data-btab="terminal" role="tab" aria-selected="false">${icon("terminal")}<span>Terminal</span></button>
            <button class="bp-tab active" data-btab="diagnostics" role="tab" aria-selected="true">${icon("activity")}<span>Diagnostics</span></button>
            <button class="bp-tab" data-btab="waveform" role="tab" aria-selected="false">${icon("activity")}<span>Waveform</span></button>
            <button class="bp-tab" data-btab="displays" role="tab" aria-selected="false">${icon("monitor")}<span>Serial / VGA / LCD</span></button>
            <em class="bp-badge" id="diag-badge" title="Diagnostics">0</em>
            <span class="bp-flex"></span>
            <button class="icon-btn" data-act="collapse" title="Collapse bottom dock" aria-label="Collapse bottom dock">${icon("chevron")}</button>
        </div>
        <div class="bp-body">
            <div class="bp-pane" data-pane="terminal">
                <div class="bp-pane-tools">
                    <span class="bp-hint">Local PTY &mdash; type <code>help</code> for commands</span>
                    <span class="bp-flex"></span>
                    <button class="btn" data-act="term-clear">Clear</button>
                    <button class="btn" data-act="term-restart">Restart</button>
                </div>
                <div class="term-wrap" id="terminal-output"></div>
                <div class="bp-term-input">
                    <span aria-hidden="true">&rsaquo;</span>
                    <input type="text" id="terminal-input" autocomplete="off" spellcheck="false"
                        aria-label="Terminal input" placeholder="Terminal input&hellip;">
                </div>
            </div>

            <div class="bp-pane hidden" data-pane="diagnostics">
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

            <div class="bp-pane hidden" data-pane="waveform">
                <div class="probe-bar" id="probe-bar">
                    <span class="probe-hint">Click a pin on the 3D board to probe it.</span>
                    <span class="bp-flex"></span>
                    <button type="button" class="btn bp-btn" id="bp-export-vcd" title="Download the captured waveform as VCD">${icon("download")}<span>Export VCD</span></button>
                </div>
                <div class="wave-wrap" id="wave-wrap"></div>
            </div>

            <div class="bp-pane hidden" data-pane="displays">
                <div class="display-cards">
                    <section class="display-card" data-disp="uart">
                        <header>Serial / UART <span class="baud-badge" id="serial-baud">baud: --</span></header>
                        <div class="serial-out" id="serial-out"><div class="bp-empty">No UART traffic yet.</div></div>
                        <div class="serial-send">
                            <input type="text" id="serial-tx" placeholder="UART RX injection requires backend support" disabled aria-label="UART send">
                            <button class="btn" disabled>Send</button>
                            <span class="serial-frames" id="serial-frames">0 frames</span>
                        </div>
                    </section>
                    <section class="display-card" data-disp="vga">
                        <header>VGA</header>
                        <div class="vga-wrap">
                            <canvas id="vga-canvas" width="640" height="480"></canvas>
                            <div class="vga-nosignal" id="vga-nosignal">no signal</div>
                        </div>
                    </section>
                    <section class="display-card" data-disp="lcd">
                        <header>LCD 1602</header>
                        <div class="lcd-panel">
                            <div class="lcd-screen" id="lcd-screen">
                                <div class="lcd-line" id="lcd-line0">&nbsp;</div>
                                <div class="lcd-line" id="lcd-line1">&nbsp;</div>
                            </div>
                            <div class="lcd-note">HD44780 &mdash; LCD_RS/RW/E + LCD_D[7..0]</div>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    `;

    const panes = {};
    root.querySelectorAll(".bp-pane").forEach((p) => { panes[p.dataset.pane] = p; });
    const wave = createWaveformView(root.querySelector("#wave-wrap"), { onValuesAt: h.onValuesAt });
    const logEl = root.querySelector("#console-log");
    const badge = root.querySelector("#diag-badge");
    const filters = { info: true, ok: true, warn: true, error: true, cmd: true };
    const logRows = [];
    let problems = [];
    let active = "diagnostics";

    // ------------------------------------------------------------- tabs ----
    function showTab(id) {
        if (!panes[id]) return;
        active = id;
        root.querySelectorAll(".bp-tab").forEach((t) => {
            const on = t.dataset.btab === id;
            t.classList.toggle("active", on);
            t.setAttribute("aria-selected", String(on));
        });
        Object.entries(panes).forEach(([key, pane]) => pane.classList.toggle("hidden", key !== id));
        if (id === "waveform") setTimeout(() => wave.resize(), 30);
    }
    root.querySelector(".bp-tabs").addEventListener("click", (e) => {
        const tab = e.target.closest(".bp-tab");
        if (tab) { showTab(tab.dataset.btab); return; }
        const act = e.target.closest("[data-act]");
        if (!act) return;
        const section = root.closest("#bottom") || root.parentElement;
        switch (act.dataset.act) {
            case "collapse":
                section.classList.toggle("collapsed");
                h.onCollapsed?.(section.classList.contains("collapsed"));
                setTimeout(() => wave.resize(), 60);
                break;
            case "clearlog":
                logEl.innerHTML = "";
                logRows.length = 0;
                updateBadge();
                break;
            case "term-clear": h.onTerminalClear?.(); break;
            case "term-restart": h.onTerminalRestart?.(); break;
            default: break;
        }
    });

    // ------------------------------------------------------- diagnostics ---
    root.querySelectorAll("[data-lf]").forEach((cb) => {
        cb.addEventListener("change", () => {
            filters[cb.dataset.lf] = cb.checked;
            logRows.forEach((r) => r.el.classList.toggle("hidden", !filters[r.level]));
        });
    });
    root.querySelector("#bp-export-vcd")?.addEventListener("click", () => h.onExportVcd?.());
    root.querySelector("#terminal-input")?.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const line = e.target.value;
        e.target.value = "";
        h.onTerminalInput?.(line);
    });

    function stamp() {
        const d = new Date();
        const p = (n, w = 2) => String(n).padStart(w, "0");
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    }

    function updateBadge() {
        const errs = problems.filter((p) => p.severity === "error").length;
        const warns = problems.filter((p) => p.severity === "warning").length;
        const n = problems.length || logRows.filter((r) => r.level === "error").length;
        badge.textContent = String(n);
        badge.classList.toggle("has-errors", errs > 0);
        badge.classList.toggle("has-warnings", errs === 0 && warns > 0);
        badge.title = `${errs} error(s), ${warns} warning(s), ${logRows.length} log line(s)`;
    }

    function log(text, level = "info") {
        const row = document.createElement("div");
        row.className = `log-line log-${level}`;
        row.innerHTML = `<span class="log-time">${stamp()}</span><span class="log-tag">${TAGS[level] || "INFO"}</span><span class="log-text"></span>`;
        row.querySelector(".log-text").textContent = String(text);
        row.classList.toggle("hidden", !filters[level]);
        logEl.appendChild(row);
        logRows.push({ el: row, level });
        while (logRows.length > 600) logRows.shift().el.remove();
        // Defer the scroll: reading scrollHeight forces a full document layout
        // (backdrop-filter pills make that expensive) and would blow the
        // <1 ms stimulus budget. The visual result is identical.
        requestAnimationFrame(() => { logEl.scrollTop = logEl.scrollHeight; });
        if (level === "error") updateBadge();
    }

    // Compiler diagnostics now live here (the right workbench keeps its own
    // compact Code-tab drawer, but this dock is the single full log).
    function setProblems(list = []) {
        problems = Array.isArray(list) ? list : [];
        logRows.filter((r) => r.level === "diag").forEach((r) => r.el.remove());
        updateBadge();
    }

    // ------------------------------------------------------------ serial ---
    const serialOut = root.querySelector("#serial-out");
    const baudEl = root.querySelector("#serial-baud");
    const framesEl = root.querySelector("#serial-frames");
    let uart = { bytes: [], baud: null, frames: 0 };
    function setUart(u) {
        uart = u || { bytes: [], baud: null, frames: 0 };
        baudEl.textContent = `baud: ${uart.baud ?? "--"}`;
        framesEl.textContent = `${uart.frames || 0} frames`;
        if (!uart.bytes?.length) {
            serialOut.innerHTML = `<div class="bp-empty">No UART traffic yet — run a design that transmits on UART_TXD.</div>`;
            return;
        }
        serialOut.innerHTML = uart.bytes.slice(0, 4096).map((b) =>
            `<span class="ser-byte">0x${(b & 0xff).toString(16).toUpperCase().padStart(2, "0")}</span>`).join("");
    }

    // --------------------------------------------------------------- vga ---
    const vgaCtx = root.querySelector("#vga-canvas").getContext("2d");
    const vgaNoSig = root.querySelector("#vga-nosignal");
    function setVga(vga) {
        vgaCtx.fillStyle = "#000";
        vgaCtx.fillRect(0, 0, 640, 480);
        const samples = vga?.samples || {};
        if (!Object.keys(samples).length || vga?.frame === false) {
            vgaNoSig.classList.remove("hidden");
            return;
        }
        vgaNoSig.classList.add("hidden");
        for (const k of Object.keys(samples)) {
            const [r, g, b] = samples[k];
            vgaCtx.fillStyle = `rgb(${(r || 0) * 255},${(g || 0) * 255},${(b || 0) * 255})`;
            vgaCtx.fillRect(Number(k), 0, 64, 480);
        }
    }
    setVga(null);

    // --------------------------------------------------------------- lcd ----
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

    // ------------------------------------------------------------ probes ---
    const probeBar = root.querySelector("#probe-bar");
    function addProbeChip(probe, onRemove) {
        probeBar.querySelector(".probe-hint")?.remove();
        const chip = document.createElement("span");
        chip.className = "probe-chip";
        chip.innerHTML = `<b>${probe.label || probe.pinId}</b><code>${probe.pinId}</code><button type="button" aria-label="Remove probe">&times;</button>`;
        chip.querySelector("button").addEventListener("click", () => {
            chip.remove();
            onRemove?.();
            if (!probeBar.querySelector(".probe-chip")) {
                probeBar.innerHTML = `<span class="probe-hint">Click a pin on the 3D board to probe it.</span>`;
            }
        });
        probeBar.appendChild(chip);
    }

    updateBadge();

    return {
        showTab, log, setProblems, setUart, setVga, setLcd, wave, addProbeChip,
        getTerminalHost: () => root.querySelector("#terminal-output"),
        get active() { return active; },
        root,
    };
}
