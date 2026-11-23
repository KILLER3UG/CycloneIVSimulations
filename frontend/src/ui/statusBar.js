// statusBar.js — Zone 6: Quartus Prime Standard Edition status bar.
// Left: action status text | Right: Ln X, Col Y | File Type | Progress % | hh:mm:ss

export function createStatusBar(root) {
    root.classList.add("statusbar");
    root.innerHTML = `
        <span class="st-cell st-action" id="st-action">Ready</span>
        <span class="st-flex"></span>
        <span class="st-cell st-cursor" id="st-cursor">Ln 1 &nbsp; Col 1</span>
        <span class="st-cell st-lang" id="st-lang">VHDL File</span>
        <span class="st-cell st-board hidden" id="st-board">Cyclone IV E: EP4CE6E22C8</span>
        <span class="st-cell st-progress" id="st-progress">0%</span>
        <span class="st-cell st-elapsed" id="st-elapsed">00:00:00</span>
        <span class="st-cell st-version hidden" id="st-version"></span>
    `;

    const actionEl = root.querySelector("#st-action");
    const cursor = root.querySelector("#st-cursor");
    const lang = root.querySelector("#st-lang");
    const board = root.querySelector("#st-board");
    const progress = root.querySelector("#st-progress");
    const elapsed = root.querySelector("#st-elapsed");
    const version = root.querySelector("#st-version");

    let timer = null;
    let startedAt = 0;

    function setAction(text) {
        if (actionEl) actionEl.textContent = text || "Ready";
    }
    function setCursor(line, column) {
        cursor.textContent = `Ln ${line || 1}   Col ${column || 1}`;
    }
    function setLanguage(text) {
        const t = String(text || "VHDL");
        lang.textContent = /file$/i.test(t) ? t : `${t} File`;
    }
    function setBoard(text) {
        board.textContent = text || "\u2014";
    }
    function setVersion(text) {
        version.textContent = text || "";
    }
    function setProgress(pct, label) {
        if (label) setAction(label);
        if (pct === null || pct === undefined) {
            progress.textContent = "\u2026";
            progress.classList.add("indeterminate");
            progress.style.setProperty("--pct", "15%");
            return;
        }
        const clamped = Math.max(0, Math.min(100, Math.round(pct)));
        progress.classList.remove("indeterminate");
        progress.textContent = `${clamped}%`;
        progress.style.setProperty("--pct", `${clamped}%`);
    }
    function clearProgress() {
        progress.textContent = "0%";
        progress.classList.remove("indeterminate");
        progress.style.setProperty("--pct", "0%");
        if (timer) { clearInterval(timer); timer = null; }
    }
    function beginElapsed() {
        startedAt = performance.now();
        if (timer) clearInterval(timer);
        timer = setInterval(() => {
            elapsed.textContent = formatElapsed(performance.now() - startedAt);
        }, 500);
        elapsed.textContent = "00:00:00";
    }
    function formatElapsed(ms) {
        const s = Math.max(0, Math.floor(ms / 1000));
        const p = (n) => String(n).padStart(2, "0");
        return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
    }
    function stopElapsed() {
        if (timer) { clearInterval(timer); timer = null; }
        if (startedAt) elapsed.textContent = formatElapsed(performance.now() - startedAt);
    }

    return {
        setAction, setCursor, setLanguage, setBoard, setVersion,
        setProgress, clearProgress, beginElapsed, stopElapsed, root,
    };
}
