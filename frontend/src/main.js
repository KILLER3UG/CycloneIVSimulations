// main.js — Cyclone IV Studio: wires the SimulIDE-style IDE around Board3D.
//
// Flow: load health/board/examples → compile (REST) → pin check → WS
// sim_start → paced cycle_batch (board + stats + waveform) → sim_done →
// one-shot /api/simulate for decoded peripherals (UART/VGA/LCD).

import "./styles.css";
import { Board3D } from "./board/index.js";
import { ApiClient, SimSession } from "./api.js";
import { createStore } from "./state.js";
import { createToolbar } from "./ui/toolbar.js";
import { createSidebar } from "./ui/sidebar.js";
import { createEditorPanel } from "./ui/editorPanel.js";
import { createBottomPanel } from "./ui/bottomPanel.js";
import { createStatsBlock } from "./ui/stats.js";
import { createInteractions, createBoardOverlay } from "./ui/interactions.js";
import { toast, cheatSheet } from "./ui/toast.js";
import { icon } from "./ui/icons.js";

const store = createStore();
const S = store.state;
const api = new ApiClient();

const $ = (id) => document.getElementById(id);

// ----------------------------------------------------------------- board --
let board = null;
let overlay = null;
let interactions = null;

function initBoard() {
    const host = $("board-host");
    try {
        board = new Board3D(host, {
            quality: "balanced",
            theme: S.theme,
            onPick: (pick) => {
                if (pick?.componentId) {
                    bottom.log(`Focused ${pick.componentId}`, "cmd");
                }
            },
        });
        board.mount();
        board.setPreset("iso");
        interactions = createInteractions(board, host, {
            onPowerToggle: togglePower,
            onDipToggle: toggleDip,
            onProbe: addProbe,
            getPinValue,
        });
        overlay = createBoardOverlay(host);

        // board overlay controls (camera presets + zoom/fit) — index.html
        const presets = $("cam-presets");
        presets.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-preset]");
            if (!btn) return;
            presets.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
            board.setPreset?.(btn.dataset.preset);
        });
        $("bt-zoin").addEventListener("click", () => board.zoomIn?.());
        $("bt-zoout").addEventListener("click", () => board.zoomOut?.());
        $("bt-fit").addEventListener("click", () => board.fit?.());
        return true;
    } catch (err) {
        console.error("WebGL init failed", err);
        host.innerHTML = `
            <div class="webgl-fallback">
                <h2>3D view unavailable</h2>
                <p>The browser could not create a WebGL context, so the board model cannot be rendered.</p>
                <p>Enable hardware acceleration or try a different browser. The rest of the studio (editor, compile, waveform) still works.</p>
            </div>`;
        return false;
    }
}

// ------------------------------------------------------- pin / cycle glue --
let sigPins = new Map();   // lower(port) → [pinId, …]  (from compile board.pins)
let pinValueIndex = new Map(); // pinId → {port, idx}

function buildPinIndexes(boardInfo) {
    sigPins = new Map();
    pinValueIndex = new Map();
    const pins = boardInfo?.pins || {};
    for (const [port, list] of Object.entries(pins)) {
        const arr = Array.isArray(list) ? list : [list];
        sigPins.set(String(port).toLowerCase(), arr.map((p) => String(p).toUpperCase()));
        arr.forEach((p, i) => {
            const key = String(p).toUpperCase();
            if (!pinValueIndex.has(key)) pinValueIndex.set(key, { port, idx: i });
        });
    }
    // fallback: profile pinMap (aliases like CLOCK_50/FPGA_CLK/CLK → PIN_23)
    const pm = S.profile?.pinMap || {};
    for (const [signal, list] of Object.entries(pm)) {
        const base = String(signal).replace(/\[\d+\]$/, "").toLowerCase();
        if (!sigPins.has(base)) {
            const arr = (Array.isArray(list) ? list : [list]).map((p) => String(p).toUpperCase());
            sigPins.set(base, arr);
            arr.forEach((p, i) => { if (!pinValueIndex.has(p)) pinValueIndex.set(p, { port: signal, idx: i }); });
        }
    }
}

function cycleToPinValues(values) {
    const out = {};
    for (const [name, val] of Object.entries(values || {})) {
        const pins = sigPins.get(String(name).toLowerCase());
        if (!pins) continue;
        pins.forEach((pinId, idx) => {
            let level;
            if (typeof val === "number") level = (val >>> idx) & 1;
            else if (typeof val === "string") level = /^[01]/.test(val) ? Number(val[0]) : val;
            else level = val;
            out[pinId] = level;
        });
    }
    return out;
}

function getPinValue(pinId) {
    const entry = pinValueIndex.get(String(pinId).toUpperCase());
    if (!entry) return undefined;
    const v = S.liveValues[entry.port];
    if (v === undefined || v === null) return undefined;
    if (typeof v === "number") return String((v >>> entry.idx) & 1);
    return String(v).toUpperCase();
}

function applyCycleToBoard(cycle) {
    if (!board) return;
    if (!S.power) return; // power off: outputs stay cleared
    board.applyCycle({ pins: cycleToPinValues(cycle.values) }, { time: cycle.time });
}

// ------------------------------------------------------------- components --
let toolbar, sidebar, editor, bottom, stats;

function initComponents() {
    toolbar = createToolbar($("toolbar"), {
        onPower: togglePower,
        onRun: () => run(),
        onRunMode: (mode) => {
            S.programmingMode = mode;
            toolbar.setStatus("idle");
            bottom.log(mode === "as"
                ? "Programming mode: AS flash (persistent) — simulated"
                : "Programming mode: JTAG (volatile)", "cmd");
            if (S.status === "idle" || S.status === "error") run(mode);
        },
        onPause: togglePause,
        onStop: stopSim,
        onReset: resetSim,
        onStep: () => stepSim(1),
        onZoomIn: () => board?.zoomIn?.(),
        onZoomOut: () => board?.zoomOut?.(),
        onFit: () => board?.fit?.(),
        onPreset: (p) => board?.setPreset?.(p),
        onTheme: toggleTheme,
        onHelp: cheatSheet,
        onToggleLeft: () => toggleDrawer("left"),
        onToggleRight: () => toggleDrawer("right"),
    });

    sidebar = createSidebar($("left"), {
        onFocus: (id) => {
            if (!board?.focusComponent?.(id)) toast(`No 3D part for "${id}"`, { kind: "warn" });
        },
        onHighlightPin: (pinId) => {
            if (!board?.highlightPin?.(pinId)) toast(`Pin ${pinId} is not on the 3D model`, { kind: "warn" });
        },
        onExample: (id) => loadExample(id),
        onAttachedChanged: () => {},
        log: (t, l) => bottom.log(t, l),
    });

    editor = createEditorPanel($("right"), {
        initialSource: S.files[0].content,
        onFilesChanged: () => {},
        onRun: () => run(),
        onRunMode: (mode) => {
            S.programmingMode = mode;
            if (S.status === "idle" || S.status === "error") run(mode);
        },
        onDevice: selectDevice,
        onTopEntity: (name) => { S.topEntity = name; },
        onPinOverride: (v) => { S.pinCheck.override = v; },
        onCollapsed: () => setTimeout(() => board?._resize?.(), 60),
        log: (t, l) => bottom.log(t, l),
    });

    bottom = createBottomPanel($("bottompanel"), {
        onOpenProblem: openProblem,
        onValuesAt: (t) => { S.simTimeNs = t; },
    });
    // SimulIDE-style stats card floats over the board (mockup: bottom-left)
    const statsEl = document.createElement("div");
    statsEl.id = "stats";
    $("board-area").appendChild(statsEl);
    stats = createStatsBlock(statsEl);
}

// --------------------------------------------------------------- logging --
function log(text, level = "info") {
    bottom.log(text, level);
}

// -------------------------------------------------------------- drawers --
function toggleDrawer(which) {
    const cls = which === "left" ? "drawer-left" : "drawer-right";
    document.body.classList.toggle(cls);
    syncBackdrop();
}

function syncBackdrop() {
    const open = document.body.classList.contains("drawer-left")
        || document.body.classList.contains("drawer-right");
    const backdrop = $("drawer-backdrop");
    if (backdrop) backdrop.hidden = !open;
}

function setStatus(status, detail = "") {
    S.status = status;
    S.statusDetail = detail;
    toolbar.setStatus(status, detail);
}

// ---------------------------------------------------------------- theme --
function toggleTheme() {
    setTheme(S.theme === "dark" ? "light" : "dark");
}

function setTheme(theme) {
    S.theme = theme;
    document.documentElement.dataset.theme = theme;
    board?.setTheme?.(theme);
    editor?.setTheme(theme === "dark");
    toolbar?.setTheme(theme === "dark");
}

// ---------------------------------------------------------------- power --
function togglePower() {
    setPower(!S.power);
}

function setPower(on) {
    S.power = !!on;
    board?.setPower(S.power);
    toolbar.setPower(S.power);
    log(S.power ? "Board power ON" : "Board power OFF — all outputs cleared", S.power ? "ok" : "warn");
    if (!S.power) overlay?.show();
    else if (S.programmed) overlay?.hide();
}

function toggleDip(index) {
    // The control strip owns stimulus + re-run + 3D sync when a binding
    // exists; without one the 3D DIP stays a visual toggle.
    const btn = document.querySelector(`#bc-row .bc-switch[data-index="${index}"]`);
    if (btn) {
        btn.click();
        return;
    }
    S.dipState = S.dipState || [false, false, false, false];
    S.dipState[index] = !S.dipState[index];
    board?.setDip(index, S.dipState[index]);
    log(`DIP${index + 1} → ${S.dipState[index] ? "ON" : "OFF"}`, "cmd");
}

// ---------------------------------------------------------------- probes --
function addProbe(probe) {
    if (S.probes.some((p) => p.pinId === probe.pinId)) {
        toast(`${probe.pinId} is already probed`, { kind: "warn" });
        return;
    }
    S.probes.push(probe);
    bottom.addProbeChip(probe, () => {
        S.probes = S.probes.filter((p) => p.pinId !== probe.pinId);
    });
    bottom.wave.addProbeSignal(probe.pinId);
    bottom.showTab("wave");
    log(`Probe added: ${probe.label} (${probe.pinId}) → Waveform`, "ok");
}

// ---------------------------------------------------------- backend load --
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

async function checkHealth() {
    try {
        const { httpOk, data } = await api.health();
        const ok = httpOk && data?.ok;
        S.backendOk = ok;
        S.ghdlVersion = data?.version || "";
        $("backend-banner").classList.toggle("hidden", !!ok);
        if (ok) {
            const m = String(S.ghdlVersion).match(/\d+\.\d+\.\d+/);
            log(`Backend ready — GHDL ${m ? m[0] : "available"}`, "ok");
            logModelNotes(data?.device?.modelNotes);
        } else {
            log("Backend health check failed", "error");
        }
    } catch (err) {
        S.backendOk = false;
        $("backend-banner").classList.remove("hidden");
        log(`Backend unreachable: ${err.message}`, "error");
    }
}

async function loadProfile() {
    try {
        const { httpOk, data } = await api.board();
        if (!httpOk || !data?.board) throw new Error(data?.message || `HTTP error`);
        // normalize: board.json shape = {board: {...}, pinMap, facts, device}
        const merged = data.board;
        S.profile = { board: merged, pinMap: merged.pinMap || {}, facts: merged.facts || [], device: data.device };
        S.device = data.device;
        board?.setProfile?.(S.profile);
        sidebar.setProfile(S.profile);
        const hz = merged.clockHz || 50000000;
        S.simStats.targetSpeed = hz;
        log(`Board profile: ${merged.name} (${merged.fpga}) — ${(hz / 1e6).toFixed(0)} MHz`, "info");
    } catch (err) {
        log(`Board profile unavailable: ${err.message}`, "warn");
    }
}

async function loadExamples() {
    try {
        const { httpOk, data } = await api.examples();
        S.examples = httpOk ? (data?.examples || []) : [];
    } catch {
        S.examples = [];
    }
    sidebar.setExamples(S.examples);
}

async function loadExample(id) {
    const ex = S.examples.find((e) => e.id === id);
    if (!ex) return;
    try {
        const { httpOk, data } = await api.example(id);
        const source = httpOk ? (data?.source ?? ex.source) : ex.source;
        editor.setFiles([{ name: ex.file || `${ex.id}.vhd`, content: source }], false);
        editor.setTopEntity(ex.entity || "");
        S.topEntity = ex.entity || "";
        log(`Loaded example: ${ex.name}`, "cmd");
        // auto-fill sensible sim setup for longer examples
        if (/uart/i.test(ex.id)) {
            $("ss-duration").value = "1500";
        }
        if (/sevseg/i.test(ex.id)) {
            // the tubes multiplex every 16384 cycles (~327 µs at 10 ns clock);
            // ~1.5 ms shows two full rotations across all four digits
            $("ss-duration").value = "1500000";
        }
    } catch (err) {
        log(`Failed to load example ${ex.id}: ${err.message}`, "error");
    }
}

async function selectDevice(key) {
    try {
        const { httpOk, data } = await api.selectDevice(key);
        if (!httpOk || !data?.ok) throw new Error(data?.message || "select failed");
        S.deviceKey = key;
        S.device = data.device;
        log(`Device selected: ${data.device?.part || key}`, "ok");
    } catch (err) {
        log(`Device select failed: ${err.message}`, "error");
        editor.setDevice(S.deviceKey);
    }
}

// ------------------------------------------------------------- pin check --
function checkPins(entity) {
    const unknown = [];
    if (!entity) return unknown;
    // The backend resolves profile pins incl. textbook aliases
    // (seven_seg→SEG, dtube→DIG, s1..s4→KEY bits) — trust its result first.
    const compileKeys = Object.keys(S.compileBoard?.pins || {}).map((k) => k.toLowerCase());
    const pm = S.profile?.pinMap || {};
    const keys = Object.keys(pm).map((k) => k.toLowerCase());
    const clockPort = (S.compileBoard?.clock || "").toLowerCase();
    const resetPort = (S.compileBoard?.reset || "").toLowerCase();
    for (const port of entity.ports) {
        const name = String(port.name);
        const lower = name.toLowerCase();
        if (lower === clockPort || lower === resetPort) continue; // harness-driven
        const width = port.width || 1;
        let ok = compileKeys.includes(lower) || keys.includes(lower);
        if (!ok && width > 1) {
            ok = compileKeys.includes(`${lower}[0]`) || compileKeys.some((k) => k.startsWith(`${lower}[`))
                || keys.includes(`${lower}[0]`) || keys.some((k) => k.startsWith(`${lower}[`));
        }
        if (!ok) unknown.push(name);
    }
    return unknown;
}

// ------------------------------------------------- board DIP/keys controls --
// The real board's red DIP shares nets with KEY1–4 (pins 88–91, active-low:
// ON/closed reads 0). The strip binds those nets to the design's input ports
// (KEY/SW buses, or scalar s1..s4-style ports), flips the stimulus constant,
// syncs the 3D switch visual and auto re-runs — so toggling behaves like the
// physical switch bank.
let rerunTimer = null;

function scheduleRerun() {
    if (rerunTimer) clearTimeout(rerunTimer);
    rerunTimer = setTimeout(() => {
        rerunTimer = null;
        if (!S.backendOk) return;
        if (S.running || S.paused) stopSession();
        run();
    }, 250);
}

function boardControlBinding(entity) {
    if (!entity) return null;
    const isClkRst = (p) => {
        const l = p.name.toLowerCase();
        return l === (S.compileBoard?.clock || "").toLowerCase() || l === (S.compileBoard?.reset || "").toLowerCase()
            || /^clk|clock|rst|reset/.test(l);
    };
    const bus = entity.ports.find((p) => p.direction === "in"
        && p.width >= 2 && p.width <= 8 && /key|sw|dip|btn/i.test(p.name));
    if (bus) {
        return { kind: "bus", port: bus.name, width: Math.min(bus.width, 4), bits: [] };
    }
    const scalars = entity.ports.filter((p) => p.direction === "in" && (p.width || 1) === 1 && !isClkRst(p));
    if (scalars.length) return { kind: "scalars", ports: scalars.slice(0, 4), width: Math.min(scalars.length, 4) };
    return null;
}

function buildBoardControls(entity) {
    const wrap = $("board-controls");
    const row = $("bc-row");
    if (!wrap || !row) return;
    const binding = boardControlBinding(entity);
    row.innerHTML = "";
    if (!binding) {
        wrap.classList.add("hidden");
        return;
    }
    wrap.classList.remove("hidden");

    const labels = ["1", "2", "3", "4"];
    for (let i = 0; i < binding.width; i++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "bc-switch";
        btn.dataset.index = String(i);
        let portName, bit;
        if (binding.kind === "bus") {
            portName = binding.port;
            bit = i;
        } else {
            portName = binding.ports[i].name;
            bit = null;
        }
        btn.dataset.port = portName;
        btn.dataset.bit = bit === null ? "" : String(bit);
        btn.innerHTML = `<span class="bc-rocker"></span><span class="bc-label">${binding.kind === "bus" ? "SW" : "S"}${labels[i] || i + 1}</span>`;
        // reflect the current stimulus state (active-low: ON/closed = 0)
        const value = editor.getStimulusValue(portName);
        const on = binding.kind === "bus"
            ? ((value >>> bit) & 1) === 0
            : value === 0;
        btn.classList.toggle("on", on);
        btn.title = `${portName}${bit === null ? "" : `[${bit}]`} — ${on ? "closed (reads 0)" : "open (pull-up reads 1)"} — click to toggle and re-run`;
        btn.addEventListener("click", () => {
            const nowOn = !btn.classList.contains("on");
            btn.classList.toggle("on", nowOn);
            btn.title = `${portName}${bit === null ? "" : `[${bit}]`} — ${nowOn ? "closed (reads 0)" : "open (pull-up reads 1)"} — click to toggle and re-run`;
            if (binding.kind === "bus") {
                const v = editor.getStimulusValue(portName);
                const next = nowOn ? (v & ~(1 << bit)) : (v | (1 << bit));
                editor.setStimulusValue(portName, next);
                board?.setDip?.(i, nowOn);
            } else {
                // scalar key net: ON/closed drives the pin low
                editor.setStimulusValue(portName, nowOn ? 0 : 1);
                board?.pressKey?.(i, nowOn);
            }
            log(`S${labels[i] || i + 1} → ${nowOn ? "closed (0)" : "open (1)"} — re-running…`, "cmd");
            scheduleRerun();
        });
        row.appendChild(btn);
    }
}

// ------------------------------------------------------------------ run --
let session = null;
let cyclesMap = new Map();
let updateAccum = 0;

function stopSession() {
    if (session) {
        session.close();
        session = null;
    }
    S.running = false;
    S.paused = false;
}

function simPayload(sourceOverride) {
    const files = editor.getFiles();
    const hdls = files.filter((f) => /\.(vhd|vhdl|v|sv)$/i.test(f.name));
    const qsf = files.find((f) => /\.qsf$/i.test(f.name));
    const setup = editor.readSetup();
    const boardInfo = S.compileBoard || {};
    const payload = {
        vhdl: sourceOverride ?? (hdls[0]?.content || ""),
        files: hdls,
        top: editor.getTopEntity() || undefined,
        duration: setup.duration,
        clockPeriod: setup.clockPeriod,
        resetCycles: setup.resetCycles,
        resetActiveHigh: !setup.resetActiveLow,
        resetPort: boardInfo.reset || undefined,
        clockPort: boardInfo.clock || undefined,
        stimuli: editor.buildStimuli(boardInfo.clock, boardInfo.reset),
        // capture the whole requested duration (was a flat 4096-cycle cap,
        // which truncated long multiplexed-display runs)
        maxCycles: Math.min(131072, Math.max(100, Math.ceil((setup.duration || 1000) / Math.max(1, setup.clockPeriod || 10)))),
    };
    if (qsf) payload.qsf = qsf.content;
    return payload;
}

async function run(modeOverride) {
    if (S.running || S.paused) {
        toast("A simulation is already active", { kind: "warn" });
        return;
    }
    if (S.backendOk === false) {
        toast("Backend is offline — start it with: python -m backend serve", { kind: "error", timeout: 5000 });
        return;
    }
    const mode = modeOverride || S.programmingMode;
    const files = editor.getFiles();
    const hdls = files.filter((f) => /\.(vhd|vhdl|v|sv)$/i.test(f.name));
    if (!hdls.length) {
        toast("No VHDL/Verilog source file to compile", { kind: "error" });
        return;
    }

    stopSession();
    cyclesMap = new Map();
    bottom.wave.setData([], 0);
    toolbar.setStep(0, "active"); // Analyzing
    setStatus("compiling");
    log(`Compiling ${hdls.map((f) => f.name).join(", ")}…`, "cmd");

    // 1 — compile
    let res;
    try {
        const payload = {
            vhdl: hdls[0].content,
            files: hdls,
            top: editor.getTopEntity() || undefined,
        };
        const qsf = files.find((f) => /\.qsf$/i.test(f.name));
        if (qsf) payload.qsf = qsf.content;
        res = await api.compile(payload);
    } catch (err) {
        toolbar.setStep(0, "error");
        setStatus("error", err.message);
        log(`Compile request failed: ${err.message}`, "error");
        return;
    }

    const problems = [
        ...(res.data?.errors || []),
        ...(res.data?.warnings || []),
    ];
    S.problems = problems;
    bottom.setProblems(problems);
    editor.setProblems(problems);

    if (!res.httpOk || !res.data?.ok) {
        toolbar.setStep(1, "error");
        setStatus("error", "compile failed");
        const errs = res.data?.errors || [];
        log(`Compilation failed${errs.length ? ` — ${errs.length} error(s)` : ""}`, "error");
        for (const e of errs.slice(0, 12)) log(`${e.message || e} (${e.file || "?"}${e.line ? ":" + e.line : ""})`, "error");
        if (!errs.length && res.data?.message) log(res.data.message, "error");
        return;
    }

    S.entity = res.data.entity;
    S.compileResult = res.data;
    S.compileBoard = res.data.board || {};
    buildPinIndexes(S.compileBoard);
    editor.setEntity(S.entity);
    buildBoardControls(S.entity);
    toolbar.setStep(1, "done"); // Compiling done
    log(`Compiled ${S.entity.name}: ${S.entity.ports.length} ports`, "ok");

    // 2 — pin check
    toolbar.setStep(2, "active");
    const unknown = checkPins(S.entity);
    S.pinCheck.unknown = unknown;
    const blocked = unknown.length > 0 && !S.pinCheck.override;
    editor.setPinCheck(unknown, blocked);
    if (unknown.length) {
        log(`Pin check: ${unknown.length} port(s) not on the board profile: ${unknown.join(", ")}`, "warn");
    } else {
        log("Pin check passed — all ports mapped", "ok");
    }
    if (blocked) {
        toolbar.setStep(2, "error");
        setStatus("error", "pin check failed");
        log("Run blocked: fix the unknown ports or tick “Run anyway (override pin check)”.", "error");
        toast("Pin check failed — see Problems / the pin-check banner", { kind: "error" });
        return;
    }
    toolbar.setStep(2, "done");

    // 3 — programming
    toolbar.setStep(3, "active");
    setStatus("programming");
    if (mode === "as") {
        log("AS flash programming is not modeled by the backend — running volatile configuration", "warn");
        toast("AS flash programming is simulated as a volatile JTAG run", { kind: "warn", timeout: 4500 });
    } else {
        log("Programming via JTAG (volatile configuration)…", "cmd");
    }
    board?.setDesign?.(S.compileBoard);
    board?.resetVisual?.();

    // 4 — WS session
    const payload = simPayload();
    session = new SimSession({
        onMessage: (msg) => handleSessionMessage(msg),
        onClose: (byUser) => {
            if (!byUser && (S.running || S.paused)) {
                setStatus("error", "connection lost");
                log("Simulation WebSocket closed unexpectedly", "error");
            }
        },
    });
    try {
        await session.connect();
    } catch (err) {
        toolbar.setStep(3, "error");
        setStatus("error", "websocket failed");
        log(`Could not open simulation session: ${err.message}`, "error");
        return;
    }
    session.start(payload);
}

function handleSessionMessage(msg) {
    switch (msg.type) {
        case "sim_ready": {
            S.signals = msg.signals || [];
            S.totalCycles = msg.totalCycles || 0;
            if (msg.board) {
                S.compileBoard = { ...(S.compileBoard || {}), ...msg.board };
                buildPinIndexes(S.compileBoard);
                board?.setDesign?.(msg.board);
            }
            if (msg.entity) {
                S.entity = msg.entity;
                editor.setEntity(msg.entity);
                buildBoardControls(msg.entity);
            }
            bottom.wave.setSignals(S.signals);
            S.running = true;
            S.paused = false;
            S.programmed = true;
            overlay?.hide();
            board?.setRunning?.(true);
            setStatus("running");
            toolbar.setRunning(true, false);
            editor.setRunState(true, false);
            toolbar.setStep(4, "active"); // Running
            log(`Simulation running — ${S.totalCycles} cycles captured (${(S.simStats.targetSpeed / 1e6).toFixed(0)} MHz clock)`, "ok");
            fetchPeripherals();
            break;
        }
        case "cycle_batch": {
            const t0 = performance.now();
            const cycles = msg.cycles || [];
            for (const c of cycles) cyclesMap.set(c.cycle, c);
            const last = cycles[cycles.length - 1];
            if (last) {
                S.liveValues = last.values || {};
                S.simTimeNs = last.time;
                S.cursorCycle = last.cycle;
                applyCycleToBoard(last);
            }
            if (msg.stats) S.simStats = { ...S.simStats, ...msg.stats };
            bottom.wave.addCycles(cycles);
            sidebar.setLiveValues(S.liveValues);
            stats.update(S);
            updateAccum += performance.now() - t0;
            break;
        }
        case "sim_done": {
            S.running = false;
            S.paused = false;
            const final = msg.final || {};
            S.liveValues = final;
            applyCycleToBoard({ values: final, time: S.simTimeNs });
            setStatus("idle");
            toolbar.setRunning(false, false);
            editor.setRunState(false, false);
            toolbar.setStep(5, "done");
            log(`Simulation complete — ${msg.totalCycles ?? S.totalCycles} cycles, t = ${(S.simTimeNs / 1e3).toFixed(3)} µs`, "ok");
            sidebar.setLiveValues(S.liveValues);
            fetchPeripherals();
            break;
        }
        case "sim_paused": {
            S.paused = true;
            S.running = false;
            setStatus("paused");
            toolbar.setRunning(true, true);
            editor.setRunState(true, true);
            log(`Paused at cycle ${msg.cursor ?? S.cursorCycle}`, "cmd");
            break;
        }
        case "sim_resumed": {
            S.paused = false;
            S.running = true;
            setStatus("running");
            toolbar.setRunning(true, false);
            editor.setRunState(true, false);
            log("Resumed", "cmd");
            break;
        }
        case "sim_reset": {
            S.cursorCycle = 0;
            S.simTimeNs = 0;
            S.liveValues = {};
            const first = Array.from(cyclesMap.values()).sort((a, b) => a.cycle - b.cycle)[0];
            if (first) {
                S.liveValues = first.values;
                applyCycleToBoard(first);
            }
            sidebar.setLiveValues(S.liveValues);
            stats.update(S);
            log("Simulation cursor reset to cycle 0", "cmd");
            break;
        }
        case "sim_stopped": {
            S.running = false;
            S.paused = false;
            setStatus("idle");
            toolbar.setRunning(false, false);
            editor.setRunState(false, false);
            toolbar.setStep(-1);
            log(`Simulation stopped at cycle ${msg.cursor ?? "?"}`, "cmd");
            break;
        }
        case "sim_error": {
            S.running = false;
            S.paused = false;
            setStatus("error", msg.message || "simulation error");
            toolbar.setRunning(false, false);
            editor.setRunState(false, false);
            toolbar.setStep(4, "error");
            log(`Simulation error: ${msg.message || "unknown"}`, "error");
            if (msg.errors?.length) {
                S.problems = msg.errors;
                bottom.setProblems(msg.errors);
                editor.setProblems(msg.errors);
            }
            break;
        }
        case "pong":
        default:
            break;
    }
}

// ------------------------------------------------------------ controls --
function togglePause() {
    if (!session || (!S.running && !S.paused)) {
        toast("No running simulation to pause", { kind: "warn" });
        return;
    }
    if (S.paused) session.resume();
    else session.pause();
}

function stopSim() {
    if (!session || (!S.running && !S.paused)) {
        // nothing live: just reset visuals/status
        setStatus("idle");
        return;
    }
    session.stop();
}

function resetSim() {
    if (!session || (!S.running && !S.paused)) {
        toast("No simulation session — press Run first", { kind: "warn" });
        return;
    }
    session.reset();
}

function stepSim(n) {
    if (!session || !S.paused) {
        toast("Stepping requires a paused simulation", { kind: "warn" });
        return;
    }
    if (n > 0) {
        session.step(n);
    } else {
        // local rewind: re-apply an earlier cycle from the recorded buffer
        const target = Math.max(0, S.cursorCycle + n);
        const cycle = cyclesMap.get(target);
        if (cycle) {
            S.cursorCycle = target;
            S.simTimeNs = cycle.time;
            S.liveValues = cycle.values;
            applyCycleToBoard(cycle);
            sidebar.setLiveValues(S.liveValues);
            stats.update(S);
            log(`Stepped back to cycle ${target}`, "cmd");
        } else {
            toast("No recorded cycle that far back", { kind: "warn" });
        }
    }
}

// ------------------------------------------------- peripherals (detail) --
let peripheralsFetched = 0;
function fetchPeripherals() {
    const stamp = Date.now();
    peripheralsFetched = stamp;
    const payload = simPayload();
    api.simulate(payload).then(({ httpOk, data }) => {
        if (!httpOk || !data?.ok || peripheralsFetched !== stamp) return;
        const per = data.peripherals || {};
        if (per.uart) {
            S.uart = per.uart;
            bottom.setUart(per.uart);
            if (per.uart.frames) log(`UART: ${per.uart.frames} frame(s) decoded at ${per.uart.baud ?? "?"} baud`, "ok");
        }
        if (per.vga) {
            S.vga = per.vga;
            bottom.setVga(per.vga);
        }
        if (per.lcd !== undefined) {
            S.lcd = per.lcd;
            bottom.setLcd(per.lcd);
        }
        if (per.buzzer) {
            S.buzzer = per.buzzer;
            if (per.buzzer.tone) log(`Buzzer: ${per.buzzer.frequency} Hz tone`, "info");
        }
        if (per.eeprom) log("EEPROM dump available (AT24C08)", "info");
    }).catch(() => { /* peripheral detail is best-effort */ });
}

// --------------------------------------------------------------- problems --
function openProblem(p) {
    const file = p.file || editor.getActiveFile();
    editor.openFile(file, p.line, p.column);
    toast(`${p.severity || "error"}: ${String(p.message || "").slice(0, 80)}`, { kind: /warn/i.test(p.severity || "") ? "warn" : "error" });
}

// ----------------------------------------------------------------- stats --
let lastStatsTick = performance.now();
function startLoops() {
    setInterval(() => {
        const now = performance.now();
        const window = now - lastStatsTick;
        lastStatsTick = now;
        S.updateLoad = Math.min(100, (updateAccum / Math.max(1, window)) * 100);
        updateAccum = 0;
        const s = board?.stats?.();
        if (s) {
            S.fps = s.fps;
            S.drawCalls = s.drawCalls;
        }
        stats.update(S);
        sidebar.setLiveValues(S.liveValues);
    }, 250);
}

// ------------------------------------------------------------- shortcuts --
function bindShortcuts() {
    document.addEventListener("keydown", (e) => {
        const inEditor = e.target.closest?.(".monaco-editor, input, textarea, select");
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            run();
            return;
        }
        if (inEditor) return;
        switch (e.key) {
            case "Escape": stopSim(); break;
            case "ArrowRight": if (S.paused) { e.preventDefault(); stepSim(1); } break;
            case "ArrowLeft": if (S.paused) { e.preventDefault(); stepSim(-1); } break;
            case "+": case "=": board?.zoomIn?.(); break;
            case "-": case "_": board?.zoomOut?.(); break;
            case "f": case "F": board?.fit?.(); break;
            case "1": board?.setPreset?.("top"); break;
            case "2": board?.setPreset?.("front"); break;
            case "3": board?.setPreset?.("iso"); break;
            case "4": board?.setPreset?.("ports"); break;
            case "p": case "P": togglePower(); break;
            case "t": case "T": toggleTheme(); break;
            case "?": cheatSheet(); break;
            default: break;
        }
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "b") {
            e.preventDefault();
            toggleDrawer("left");
        }
        if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "b") {
            e.preventDefault();
            $("bottom").classList.toggle("collapsed");
            setTimeout(() => bottom.wave.resize(), 60);
        }
    });

    const backdrop = $("drawer-backdrop");
    if (backdrop) {
        backdrop.addEventListener("click", () => {
            document.body.classList.remove("drawer-left", "drawer-right");
            syncBackdrop();
        });
    }
}

// ----------------------------------------------------------------- init --
async function init() {
    initComponents();
    const ok3d = initBoard();
    if (ok3d) {
        // interactions need `bottom` for logging; rebind handler context
        setTheme("light");
        toolbar.setPower(true);
    }
    bindShortcuts();
    startLoops();

    // retry button on the backend banner
    $("backend-retry").addEventListener("click", async () => {
        $("backend-banner").classList.add("hidden");
        await checkHealth();
        if (S.backendOk) { await loadProfile(); await loadExamples(); }
    });

    await checkHealth();
    await loadProfile();
    await loadExamples();

    // default: load the sevseg_keys example (DIP-driven 4-tube demo);
    // fall back to the counter if it is missing
    const def = S.examples.find((e) => e.id === "sevseg_keys")
        || S.examples.find((e) => /counter/i.test(e.id) || /counter/i.test(e.name));
    if (def) await loadExample(def.id);

    // expose for console poking / tests
    window.__cyclone = { board, state: S, api, run, stopSim, editor, bottom };
    log("Cyclone IV Studio ready — load an example or write VHDL, then press Run (Ctrl+Enter).", "info");
}

init();
