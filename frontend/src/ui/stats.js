// stats.js — compact horizontal HUD strip for the 3D canvas.
// The board viewport keeps this inline inside .board-hud-pill (never stretched).

function fmtClock(hz) {
    if (!Number.isFinite(hz) || hz <= 0) return "--";
    if (hz >= 1e9) return (hz / 1e9).toFixed(2) + " GHz";
    if (hz >= 1e6) return (hz / 1e6).toFixed(0) + " MHz";
    if (hz >= 1e3) return (hz / 1e3).toFixed(0) + " kHz";
    return Math.round(hz) + " Hz";
}

export function fmtSimTime(ns) {
    if (!Number.isFinite(ns) || ns < 0) ns = 0;
    if (ns < 1000) return `${Math.round(ns)} ns`;
    if (ns < 1e6) return `${(ns / 1e3).toFixed(2)} \u00b5s`;
    if (ns < 1e9) return `${(ns / 1e6).toFixed(2)} ms`;
    return `${(ns / 1e9).toFixed(3)} s`;
}

function counts(state) {
    const b = state.boardProfile?.board || state.profile?.board || {};
    const keys = b.buttons?.pins?.length || b.buttons?.count || 0;
    const switches = b.switches?.pins?.length || b.switches?.count || 0;
    const shared = !!b.switches?.sharedWithButtons;
    return { keys, switches, shared };
}

export function createStatsBlock(container) {
    container.classList.add("stats-block", "stats-pill");
    // Subtle scope reminder: this is an RTL functional simulation (GHDL).
    // Gate-level timing (routing delays, setup/hold, Fmax, SDF) requires
    // Quartus Synthesis + Fitter + TimeQuest STA and is NOT modelled here.
    container.title =
        "RTL functional simulation only (GHDL) - no gate-level timing/STA. " +
        "Quartus Synthesis + TimeQuest are authoritative for timing closure.";
    container.innerHTML = `
        <span class="hud-item hud-live" id="st-status">Live</span>
        <span class="hud-sep">&middot;</span>
        <span class="hud-item" id="st-target" title="simulated clock period (RTL functional only - no gate-level timing)">50 MHz</span>
        <span class="hud-sep">&middot;</span>
        <span class="hud-item hud-latency" id="st-latency">&lt;1ms</span>
        <span class="hud-bar">|</span>
        <span class="hud-item" id="st-keys">KEY 1..4</span>
        <span class="hud-item" id="st-sw">SW 1..4</span>
        <span class="hud-sep">&middot;</span>
        <span class="hud-item" id="st-time">Sim: 0 ns</span>
        <span class="hud-sep">&middot;</span>
        <span class="hud-item" id="st-scope" title="RTL functional simulation only (GHDL) - no gate-level timing/STA">RTL</span>
    `;
    const el = {
        status: container.querySelector("#st-status"),
        target: container.querySelector("#st-target"),
        latency: container.querySelector("#st-latency"),
        keys: container.querySelector("#st-keys"),
        sw: container.querySelector("#st-sw"),
        time: container.querySelector("#st-time"),
    };

    function update(state) {
        const { keys, switches, shared } = counts(state);
        el.target.textContent = fmtClock(state.simStats?.targetSpeed || state.clockHz);
        el.time.textContent = `Sim: ${fmtSimTime(state.simTimeNs)}`;
        el.status.textContent = state.status || "Live";
        el.latency.textContent = state.stimulusMap ? "<1ms" : "GHDL";
        el.keys.textContent = keys ? (shared ? `K1..${keys}` : `K0..${keys - 1}`) : "K --";
        el.sw.textContent = switches
            ? (shared ? `S1..${switches} shared` : `SW0..${switches - 1}`)
            : "SW --";
    }

    return { update, el: container };
}
