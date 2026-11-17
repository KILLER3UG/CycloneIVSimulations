// stats.js — single-line floating HUD pill for the 3D canvas.
// Updated at ~4 Hz by main.js via `update()`.

function fmtClock(hz) {
    if (!Number.isFinite(hz) || hz <= 0) return "--";
    if (hz >= 1e9) return (hz / 1e9).toFixed(2) + " GHz";
    if (hz >= 1e6) return (hz / 1e6).toFixed(2) + " MHz";
    if (hz >= 1e3) return (hz / 1e3).toFixed(2) + " kHz";
    return Math.round(hz) + " Hz";
}

// Compact simulation time: picks the largest sensible unit.
export function fmtSimTime(ns) {
    if (!Number.isFinite(ns) || ns < 0) ns = 0;
    if (ns < 1000) return `${Math.round(ns)} ns`;
    if (ns < 1e6) return `${(ns / 1e3).toFixed(2)} \u00b5s`;
    if (ns < 1e9) return `${(ns / 1e6).toFixed(2)} ms`;
    return `${(ns / 1e9).toFixed(3)} s`;
}

export function createStatsBlock(container) {
    container.classList.add("stats-block", "stats-pill");
    container.innerHTML = `
        <span class="hud-item" id="st-status">Idle</span>
        <span class="hud-sep">\u00b7</span>
        <span class="hud-item" id="st-target">--</span>
        <span class="hud-sep">\u00b7</span>
        <span class="hud-item" id="st-time">Sim: 0 ns</span>
        <span class="hud-sep">\u00b7</span>
        <span class="hud-item" id="st-fps">-- FPS</span>
    `;
    const el = {
        status: container.querySelector("#st-status"),
        target: container.querySelector("#st-target"),
        time: container.querySelector("#st-time"),
        fps: container.querySelector("#st-fps"),
    };
    function update(state) {
        el.target.textContent = fmtClock(state.simStats.targetSpeed);
        el.time.textContent = `Sim: ${fmtSimTime(state.simTimeNs)}`;
        el.fps.textContent = `${Math.round(state.fps || 0)} FPS`;
        el.status.textContent = state.status || "Idle";
    }
    // refresh from shared state on the 4 Hz tick handled by main.js
    return { update, el: container };
}
