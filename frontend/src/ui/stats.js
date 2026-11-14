// stats.js — bottom-left SimulIDE-style simulation stats block.
// Updated at ~4 Hz by main.js via `update()`.

function fmtClock(hz) {
    if (!Number.isFinite(hz) || hz <= 0) return "--";
    if (hz >= 1e9) return (hz / 1e9).toFixed(2) + " GHz";
    if (hz >= 1e6) return (hz / 1e6).toFixed(2) + " MHz";
    if (hz >= 1e3) return (hz / 1e3).toFixed(2) + " kHz";
    return Math.round(hz) + " Hz";
}

// SimulIDE-style decomposed simulation time: hhh:mm:ss . mmm . uuu . nnn
export function fmtSimTime(ns) {
    if (!Number.isFinite(ns) || ns < 0) ns = 0;
    const totalNs = Math.round(ns);
    const n = totalNs % 1000;
    const totalUs = Math.floor(totalNs / 1000);
    const u = totalUs % 1000;
    const totalMs = Math.floor(totalUs / 1000);
    const ms = totalMs % 1000;
    const totalS = Math.floor(totalMs / 1000);
    const s = totalS % 60;
    const totalM = Math.floor(totalS / 60);
    const m = totalM % 60;
    const h = Math.floor(totalM / 60);
    const pad = (v, w = 2) => String(v).padStart(w, "0");
    return `${pad(h, 3)}:${pad(m)}:${pad(s)} s ${pad(ms, 3)} ms ${pad(u, 3)} \u00b5s ${pad(n, 3)} ns`;
}

export function createStatsBlock(container) {
    container.classList.add("stats-block");
    container.innerHTML = `
        <div class="stat-row"><span class="stat-label">Sim time</span><span class="stat-value stat-time" id="st-time">000:00:00 s 000 ms 000 \u00b5s 000 ns</span></div>
        <div class="stat-row"><span class="stat-label">Target</span><span class="stat-value" id="st-target">--</span></div>
        <div class="stat-row"><span class="stat-label">Real speed</span><span class="stat-value" id="st-real">--</span></div>
        <div class="stat-row"><span class="stat-label">Engine load</span><span class="stat-value" id="st-engine">--</span></div>
        <div class="stat-row"><span class="stat-label">Update load</span><span class="stat-value" id="st-update">--</span></div>
        <div class="stat-row"><span class="stat-label">Real FPS</span><span class="stat-value" id="st-fps">--</span></div>
    `;
    const el = {
        time: container.querySelector("#st-time"),
        target: container.querySelector("#st-target"),
        real: container.querySelector("#st-real"),
        engine: container.querySelector("#st-engine"),
        update: container.querySelector("#st-update"),
        fps: container.querySelector("#st-fps"),
    };
    let lastState = null;
    function update(state) {
        lastState = state;
        el.time.textContent = fmtSimTime(state.simTimeNs);
        el.target.textContent = fmtClock(state.simStats.targetSpeed);
        el.real.textContent = state.running || state.paused
            ? `${(state.simStats.realSpeed ?? 0).toFixed(2)} %`
            : "--";
        el.engine.textContent = state.simStats.engineLoad == null
            ? "--"
            : `${state.simStats.engineLoad.toFixed(2)} %`;
        el.update.textContent = `${state.updateLoad.toFixed(1)} %`;
        el.fps.textContent = String(Math.round(state.fps || 0));
    }
    // refresh from shared state on the 4 Hz tick handled by main.js
    return { update, el: container };
}
