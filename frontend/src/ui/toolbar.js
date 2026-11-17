// toolbar.js — top toolbar: power, pause/stop/reset/step, the compile
// pipeline (Analyze → Compile → Pin check → Program → Simulate), status badge,
// theme toggle, licenses/about, and help. Header has no Compile or Run button.

import { icon } from "./icons.js";

const STEPS = ["Analyze", "Compile", "Pin check", "Program", "Simulate"];

export function createToolbar(root, h) {
    root.classList.add("toolbar");
    root.innerHTML = `
        <div class="tb-group tb-left">
            <button class="icon-btn only-narrow" data-act="left" aria-label="Toggle components sidebar" title="Components">${icon("menu")}</button>
            <span class="tb-title">Cyclone IV Studio</span>
            <span class="tb-sub">RZ-EasyFPGA A2.2</span>
        </div>
        <div class="tb-group tb-center">
            <button class="icon-btn tb-power" data-act="power" aria-label="Board power" aria-pressed="true" title="Board power (P)">${icon("power")}</button>
            <span class="tb-sep"></span>
            <button class="icon-btn" data-act="pause" aria-label="Pause simulation" title="Pause">${icon("pause")}</button>
            <button class="icon-btn" data-act="stop" aria-label="Stop simulation" title="Stop (Esc)">${icon("stop")}</button>
            <button class="icon-btn" data-act="reset" aria-label="Reset simulation cursor" title="Reset cursor to cycle 0">${icon("reset")}</button>
            <button class="icon-btn" data-act="step" aria-label="Step one cycle" title="Step +1 cycle (while paused)">${icon("step")}</button>
            <div class="tb-pipeline" id="tb-pipeline" aria-label="Compile pipeline">
                ${STEPS.map((s) => `<span class="tb-step" data-step="${s}"><span class="tb-step-dot"></span>${s}</span>`).join("")}
            </div>
        </div>
        <div class="tb-group tb-right">
            <span class="status-badge st-idle" id="status-badge" role="status">
                ${icon("info")}<span id="status-text">Idle</span>
            </span>
            <button type="button" class="btn-version" data-act="about" id="tb-version" title="About Cyclone IV Studio &amp; Licenses" aria-label="About and licenses">v0.1.0</button>
            <button class="icon-btn tb-audio" data-act="mute" id="tb-mute" title="Mute buzzer (M)" aria-label="Mute buzzer" aria-pressed="false">${icon("volume")}</button>
            <span class="tb-audio-badge" id="tb-audio-badge" aria-live="polite">Silent</span>
            <input type="range" id="tb-volume" class="tb-volume" min="0" max="100" step="1" value="55" aria-label="Buzzer volume" title="Buzzer volume" />
            <button class="icon-btn" data-act="theme" aria-label="Toggle dark theme" title="Theme (T)">${icon("moon")}</button>
            <button class="icon-btn" data-act="help" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">${icon("help")}</button>
            <button class="icon-btn only-narrow" data-act="right" aria-label="Toggle editor panel" title="Editor">${icon("file")}</button>
        </div>
    `;

    const badge = root.querySelector("#status-badge");
    const powerBtn = root.querySelector('[data-act="power"]');
    const pauseBtn = root.querySelector('[data-act="pause"]');
    const stepBtn = root.querySelector('[data-act="step"]');
    const themeBtn = root.querySelector('[data-act="theme"]');
    const steps = [...root.querySelectorAll(".tb-step")];

    const LABELS = {
        idle: ["Idle", "info"],
        compiling: ["Compiling\u2026", "info"],
        programming: ["Programming\u2026", "info"],
        running: ["Running", "check"],
        paused: ["Paused", "pause"],
        error: ["Error", "alert"],
    };

    function setStatus(status, detail = "") {
        const [label, ic] = LABELS[status] || LABELS.idle;
        badge.className = `status-badge st-${status}`;
        badge.innerHTML = `${icon(ic)}<span id="status-text">${label}</span>`;
        badge.title = detail || label;
    }

    // Pipeline progress: same semantics as the old editor steps —
    // setStep(i, state): steps < i done, step i = state ("active"|"done"|"error").
    function setStep(current, state = "active") {
        const idx = typeof current === "number" ? current : STEPS.indexOf(current);
        steps.forEach((s, i) => {
            s.classList.remove("active", "done", "error");
            if (idx < 0) return;
            if (i < idx) s.classList.add("done");
            else if (i === idx) s.classList.add(state === "error" ? "error" : state);
            else if (idx >= STEPS.length) s.classList.add("done");
        });
    }

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

    function setVersion(v) {
        const btn = root.querySelector("#tb-version");
        if (btn && v) btn.textContent = `v${String(v).replace(/^v/i, "")}`;
    }

    root.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        switch (btn.dataset.act) {
            case "power": h.onPower?.(); break;
            case "pause": h.onPause?.(); break;
            case "stop": h.onStop?.(); break;
            case "reset": h.onReset?.(); break;
            case "step": h.onStep?.(); break;
            case "theme": h.onTheme?.(); break;
            case "mute": h.onMute?.(); break;
            case "help": h.onHelp?.(); break;
            case "about": h.onAbout?.(); break;
            case "left": h.onToggleLeft?.(); break;
            case "right": h.onToggleRight?.(); break;
            default: break;
        }
    });

    return { setStatus, setStep, setPower, setRunning, setTheme, setVersion, root };
}
