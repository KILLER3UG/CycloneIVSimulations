// toolbar.js — Zone 1: a slim 42px monochrome header in three groups.
// Left: title + board selector + examples selector.
// Center: transport pill group + the single primary Compile & Run action.
// Right: audio pill with volume popover + the two view toggles.

import { icon } from "./icons.js";

export function createToolbar(root, h) {
    root.classList.add("toolbar");
    root.innerHTML = `
        <div class="tb-group tb-left">
            <span class="tb-title">Cyclone IV Studio</span>
            <label class="tb-select" title="Active FPGA board">
                <select id="tb-board-select" aria-label="FPGA Board"></select>
            </label>
            <label class="tb-select" title="Load a bundled example">
                <select id="tb-examples" aria-label="Load Example"><option value="">Examples&hellip;</option></select>
            </label>
        </div>

        <div class="tb-group tb-center">
            <div class="tb-pill" role="group" aria-label="Simulation transport">
                <button class="icon-btn tb-power" data-act="power" aria-label="Board power" aria-pressed="true" title="Board power (P)">${icon("power")}</button>
                <button class="icon-btn" data-act="pause" aria-label="Pause simulation" title="Pause / resume">${icon("pause")}</button>
                <button class="icon-btn" data-act="stop" aria-label="Stop simulation" title="Stop (Esc)">${icon("stop")}</button>
                <button class="icon-btn" data-act="reset" aria-label="Reset simulation" title="Reset">${icon("reset")}</button>
                <button class="icon-btn" data-act="step" aria-label="Step one cycle" title="Step +1 cycle">${icon("step")}</button>
            </div>
            <button type="button" class="btn btn-primary tb-compile" id="tb-compile" data-act="compile" title="Compile &amp; run (Ctrl+Enter)">${icon("play")}<span>Compile &amp; Run</span></button>
        </div>

        <div class="tb-group tb-right">
            <div class="tb-audio-pill">
                <button class="icon-btn tb-mute" id="tb-mute" title="Mute buzzer" aria-label="Mute buzzer" aria-pressed="false">${icon("volume")}</button>
                <span class="tb-audio-badge" id="tb-audio-badge" aria-live="polite">Silent</span>
                <button class="icon-btn tb-audio-caret" id="tb-audio-caret" aria-label="Volume" aria-expanded="false" title="Volume">&#9662;</button>
                <div class="tb-volume-pop" id="tb-volume-pop" hidden>
                    <label for="tb-volume">Buzzer volume</label>
                    <input type="range" id="tb-volume" min="0" max="100" step="1" value="55" aria-label="Buzzer volume">
                </div>
            </div>
            <button class="icon-btn tb-view" data-act="collapse" aria-label="Toggle right workbench" title="Toggle right workbench">${icon("slider")}</button>
            <button class="icon-btn tb-view" id="tb-toggle-bottom" aria-label="Toggle bottom dock" title="Toggle bottom dock">${icon("monitor")}</button>
            <button class="icon-btn" id="tb-update" aria-label="Check for updates" title="Check for updates">${icon("update")}</button>
        </div>
    `;

    const powerBtn = root.querySelector('[data-act="power"]');
    const pauseBtn = root.querySelector('[data-act="pause"]');
    const stepBtn = root.querySelector('[data-act="step"]');
    const boardSel = root.querySelector("#tb-board-select");
    const examplesSel = root.querySelector("#tb-examples");
    const muteBtn = root.querySelector("#tb-mute");
    const badge = root.querySelector("#tb-audio-badge");
    const caret = root.querySelector("#tb-audio-caret");
    const pop = root.querySelector("#tb-volume-pop");

    // Status/pipeline/version live in the HUD and diagnostics now; keep no-op
    // entry points so callers written against the older toolbar still work.
    function setStatus() {}
    function setStep() {}
    function setVersion() {}
    function setTheme() { /* the studio is dark-only */ }

    function setPower(on) {
        powerBtn.classList.toggle("on", !!on);
        powerBtn.setAttribute("aria-pressed", String(!!on));
        powerBtn.title = on ? "Power on — click to switch off" : "Power off — click to switch on";
    }

    function setRunning(running, paused = false) {
        pauseBtn.classList.toggle("active", !!paused);
        pauseBtn.title = paused ? "Resume" : "Pause";
        stepBtn.disabled = !!running && !paused;
        // The header owns compile now (the workbench footer button is gone):
        // mirror the run state on Compile & Run.
        const runBtn = root.querySelector("#tb-compile");
        if (runBtn) {
            runBtn.disabled = !!running;
            const label = runBtn.querySelector("span");
            if (label) label.textContent = running ? "Compiling\u2026" : "Compile & Run";
        }
    }

    function setExamples(list) {
        const items = Array.isArray(list) ? list : [];
        examplesSel.innerHTML = `<option value="">Examples&hellip;</option>`
            + items.map((e) => `<option value="${String(e.id)}">${e.name || e.id}</option>`).join("");
        examplesSel.value = "";
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

    root.addEventListener("change", (e) => {
        if (e.target === examplesSel && e.target.value) {
            const id = e.target.value;
            examplesSel.value = "";
            h.onExample?.(id);
        } else if (e.target === boardSel && e.target.value) {
            h.onBoard?.(e.target.value);
        }
    });

    root.addEventListener("click", (e) => {
        if (e.target === caret) {
            const open = pop.hidden;
            pop.hidden = !open;
            caret.setAttribute("aria-expanded", String(open));
            return;
        }
        if (!pop.hidden && !e.target.closest(".tb-audio-pill")) {
            pop.hidden = true;
            caret.setAttribute("aria-expanded", "false");
        }
        if (e.target.closest("#tb-toggle-bottom")) {
            h.onToggleBottom?.();
            return;
        }
        if (e.target.closest("#tb-update")) {
            h.onUpdate?.();
            return;
        }
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        switch (btn.dataset.act) {
            case "power": h.onPower?.(); break;
            case "pause": h.onPause?.(); break;
            case "stop": h.onStop?.(); break;
            case "reset": h.onReset?.(); break;
            case "step": h.onStep?.(); break;
            case "compile": h.onRun?.(); break;
            case "mute": h.onMute?.(); break;
            case "collapse": h.onToggleRight?.(); break;
            default: break;
        }
    });

    return {
        setStatus, setStep, setPower, setRunning, setTheme, setVersion,
        setExamples, setBoards, setActiveBoard, setAudio, root,
    };
}
