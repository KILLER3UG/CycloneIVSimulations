/* Cyclone IV Studio - frontend for the GHDL-backed VHDL simulator. */
import { Board3D } from "./board3d.js";

(() => {
    "use strict";

    const $ = (id) => document.getElementById(id);

    const dom = {
        exampleSelect: $("example-select"),
        topEntity: $("top-entity"),
        ghdlBadge: $("ghdl-badge"),
        compileBtn: $("compile-btn"),
        runBtn: $("run-btn"),
        editorStatus: $("editor-status"),
        editor: $("editor"),
        gutter: $("gutter"),
        highlight: $("highlight"),
        code: $("code"),
        board: $("board"),
        boardStatus: $("board-status"),
        board3dEl: $("board3d"),
        board2d: $("board-2d"),
        board3dFallback: $("board3d-fallback"),
        displayReadout: $("display-readout"),
        timingOverlay: $("timing-overlay"),
        scanCanvas: $("scan-canvas"),
        timingMode: $("timing-mode"),
        focusDisplay: $("focus-display"),
        resetView: $("reset-view"),
        autoRotate: $("auto-rotate"),
        showTiming: $("show-timing"),
        duration: $("duration"),
        clockPeriod: $("clock-period"),
        resetCycles: $("reset-cycles"),
        resetLow: $("reset-low"),
        stimulus: $("stimulus"),
        runStatus: $("run-status"),
        playBtn: $("play-btn"),
        pauseBtn: $("pause-btn"),
        stopBtn: $("stop-btn"),
        speed: $("speed"),
        clearLog: $("clear-log"),
        log: $("log"),
        showInternals: $("show-internals"),
        zoomOut: $("zoom-out"),
        zoomIn: $("zoom-in"),
        zoomFit: $("zoom-fit"),
        waveform: $("waveform"),
        canvas: $("wave-canvas"),
        tooltip: $("wave-tooltip"),
        waveEmpty: $("wave-empty"),
        statusLeft: $("status-left"),
        statusRight: $("status-right"),
        uploadBtn: $("upload-btn"),
        fileUpload: $("file-upload"),
        dropZone: $("drop-zone"),
        waveDrawer: $("wave-drawer"),
        waveToggle: $("wave-toggle"),
        hoverTip: $("hover-tip"),
        toast: $("interaction-toast"),
        periphLibrary: $("periph-library"),
        periphConnected: $("periph-connected"),
        periphCount: $("periph-count"),
        sceneKey: $("scene-key"),
        sceneGlow: $("scene-glow"),
        sceneFog: $("scene-fog"),
        sceneExposure: $("scene-exposure"),
        sceneOrbit: $("scene-orbit"),
        sceneQuality: $("scene-quality"),
        sceneGrid: $("scene-grid"),
        sceneGhost: $("scene-ghost"),
        sceneReset: $("scene-reset"),
        sceneRandomize: $("scene-randomize"),
    };

    const state = {
        source: "",
        entity: null,
        board: null,
        profile: null,
        waveform: null,
        examples: [],
        currentExample: null,
        stimulusConfig: {},
        busy: false,
        cursorTime: 0,
        view: { t0: 0, t1: 1000 },
        view3d: "3d",
        visible: new Set(),
        showInternals: false,
        playback: { playing: false, index: 0, timer: null },
        drag: null,
        hoverTime: null,
        peripherals: [],
        periphSeq: 0,
        simTimer: null,
    };

    let board3d = null;

    const COLORS = [
        "#5ab0ff", "#f5a524", "#38d6c4", "#b388ff", "#ff7b72",
        "#9ece6a", "#ff9d5c", "#7fdbff", "#e0af68", "#bb9af7",
    ];

    const KEYWORDS = new Set([
        "abs", "access", "after", "alias", "all", "and", "architecture", "array",
        "assert", "attribute", "begin", "block", "body", "buffer", "bus", "case",
        "component", "configuration", "constant", "disconnect", "downto", "else",
        "elsif", "end", "entity", "exit", "file", "for", "function", "generate",
        "generic", "group", "guarded", "if", "impure", "in", "inertial", "inout",
        "is", "label", "library", "linkage", "literal", "loop", "map", "mod", "nand",
        "new", "next", "nor", "not", "null", "of", "on", "open", "or", "others",
        "out", "package", "port", "postponed", "procedure", "process", "pure",
        "range", "record", "register", "reject", "rem", "report", "return", "rol",
        "ror", "select", "severity", "signal", "shared", "sla", "sll", "sra", "srl",
        "subtype", "then", "to", "transport", "type", "unaffected", "units", "until",
        "use", "variable", "wait", "when", "while", "with", "xnor", "xor",
    ]);

    const TYPES = new Set([
        "std_logic", "std_logic_vector", "std_ulogic", "std_ulogic_vector",
        "bit", "bit_vector", "boolean", "integer", "natural", "positive", "signed",
        "unsigned", "real", "time", "character", "string", "severity_level",
    ]);

    // ---------------------------------------------------------------- utils
    function esc(text) {
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    function hex(value, width) {
        if (typeof value !== "number") return String(value).toUpperCase();
        const digits = Math.max(1, Math.ceil(width / 4));
        return "0x" + (value >>> 0).toString(16).toUpperCase().padStart(digits, "0").slice(-digits);
    }

    function formatValue(value, port) {
        if (port && (port.width || 1) > 1) return hex(value, port.width);
        if (value === 1 || value === "1") return "1";
        if (value === 0 || value === "0") return "0";
        return String(value).toUpperCase();
    }

    function bitAt(value, bit) {
        if (typeof value !== "number") return 0;
        return (value >>> bit) & 1;
    }

    function valueAt(signal, time) {
        if (!signal || !signal.transitions.length) return 0;
        let value = signal.transitions[0][1];
        for (const [t, v] of signal.transitions) {
            if (t <= time) value = v;
            else break;
        }
        if (value === "0") return 0;
        if (value === "1") return 1;
        if (typeof value === "string" && /^[01xz]+$/i.test(value)) return value.toUpperCase();
        return value;
    }

    function valuesAt(time) {
        const values = {};
        if (!state.waveform) return values;
        for (const signal of state.waveform.signals) {
            values[signal.name] = valueAt(signal, time);
        }
        return values;
    }

    function parseValue(text, port) {
        const raw = String(text == null ? "0" : text).trim();
        if ((port.width || 1) === 1) {
            if (raw === "1" || raw.toLowerCase() === "true") return 1;
            return 0;
        }
        let value = 0;
        if (/^0x[0-9a-f]+$/i.test(raw)) value = parseInt(raw.slice(2), 16);
        else if (/^[01]+$/.test(raw)) value = parseInt(raw, 2);
        else value = Number(raw);
        return Number.isFinite(value) ? value : 0;
    }

    function parseSequence(text, port) {
        const parts = String(text || "").split(",").map((p) => p.trim()).filter(Boolean);
        const values = parts.map((p) => parseValue(p, port));
        return values.length ? values : [0, 1];
    }

    function niceStep(raw) {
        if (!Number.isFinite(raw) || raw <= 0) return 1;
        const power = Math.pow(10, Math.floor(Math.log10(raw)));
        const n = raw / power;
        const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
        return mult * power;
    }

    function fmtTime(t) {
        if (t >= 1e6) return (t / 1e6).toFixed(2) + " ms";
        if (t >= 1000) return (t / 1000).toFixed(2) + " µs";
        if (t >= 100) return t.toFixed(0) + " ns";
        if (t >= 10) return t.toFixed(1) + " ns";
        return t.toFixed(2) + " ns";
    }

    function portByName(name) {
        if (!state.entity) return null;
        return state.entity.ports.find((p) => p.name === name) || null;
    }

    function isClockPort(port) {
        return state.board && state.board.clock === (port && port.name);
    }

    function isResetPort(port) {
        return state.board && state.board.reset === (port && port.name);
    }

    // --------------------------------------------------------------- logging
    const TAGS = { info: "INFO", ok: " OK ", warn: "WARN", error: "ERR ", cmd: "CMD " };

    function log(message, type = "info", line = null) {
        const row = document.createElement("div");
        row.className = "log-line " + type;
        row.innerHTML = `<span class="tag">${TAGS[type] || "INFO"}</span><span>${esc(message)}</span>`;
        if (line) {
            row.dataset.line = String(line);
            row.title = "Jump to line " + line;
            row.addEventListener("click", () => focusLine(Number(line)));
        }
        dom.log.appendChild(row);
        while (dom.log.children.length > 400) dom.log.removeChild(dom.log.firstChild);
        dom.log.scrollTop = dom.log.scrollHeight;
    }

    function clearLog() {
        dom.log.innerHTML = "";
    }

    function handleErrors(errors) {
        if (!errors || !errors.length) return;
        for (const error of errors.slice(0, 14)) {
            const where = error.line ? ` (line ${error.line}${error.column ? ":" + error.column : ""})` : "";
            log(`${error.message || "error"}${where}`, "error", error.line || null);
        }
        if (errors.length > 14) log(`... ${errors.length - 14} more errors`, "error");
    }

    function setBusy(busy, label) {
        state.busy = busy;
        dom.compileBtn.disabled = busy;
        dom.runBtn.disabled = busy;
        dom.runBtn.classList.toggle("running", busy);
        if (busy) {
            dom.runBtn.textContent = label || "Working…";
            dom.runStatus.textContent = label || "Working…";
        } else {
            dom.runBtn.textContent = "Run simulation";
            dom.runStatus.textContent = "";
        }
    }

    // ---------------------------------------------------------------- editor
    const TOKEN_RE = /(--[^\n]*)|("(?:[^"]|"")*")|('(?:[01xXzZwWhHuUlL\-])')|\b([A-Za-z_]\w*)\b|(\d[\d_]*)|(\*\*|=>|<=|>=|\/=|\?=|:=|<<|>>|[+\-&|=<>()\[\],;:.])/g;

    function highlight(code) {
        let out = "";
        let last = 0;
        let match;
        TOKEN_RE.lastIndex = 0;
        while ((match = TOKEN_RE.exec(code)) !== null) {
            out += esc(code.slice(last, match.index));
            const token = match[0];
            let cls = "";
            if (match[1]) cls = "tok-comment";
            else if (match[2] || match[3]) cls = "tok-string";
            else if (match[4]) {
                const word = match[4].toLowerCase();
                cls = KEYWORDS.has(word) ? "tok-keyword" : TYPES.has(word) ? "tok-type" : "tok-ident";
            } else if (match[5]) cls = "tok-number";
            else if (match[6]) cls = "tok-op";
            out += cls ? `<span class="${cls}">${esc(token)}</span>` : esc(token);
            last = match.index + token.length;
        }
        out += esc(code.slice(last));
        return out;
    }

    function updateEditor() {
        const code = dom.code.value;
        dom.highlight.innerHTML = highlight(code) + "\n";
        const lines = code.split("\n").length;
        let gutter = "";
        for (let i = 1; i <= lines; i += 1) gutter += `<div>${i}</div>`;
        dom.gutter.innerHTML = gutter;
        dom.editorStatus.textContent = `${lines} line${lines === 1 ? "" : "s"}`;
    }

    function focusLine(line) {
        const code = dom.code;
        const lines = code.value.split("\n");
        let pos = 0;
        for (let i = 0; i < Math.max(0, line - 1) && i < lines.length; i += 1) {
            pos += lines[i].length + 1;
        }
        code.focus();
        code.setSelectionRange(pos, pos);
        const lineHeight = parseFloat(getComputedStyle(code).lineHeight) || 19;
        code.scrollTop = Math.max(0, (line - 4) * lineHeight);
        dom.highlight.scrollTop = code.scrollTop;
        dom.gutter.scrollTop = code.scrollTop;
    }

    function bindEditor() {
        dom.code.addEventListener("input", () => {
            state.source = dom.code.value;
            updateEditor();
        });

        dom.code.addEventListener("scroll", () => {
            dom.highlight.scrollTop = dom.code.scrollTop;
            dom.highlight.scrollLeft = dom.code.scrollLeft;
            dom.gutter.scrollTop = dom.code.scrollTop;
        });

        dom.code.addEventListener("keydown", (event) => {
            if (event.key === "Tab") {
                event.preventDefault();
                const start = dom.code.selectionStart;
                const end = dom.code.selectionEnd;
                const value = dom.code.value;
                dom.code.value = value.slice(0, start) + "  " + value.slice(end);
                dom.code.selectionStart = dom.code.selectionEnd = start + 2;
                state.source = dom.code.value;
                updateEditor();
            }
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                compile();
            }
            if (event.key === "F5") {
                event.preventDefault();
                simulate();
            }
        });
    }

    // ------------------------------------------------------------------- api
    async function api(path, options) {
        try {
            const response = await fetch(path, options);
            const data = await response.json().catch(() => ({}));
            return { httpOk: response.ok, data };
        } catch (error) {
            return { httpOk: false, data: { ok: false, message: String(error) } };
        }
    }

    async function checkHealth() {
        const { data } = await api("/api/health");
        if (data && data.ok) {
            const version = String(data.version || "GHDL").split(" ").slice(0, 3).join(" ");
            dom.ghdlBadge.textContent = "GHDL " + (version.match(/\d+\.\d+\.\d+/) || ["ready"])[0];
            dom.ghdlBadge.className = "badge ok";
            dom.statusRight.textContent = version;
            log(`GHDL ready (${version})`, "ok");
            logModelNotes(data.device && data.device.modelNotes);
        } else {
            dom.ghdlBadge.textContent = "GHDL missing";
            dom.ghdlBadge.className = "badge err";
            dom.statusRight.textContent = "GHDL not found";
            log((data && data.error) || "GHDL is not available on this machine.", "error");
        }
    }

    // Load the canonical board profile (board/board.json) so the UI's pin
    // map, polarities and part parameters come from the same source as the
    // backend instead of being hard-coded here.
    async function loadBoardProfile() {
        const { data } = await api("/api/board");
        state.profile = (data && data.board) || null;
        if (state.profile) {
            log(`Board profile: ${state.profile.name} (${state.profile.fpga})`, "info");
        }
        return state.profile;
    }

    // Merge the board profile's device configuration into a simulation's board
    // map. The backend already sends ledConfig/displayConfig, but the profile
    // is authoritative and covers the case where a design has no mapped I/O.
    function applyBoardProfile(board) {
        if (!board) return board;
        const profile = state.profile;
        if (!profile) return board;
        board.ledConfig = board.ledConfig && Object.keys(board.ledConfig).length
            ? board.ledConfig
            : {
                activeLow: profile.leds.activeLow,
                count: profile.leds.count,
                seriesResistor: profile.leds.seriesResistor,
            };
        board.displayConfig = board.displayConfig && Object.keys(board.displayConfig).length
            ? board.displayConfig
            : {
                segBitMap: profile.displays.segBitMap,
                segmentActiveLow: profile.displays.segmentActiveLow,
                digitActiveLow: profile.displays.digitActiveLow,
                multiplexed: profile.displays.multiplexed,
                count: profile.displays.count,
            };
        board.parts = board.parts && Object.keys(board.parts).length
            ? board.parts
            : {
                buzzer: profile.buzzer,
                i2c: profile.i2c,
                infrared: profile.infrared,
                ps2: profile.ps2,
                uart: profile.uart,
                vga: profile.vga,
            };
        board.controlsConfig = board.controlsConfig && Object.keys(board.controlsConfig).length
            ? board.controlsConfig
            : {
                activeLow: profile.buttons.activeLow,
                onValue: profile.switches.onValue,
            };
        return board;
    }

    // Surface what the simulator models per the schematic and which behaviours
    // are still unverified on real hardware (board_spec.md §0/§16-18).
    function logModelNotes(notes) {
        if (!Array.isArray(notes) || !notes.length) return;
        log("Board model notes (RZ-EasyFPGA A2.2):", "cmd");
        for (const note of notes) {
            const unverified = /unverified/i.test(note.status || "");
            log(`${note.topic} — ${note.status}: ${note.detail}`, unverified ? "warn" : "info");
        }
    }

    async function loadExamples() {
        const { data } = await api("/api/examples");
        state.examples = (data && data.examples) || [];
        dom.exampleSelect.innerHTML = "";
        for (const example of state.examples) {
            const option = document.createElement("option");
            option.value = example.id;
            option.textContent = example.name;
            option.title = example.description;
            dom.exampleSelect.appendChild(option);
        }
    }

    function loadExample(id, run = true) {
        const example = state.examples.find((item) => item.id === id);
        if (!example) return;
        state.currentExample = id;
        state.source = example.source;
        state.entity = null;
        state.board = null;
        state.waveform = null;
        state.stimulusConfig = {};
        state.cursorTime = 0;
        dom.code.value = example.source;
        dom.topEntity.value = "";
        dom.duration.value = example.id === "uart_tx" ? "1500" : "1000";
        dom.waveEmpty.classList.remove("hidden");
        if (board3d && board3d.ok) board3d.clearFrame();
        updateEditor();
        renderBoard();
        renderStimulus();
        drawTiming(0);
        log(`Loaded example: ${example.name}`, "cmd");
        if (run) {
            compile().then((ok) => {
                if (ok) simulate();
            });
        }
    }

    // -------------------------------------------------------------- compile
    async function compile() {
        if (state.busy) return false;
        state.source = dom.code.value;
        setBusy(true, "Compiling…");
        log("Compiling design…", "cmd");
        const payload = {
            vhdl: state.source,
            top: dom.topEntity.value.trim() || undefined,
        };
        const { httpOk, data } = await api("/api/compile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        setBusy(false);

        if (!httpOk || !data.ok) {
            handleErrors(data.errors);
            log((data && data.message) || "Compilation failed", "error");
            updateStatus();
            return false;
        }

        state.entity = data.entity;
        state.board = applyBoardProfile(data.board || state.board);
        if (state.board && typeof state.board.resetActiveHigh === "boolean") {
            dom.resetLow.checked = !state.board.resetActiveHigh;
        }
        log(`Compiled ${data.entity.name}: ${data.entity.ports.length} ports`, "ok");
        if (board3d && board3d.ok) {
            board3d.setDesign(state.entity, state.board);
            board3d.clearFrame();
        }
        renderBoard();
        renderStimulus();
        drawTiming(0);
        updateStatus();
        return true;
    }

    // -------------------------------------------------------------- simulate
    function buildStimulus() {
        if (!state.entity) return [];
        const inputs = state.entity.ports.filter(
            (port) => port.direction === "in" && !isClockPort(port) && !isResetPort(port)
        );
        const stimuli = [];
        for (const port of inputs) {
            const config = getConfig(port);
            const kind = config.kind || "constant";
            const value = parseValue(config.value, port);
            stimuli.push({
                port: port.name,
                kind,
                value,
                values: kind === "sequence" ? parseSequence(config.value, port) : [],
                periodCycles: Math.max(1, parseInt(config.period, 10) || 1),
                pulseCycles: Math.max(1, parseInt(config.period, 10) || 1),
            });
        }
        return stimuli;
    }

    async function simulate() {
        if (state.busy) return;
        state.source = dom.code.value;
        if (!state.entity) {
            const ok = await compile();
            if (!ok) return;
        }

        setBusy(true, "Simulating…");
        log("Running GHDL (analyze → elaborate → simulate)…", "cmd");

        const payload = {
            vhdl: state.source,
            top: dom.topEntity.value.trim() || undefined,
            duration: Number(dom.duration.value) || 1000,
            clockPeriod: Number(dom.clockPeriod.value) || 10,
            resetCycles: Math.max(0, parseInt(dom.resetCycles.value, 10) || 0),
            resetActiveHigh: !dom.resetLow.checked,
            resetPort: (state.board && state.board.reset) || undefined,
            clockPort: (state.board && state.board.clock) || undefined,
            stimuli: buildStimulus(),
            maxCycles: 2048,
        };

        const { httpOk, data } = await api("/api/simulate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        setBusy(false);

        if (!httpOk || !data.ok) {
            handleErrors(data.errors);
            log((data && data.message) || "Simulation failed", "error");
            updateStatus();
            return;
        }

        state.waveform = data.waveforms;
        state.board = applyBoardProfile(data.board || state.board);
        state.entity = data.entity || state.entity;
        if (state.board && typeof state.board.resetActiveHigh === "boolean") {
            dom.resetLow.checked = !state.board.resetActiveHigh;
        }
        state.cursorTime = 0;
        const duration = Number(state.waveform.duration) || payload.duration;
        state.view = { t0: 0, t1: duration };

        state.visible = new Set(
            state.waveform.signals
                .filter((signal) => signal.isPort || state.showInternals)
                .map((signal) => signal.name)
        );

        dom.waveEmpty.classList.add("hidden");
        dom.playBtn.disabled = !(state.waveform.cycles || []).length;
        dom.pauseBtn.disabled = true;
        dom.stopBtn.disabled = true;
        stopPlayback();
        updateBoard(state.waveform.final || {});
        if (board3d && board3d.ok) {
            board3d.setDesign(state.entity, state.board);
            board3d.setCycles(state.waveform.cycles || []);
            board3d.setFrame(state.waveform.final || {}, { cycleIndex: 0 });
        }
        renderStimulus();
        drawTiming(0);
        drawWaveform();
        updateStatus();
        refreshPeripheralPorts();
        updatePeripherals(state.waveform.final || {});

        const cycles = (state.waveform.cycles || []).length;
        log(`Simulation complete: ${cycles} clock cycles over ${duration.toFixed(1)} ns`, "ok");
        if (state.waveform.errors && state.waveform.errors.length) handleErrors(state.waveform.errors);
    }

    // -------------------------------------------------------------- stimulus
    function getConfig(port) {
        if (!state.stimulusConfig[port.name]) {
            const existing = state.stimulusConfig[port.name] || {};
            state.stimulusConfig[port.name] = {
                kind: existing.kind || "constant",
                value: existing.value != null ? existing.value : "0",
                period: existing.period || "1",
            };
        }
        return state.stimulusConfig[port.name];
    }

    function renderStimulus() {
        dom.stimulus.innerHTML = "";
        if (!state.entity) {
            dom.stimulus.innerHTML = '<div class="stimulus-empty">Compile a design to configure inputs.</div>';
            return;
        }
        const inputs = state.entity.ports.filter(
            (port) => port.direction === "in" && !isClockPort(port) && !isResetPort(port)
        );
        if (!inputs.length) {
            dom.stimulus.innerHTML = '<div class="stimulus-empty">No free inputs (clock and reset are automatic).</div>';
            return;
        }

        for (const port of inputs) {
            const config = getConfig(port);
            const row = document.createElement("div");
            row.className = "stimulus-row";
            row.innerHTML = `
                <span class="name" title="${esc(port.type)}">${esc(port.name)}</span>
                <select data-field="kind">
                    <option value="constant">constant</option>
                    <option value="toggle">toggle</option>
                    <option value="pulse">pulse</option>
                    <option value="sequence">sequence</option>
                </select>
                <input data-field="value" data-port="${esc(port.name)}" type="text" value="${esc(config.value)}" spellcheck="false">
                <input data-field="period" type="number" min="1" step="1" value="${esc(config.period)}" title="cycles">
            `;
            const select = row.querySelector('[data-field="kind"]');
            const valueInput = row.querySelector('[data-field="value"]');
            const periodInput = row.querySelector('[data-field="period"]');
            select.value = config.kind;
            valueInput.placeholder = port.width > 1 ? "0x00" : "0/1";
            periodInput.title = "period in clock cycles";

            select.addEventListener("change", () => {
                config.kind = select.value;
                valueInput.placeholder = config.kind === "sequence" ? "0,1,2,3" : port.width > 1 ? "0x00" : "0/1";
                if (config.kind === "toggle" || config.kind === "pulse") {
                    valueInput.value = config.kind === "pulse" ? "1" : "0";
                    config.value = valueInput.value;
                }
            });
            valueInput.addEventListener("change", () => {
                config.value = valueInput.value;
                updateSwitchFromConfig(port);
            });
            periodInput.addEventListener("change", () => {
                config.period = String(Math.max(1, parseInt(periodInput.value, 10) || 1));
                periodInput.value = config.period;
            });
            dom.stimulus.appendChild(row);
        }
    }

    // ----------------------------------------------------------------- board
    function segmentSvg() {
        return `
        <svg class="seven-seg" viewBox="0 0 52 92" data-role="display" aria-hidden="true">
            <polygon class="seg" data-seg="a" points="12,4 40,4 35,9 17,9"></polygon>
            <polygon class="seg" data-seg="b" points="42,6 47,11 47,39 42,44 37,39 37,11"></polygon>
            <polygon class="seg" data-seg="c" points="42,46 47,51 47,79 42,84 37,79 37,51"></polygon>
            <polygon class="seg" data-seg="d" points="12,88 17,83 35,83 40,88 35,92 17,92"></polygon>
            <polygon class="seg" data-seg="e" points="10,46 15,51 15,79 10,84 5,79 5,51"></polygon>
            <polygon class="seg" data-seg="f" points="10,6 15,11 15,39 10,44 5,39 5,11"></polygon>
            <polygon class="seg" data-seg="g" points="12,44 17,39 35,39 40,44 35,49 17,49"></polygon>
            <circle class="dot" data-seg="dp" cx="47" cy="88" r="2.6"></circle>
        </svg>`;
    }

    function renderBoard() {
        if (!state.entity || !state.board) {
            dom.board.innerHTML = '<div class="board-empty">Compile a design to populate the board.</div>';
            dom.boardStatus.textContent = "EP4CE6E22C8";
            return;
        }

        const byName = {};
        for (const port of state.entity.ports) byName[port.name] = port;
        let html = "";

        if (state.board.clock || state.board.reset) {
            html += '<div class="board-group"><div class="board-group-title"><span>Clock / reset</span></div><div class="board-chip-row">';
            if (state.board.clock) {
                html += `<span class="chip clock" data-chip="${esc(state.board.clock)}"><span class="dot"></span>${esc(state.board.clock)}</span>`;
            }
            if (state.board.reset) {
                html += `<span class="chip" data-chip="${esc(state.board.reset)}"><span class="dot"></span>${esc(state.board.reset)}</span>`;
            }
            html += "</div></div>";
        }

        const leds = (state.board.leds || []).map((name) => byName[name]).filter(Boolean);
        if (leds.length) {
            html += '<div class="board-group"><div class="board-group-title"><span>LEDs</span><span class="value" data-role="value">0x0</span></div><div class="led-row">';
            for (const port of leds) {
                const bits = Math.min(port.width || 1, 16);
                for (let bit = 0; bit < bits; bit += 1) {
                    html += `<div class="led-cell" data-port="${esc(port.name)}" data-bit="${bit}">
                        <div class="led"></div><span class="led-label">${bit}</span>
                    </div>`;
                }
            }
            html += "</div></div>";
        }

        const displays = (state.board.displays || []).map((name) => byName[name]).filter(Boolean);
        for (const port of displays) {
            html += `<div class="board-group"><div class="board-group-title"><span>${esc(port.name)}</span><span class="value" data-role="value" data-port="${esc(port.name)}">0x0</span></div><div class="seven-seg-row">${segmentSvg()}</div></div>`;
        }

        const switches = (state.board.switches || []).map((name) => byName[name]).filter(Boolean);
        if (switches.length) {
            html += '<div class="board-group"><div class="board-group-title"><span>DIP switches</span><span class="value">click to toggle</span></div><div class="switch-row">';
            for (const port of switches) {
                const bits = Math.min(port.width || 1, 16);
                for (let bit = 0; bit < bits; bit += 1) {
                    html += `<div class="switch-cell"><button class="switch" type="button" data-port="${esc(port.name)}" data-bit="${bit}" title="${esc(port.name)}[${bit}]"></button><span class="led-label">${bit}</span></div>`;
                }
            }
            html += "</div></div>";
        }

        const buttons = (state.board.buttons || []).map((name) => byName[name]).filter(Boolean);
        if (buttons.length) {
            html += '<div class="board-group"><div class="board-group-title"><span>Push buttons</span><span class="value">click to set</span></div><div class="key-row">';
            for (const port of buttons) {
                const bits = Math.min(port.width || 1, 16);
                for (let bit = 0; bit < bits; bit += 1) {
                    html += `<div class="key-cell"><button class="key" type="button" data-port="${esc(port.name)}" data-bit="${bit}" title="${esc(port.name)}[${bit}]"></button><span class="led-label">${bit}</span></div>`;
                }
            }
            html += "</div></div>";
        }

        if (!html) {
            html = '<div class="board-empty">This design has no board-mapped I/O.<br>Use names like <code>led</code>, <code>sw</code>, <code>key</code> or <code>hex0</code>.</div>';
        }

        dom.board.innerHTML = html;
        if (dom.boardStatus) dom.boardStatus.textContent = `${state.entity.name} · ${state.entity.ports.length} ports`;
        bindBoardControls(byName);
        updateBoard({});
    }

    function bindBoardControls(byName) {
        dom.board.querySelectorAll(".switch, .key").forEach((button) => {
            const portName = button.dataset.port;
            const bit = Number(button.dataset.bit);
            const port = byName[portName];
            if (!port) return;
            button.addEventListener("click", () => {
                const config = getConfig(port);
                let value = parseValue(config.value, port);
                const isSwitch = button.classList.contains("switch");
                // Board polarity (RZ-EasyFPGA A2.2): a pressed key pulls the
                // net low, and a DIP switched ON shorts the net low as well.
                if (isSwitch) value ^= (1 << bit);
                else value &= ~(1 << bit);
                config.value = String(value);
                config.kind = "constant";
                button.classList.toggle("on", (value & (1 << bit)) === 0);
                const input = dom.stimulus.querySelector(
                    `.stimulus-row input[data-field="value"][data-port="${portName}"]`
                );
                if (input) input.value = config.value;
                updateBoard({});
            });
            button.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                const port = byName[portName];
                const config = getConfig(port);
                let value = parseValue(config.value, port);
                value &= ~(1 << bit);
                config.value = String(value);
                config.kind = "constant";
                button.classList.remove("on");
                updateBoard({});
            });
        });
    }

    function updateSwitchFromConfig(port) {
        const config = state.stimulusConfig[port.name];
        if (!config) return;
        const value = parseValue(config.value, port);
        dom.board.querySelectorAll(`.switch[data-port="${port.name}"], .key[data-port="${port.name}"]`).forEach((button) => {
            const bit = Number(button.dataset.bit);
            // Board controls are active-low: ON/pressed reads 0 (board.json).
            const activeLow = !!(state.board && state.board.controlsConfig && state.board.controlsConfig.activeLow);
            button.classList.toggle("on", activeLow ? ((value >> bit) & 1) === 0 : Boolean(value & (1 << bit)));
        });
    }

    function updateBoard(values) {
        if (!state.entity || !state.board) return;
        const byName = {};
        for (const port of state.entity.ports) byName[port.name] = port;

        const ledActiveLow = !!(state.board && state.board.ledConfig && state.board.ledConfig.activeLow);
        dom.board.querySelectorAll(".led-cell").forEach((cell) => {
            const port = byName[cell.dataset.port];
            const bit = Number(cell.dataset.bit);
            const value = values[cell.dataset.port];
            const unknown = typeof value === "string" && /[xz]/i.test(value);
            const bitLevel = typeof value === "number" ? (value >>> bit) & 1 : null;
            const lit = !unknown && bitLevel !== null && (ledActiveLow ? bitLevel === 0 : bitLevel === 1);
            cell.classList.toggle("unknown", unknown);
            cell.classList.toggle("on", lit);
        });

        const segMap = (state.board && state.board.displayConfig && state.board.displayConfig.segBitMap)
            || { b: 0, a: 1, c: 2, d: 3, e: 4, f: 5, g: 6, dp: 7 };
        const segActiveLow = !(state.board && state.board.displayConfig && state.board.displayConfig.segmentActiveLow === false);
        dom.board.querySelectorAll(".seven-seg").forEach((svg) => {
            const group = svg.closest(".board-group");
            const portName = group && group.querySelector('[data-role="value"]');
            const name = portName && portName.dataset.port;
            const port = name ? byName[name] : null;
            const value = name ? values[name] : 0;
            if (port) {
                const label = group.querySelector('[data-role="value"]');
                if (label) label.textContent = formatValue(value, port);
            }
            const segValue = typeof value === "number" ? value : null;
            svg.querySelectorAll(".seg").forEach((segment) => {
                const bit = segValue === null ? 1 : (segValue >>> segMap[segment.dataset.seg]) & 1;
                const on = segValue !== null && (segActiveLow ? bit === 0 : bit === 1);
                segment.classList.toggle("on", on);
            });
            const dot = svg.querySelector('[data-seg="dp"]');
            if (dot) {
                const dpBit = segValue === null ? 1 : (segValue >>> 7) & 1;
                dot.classList.toggle("on", segValue !== null && (segActiveLow ? dpBit === 0 : dpBit === 1));
            }
        });

        for (const name of state.board.leds || []) {
            const cell = dom.board.querySelector(`.led-cell[data-port="${name}"]`);
            const group = cell ? cell.closest(".board-group") : null;
            if (group) {
                const port = byName[name];
                const value = values[name] || 0;
                const label = group.querySelector('[data-role="value"]');
                if (label && port) label.textContent = formatValue(value, port);
            }
        }

        for (const name of state.board.switches || []) {
            const port = byName[name];
            const value = values[name] != null ? values[name] : parseValue(getConfig(port).value, port);
            dom.board.querySelectorAll(`.switch[data-port="${name}"]`).forEach((button) => {
                const bit = Number(button.dataset.bit);
                // DIP ON/closed reads 0 on this board.
                button.classList.toggle("on", bitAt(value, bit) === 0);
            });
        }

        for (const name of state.board.buttons || []) {
            const port = byName[name];
            const value = values[name] != null ? values[name] : parseValue(getConfig(port).value, port);
            dom.board.querySelectorAll(`.key[data-port="${name}"]`).forEach((button) => {
                const bit = Number(button.dataset.bit);
                // A pressed key reads 0 on this board.
                button.classList.toggle("on", bitAt(value, bit) === 0);
            });
        }

        dom.board.querySelectorAll("[data-chip]").forEach((chip) => {
            const value = values[chip.dataset.chip];
            chip.classList.toggle("on", bitAt(value, 0) === 1);
        });

        updatePeripherals(values);
    }

    // --------------------------------------------------------------- playback
    function stopPlayback() {
        state.playback.playing = false;
        if (state.playback.timer) {
            clearTimeout(state.playback.timer);
            state.playback.timer = null;
        }
        state.playback.index = 0;
        dom.playBtn.disabled = !(state.waveform && (state.waveform.cycles || []).length);
        dom.pauseBtn.disabled = true;
        dom.stopBtn.disabled = true;
    }

    function startPlayback() {
        if (!state.waveform || !(state.waveform.cycles || []).length || state.playback.playing) return;
        state.playback.playing = true;
        state.playback.index = 0;
        dom.playBtn.disabled = true;
        dom.pauseBtn.disabled = false;
        dom.stopBtn.disabled = false;

        const speed = Math.max(1, Number(dom.speed.value) || 12);
        const interval = 1000 / speed;

        const step = () => {
            if (!state.playback.playing) return;
            const cycles = state.waveform.cycles;
            if (state.playback.index >= cycles.length) {
                stopPlayback();
                updateBoard(state.waveform.final || {});
                if (board3d && board3d.ok) board3d.setFrame(state.waveform.final || {}, { cycleIndex: cycles.length - 1 });
                state.cursorTime = Number(state.waveform.duration) || 0;
                drawTiming(cycles.length - 1);
                drawWaveform();
                return;
            }
            const cycle = cycles[state.playback.index];
            const cycleIndex = state.playback.index;
            state.playback.index += 1;
            state.cursorTime = cycle.time;
            updateBoard(cycle.values || {});
            if (board3d && board3d.ok) board3d.setFrame(cycle.values || {}, { cycleIndex });
            drawTiming(cycleIndex);
            updateStatus();
            drawWaveform();
            state.playback.timer = setTimeout(step, interval);
        };
        step();
    }

    function pausePlayback() {
        if (!state.playback.playing) return;
        state.playback.playing = false;
        if (state.playback.timer) {
            clearTimeout(state.playback.timer);
            state.playback.timer = null;
        }
        dom.playBtn.disabled = false;
        dom.pauseBtn.disabled = true;
        dom.stopBtn.disabled = false;
    }

    // -------------------------------------------------------------- waveform
    const canvas = dom.canvas;
    const ctx = canvas.getContext("2d");
    let canvasW = 800;
    let canvasH = 300;

    const LABEL_W = 138;
    const TOP = 24;
    const BOTTOM = 22;
    const RIGHT = 14;

    function visibleSignals() {
        if (!state.waveform) return [];
        return state.waveform.signals.filter(
            (signal) => (signal.isPort || state.showInternals) && state.visible.has(signal.name)
        );
    }

    function resizeCanvas() {
        const rect = dom.waveform.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvasW = Math.max(320, rect.width);
        canvasH = Math.max(160, rect.height);
        canvas.width = Math.round(canvasW * dpr);
        canvas.height = Math.round(canvasH * dpr);
        canvas.style.width = canvasW + "px";
        canvas.style.height = canvasH + "px";
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawWaveform();
    }

    function drawWaveform() {
        ctx.clearRect(0, 0, canvasW, canvasH);
        ctx.fillStyle = "#0a1017";
        ctx.fillRect(0, 0, canvasW, canvasH);

        if (!state.waveform) {
            dom.waveEmpty.classList.remove("hidden");
            return;
        }

        const signals = visibleSignals();
        if (!signals.length) {
            dom.waveEmpty.textContent = "No signals selected.";
            dom.waveEmpty.classList.remove("hidden");
            return;
        }
        dom.waveEmpty.classList.add("hidden");

        const plotW = Math.max(10, canvasW - LABEL_W - RIGHT);
        const t0 = state.view.t0;
        const t1 = Math.max(state.view.t1, t0 + 1e-9);
        const xOf = (t) => LABEL_W + ((t - t0) / (t1 - t0)) * plotW;
        const tOf = (x) => t0 + ((x - LABEL_W) / plotW) * (t1 - t0);

        const availableH = canvasH - TOP - BOTTOM;
        const rowH = Math.max(18, Math.min(48, availableH / signals.length));
        const startY = TOP + Math.max(0, (availableH - rowH * signals.length) / 2);

        // time grid
        const step = niceStep((t1 - t0) / 9);
        const first = Math.ceil(t0 / step) * step;
        ctx.font = "10px " + getComputedStyle(document.body).fontFamily;
        ctx.textBaseline = "top";
        for (let t = first; t <= t1 + 1e-9; t += step) {
            const x = xOf(t);
            ctx.strokeStyle = "rgba(120, 160, 190, 0.10)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + 0.5, TOP - 6);
            ctx.lineTo(Math.round(x) + 0.5, canvasH - BOTTOM + 4);
            ctx.stroke();
            ctx.fillStyle = "#5f768c";
            ctx.textAlign = "center";
            ctx.fillText(fmtTime(t), x, 6);
        }

        // rows
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        for (let i = 0; i < signals.length; i += 1) {
            const signal = signals[i];
            const yTop = startY + i * rowH;
            const yMid = yTop + rowH / 2;
            const highY = yTop + 6;
            const lowY = yTop + rowH - 7;

            if (i % 2 === 1) {
                ctx.fillStyle = "rgba(255,255,255,0.014)";
                ctx.fillRect(LABEL_W, yTop, plotW, rowH);
            }

            const color = COLORS[i % COLORS.length];
            ctx.fillStyle = color;
            ctx.fillRect(10, yMid - 1.5, 8, 3);

            ctx.fillStyle = "#b9cadb";
            ctx.font = "11px " + getComputedStyle(document.body).fontFamily;
            let label = signal.name;
            if (signal.width > 1) label += ` [${signal.width}]`;
            if (signal.isInternal) label += " ·int";
            ctx.fillText(label, 24, yMid);

            ctx.fillStyle = "#4f6478";
            ctx.font = "9px " + getComputedStyle(document.body).fontFamily;
            ctx.textAlign = "right";
            ctx.fillText(signal.typeName || "", LABEL_W - 8, yMid);
            ctx.textAlign = "left";

            // waveform
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.6;
            ctx.beginPath();

            if (signal.width === 1) {
                const startValue = valueAt(signal, t0) ? 1 : 0;
                let y = startValue ? highY : lowY;
                let x = LABEL_W;
                ctx.moveTo(x, y);
                for (const [t, value] of signal.transitions) {
                    if (t < t0 || t > t1) continue;
                    const nx = xOf(t);
                    const ny = value ? highY : lowY;
                    ctx.lineTo(nx, y);
                    ctx.lineTo(nx, ny);
                    x = nx;
                    y = ny;
                }
                ctx.lineTo(LABEL_W + plotW, y);
                ctx.stroke();
            } else {
                const midY = yMid;
                let lastX = LABEL_W;
                let lastTextX = -1000;
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                for (const [t, value] of signal.transitions) {
                    if (t < t0 || t > t1) continue;
                    const x = xOf(t);
                    ctx.beginPath();
                    ctx.moveTo(x, midY - 6);
                    ctx.lineTo(x, midY + 6);
                    ctx.stroke();
                    if (x - lastTextX > 38) {
                        ctx.fillStyle = color;
                        ctx.font = "10px " + getComputedStyle(document.body).fontFamily;
                        ctx.fillText(formatValue(value, signal), Math.min(x + 4, canvasW - RIGHT - 36), midY);
                        lastTextX = x;
                    }
                    lastX = x;
                }
                ctx.strokeStyle = "rgba(120,160,190,0.18)";
                ctx.beginPath();
                ctx.moveTo(LABEL_W, midY);
                ctx.lineTo(LABEL_W + plotW, midY);
                ctx.stroke();
            }
        }

        // cursor
        const cx = xOf(state.cursorTime);
        if (cx >= LABEL_W && cx <= LABEL_W + plotW) {
            ctx.strokeStyle = "rgba(245,165,36,0.85)";
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(cx + 0.5, TOP - 4);
            ctx.lineTo(cx + 0.5, canvasH - BOTTOM + 4);
            ctx.stroke();
            ctx.setLineDash([]);

            const label = fmtTime(state.cursorTime);
            ctx.font = "10px " + getComputedStyle(document.body).fontFamily;
            const width = ctx.measureText(label).width + 10;
            const bx = Math.min(Math.max(cx - width / 2, LABEL_W), LABEL_W + plotW - width);
            ctx.fillStyle = "rgba(245,165,36,0.16)";
            ctx.strokeStyle = "rgba(245,165,36,0.5)";
            ctx.beginPath();
            ctx.roundRect(bx, canvasH - BOTTOM + 4, width, 15, 4);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#ffd479";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, bx + width / 2, canvasH - BOTTOM + 12);
        }

        // axes
        ctx.strokeStyle = "rgba(120,160,190,0.16)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(LABEL_W + 0.5, TOP - 8);
        ctx.lineTo(LABEL_W + 0.5, canvasH - BOTTOM + 4);
        ctx.lineTo(canvasW - RIGHT, canvasH - BOTTOM + 4);
        ctx.stroke();
    }

    function zoomBy(factor, anchorTime) {
        if (!state.waveform) return;
        const duration = Number(state.waveform.duration) || 1000;
        const t0 = state.view.t0;
        const t1 = state.view.t1;
        const anchor = anchorTime == null ? (t0 + t1) / 2 : anchorTime;
        const newSpan = Math.max(1e-3, (t1 - t0) * factor);
        let newT0 = anchor - ((anchor - t0) / (t1 - t0)) * newSpan;
        let newT1 = newT0 + newSpan;
        if (newT0 < 0) { newT1 -= newT0; newT0 = 0; }
        if (newT1 > duration) { newT0 -= newT1 - duration; newT1 = duration; }
        if (newT0 < 0) { newT0 = 0; newT1 = Math.min(duration, newSpan); }
        state.view = { t0: newT0, t1: Math.max(newT1, newT0 + 1e-3) };
        drawWaveform();
    }

    function fitView() {
        if (!state.waveform) return;
        const duration = Number(state.waveform.duration) || 1000;
        state.view = { t0: 0, t1: duration };
        drawWaveform();
    }

    function eventTime(event) {
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const plotW = Math.max(10, canvasW - LABEL_W - RIGHT);
        const ratio = (x - LABEL_W) / plotW;
        return state.view.t0 + Math.max(0, Math.min(1, ratio)) * (state.view.t1 - state.view.t0);
    }

    function bindWaveform() {
        canvas.addEventListener("wheel", (event) => {
            if (!state.waveform) return;
            event.preventDefault();
            const time = eventTime(event);
            zoomBy(event.deltaY < 0 ? 0.8 : 1.25, time);
        }, { passive: false });

        canvas.addEventListener("mousedown", (event) => {
            if (!state.waveform) return;
            if (event.button !== 0) return;
            const time = eventTime(event);
            state.cursorTime = time;
            state.drag = { x: event.clientX, t0: state.view.t0, t1: state.view.t1 };
            updateBoard(valuesAt(time));
            drawWaveform();
            showTooltip(time, event);
        });

        window.addEventListener("mousemove", (event) => {
            if (!state.waveform) return;
            if (state.drag) {
                const rect = canvas.getBoundingClientRect();
                const plotW = Math.max(10, canvasW - LABEL_W - RIGHT);
                const span = state.drag.t1 - state.drag.t0;
                const delta = ((event.clientX - state.drag.x) / plotW) * span;
                let t0 = state.drag.t0 - delta;
                let t1 = state.drag.t1 - delta;
                const duration = Number(state.waveform.duration) || 1000;
                if (t0 < 0) { t1 -= t0; t0 = 0; }
                if (t1 > duration) { t0 -= t1 - duration; t1 = duration; }
                if (t0 < 0) t0 = 0;
                state.view = { t0, t1: Math.max(t1, t0 + 1e-3) };
                drawWaveform();
                return;
            }
            const rect = canvas.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
                hideTooltip();
                return;
            }
            const time = eventTime(event);
            state.cursorTime = time;
            drawWaveform();
            showTooltip(time, event);
        });

        window.addEventListener("mouseup", () => {
            state.drag = null;
        });

        canvas.addEventListener("mouseleave", hideTooltip);

        dom.zoomIn.addEventListener("click", () => zoomBy(0.7));
        dom.zoomOut.addEventListener("click", () => zoomBy(1.4));
        dom.zoomFit.addEventListener("click", fitView);
    }

    function showTooltip(time, event) {
        if (!state.waveform) return;
        const signals = visibleSignals();
        let rows = "";
        for (const signal of signals.slice(0, 10)) {
            const value = valueAt(signal, time);
            rows += `<div><span style="color:${COLORS[signals.indexOf(signal) % COLORS.length]}">■</span> ${esc(signal.name)} = ${esc(formatValue(value, signal))}</div>`;
        }
        dom.tooltip.innerHTML = `<div style="color:#ffd479;margin-bottom:2px">t = ${esc(fmtTime(time))}</div>${rows}`;
        const rect = dom.waveform.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        dom.tooltip.style.left = Math.max(90, Math.min(canvasW - 90, x)) + "px";
        dom.tooltip.style.top = Math.max(60, y - 8) + "px";
        dom.tooltip.classList.add("visible");
    }

    function hideTooltip() {
        dom.tooltip.classList.remove("visible");
    }

    // ---------------------------------------------------------------- status
    function updateStatus() {
        const parts = [];
        if (state.entity) parts.push(`entity ${state.entity.name}`);
        if (state.waveform) {
            parts.push(`${Number(state.waveform.duration || 0).toFixed(1)} ns`);
            parts.push(`${(state.waveform.cycles || []).length} cycles`);
        }
        parts.push(`cursor ${fmtTime(state.cursorTime)}`);
        dom.statusLeft.textContent = parts.join("  ·  ");
        if (state.board && state.board.clock) {
            dom.statusRight.textContent = `clock ${state.board.clock}` + (state.board.reset ? ` · reset ${state.board.reset}` : "");
        }
    }

    // ------------------------------------------------------------------ 3D board
    function toIntLocal(value) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.trunc(number) : 0;
    }

    function bitLocal(value, index) {
        return (toIntLocal(value) >>> index) & 1;
    }

    function activeDigitLocal(value, width = 4) {
        const v = toIntLocal(value);
        if (width <= 2) return v & 3;
        const set = [];
        for (let i = 0; i < width; i += 1) if (v & (1 << i)) set.push(i);
        if (set.length === 1) return set[0];
        if (set.length === width - 1) {
            for (let i = 0; i < width; i += 1) if (!(v & (1 << i))) return i;
        }
        return -1;
    }

    function toHex(value, digits) {
        return Math.max(0, toIntLocal(value)).toString(16).toUpperCase().padStart(digits, "0");
    }

    function formatReadout(info) {
        if (!info) return "no design loaded";
        if (info.mode === "multiplexed") {
            return `DIG 0x${toHex(info.dig, 2)} · HEX 0x${toHex(info.hex, 2)} · digit ${info.active} · ${info.scanHz} Hz`;
        }
        if (info.mode === "direct") return `${info.displays.length} parallel buses · direct drive`;
        if (info.mode === "static") return `HEX 0x${toHex(info.hex, 2)} · all digits mirror`;
        return "no display ports";
    }

    function initBoard3D() {
        try {
            board3d = new Board3D(dom.board3dEl);
        } catch (error) {
            console.error("Board3D failed:", error);
            board3d = null;
        }
        if (!board3d || !board3d.ok) {
            if (dom.displayReadout) dom.displayReadout.textContent = "3D unavailable";
            return;
        }
        board3d.onReadout = (info) => {
            if (dom.displayReadout) dom.displayReadout.textContent = formatReadout(info);
        };
        board3d.onToggle = (kind, index) => onBoardToggle(kind, index);
        board3d.onHover = (label, x, y) => onBoardHover(label, x, y);
        board3d.setAutoRotate(dom.autoRotate.checked);
        applySceneDefaults();
    }

    function setView(view) {
        state.view3d = view;
        dom.board3dEl.classList.toggle("hidden", view !== "3d");
        dom.board2d.classList.toggle("hidden", view !== "2d");
        document.querySelectorAll("[data-view]").forEach((button) => {
            button.classList.toggle("active", button.dataset.view === view);
        });
        if (board3d && board3d.ok) board3d.setActive(view === "3d");
        if (view === "2d") {
            renderBoard();
            updateBoard(state.waveform ? state.waveform.final || {} : {});
        }
        drawTiming(state.playback.index || 0);
    }

    function drawTiming(index = 0) {
        const canvas = dom.scanCanvas;
        const overlay = dom.timingOverlay;
        if (!canvas || !overlay) return;
        if (!dom.showTiming.checked) {
            overlay.classList.add("hidden");
            return;
        }
        overlay.classList.remove("hidden");

        const rect = canvas.getBoundingClientRect();
        const width = Math.max(240, rect.width || 420);
        const height = Math.max(70, rect.height || 92);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
        }
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const info = board3d && board3d.ok
            ? board3d.getInfo()
            : {
                mode: (state.board && state.board.digits && state.board.digits.length) ? "multiplexed" : "static",
                displays: (state.board && state.board.displays) || [],
                digitPort: state.board && state.board.digits ? state.board.digits[0] : null,
                active: -1,
                hex: 0,
                dig: 0,
                scanHz: 90,
            };

        const cycles = state.waveform && state.waveform.cycles ? state.waveform.cycles : [];
        if (!cycles.length) {
            dom.timingMode.textContent = "no cycles";
            ctx.fillStyle = "#5f768c";
            ctx.font = "9px ui-monospace, monospace";
            ctx.fillText("run a simulation to see the display scan", 8, 18);
            return;
        }
        if (!info || info.mode === "blank" || !info.displays.length) {
            dom.timingMode.textContent = "no display ports";
            ctx.fillStyle = "#5f768c";
            ctx.font = "9px ui-monospace, monospace";
            ctx.fillText("this design has no hex/segment or digit-select port", 8, 18);
            return;
        }

        const labelW = 26;
        const top = 12;
        const bottom = 10;
        const multiplexed = info.mode === "multiplexed";
        const rows = multiplexed ? 11 : 7;
        const rowH = (height - top - bottom) / rows;
        const span = Math.min(14, cycles.length);
        const currentIndex = Math.max(0, Math.min(cycles.length - 1, Math.round(index)));
        const start = Math.max(0, Math.min(currentIndex - Math.floor(span / 2), cycles.length - span));
        const slice = cycles.slice(start, start + span);
        const dx = (width - labelW - 6) / slice.length;
        const rowY = (row) => top + row * rowH;

        // grid
        ctx.strokeStyle = "rgba(120, 160, 190, 0.10)";
        ctx.lineWidth = 1;
        for (let i = 0; i <= slice.length; i += 1) {
            const x = Math.round(labelW + i * dx) + 0.5;
            ctx.beginPath();
            ctx.moveTo(x, top - 2);
            ctx.lineTo(x, height - bottom);
            ctx.stroke();
        }

        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.font = "7.5px ui-monospace, monospace";
        if (multiplexed) {
            for (let d = 0; d < 4; d += 1) {
                ctx.fillStyle = "rgba(245, 165, 36, 0.85)";
                ctx.fillText(`D${d}`, 3, rowY(d) + rowH / 2);
            }
            for (let j = 0; j < 7; j += 1) {
                ctx.fillStyle = "rgba(255, 110, 90, 0.8)";
                ctx.fillText("abcdefg"[j], 3, rowY(4 + j) + rowH / 2);
            }
        } else {
            for (let j = 0; j < 7; j += 1) {
                ctx.fillStyle = "rgba(255, 110, 90, 0.8)";
                ctx.fillText("abcdefg"[j], 3, rowY(j) + rowH / 2);
            }
        }

        // Active digit band and cursor column.
        if (multiplexed) {
            for (let i = 0; i < slice.length; i += 1) {
                const dig = toIntLocal(slice[i].values[info.digitPort]);
                const active = activeDigitLocal(dig, 4);
                if (active >= 0) {
                    ctx.fillStyle = "rgba(245, 165, 36, 0.09)";
                    ctx.fillRect(labelW + i * dx, rowY(active), dx, rowH);
                }
            }
        }
        const cursorX = labelW + (currentIndex - start + 0.5) * dx;
        ctx.strokeStyle = "rgba(245, 165, 36, 0.45)";
        ctx.beginPath();
        ctx.moveTo(cursorX, top - 2);
        ctx.lineTo(cursorX, height - bottom);
        ctx.stroke();

        const drawRow = (row, value, bitIndex, color) => {
            const y = rowY(row);
            for (let i = 0; i < slice.length; i += 1) {
                const on = bitLocal(value, bitIndex) === 1;
                const x = labelW + i * dx;
                ctx.fillStyle = on ? color : "rgba(70, 95, 115, 0.22)";
                if (on) ctx.fillRect(x + 1, y + 1, Math.max(1, dx - 2), Math.max(1.5, rowH * 0.42));
                else ctx.fillRect(x + 1, y + rowH * 0.62, Math.max(1, dx - 2), 1);
            }
        };

        if (multiplexed) {
            for (let d = 0; d < 4; d += 1) {
                drawRow(d, toIntLocal(slice[0].values[info.digitPort]) && slice.map((c) => toIntLocal(c.values[info.digitPort])), d, "rgba(245, 165, 36, 0.95)");
            }
            // drawRow above only draws one value; redo per cycle for the bus rows.
            for (let i = 0; i < slice.length; i += 1) {
                const dig = toIntLocal(slice[i].values[info.digitPort]);
                const hex = toIntLocal(slice[i].values[info.displays[0]]);
                for (let d = 0; d < 4; d += 1) {
                    const y = rowY(d);
                    const on = bitLocal(dig, d) === 1;
                    const x = labelW + i * dx;
                    ctx.fillStyle = on ? "rgba(245, 165, 36, 0.95)" : "rgba(70, 95, 115, 0.22)";
                    ctx.fillRect(x + 1, on ? y + 1 : y + rowH * 0.62, Math.max(1, dx - 2), on ? Math.max(1.5, rowH * 0.42) : 1);
                }
                for (let j = 0; j < 7; j += 1) {
                    const y = rowY(4 + j);
                    const on = bitLocal(hex, 6 - j) === 1;
                    const x = labelW + i * dx;
                    ctx.fillStyle = on ? "rgba(255, 90, 78, 0.9)" : "rgba(70, 95, 115, 0.22)";
                    ctx.fillRect(x + 1, on ? y + 1 : y + rowH * 0.62, Math.max(1, dx - 2), on ? Math.max(1.5, rowH * 0.42) : 1);
                }
            }
            dom.timingMode.textContent = "one-hot · 4 tubes / 7 segments";
        } else {
            const port = info.displays[0];
            for (let i = 0; i < slice.length; i += 1) {
                const hex = toIntLocal(slice[i].values[port]);
                for (let j = 0; j < 7; j += 1) {
                    const y = rowY(j);
                    const on = bitLocal(hex, 6 - j) === 1;
                    const x = labelW + i * dx;
                    ctx.fillStyle = on ? "rgba(255, 90, 78, 0.9)" : "rgba(70, 95, 115, 0.22)";
                    ctx.fillRect(x + 1, on ? y + 1 : y + rowH * 0.62, Math.max(1, dx - 2), on ? Math.max(1.5, rowH * 0.42) : 1);
                }
            }
            dom.timingMode.textContent = info.mode === "direct" ? `${info.displays.length} parallel buses` : "single bus · all digits mirror";
        }
    }

    // ------------------------------------------------------------------ init
    function bindControls() {
        dom.compileBtn.addEventListener("click", compile);
        dom.runBtn.addEventListener("click", simulate);
        dom.clearLog.addEventListener("click", clearLog);
        dom.exampleSelect.addEventListener("change", () => loadExample(dom.exampleSelect.value, true));
        dom.showInternals.addEventListener("change", () => {
            state.showInternals = dom.showInternals.checked;
            if (state.waveform) {
                for (const signal of state.waveform.signals) {
                    if (signal.isPort) state.visible.add(signal.name);
                    if (state.showInternals && signal.isInternal) state.visible.add(signal.name);
                    if (!state.showInternals && signal.isInternal) state.visible.delete(signal.name);
                }
            }
            drawWaveform();
        });
        dom.playBtn.addEventListener("click", startPlayback);
        dom.pauseBtn.addEventListener("click", pausePlayback);
        dom.stopBtn.addEventListener("click", () => {
            stopPlayback();
            state.cursorTime = 0;
            if (state.waveform) updateBoard(state.waveform.final || {});
            drawWaveform();
        });
        dom.speed.addEventListener("input", () => {
            if (state.playback.playing) {
                pausePlayback();
                startPlayback();
            }
        });
    }

    function bindBoardTools() {
        document.querySelectorAll("[data-view]").forEach((button) => {
            button.addEventListener("click", () => setView(button.dataset.view));
        });
        dom.focusDisplay.addEventListener("click", () => {
            if (board3d && board3d.ok) board3d.focusDisplay();
        });
        dom.resetView.addEventListener("click", () => {
            if (board3d && board3d.ok) board3d.resetView();
        });
        dom.autoRotate.addEventListener("change", () => {
            if (board3d && board3d.ok) board3d.setAutoRotate(dom.autoRotate.checked);
        });
        dom.showTiming.addEventListener("change", () => {
            const overlay = dom.timingOverlay;
            if (overlay) overlay.classList.toggle("hidden", !dom.showTiming.checked);
            drawTiming(state.playback.index || 0);
        });
    }

    // ------------------------------------------------------------- file upload
    function initUpload() {
        dom.uploadBtn.addEventListener("click", () => dom.fileUpload.click());
        dom.fileUpload.addEventListener("change", () => {
            const file = dom.fileUpload.files && dom.fileUpload.files[0];
            if (file) readVhdlFile(file);
            dom.fileUpload.value = "";
        });
        const editor = dom.editor;
        ["dragenter", "dragover"].forEach((ev) => editor.addEventListener(ev, (e) => {
            e.preventDefault();
            editor.classList.add("dragover");
        }));
        editor.addEventListener("dragleave", (e) => {
            if (!editor.contains(e.relatedTarget)) editor.classList.remove("dragover");
        });
        editor.addEventListener("drop", (e) => {
            e.preventDefault();
            editor.classList.remove("dragover");
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (file) readVhdlFile(file);
        });
    }

    function readVhdlFile(file) {
        const reader = new FileReader();
        reader.onload = () => loadVhdlText(String(reader.result || ""), file.name);
        reader.onerror = () => log(`Could not read ${file.name}`, "error");
        reader.readAsText(file);
    }

    function loadVhdlText(text, name) {
        state.currentExample = null;
        state.entity = null;
        state.board = null;
        state.waveform = null;
        state.stimulusConfig = {};
        dom.code.value = text;
        state.source = text;
        dom.topEntity.value = "";
        updateEditor();
        renderBoard();
        renderStimulus();
        log(`Loaded file: ${name} (${text.split("\n").length} lines)`, "cmd");
        compile().then((ok) => { if (ok) simulate(); });
    }

    // ----------------------------------------------------------- scene controls
    function initSceneControls() {
        const bind = (el, fn) => el && el.addEventListener("input", fn);
        bind(dom.sceneKey, () => board3d && board3d.ok && board3d.setKeyLight(Number(dom.sceneKey.value)));
        bind(dom.sceneGlow, () => board3d && board3d.ok && board3d.setGlow(Number(dom.sceneGlow.value)));
        bind(dom.sceneFog, () => board3d && board3d.ok && board3d.setFog(Number(dom.sceneFog.value)));
        bind(dom.sceneExposure, () => board3d && board3d.ok && board3d.setExposure(Number(dom.sceneExposure.value)));
        bind(dom.sceneOrbit, () => board3d && board3d.ok && board3d.setOrbitSpeed(Number(dom.sceneOrbit.value)));
        dom.sceneQuality.addEventListener("change", () => board3d && board3d.ok && board3d.setQuality(Number(dom.sceneQuality.value)));
        dom.sceneGrid.addEventListener("change", () => board3d && board3d.ok && board3d.setGrid(dom.sceneGrid.checked));
        dom.sceneGhost.addEventListener("change", () => board3d && board3d.ok && board3d.setGhost(dom.sceneGhost.checked));
        dom.sceneRandomize.addEventListener("click", () => board3d && board3d.ok && board3d.randomizeAngle());
        dom.sceneReset.addEventListener("click", () => {
            dom.sceneKey.value = "2.35"; dom.sceneGlow.value = "1"; dom.sceneFog.value = "0.35";
            dom.sceneExposure.value = "1.08"; dom.sceneOrbit.value = "0.55"; dom.sceneQuality.value = "1.5";
            dom.sceneGrid.checked = false; dom.sceneGhost.checked = false; dom.autoRotate.checked = false;
            if (board3d && board3d.ok) board3d.resetScene();
        });
    }

    function applySceneDefaults() {
        if (!board3d || !board3d.ok) return;
        board3d.setKeyLight(Number(dom.sceneKey.value));
        board3d.setGlow(Number(dom.sceneGlow.value));
        board3d.setFog(Number(dom.sceneFog.value));
        board3d.setExposure(Number(dom.sceneExposure.value));
        board3d.setOrbitSpeed(Number(dom.sceneOrbit.value));
        board3d.setQuality(Number(dom.sceneQuality.value));
        board3d.setGrid(dom.sceneGrid.checked);
        board3d.setGhost(dom.sceneGhost.checked);
    }

    // ------------------------------------------------------------- wave drawer
    function initWaveDrawer() {
        dom.waveToggle.addEventListener("click", () => {
            const collapsed = dom.waveDrawer.classList.toggle("collapsed");
            dom.waveToggle.setAttribute("aria-expanded", String(!collapsed));
            if (!collapsed) { resizeCanvas(); drawWaveform(); }
        });
    }

    // --------------------------------------------------------- board interaction
    function onBoardToggle(kind, index) {
        if (!state.entity || !state.board) { showToast("Load a design first"); return; }
        const names = kind === "switch" ? (state.board.switches || []) : (state.board.buttons || []);
        const byName = {};
        for (const p of state.entity.ports) byName[p.name] = p;
        let port = null, bit = index, acc = 0;
        for (const name of names) {
            const p = byName[name];
            if (!p) continue;
            const w = Math.min(p.width || 1, 16);
            if (index < acc + w) { port = p; bit = index - acc; break; }
            acc += w;
        }
        if (!port) { showToast(kind === "switch" ? "No DIP input in this design" : "No KEY input in this design"); return; }
        const config = getConfig(port);
        let value = parseValue(config.value, port);
        value ^= (1 << bit);
        config.value = String(value);
        config.kind = "constant";
        const input = dom.stimulus.querySelector(`.stimulus-row input[data-field="value"][data-port="${port.name}"]`);
        if (input) input.value = config.value;
        const on = (value & (1 << bit)) === 0;
        showToast(`${kind === "switch" ? "DIP" : "KEY"} ${index + 1} → ${on ? "ON (0)" : "OFF (1)"} · re-running`);
        if (board3d && board3d.ok) {
            if (kind === "switch" && board3d.switchCells[index]) board3d.setSwitch(board3d.switchCells[index], on);
            if (kind === "key" && board3d.keyCells[index]) board3d.setKey(board3d.keyCells[index], on);
        }
        scheduleSimulate();
    }

    function scheduleSimulate() {
        if (state.simTimer) clearTimeout(state.simTimer);
        state.simTimer = setTimeout(() => { state.simTimer = null; simulate(); }, 180);
    }

    function onBoardHover(label, x, y) {
        const tip = dom.hoverTip;
        if (!label) { tip.classList.add("hidden"); return; }
        const stage = dom.board3dEl.getBoundingClientRect();
        tip.textContent = label;
        tip.style.left = (x - stage.left) + "px";
        tip.style.top = (y - stage.top) + "px";
        tip.classList.remove("hidden");
    }

    let toastTimer = null;
    function showToast(msg) {
        dom.toast.textContent = msg;
        dom.toast.classList.remove("hidden");
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => dom.toast.classList.add("hidden"), 1800);
    }

    // -------------------------------------------------------------- peripherals
    const PERIPH_TYPES = [
        { type: "ledbar", name: "LED bar", icon: "▮", desc: "8 discrete LEDs", prefer: "led" },
        { type: "lcd", name: "1602 LCD", icon: "▭", desc: "Character display", prefer: null },
        { type: "servo", name: "Servo", icon: "◔", desc: "PWM horn angle", prefer: null },
        { type: "bargraph", name: "Bargraph", icon: "▥", desc: "10-level meter", prefer: null },
    ];

    function outputPorts() {
        if (!state.entity) return [];
        return state.entity.ports.filter((p) => p.direction === "out" || p.direction === "inout");
    }

    function initPeripherals() {
        renderPeriphLibrary();
        renderPeriphConnected();
    }

    function renderPeriphLibrary() {
        dom.periphLibrary.innerHTML = "";
        for (const def of PERIPH_TYPES) {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "periph-item";
            item.innerHTML = `<span class="pi-icon">${def.icon}</span><span class="pi-name">${def.name}</span><span class="pi-desc">${def.desc}</span>`;
            item.addEventListener("click", () => connectPeripheral(def));
            dom.periphLibrary.appendChild(item);
        }
    }

    function connectPeripheral(def) {
        if (!board3d || !board3d.ok) { showToast("3D view unavailable"); return; }
        if (state.peripherals.length >= 6) { showToast("All 6 expansion slots used"); return; }
        const id = "p" + (state.periphSeq += 1);
        const outs = outputPorts();
        let bind = "";
        if (def.prefer) {
            const pref = outs.find((p) => p.name.toLowerCase().includes(def.prefer));
            bind = pref ? pref.name : (outs[0] ? outs[0].name : "");
        } else {
            bind = outs[0] ? outs[0].name : "";
        }
        const entry = { id, type: def.type, name: def.name, icon: def.icon, bind };
        state.peripherals.push(entry);
        board3d.attachPeripheral(id, def.type, { label: def.name });
        renderPeriphConnected();
        updatePeripherals(state.waveform ? state.waveform.final || {} : {});
        log(`Connected ${def.name}${bind ? " → " + bind : ""}`, "ok");
        showToast(`${def.name} connected`);
    }

    function disconnectPeripheral(id) {
        const i = state.peripherals.findIndex((p) => p.id === id);
        if (i < 0) return;
        const [entry] = state.peripherals.splice(i, 1);
        if (board3d && board3d.ok) board3d.detachPeripheral(id);
        renderPeriphConnected();
        log(`Disconnected ${entry.name}`, "cmd");
    }

    function renderPeriphConnected() {
        dom.periphConnected.innerHTML = "";
        dom.periphCount.textContent = `${state.peripherals.length} connected`;
        if (!state.peripherals.length) {
            const empty = document.createElement("div");
            empty.className = "periph-empty";
            empty.textContent = "No modules connected. Pick one above to plug it into the board.";
            dom.periphConnected.appendChild(empty);
            return;
        }
        const outs = outputPorts();
        for (const p of state.peripherals) {
            const card = document.createElement("div");
            card.className = "periph-card";
            card.id = "periph-card-" + p.id;
            const options = ['<option value="">— bind port —</option>']
                .concat(outs.map((o) => `<option value="${esc(o.name)}"${o.name === p.bind ? " selected" : ""}>${esc(o.name)} [${o.width || 1}]</option>`))
                .join("");
            card.innerHTML = `
                <div class="periph-card-head">
                    <span class="periph-card-title"><span class="pi-icon">${p.icon}</span>${esc(p.name)}</span>
                    <button class="periph-remove" type="button" title="Disconnect">✕</button>
                </div>
                <div class="periph-bind"><label>Port</label><select>${options}</select></div>
                <div class="periph-readout">bind a port</div>`;
            card.querySelector(".periph-remove").addEventListener("click", () => disconnectPeripheral(p.id));
            card.querySelector("select").addEventListener("change", (e) => {
                p.bind = e.target.value;
                updatePeripherals(state.waveform ? state.waveform.final || {} : {});
            });
            dom.periphConnected.appendChild(card);
        }
    }

    function refreshPeripheralPorts() {
        const outs = outputPorts();
        const names = new Set(outs.map((o) => o.name));
        for (const p of state.peripherals) {
            if (p.bind && !names.has(p.bind)) p.bind = outs[0] ? outs[0].name : "";
        }
        renderPeriphConnected();
    }

    function updatePeripherals(values) {
        if (!board3d || !board3d.ok || !state.peripherals.length) return;
        const byName = {};
        if (state.entity) for (const p of state.entity.ports) byName[p.name] = p;
        const ledNames = (state.board && state.board.leds) || [];
        for (const p of state.peripherals) {
            const port = byName[p.bind];
            const width = port ? (port.width || 1) : 8;
            const raw = port && values[p.bind] != null ? values[p.bind] : 0;
            const value = toIntLocal(raw);
            const activeLow = ledNames.includes(p.bind);
            const max = ((1 << Math.min(width, 16)) - 1) || 1;
            const meta = { activeLow, max };
            if (p.type === "lcd") meta.text = port ? "0x" + (value >>> 0).toString(16).toUpperCase() : "----";
            board3d.updatePeripheral(p.id, value, meta);
            const ro = document.querySelector(`#periph-card-${p.id} .periph-readout`);
            if (ro) {
                if (!port) ro.textContent = "bind a port";
                else if (p.type === "servo") ro.textContent = `${p.bind} = ${value} → ${Math.round((value / max) * 180 - 90)}°`;
                else ro.textContent = `${p.bind} = 0x${(value >>> 0).toString(16).toUpperCase()} · ${value}`;
            }
        }
    }

    async function init() {
        bindEditor();
        bindControls();
        bindBoardTools();
        bindWaveform();
        initUpload();
        initSceneControls();
        initPeripherals();
        initWaveDrawer();
        initBoard3D();
        setView("3d");
        updateEditor();
        const initial = `-- Cyclone IV VHDL simulator\n-- Write an entity and architecture, then press F5.\n\nlibrary ieee;\nuse ieee.std_logic_1164.all;\n\nentity counter is\n    port (\n        clk   : in  std_logic;\n        reset : in  std_logic;\n        led   : out std_logic_vector(7 downto 0)\n    );\nend entity counter;\n\narchitecture rtl of counter is\n    signal count : unsigned(7 downto 0) := (others => '0');\nbegin\n    process (clk, reset)\n    begin\n        if reset = '1' then\n            count <= (others => '0');\n        elsif rising_edge(clk) then\n            count <= count + 1;\n        end if;\n    end process;\n\n    led <= std_logic_vector(count);\nend architecture rtl;\n`;
        dom.code.value = initial;
        state.source = initial;
        updateEditor();
        await checkHealth();
        await loadBoardProfile();
        await loadExamples();
        if (state.examples.length) {
            dom.exampleSelect.value = state.examples[0].id;
            loadExample(state.examples[0].id, true);
        }
        resizeCanvas();
        window.addEventListener("resize", resizeCanvas);
        if (window.ResizeObserver) {
            new ResizeObserver(() => resizeCanvas()).observe(dom.waveform);
        }
    }

    init();
})();