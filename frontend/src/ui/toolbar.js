// toolbar.js — top toolbar: power, run/pause/stop/reset/step, the compile
// pipeline (Analyze → Compile → Pin check → Program → Run), status badge,
// theme toggle and help. Camera presets live on the board overlay (index.html).

import { icon } from "./icons.js";

const STEPS = ["Analyze", "Compile", "Pin check", "Program", "Run"];

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
            <div class="run-wrap">
                <button class="btn btn-primary tb-run" data-act="run" title="Compile + upload + run (Ctrl+Enter)">${icon("play")}<span>Run</span></button>
                <button class="btn btn-primary tb-run-caret" data-act="runmenu" aria-label="Programming mode" aria-haspopup="true">${icon("chevron")}</button>
                <div class="run-menu hidden" role="menu">
                    <button type="button" role="menuitem" data-mode="jtag"><strong>Program (JTAG, volatile)</strong><small>configure the FPGA directly; image is lost on power-off</small></button>
                    <button type="button" role="menuitem" data-mode="as"><strong>Program flash (AS, persistent)</strong><small>write the EPCS16 configuration flash &mdash; simulated</small></button>
                </div>
            </div>
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
            <button class="icon-btn" data-act="theme" aria-label="Toggle dark theme" title="Theme (T)">${icon("moon")}</button>
            <button class="icon-btn" data-act="help" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">${icon("help")}</button>
            <button class="icon-btn only-narrow" data-act="right" aria-label="Toggle editor panel" title="Editor">${icon("file")}</button>
        </div>
    `;

    const badge = root.querySelector("#status-badge");
    const powerBtn = root.querySelector('[data-act="power"]');
    const runBtn = root.querySelector('[data-act="run"]');
    const menu = root.querySelector(".run-menu");
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
        runBtn.classList.toggle("running", running && !paused);
        runBtn.querySelector("span").textContent = running && !paused ? "Running" : "Run";
        pauseBtn.classList.toggle("active", paused);
        pauseBtn.title = paused ? "Resume" : "Pause";
        stepBtn.disabled = running && !paused;
        stepBtn.classList.toggle("disabled", running && !paused);
    }

    function setTheme(dark) {
        themeBtn.innerHTML = dark ? icon("sun") : icon("moon");
        themeBtn.title = dark ? "Switch to light theme" : "Switch to dark theme";
    }

    root.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        const modeBtn = e.target.closest("[data-mode]");
        if (modeBtn) {
            menu.classList.add("hidden");
            h.onRunMode?.(modeBtn.dataset.mode);
            return;
        }
        switch (btn.dataset.act) {
            case "power": h.onPower?.(); break;
            case "run": menu.classList.add("hidden"); h.onRun?.(); break;
            case "runmenu": menu.classList.toggle("hidden"); break;
            case "pause": h.onPause?.(); break;
            case "stop": h.onStop?.(); break;
            case "reset": h.onReset?.(); break;
            case "step": h.onStep?.(); break;
            case "theme": h.onTheme?.(); break;
            case "help": h.onHelp?.(); break;
            case "left": h.onToggleLeft?.(); break;
            case "right": h.onToggleRight?.(); break;
            default: break;
        }
    });

    document.addEventListener("click", (e) => {
        if (!e.target.closest(".run-wrap")) menu.classList.add("hidden");
    });

    return { setStatus, setStep, setPower, setRunning, setTheme, root };
}
