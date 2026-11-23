// statusBar.js — Zone 6: the slim 24px status bar.
// Ln X, Col Y | VHDL / Verilog | Active Board | compile progress % + elapsed.

export function createStatusBar(root) {
    root.classList.add("statusbar");
    root.innerHTML = `
        <span class="st-cell st-cursor" id="st-cursor">Ln 1, Col 1</span>
        <span class="st-cell st-lang" id="st-lang">VHDL</span>
        <span class="st-cell st-board" id="st-board">&mdash;</span>
        <span class="st-flex"></span>
        <span class="st-cell st-progress" id="st-progress"></span>
        <span class="st-cell st-elapsed" id="st-elapsed"></span>
        <span class="st-cell st-version" id="st-version"></span>
    `;

    const cursor = root.querySelector("#st-cursor");
    const lang = root.querySelector("#st-lang");
    const board = root.querySelector("#st-board");
    const progress = root.querySelector("#st-progress");
    const elapsed = root.querySelector("#st-elapsed");
    const version = root.querySelector("#st-version");

    let timer = null;
    let startedAt = 0;

    function setCursor(line, column) {
        cursor.textContent = `Ln ${line || 1}, Col ${column || 1}`;
    }
    function setLanguage(text) {
        lang.textContent = text || "VHDL";
    }
    function setBoard(text) {
        board.textContent = text || "\u2014";
    }
    function setVersion(text) {
        version.textContent = text || "";
    }
    /** pct: 0..100 or null for an indeterminate run; label adds the stage. */
    function setProgress(pct, label) {
        if (pct === null || pct === undefined) {
            progress.textContent = label ? `${label}` : "";
            progress.classList.add("indeterminate");
            return;
        }
        progress.classList.remove("indeterminate");
        progress.textContent = `${label ? label + " \u00b7 " : ""}${Math.round(pct)}%`;
    }
    function clearProgress() {
        progress.textContent = "";
        progress.classList.remove("indeterminate");
        elapsed.textContent = "";
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
        elapsed.textContent = formatElapsed(performance.now() - startedAt);
    }

    return { setCursor, setLanguage, setBoard, setVersion, setProgress, clearProgress, beginElapsed, stopElapsed, root };
}
