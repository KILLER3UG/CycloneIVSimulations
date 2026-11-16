// waveform.js — canvas waveform viewer (ported from the proven legacy viewer).
// Renders step waves from the streamed cycle data, with a signal picker,
// wheel zoom, drag-pan and a cursor with a time/value tooltip.

const COLORS = [
    "#5ab0ff", "#f5a524", "#38d6c4", "#b388ff", "#ff7b72",
    "#9ece6a", "#ff9d5c", "#7fdbff", "#e0af68", "#bb9af7",
    "#6ee7b7", "#f472b6", "#facc15", "#93c5fd", "#f87171",
];

const LABEL_W = 132;
const TOP = 22;
const BOTTOM = 20;
const RIGHT = 12;

function niceStep(raw) {
    if (!Number.isFinite(raw) || raw <= 0) return 1;
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / power;
    const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return mult * power;
}

export function fmtTime(t) {
    if (!Number.isFinite(t)) return "--";
    if (Math.abs(t) >= 1e6) return (t / 1e6).toFixed(2) + " ms";
    if (Math.abs(t) >= 1000) return (t / 1000).toFixed(2) + " \u00b5s";
    if (Math.abs(t) >= 100) return t.toFixed(0) + " ns";
    if (Math.abs(t) >= 10) return t.toFixed(1) + " ns";
    return t.toFixed(2) + " ns";
}

export function createWaveformView(host, { onValuesAt } = {}) {
    host.classList.add("wave-host");
    host.innerHTML = `
        <div class="wave-side">
            <div class="wave-side-head">Signals</div>
            <div class="wave-signals" id="wave-signals"></div>
        </div>
        <div class="wave-main">
            <div class="wave-toolbar">
                <button class="btn" data-w="zin" title="Zoom in">+</button>
                <button class="btn" data-w="zout" title="Zoom out">\u2212</button>
                <button class="btn" data-w="fit" title="Fit">fit</button>
                <span class="wave-range" id="wave-range"></span>
            </div>
            <div class="wave-canvas-wrap">
                <canvas id="wave-canvas"></canvas>
                <div class="wave-tooltip hidden" id="wave-tooltip"></div>
                <div class="wave-empty hidden" id="wave-empty">No waveform data \u2014 run a simulation.</div>
            </div>
        </div>
    `;

    const canvas = host.querySelector("#wave-canvas");
    const ctx = canvas.getContext("2d");
    const tooltip = host.querySelector("#wave-tooltip");
    const empty = host.querySelector("#wave-empty");
    const signalsEl = host.querySelector("#wave-signals");
    const rangeEl = host.querySelector("#wave-range");

    let signals = [];        // [{name,width,direction}]
    let visible = new Set();
    let cycles = [];         // [{cycle,time,values}]
    let duration = 0;
    let view = { t0: 0, t1: 1000 };
    let cursorTime = 0;
    let canvasW = 600, canvasH = 260;
    let drag = null;

    // -------------------------------------------------------------- data ---
    // Cycles arrive in time order; binary search keeps draw()/valueAt O(log n)
    // instead of scanning the whole capture (which was quadratic when every
    // 32-cycle batch redrew the canvas).
    function lowerBound(t) {
        let lo = 0, hi = cycles.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cycles[mid].time < t) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    let drawQueued = false;
    function scheduleDraw() {
        if (drawQueued) return;
        drawQueued = true;
        requestAnimationFrame(() => { drawQueued = false; draw(); });
    }

    function setSignals(list) {
        signals = list || [];
        visible = new Set(
            signals.filter((s) => s.direction === "out" || /clk|clock|reset/i.test(s.name))
                .map((s) => s.name)
        );
        if (!visible.size && signals.length) visible.add(signals[0].name);
        renderSignalPicker();
        scheduleDraw();
    }

    function setData(newCycles, totalHint) {
        cycles = newCycles || [];
        duration = cycles.length ? cycles[cycles.length - 1].time : duration;
        const span = Math.max(duration, 1);
        view = { t0: 0, t1: span };
        empty.classList.toggle("hidden", cycles.length > 0);
        scheduleDraw();
    }

    function addCycles(more) {
        if (!more?.length) return;
        for (const c of more) cycles.push(c);
        duration = cycles[cycles.length - 1].time;
        if (view.t1 >= duration - (more[more.length - 1].time - more[0].time) - 1e-6) view.t1 = duration;
        empty.classList.add("hidden");
        scheduleDraw();
    }

    function ensureVisible(name) {
        if (!visible.has(name)) { visible.add(name); renderSignalPicker(); }
    }

    function setCursor(t) { cursorTime = t; scheduleDraw(); }

    // ------------------------------------------------------------- picker --
    function renderSignalPicker() {
        signalsEl.innerHTML = "";
        for (const s of signals) {
            const row = document.createElement("label");
            row.className = "wave-sig";
            const color = COLORS[signals.indexOf(s) % COLORS.length];
            row.innerHTML = `<input type="checkbox" ${visible.has(s.name) ? "checked" : ""}>
                <span class="wave-sig-dot" style="background:${color}"></span>
                <span class="wave-sig-name" title="${s.name}">${s.name}${s.width > 1 ? ` [${s.width}]` : ""}</span>`;
            row.querySelector("input").addEventListener("change", (e) => {
                if (e.target.checked) visible.add(s.name); else visible.delete(s.name);
                scheduleDraw();
            });
            signalsEl.appendChild(row);
        }
    }

    function addProbeSignal(name) {
        if (!signals.some((s) => s.name === name)) {
            signals = signals.concat([{ name, width: 1, direction: "probe" }]);
        }
        visible.add(name);
        renderSignalPicker();
        scheduleDraw();
    }

    // -------------------------------------------------------------- draw ---
    function resize() {
        const rect = host.querySelector(".wave-canvas-wrap").getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvasW = Math.max(300, rect.width);
        canvasH = Math.max(140, rect.height);
        canvas.width = Math.round(canvasW * dpr);
        canvas.height = Math.round(canvasH * dpr);
        canvas.style.width = canvasW + "px";
        canvas.style.height = canvasH + "px";
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        scheduleDraw();
    }

    function visibleSignals() {
        return signals.filter((s) => visible.has(s.name));
    }

    function valueAt(signal, time) {
        if (!cycles.length) return undefined;
        const i = lowerBound(time + 1e-9) - 1;
        return cycles[Math.max(0, i)].values[signal.name];
    }

    function draw() {
        const dark = document.documentElement.dataset.theme === "dark";
        const bg = dark ? "#12151c" : "#0d1420";
        const grid = dark ? "rgba(140,170,200,0.10)" : "rgba(120,160,190,0.10)";
        const labelCol = dark ? "#aebacd" : "#b9cadb";
        const axisCol = dark ? "rgba(140,170,200,0.2)" : "rgba(120,160,190,0.16)";
        ctx.clearRect(0, 0, canvasW, canvasH);
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvasW, canvasH);

        rangeEl.textContent = cycles.length
            ? `${fmtTime(view.t0)} \u2014 ${fmtTime(view.t1)} \u00b7 ${cycles.length} cycles`
            : "no data";

        if (!cycles.length || !signals.length) {
            empty.classList.remove("hidden");
            return;
        }
        empty.classList.add("hidden");

        const sigs = visibleSignals();
        if (!sigs.length) return;
        const plotW = Math.max(10, canvasW - LABEL_W - RIGHT);
        const t0 = view.t0;
        const t1 = Math.max(view.t1, t0 + 1e-9);
        const xOf = (t) => LABEL_W + ((t - t0) / (t1 - t0)) * plotW;

        const availableH = canvasH - TOP - BOTTOM;
        const rowH = Math.max(16, Math.min(46, availableH / sigs.length));
        const startY = TOP + Math.max(0, (availableH - rowH * sigs.length) / 2);

        // time grid
        const font = "10px ui-monospace, Consolas, monospace";
        ctx.font = font;
        ctx.textBaseline = "top";
        const step = niceStep((t1 - t0) / 9);
        for (let t = Math.ceil(t0 / step) * step; t <= t1 + 1e-9; t += step) {
            const x = xOf(t);
            ctx.strokeStyle = grid;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + 0.5, TOP - 6);
            ctx.lineTo(Math.round(x) + 0.5, canvasH - BOTTOM + 4);
            ctx.stroke();
            ctx.fillStyle = dark ? "#77879b" : "#5f768c";
            ctx.textAlign = "center";
            ctx.fillText(fmtTime(t), x, 5);
        }

        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        sigs.forEach((signal, i) => {
            const yTop = startY + i * rowH;
            const yMid = yTop + rowH / 2;
            const highY = yTop + 5;
            const lowY = yTop + rowH - 6;
            const color = COLORS[signals.indexOf(signal) % COLORS.length];

            if (i % 2 === 1) {
                ctx.fillStyle = dark ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.025)";
                ctx.fillRect(LABEL_W, yTop, plotW, rowH);
            }
            ctx.fillStyle = color;
            ctx.fillRect(8, yMid - 1.5, 7, 3);
            ctx.fillStyle = labelCol;
            ctx.font = "11px ui-monospace, Consolas, monospace";
            let label = signal.name;
            if (signal.width > 1) label += ` [${signal.width}]`;
            ctx.fillText(label, 20, yMid, LABEL_W - 26);

            if ((signal.width || 1) === 1) {
                // bit wave: step through cycles
                let prev = valueAt(signal, t0);
                let y = (prev === 1 || prev === "1") ? highY : lowY;
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.6;
                ctx.beginPath();
                ctx.moveTo(LABEL_W, y);
                let lastX = LABEL_W;
                for (let ci = lowerBound(t0); ci < cycles.length; ci += 1) {
                    const c = cycles[ci];
                    if (c.time > t1) break;
                    const v = c.values[signal.name];
                    const high = v === 1 || v === "1";
                    const ny = high ? highY : lowY;
                    const x = xOf(c.time);
                    if (x > lastX + 0.01) {
                        ctx.lineTo(x, y);
                        ctx.lineTo(x, ny);
                        lastX = x;
                        y = ny;
                    }
                    prev = v;
                }
                ctx.lineTo(LABEL_W + plotW, y);
                ctx.stroke();
            } else {
                // bus: transition ticks + hex labels
                ctx.strokeStyle = "rgba(120,160,190,0.18)";
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(LABEL_W, yMid);
                ctx.lineTo(LABEL_W + plotW, yMid);
                ctx.stroke();
                let prevVal = valueAt(signal, t0);
                let lastTextX = -1000;
                ctx.font = "10px ui-monospace, Consolas, monospace";
                for (let ci = lowerBound(t0); ci < cycles.length; ci += 1) {
                    const c = cycles[ci];
                    if (c.time > t1) break;
                    const v = c.values[signal.name];
                    if (v === prevVal) continue;
                    const x = xOf(c.time);
                    ctx.strokeStyle = color;
                    ctx.beginPath();
                    ctx.moveTo(x, yMid - 6);
                    ctx.lineTo(x, yMid + 6);
                    ctx.stroke();
                    if (x - lastTextX > 40) {
                        ctx.fillStyle = color;
                        const text = typeof v === "number"
                            ? "0x" + (v >>> 0).toString(16).toUpperCase().padStart(Math.max(1, Math.ceil((signal.width || 4) / 4)), "0")
                            : String(v ?? "--").toUpperCase();
                        ctx.fillText(text, Math.min(x + 4, canvasW - RIGHT - 40), yMid);
                        lastTextX = x;
                    }
                    prevVal = v;
                }
                if (lastTextX < LABEL_W) {
                    ctx.fillStyle = color;
                    const v = prevVal;
                    const text = typeof v === "number"
                        ? "0x" + (v >>> 0).toString(16).toUpperCase().padStart(Math.max(1, Math.ceil((signal.width || 4) / 4)), "0")
                        : String(v ?? "--").toUpperCase();
                    ctx.fillText(text, LABEL_W + 4, yMid);
                }
            }
        });

        // cursor
        const cx = xOf(cursorTime);
        if (cx >= LABEL_W - 1 && cx <= LABEL_W + plotW + 1) {
            ctx.strokeStyle = "rgba(245,165,36,0.85)";
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(cx + 0.5, TOP - 4);
            ctx.lineTo(cx + 0.5, canvasH - BOTTOM + 4);
            ctx.stroke();
            ctx.setLineDash([]);
            const label = fmtTime(cursorTime);
            ctx.font = font;
            const w = ctx.measureText(label).width + 10;
            const bx = Math.min(Math.max(cx - w / 2, LABEL_W), LABEL_W + plotW - w);
            ctx.fillStyle = "rgba(245,165,36,0.16)";
            ctx.strokeStyle = "rgba(245,165,36,0.5)";
            ctx.beginPath();
            ctx.roundRect(bx, canvasH - BOTTOM + 3, w, 15, 4);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#ffd479";
            ctx.textAlign = "center";
            ctx.fillText(label, bx + w / 2, canvasH - BOTTOM + 11);
        }

        // axes
        ctx.strokeStyle = axisCol;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(LABEL_W + 0.5, TOP - 8);
        ctx.lineTo(LABEL_W + 0.5, canvasH - BOTTOM + 4);
        ctx.lineTo(canvasW - RIGHT, canvasH - BOTTOM + 4);
        ctx.stroke();
    }

    // ----------------------------------------------------------- controls --
    function zoomBy(factor, anchorTime) {
        const span = Math.max(1e-3, (view.t1 - view.t0) * factor);
        const anchor = anchorTime == null ? (view.t0 + view.t1) / 2 : anchorTime;
        let t0 = anchor - ((anchor - view.t0) / (view.t1 - view.t0)) * span;
        let t1 = t0 + span;
        const max = Math.max(duration, 1);
        if (t0 < 0) { t1 -= t0; t0 = 0; }
        if (t1 > max) { t0 -= t1 - max; t1 = max; }
        if (t0 < 0) { t0 = 0; t1 = Math.min(max, span); }
        view = { t0, t1: Math.max(t1, t0 + 1e-3) };
        scheduleDraw();
    }

    function fit() {
        view = { t0: 0, t1: Math.max(duration, 1) };
        scheduleDraw();
    }

    function eventTime(e) {
        const rect = canvas.getBoundingClientRect();
        const plotW = Math.max(10, canvasW - LABEL_W - RIGHT);
        const ratio = (e.clientX - rect.left - LABEL_W) / plotW;
        return view.t0 + Math.max(0, Math.min(1, ratio)) * (view.t1 - view.t0);
    }

    canvas.addEventListener("wheel", (e) => {
        if (!cycles.length) return;
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 0.8 : 1.25, eventTime(e));
    }, { passive: false });

    canvas.addEventListener("mousedown", (e) => {
        if (!cycles.length || e.button !== 0) return;
        cursorTime = eventTime(e);
        drag = { x: e.clientX, t0: view.t0, t1: view.t1 };
        onValuesAt?.(cursorTime);
        scheduleDraw();
    });

    window.addEventListener("mousemove", (e) => {
        if (drag) {
            const rect = canvas.getBoundingClientRect();
            const plotW = Math.max(10, canvasW - LABEL_W - RIGHT);
            const span = drag.t1 - drag.t0;
            const delta = ((e.clientX - drag.x) / plotW) * span;
            const max = Math.max(duration, 1);
            let t0 = drag.t0 - delta;
            let t1 = drag.t1 - delta;
            if (t0 < 0) { t1 -= t0; t0 = 0; }
            if (t1 > max) { t0 -= t1 - max; t1 = max; }
            if (t0 < 0) t0 = 0;
            view = { t0, t1: Math.max(t1, t0 + 1e-3) };
            scheduleDraw();
            return;
        }
        const rect = canvas.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
            tooltip.classList.add("hidden");
            return;
        }
        if (!cycles.length) return;
        const t = eventTime(e);
        if (Math.abs(t - cursorTime) > (view.t1 - view.t0) / (canvasW * 2)) {
            cursorTime = t;
            scheduleDraw();
        }
        const sigs = visibleSignals().slice(0, 10);
        tooltip.innerHTML = `<div class="wt-time">t = ${fmtTime(t)}</div>` + sigs.map((s) => {
            const v = valueAt(s, t);
            const text = typeof v === "number" && s.width > 1
                ? "0x" + (v >>> 0).toString(16).toUpperCase()
                : String(v ?? "--");
            return `<div><span class="wt-dot" style="background:${COLORS[signals.indexOf(s) % COLORS.length]}"></span>${s.name} = ${text}</div>`;
        }).join("");
        const wrapRect = host.querySelector(".wave-canvas-wrap").getBoundingClientRect();
        tooltip.style.left = Math.max(90, Math.min(canvasW - 90, e.clientX - wrapRect.left)) + "px";
        tooltip.style.top = Math.max(40, e.clientY - wrapRect.top - 8) + "px";
        tooltip.classList.remove("hidden");
    });

    window.addEventListener("mouseup", () => { drag = null; });
    canvas.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));

    host.querySelector('.wave-toolbar [data-w="zin"]').addEventListener("click", () => zoomBy(0.7));
    host.querySelector('.wave-toolbar [data-w="zout"]').addEventListener("click", () => zoomBy(1.4));
    host.querySelector('.wave-toolbar [data-w="fit"]').addEventListener("click", fit);

    const ro = new ResizeObserver(() => resize());
    ro.observe(host.querySelector(".wave-canvas-wrap"));
    resize();

    return {
        setSignals, setData, addCycles, setCursor, addProbeSignal, ensureVisible,
        fit, zoomBy, resize, draw,
        getData: () => cycles,
    };
}
