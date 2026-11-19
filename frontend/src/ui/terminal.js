// terminal.js — interactive PTY terminal over /ws/terminal.
//
// Renders a compact Studio Monochrome header, an xterm surface and a plain
// accessible command bar + text mirror. The mirror is ANSI-stripped so DOM
// assertions (Playwright) and keyboard/xterm usage both work.

import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { terminalWsUrl } from "../api.js";

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

function stripAnsi(text) {
    return String(text ?? "").replace(ANSI_PATTERN, "").replace(/\r/g, "");
}

/**
 * createTerminalController(containerEl) → controller with:
 *   connect, disconnect, open, fit, sendInput, runLine, clear, restart,
 *   getText, isReady, isConnected.
 */
export function createTerminalController(containerEl) {
    if (!containerEl) throw new Error("createTerminalController requires a container element");

    containerEl.classList.add("studio-terminal");
    containerEl.innerHTML = `
        <div class="term-header" role="toolbar" aria-label="Terminal controls"
             style="display:flex;align-items:center;gap:10px;padding:4px 9px;
                    background:#121215;color:#f4f4f5;border-bottom:1px solid #2a2a2e;
                    font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
          <span class="term-title" style="letter-spacing:.12em;text-transform:uppercase;opacity:.7">Terminal</span>
          <span id="term-cwd" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#a1a1aa">—</span>
          <span id="term-status" role="status" aria-live="polite" style="color:#f4f4f5">disconnected</span>
          <button id="term-clear" type="button" title="Clear terminal"
                  style="background:#232327;color:#f4f4f5;border:1px solid #3a3a40;border-radius:3px;padding:2px 8px;cursor:pointer;font:inherit">Clear</button>
          <button id="term-restart" type="button" title="Restart shell"
                  style="background:#232327;color:#f4f4f5;border:1px solid #3a3a40;border-radius:3px;padding:2px 8px;cursor:pointer;font:inherit">Restart</button>
        </div>
        <div class="xterm" style="background:#0a0a0b;color:#f4f4f5;padding:6px;flex:1;min-height:120px"></div>
        <div class="term-command" style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:#101013;border-top:1px solid #2a2a2e">
          <label for="terminal-input" style="color:#a1a1aa;font:600 11px ui-monospace,monospace">$</label>
          <input id="terminal-input" type="text" autocomplete="off" spellcheck="false"
                 aria-label="Run a command in the terminal"
                 placeholder="Run command (e.g. ghdl --version)..."
                 style="flex:1;min-width:0;background:#0a0a0b;color:#f4f4f5;border:1px solid #34343a;border-radius:3px;padding:5px 7px;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" />
        </div>
        <pre id="terminal-output" class="term-mirror" role="log" aria-live="polite"
             style="background:#0a0a0b;color:#f4f4f5;
                    font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
                    white-space:pre-wrap;overflow:auto"></pre>`;

    const xtermEl = containerEl.querySelector(".xterm");
    const cwdEl = containerEl.querySelector("#term-cwd");
    const statusEl = containerEl.querySelector("#term-status");
    const clearBtn = containerEl.querySelector("#term-clear");
    const restartBtn = containerEl.querySelector("#term-restart");
    const inputEl = containerEl.querySelector("#terminal-input");
    const outputEl = containerEl.querySelector("#terminal-output");

    let term = null;
    let fitAddon = null;
    let ws = null;
    let ready = false;
    let connected = false;
    let mirror = "";
    let connectPromise = null;

    function setStatus(text, tone = "normal") {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.style.color = tone === "error" ? "#ff6b6b" : tone === "ready" ? "#7ee2a8" : "#f4f4f5";
    }

    function appendMirror(data) {
        const text = stripAnsi(data);
        if (!text) return;
        mirror += text;
        // Bound DOM growth: long builds must not leak unbounded text nodes.
        if (mirror.length > 200000) mirror = mirror.slice(-100000);
        if (outputEl) outputEl.textContent = mirror;
    }

    function initXterm() {
        if (term || !xtermEl) return;
        try {
            term = new Terminal({
                theme: {
                    background: "#0a0a0b",
                    foreground: "#f4f4f5",
                    cursor: "#f4f4f5",
                    selectionBackground: "#3f3f46",
                },
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 12,
                lineHeight: 1.2,
                cursorBlink: true,
                convertEol: true,
                scrollback: 2000,
            });
            fitAddon = new FitAddon();
            term.loadAddon(fitAddon);
            term.open(xtermEl);
            term.onData((data) => sendInput(data));
            try { fitAddon.fit(); } catch { /* hidden container: fit later */ }
        } catch {
            // jsdom/headless without canvas support: the accessible mirror
            // and command bar remain fully usable.
            term = null;
            fitAddon = null;
        }
    }

    function send(obj) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    }

    function sendResize() {
        const cols = term?.cols || 80;
        const rows = term?.rows || 24;
        send({ type: "resize", cols, rows });
    }

    function connect() {
        if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
            return connectPromise || Promise.resolve(connected);
        }
        if (typeof WebSocket === "undefined") {
            setStatus("unavailable", "error");
            return Promise.resolve(false);
        }
        setStatus("connecting");
        connectPromise = new Promise((resolve) => {
            try {
                ws = new WebSocket(terminalWsUrl());
            } catch (err) {
                setStatus(`error: ${err.message}`, "error");
                resolve(false);
                return;
            }
            ws.onopen = () => {
                connected = true;
                setStatus("connected", "ready");
                resolve(true);
            };
            ws.onmessage = (ev) => {
                let msg;
                try { msg = JSON.parse(ev.data); } catch { return; }
                switch (msg?.type) {
                    case "ready":
                        ready = true;
                        connected = true;
                        if (cwdEl) cwdEl.textContent = msg.cwd || "—";
                        setStatus(`ready${msg.ghdlOnPath ? " · ghdl on PATH" : ""}`, "ready");
                        appendMirror(`shell ready · ${msg.cwd || "—"}\r\n`);
                        sendResize();
                        break;
                    case "output":
                        if (term) term.write(msg.data || "");
                        appendMirror(msg.data || "");
                        break;
                    case "exit":
                        ready = false;
                        setStatus(`exited (${msg.code ?? "?"})`, "error");
                        appendMirror(`\r\n[process exited with code ${msg.code ?? "?"}]\r\n`);
                        break;
                    case "error":
                        setStatus(`error: ${msg.message || "unknown"}`, "error");
                        appendMirror(`\r\n[error: ${msg.message || "unknown"}]\r\n`);
                        break;
                    default:
                        break;
                }
            };
            ws.onerror = () => {
                setStatus("connection error", "error");
                resolve(false);
            };
            ws.onclose = () => {
                connected = false;
                ready = false;
                if (statusEl && statusEl.textContent !== "connection error") setStatus("disconnected");
                resolve(false);
            };
        });
        return connectPromise;
    }

    function disconnect() {
        ready = false;
        connected = false;
        connectPromise = null;
        if (ws) {
            try { ws.close(); } catch { /* ignore */ }
            ws = null;
        }
        setStatus("disconnected");
    }

    async function open() {
        initXterm();
        const ok = await connect();
        if (ok) fit();
        return ok;
    }

    function fit() {
        try { fitAddon?.fit(); } catch { /* ignore hidden container */ }
        sendResize();
    }

    function sendInput(data) {
        send({ type: "input", data: String(data ?? "") });
    }

    function runLine(line) {
        const value = String(line ?? "");
        sendInput(`${value}\r\n`);
        if (inputEl && inputEl.value) inputEl.value = "";
    }

    function clear() {
        if (term) term.clear();
        mirror = "";
        if (outputEl) outputEl.textContent = "";
    }

    function restart() {
        clear();
        send({ type: "restart" });
    }

    function getText() {
        if (term?.buffer?.active?.getLine) {
            // Prefer the accessible mirror; xterm rows lose scrollback context.
        }
        return mirror;
    }

    if (clearBtn) clearBtn.addEventListener("click", clear);
    if (restartBtn) restartBtn.addEventListener("click", restart);
    // Keep xterm's grid synced with the dock: tab shows, dock drags, collapse
    // and window resizes all change the host box. rAF-debounced so a drag
    // coalesces into one fit per frame; hidden hosts are skipped (fit throws).
    let fitRaf = 0;
    const resizeObserver = typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (fitRaf) return;
            fitRaf = requestAnimationFrame(() => {
                fitRaf = 0;
                const box = containerEl.getBoundingClientRect();
                if (box.width > 40 && box.height > 40) fit();
            });
        })
        : null;
    resizeObserver?.observe(containerEl);
    if (inputEl) {
        inputEl.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
                ev.preventDefault();
                runLine(inputEl.value);
            }
        });
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
        getText,
        isReady: () => ready,
        isConnected: () => connected,
        // Exposed for the host UI's resize observer / keyboard focus helper.
        element: containerEl,
        focus: () => { try { term?.focus(); } catch { /* ignore */ } },
    };
}

export default createTerminalController;
