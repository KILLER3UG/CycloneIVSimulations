// api.js — REST client + WebSocket simulation session for the GHDL backend.

const FALLBACK_ORIGINS = ["http://127.0.0.1:8080", "http://127.0.0.1:8000", "http://127.0.0.1:8765"];
let detectedBackendOrigin = "";

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

    simulate(payload) {
        return this._fetch("/api/simulate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
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
}

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
    }

    connect() {
        const wsBase = detectedBackendOrigin
            ? detectedBackendOrigin.replace(/^http/, "ws")
            : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
        const url = `${wsBase}/ws`;
        return new Promise((resolve, reject) => {
            let settled = false;
            const ws = new WebSocket(url);
            this.ws = ws;
            ws.onopen = () => {
                if (!settled) { settled = true; resolve(); }
                this.onOpen();
            };
            ws.onmessage = (ev) => {
                let msg = null;
                try { msg = JSON.parse(ev.data); } catch { return; }
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

    start(params) { this.send({ type: "sim_start", ...params }); }
    pause() { this.send({ type: "sim_pause" }); }
    resume() { this.send({ type: "sim_resume" }); }
    stop() { this.send({ type: "sim_stop" }); }
    reset() { this.send({ type: "sim_reset" }); }
    step(cycles = 1) { this.send({ type: "sim_step", cycles }); }

    close() {
        this.closedByUser = true;
        if (this.ws) {
            try { this.ws.close(); } catch { /* ignore */ }
            this.ws = null;
        }
    }
}
