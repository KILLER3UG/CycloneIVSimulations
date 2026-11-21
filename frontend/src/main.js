// main.js — Cyclone IV Studio: the 2-zone workbench around Board3D.
//
// A successful Compile & Run publishes a pre-computed `stimulusMap`. Channel
// changes are then resolved CLIENT-SIDE from that map (0 HTTP requests, <1 ms)
// instead of re-running GHDL. Only an uncached/partial map falls back to
// api.simulate(), with an AbortController that cancels the previous request.

import "./styles.css";
import { Board3D } from "./board/index.js";
import { ApiClient, SimSession } from "./api.js";
import { createStore } from "./state.js";
import { createToolbar } from "./ui/toolbar.js";
import { isEditableTarget } from "./ui/editableGuard.js";
import { reduceLiveVga, reduceUartBytes } from "./liveFrame.js";
import { createSidebar } from "./ui/sidebar.js";
import { createEditorPanel } from "./ui/editorPanel.js";
import { createBottomPanel } from "./ui/bottomPanel.js";
import { createStatsBlock } from "./ui/stats.js";
import { createInteractions } from "./ui/interactions.js";
import { dialog, toast, cheatSheet } from "./ui/toast.js";
import { icon } from "./ui/icons.js";
import { audio } from "./audio.js";
import { runUpdateFlow, updatesSupported } from "./updater.js";
import { buildVcd } from "./vcdExport.js";
import { createTerminalController } from "./ui/terminal.js";

const store = createStore();
const S = store.state;
const api = new ApiClient();
const $ = (id) => document.getElementById(id);

// Runtime state not owned by the shared store (kept on S so window.__cyclone
// exposes a single source of truth).
S.stimulusMap = null;
S.boardsList = [];
S.activeBoardId = "";
S.boardProfile = S.boardProfile || S.profile || null;
S.keyState = [];
S.dipState = [];
S.releaseTimer = null;
S.releaseDeadlineMs = 0;
S.clockPeriodNs = 20;
S.finalValues = {};
S.buzzer = { tone: false, frequency: 0, duty: 0, activeLow: true };
// Live interactive co-simulation state (persistent GHDL stepping).
S.liveActive = false;
S.livePace = "max";
S.liveCyclesTotal = 0;
S.liveFrames = 0;
S.liveSpeedText = "\u2014";
S.liveResetPending = false;
S.bounceEnabled = false;
S.lastPayload = null;
S.uartLiveBytes = [];
S.liveVga = null;

let board = null;
let interactions = null;
let toolbar, sidebar, editor, bottom, stats, terminal = null;
let session = null;
let sessionGen = 0;
let simAbort = null;
let rerunTimer = null;
let cyclesMap = new Map();
let pendingCycles = [];
let updateAccum = 0;
let sigPins = new Map();
let pinValueIndex = new Map();
let keyNetBindings = [];

const safeCall = (fn, ...args) => {
    if (typeof fn !== "function") return undefined;
    try { return fn(...args); } catch { return undefined; }
};
const audioSettle = (p) => { if (p && typeof p.catch === "function") p.catch(() => {}); return p; };

// ------------------------------------------------------------ api adapters --
// Cleanly target the fe-core contracts; keep a compatibility path to the
// older REST surface so the app still boots before that branch is merged.
async function apiGet(name, path) {
    if (typeof api[name] === "function") {
        const res = await api[name]();
        return res?.data !== undefined ? res.data : res;
    }
    const res = await api._fetch(path);
    return res?.data !== undefined ? res.data : res;
}
async function apiPost(name, path, body, args = []) {
    if (typeof api[name] === "function") {
        const res = await api[name](...args);
        return res?.data !== undefined ? res.data : res;
    }
    const res = await api._fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return res?.data !== undefined ? res.data : res;
}

function makeSession(handlers) {
    if (typeof api.connectSession === "function") return api.connectSession(handlers);
    return new SimSession(handlers);
}
function sessionStart(payload) {
    if (!session) return;
    if (typeof session.runSim === "function") session.runSim(payload);
    else if (typeof session.start === "function") session.start(payload);
}

// ------------------------------------------------------------------ audio --
function audioState() {
    if (typeof audio.state === "function") return audio.state() || {};
    return {
        muted: !!audio.muted, volume: audio.volume,
        active: !!audio.active, frequency: audio.frequency, duty: audio.duty,
    };
}
function updateAudioBadge() {
    toolbar?.setAudio?.(audioState());
    const badge = $("tb-audio-badge");
    if (badge) {
        const st = audioState();
        badge.textContent = st.muted ? "Muted"
            : st.active && st.frequency ? `${Math.round(st.frequency)} Hz` : "Silent";
    }
}
async function toggleMute() {
    audioSettle(safeCall(() => audio.ensure?.()));
    audio.setMuted(!audio.muted);
    updateAudioBadge();
}
function driveBuzzer(enabled, frequency, duty) {
    if (enabled && frequency > 0) audioSettle(audio.tone(frequency, duty));
    else audio.silence();
    updateAudioBadge();
}

// ------------------------------------------------------ pin / cycle glue ---
function buildPinIndexes(boardInfo) {
    sigPins = new Map();
    pinValueIndex = new Map();
    for (const [port, list] of Object.entries(boardInfo?.pins || {})) {
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

// ------------------------------------------------------------------ board --
function initBoard() {
    const host = $("board-host");
    try {
        board = new Board3D(host, {
            quality: "balanced", theme: "dark",
            onPick: (pick) => { if (pick?.componentId) bottom.log(`Focused ${pick.componentId}`, "cmd"); },
        });
        board.mount();
        board.setPreset("iso");
        interactions = createInteractions(board, host, {
            onPowerToggle: togglePower,
            onDipToggle: toggleDip,
            onKeyPress: (index, down) => setPhysicalKeyPressed(index, down),
            onResetPress: (down) => { if (down) pressBoardReset(); },
            onProbe: addProbe,
            getPinValue,
        });

        const presets = $("cam-presets");
        presets?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-cam]");
            if (!btn) return;
            presets.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
            const cam = btn.dataset.cam;
            if (cam === "fit") board.fit?.();
            else board.setPreset?.(cam === "iso" ? "iso" : cam);
        });
        const labelBtn = $("btn-pin-labels");
        labelBtn?.addEventListener("click", () => {
            const on = labelBtn.getAttribute("aria-pressed") !== "true";
            labelBtn.setAttribute("aria-pressed", String(on));
            safeCall(() => board.setPinLabels?.(on));
        });
        return true;
    } catch (err) {
        console.error("WebGL init failed", err);
        host.innerHTML = `<div class="webgl-fallback">
            <h2>3D view unavailable</h2>
            <p>The editor, Pin Planner, compile and waveform tools still work.</p>
        </div>`;
        return false;
    }
}

// --------------------------------------------------- channel / stimulus ----
function channelConfig() {
    return S.stimulusMap?.meta?.channels || S.boardProfile?.board?.channels || null;
}

// bit i = the logic level driven onto interactive channel i.
// activeLow channels are idle-high (1) and pressed/closed-low (0).
function computeChannelMask() {
    const channels = channelConfig();
    if (channels?.length) {
        let mask = 0;
        let btnSeen = 0;
        let swSeen = 0;
        for (const ch of channels) {
            let closed = false;
            if (ch.kind === "button") closed = !!S.keyState[btnSeen++];
            else if (ch.kind === "switch") closed = !!S.dipState[swSeen++];
            else {
                const i = Number(ch.index) || 0;
                closed = !!(S.keyState[i] || S.dipState[i]);
            }
            const low = ch.activeLow !== false;
            const level = closed ? (low ? 0 : 1) : (low ? 1 : 0);
            if (level) mask |= 1 << (Number(ch.index) || 0);
        }
        return mask;
    }
    const b = S.boardProfile?.board || {};
    const btnPins = b.buttons?.pins || [];
    const swPins = b.switches?.pins || [];
    const shared = !!b.switches?.sharedWithButtons;
    const btnLow = b.buttons?.activeLow !== false;
    const swLow = b.switches?.activeLow !== false;
    let mask = 0;
    for (let i = 0; i < btnPins.length + (shared ? 0 : swPins.length); i += 1) {
        const isBtn = i < btnPins.length;
        const closed = isBtn ? !!S.keyState[i] : !!S.dipState[i - btnPins.length];
        const low = isBtn ? btnLow : swLow;
        const level = closed ? (low ? 0 : 1) : (low ? 1 : 0);
        if (level) mask |= 1 << i;
    }
    return mask;
}

// A finished capture leaves S.running === false (idle render tier), but the
// design is still programmed and the pre-computed stimulus map stays live.
// Interactive key/DIP play therefore must not be gated on the streaming flag.
function canPlayBuzzer() {
    return !!(S.programmed && (S.powered ?? S.power) && !S.paused);
}

function applyStimulusEntry(entry) {
    if (!entry) return;
    safeCall(() => board?.applyBoardImage?.(entry));
    S.finalValues = { ...(S.finalValues || {}), ...(entry.finalValues || {}) };
    S.buzzer = entry.buzzerDecode
        ? { ...entry.buzzerDecode }
        : { tone: false, frequency: 0, duty: 0, activeLow: true };
    const bz = S.buzzer;
    const sounding = !!(canPlayBuzzer() && bz.tone && bz.frequency > 0);
    driveBuzzer(
        sounding,
        Number(bz.frequency) || 0,
        Number(bz.duty) || 0.5,
    );
    // The 3D buzzer state ring follows the SAME decoded state as the audio — the raw
    // image.buzzer pin level is polarity-blind (active-low buzzers sound at 0).
    safeCall(() => board?.setBuzzerActive?.(sounding));
    S.liveValues = S.finalValues;
    safeCall(() => sidebar?.setLiveValues?.(S.finalValues));
    safeCall(() => sidebar?.setPeripherals?.(entry));
    safeCall(() => stats?.update?.(S));
    safeCall(() => bottom?.log?.("Simulation complete — board updated", "ok"));
}

// One channel changed. Resolve synchronously whenever the pre-computed map
// covers the resulting mask; otherwise fall back to one cancellable request.
function handleChannelChange(changedKind, idx, newVal, prevVal) {
    const i = Number(idx) || 0;
    if (changedKind === "key") S.keyState[i] = !!newVal;
    else S.dipState[i] = !!newVal;

    // 0 ms visual feedback.
    const btnCount = S.boardProfile?.board?.buttons?.pins?.length || 0;
    const sharedMode = !!S.boardProfile?.board?.switches?.sharedWithButtons;
    const dipVisual = changedKind === "dip" && !sharedMode ? btnCount + i : i;
    safeCall(() => board?.pressKey?.(i, !!S.keyState[i]));
    safeCall(() => board?.setDip?.(dipVisual, !!S.dipState[i]));
    updateBoardControlButton(dipVisual);
    safeCall(() => sidebar?.setPeripherals?.(S.lastStimulusEntry || {}));

    // Live co-simulation: the physical pin state (wired-AND of key + DIP on
    // the shared A2.2 bank) is pushed to the persistent GHDL process and the
    // batch stimulus-map path is bypassed entirely.
    if (S.liveActive) {
        safeCall(() => session?.liveInput?.({
            keys: (S.keyState || []).map(Boolean),
            dip: (S.dipState || []).map(Boolean),
            reset: !!S.liveResetPending,
            bounce: !!S.bounceEnabled,
        }));
        return;
    }

    if (S.releaseTimer) { clearTimeout(S.releaseTimer); S.releaseTimer = null; }
    S.releaseDeadlineMs = 0;

    const map = S.stimulusMap;
    if (map?.vectors) {
        const mask = computeChannelMask();
        const release = changedKind === "key" && prevVal && !newVal
            && !S.keyState.some(Boolean) ? map.releases?.[String(i)] : null;
        if (release && (release.releaseCycles || 0) > 0 && release.buzzerDecode?.tone
            && canPlayBuzzer()) {
            S.lastStimulusEntry = release;
            applyStimulusEntry(release);
            const ms = Math.max(50, Math.round(
                ((release.releaseCycles || 0) * (S.clockPeriodNs || 20)) / 1e6,
            ));
            S.releaseDeadlineMs = Date.now() + ms;
            S.releaseTimer = setTimeout(() => {
                S.releaseTimer = null;
                S.releaseDeadlineMs = 0;
                const cur = S.stimulusMap?.vectors?.[String(computeChannelMask())];
                if (cur) { S.lastStimulusEntry = cur; applyStimulusEntry(cur); }
            }, ms);
            return;
        }
        const hit = map.vectors[String(mask)];
        if (hit !== undefined) {
            S.lastStimulusEntry = hit;
            applyStimulusEntry(hit);
            return;
        }
    }
    fallbackSimulate();
}

async function fallbackSimulate() {
    if (simAbort) simAbort.abort();
    simAbort = new AbortController();
    try {
        const plan = editor.resolveCompilePlan();
        const payload = simPayload({ plan, skipSynth: true, compactBoard: true });
        const res = await api.simulate(payload, { signal: simAbort.signal });
        const data = res?.data !== undefined ? res.data : res;
        if (!data) return;
        if (data.stimulusMap) {
            S.stimulusMap = data.stimulusMap;
            S.clockPeriodNs = Number(data.clockPeriodNs) || S.clockPeriodNs;
        }
        const entry = data.boardImage || data;
        if (entry && (entry.leds || entry.buzzerDecode || entry.pov)) {
            S.lastStimulusEntry = entry;
            applyStimulusEntry(entry);
        }
    } catch (err) {
        if (err?.name !== "AbortError") bottom.log(`Stimulus fallback failed: ${err.message}`, "warn");
    } finally {
        simAbort = null;
    }
}

// --------------------------------------------------- board control cells ---
function setPhysicalKeyPressed(index, pressed) {
    const i = Number(index) || 0;
    if (i < 0 || i >= S.keyState.length) return;
    const prev = !!S.keyState[i];
    if (prev === !!pressed) return;
    handleChannelChange("key", i, pressed ? 1 : 0, prev ? 1 : 0);
}
function toggleDip(index) {
    const i = Number(index) || 0;
    if (i < 0 || i >= S.dipState.length) return;
    const prev = !!S.dipState[i];
    handleChannelChange("dip", i, prev ? 0 : 1, prev ? 1 : 0);
}
function updateBoardControlButton(index) {
    const row = $("bc-row");
    const item = row?.querySelector(`.bc-cell[data-index="${index}"]`);
    if (!item) return;
    const keyBtn = item.querySelector(".bc-key");
    const dipBtn = item.querySelector(".bc-dip");
    const valSpan = item.querySelector(".bc-val");
    const dipIndex = Number(item.dataset.dip ?? index);
    const closed = !!(S.keyState[index] || S.dipState[dipIndex]);
    keyBtn?.classList.toggle("on", !!S.keyState[index]);
    dipBtn?.classList.toggle("on", !!S.dipState[dipIndex]);
    if (valSpan) {
        valSpan.textContent = closed ? "0" : "1";
        valSpan.classList.toggle("v0", !!closed);
    }
    const targetNames = (keyNetBindings[index] || []).map((t) => t.nodeName).join(", ");
    item.title = targetNames ? `Channel ${index} -> ${targetNames}` : `Channel ${index} — unassigned`;
}

function buildBoardControls() {
    const wrap = $("board-controls");
    const row = $("bc-row");
    if (!wrap || !row) return;
    const b = S.boardProfile?.board || {};
    const keyCount = b.buttons?.pins?.length || b.buttons?.count || 0;
    const swCount = b.switches?.pins?.length || b.switches?.count || 0;
    const shared = !!b.switches?.sharedWithButtons;
    S.keyState = new Array(keyCount).fill(false);
    S.dipState = new Array(shared ? keyCount : swCount).fill(false);
    row.innerHTML = "";

    const makeCell = (index, label, withKey, withDip, dipLabel, dipIndex = index) => {
        const cell = document.createElement("div");
        cell.className = "bc-cell";
        cell.dataset.index = String(index);
        cell.dataset.dip = String(dipIndex);
        cell.innerHTML = `
            ${withKey ? `<button type="button" class="bc-key" data-pressed="0" title="Hold for logic 0">${label}<b class="bc-val">1</b></button>` : ""}
            ${withDip ? `<button type="button" class="bc-dip" aria-pressed="false" title="Toggle DIP switch">${dipLabel}</button>` : ""}
            ${withKey ? "" : `<b class="bc-val">1</b>`}
        `;
        const keyBtn = cell.querySelector(".bc-key");
        if (keyBtn) {
            const release = () => {
                if (keyBtn.dataset.pressed !== "1") return;
                keyBtn.dataset.pressed = "0";
                setPhysicalKeyPressed(index, false);
            };
            keyBtn.addEventListener("pointerdown", (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                keyBtn.dataset.pressed = "1";
                setPhysicalKeyPressed(index, true);
            });
            keyBtn.addEventListener("pointerup", release);
            keyBtn.addEventListener("pointercancel", release);
            keyBtn.addEventListener("pointerleave", release);
            keyBtn.addEventListener("keydown", (e) => {
                if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                    e.preventDefault();
                    keyBtn.dataset.pressed = "1";
                    setPhysicalKeyPressed(index, true);
                }
            });
            keyBtn.addEventListener("keyup", (e) => {
                if (e.key === " " || e.key === "Enter") { e.preventDefault(); release(); }
            });
        }
        cell.querySelector(".bc-dip")?.addEventListener("click", () => toggleDip(dipIndex));
        // Single-row HUD: .bc-cell is display:contents, so order the buttons
        // directly — all keys first (K1..K4), then all DIPs (S1..S4).
        if (keyBtn) keyBtn.style.order = String(index);
        const dipBtn = cell.querySelector(".bc-dip");
        if (dipBtn) dipBtn.style.order = String(10 + dipIndex);
        if (!withKey) {
            const val = cell.querySelector(":scope > .bc-val");
            if (val) val.style.order = String(10 + dipIndex);
        }
        row.appendChild(cell);
        updateBoardControlButton(index);
    };

    if (shared) {
        for (let i = 0; i < keyCount; i += 1) makeCell(i, `K${i + 1}`, true, true, `S${i + 1}`);
    } else {
        for (let i = 0; i < keyCount; i += 1) makeCell(i, `K${i}`, true, false, "");
        for (let i = 0; i < swCount; i += 1) {
            makeCell(keyCount + i, "", false, true, `SW${i}`, i);
        }
    }
    wrap.classList.toggle("hidden", keyCount + swCount === 0);
}

// ------------------------------------------------------------- components --
function resizeBoardSoon() {
    requestAnimationFrame(() => board?._resize?.());
    setTimeout(() => board?._resize?.(), 60);
}
function syncPlannerToTopContext(ctx) {
    if (!sidebar) return;
    if (ctx?.entityObj) {
        sidebar.setEntity(ctx.entityObj);
        applyKeyDefaultsToEditor(ctx.entityObj, sidebar.getPinPlan());
    } else if (!ctx?.topFile) sidebar.setEntity(null);
}
function syncPlannerToActiveTop() { syncPlannerToTopContext(editor?.getTopContext?.()); }
function log(text, level = "info") { bottom?.log?.(text, level); }

function initComponents() {
    toolbar = createToolbar($("toolbar"), {
        onPower: togglePower,
        onPause: togglePause,
        onStop: stopSim,
        onReset: resetSim,
        onStep: () => stepSim(1),
        onRun: () => compileAndProgram(),
        onMute: toggleMute,
        onBoard: (id) => selectBoard(id),
        onExample: (id) => loadExample(id),
        onToggleRight: () => toggleRight(),
        onToggleBottom: () => toggleBottom(),
        onUpdate: () => { void runUpdateFlow(); },
        onPace: (pace) => setLivePace(pace),
        onBounce: (on) => { S.bounceEnabled = !!on; log(`Mechanical bounce ${on ? "enabled" : "disabled"}`, "cmd"); },
    });

    // The update button only makes sense inside the desktop webview.
    if (!updatesSupported()) {
        document.getElementById("tb-update")?.remove();
    }

    const vol = $("tb-volume");
    if (vol) {
        vol.value = String(Math.round(audio.volume * 100));
        vol.addEventListener("input", () => {
            audioSettle(safeCall(() => audio.ensure?.()));
            audio.setVolume(Number(vol.value) / 100);
            updateAudioBadge();
        });
    }
    updateAudioBadge();

    editor = createEditorPanel($("editor-host"), {
        initialSource: S.files[0].content,
        onFilesChanged: () => syncPlannerToActiveTop(),
        onTopContextChanged: (ctx) => syncPlannerToTopContext(ctx),
        onQsfUploaded: (qsfText) => { syncPlannerToActiveTop(); sidebar.importQsfText(qsfText); },
        onFilesUploaded: () => {},
        onRun: () => compileAndProgram(),
        onDevice: selectDevice,
        onCollapsed: () => resizeBoardSoon(),
        onResized: () => resizeBoardSoon(),
        log: (t, l) => log(t, l),
    });

    sidebar = createSidebar($("sidebar-host"), {
        onFocus: (id) => { if (!board?.focusComponent?.(id)) toast(`No 3D part for "${id}"`, { kind: "warn" }); },
        onHighlightPin: (pinId) => { if (!board?.highlightPin?.(pinId)) toast(`Pin ${pinId} is not mapped`, { kind: "info" }); },
        onExample: (id) => loadExample(id),
        onRun: () => compileAndProgram(),
        onPinAssignmentsChanged: () => { if (S.programmed && S.compileResult?.ok) syncLivePinBindings(); },
        onImportBoard: (manifest) => importCustomBoard(manifest),
        log: (t, l) => log(t, l),
    });
    sidebar.setKeyStateReader(() => S.keyState || []);

    bottom = createBottomPanel($("bottompanel"), {
        onOpenProblem: (p) => editor.openFile(p.file || editor.getActiveFile(), p.line, p.column),
        onValuesAt: (t) => { S.simTimeNs = t; },
        onLiveUartTx: (bytes) => {
            if (!S.liveActive) { toast("UART injection needs live mode — run first", { kind: "warn" }); return; }
            safeCall(() => session?.liveUartTx?.({ bytes, baud: 115200 }));
        },
        onLivePs2: (byte) => {
            if (!S.liveActive) { toast("PS/2 injection needs live mode — run first", { kind: "warn" }); return; }
            safeCall(() => session?.livePs2?.(byte));
            log(`PS/2 scancode 0x${byte.toString(16).toUpperCase()} injected`, "cmd");
        },
        onLiveIr: (addr, cmd) => {
            if (!S.liveActive) { toast("IR trigger needs live mode — run first", { kind: "warn" }); return; }
            safeCall(() => session?.liveIr?.(addr, cmd));
            log(`NEC IR frame 0x${addr.toString(16)}/0x${cmd.toString(16)} fired`, "cmd");
        },
        onLiveTemp: (c) => {
            if (!S.liveActive) return;
            safeCall(() => session?.liveTemp?.(c));
        },
        onExportVcd: exportVcd,
        onTerminalInput: (line) => {
            if (!terminal) return;
            if (typeof terminal.runLine === "function") terminal.runLine(line);
            else safeCall(() => terminal.sendInput?.(line + "\n"));
        },
        onTerminalClear: () => terminal?.clear?.(),
        onTerminalRestart: () => terminal?.restart?.(),
        onCollapsed: () => setTimeout(() => bottom.wave.resize(), 60),
    });

    const statsEl = document.createElement("div");
    statsEl.id = "stats";
    document.querySelector(".board-hud-pill")?.appendChild(statsEl);
    stats = createStatsBlock(statsEl);

    const right = $("right");
    right.dataset.tab = "code";
    $("wb-tabs")?.addEventListener("click", (e) => {
        const tab = e.target.closest("[data-tab]");
        if (!tab) return;
        setWorkbenchTab(tab.dataset.tab);
    });

    // The 2-zone layout moved the drag handle out of the editor panel into
    // #workspace; keep dragging it to resize the right workbench column.
    const wbResizer = document.querySelector("#workspace > .ep-resizer");
    if (wbResizer) {
        let drag = null;
        const applyWidth = (px, persist) => {
            const w = Math.min(900, Math.max(340, Math.round(px)));
            document.documentElement.style.setProperty("--right-w", `${w}px`);
            if (persist) {
                try { localStorage.setItem("c4_right_w", String(w)); } catch { /* ignore */ }
            }
            resizeBoardSoon();
        };
        wbResizer.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            drag = { x: e.clientX, w: $("right").getBoundingClientRect().width };
            try { wbResizer.setPointerCapture(e.pointerId); } catch { /* ignore */ }
            document.body.classList.add("resizing");
        });
        wbResizer.addEventListener("pointermove", (e) => {
            if (!drag) return;
            applyWidth(drag.w - (e.clientX - drag.x), false);
        });
        const endDrag = (e) => {
            if (!drag) return;
            const w = drag.w - (e.clientX - drag.x);
            drag = null;
            document.body.classList.remove("resizing");
            try { wbResizer.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            applyWidth(Number.isFinite(w) ? w : $("right").getBoundingClientRect().width, true);
        };
        wbResizer.addEventListener("pointerup", endDrag);
        wbResizer.addEventListener("pointercancel", endDrag);
    }

    // Bottom dock height: drag its top edge (same pattern as the workbench
    // resizer). Persisted; the board viewport re-fits around the new height.
    const bottomEl = $("bottom");
    const bpResizer = bottomEl?.querySelector(".bp-resizer");
    const applyBottomHeight = (px, persist) => {
        const max = Math.min(560, Math.round(window.innerHeight * 0.6));
        const h = Math.min(max, Math.max(180, Math.round(px)));
        document.documentElement.style.setProperty("--bottom-h", `${h}px`);
        if (persist) {
            try { localStorage.setItem("c4_bottom_h", String(h)); } catch { /* ignore */ }
        }
        resizeBoardSoon();
    };
    try {
        const saved = Number(localStorage.getItem("c4_bottom_h"));
        if (Number.isFinite(saved) && saved >= 180) applyBottomHeight(saved, false);
    } catch { /* ignore */ }
    if (bpResizer) {
        let drag = null;
        bpResizer.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            drag = { y: e.clientY, h: bottomEl.getBoundingClientRect().height };
            try { bpResizer.setPointerCapture(e.pointerId); } catch { /* ignore */ }
            document.body.classList.add("resizing-bottom");
        });
        bpResizer.addEventListener("pointermove", (e) => {
            if (!drag) return;
            applyBottomHeight(drag.h - (e.clientY - drag.y), false);
        });
        const endDrag = (e) => {
            if (!drag) return;
            const h = drag.h - (e.clientY - drag.y);
            drag = null;
            document.body.classList.remove("resizing-bottom");
            try { bpResizer.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            applyBottomHeight(Number.isFinite(h) ? h : bottomEl.getBoundingClientRect().height, true);
            setTimeout(() => bottom?.wave?.resize?.(), 60);
        };
        bpResizer.addEventListener("pointerup", endDrag);
        bpResizer.addEventListener("pointercancel", endDrag);
    }
}

function setWorkbenchTab(key) {
    const right = $("right");
    if (!right || !["code", "pinmap", "periph", "board"].includes(key)) return;
    right.dataset.tab = key;
    right.querySelectorAll(".wb-tab").forEach((t) => {
        const on = t.dataset.tab === key;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", String(on));
    });
    if (key !== "code") sidebar.showTab(key);
    else requestAnimationFrame(() => editor?.editor?.layout?.());
    resizeBoardSoon();
}
function toggleRight() {
    const right = $("right");
    if (!right) return;
    right.classList.toggle("collapsed");
    resizeBoardSoon();
}
function toggleBottom() {
    $("bottom")?.classList.toggle("collapsed");
    setTimeout(() => bottom?.wave?.resize?.(), 60);
}

// ------------------------------------------------------------------ theme --
function setTheme() {
    document.documentElement.dataset.theme = "dark";
    safeCall(() => board?.setTheme?.("dark"));
    safeCall(() => editor?.setTheme?.(true));
}
function toggleTheme() { /* the studio is intentionally dark-only */ }

// ------------------------------------------------------------------ power --
function togglePower() { setPower(!S.power); }
function setPower(on) {
    S.power = !!on;
    S.powered = S.power;
    if (!S.power) {
        driveBuzzer(false, 0, 0);
        stopSession();
    }
    safeCall(() => board?.setPower?.(S.power));
    toolbar.setPower(S.power);
    if (S.power) {
        // Power cycling releases momentary buttons: the restored design boots
        // idle, and the next key press starts from a clean channel mask.
        for (let i = 0; i < (S.keyState || []).length; i += 1) {
            S.keyState[i] = false;
            safeCall(() => board?.pressKey?.(i, false));
            updateBoardControlButton(i);
        }
        driveBuzzer(false, 0, 0);
    }
    log(S.power ? "Board power ON" : "Board power OFF — outputs cleared", S.power ? "ok" : "warn");
    if (S.power && S.compileResult?.ok) refresh();
}

// ----------------------------------------------------------------- probes --
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
    log(`Probe added: ${probe.label} (${probe.pinId})`, "ok");
}

// ------------------------------------------------------- backend / data ----
function applyProfile(data) {
    const b = data?.board || {};
    const profile = { board: b, pinMap: b.pinMap || data.pinMap || {}, facts: b.facts || [], device: data.device };
    S.profile = profile;
    S.boardProfile = profile;
    S.device = data.device || S.device;
    S.clockPeriodNs = 1e9 / (b.clockHz || 50000000);
    S.simStats.targetSpeed = b.clockHz || 50000000;
    safeCall(() => board?.setProfile?.(profile));
    safeCall(() => sidebar?.setProfile?.(profile));
    buildBoardControls();
    stats?.update(S);
    return profile;
}

async function checkHealth() {
    try {
        const data = await apiGet("health", "/api/health");
        const ok = !!data?.ok;
        S.backendOk = ok;
        S.ghdlVersion = data?.version || "";
        if (data?.appVersion) S.appVersion = data.appVersion;
        $("backend-banner")?.classList.toggle("hidden", !!ok);
        log(ok ? `Backend ready — GHDL ${data.version || "available"}` : "Backend health check failed", ok ? "ok" : "error");
    } catch (err) {
        S.backendOk = false;
        $("backend-banner")?.classList.remove("hidden");
        log(`Backend unreachable: ${err.message}`, "error");
    }
}

async function loadProfile() {
    try {
        const data = await apiGet("board", "/api/board");
        if (!data?.board) throw new Error("no board profile");
        const profile = applyProfile(data);
        log(`Board profile: ${profile.board.name} — ${(profile.board.clockHz / 1e6).toFixed(0)} MHz`, "info");
    } catch (err) {
        log(`Board profile unavailable: ${err.message}`, "warn");
    }
}

async function loadBoards() {
    try {
        const data = await apiGet("getBoards", "/api/boards");
        S.boardsList = data?.boards || [];
        S.activeBoardId = data?.activeBoard || S.activeBoardId;
        toolbar.setBoards(S.boardsList, S.activeBoardId);
        if (data?.board) {
            const profile = applyProfile({ board: data.board, device: data.device });
            if (!S.compileResult) buildBoardControls();
        }
    } catch {
        toolbar.setBoards(S.boardsList, S.activeBoardId);
    }
}

async function selectBoard(id) {
    try {
        const data = await apiPost("selectBoard", "/api/boards/select", { board: id }, [id]);
        if (data && data.ok === false) throw new Error(data.message || "select failed");
        S.stimulusMap = null;
        S.lastStimulusEntry = null;
        S.compileResult = null;
        S.programmed = false;
        S.boardsList = data?.boards || S.boardsList;
        S.activeBoardId = data?.activeBoard || id;
        if (data?.board) applyProfile({ board: data.board, device: data.device });
        safeCall(() => board?.rebuildBoard?.(S.boardProfile));
        safeCall(() => board?.resetVisual?.());
        S.stimulusMap = null;
        buildBoardControls();
        toolbar.setBoards(S.boardsList, S.activeBoardId);
        toolbar.setActiveBoard(S.activeBoardId);
        if (data?.device) safeCall(() => editor.setDevice?.(data.device.key || data.device.part));
        log(`Selected board: ${S.boardProfile?.board?.name || id}`, "ok");
    } catch (err) {
        log(`Board select failed: ${err.message}`, "error");
    }
}

async function importCustomBoard(manifest) {
    try {
        const data = await apiPost("importBoard", "/api/boards/import", { manifest, select: true }, [manifest, true]);
        if (data && data.ok === false) throw new Error(data.message || "import failed");
        S.stimulusMap = null;
        S.activeBoardId = data?.activeBoard || manifest?.id || S.activeBoardId;
        if (data?.board) applyProfile({ board: data.board, device: data.device });
        safeCall(() => board?.rebuildBoard?.(S.boardProfile));
        safeCall(() => board?.resetVisual?.());
        buildBoardControls();
        await loadBoards();
        toolbar.setActiveBoard(S.activeBoardId);
        log(`Imported custom board: ${S.boardProfile?.board?.name || S.activeBoardId}`, "ok");
    } catch (err) {
        log(`Board import failed: ${err.message}`, "error");
    }
}

async function loadExamples() {
    try {
        const data = await apiGet("examples", "/api/examples");
        S.examples = data?.examples || [];
    } catch { S.examples = []; }
    sidebar.setExamples(S.examples);
    toolbar.setExamples(S.examples);
}

async function loadExample(id) {
    const ex = S.examples.find((e) => e.id === id);
    if (!ex) return;
    try {
        const data = typeof api.example === "function"
            ? await api.example(id)
            : (await api._fetch(`/api/examples/${encodeURIComponent(id)}`)).data;
        const source = data?.source ?? ex.source;
        editor.setFiles([{ name: ex.file || `${ex.id}.vhd`, content: source }], false);
        log(`Loaded example: ${ex.name}`, "cmd");
    } catch (err) {
        log(`Failed to load example ${ex.id}: ${err.message}`, "error");
    }
}

async function selectDevice(key) {
    try {
        const data = await apiPost("selectDevice", "/api/device/select", { device: key }, [key]);
        if (data && data.ok === false) throw new Error(data.message || "select failed");
        S.deviceKey = key;
        S.device = data.device;
        log(`Device selected: ${data.device?.part || key}`, "ok");
    } catch (err) {
        log(`Device select failed: ${err.message}`, "error");
        editor.setDevice(S.deviceKey);
    }
}

// --------------------------------------------- key defaults / live binding --
function keyPinList() {
    return (S.boardProfile?.board?.buttons?.pins || []).map((p) => String(p).toUpperCase());
}
function applyKeyDefaultsToEditor(entityObj, pinPlan) {
    if (!entityObj?.ports) return;
    const keyPins = keyPinList();
    const boundByPort = new Map();
    for (const n of pinPlan?.nodes || []) {
        const loc = pinPlan.validation?.validByNode?.get(n.nodeName);
        if (!loc) continue;
        const kIdx = keyPins.indexOf(String(loc).toUpperCase());
        if (kIdx >= 0) {
            const set = boundByPort.get(n.portName) || new Set();
            set.add(n.bitOffset || 0);
            boundByPort.set(n.portName, set);
        }
    }
    for (const port of entityObj.ports) {
        if (port.direction !== "in") continue;
        const width = port.width || 1;
        const isKeyNamed = /^(?:key|sw|switch|btn|dip|ckey)[_]?\d+$/i.test(port.name);
        const boundBits = boundByPort.get(port.name);
        if (!boundBits && !isKeyNamed) continue;
        let cur = editor.getStimulusValue(port.name);
        for (let b = 0; b < width; b += 1) {
            if (boundBits?.has(b)) {
                const loc = pinPlan.portPins?.[port.name]?.[b];
                const kIdx = keyPins.indexOf(String(loc || "").toUpperCase());
                const closed = kIdx >= 0 ? !!(S.keyState[kIdx] || S.dipState[kIdx]) : false;
                if (closed) cur &= ~(1 << b); else cur |= (1 << b);
            } else if (!boundBits && isKeyNamed) cur |= (1 << b);
        }
        editor.setStimulusValue(port.name, cur);
    }
}

function syncLivePinBindings() {
    const keyPins = keyPinList();
    const plan = sidebar.getPinPlan();
    if (S.compileBoard) {
        S.compileBoard.pins = {};
        for (const [port, arr] of Object.entries(plan.portPins || {})) S.compileBoard.pins[port] = [...arr];
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
}

function scheduleRerun() {
    if (rerunTimer) clearTimeout(rerunTimer);
    rerunTimer = setTimeout(() => {
        rerunTimer = null;
        if (S.backendOk && S.compileResult?.ok) refresh();
    }, 90);
}
function pressBoardReset() {
    log("RESET pressed — restarting captured run", "cmd");
    scheduleRerun();
}

// ------------------------------------------------------------------- run ---
function simPayload({ skipSynth = false, compactBoard = false, plan = null } = {}) {
    const cPlan = plan || editor.resolveCompilePlan();
    const pinPlan = sidebar.getPinPlan();
    const hdls = cPlan.includedFiles || [];
    const setup = editor.readSetup();
    const boardInfo = S.compileBoard || {};
    const ports = S.entity?.ports || [];
    const hasBuzzer = ports.some((p) => p.direction === "out" && /buzzer|beep|spk/i.test(p.name || ""));
    const hasDisplay = ports.some((p) => p.direction === "out" && /^(seg|dig|seven_seg|dtube)/i.test(p.name || ""));
    let duration = hasBuzzer ? Math.max(setup.duration, 3_900_000) : setup.duration;
    if (hasDisplay) duration = Math.max(duration, 10_000_000);
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
        includeStimulusMap: true,
        skipSynth,
        compactBoard: compactBoard || hasDisplay,
    };
}

function formatSummary({ topEntity, topFile, filesUsed, pinPlan, errCount, warnCount }) {
    const assigned = pinPlan?.validation?.assignedCount ?? 0;
    const total = pinPlan?.nodes?.length ?? 0;
    return `Top: ${topEntity || "—"} (${topFile || "—"}) · Files: ${filesUsed} · Pins: ${assigned}/${total} · ${errCount} err, ${warnCount} warn`;
}

function showCompileFailure(summary, msgs, errCount, step = 1) {
    bottom.setProblems(msgs.filter((m) => m.severity === "error" || m.severity === "warning"));
    editor.setProblems(msgs);
    toolbar.setStep(step, "error");
    setStatus("error", "compile failed");
    log(`Compile failed (${errCount} error(s)) — previous board state retained.`, "error");
    for (const e of msgs.slice(0, 12)) log(`${e.message || e} (${e.file || "project"}${e.line ? ":" + e.line : ""})`, "error");
    toast(`Compile failed (${errCount} error${errCount > 1 ? "s" : ""})`, { kind: "error" });
}

function setStatus(status, detail = "") { S.status = status; S.statusDetail = detail; toolbar.setStatus(status, detail); }

async function compileAndProgram() {
    refreshing = false;
    refreshPending = false;
    audioSettle(safeCall(() => audio.ensure?.()));
    if (S.backendOk === false) {
        toast("Backend is offline — start it cleanly or retry connection", { kind: "error" });
        return;
    }
    const plan = editor.resolveCompilePlan();
    if (!plan.includedFiles.length) {
        showCompileFailure("No project files", [{ severity: "error", message: "No source files in project to compile." }], 1, 0);
        return;
    }
    syncPlannerToTopContext({ entityObj: plan.topEntityObj, topFile: plan.topFile });
    const pinPlan = sidebar.getPinPlan();
    const preErrors = [...plan.missingErrors, ...pinPlan.validation.errors];
    const pinWarnings = [...pinPlan.validation.warnings];
    if (preErrors.length) {
        const summary = formatSummary({
            topEntity: plan.topEntity, topFile: plan.topFile, filesUsed: plan.includedFiles.length,
            pinPlan, errCount: preErrors.length, warnCount: pinWarnings.length,
        });
        showCompileFailure(summary, [...preErrors, ...pinWarnings, ...plan.ignoreInfos], preErrors.length, 0);
        return;
    }

    setStatus("compiling");
    log(`Compiling top-level '${plan.topEntity}'…`, "cmd");
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
        log(`Compile request failed: ${err.message}`, "error");
        return;
    }

    const backendErrors = res.data?.errors || [];
    const backendWarnings = (res.data?.warnings || []).filter((w) => !/without a pin assignment/i.test(w.message || ""));
    const allErrors = [...backendErrors];
    const allWarnings = [...pinWarnings, ...backendWarnings];
    const combined = [...allErrors, ...allWarnings, ...plan.ignoreInfos];
    const summary = formatSummary({
        topEntity: res.data?.entity?.name || plan.topEntity, topFile: plan.topFile,
        filesUsed: plan.includedFiles.length, pinPlan,
        errCount: allErrors.length, warnCount: allWarnings.length,
    });
    S.problems = combined.filter((m) => m.severity !== "info");
    bottom.setProblems(S.problems);
    editor.setProblems(S.problems);
    // The Diagnostics dock is the single home for compile messages now.
    log(summary, allErrors.length ? "error" : "ok");
    if (!res.httpOk || !res.data?.ok || allErrors.length) {
        showCompileFailure(summary, combined, allErrors.length || 1);
        return;
    }

    stopSession();
    cyclesMap = new Map();
    pendingCycles = [];
    bottom.wave.setData([], 0);
    S.entity = res.data.entity;
    S.compileResult = res.data;
    S.compileBoard = res.data.board || {};
    if (res.data.stimulusMap) S.stimulusMap = res.data.stimulusMap;
    sidebar.setEntity(S.entity);
    const updatedPinPlan = sidebar.getPinPlan();
    editor.setEntity(S.entity);
    applyKeyDefaultsToEditor(S.entity, updatedPinPlan);
    for (let i = 0; i < S.keyState.length; i += 1) S.keyState[i] = false;
    syncLivePinBindings();
    buildBoardControls();
    toolbar.setStep(1, "done");
    toolbar.setStep(2, "done");
    log(`Compiled ${S.entity.name}: ${S.entity.ports.length} ports`, "ok");

    safeCall(() => board?.setDesign?.(S.compileBoard));
    safeCall(() => board?.resetVisual?.());
    const payload = simPayload({ plan });
    S.lastPayload = payload;
    const gen = ++sessionGen;
    session = makeSession({
        onMessage: (msg) => { if (gen === sessionGen) handleSessionMessage(msg); },
        onSimReady: (msg) => { if (gen === sessionGen) handleSimReady(msg); },
        onClose: (byUser) => {
            if (gen !== sessionGen) return;
            driveBuzzer(false, 0, 0);  // never leave a tone running on a dead socket
            if (!byUser && (S.running || S.paused)) log("Simulation WebSocket closed unexpectedly", "error");
        },
        onOpen: () => {},
    });
    try {
        await session.connect();
    } catch (err) {
        toolbar.setStep(3, "error");
        setStatus("error", "websocket failed");
        log(`Could not open simulation session: ${err.message}`, "error");
        return;
    }
    sessionStart(payload);
}

let refreshing = false;
let refreshPending = false;
async function refresh() {
    if (!S.backendOk) return;
    if (!S.power) { toast("Board is powered off — turn Power ON to run", { kind: "warn" }); return; }
    if (!S.compileResult || !S.compileBoard) { compileAndProgram(); return; }
    if (refreshing) { refreshPending = true; return; }
    refreshing = true;
    refreshPending = false;
    cyclesMap = new Map();
    pendingCycles = [];
    bottom.wave.setData([], 0);
    setStatus("running", "applying inputs");
    const payload = simPayload({ skipSynth: true, compactBoard: true });
    S.lastPayload = payload;
    stopSession();
    const gen = ++sessionGen;
    session = makeSession({
        onMessage: (msg) => { if (gen === sessionGen) handleSessionMessage(msg); },
        onSimReady: (msg) => { if (gen === sessionGen) handleSimReady(msg); },
        onClose: () => { driveBuzzer(false, 0, 0); },
        onOpen: () => {},
    });
    try { await session.connect(); }
    catch (err) {
        refreshing = false;
        setStatus("error", "websocket failed");
        log(`Refresh failed: ${err.message}`, "error");
        if (refreshPending) { refreshPending = false; refresh(); }
        return;
    }
    sessionStart(payload);
}

function handleSimReady(msg) {
    if (!msg) return;
    if (msg.stimulusMap) {
        S.stimulusMap = msg.stimulusMap;
        S.clockPeriodNs = Number(msg.clockPeriodNs) || S.clockPeriodNs;
    }
    S.signals = msg.signals || S.signals || [];
    S.totalCycles = msg.totalCycles || 0;
    S.clockNs = Number(msg.clockNs) || 20;
    if (msg.board) {
        S.compileBoard = { ...(S.compileBoard || {}), ...msg.board };
        syncLivePinBindings();
        safeCall(() => board?.setDesign?.(S.compileBoard));
        safeCall(() => board?.setLiveMap?.(S.compileBoard));
    }
    if (msg.entity) { S.entity = msg.entity; editor.setEntity(msg.entity); }
    bottom.wave.setSignals(S.signals);
    S.running = true;
    S.paused = false;
    S.programmed = true;
    safeCall(() => board?.setRunning?.(true));
    setStatus("running");
    toolbar.setRunning(true, false);
    log(`Simulation running — ${S.totalCycles} cycles captured`, "ok");
    applyPeripherals(msg.peripherals, msg.clockNs);
}

function handleSessionMessage(msg) {
    switch (msg.type) {
        case "sim_ready": handleSimReady(msg); break;
        case "cycle_batch": {
            for (const c of msg.cycles || []) {
                cyclesMap.set(c.cycle, c);
                applyCycleToBoard(c);
                pendingCycles.push(c);
            }
            const last = (msg.cycles || []).slice(-1)[0];
            if (last) { S.liveValues = last.values || {}; S.simTimeNs = last.time; S.cursorCycle = last.cycle; }
            if (msg.stats) S.simStats = { ...S.simStats, ...msg.stats };
            break;
        }
        case "sim_done": {
            const wasRefresh = refreshing;
            S.running = false;
            S.paused = false;
            refreshing = false;
            const final = msg.final || {};
            S.liveValues = final;
            if (msg.stimulusMap) S.stimulusMap = msg.stimulusMap;
            if (msg.boardImage && board) {
                S.lastStimulusEntry = msg.boardImage;
                board.applyBoardImage(msg.boardImage);
            } else applyCycleToBoard({ values: final, time: S.simTimeNs });
            // The async sidebar mirror must see the compiled POV image too —
            // otherwise the Peripherals 7-segment readout stays at 0%.
            safeCall(() => sidebar?.setPeripherals?.(S.lastStimulusEntry || {}));
            flushPendingUi();
            safeCall(() => board?.setRunning?.(false));
            // A capture that finishes while the student is holding a key must
            // not silence/clear the live channel state: re-resolve the current
            // input mask from the pre-computed map before falling back to the
            // stale final cycle captured with the old inputs.
            const held = (S.keyState || []).some(Boolean) || (S.dipState || []).some(Boolean);
            const liveEntry = held ? S.stimulusMap?.vectors?.[String(computeChannelMask())] : null;
            if (liveEntry) {
                S.lastStimulusEntry = liveEntry;
                applyStimulusEntry(liveEntry);
            } else driveBuzzer(false, 0, 0);
            setStatus("idle");
            toolbar.setRunning(false, false);
            log(wasRefresh && msg.boardImage ? "Simulation complete — board updated"
                : `Simulation complete — ${msg.totalCycles ?? S.totalCycles} cycles`, "ok");
            if (refreshPending) { refreshPending = false; refresh(); }
            // The batch preview is done — hand over to the persistent live
            // co-simulation so key/DIP/reset interaction continues from the
            // exact end state instead of re-running from t=0.
            startLiveMode();
            break;
        }
        case "live_ready":
            S.liveActive = true;
            S.livePace = msg.pace || "max";
            S.liveCyclesTotal = 0;
            S.liveFrames = 0;
            safeCall(() => board?.setRunning?.(true));
            toolbar.setLive(true, S.livePace, "live");
            setStatus("live");
            log("Live co-simulation running — press keys / flip DIPs on the board", "ok");
            break;
        case "live_frame":
            handleLiveFrame(msg);
            break;
        case "live_pace":
            S.livePace = msg.pace || S.livePace;
            toolbar.setLive(true, S.livePace, S.liveSpeedText);
            log(`Clock pace: ${paceLabel(S.livePace)}`, "cmd");
            break;
        case "live_error":
            S.liveActive = false;
            toolbar.setLive(false, S.livePace, "\u2014");
            log(`Live mode error: ${msg.message || "unknown"}${msg.detail ? " — " + msg.detail : ""}`, "error");
            break;
        case "live_stopped":
            S.liveActive = false;
            toolbar.setLive(false, S.livePace, "\u2014");
            break;
        case "sim_paused":
            S.paused = true; S.running = false;
            safeCall(() => board?.setRunning?.(false));
            flushPendingUi();
            setStatus("paused");
            toolbar.setRunning(true, true);
            driveBuzzer(false, 0, 0);
            break;
        case "sim_resumed":
            S.paused = false; S.running = true;
            safeCall(() => board?.setRunning?.(true));
            setStatus("running");
            toolbar.setRunning(true, false);
            break;
        case "sim_reset":
            S.cursorCycle = 0; S.simTimeNs = 0; S.liveValues = {};
            const first = Array.from(cyclesMap.values()).sort((a, b) => a.cycle - b.cycle)[0];
            if (first) { S.liveValues = first.values; applyCycleToBoard(first); }
            sidebar.setLiveValues(S.liveValues);
            stats.update(S);
            break;
        case "sim_stopped":
            S.running = false; S.paused = false; refreshing = false; refreshPending = false;
            safeCall(() => board?.setRunning?.(false));
            driveBuzzer(false, 0, 0);
            flushPendingUi();
            setStatus("idle");
            toolbar.setRunning(false, false);
            toolbar.setStep(-1);
            break;
        case "sim_error":
            S.running = false; S.paused = false; refreshing = false; refreshPending = false;
            safeCall(() => board?.setRunning?.(false));
            setStatus("error", msg.message || "simulation error");
            toolbar.setRunning(false, false);
            toolbar.setStep(4, "error");
            log(`Simulation error: ${msg.message || "unknown"}`, "error");
            if (msg.errors?.length) {
                S.problems = msg.errors;
                bottom.setProblems(msg.errors);
                editor.setProblems(msg.errors);
            }
            break;
        default: break;
    }
}

function flushPendingUi() {
    if (pendingCycles.length) { bottom.wave.addCycles(pendingCycles); pendingCycles = []; }
    sidebar.setLiveValues(S.liveValues);
}

// --------------------------------------------------------------- controls --
function stopSession() {
    sessionGen += 1;
    if (session) {
        safeCall(() => session.close?.());
        session = null;
    }
    S.running = false;
    S.paused = false;
    S.liveActive = false;
    toolbar.setLive(false, S.livePace, "\u2014");
    safeCall(() => board?.setRunning?.(false));
    if (S.releaseTimer) { clearTimeout(S.releaseTimer); S.releaseTimer = null; }
    driveBuzzer(false, 0, 0);
}
function togglePause() {
    if (S.paused) {
        S.paused = false;
        safeCall(() => session?.resume?.());
        if (S.buzzer?.tone) driveBuzzer(true, S.buzzer.frequency, S.buzzer.duty);
        log("Simulation resumed", "cmd");
        return;
    }
    // Interactive play has no streaming session, so the local flag is the
    // authoritative pause state for the stimulus-map path.
    S.paused = true;
    driveBuzzer(false, 0, 0);
    if (S.running) safeCall(() => session?.pause?.());
    log("Simulation paused — buzzer silenced", "cmd");
}
function stopSim() {
    driveBuzzer(false, 0, 0);
    safeCall(() => board?.resetVisual?.());
    if (S.liveActive) {
        stopLiveMode();
        S.running = false; S.paused = false;
        setStatus("idle");
        log("Live co-simulation stopped", "cmd");
        return;
    }
    if (!session || (!S.running && !S.paused)) { setStatus("idle"); return; }
    safeCall(() => session?.stop?.());
}
// --------------------------------------------------- live co-simulation ---
function paceLabel(pace) {
    return { single: "Single Cycle", "1hz": "1 Hz", "100hz": "100 Hz",
             "10khz": "10 kHz", max: "Live Max" }[pace] || pace;
}

/** Hand over from the finished batch capture to persistent live stepping. */
function startLiveMode() {
    if (S.liveActive || !session?.open) return;
    const payload = S.lastPayload || {};
    session.liveStart({
        vhdl: payload.vhdl,
        files: payload.files,
        top: payload.top,
        clockPeriod: payload.clockPeriod || S.clockPeriodNs,
        resetCycles: payload.resetCycles ?? 2,
        resetActiveHigh: payload.resetActiveHigh ?? true,
        resetPort: payload.resetPort,
        clockPort: payload.clockPort,
    });
}

function stopLiveMode() {
    S.liveActive = false;
    safeCall(() => session?.liveStop?.());
    toolbar.setLive(false, S.livePace, "\u2014");
}

function setLivePace(pace) {
    S.livePace = pace;
    safeCall(() => session?.livePace?.(pace));
    if (!S.liveActive) toolbar.setLive(true, pace, S.liveSpeedText);
}

function handleLiveFrame(msg) {
    S.liveActive = true;
    S.liveFrames += 1;
    S.liveCyclesTotal += Number(msg.cycles) || 0;
    S.simTimeNs = Number(msg.timeNs) || S.simTimeNs;
    if (msg.values) S.liveValues = msg.values;
    safeCall(() => board?.applyLiveFrame?.(msg));
    // Live peripheral panels: decoded UART bytes + the VGA framebuffer.
    if (msg.uartBytes?.length) {
        S.uartLiveBytes = reduceUartBytes(S.uartLiveBytes, msg.uartBytes);
        safeCall(() => bottom?.setLiveUart?.(S.uartLiveBytes));
    }
    if (msg.vga) {
        S.liveVga = reduceLiveVga(S.liveVga, msg.vga.lines || {});
        safeCall(() => bottom?.setLiveVga?.(S.liveVga.fb));
    }
    if (msg.lcd) safeCall(() => bottom?.setLcd?.((msg.lcd.lines || []).join("\n")));
    // Honest live-speed readout: cycles advanced per wall second, sampled
    // once a second from the accumulated totals (never the nominal pace).
    const now = performance.now();
    if (!S._liveSpeedAt) { S._liveSpeedAt = now; S._liveSpeedCycles = S.liveCyclesTotal; }
    if (now - S._liveSpeedAt >= 1000) {
        const cps = Math.round((S.liveCyclesTotal - S._liveSpeedCycles) * 1000 / (now - S._liveSpeedAt));
        S.liveSpeedText = `${cps.toLocaleString()} cyc/s \u00b7 ${(cps / 50e6 * 100).toFixed(2)}% of 50 MHz`;
        S._liveSpeedAt = now;
        S._liveSpeedCycles = S.liveCyclesTotal;
        toolbar.setLive(true, S.livePace, S.liveSpeedText);
    }
    // Buzzer: the board speaker is PASSIVE — a tone exists only while the pin
    // toggles (frequency from the toggle count over the frame); a steady DC
    // level is silence on this board (no on-board oscillator).
    const bz = msg.buzzer || null;
    if (bz && bz.toggles > 1 && canPlayBuzzer()) {
        const freq = bz.toggles / (2 * Math.max(1, msg.cycles) * ((S.clockPeriodNs || 10) * 1e-9));
        const duty = Math.min(1, Math.max(0, (bz.activeCycles || 0) / Math.max(1, msg.cycles)));
        S.buzzer = { tone: true, frequency: Math.round(freq), duty, activeLow: true };
        driveBuzzer(true, Math.min(20000, Math.max(20, freq)), duty);
    } else if (S.buzzer?.tone || S.buzzer?.frequency) {
        S.buzzer = { tone: false, frequency: 0, duty: 0, activeLow: true };
        driveBuzzer(false, 0, 0);
    }
    sidebar.setLiveValues(S.liveValues);
    stats.update(S);
}

/** Live reset: assert for resetCycles, then release — state, not restart. */
function liveResetPulse() {
    const cycles = Math.max(1, Number(S.lastPayload?.resetCycles) || 2);
    safeCall(() => session?.liveInput?.({ keys: S.keyState, dip: S.dipState, reset: true }));
    safeCall(() => session?.liveStep?.(cycles));
    safeCall(() => session?.liveInput?.({ keys: S.keyState, dip: S.dipState, reset: false }));
}

function resetSim() {
    if (S.liveActive) {
        liveResetPulse();
        log("Live reset pulse sent", "cmd");
        return;
    }
    if (!session || (!S.running && !S.paused)) {
        toast("No simulation session — press Compile first", { kind: "warn" });
        return;
    }
    driveBuzzer(false, 0, 0);
    if (S.releaseTimer) { clearTimeout(S.releaseTimer); S.releaseTimer = null; }
    safeCall(() => session?.reset?.());
}
function stepSim(n) {
    if (S.liveActive) {
        if (n > 0) safeCall(() => session?.liveStep?.(n));
        return;
    }
    if (!session || !S.paused) { toast("Stepping requires a paused simulation", { kind: "warn" }); return; }
    if (n > 0) safeCall(() => session?.step?.(n));
    else {
        const target = Math.max(0, S.cursorCycle + n);
        const cycle = cyclesMap.get(target);
        if (cycle) {
            S.cursorCycle = target;
            S.simTimeNs = cycle.time;
            S.liveValues = cycle.values;
            applyCycleToBoard(cycle);
            sidebar.setLiveValues(S.liveValues);
            stats.update(S);
        }
    }
}

function applyPeripherals(per, clockNs = 20) {
    if (!per) return;
    S.lastPeripherals = per;
    if (per.uart) { S.uart = per.uart; bottom.setUart(per.uart); }
    if (per.vga) { S.vga = per.vga; bottom.setVga(per.vga); }
    if (per.lcd !== undefined) { S.lcd = per.lcd; bottom.setLcd(per.lcd); }
    safeCall(() => sidebar?.setPeripherals?.(per));
    if (per.buzzer?.tone) {
        S.buzzer = { ...per.buzzer };
        if (clockNs) S.clockPeriodNs = Number(clockNs) || S.clockPeriodNs;
    }
}

// ------------------------------------------------------------------- VCD ---
function exportVcd() {
    const signals = S.signals || [];
    const cycles = Array.from(cyclesMap.values()).sort((a, b) => a.cycle - b.cycle);
    if (!cycles.length) { toast("No waveform to export — compile and run first", { kind: "warn" }); return; }
    const durationNs = Number(cycles[cycles.length - 1].time) || Number(S.simTimeNs) || 0;
    const text = buildVcd(signals, cycles, { timescaleNs: Number(S.clockNs) || 20, durationNs });
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "waveform.vcd";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log(`Exported waveform.vcd (${cycles.length} cycles)`, "ok");
}

// -------------------------------------------------------------- terminal ---
async function mountTerminal() {
    try {
        // Static import keeps the controller in the production bundle; the old
        // @vite-ignore dynamic import resolved against dist/assets and 404'd.
        if (!bottom?.getTerminalHost) return;
        terminal = createTerminalController(bottom.getTerminalHost());
        safeCall(() => terminal.connect?.());
        if (window.__cyclone) window.__cyclone.terminal = terminal;
        log("Terminal ready", "ok");
    } catch (err) {
        log(`Terminal unavailable: ${err.message}`, "warn");
    }
}

// ----------------------------------------------------------------- loops ---
let lastStatsTick = performance.now();
function startLoops() {
    setInterval(() => {
        const now = performance.now();
        const windowMs = now - lastStatsTick;
        lastStatsTick = now;
        S.updateLoad = Math.min(100, (updateAccum / Math.max(1, windowMs)) * 100);
        updateAccum = 0;
        const s = board?.stats?.();
        if (s) { S.fps = s.fps; S.drawCalls = s.drawCalls; }
        flushPendingUi();
        stats.update(S);
    }, 250);
}

function bindShortcuts() {
    // Keyboard-driven hardware inputs: hold 1–4 for KEY1..4, R for RESET
    // (live co-simulation and batch stimulus both route through the same
    // channel funnel).
    const keyFromCode = (code) => {
        const i = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(code);
        return i >= 0 ? i : -1;
    };
    document.addEventListener("keydown", (e) => {
        // Never hijack typing inside inputs, textareas, selects,
        // contenteditable hosts or the Monaco/CodeMirror editor.
        if (isEditableTarget(e.target)) return;
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); compileAndProgram(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === "\\") { e.preventDefault(); toggleRight(); return; }
        if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "b") {
            e.preventDefault(); toggleBottom(); return;
        }
        const keyIndex = keyFromCode(e.code);
        if (keyIndex >= 0 && !e.repeat) { setPhysicalKeyPressed(keyIndex, true); e.preventDefault(); return; }
        switch (e.key) {
            case "Escape": stopSim(); break;
            case "r": case "R":
                if (!e.repeat) {
                    if (S.liveActive) liveResetPulse();
                    else resetSim();
                }
                break;
            case "ArrowRight": if (S.paused || S.liveActive) { e.preventDefault(); stepSim(1); } break;
            case "ArrowLeft": if (S.paused) { e.preventDefault(); stepSim(-1); } break;
            case "+": case "=": board?.zoomIn?.(); break;
            case "-": case "_": board?.zoomOut?.(); break;
            case "f": case "F": board?.fit?.(); break;
            case "5": board?.setPreset?.("top"); break;
            case "6": board?.setPreset?.("front"); break;
            case "7": board?.setPreset?.("iso"); break;
            case "8": board?.setPreset?.("segmacro"); break;
            case "9": board?.setPreset?.("lcd"); break;
            case "p": case "P": togglePower(); break;
            default: break;
        }
    });
    document.addEventListener("keyup", (e) => {
        if (isEditableTarget(e.target)) return;
        const keyIndex = keyFromCode(e.code);
        if (keyIndex >= 0) setPhysicalKeyPressed(keyIndex, false);
    });
}

// ------------------------------------------------------------------- init --
async function init() {
    initComponents();
    initBoard();
    setTheme("dark");
    toolbar.setPower(true);
    resizeBoardSoon();
    bindShortcuts();
    startLoops();

    $("backend-retry")?.addEventListener("click", async () => {
        $("backend-banner")?.classList.add("hidden");
        await checkHealth();
        if (S.backendOk) { await loadProfile(); await loadBoards(); await loadExamples(); }
    });

    await checkHealth();
    await loadProfile();
    await loadBoards();
    await loadExamples();

    const def = S.examples.find((e) => e.id === "sevseg_keys")
        || S.examples.find((e) => /counter/i.test(e.id) || /counter/i.test(e.name));
    if (def) await loadExample(def.id);

    window.__cyclone = {
        board, state: S, api, compile: compileAndProgram, run: compileAndProgram,
        stopSim, editor, sidebar, bottom, audio, pause: togglePause, resetSim, stepSim,
        toggleDip, setPhysicalKeyPressed, selectBoard, importCustomBoard,
        computeChannelMask, applyStimulusEntry, handleChannelChange, terminal,
    };
    log("Cyclone IV Studio ready — press Compile & Run (Ctrl+Enter).", "info");
    mountTerminal();
}

init();
