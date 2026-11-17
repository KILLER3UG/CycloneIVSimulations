// audio.js — BEEP synthesis for the RZ-EasyFPGA A2.2 buzzer (PIN_110).
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
// A steady HIGH (transistor off) is silent. A steady LOW (DC) is also silent
// for this passive speaker. Oscillating 20 Hz–20 kHz -> square tone.

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
        this.frequency = 0;
        this.duty = 0;
        this.active = false;
    }

    /** Create/resume the AudioContext. Must be called from a user gesture. */
    async ensure() {
        if (!this.ctx) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) return false;
            this.ctx = new Ctor();
            this.master = this.ctx.createGain();
            this.master.gain.value = this.muted ? 0 : this.volume;
            this.master.connect(this.ctx.destination);
        }
        if (this.ctx.state === "suspended") {
            try { await this.ctx.resume(); } catch { /* ignore */ }
        }
        return this.ctx.state === "running";
    }

    setMuted(muted) {
        this.muted = Boolean(muted);
        if (this.master && this.ctx) {
            const t = this.ctx.currentTime;
            this.master.gain.cancelScheduledValues(t);
            this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, t, RAMP_S);
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
        savePrefs({ muted: this.muted, volume: this.volume });
    }

    /**
     * Play a square tone at `freqHz`. `duty` is measured for the badge; the
     * oscillator is band-limited by Web Audio's square wave.
     */
    async tone(freqHz, duty = 0.5) {
        const f = Number(freqHz);
        if (!Number.isFinite(f) || f < MIN_HZ || f > MAX_HZ) {
            this.silence();
            return false;
        }
        // Claim the state synchronously: sim_done (which schedules the 1 s
        // stop) can fire before the AudioContext resume promise resolves.
        if (this.active && this.osc && Math.abs(this.frequency - f) < 0.5) {
            this.duty = duty;
            return true;
        }
        this.frequency = f;
        this.duty = duty;
        this.active = true;
        const ok = await this.ensure();
        if (!ok) {
            this.active = false;
            this.frequency = 0;
            this.duty = 0;
            return false;
        }
        const now = this.ctx.currentTime;
        this._stop(now);
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = "square";
        osc.frequency.setValueAtTime(f, now);
        gain.gain.setValueAtTime(0.0001, now);
        osc.connect(gain);
        gain.connect(this.master);
        osc.start(now);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, this.volume), now + RAMP_S);
        this.osc = osc;
        this.gain = gain;
        this.frequency = f;
        this.duty = duty;
        this.active = true;
        return true;
    }

    silence() {
        if (!this.ctx) {
            this.active = false;
            this.frequency = 0;
            return;
        }
        this._stop(this.ctx.currentTime);
        this.active = false;
        this.frequency = 0;
        this.duty = 0;
    }

    _stop(now) {
        if (this.gain && this.ctx) {
            const g = this.gain.gain;
            g.cancelScheduledValues(now);
            g.setValueAtTime(Math.max(0.0002, g.value || 0.0001), now);
            g.exponentialRampToValueAtTime(0.0001, now + RAMP_S);
        }
        if (this.osc) {
            try { this.osc.stop(now + RAMP_S + 0.01); } catch { /* already stopped */ }
        }
        this.osc = null;
        this.gain = null;
    }

    /** "Silent" | "800 Hz" | "Mute" — for the toolbar badge. */
    badge() {
        if (this.muted) return "Muted";
        if (!this.active || !this.frequency) return "Silent";
        return `${Math.round(this.frequency)} Hz`;
    }

    state() {
        return {
            active: this.active,
            frequency: this.frequency,
            duty: this.duty,
            muted: this.muted,
            volume: this.volume,
            gain: this.master && this.ctx ? this.master.gain.value : 0,
            oscGain: this.gain && this.ctx ? this.gain.gain.value : 0,
            badge: this.badge(),
        };
    }
}

export const audio = new BuzzerAudio();
export { MIN_HZ as BUZZER_MIN_HZ, MAX_HZ as BUZZER_MAX_HZ };