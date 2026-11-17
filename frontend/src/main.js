// main.js — Cyclone IV Studio: wires the Quartus-inspired IDE around Board3D.
//
// Flow: resolve active/pinned top-level + dependency tree -> validate Pin
// Planner -> compile (REST) -> load board & WS simulate -> stream cycles / live
// board updates driven exclusively through the Pin Planner table.

import "./styles.css";
import { Board3D } from "./board/index.js";
import { ApiClient, SimSession } from "./api.js";
import { createStore } from "./state.js";
import { createToolbar } from "./ui/toolbar.js";
import { createSidebar } from "./ui/sidebar.js";
import { createEditorPanel } from "./ui/editorPanel.js";
import { createBottomPanel } from "./ui/bottomPanel.js";
import { createStatsBlock } from "./ui/stats.js";
import { createInteractions } from "./ui/interactions.js";
import { dialog, toast, cheatSheet } from "./ui/toast.js";
import { icon } from "./ui/icons.js";
import { audio } from "./audio.js";
import { detectDownCounter, measureBuzzer, noteSeconds } from "./buzzerModel.js";

const store = createStore();
const S = store.state;
const api = new ApiClient();

const $ = (id) => document.getElementById(id);

const RIGHT_COLLAPSED_KEY = "c4_right_collapsed";
const LEFT_COLLAPSED_KEY = "c4_left_collapsed";

function loadCollapsedPref(key) {
    try {
        return localStorage.getItem(key) === "1";
    } catch {
        return false;
    }
}

function saveCollapsedPref(key, collapsed) {
    try {
        localStorage.setItem(key, collapsed ? "1" : "0");
    } catch {
        // ignore storage restrictions
    }
}

// ----------------------------------------------------------------- board --
let board = null;
let interactions = null;

function initBoard() {
    const host = $("board-host");
    try {
        board = new Board3D(host, {
            quality: "balanced",
            theme: S.theme,
            onPick: (pick) => {
                if (pick?.componentId) bottom.log(`Focused ${pick.componentId}`, "cmd");
            },
        });
        board.mount();
        board.setPreset("iso");
        if (board.gpuIsSoftware) {
            log(`3D rendering is on a SOFTWARE rasterizer (${board.gpuName}) — every frame is CPU-drawn. Enable hardware acceleration in your browser settings.`, "warn");
        } else {
            log(`3D renderer (GPU): ${board.gpuName}`, "info");
        }
        interactions = createInteractions(board, host, {
            onPowerToggle: togglePower,
            onDipToggle: toggleDip,
            onKeyPress: (index, down) => setPhysicalKeyPressed(index, down),
            onResetPress: (down) => { if (down) pressBoardReset(); },
            onProbe: addProbe,
            getPinValue,
        });

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
                <p>The editor, Pin Planner, compile, and waveform tools still work.</p>
            </div>`;
        return false;
    }
}

// ------------------------------------------------------- pin / cycle glue --
let sigPins = new Map();       // lower(port) -> [pinId_bit0, pinId_bit1, ...] ("" if unassigned)
let pinValueIndex = new Map(); // pinId -> { port, idx }

// Strictly derive signal-to-package-pin routes ONLY from compileBoard.pins
// (which comes from the Pin Planner table). Unassigned ports are never mapped.
function buildPinIndexes(boardInfo) {
    sigPins = new Map();
    pinValueIndex = new Map();
    const pins = boardInfo?.pins || {};
    for (const [port, list] of Object.entries(pins)) {
        const arr = Array.isArray(list) ? list : [list];
        const norm = arr.map((p) => (p ? String(p).toUpperCase() : ""));
        sigPins.set(String(port).toLowerCase(), norm);
        norm.forEach((pinId, i) => {
            if (pinId && !pinValueIndex.has(pinId)) pinValueIndex.set(pinId, { port, idx: i });
        });
    }
}

function cycleToPinValues(values) {
    const out = {};
    for (const [name, val] of Object.entries(values || {})) {
        const pins = sigPins.get(String(name).toLowerCase());
        if (!pins) continue;
        pins.forEach((pinId, idx) => {
            if (!pinId) return;
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
    if (!board || !S.power) return;
    board.applyCycle({ pins: cycleToPinValues(cycle.values) }, { time: cycle.time });
}

// ------------------------------------------------------------- components --
let toolbar, sidebar, editor, bottom, stats;

function resizeBoardSoon() {
    requestAnimationFrame(() => board?._resize?.());
    setTimeout(() => board?._resize?.(), 60);
}

// --------------------------------------------------------------- buzzer ----
let buzzerStopTimer = null;

function clearBuzzerTimer() {
    if (buzzerStopTimer) {
        clearTimeout(buzzerStopTimer);
        buzzerStopTimer = null;
    }
}

function updateAudioBadge() {
    const badge = $("tb-audio-badge");
    if (badge) badge.textContent = audio.badge();
    const btn = $("tb-mute");
    if (btn) {
        btn.innerHTML = icon(audio.muted ? "mute" : "volume");
        btn.classList.toggle("muted", audio.muted);
        btn.setAttribute("aria-pressed", String(audio.muted));
        btn.title = audio.muted ? "Unmute buzzer (M)" : "Mute buzzer (M)";
    }
    const vol = $("tb-volume");
    if (vol && document.activeElement !== vol) vol.value = String(Math.round(audio.volume * 100));
}

async function toggleMute() {
    await audio.ensure();
    audio.setMuted(!audio.muted);
    updateAudioBadge();
}

// Start/refresh the tone from the cycle-accurate buzzer decode. The backend
// measures edges in simulated ns; measureBuzzer converts them to 50 MHz cycles.
function applyBuzzerAudio(per, clockNs) {
    clearBuzzerTimer();
    if (!per || typeof per !== "object") {
        audio.silence();
        updateAudioBadge();
        return;
    }
    const m = measureBuzzer(per.edges, clockNs, per.activeLow !== false);
    if (m.tone) {
        audio.tone(m.frequency, m.duty).then(updateAudioBadge).catch(() => {});
        log(`Buzzer: ${m.frequency} Hz (${m.cyclesPerPeriod} cycles/period, ${(m.duty * 100).toFixed(0)}% duty)`, "info");
    } else {
        audio.silence();
        updateAudioBadge();
        // Passive speaker + PNP high-side: a steady LOW is DC, not a tone.
        if (per.tone) log(`Buzzer: ${per.frequency} Hz tone`, "info");
    }
    S.buzzer = { ...per, ...m };
}

// After the capture, schedule the 1 s countdown from the design's own loaded
// down-counter (buzz1: sec_counter = 49,999,999 at release). No wall-clock
// guessing and no multi-second GHDL run.
function scheduleBuzzerStop(clockNs, countdown = null) {
    const b = S.buzzer || {};
    if (b.level === 1) return; // already silent at the end of the capture
    let found = countdown;
    if (!found) {
        const cycles = Array.from(cyclesMap.values()).sort((a, b2) => a.cycle - b2.cycle);
        found = detectDownCounter(cycles, 1000);
    }
    if (!found) return; // no terminal count -> keep the tone until stop/next run
    const secs = noteSeconds(found.terminal, clockNs);
    if (secs > 0.02 && secs < 60) {
        buzzerStopTimer = setTimeout(() => {
            audio.silence();
            updateAudioBadge();
            buzzerStopTimer = null;
            log(`Buzzer: ${found.name} expired -> silent`, "info");
        }, secs * 1000);
        log(`Buzzer: ${found.name} loaded ${found.terminal} cycles -> ${secs.toFixed(3)} s note`, "info");
    }
}

function initComponents() {
    toolbar = createToolbar($("toolbar"), {
        onPower: togglePower,
        onPause: togglePause,
        onStop: stopSim,
        onReset: resetSim,
        onStep: () => stepSim(1),
        onZoomIn: () => board?.zoomIn?.(),
        onZoomOut: () => board?.zoomOut?.(),
        onFit: () => board?.fit?.(),
        onPreset: (p) => board?.setPreset?.(p),
        onTheme: toggleTheme,
        onMute: toggleMute,
        onHelp: cheatSheet,
        onAbout: () => showAboutDialog(),
        onToggleLeft: () => toggleDrawer("left"),
        onToggleRight: () => toggleDrawer("right"),
    });

    // Buzzer volume + persisted mute state.
    const vol = $("tb-volume");
    if (vol) {
        vol.value = String(Math.round(audio.volume * 100));
        vol.addEventListener("input", async () => {
            await audio.ensure();
            audio.setVolume(Number(vol.value) / 100);
            updateAudioBadge();
        });
    }
    updateAudioBadge();

    sidebar = createSidebar($("left"), {
        onFocus: (id) => {
            if (!board?.focusComponent?.(id)) toast(`No 3D part for "${id}"`, { kind: "warn" });
        },
        onHighlightPin: (pinId) => {
            if (!board?.highlightPin?.(pinId)) toast(`Pin ${pinId} is not mapped to a visible 3D part`, { kind: "info" });
        },
        onExample: (id) => loadExample(id),
        onAttachedChanged: () => {},
        onPinAssignmentsChanged: () => {
            if (S.programmed && S.compileResult?.ok) {
                syncLivePinBindings();
            }
        },
        onCollapsed: (collapsed) => {
            saveCollapsedPref(LEFT_COLLAPSED_KEY, collapsed);
            resizeBoardSoon();
        },
        log: (t, l) => bottom.log(t, l),
    });

    editor = createEditorPanel($("right"), {
        initialSource: S.files[0].content,
        onFilesChanged: () => syncPlannerToActiveTop(),
        onTopContextChanged: (ctx) => syncPlannerToTopContext(ctx),
        onQsfUploaded: (qsfText, qsfName) => {
            syncPlannerToActiveTop();
            sidebar.importQsfText(qsfText, qsfName);
        },
        onFilesUploaded: () => {},
        onRun: () => compileAndProgram(),
        onDevice: selectDevice,
        onCollapsed: (collapsed) => {
            saveCollapsedPref(RIGHT_COLLAPSED_KEY, collapsed);
            resizeBoardSoon();
        },
        log: (t, l) => bottom.log(t, l),
    });

    bottom = createBottomPanel($("bottompanel"), {
        onOpenProblem: openProblem,
        onValuesAt: (t) => { S.simTimeNs = t; },
    });

    const statsEl = document.createElement("div");
    statsEl.id = "stats";
    $("board-area").appendChild(statsEl);
    stats = createStatsBlock(statsEl);
}

function showAboutDialog() {
    const ver = S.appVersion || "0.1.0";
    const html = `
        <p style="margin-bottom:10px;"><b>Cyclone IV Studio v${ver}</b> — Interactive RZ-EasyFPGA A2.2 (EP4CE6E22C8N) FPGA Simulator.</p>
        <div class="ic-title">Third-Party & Open-Source Licenses</div>
        <ul style="padding-left:18px;margin:6px 0 10px;line-height:1.55;">
            <li><b>GHDL</b> (bundled VHDL compiler &amp; simulator): GNU General Public License v2+ (GPL-2.0-or-later). Source code is available under the GPL written source offer in <code>THIRD_PARTY_LICENSES.md</code> and at <a href="https://github.com/ghdl/ghdl" target="_blank" rel="noreferrer">github.com/ghdl/ghdl</a>.</li>
            <li><b>FastAPI, Uvicorn, WebSockets, Starlette, Pydantic</b>: MIT / BSD licenses.</li>
            <li><b>Three.js, Monaco Editor, JSZip, Vite, Vitest</b>: MIT licenses.</li>
            <li><b>Tauri</b> (desktop shell): MIT / Apache-2.0 licenses.</li>
        </ul>
        <p style="font-size:11px;color:var(--muted);">Vendor schematic PDFs and proprietary binary bitstream images are excluded from redistribution; only derived open pin-map metadata (<code>board/board.json</code>) is shipped.</p>
    `;
    dialog({
        title: `About Cyclone IV Studio v${ver}`,
        body: html,
        actions: [{ label: "Close", kind: "primary" }],
        wide: true,
    });
}

function syncPlannerToTopContext(ctx) {
    if (ctx?.entityObj) {
        sidebar.setEntity(ctx.entityObj);
        applyKeyDefaultsToEditor(ctx.entityObj, sidebar.getPinPlan());
    } else if (!ctx?.topFile) {
        sidebar.setEntity(null);
    }
}

function syncPlannerToActiveTop() {
    const ctx = editor?.getTopContext?.();
    syncPlannerToTopContext(ctx);
}

function log(text, level = "info") {
    bottom.log(text, level);
}

// -------------------------------------------------------------- drawers --
function toggleDrawer(which) {
    const isNarrow = window.matchMedia("(max-width: 1150px)").matches;
    if (!isNarrow) {
        if (which === "right") {
            const el = $("right");
            editor?.setCollapsed?.(!el?.classList.contains("collapsed"));
        } else {
            const el = $("left");
            sidebar?.setCollapsed?.(!el?.classList.contains("collapsed"));
        }
        return;
    }
    if (which === "right" && $("right")?.classList.contains("collapsed")) editor?.expand?.();
    if (which === "left" && $("left")?.classList.contains("collapsed")) sidebar?.expand?.();
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
    if (S.power) {
        log("Board power ON", "ok");
    } else {
        S.programmed = false;
        log("Board power OFF — outputs cleared, volatile JTAG configuration lost (press Compile to reprogram)", "warn");
    }
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
async function checkHealth() {
    try {
        const { httpOk, data } = await api.health();
        const ok = httpOk && data?.ok;
        S.backendOk = ok;
        S.ghdlVersion = data?.version || "";
        if (data?.appVersion) { S.appVersion = data.appVersion; toolbar?.setVersion?.(S.appVersion); }
        $("backend-banner").classList.toggle("hidden", !!ok);
        if (ok) {
            const m = String(S.ghdlVersion).match(/\d+\.\d+\.\d+/);
            log(`Backend ready — GHDL ${m ? m[0] : "available"}`, "ok");
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
        if (!httpOk || !data?.board) throw new Error(data?.message || "HTTP error");
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
        log(`Loaded example: ${ex.name}`, "cmd");
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

// ------------------------------------------------- board KEY/DIP controls --
// Active-low KEY1..KEY4 (PIN_88..91, 10k pull-ups R38-R41) & DIP SW2 (R42-R45):
// - Both start OPEN / RELEASED -> logic 1.
// - Pressing a key reads logic 0 ONLY while held down, returning to 1 on release.
// - Closing a DIP lever latches the shared net to 0 until opened back to 1.
let rerunTimer = null;
const keyHeldState = [false, false, false, false];
const dipLatchedState = [false, false, false, false];
let keyNetBindings = [null, null, null, null]; // index 0..3 -> [{ portName, bitOffset, width }] | null

function keyPinList() {
    // board.json is the only source of KEY pin numbers (A1: no fallback map).
    const pins = S.profile?.board?.buttons?.pins || [];
    return pins.map((p) => String(p).toUpperCase());
}

function applyKeyDefaultsToEditor(entityObj, pinPlan) {
    if (!entityObj?.ports) return;
    const keyPins = keyPinList();
    const boundByPort = new Map();
    if (pinPlan?.nodes) {
        for (const n of pinPlan.nodes) {
            const loc = pinPlan.validation?.validByNode?.get(n.nodeName);
            if (!loc) continue;
            const kIdx = keyPins.indexOf(loc);
            if (kIdx >= 0) {
                const set = boundByPort.get(n.portName) || new Set();
                set.add(n.bitOffset || 0);
                boundByPort.set(n.portName, set);
            }
        }
    }
    for (const port of entityObj.ports) {
        if (port.direction !== "in") continue;
        const w = port.width || 1;
        const isKeyNamed = /^(?:key|sw|switch|btn|dip|ckey)[_]?\d+$|^(?:[sk][1-4])$/i.test(port.name);
        const boundBits = boundByPort.get(port.name);
        if (!boundBits && !isKeyNamed) continue;
        let cur = editor.getStimulusValue(port.name);
        // Ensure assigned KEY pins match current held/latched hardware state (all open = 1 initially)
        for (let b = 0; b < w; b += 1) {
            if (boundBits && boundBits.has(b)) {
                const loc = pinPlan.portPins?.[port.name]?.[b];
                const kIdx = keyPins.indexOf(String(loc || "").toUpperCase());
                const closed = kIdx >= 0 ? (keyHeldState[kIdx] || dipLatchedState[kIdx]) : false;
                if (closed) cur &= ~(1 << b);
                else cur |= (1 << b);
            } else if (!boundBits && isKeyNamed) {
                cur |= (1 << b);
            }
        }
        editor.setStimulusValue(port.name, cur);
    }
}

function scheduleRerun() {
    if (rerunTimer) clearTimeout(rerunTimer);
    rerunTimer = setTimeout(() => {
        rerunTimer = null;
        if (!S.backendOk || !S.compileResult?.ok) return;
        refresh();
    }, 90);
}

// Compute KEY1..KEY4 -> assigned top-level entity port bit bindings ONLY via Pin Planner.
function syncLivePinBindings() {
    const keyPins = keyPinList();
    const plan = sidebar.getPinPlan();
    if (S.compileBoard) {
        S.compileBoard.pins = {};
        for (const [port, arr] of Object.entries(plan.portPins || {})) {
            S.compileBoard.pins[port] = [...arr];
        }
    }
    buildPinIndexes(S.compileBoard);
    keyNetBindings = keyPins.map((pin) => {
        const targets = [];
        for (const n of plan.nodes || []) {
            if (n.direction !== "input") continue;
            if (plan.validation?.validByNode?.get(n.nodeName) === pin) {
                targets.push({ portName: n.portName, bitOffset: n.bitOffset || 0, nodeName: n.nodeName });
            }
        }
        return targets.length ? targets : null;
    });
    buildBoardControls();
}

function syncKeyStimulusAndUI(index, reason) {
    const closed = Boolean(keyHeldState[index] || dipLatchedState[index]);
    const level = closed ? 0 : 1;
    const targets = keyNetBindings[index] || [];
    for (const t of targets) {
        const p = S.entity?.ports?.find((x) => x.name === t.portName);
        const width = p?.width || 1;
        if (width > 1) {
            const cur = editor.getStimulusValue(t.portName);
            editor.setStimulusValue(t.portName, closed ? (cur & ~(1 << t.bitOffset)) : (cur | (1 << t.bitOffset)));
        } else if (reason === "released") {
            // Model the release edge (not a permanent low): the design's own
            // countdown starts here, e.g. buzz1's 1.0 s timer.
            editor.setStimulusPulseOnce(t.portName, 1);
        } else {
            editor.setStimulusValue(t.portName, level);
        }
    }
    board?.pressKey?.(index, keyHeldState[index]);
    board?.setDip?.(index, dipLatchedState[index]);
    updateBoardControlButton(index);
    if (targets.length && S.programmed) {
        log(`KEY${index + 1} (${keyPinList()[index]}) → ${reason} (logic ${level})`, "cmd");
        scheduleRerun();
    }
}

function setPhysicalKeyPressed(index, pressed) {
    if (index < 0 || index >= 4) return;
    if (pressed) audio.ensure().catch(() => {});
    if (keyHeldState[index] === Boolean(pressed)) return;
    keyHeldState[index] = Boolean(pressed);
    syncKeyStimulusAndUI(index, keyHeldState[index] ? "pressed" : "released");
}

function toggleDip(index) {
    if (index < 0 || index >= 4) return;
    dipLatchedState[index] = !dipLatchedState[index];
    syncKeyStimulusAndUI(index, dipLatchedState[index] ? "DIP closed" : "DIP open");
}

function pressBoardReset() {
    if (!S.programmed) return;
    log("RESET pressed — restarting captured run (power-on reset)", "cmd");
    scheduleRerun();
}

function updateBoardControlButton(index) {
    const row = $("bc-row");
    if (!row) return;
    const item = row.querySelector(`.bc-cell[data-index="${index}"]`);
    if (!item) return;
    const keyBtn = item.querySelector(".bc-key");
    const dipBtn = item.querySelector(".bc-dip");
    const valSpan = item.querySelector(".bc-val");
    const closed = Boolean(keyHeldState[index] || dipLatchedState[index]);
    const level = closed ? 0 : 1;
    keyBtn?.classList.toggle("on", keyHeldState[index]);
    dipBtn?.classList.toggle("on", dipLatchedState[index]);
    if (valSpan) {
        valSpan.textContent = String(level);
        valSpan.classList.toggle("v0", level === 0);
    }
    const targetNames = (keyNetBindings[index] || []).map((t) => t.nodeName).join(", ");
    item.title = targetNames
        ? `KEY${index + 1} (${keyPinList()[index]}) -> ${targetNames} | reads ${level}`
        : `KEY${index + 1} (${keyPinList()[index]}) unassigned in Pin Planner`;
}

function buildBoardControls() {
    const wrap = $("board-controls");
    const row = $("bc-row");
    if (!wrap || !row) return;
    const anyBound = keyNetBindings.some(Boolean);
    row.innerHTML = "";
    if (!anyBound) {
        wrap.classList.add("hidden");
        return;
    }
    wrap.classList.remove("hidden");

    for (let i = 0; i < 4; i += 1) {
        const targets = keyNetBindings[i];
        const cell = document.createElement("div");
        cell.className = `bc-cell ${targets ? "" : "bc-unbound"}`;
        cell.dataset.index = String(i);
        cell.innerHTML = `
            <button type="button" class="bc-key" ${targets ? "" : "disabled"} title="Hold for logic 0, release for logic 1">
                <span>KEY${i + 1}</span>
                <b class="bc-val">1</b>
            </button>
            <button type="button" class="bc-dip" ${targets ? "" : "disabled"} title="Toggle DIP switch SW${i + 1} (latch 0/1)">
                SW${i + 1}
            </button>
        `;
        const keyBtn = cell.querySelector(".bc-key");
        const dipBtn = cell.querySelector(".bc-dip");

        const releaseKey = () => {
            if (keyHeldState[i]) setPhysicalKeyPressed(i, false);
        };
        keyBtn.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || !targets) return;
            e.preventDefault();
            setPhysicalKeyPressed(i, true);
        });
        keyBtn.addEventListener("pointerup", releaseKey);
        keyBtn.addEventListener("pointercancel", releaseKey);
        keyBtn.addEventListener("pointerleave", releaseKey);
        keyBtn.addEventListener("keydown", (e) => {
            if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                e.preventDefault();
                setPhysicalKeyPressed(i, true);
            }
        });
        keyBtn.addEventListener("keyup", (e) => {
            if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                releaseKey();
            }
        });
        dipBtn.addEventListener("click", () => {
            if (targets) toggleDip(i);
        });

        row.appendChild(cell);
        updateBoardControlButton(i);
    }
}

// ------------------------------------------------------------------ run --
let session = null;
let cyclesMap = new Map();
let updateAccum = 0;
let pendingCycles = [];

function flushPendingUi() {
    if (pendingCycles.length) {
        bottom.wave.addCycles(pendingCycles);
        pendingCycles = [];
    }
    sidebar.setLiveValues(S.liveValues);
}

let sessionGen = 0;

function stopSession() {
    sessionGen += 1;
    if (session) {
        session.close();
        session = null;
    }
    S.running = false;
    S.paused = false;
    board?.setRunning?.(false);
    clearBuzzerTimer();
    audio.silence();
    updateAudioBadge();
}

function makeSession() {
    const gen = sessionGen;
    return new SimSession({
        onMessage: (msg) => { if (gen === sessionGen) handleSessionMessage(msg); },
        onClose: (byUser) => {
            if (gen !== sessionGen) return;
            if (!byUser && (S.running || S.paused)) {
                setStatus("error", "connection lost");
                log("Simulation WebSocket closed unexpectedly", "error");
            }
        },
    });
}

function simPayload({ skipSynth = false, compactBoard = false, plan = null } = {}) {
    const cPlan = plan || editor.resolveCompilePlan();
    const pinPlan = sidebar.getPinPlan();
    const hdls = cPlan.includedFiles || [];
    const setup = editor.readSetup();
    const boardInfo = S.compileBoard || {};
    // A buzzer design needs >1 full tone period in the capture to measure the
    // frequency (800 Hz = 1.25 ms). Extend only the simulated duration; the
    // UI cycle window stays at 65,546 samples.
    const hasBuzzer = (S.entity?.ports || []).some(
        (p) => p.direction === "out" && /buzzer|beep|spk/i.test(p.name || ""),
    );
    const duration = hasBuzzer ? Math.max(setup.duration, 3_900_000) : setup.duration;
    return {
        vhdl: hdls[hdls.length - 1]?.content || hdls[0]?.content || "",
        files: hdls,
        top: cPlan.topEntity || undefined,
        qsf: pinPlan.qsfText,
        strictPins: true,
        duration,
        clockPeriod: setup.clockPeriod,
        resetCycles: setup.resetCycles,
        resetActiveHigh: !setup.resetActiveLow,
        resetPort: boardInfo.reset || undefined,
        clockPort: boardInfo.clock || undefined,
        stimuli: editor.buildStimuli(boardInfo.clock, boardInfo.reset),
        maxCycles: Math.min(131072, Math.max(100, Math.ceil((setup.duration || 1000) / Math.max(1, setup.clockPeriod || 10)))),
        skipSynth,
        compactBoard,
    };
}

function formatSummary({ topEntity, topFile, filesUsed, pinPlan, errCount, warnCount }) {
    const assigned = pinPlan?.validation?.assignedCount ?? 0;
    const total = pinPlan?.nodes?.length ?? 0;
    return `Top: ${topEntity || "—"} (${topFile || "—"}) · Files: ${filesUsed} · Pins: ${assigned}/${total} · ${errCount} err, ${warnCount} warn`;
}

async function compileAndProgram() {
    refreshing = false;
    S.refreshing = false;
    // Compile is a user gesture — this is the right place to resume audio.
    audio.ensure().catch(() => {});
    if (S.backendOk === false) {
        toast("Backend is offline — start it cleanly or retry connection", { kind: "error", timeout: 5000 });
        return;
    }

    const plan = editor.resolveCompilePlan();
    if (!plan.includedFiles.length) {
        const msg = { file: "", line: 1, column: 1, severity: "error", message: "No source files in project to compile." };
        editor.setMessages("No project files", [msg]);
        toast("Add a .vhd or .v file first", { kind: "error" });
        return;
    }

    // Ensure Pin Planner matches the selected top-level ports before validation
    syncPlannerToTopContext({ entityObj: plan.topEntityObj, topFile: plan.topFile });
    const pinPlan = sidebar.getPinPlan();

    toolbar.setStep(0, "active");
    setStatus("compiling");
    log(`Compiling top-level '${plan.topEntity}' (${plan.includedFiles.map((f) => f.name).join(", ")})…`, "cmd");
    for (const info of plan.ignoreInfos) log(info.message, "info");

    // Client-side missing dependency or Pin Planner errors fail BEFORE touching board state
    const preErrors = [...plan.missingErrors, ...pinPlan.validation.errors];
    const pinWarnings = [...pinPlan.validation.warnings];
    if (preErrors.length) {
        const allMsgs = [...preErrors, ...pinWarnings, ...plan.ignoreInfos];
        const summary = formatSummary({
            topEntity: plan.topEntity,
            topFile: plan.topFile,
            filesUsed: plan.includedFiles.length,
            pinPlan,
            errCount: preErrors.length,
            warnCount: pinWarnings.length,
        });
        editor.setMessages(summary, allMsgs);
        bottom.setProblems(allMsgs);
        editor.setProblems(allMsgs);
        toolbar.setStep(plan.missingErrors.length ? 0 : 2, "error");
        setStatus("error", "compile failed");
        log(`Compile failed (${preErrors.length} error(s)) — previous board state retained.`, "error");
        for (const e of preErrors.slice(0, 12)) log(`${e.message} (${e.file || "project"}${e.line ? ":" + e.line : ""})`, "error");
        toast(`Compile failed (${preErrors.length} error${preErrors.length > 1 ? "s" : ""})`, { kind: "error" });
        return;
    }

    // 1 — compile on backend (never clear running board until compile passes!)
    let res;
    try {
        res = await api.compile({
            vhdl: plan.includedFiles[plan.includedFiles.length - 1].content,
            files: plan.includedFiles,
            top: plan.topEntity || undefined,
            qsf: pinPlan.qsfText,
            strictPins: true,
        });
    } catch (err) {
        toolbar.setStep(0, "error");
        setStatus("error", err.message);
        editor.setMessages("Compile request failed", [{ severity: "error", message: err.message }]);
        log(`Compile request failed: ${err.message}`, "error");
        return;
    }

    const backendErrors = res.data?.errors || [];
    const backendWarnings = (res.data?.warnings || []).filter((w) => !/without a pin assignment|no pin assignment/i.test(w.message || ""));
    const allErrors = [...backendErrors];
    const allWarnings = [...pinWarnings, ...backendWarnings];
    const combinedMsgs = [...allErrors, ...allWarnings, ...plan.ignoreInfos];
    const summary = formatSummary({
        topEntity: res.data?.entity?.name || plan.topEntity,
        topFile: plan.topFile,
        filesUsed: plan.includedFiles.length,
        pinPlan,
        errCount: allErrors.length,
        warnCount: allWarnings.length,
    });

    S.problems = [...allErrors, ...allWarnings];
    bottom.setProblems(S.problems);
    editor.setProblems(S.problems);
    editor.setMessages(summary, combinedMsgs);

    if (!res.httpOk || !res.data?.ok || allErrors.length) {
        toolbar.setStep(1, "error");
        setStatus("error", "compile failed");
        log(`Compilation failed${allErrors.length ? ` — ${allErrors.length} error(s)` : ""} — board kept previous state.`, "error");
        for (const e of allErrors.slice(0, 12)) log(`${e.message || e} (${e.file || "?"}${e.line ? ":" + e.line : ""})`, "error");
        if (!allErrors.length && res.data?.message) log(res.data.message, "error");
        return;
    }

    // Compile succeeded -> now stop old simulation session and load new design onto board
    stopSession();
    cyclesMap = new Map();
    pendingCycles = [];
    bottom.wave.setData([], 0);

    // Sync Pin Planner with authoritative compiled entity if ports updated
    S.entity = res.data.entity;
    S.compileResult = res.data;
    S.compileBoard = res.data.board || {};
    sidebar.setEntity(S.entity);
    const updatedPinPlan = sidebar.getPinPlan();
    editor.setEntity(S.entity);
    applyKeyDefaultsToEditor(S.entity, updatedPinPlan);

    // Re-reset momentary holds to released (logic 1) on fresh program
    for (let i = 0; i < 4; i += 1) keyHeldState[i] = false;
    syncLivePinBindings();
    for (let i = 0; i < 4; i += 1) {
        board?.pressKey?.(i, false);
        board?.setDip?.(i, dipLatchedState[i]);
    }

    toolbar.setStep(1, "done");
    toolbar.setStep(2, "done");
    log(`Compiled ${S.entity.name}: ${S.entity.ports.length} ports (${updatedPinPlan.validation.assignedCount} pinned, ${updatedPinPlan.validation.unassignedCount} unassigned)`, "ok");
    if (updatedPinPlan.validation.unassignedCount > 0) {
        log(`Warning: ${updatedPinPlan.validation.unassignedCount} unassigned port(s) will do nothing on the board.`, "warn");
    }

    toolbar.setStep(3, "active");
    setStatus("programming");
    log("Programming via JTAG (auto-loading compiled design onto board)…", "cmd");
    board?.setDesign?.(S.compileBoard);
    board?.resetVisual?.();

    // 4 — WS session
    const payload = simPayload({ plan });
    session = makeSession();
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

let refreshing = false;
let pendingRefresh = false;
async function refresh() {
    if (!S.backendOk) return;
    if (!S.compileResult || !S.compileBoard) { compileAndProgram(); return; }
    if (refreshing) { pendingRefresh = true; return; }
    refreshing = true;
    S.refreshing = true;
    pendingRefresh = false;
    cyclesMap = new Map();
    pendingCycles = [];
    bottom.wave.setData([], 0);
    board?.resetDisplayHold?.();
    setStatus("running", "applying inputs");
    const payload = simPayload({ skipSynth: true, compactBoard: true });
    stopSession();
    session = new SimSession({ onMessage: (msg) => handleSessionMessage(msg) });
    try {
        await session.connect();
    } catch (err) {
        refreshing = false;
        S.refreshing = false;
        setStatus("error", "websocket failed");
        log(`Refresh failed: ${err.message}`, "error");
        if (pendingRefresh) { pendingRefresh = false; refresh(); }
        return;
    }
    session.start(payload);
}

function handleSessionMessage(msg) {
    switch (msg.type) {
        case "sim_ready": {
            S.signals = msg.signals || [];
            S.totalCycles = msg.totalCycles || 0;
            S.clockNs = Number(msg.clockNs) || 20;
            if (msg.board) {
                S.compileBoard = { ...(S.compileBoard || {}), ...msg.board };
                syncLivePinBindings();
                board?.setDesign?.(S.compileBoard);
            }
            if (msg.entity) {
                S.entity = msg.entity;
                editor.setEntity(msg.entity);
            }
            bottom.wave.setSignals(S.signals);
            S.running = true;
            S.paused = false;
            S.programmed = true;
            board?.setRunning?.(true);
            if (msg.compactBoard) {
                setStatus("running", "applying inputs");
            } else {
                setStatus("running");
                toolbar.setRunning(true, false);
                editor.setRunState(true, false);
                toolbar.setStep(4, "active");
                log(`Simulation running — ${S.totalCycles} cycles captured (${(S.simStats.targetSpeed / 1e6).toFixed(0)} MHz clock)`, "ok");
            }
            applyPeripherals(msg.peripherals, msg.clockNs);
            break;
        }
        case "cycle_batch": {
            const t0 = performance.now();
            const cycles = msg.cycles || [];
            for (const c of cycles) {
                cyclesMap.set(c.cycle, c);
                applyCycleToBoard(c);
            }
            const last = cycles[cycles.length - 1];
            if (last) {
                S.liveValues = last.values || {};
                S.simTimeNs = last.time;
                S.cursorCycle = last.cycle;
            }
            if (msg.stats) S.simStats = { ...S.simStats, ...msg.stats };
            for (const c of cycles) pendingCycles.push(c);
            updateAccum += performance.now() - t0;
            break;
        }
        case "sim_done": {
            const wasRefresh = refreshing;
            S.running = false;
            S.paused = false;
            refreshing = false;
            S.refreshing = false;
            const final = msg.final || {};
            S.liveValues = final;
            if (msg.boardImage && board) board.applyBoardImage(msg.boardImage);
            else applyCycleToBoard({ values: final, time: S.simTimeNs });
            flushPendingUi();
            board?.setRunning?.(false);
            S.countdown = msg.boardImage?.countdown || null;
            scheduleBuzzerStop(Number(msg.clockNs) || S.clockNs || 20, msg.boardImage?.countdown);
            setStatus("idle");
            toolbar.setRunning(false, false);
            editor.setRunState(false, false);
            toolbar.setStep(5, "done");
            if (wasRefresh && msg.boardImage) {
                log("Simulation complete — board updated", "ok");
            } else {
                log(`Simulation complete — ${msg.totalCycles ?? S.totalCycles} cycles, t = ${(S.simTimeNs / 1e3).toFixed(3)} µs`, "ok");
            }
            if (pendingRefresh) { pendingRefresh = false; refresh(); }
            break;
        }
        case "sim_paused": {
            S.paused = true;
            S.running = false;
            board?.setRunning?.(false);
            flushPendingUi();
            setStatus("paused");
            toolbar.setRunning(true, true);
            editor.setRunState(true, true);
            log(`Paused at cycle ${msg.cursor ?? S.cursorCycle}`, "cmd");
            break;
        }
        case "sim_resumed": {
            S.paused = false;
            S.running = true;
            board?.setRunning?.(true);
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
            refreshing = false;
            S.refreshing = false;
            board?.setRunning?.(false);
            clearBuzzerTimer();
            audio.silence();
            updateAudioBadge();
            flushPendingUi();
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
            refreshing = false;
            S.refreshing = false;
            board?.setRunning?.(false);
            setStatus("error", msg.message || "simulation error");
            toolbar.setRunning(false, false);
            editor.setRunState(false, false);
            toolbar.setStep(4, "error");
            log(`Simulation error: ${msg.message || "unknown"}`, "error");
            if (msg.errors?.length) {
                S.problems = msg.errors;
                bottom.setProblems(msg.errors);
                editor.setProblems(msg.errors);
                editor.setMessages("Simulation failed", msg.errors);
            }
            break;
        }
        default: break;
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
        setStatus("idle");
        return;
    }
    session.stop();
}

function resetSim() {
    if (!session || (!S.running && !S.paused)) {
        toast("No simulation session — press Compile first", { kind: "warn" });
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
function applyPeripherals(per, clockNs = 20) {
    if (!per) return;
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
        applyBuzzerAudio(per.buzzer, clockNs);
    }
    if (per.eeprom) log("EEPROM dump available (AT24C08)", "info");
}

// --------------------------------------------------------------- problems --
function openProblem(p) {
    const file = p.file || editor.getActiveFile();
    editor.openFile(file, p.line, p.column);
}

// ----------------------------------------------------------------- stats --
let lastStatsTick = performance.now();
function startLoops() {
    setInterval(() => {
        const now = performance.now();
        const windowMs = now - lastStatsTick;
        lastStatsTick = now;
        S.updateLoad = Math.min(100, (updateAccum / Math.max(1, windowMs)) * 100);
        updateAccum = 0;
        const s = board?.stats?.();
        if (s) {
            S.fps = s.fps;
            S.drawCalls = s.drawCalls;
        }
        flushPendingUi();
        stats.update(S);
    }, 250);
}

// ------------------------------------------------------------- shortcuts --
function bindShortcuts() {
    document.addEventListener("keydown", (e) => {
        const inEditor = e.target.closest?.(".monaco-editor, input, textarea, select");
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            compileAndProgram();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "b") {
            e.preventDefault();
            toggleDrawer("left");
            return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "\\") {
            e.preventDefault();
            toggleDrawer("right");
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "b") {
            e.preventDefault();
            $("bottom").classList.toggle("collapsed");
            setTimeout(() => bottom.wave.resize(), 60);
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
        setTheme("light");
        toolbar.setPower(true);
    }

    // Restore persisted sidebar collapse states before profile/example load
    if (loadCollapsedPref(RIGHT_COLLAPSED_KEY)) editor.setCollapsed(true);
    if (loadCollapsedPref(LEFT_COLLAPSED_KEY)) sidebar.setCollapsed(true);
    resizeBoardSoon();

    bindShortcuts();
    startLoops();

    $("backend-retry").addEventListener("click", async () => {
        $("backend-banner").classList.add("hidden");
        await checkHealth();
        if (S.backendOk) { await loadProfile(); await loadExamples(); }
    });

    await checkHealth();
    await loadProfile();
    await loadExamples();

    const def = S.examples.find((e) => e.id === "sevseg_keys")
        || S.examples.find((e) => /counter/i.test(e.id) || /counter/i.test(e.name));
    if (def) await loadExample(def.id);

    window.__cyclone = {
        board, state: S, api, compile: compileAndProgram, run: compileAndProgram,
        stopSim, editor, sidebar, bottom, audio,
        pause: togglePause, resetSim, stepSim, toggleDip, setPhysicalKeyPressed,
    };
    log("Cyclone IV Studio ready — open a file, assign pins in Pin Planner, and press Compile (Ctrl+Enter).", "info");
}

init();
