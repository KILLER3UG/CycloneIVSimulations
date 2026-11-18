// audio.js — BEEP synthesis for the RZ-EasyFPGA A2.2 buzzer.
//
// The drive is active-low: BEEP = 0 turns the 8550 PNP on. The schematic has
// no on-board oscillator and the fitted part is treated as passive, so the
// design itself must toggle the pin. Tone parameters therefore come from the
// **simulated** transition timestamps (ns) converted to 50 MHz clock cycles —
// never from requestAnimationFrame / wall-clock intervals, which would
// pitch-shift the tone down when the browser cannot step 50 M cycles per
// second.
//
//   f = 50_000_000 / cycles_per_period
//   duty = active_cycles / cycles_per_period
//
// Zero-latency contract: tone()/silence() claim and publish their complete
// state synchronously on the calling JS turn. A first click can happen before
// AudioContext.resume() has resolved; _ensureSync() builds the nodes and
// starts resume() in the background so audio.state() is correct in < 1 ms.

const STORAGE_KEY = "c4_audio_v1";
const MIN_HZ = 20;
const MAX_HZ = 20_000;
const RAMP_S = 0.004; // 4 ms click-free ramp

function loadPrefs() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        return {
            muted: Boolean(raw.muted),
            volume: Number.isFinite(raw.volume) ? Math.min(1, Math.max(0, raw.volume)) : 0.55,
        };
    } catch {
        return { muted: false, volume: 0.55 };
    }
}

function savePrefs(prefs) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
        /* restricted storage: ignore */
    }
}

export class BuzzerAudio {
    constructor() {
        const prefs = loadPrefs();
        this.muted = prefs.muted;
        this.volume = prefs.volume;
        this.ctx = null;
        this.master = null;
        this.osc = null;
        this.gain = null;
        this._started = false;
        this.frequency = 0;
        this.duty = 0;
        this.active = false;
    }

    /**
     * Synchronous node setup. Creates AudioContext + oscillator + gain on the
     * CURRENT turn (no await), then kicks off resume() without blocking.
     * Safe on the very first user gesture, while resume() is still pending.
     */
    _ensureSync() {
        if (this.ctx && this.osc && this.gain) return true;
        const Ctor = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
        if (!Ctor) return false;
        try {
            if (!this.ctx) {
                this.ctx = new Ctor();
                this.master = this.ctx.createGain();
                this.master.gain.value = this.muted ? 0 : this.volume;
                this.master.connect(this.ctx.destination);
            }
            if (!this.osc) {
                this.osc = this.ctx.createOscillator();
                this.osc.type = "square";
            }
            if (!this.gain) {
                this.gain = this.ctx.createGain();
                this.gain.gain.value = 0;
                this.osc.connect(this.gain);
                this.gain.connect(this.master);
            }
            if (!this._started) {
                this.osc.start(0);
                this._started = true;
            }
            if (this.ctx.state === "suspended" && typeof this.ctx.resume === "function") {
                // Non-blocking: never await inside a state-changing call.
                const pending = this.ctx.resume();
                if (pending && typeof pending.catch === "function") pending.catch(() => {});
            }
            return true;
        } catch {
            return false;
        }
    }

    /** Create/resume the AudioContext (must be called from a user gesture). */
    async ensure() {
        this._ensureSync();
        if (this.ctx && this.ctx.state === "suspended") {
            try { await this.ctx.resume(); } catch { /* ignore */ }
        }
        return Boolean(this.ctx && this.ctx.state === "running");
    }

    setMuted(muted) {
        this.muted = Boolean(muted);
        if (this.master && this.ctx) {
            const t = this.ctx.currentTime;
            this.master.gain.cancelScheduledValues(t);
            this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, t, RAMP_S);
        }
        // Active tone: publish the new gain on this turn (no ramp delay).
        if (this.active && this.gain) {
            try { this.gain.gain.cancelScheduledValues(this.ctx.currentTime); } catch { /* ignore */ }
            this.gain.gain.value = this.muted ? 0 : this.volume;
        }
        savePrefs({ muted: this.muted, volume: this.volume });
    }

    setVolume(volume) {
        const v = Math.min(1, Math.max(0, Number(volume) || 0));
        this.volume = v;
        if (this.master && this.ctx) {
            const t = this.ctx.currentTime;
            this.master.gain.cancelScheduledValues(t);
            this.master.gain.setTargetAtTime(this.muted ? 0 : v, t, RAMP_S);
        }
        if (this.active && this.gain) {
            try { this.gain.gain.cancelScheduledValues(this.ctx.currentTime); } catch { /* ignore */ }
            this.gain.gain.value = this.muted ? 0 : this.volume;
        }
        savePrefs({ muted: this.muted, volume: this.volume });
    }

    /**
     * Play a square tone at `freqHz`. All state visible through state() is
     * committed synchronously before the first await, including on the very
     * first call when the AudioContext is still resuming.
     */
    async tone(freqHz, duty = 0.5) {
        const f = Number(freqHz);
        if (!Number.isFinite(f) || f < MIN_HZ || f > MAX_HZ) {
            this.silence();
            return false;
        }
        const d = Number.isFinite(Number(duty)) ? Number(duty) : 0.5;
        const ok = this._ensureSync();

        // Synchronous state claim — before any await, before resume resolves.
        this.frequency = f;
        this.duty = d;
        this.active = true;
        if (ok && this.osc && this.gain) {
            const targetGain = this.muted ? 0 : this.volume;
            const t = this.ctx.currentTime;
            try {
                this.osc.frequency.value = f;
                if (typeof this.osc.frequency.setValueAtTime === "function") {
                    this.osc.frequency.setValueAtTime(f, t);
                }
                this.gain.gain.cancelScheduledValues(t);
                this.gain.gain.value = targetGain;
            } catch {
                this.gain.gain.value = targetGain;
            }
        }

        if (!ok) return false;
        // Resume in the background; the visible state above is already final.
        try { await this.ensure(); } catch { /* ignore */ }
        return true;
    }

    silence() {
        this.active = false;
        this.frequency = 0;
        this.duty = 0;
        if (this.gain) {
            try {
                const t = this.ctx ? this.ctx.currentTime : 0;
                this.gain.gain.cancelScheduledValues(t);
            } catch { /* ignore */ }
            this.gain.gain.value = 0;
        }
    }

    /** Legacy ramp-out helper, kept for callers that use it directly. */
    _stop(now) {
        if (this.gain && this.ctx) {
            const g = this.gain.gain;
            g.cancelScheduledValues(now);
            g.setValueAtTime(Math.max(0.0002, g.value || 0.0001), now);
            g.exponentialRampToValueAtTime(0.0001, now + RAMP_S);
        }
    }

    /** "Silent" | "800 Hz" | "Mute" — for the toolbar badge. */
    badge() {
        if (this.muted) return "Muted";
        if (!this.active || !this.frequency) return "Silent";
        return `${Math.round(this.frequency)} Hz`;
    }

    state() {
        return {
            ready: Boolean(this.ctx && this.ctx.state === "running"),
            active: this.active,
            frequency: this.frequency,
            duty: this.duty,
            muted: this.muted,
            volume: this.volume,
            gain: this.master && this.ctx ? this.master.gain.value : 0,
            oscFreq: this.osc && this.ctx ? this.osc.frequency.value : 0,
            oscGain: this.gain && this.ctx ? this.gain.gain.value : 0,
            badge: this.badge(),
        };
    }
}

export const audio = new BuzzerAudio();
export { MIN_HZ as BUZZER_MIN_HZ, MAX_HZ as BUZZER_MAX_HZ };
