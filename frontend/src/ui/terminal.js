// terminal.js — Real multi-tab ConPTY terminal (xterm.js + Tauri portable-pty IPC,
// with WebSocket /ws/terminal fallback in browser dev mode).
//
// Features:
// - Multiple independent terminal instances ("+" new tab, "x" closes & kills shell)
// - Shell dropdown: PowerShell (default), Command Prompt, Git Bash (if installed)
// - Keeps sessions alive when panel is collapsed or user switches bottom tabs
// - Full ANSI colors, Ctrl+C copy-if-selected / interrupt, Ctrl+V paste, scrollback,
//   and ResizeObserver -> FitAddon -> PTY resize.

import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { terminalWsUrl } from "../api.js";
import { normalizeDir, sameDir, buildCdCommand } from "./terminalPath.js";

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

function stripAnsi(text) {
    return String(text ?? "").replace(ANSI_PATTERN, "").replace(/\r/g, "");
}

function isTauriRuntime() {
    return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export function createTerminalController(containerEl, opts = {}) {
    if (!containerEl) throw new Error("createTerminalController requires a container element");

    const getCwd = opts.getCwd || (() => null);
    const getExtraPaths = opts.getExtraPaths || (() => []);
    const onCdProject = opts.onCdProject || null;

    containerEl.classList.add("studio-terminal");
    containerEl.innerHTML = `
        <div class="term-header" role="toolbar" aria-label="Terminal controls">
            <div class="term-tabs" id="term-tabs" role="tablist"></div>
            <button id="term-add" type="button" class="term-btn" title="New Terminal Tab">+</button>
            <select id="term-shell" class="term-select" aria-label="Shell">
                <option value="powershell" selected>PowerShell</option>
                <option value="cmd">Command Prompt</option>
            </select>
            <span id="term-cwd" class="term-cwd">&mdash;</span>
            <span id="term-status" class="term-status" role="status" aria-live="polite">disconnected</span>
            <button id="term-cd-project" type="button" class="term-btn" title="cd to active file folder (or Home if no file)">cd Project</button>
            <button id="term-clear" type="button" class="term-btn" title="Clear active terminal">Clear</button>
            <button id="term-restart" type="button" class="term-btn" title="Restart active shell">Restart</button>
        </div>
        <div class="term-stage" id="term-stage"></div>
        <div class="term-command">
            <label for="terminal-input">$</label>
            <input id="terminal-input" type="text" autocomplete="off" spellcheck="false"
                   aria-label="Run a command in the terminal"
                   placeholder="Run command (e.g. quartus_sh --version, dir, git status)...">
        </div>
        <pre id="terminal-output" class="term-mirror" role="log" aria-live="polite"></pre>
    `;

    const tabsEl = containerEl.querySelector("#term-tabs");
    const addBtn = containerEl.querySelector("#term-add");
    const shellSel = containerEl.querySelector("#term-shell");
    const cwdEl = containerEl.querySelector("#term-cwd");
    const statusEl = containerEl.querySelector("#term-status");
    const cdProjBtn = containerEl.querySelector("#term-cd-project");
    const clearBtn = containerEl.querySelector("#term-clear");
    const restartBtn = containerEl.querySelector("#term-restart");
    const stageEl = containerEl.querySelector("#term-stage");
    const inputEl = containerEl.querySelector("#terminal-input");
    const outputEl = containerEl.querySelector("#terminal-output");

    let nextSeq = 1;
    let activeId = null;
    const sessions = new Map(); // id -> session object
    let tauriListenersReady = false;

    function setStatus(text, tone = "normal") {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.dataset.tone = tone;
    }

    function syncMirror() {
        const s = sessions.get(activeId);
        if (outputEl) outputEl.textContent = s ? s.mirror : "";
        if (cwdEl) cwdEl.textContent = s?.cwd || "—";
    }

    function appendMirror(s, data) {
        const text = stripAnsi(data);
        if (!text) return;
        s.mirror += text;
        if (s.mirror.length > 200000) s.mirror = s.mirror.slice(-100000);
        if (s.id === activeId && outputEl) outputEl.textContent = s.mirror;
    }

    async function loadShells() {
        let shells = [];
        if (isTauriRuntime()) {
            try {
                shells = await invoke("pty_list_shells");
            } catch { shells = []; }
        } else if (typeof opts.fetchShells === "function") {
            try { shells = await opts.fetchShells(); } catch { shells = []; }
        }
        if (Array.isArray(shells) && shells.length) {
            shellSel.innerHTML = shells.map((sh) =>
                `<option value="${sh.id}" ${sh.default ? "selected" : ""}>${sh.label}</option>`).join("");
        }
    }

    async function ensureTauriListeners() {
        if (!isTauriRuntime() || tauriListenersReady) return;
        tauriListenersReady = true;
        await listen("pty-output", (ev) => {
            const payload = ev.payload || {};
            const s = sessions.get(payload.id);
            if (!s) return;
            const data = String(payload.data || "");
            if (s.term) s.term.write(data);
            appendMirror(s, data);
        });
        await listen("pty-exit", (ev) => {
            const payload = ev.payload || {};
            const s = sessions.get(payload.id);
            if (!s) return;
            s.ready = false;
            const msg = `\r\n[process exited with code ${payload.code ?? 0}]\r\n`;
            if (s.term) s.term.write(msg);
            appendMirror(s, msg);
            if (s.id === activeId) setStatus(`exited (${payload.code ?? 0})`, "error");
        });
    }

    function renderTabs() {
        tabsEl.innerHTML = Array.from(sessions.values()).map((s) => `
            <div class="term-tab ${s.id === activeId ? "active" : ""}" data-tid="${s.id}" role="tab" aria-selected="${s.id === activeId}">
                <span class="term-tab-label">${s.label}</span>
                <button type="button" class="term-tab-close" data-close-tid="${s.id}" title="Close terminal and kill shell">&times;</button>
            </div>
        `).join("");
    }

    function fitSession(s) {
        if (!s || !s.fitAddon) return;
        const box = s.host.getBoundingClientRect();
        if (box.width < 40 || box.height < 40) return;
        try { s.fitAddon.fit(); } catch { return; }
        const cols = s.term?.cols || 80;
        const rows = s.term?.rows || 24;
        if (s.mode === "tauri") {
            void invoke("pty_resize", { id: s.id, cols, rows }).catch(() => {});
        } else if (s.ws && s.ws.readyState === 1) {
            s.ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
    }

    function sendToSession(s, data) {
        if (!s) return;
        const str = String(data ?? "");
        if (s.mode === "tauri") {
            void invoke("pty_write", { id: s.id, data: str }).catch(() => {});
        } else if (s.ws && s.ws.readyState === 1) {
            s.ws.send(JSON.stringify({ type: "input", data: str }));
        }
    }

    async function spawnSession(shellId) {
        const id = `term-${nextSeq++}`;
        const chosenShell = shellId || shellSel?.value || "powershell";
        const shellLabel = chosenShell === "cmd" ? "cmd" : chosenShell === "gitbash" ? "bash" : "pwsh";
        const host = document.createElement("div");
        host.className = "term-host hidden";
        stageEl.appendChild(host);

        const s = {
            id,
            shellId: chosenShell,
            label: `${shellLabel} #${nextSeq - 1}`,
            host,
            term: null,
            fitAddon: null,
            ws: null,
            mode: isTauriRuntime() ? "tauri" : "ws",
            ready: false,
            connected: false,
            cwd: getCwd() || "",
            homeDir: "",
            mirror: "",
        };
        sessions.set(id, s);

        try {
            const term = new Terminal({
                theme: {
                    background: "#ffffff",
                    foreground: "#111111",
                    cursor: "#111111",
                    cursorAccent: "#ffffff",
                    selectionBackground: "#cce4f7",
                    selectionForeground: "#000000",
                    black: "#111111",
                    red: "#c41a16",
                    green: "#007400",
                    yellow: "#946200",
                    blue: "#0050a4",
                    magenta: "#881391",
                    cyan: "#007373",
                    white: "#555555",
                    brightBlack: "#666666",
                    brightRed: "#dc2626",
                    brightGreen: "#15803d",
                    brightYellow: "#b45309",
                    brightBlue: "#0078d4",
                    brightMagenta: "#a21caf",
                    brightCyan: "#0e7490",
                    brightWhite: "#1f2937",
                },
                fontFamily: "Consolas, 'Cascadia Code', ui-monospace, monospace",
                fontSize: 12.5,
                lineHeight: 1.2,
                cursorBlink: true,
                convertEol: false,
                scrollback: 5000,
            });
            const fitAddon = new FitAddon();
            term.loadAddon(fitAddon);
            term.open(host);

            // Windows copy/paste + Ctrl+C interrupt handling
            term.attachCustomKeyEventHandler((ev) => {
                if (ev.type === "keydown" && (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "c") {
                    if (term.hasSelection()) {
                        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
                        term.clearSelection();
                        return false;
                    }
                    return true; // send \x03 to ConPTY
                }
                if (ev.type === "keydown" && (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "v") {
                    navigator.clipboard?.readText().then((txt) => {
                        if (txt) sendToSession(s, txt);
                    }).catch(() => {});
                    return false;
                }
                return true;
            });

            term.onData((data) => sendToSession(s, data));
            s.term = term;
            s.fitAddon = fitAddon;
        } catch {
            // Headless/jsdom fallback without canvas
        }

        selectTab(id);

        if (s.mode === "tauri") {
            await ensureTauriListeners();
            try {
                if (s.id === activeId) setStatus("starting...");
                const cols = s.term?.cols || 100;
                const rows = s.term?.rows || 24;
                const res = await invoke("pty_create", {
                    id: s.id,
                    shell: chosenShell,
                    cwd: getCwd() || null,
                    cols,
                    rows,
                    extraPaths: getExtraPaths() || [],
                });
                s.ready = true;
                s.connected = true;
                s.homeDir = res?.home || s.homeDir || "";
                s.cwd = res?.cwd || s.cwd;
                if (s.id === activeId) {
                    setStatus(`ready (${chosenShell})`, "ready");
                    syncMirror();
                    fitSession(s);
                }
                return true;
            } catch (err) {
                if (s.id === activeId) setStatus(`error: ${err}`, "error");
                return false;
            }
        }

        // Browser / dev fallback via WebSocket /ws/terminal
        if (typeof WebSocket === "undefined") {
            if (s.id === activeId) setStatus("unavailable", "error");
            return false;
        }
        return new Promise((resolve) => {
            if (s.id === activeId) setStatus("connecting");
            const baseUrl = terminalWsUrl({ shell: chosenShell, cwd: getCwd() || "" });
            let ws;
            try { ws = new WebSocket(baseUrl); }
            catch (err) {
                if (s.id === activeId) setStatus(`error: ${err.message}`, "error");
                resolve(false);
                return;
            }
            s.ws = ws;
            ws.onopen = () => {
                s.connected = true;
                if (s.id === activeId) setStatus("connected", "ready");
            };
            ws.onmessage = (ev) => {
                let msg;
                try { msg = JSON.parse(ev.data); } catch { return; }
                if (msg?.type === "ready") {
                    s.ready = true;
                    s.connected = true;
                    s.homeDir = msg.home || s.homeDir || "";
                    s.cwd = msg.cwd || s.cwd;
                    if (s.id === activeId) {
                        setStatus(`ready${msg.ghdlOnPath ? " · ghdl" : ""}`, "ready");
                        syncMirror();
                        fitSession(s);
                    }
                    appendMirror(s, `shell ready · ${s.cwd}\n`);
                    resolve(true);
                } else if (msg?.type === "output") {
                    if (s.term) s.term.write(msg.data || "");
                    appendMirror(s, msg.data || "");
                } else if (msg?.type === "exit") {
                    s.ready = false;
                    if (s.id === activeId) setStatus(`exited (${msg.code ?? "?"})`, "error");
                    appendMirror(s, `\n[process exited with code ${msg.code ?? "?"}]\n`);
                } else if (msg?.type === "error") {
                    if (s.id === activeId) setStatus(`error: ${msg.message || "unknown"}`, "error");
                }
            };
            ws.onerror = () => {
                if (s.id === activeId) setStatus("connection error", "error");
                resolve(false);
            };
            ws.onclose = () => {
                s.connected = false;
                s.ready = false;
                if (s.id === activeId) setStatus("disconnected");
                resolve(false);
            };
        });
    }

    function selectTab(id) {
        if (!sessions.has(id)) return;
        activeId = id;
        for (const [sid, s] of sessions) {
            s.host.classList.toggle("hidden", sid !== id);
        }
        renderTabs();
        const active = sessions.get(id);
        if (active) {
            setStatus(active.ready ? `ready (${active.shellId})` : "disconnected", active.ready ? "ready" : "normal");
            syncMirror();
            requestAnimationFrame(() => fitSession(active));
        }
    }

    async function closeTab(id) {
        const s = sessions.get(id);
        if (!s) return;
        sessions.delete(id);
        if (s.mode === "tauri") {
            void invoke("pty_kill", { id: s.id }).catch(() => {});
        } else if (s.ws) {
            try { s.ws.close(); } catch { /* ignore */ }
        }
        try { s.term?.dispose(); } catch { /* ignore */ }
        s.host.remove();
        if (activeId === id) {
            const next = sessions.keys().next().value || null;
            if (next) selectTab(next);
            else {
                activeId = null;
                renderTabs();
                setStatus("closed");
                syncMirror();
            }
        } else {
            renderTabs();
        }
    }

    addBtn?.addEventListener("click", () => { void spawnSession(shellSel?.value); });
    tabsEl?.addEventListener("click", (e) => {
        const closeBtn = e.target.closest("[data-close-tid]");
        if (closeBtn) {
            e.stopPropagation();
            void closeTab(closeBtn.dataset.closeTid);
            return;
        }
        const tab = e.target.closest("[data-tid]");
        if (tab) selectTab(tab.dataset.tid);
    });

    cdProjBtn?.addEventListener("click", () => onCdProject?.());
    clearBtn?.addEventListener("click", () => clear());
    restartBtn?.addEventListener("click", () => { void restart(); });

    if (inputEl) {
        inputEl.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
                ev.preventDefault();
                runLine(inputEl.value);
            }
        });
    }

    let fitRaf = 0;
    const resizeObserver = typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (fitRaf) return;
            fitRaf = requestAnimationFrame(() => {
                fitRaf = 0;
                const s = sessions.get(activeId);
                if (s) fitSession(s);
            });
        })
        : null;
    resizeObserver?.observe(containerEl);

    async function connect() {
        await loadShells();
        if (sessions.size === 0) {
            return spawnSession(shellSel?.value);
        }
        return true;
    }

    async function open() {
        const ok = await connect();
        fit();
        return ok;
    }

    function fit() {
        const s = sessions.get(activeId);
        if (s) fitSession(s);
    }

    function sendInput(data) {
        const s = sessions.get(activeId);
        if (s) sendToSession(s, data);
    }

    function runLine(line) {
        const value = String(line ?? "");
        sendInput(`${value}\r\n`);
        if (inputEl && inputEl.value) inputEl.value = "";
    }

    function syncCwd(targetDir, { force = false } = {}) {
        const s = sessions.get(activeId);
        if (!s || !s.connected) return false;
        const desired = normalizeDir(targetDir);
        const displayTarget = desired || s.homeDir || "~";
        if (!force) {
            if (desired && sameDir(s.cwd, desired)) return false;
            if (!desired && ((s.homeDir && sameDir(s.cwd, s.homeDir)) || s.cwd === "~")) return false;
        }
        const cmd = buildCdCommand(desired, s.shellId);
        sendToSession(s, `${cmd}\r\n`);
        s.cwd = displayTarget;
        syncMirror();
        return true;
    }

    function clear() {
        const s = sessions.get(activeId);
        if (!s) return;
        s.term?.clear();
        s.mirror = "";
        syncMirror();
    }

    async function restart() {
        const s = sessions.get(activeId);
        const sh = s?.shellId || shellSel?.value;
        if (s) await closeTab(s.id);
        return spawnSession(sh);
    }

    function disconnect() {
        for (const id of Array.from(sessions.keys())) {
            void closeTab(id);
        }
    }

    return {
        connect,
        disconnect,
        open,
        fit,
        sendInput,
        runLine,
        clear,
        restart,
        syncCwd,
        newTab: (sh) => spawnSession(sh),
        closeTab,
        getTabCount: () => sessions.size,
        getCwd: () => sessions.get(activeId)?.cwd || "",
        getText: () => sessions.get(activeId)?.mirror || "",
        isReady: () => Boolean(sessions.get(activeId)?.ready),
        isConnected: () => Boolean(sessions.get(activeId)?.connected),
        element: containerEl,
        focus: () => { try { sessions.get(activeId)?.term?.focus(); } catch { /* ignore */ } },
    };
}

export default createTerminalController;
