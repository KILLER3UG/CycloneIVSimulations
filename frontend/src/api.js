// api.js — REST client + WebSocket simulation session for the GHDL backend.

const FALLBACK_ORIGINS = ["http://127.0.0.1:8080", "http://127.0.0.1:8000", "http://127.0.0.1:8765"];
let detectedBackendOrigin = "";

// Same-origin by default. A host page may override the API base before app
// start (window.CYCLONE_API_BASE); WebSocket URLs are derived from the same
// value so the simulation and the terminal always reach one backend.
export const API_BASE = "";

function configuredApiBase() {
    if (typeof window === "undefined") return API_BASE;
    return window.CYCLONE_API_BASE || window.API_BASE || API_BASE || "";
}

function configuredOrigin() {
    const base = configuredApiBase();
    if (!base) return "";
    try {
        return new URL(base, typeof location === "undefined" ? "http://localhost/" : location.href).origin.replace(/\/+$/, "");
    } catch {
        return String(base).replace(/\/+$/, "");
    }
}

function wsOrigin() {
    const origin = configuredOrigin() || detectedBackendOrigin;
    if (origin) return origin.replace(/^http/, "ws").replace(/\/+$/, "");
    if (typeof location === "undefined") return "ws://127.0.0.1:8080";
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

/** URL of the interactive PTY terminal (same backend as the simulation). */
export function terminalWsUrl(opts = {}) {
    const params = new URLSearchParams();
    if (opts.shell) params.set("shell", String(opts.shell));
    if (opts.cwd) params.set("cwd", String(opts.cwd));
    const qs = params.toString();
    return `${wsOrigin()}/ws/terminal${qs ? `?${qs}` : ""}`;
}

async function probeBackendOrigin() {
    for (const origin of FALLBACK_ORIGINS) {
        try {
            const res = await fetch(`${origin}/api/board`);
            if (!res.ok) continue;
            const bData = await res.json().catch(() => null);
            if (bData?.ok === true) {
                detectedBackendOrigin = origin;
                return origin;
            }
        } catch {
            // Try next candidate backend origin.
        }
    }
    return "";
}

export class ApiClient {
    constructor({ onError } = {}) {
        this.onError = onError || (() => {});
    }

    async _fetch(path, options) {
        let res;
        let data = {};
        let networkErr = null;
        const prevOrigin = detectedBackendOrigin;
        try {
            res = await fetch(`${detectedBackendOrigin}${path}`, options);
            data = await res.json().catch(() => ({}));
        } catch (err) {
            networkErr = err;
            // An aborted request must never trigger origin probing/retry.
            if (options?.signal?.aborted) throw err;
        }
        const badProxy = res && (res.status === 502 || res.status === 503 || res.status === 504);
        const foreign404 = res && res.status === 404 && data?.ok === undefined;
        if (networkErr || badProxy || foreign404) {
            const origin = await probeBackendOrigin();
            if (origin && (!prevOrigin || origin !== prevOrigin)) {
                try {
                    res = await fetch(`${origin}${path}`, options);
                    data = await res.json().catch(() => ({}));
                    return { httpOk: res.ok, status: res.status, data };
                } catch {
                    // Fall through to report network or status failure below.
                }
            }
            if (networkErr || !res) {
                const e = new Error(`Backend unreachable (${path})`);
                e.network = true;
                throw e;
            }
        }
        return { httpOk: res.ok, status: res.status, data };
    }

    health() {
        return this._fetch("/api/health");
    }

    board() {
        return this._fetch("/api/board");
    }

    examples() {
        return this._fetch("/api/examples");
    }

    example(id) {
        return this._fetch(`/api/examples/${encodeURIComponent(id)}`);
    }

    compile(payload) {
        return this._fetch("/api/compile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    }

    /**
     * REST simulation. The pre-computed stimulus map is requested by default;
     * pass includeStimulusMap:false (in payload or opts) to opt out.
     * opts.signal is forwarded to fetch as an AbortSignal.
     */
    simulate(payload, opts = {}) {
        const body = { ...(payload || {}) };
        if (body.includeStimulusMap === undefined && body.include_stimulus_map === undefined) {
            body.includeStimulusMap = opts.includeStimulusMap !== false;
        }
        const options = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        };
        if (opts && opts.signal !== undefined) options.signal = opts.signal;
        return this._fetch("/api/simulate", options);
    }

    selectDevice(key) {
        return this._fetch("/api/device/select", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device: key }),
        });
    }

    devices() {
        return this._fetch("/api/device");
    }

    // --------------------------------------------------------- multi-board --
    /** GET /api/boards → { ok, activeBoard, boards }. */
    getBoards() {
        return this._fetch("/api/boards");
    }

    /** Alias retained for callers that prefer the shorter name. */
    boards() {
        return this.getBoards();
    }

    /** POST /api/boards/select → activates a registered board by id. */
    selectBoard(boardId) {
        return this._fetch("/api/boards/select", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ board: boardId }),
        });
    }

    /** POST /api/boards/import → registers (and optionally selects) a manifest. */
    importBoard(manifest, select = true) {
        return this._fetch("/api/boards/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ manifest, select: select !== false }),
        });
    }

    /** POST /api/terminal/exec → one-shot command (GHDL is on PATH). */
    terminalExec(command, cwd = null) {
        return this._fetch("/api/terminal/exec", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command, cwd }),
        });
    }

    getSettings() {
        return this._fetch("/api/settings");
    }

    saveSettings(settings) {
        return this._fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(settings || {}),
        });
    }

    terminalShells() {
        return this._fetch("/api/terminal/shells");
    }

    quartusCompile(payload) {
        return this._fetch("/api/quartus/compile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload || {}),
        });
    }

    openQuartusGui(payload = {}) {
        return this._fetch("/api/quartus/open-gui", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    }

    openQuartusProgrammer(payload = {}) {
        return this._fetch("/api/quartus/programmer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    }

    simulateNetlist(payload) {
        return this._fetch("/api/quartus/simulate-netlist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload || {}),
        });
    }

    workspaceFiles(dir) {
        return this._fetch(`/api/workspace/files?dir=${encodeURIComponent(String(dir || ""))}`);
    }

    workspaceOpen(dir) {
        return this._fetch("/api/workspace/open", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dir: String(dir || "") }),
        });
    }

    workspaceOpenFiles(paths) {
        return this._fetch("/api/workspace/open-files", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths: Array.isArray(paths) ? paths : [] }),
        });
    }

    workspaceWrite(dir, files) {
        return this._fetch("/api/workspace/write", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dir: String(dir || ""), files: files || [] }),
        });
    }

    workspaceDelete(dir, name) {
        return this._fetch("/api/workspace/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dir: String(dir || ""), name: String(name || "") }),
        });
    }
}

// Standalone helpers use a shared client; callers may still instantiate their
// own ApiClient (with a custom onError) and call the same methods on it.
const defaultApiClient = new ApiClient();

export function getBoards() { return defaultApiClient.getBoards(); }
export const boards = getBoards;
export function selectBoard(boardId) { return defaultApiClient.selectBoard(boardId); }
export function importBoard(manifest, select = true) { return defaultApiClient.importBoard(manifest, select); }
export function terminalExec(command, cwd = null) { return defaultApiClient.terminalExec(command, cwd); }

// ---------------------------------------------------------------------------
// Streaming simulation session over /ws.
// Server → client: sim_ready, cycle_batch, sim_done, sim_paused, sim_resumed,
// sim_reset, sim_stopped, sim_error.
// Client → server: sim_start, sim_pause, sim_resume, sim_stop, sim_reset,
// sim_step {cycles}.
// ---------------------------------------------------------------------------
export class SimSession {
    constructor({ onMessage, onClose, onOpen } = {}) {
        this.onMessage = onMessage || (() => {});
        this.onClose = onClose || (() => {});
        this.onOpen = onOpen || (() => {});
        this.ws = null;
        this.closedByUser = false;
        this.url = null; // optional explicit URL override
    }

    connect(url = null) {
        if (url) this.url = url;
        const target = this.url || `${wsOrigin()}/ws`;
        return new Promise((resolve, reject) => {
            let settled = false;
            const ws = new WebSocket(target);
            this.ws = ws;
            ws.onopen = () => {
                if (!settled) { settled = true; resolve(); }
                this.onOpen();
            };
            ws.onmessage = (ev) => {
                let msg = null;
                try { msg = JSON.parse(ev.data); } catch { return; }
                // Forward the COMPLETE frame — sim_ready.stimulusMap is a large
                // nested object and must never be stripped here.
                if (msg) this.onMessage(msg);
            };
            ws.onerror = () => {
                if (!settled) { settled = true; reject(new Error("WebSocket connection failed")); }
            };
            ws.onclose = () => {
                if (!settled) { settled = true; reject(new Error("WebSocket closed before open")); }
                this.onClose(this.closedByUser);
            };
        });
    }

    get open() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    send(obj) {
        if (this.open) this.ws.send(JSON.stringify(obj));
    }

    /** sim_start payload — requests the stimulus map unless explicitly false. */
    start(params = {}) {
        const payload = { ...(params || {}) };
        if (payload.includeStimulusMap === undefined && payload.include_stimulus_map === undefined) {
            payload.includeStimulusMap = true;
        }
        this.send({ type: "sim_start", ...payload });
    }

    /** Explicit alias for the run-SIM payload contract. */
    runSim(params = {}) { this.start(params); }
    pause() { this.send({ type: "sim_pause" }); }
    resume() { this.send({ type: "sim_resume" }); }
    stop() { this.send({ type: "sim_stop" }); }
    reset() { this.send({ type: "sim_reset" }); }
    step(cycles = 1) { this.send({ type: "sim_step", cycles }); }

    // -- live interactive co-simulation (persistent GHDL stepping) -----------
    liveStart(params = {}) { this.send({ type: "live_start", ...(params || {}) }); }
    liveInput(params = {}) { this.send({ type: "live_input", ...(params || {}) }); }
    livePace(pace) { this.send({ type: "live_pace", pace }); }
    liveStep(cycles = 1) { this.send({ type: "live_step", cycles }); }
    liveStop() { this.send({ type: "live_stop" }); }

    // -- real Quartus compilation over /ws ----------------------------------
    quartusCompile(params = {}) { this.send({ type: "quartus_compile", ...(params || {}) }); }
    quartusStop() { this.send({ type: "quartus_stop" }); }

    // -- disk workspace file watcher over /ws -------------------------------
    workspaceWatch(dir, lastVersion = "") { this.send({ type: "workspace_watch", dir, lastVersion }); }
    workspaceAck(version) { this.send({ type: "workspace_ack", version }); }

    close() {
        this.closedByUser = true;
        if (this.ws) {
            try { this.ws.close(); } catch { /* ignore */ }
            this.ws = null;
        }
    }
}

/**
 * Convenience connector. The onMessage callback receives the original frame
 * unchanged — including sim_ready.stimulusMap — so callers can store it
 * verbatim for zero-delay stimulus playback.
 */
export function connectSession({ onMessage, onOpen, onClose, url = null } = {}) {
    const session = new SimSession({
        onMessage: (msg) => { if (typeof onMessage === "function") onMessage(msg, session); },
        onOpen: () => { if (typeof onOpen === "function") onOpen(session); },
        onClose: (byUser) => { if (typeof onClose === "function") onClose(byUser, session); },
    });
    return session.connect(url).then(() => session);
}

export default new ApiClient();
