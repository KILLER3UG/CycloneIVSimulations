// toolbar.js — slim top bar (Zone 1): title + example loader on the left, the
// transport/compile controls in the centre, and the live audio pill + theme on
// the right. Compile is the single primary action.

import { icon } from "./icons.js";

export function createToolbar(root, h) {
    root.classList.add("toolbar");
    root.innerHTML = `
        <div class="tb-group tb-left">
            <button class="icon-btn only-narrow" data-act="left" aria-label="Toggle components sidebar" title="Components">${icon("menu")}</button>
            <span class="tb-title">Cyclone IV Studio</span>
            <label class="tb-examples" title="Load a bundled example">
                <span class="tb-examples-lbl">Examples</span>
                <select id="tb-examples" aria-label="Load bundled example"><option value="">Examples\u2026</option></select>
            </label>
        </div>
        <div class="tb-group tb-center">
            <button class="icon-btn tb-power" data-act="power" aria-label="Board power" aria-pressed="true" title="Board power (P)">${icon("power")}</button>
            <span class="tb-sep"></span>
            <button class="icon-btn" data-act="pause" aria-label="Pause simulation" title="Pause">${icon("pause")}</button>
            <button class="icon-btn" data-act="stop" aria-label="Stop simulation" title="Stop (Esc)">${icon("stop")}</button>
            <button class="icon-btn" data-act="reset" aria-label="Reset simulation cursor" title="Reset cursor to cycle 0">${icon("reset")}</button>
            <button class="icon-btn" data-act="step" aria-label="Step one cycle" title="Step +1 cycle (while paused)">${icon("step")}</button>
            <span class="tb-sep"></span>
            <button type="button" class="btn btn-primary tb-compile" id="tb-compile" title="Compile design and load onto board (Ctrl+Enter)">${icon("play")}<span>Compile</span></button>
        </div>
        <div class="tb-group tb-right">
            <button class="icon-btn tb-audio" data-act="mute" id="tb-mute" title="Mute buzzer (M)" aria-label="Mute buzzer" aria-pressed="false">${icon("volume")}</button>
            <span class="tb-audio-badge" id="tb-audio-badge" aria-live="polite">Silent</span>
            <input type="range" id="tb-volume" class="tb-volume" min="0" max="100" step="1" value="55" aria-label="Buzzer volume" title="Buzzer volume" />
            <button class="icon-btn" data-act="theme" aria-label="Toggle dark theme" title="Theme (T)">${icon("moon")}</button>
            <button class="icon-btn" data-act="help" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">${icon("help")}</button>
            <button class="icon-btn only-narrow" data-act="right" aria-label="Toggle workbench" title="Workbench">${icon("file")}</button>
        </div>
    `;

    const powerBtn = root.querySelector('[data-act="power"]');
    const pauseBtn = root.querySelector('[data-act="pause"]');
    const stepBtn = root.querySelector('[data-act="step"]');
    const themeBtn = root.querySelector('[data-act="theme"]');
    const examplesSel = root.querySelector("#tb-examples");

    let currentStatus = "idle";

    // The header carries no status/pipeline badges any more: the floating HUD
    // pill over the 3D canvas shows the live status. These stay as no-op
    // entry points so the rest of the app keeps working unchanged.
    function setStatus(status, detail = "") {
        currentStatus = status || "idle";
        if (detail) currentStatus = `${currentStatus} \u2014 ${detail}`;
    }
    function setStep() { /* pipeline pills removed */ }
    function setVersion() { /* version shown in the About dialog */ }

    function setPower(on) {
        powerBtn.classList.toggle("on", on);
        powerBtn.setAttribute("aria-pressed", String(on));
        powerBtn.title = on ? "Power on \u2014 click to switch off" : "Power off \u2014 click to switch on";
    }

    function setRunning(running, paused = false) {
        pauseBtn.classList.toggle("active", paused);
        pauseBtn.title = paused ? "Resume" : "Pause";
        stepBtn.disabled = running && !paused;
        stepBtn.classList.toggle("disabled", running && !paused);
    }

    function setTheme(dark) {
        themeBtn.innerHTML = dark ? icon("sun") : icon("moon");
        themeBtn.title = dark ? "Switch to light theme" : "Switch to dark theme";
    }

    function setExamples(list) {
        if (!examplesSel) return;
        const items = Array.isArray(list) ? list : [];
        examplesSel.innerHTML = `<option value="">Examples\u2026</option>`
            + items.map((e) => `<option value="${e.id}">${e.name || e.id}</option>`).join("");
        examplesSel.value = "";
    }

    root.addEventListener("change", (e) => {
        if (e.target === examplesSel && e.target.value) {
            const id = e.target.value;
            examplesSel.value = "";
            h.onExample?.(id);
        }
    });

    root.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        switch (btn.dataset.act) {
            case "power": h.onPower?.(); break;
            case "pause": h.onPause?.(); break;
            case "stop": h.onStop?.(); break;
            case "reset": h.onReset?.(); break;
            case "step": h.onStep?.(); break;
            case "compile": h.onRun?.(); break;
            case "theme": h.onTheme?.(); break;
            case "mute": h.onMute?.(); break;
            case "help": h.onHelp?.(); break;
            case "about": h.onAbout?.(); break;
            case "left": h.onToggleLeft?.(); break;
            case "right": h.onToggleRight?.(); break;
            default: break;
        }
    });

    return { setStatus, setStep, setPower, setRunning, setTheme, setVersion, setExamples, root };
}
