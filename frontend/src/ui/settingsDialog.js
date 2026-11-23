// settingsDialog.js — Quartus Prime Settings dialog & Missing-Quartus-Path alert.

import { dialog } from "./toast.js";

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
}

export async function openSettingsDialog({ api, onSaved } = {}) {
    let data = { settings: {}, quartus: {}, modelsim: {} };
    try {
        const res = await api._fetch("/api/settings");
        if (res?.data) data = res.data;
    } catch { /* ignore */ }

    const s = data.settings || {};
    const q = data.quartus || {};
    const m = data.modelsim || {};
    const candidates = q.candidates || [];

    const bodyHtml = `
        <div class="q-settings-form">
            <div class="q-set-group">
                <label class="q-set-label" for="qs-quartus-path">Quartus path (bin64)</label>
                <div class="q-set-row">
                    <input type="text" id="qs-quartus-path" class="q-set-input" value="${esc(s.quartusPath || "")}"
                           placeholder="C:\\intelFPGA\\18.1\\quartus\\bin64">
                    <button type="button" class="btn" id="qs-detect-btn">Auto-detect</button>
                </div>
                <div class="q-set-status ${q.valid ? "ok" : "err"}" id="qs-quartus-status">
                    ${q.valid ? `Valid: ${esc(q.version || q.path)}` : esc(q.error || "Quartus path not set")}
                </div>
                ${candidates.length ? `<div class="q-set-hint">Detected: ${candidates.map((c) => `<code>${esc(c)}</code>`).join(", ")}</div>` : ""}
            </div>

            <div class="q-set-group">
                <label class="q-set-label" for="qs-modelsim-path">ModelSim path (optional, for .vho netlist simulation)</label>
                <input type="text" id="qs-modelsim-path" class="q-set-input" value="${esc(s.modelsimPath || "")}"
                       placeholder="C:\\intelFPGA\\18.1\\modelsim_ase\\win32aloem">
                <div class="q-set-status ${m.valid ? "ok" : "dim"}" id="qs-ms-status">
                    ${m.valid ? `Valid: ${esc(m.path)}` : "Not detected (built-in simulator will be used)"}
                </div>
            </div>

            <div class="q-set-group">
                <label class="q-set-label" for="qs-project-dir">Project workspace folder</label>
                <input type="text" id="qs-project-dir" class="q-set-input" value="${esc(s.projectDir || "")}">
            </div>

            <div class="q-set-group">
                <label class="q-set-label">Target Device (Fixed Built-in Devboard)</label>
                <div class="q-set-static">Cyclone IV E &mdash; EP4CE6E22C8 (RZ-EasyFPGA A2.2)</div>
            </div>

            <div class="q-set-group">
                <label class="q-set-label" for="qs-shell">Default Terminal Shell</label>
                <select id="qs-shell" class="q-set-input">
                    <option value="powershell" ${s.defaultShell === "powershell" ? "selected" : ""}>PowerShell</option>
                    <option value="cmd" ${s.defaultShell === "cmd" ? "selected" : ""}>Command Prompt (cmd.exe)</option>
                    <option value="gitbash" ${s.defaultShell === "gitbash" ? "selected" : ""}>Git Bash</option>
                </select>
            </div>
        </div>
    `;

    dialog({
        title: "Settings — Quartus Prime Standard Edition",
        body: bodyHtml,
        actions: [
            {
                label: "Save & Validate",
                kind: "primary",
                closes: false,
                onClick: async (close) => {
                    const qInput = document.getElementById("qs-quartus-path");
                    const mInput = document.getElementById("qs-modelsim-path");
                    const pInput = document.getElementById("qs-project-dir");
                    const shInput = document.getElementById("qs-shell");
                    const stEl = document.getElementById("qs-quartus-status");
                    const msEl = document.getElementById("qs-ms-status");
                    try {
                        const res = await api._fetch("/api/settings", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                quartusPath: qInput?.value || "",
                                modelsimPath: mInput?.value || "",
                                projectDir: pInput?.value || "",
                                defaultShell: shInput?.value || "powershell",
                            }),
                        });
                        const out = res?.data || {};
                        const qRes = out.quartus || {};
                        const mRes = out.modelsim || {};
                        if (stEl) {
                            stEl.className = `q-set-status ${qRes.valid ? "ok" : "err"}`;
                            stEl.textContent = qRes.valid ? `Valid: ${qRes.version || qRes.path}` : (qRes.error || "Invalid Quartus path");
                        }
                        if (msEl) {
                            msEl.className = `q-set-status ${mRes.valid ? "ok" : "dim"}`;
                            msEl.textContent = mRes.valid ? `Valid: ${mRes.path}` : "Not detected (built-in simulator will be used)";
                        }
                        onSaved?.(out);
                        if (qRes.valid) close();
                    } catch (err) {
                        if (stEl) {
                            stEl.className = "q-set-status err";
                            stEl.textContent = `Save failed: ${err.message}`;
                        }
                    }
                },
            },
            { label: "Cancel" },
        ],
    });

    setTimeout(() => {
        document.getElementById("qs-detect-btn")?.addEventListener("click", () => {
            const qInput = document.getElementById("qs-quartus-path");
            if (qInput && candidates.length) {
                qInput.value = candidates[0];
            }
        });
    }, 0);
}

export function showMissingQuartusError(message, onSetPath) {
    dialog({
        title: "Quartus Prime Path Required",
        body: `
            <p class="q-err-msg">${esc(message || "Quartus Prime executable path is missing or invalid.")}</p>
            <p class="q-err-hint">Configure your Quartus <code>bin64</code> directory (for example <code>C:\\intelFPGA\\18.1\\quartus\\bin64</code>) to run real Quartus compilation.</p>
        `,
        actions: [
            {
                label: "Set path",
                kind: "primary",
                onClick: () => { onSetPath?.(); },
            },
            { label: "Dismiss" },
        ],
    });
}
