// bottomPanel.js — Zone 5: Quartus Prime Standard Edition Messages / Terminal dock.
// Matches the screenshots:
// - Vertical left "Messages" rail
// - Toolbar: All | Error | Critical Warning | Warning | Info | <<Filter>> | Find.. | Find Next
// - Table: Type | ID | Message (with .log-line compat class on every row)
// - Bottom tab bar: System | Processing (N) | Terminal | Waveform | Serial / VGA / LCD

import { icon } from "./icons.js";
import { createWaveformView } from "./waveform.js";

export function createBottomPanel(root, h) {
    root.classList.add("bottom-panel");
    root.innerHTML = `
        <div class="bp-shell">
            <div class="bp-rail" title="Output Dock Controls">
                <button type="button" class="bp-rail-collapse" data-act="collapse" title="Collapse bottom dock" aria-label="Collapse bottom dock">&#9662;</button>
                <div class="bp-rail-icons" role="tablist" aria-label="Dock tools">
                    <button type="button" class="bp-rail-ico" data-rail="terminal" role="tab" aria-selected="false" title="Terminal (ConPTY)" aria-label="Terminal">${icon("terminal")}</button>
                    <button type="button" class="bp-rail-ico" data-rail="waveform" role="tab" aria-selected="false" title="Waveform Viewer" aria-label="Waveform">${icon("activity")}</button>
                    <button type="button" class="bp-rail-ico" data-rail="displays" role="tab" aria-selected="false" title="Serial / VGA / LCD" aria-label="Serial / VGA / LCD">${icon("monitor")}</button>
                </div>
                <div class="bp-rail-tabs" role="tablist" aria-label="Messages">
                    <button type="button" class="bp-rail-tab active" data-rail="messages" role="tab" aria-selected="true" title="Messages (System / Processing)">Messages</button>
                </div>
            </div>
            <div class="bp-main">
                <div class="bp-body">
                    <div class="bp-pane" data-pane="messages">
                        <div class="msg-tools">
                            <div class="msg-filters" role="group" aria-label="Severity filter">
                                <button type="button" class="msg-filter active" data-sev="all" title="Show all messages">All <em id="mf-all">0</em></button>
                                <button type="button" class="msg-filter" data-sev="error" title="Errors">${icon("qErr")}<em id="mf-error">0</em></button>
                                <button type="button" class="msg-filter" data-sev="critical_warning" title="Critical Warnings">${icon("qCritWarn")}<em id="mf-crit">0</em></button>
                                <button type="button" class="msg-filter" data-sev="warning" title="Warnings">${icon("qWarn")}<em id="mf-warning">0</em></button>
                                <button type="button" class="msg-filter" data-sev="info" title="Info">${icon("qInfo")}<em id="mf-info">0</em></button>
                            </div>
                            <span class="msg-sep"></span>
                            <span class="msg-filter-wrap">
                                ${icon("qFilter")}
                                <input type="text" class="msg-filter-text" id="msg-filter-text" placeholder="<<Filter>>" aria-label="Filter messages">
                            </span>
                            <button type="button" class="q-mini-btn" id="msg-find-btn" title="Find in Messages">${icon("qFind")}<span>Find..</span></button>
                            <button type="button" class="q-mini-btn" id="msg-find-next-btn" title="Find Next Match">${icon("qFind")}<span>Find Next</span></button>
                            <span class="bp-flex"></span>
                            <button type="button" class="q-mini-btn" data-act="clearlog" title="Clear Messages">Clear</button>
                        </div>
                        <div class="msg-table" id="console-log" role="log">
                            <div class="msg-head"><span>Type</span><span>ID</span><span>Message</span></div>
                        </div>
                    </div>

                    <div class="bp-pane hidden" data-pane="terminal">
                        <div class="term-wrap" id="terminal-mount" style="flex:1 1 auto;min-height:0;display:flex;flex-direction:column;"></div>
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
                                    <input type="text" id="serial-tx" placeholder="hex byte(s) to inject on UART_RXD (live)" aria-label="UART send">
                                    <button class="btn" id="serial-tx-btn" title="Inject 8N1 byte(s) on UART_RXD (live mode)">Send</button>
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
                            <section class="display-card" data-disp="live-peri">
                                <header>Live peripheral injection</header>
                                <div class="live-peri-row">
                                    <label>PS/2 <input type="text" id="live-ps2-byte" value="5A" maxlength="2" size="3" aria-label="PS/2 scancode byte (hex)"> <button class="btn" id="live-ps2-send" title="Inject one PS/2 scancode frame">Send</button></label>
                                    <label>IR <input type="text" id="live-ir-addr" value="00" maxlength="2" size="3" aria-label="NEC address (hex)"> <input type="text" id="live-ir-cmd" value="01" maxlength="2" size="3" aria-label="NEC command (hex)"> <button class="btn" id="live-ir-fire" title="Fire one NEC IR frame">Fire</button></label>
                                    <label>LM75 <input type="range" id="live-temp" min="-10" max="80" step="1" value="25" aria-label="LM75 ambient temperature (C)"> <span id="live-temp-val">25 &deg;C</span></label>
                                </div>
                                <div class="lcd-note">Live mode only &mdash; PS/2 scancodes, NEC IR frames and the LM75 ambient register update the running simulation.</div>
                            </section>
                        </div>
                    </div>
                </div>

                <div class="bp-tabs" role="tablist" aria-label="Output dock views">
                    <button type="button" class="bp-tab active" data-btab="system" role="tab" aria-selected="true"><span>System</span></button>
                    <button type="button" class="bp-tab" data-btab="processing" role="tab" aria-selected="false"><span>Processing (<em id="proc-count">0</em>)</span></button>
                    <em class="bp-badge hidden" id="diag-badge" title="Messages">0</em>
                </div>
            </div>
        </div>
    `;

    const panes = {};
    root.querySelectorAll(".bp-pane").forEach((p) => { panes[p.dataset.pane] = p; });
    const wave = createWaveformView(root.querySelector("#wave-wrap"), { onValuesAt: h.onValuesAt });
    const logEl = root.querySelector("#console-log");
    const badge = root.querySelector("#diag-badge");
    const procCountEl = root.querySelector("#proc-count");
    const filterInput = root.querySelector("#msg-filter-text");

    const messages = []; // {stream: "system"|"processing", sev, id, text, file, line, column, el, isProblem}
    let activeSev = "all";
    let filterText = "";
    let activeTab = "system";
    let lastMessageStream = "system";
    let findCursor = -1;
    let lastFindQuery = "";

    function showTab(id) {
        const normalized = id === "diagnostics" ? "processing" : id;
        const paneKey = (normalized === "system" || normalized === "processing") ? "messages" : normalized;
        if (!panes[paneKey]) return;
        activeTab = normalized;
        if (paneKey === "messages") lastMessageStream = normalized;
        root.querySelectorAll(".bp-tab").forEach((t) => {
            const on = t.dataset.btab === normalized;
            t.classList.toggle("active", on);
            t.setAttribute("aria-selected", String(on));
        });
        root.querySelectorAll(".bp-rail-ico, .bp-rail-tab").forEach((t) => {
            const on = t.dataset.rail === paneKey;
            t.classList.toggle("active", on);
            t.setAttribute("aria-selected", String(on));
        });
        Object.entries(panes).forEach(([key, pane]) => pane.classList.toggle("hidden", key !== paneKey));
        if (paneKey === "messages") {
            applyMessageFilter();
            updateCounts();
        }
        if (paneKey === "waveform") setTimeout(() => wave.resize(), 30);
        if (paneKey === "terminal") h.onTerminalShown?.();
    }

    root.addEventListener("click", (e) => {
        const railBtn = e.target.closest("[data-rail]");
        if (railBtn) {
            const section = root.closest("#bottom") || root.parentElement;
            if (section?.classList.contains("collapsed")) {
                section.classList.remove("collapsed");
                h.onCollapsed?.(false);
            }
            const dest = railBtn.dataset.rail === "messages" ? lastMessageStream : railBtn.dataset.rail;
            showTab(dest);
            return;
        }
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
                for (let i = messages.length - 1; i >= 0; i -= 1) {
                    if (messages[i].stream === currentStream()) {
                        messages[i].el.remove();
                        messages.splice(i, 1);
                    }
                }
                updateCounts();
                break;
            default: break;
        }
    });

    root.querySelector("#bp-export-vcd")?.addEventListener("click", () => h.onExportVcd?.());

    const SEV_OF_LEVEL = {
        info: "info", ok: "info", cmd: "info",
        warn: "warning", warning: "warning",
        critical_warning: "critical_warning",
        error: "error",
    };
    const TYPE_ICON = {
        error: () => icon("qErr"),
        critical_warning: () => icon("qCritWarn"),
        warning: () => icon("qWarn"),
        info: () => icon("qInfo"),
    };

    function currentStream() {
        return activeTab === "processing" ? "processing" : "system";
    }

    function matchesFilter(m) {
        if (m.stream !== currentStream()) return false;
        if (activeSev !== "all" && m.sev !== activeSev) return false;
        if (!filterText) return true;
        const hay = `${m.text} ${m.id}`.toLowerCase();
        return hay.includes(filterText.toLowerCase());
    }

    function applyMessageFilter() {
        for (const m of messages) m.el.classList.toggle("hidden", !matchesFilter(m));
    }

    function updateCounts() {
        const stream = currentStream();
        const counts = { error: 0, critical_warning: 0, warning: 0, info: 0 };
        let streamTotal = 0;
        let procTotal = 0;
        for (const m of messages) {
            if (m.stream === "processing") procTotal += 1;
            if (m.stream === stream) {
                streamTotal += 1;
                counts[m.sev] = (counts[m.sev] || 0) + 1;
            }
        }
        root.querySelector("#mf-all").textContent = String(streamTotal);
        root.querySelector("#mf-error").textContent = String(counts.error);
        root.querySelector("#mf-crit").textContent = String(counts.critical_warning);
        root.querySelector("#mf-warning").textContent = String(counts.warning);
        root.querySelector("#mf-info").textContent = String(counts.info);
        if (procCountEl) procCountEl.textContent = String(procTotal);
        badge.textContent = String(counts.error || streamTotal);
    }

    function makeMessageRow(m) {
        const row = document.createElement("div");
        row.className = `msg-row log-line sev-${m.sev}${m.isProblem ? " is-problem" : ""}`;
        row.innerHTML = `<span class="m-type">${(TYPE_ICON[m.sev] || TYPE_ICON.info)()}</span><span class="m-id"></span><span class="m-text"></span>`;
        row.querySelector(".m-id").textContent = m.id || "";
        row.querySelector(".m-text").textContent = m.text;
        if (m.isProblem || (m.file && m.line)) {
            row.title = `Click to jump to ${m.file || "source"}${m.line ? ":" + m.line : ""}`;
            row.addEventListener("click", () => h.onOpenProblem?.({
                file: m.file, line: m.line, column: m.column, severity: m.sev,
                message: m.text,
            }));
        }
        return row;
    }

    function appendMessage(m) {
        const stream = m.stream || "system";
        const entry = { ...m, stream };
        const row = makeMessageRow(entry);
        entry.el = row;
        messages.push(entry);
        logEl.appendChild(row);
        while (messages.length > 1500) {
            const old = messages.shift();
            old.el.remove();
        }
        applyMessageFilter();
        updateCounts();
        requestAnimationFrame(() => { logEl.scrollTop = logEl.scrollHeight; });
    }

    root.querySelectorAll(".msg-filter").forEach((btn) => {
        btn.addEventListener("click", () => {
            activeSev = btn.dataset.sev;
            root.querySelectorAll(".msg-filter").forEach((b) => b.classList.toggle("active", b === btn));
            applyMessageFilter();
        });
    });

    filterInput?.addEventListener("input", (e) => {
        filterText = e.target.value.trim();
        applyMessageFilter();
    });

    function runMessageFind(advance = false) {
        const query = (filterInput?.value || "").trim().toLowerCase() || lastFindQuery;
        if (!query) {
            filterInput?.focus();
            return;
        }
        lastFindQuery = query;
        const visible = messages.filter((m) => !m.el.classList.contains("hidden"));
        messages.forEach((m) => m.el.classList.remove("find-hit"));
        const matches = visible.filter((m) => `${m.id} ${m.text}`.toLowerCase().includes(query));
        if (!matches.length) return;
        findCursor = advance ? (findCursor + 1) % matches.length : 0;
        const hit = matches[findCursor];
        hit.el.classList.add("find-hit");
        hit.el.scrollIntoView({ block: "nearest" });
    }

    root.querySelector("#msg-find-btn")?.addEventListener("click", () => runMessageFind(false));
    root.querySelector("#msg-find-next-btn")?.addEventListener("click", () => runMessageFind(true));

    function stamp() {
        const d = new Date();
        const p = (n, w = 2) => String(n).padStart(w, "0");
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    function log(text, level = "info", stream = "system") {
        appendMessage({ stream, sev: SEV_OF_LEVEL[level] || "info", id: stamp(), text: String(text) });
    }

    function addQuartusMessage(item) {
        const sev = SEV_OF_LEVEL[item?.severity] || "info";
        appendMessage({
            stream: "processing",
            sev,
            id: String(item?.id || ""),
            text: String(item?.message || item?.raw || ""),
            file: item?.file || null,
            line: item?.line || null,
            column: item?.column || null,
            isProblem: Boolean(item?.file && item?.line),
        });
    }

    function clearProcessing() {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].stream === "processing") {
                messages[i].el.remove();
                messages.splice(i, 1);
            }
        }
        updateCounts();
    }

    function setProblems(list = [], stream = "processing") {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].isProblem && messages[i].stream === stream) {
                messages[i].el.remove();
                messages.splice(i, 1);
            }
        }
        for (const item of Array.isArray(list) ? list : []) {
            const sev = item.severity === "error" ? "error"
                : item.severity === "critical_warning" ? "critical_warning"
                : item.severity === "warning" ? "warning" : "info";
            const file = item.file || "design.vhd";
            const line = item.line ? String(item.line) : "";
            appendMessage({
                stream,
                sev,
                id: item.id || (line ? `${file}:${line}` : file),
                text: item.message || String(item),
                file, line: item.line, column: item.column,
                isProblem: true,
            });
        }
        updateCounts();
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

    const liveBytes = [];
    function setLiveUart(bytes, baud) {
        for (const b of bytes || []) {
            liveBytes.push(b & 0xff);
            if (liveBytes.length > 4096) liveBytes.shift();
        }
        if (baud) baudEl.textContent = `baud: ${baud}`;
        framesEl.textContent = `${liveBytes.length} byte(s)`;
        if (liveBytes.length) {
            serialOut.innerHTML = liveBytes.slice(0, 4096).map((b) =>
                `<span class="ser-byte">0x${(b & 0xff).toString(16).toUpperCase().padStart(2, "0")}</span>`).join("");
        }
    }

    function setLiveVga(lines) {
        if (!lines || !Object.keys(lines).length) return;
        vgaNoSig.classList.add("hidden");
        vgaCtx.fillStyle = "#000";
        vgaCtx.fillRect(0, 0, 640, 480);
        const lineIdx = Object.keys(lines).map(Number).sort((a, b) => a - b);
        const bandH = 480 / 525;
        for (const li of lineIdx) {
            let v = Number(lines[li]) || 0;
            for (let s = 0; s < 8; s += 1) {
                const c = v % 8;
                v = Math.floor(v / 8);
                const r = (c & 4) ? 255 : 0;
                const g = (c & 2) ? 255 : 0;
                const b = (c & 1) ? 255 : 0;
                vgaCtx.fillStyle = `rgb(${r},${g},${b})`;
                const x0 = Math.floor(((7 - s) / 8) * 640);
                vgaCtx.fillRect(x0, Math.floor(li * bandH), Math.ceil(640 / 8), Math.ceil(bandH) + 1);
            }
        }
    }

    function parseHexByte(text) {
        const v = parseInt(String(text || "").trim(), 16);
        return Number.isFinite(v) ? v & 0xff : null;
    }
    function wireLivePeripherals() {
        const ps2In = root.querySelector("#live-ps2-byte");
        root.querySelector("#live-ps2-send")?.addEventListener("click", () => {
            const b = parseHexByte(ps2In.value);
            if (b !== null) h.onLivePs2?.(b);
        });
        ps2In?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { const b = parseHexByte(ps2In.value); if (b !== null) h.onLivePs2?.(b); }
        });
        const irA = root.querySelector("#live-ir-addr");
        const irC = root.querySelector("#live-ir-cmd");
        root.querySelector("#live-ir-fire")?.addEventListener("click", () => {
            const a = parseHexByte(irA.value);
            const c = parseHexByte(irC.value);
            if (a !== null && c !== null) h.onLiveIr?.(a, c);
        });
        const temp = root.querySelector("#live-temp");
        const tempVal = root.querySelector("#live-temp-val");
        temp?.addEventListener("input", () => {
            const c = Number(temp.value);
            tempVal.textContent = `${c} \u00b0C`;
            h.onLiveTemp?.(c);
        });
    }
    wireLivePeripherals();

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

    updateCounts();

    return {
        showTab, log, addQuartusMessage, clearProcessing, setProblems,
        setUart, setVga, setLcd, setLiveUart, setLiveVga,
        wave, addProbeChip,
        getTerminalHost: () => root.querySelector("#terminal-mount"),
        get active() { return activeTab; },
        root,
    };
}
