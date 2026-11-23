// toolbar.js — Zone 1: Quartus Prime Standard Edition main toolbar.
// Matches the reference screenshots:
// New / Open / Save | Cut / Copy / Paste | Undo / Redo | Project dropdown |
// Stop | Start Compilation (Ctrl+L) | Analysis & Synthesis | Fitter |
// Assembler | Timing Analysis | EDA Netlist Writer | Programmer |
// Open in Quartus | Settings | Audio + Right/Bottom dock toggles.

import { icon } from "./icons.js";

export function createToolbar(root, h) {
    root.classList.add("toolbar");
    root.innerHTML = `
        <div class="tb-group tb-left">
            <button type="button" class="q-tool-btn" data-act="new" title="New VHDL File">${icon("qNew")}</button>
            <button type="button" class="q-tool-btn" data-act="open" title="Open Source / Project Files">${icon("qOpen")}</button>
            <button type="button" class="q-tool-btn" data-act="save" title="Save Current File (Ctrl+S)">${icon("qSave")}</button>
            <span class="tb-sep" aria-hidden="true"></span>
            <button type="button" class="q-tool-btn" data-act="cut" title="Cut (Ctrl+X)">${icon("qCut")}</button>
            <button type="button" class="q-tool-btn" data-act="copy" title="Copy (Ctrl+C)">${icon("qCopy")}</button>
            <button type="button" class="q-tool-btn" data-act="paste" title="Paste (Ctrl+V)">${icon("qPaste")}</button>
            <span class="tb-sep" aria-hidden="true"></span>
            <button type="button" class="q-tool-btn" data-act="undo" title="Undo (Ctrl+Z)">${icon("qUndo")}</button>
            <button type="button" class="q-tool-btn" data-act="redo" title="Redo (Ctrl+Y)">${icon("qRedo")}</button>
            <span class="tb-sep" aria-hidden="true"></span>
            <label class="tb-select tb-proj-select" title="Active Project / Revision">
                <select id="tb-examples" aria-label="Project / Example"></select>
            </label>
            <select id="tb-board-select" aria-label="FPGA Board" class="hidden"></select>
            <span class="tb-sep" aria-hidden="true"></span>
            <button type="button" class="q-tool-btn" data-act="pin-planner" title="Pin Planner">${icon("qPinPlan")}</button>
            <button type="button" class="q-tool-btn" data-act="settings" title="Settings (Quartus Path &amp; Options)">${icon("qSettings")}</button>
            <button type="button" class="q-tool-btn" data-act="open-quartus" title="Open in Quartus Prime GUI">${icon("qQuartus")}</button>
            <span class="tb-sep" aria-hidden="true"></span>
            <button type="button" class="q-tool-btn q-stop-btn" id="tb-stop" data-act="stop" title="Stop Compilation / Simulation (Esc)">${icon("qStop")}</button>
            <button type="button" class="q-tool-btn q-compile-btn" id="tb-compile" data-act="compile" title="Start Compilation (Ctrl+L)">${icon("qCompile")}</button>
            <button type="button" class="q-tool-btn" data-act="stage-analysis" title="Start Analysis &amp; Synthesis">${icon("qSynth")}</button>
            <button type="button" class="q-tool-btn" data-act="stage-fitter" title="Start Fitter (Place &amp; Route)">${icon("qFitter")}</button>
            <button type="button" class="q-tool-btn" data-act="stage-assembler" title="Start Assembler">${icon("qAsm")}</button>
            <button type="button" class="q-tool-btn" data-act="stage-timing" title="Start Timing Analysis">${icon("qTiming")}</button>
            <button type="button" class="q-tool-btn" data-act="stage-eda" title="Start EDA Netlist Writer">${icon("qEda")}</button>
            <button type="button" class="q-tool-btn" data-act="programmer" title="Programmer (Open Quartus Programmer / Program 3D Board)">${icon("qPgm")}</button>
            <button type="button" class="q-tool-btn" data-act="about" title="About Quartus Prime Standard Edition">${icon("qHelpBubble")}</button>
        </div>

        <div class="tb-group tb-right">
            <div class="tb-audio-pill">
                <button class="q-tool-btn tb-mute" id="tb-mute" title="Mute buzzer" aria-label="Mute buzzer" aria-pressed="false">${icon("volume")}</button>
                <span class="tb-audio-badge" id="tb-audio-badge" aria-live="polite">Silent</span>
                <button class="q-tool-btn tb-audio-caret" id="tb-audio-caret" aria-label="Volume" aria-expanded="false" title="Volume">&#9662;</button>
                <div class="tb-volume-pop" id="tb-volume-pop" hidden>
                    <label for="tb-volume">Buzzer volume</label>
                    <input type="range" id="tb-volume" min="0" max="100" step="1" value="55" aria-label="Buzzer volume">
                </div>
            </div>
            <button class="q-tool-btn tb-view" data-act="collapse" aria-label="Toggle 3D Devboard" title="Toggle 3D Devboard sidebar (Ctrl+\\)">${icon("qChip")}</button>
            <button class="q-tool-btn tb-view" id="tb-toggle-bottom" aria-label="Toggle Messages / Terminal dock" title="Toggle Messages &amp; Terminal dock">${icon("terminal")}</button>
            <button class="q-tool-btn" id="tb-update" aria-label="Check for updates" title="Check for updates">${icon("update")}</button>
        </div>
    `;

    const boardSel = root.querySelector("#tb-board-select");
    const examplesSel = root.querySelector("#tb-examples");
    const muteBtn = root.querySelector("#tb-mute");
    const badge = root.querySelector("#tb-audio-badge");
    const caret = root.querySelector("#tb-audio-caret");
    const pop = root.querySelector("#tb-volume-pop");

    function setStatus() {}
    function setStep() {}
    function setVersion() {}
    function setTheme() {}

    function setPower(on) {
        const powerBtn = document.querySelector('#sim-bar [data-act="power"]');
        if (!powerBtn) return;
        powerBtn.classList.toggle("on", !!on);
        powerBtn.setAttribute("aria-pressed", String(!!on));
        powerBtn.title = on ? "Power on — click to switch off" : "Power off — click to switch on";
    }

    function setRunning(running, paused = false) {
        const pauseBtn = document.querySelector('#sim-bar [data-act="pause"]');
        if (pauseBtn) {
            pauseBtn.classList.toggle("active", !!paused);
            pauseBtn.title = paused ? "Resume" : "Pause";
        }
        const stepBtn = document.querySelector('#sim-bar [data-act="step"]');
        if (stepBtn) stepBtn.disabled = !!running && !paused;

        const runBtn = root.querySelector("#tb-compile");
        if (runBtn) {
            runBtn.classList.toggle("running", !!running);
            runBtn.title = running ? "Compiling..." : "Start Compilation (Ctrl+L)";
        }
        const stopBtn = root.querySelector("#tb-stop");
        if (stopBtn) stopBtn.classList.toggle("active-stop", !!running);
    }

    function setExamples(list, activeProjectName) {
        const items = Array.isArray(list) ? list : [];
        examplesSel.innerHTML = items.map((e) => `<option value="${String(e.id)}">${e.name || e.id}</option>`).join("")
            + `<option value="" disabled>──────────</option>`;
        if (activeProjectName) {
            const match = items.find((e) => e.id === activeProjectName || e.name === activeProjectName);
            if (match) examplesSel.value = match.id;
        }
    }

    function setProjectLabel(name) {
        if (!name) return;
        const opt = Array.from(examplesSel.options).find((o) => o.value === name || o.textContent === name);
        if (opt) examplesSel.value = opt.value;
    }

    function setBoards(list, activeId) {
        const items = Array.isArray(list) ? list : [];
        boardSel.innerHTML = items.map((b) => {
            const id = String(b.id ?? b.name ?? "");
            const label = b.name || id;
            return `<option value="${id}">${label}</option>`;
        }).join("");
        if (activeId !== undefined && activeId !== null) boardSel.value = String(activeId);
    }

    function setActiveBoard(id) {
        if (id !== undefined && id !== null) boardSel.value = String(id);
    }

    function setAudio(st) {
        const state = st || {};
        const muted = !!state.muted;
        const active = !!state.active && !!state.frequency;
        badge.textContent = muted ? "Muted" : active ? `${Math.round(state.frequency)} Hz` : "Silent";
        muteBtn.innerHTML = muted ? icon("mute") : icon("volume");
        muteBtn.classList.toggle("muted", muted);
        muteBtn.setAttribute("aria-pressed", String(muted));
        muteBtn.title = muted ? "Unmute buzzer (M)" : "Mute buzzer (M)";
        const vol = root.querySelector("#tb-volume");
        if (vol && document.activeElement !== vol && Number.isFinite(state.volume)) {
            vol.value = String(Math.round(state.volume * 100));
        }
    }

    function setLive(visible, pace, speedText) {
        const pill = document.getElementById("tb-live-pill");
        if (pill) pill.hidden = !visible;
        const sel = document.getElementById("tb-pace");
        if (sel && pace) sel.value = String(pace);
        const speed = document.getElementById("tb-live-speed");
        if (speed) speed.textContent = speedText || "\u2014";
    }

    function setLiveSpeed(speedText) {
        const speed = document.getElementById("tb-live-speed");
        if (speed) speed.textContent = speedText || "\u2014";
    }

    root.addEventListener("change", (e) => {
        if (e.target === examplesSel && e.target.value) {
            h.onExample?.(e.target.value);
        } else if (e.target === boardSel && e.target.value) {
            h.onBoard?.(e.target.value);
        }
    });

    root.addEventListener("click", (e) => {
        if (e.target.closest("#tb-audio-caret")) {
            const open = pop.hidden;
            pop.hidden = !open;
            caret.setAttribute("aria-expanded", String(open));
            return;
        }
        if (!pop.hidden && !e.target.closest(".tb-audio-pill")) {
            pop.hidden = true;
            caret.setAttribute("aria-expanded", "false");
        }
        if (e.target.closest("#tb-mute")) { h.onMute?.(); return; }
        if (e.target.closest("#tb-toggle-bottom")) { h.onToggleBottom?.(); return; }
        if (e.target.closest("#tb-update")) { h.onUpdate?.(); return; }
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === "compile") h.onRun?.();
        else if (act === "stop") h.onStop?.();
        else if (act === "collapse") h.onToggleRight?.();
        else h.onAction?.(act);
    });

    // Hover status-bar hint text like Quartus Prime
    root.addEventListener("mouseover", (e) => {
        const btn = e.target.closest("[title]");
        if (btn?.title) h.onStatusHint?.(btn.title);
    });
    root.addEventListener("mouseout", () => h.onStatusHint?.("Ready"));

    return {
        setStatus, setStep, setPower, setRunning, setTheme, setVersion,
        setExamples, setProjectLabel, setBoards, setActiveBoard, setAudio, setLive, setLiveSpeed, root,
    };
}
