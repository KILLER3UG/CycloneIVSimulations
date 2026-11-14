// api.js — REST client + WebSocket simulation session for the GHDL backend.

export class ApiClient {
    constructor({ onError } = {}) {
        this.onError = onError || (() => {});
    }

    async _fetch(path, options) {
        let res;
        try {
            res = await fetch(path, options);
        } catch (err) {
            const e = new Error(`Backend unreachable (${path})`);
            e.network = true;
            throw e;
        }
        const data = await res.json().catch(() => ({}));
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
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const url = `${proto}://${location.host}/ws`;
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
