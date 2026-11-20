// updater.js — desktop auto-update bridge (Tauri updater plugin).
//
// The installed app's UI is served by the local backend sidecar origin, and
// the "remote-sidecar" capability grants that origin the updater/process IPC.
// In a plain browser (vite dev server, no Tauri runtime) updatesSupported()
// is false and the toolbar button stays hidden.

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { dialog } from "./ui/toast.js";

export function updatesSupported() {
    return Boolean(window.__TAURI_INTERNALS__);
}

export async function checkForUpdate() {
    const update = await check();
    if (!update) return null;
    return {
        version: String(update.version || ""),
        currentVersion: String(update.currentVersion || ""),
        notes: String(update.body || ""),
        async apply(onProgress) {
            let received = 0;
            let total = 0;
            await update.downloadAndInstall((event) => {
                if (event.event === "started") {
                    total = Number(event.data?.contentLength || 0);
                    onProgress?.(received, total);
                } else if (event.event === "progress") {
                    received += Number(event.data?.chunkLength || 0);
                    onProgress?.(received, total);
                } else if (event.event === "finished") {
                    onProgress?.(Math.max(received, total) || total, total);
                }
            });
        },
        relaunch: () => relaunch(),
    };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

const fmtSize = (n) => (Number(n) > 0 ? `${(Number(n) / (1024 * 1024)).toFixed(1)} MB` : "");

function progressHtml(text, pct) {
    const width = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="upd-progress"><div class="upd-bar" style="width:${width}%"></div><span>${esc(text)}</span></div>`;
}

// Full flow behind the toolbar "Check for updates" button.
export async function runUpdateFlow() {
    if (!updatesSupported()) return;

    let update = null;
    try {
        update = await checkForUpdate();
    } catch (err) {
        dialog({
            title: "Update check failed",
            body: `<div class="ic-row"><span>Error</span><b>${esc(String(err?.message || err))}</b></div>`,
            actions: [{ label: "Close", kind: "primary" }],
        });
        return;
    }

    if (!update) {
        dialog({
            title: "Up to date",
            body: `<div class="ic-row"><span>Version</span><b>v${esc(update?.currentVersion)}</b></div>
                   <div class="ic-row"><span>Channel</span><b>GitHub releases</b></div>`,
            actions: [{ label: "Close", kind: "primary" }],
        });
        return;
    }

    const applyUpdate = async (onTick) => {
        try {
            await update.apply(onTick);
            return null;
        } catch (err) {
            return String(err?.message || err);
        }
    };

    dialog({
        title: `Update available — v${update.version}`,
        body: `<div class="ic-row"><span>Current</span><b>v${esc(update.currentVersion)}</b></div>
               <div class="ic-row"><span>New version</span><b>v${esc(update.version)}</b></div>
               ${update.notes ? `<div class="ic-fact">${esc(update.notes)}</div>` : ""}
               ${progressHtml("Ready to download", 0)}`,
        actions: [
            {
                label: "Download & install",
                kind: "primary",
                closes: false,
                onClick: (closeDialog) => {
                    const btn = document.querySelector(".modal-actions .btn.primary");
                    if (btn) { btn.disabled = true; btn.textContent = "Downloading\u2026"; }
                    void (async () => {
                        const err = await applyUpdate((done, total) => {
                            const box = document.getElementById("upd-progress");
                            if (!box) return;
                            const pct = total ? Math.round((done / total) * 100) : 0;
                            const text = total ? `Downloading — ${fmtSize(done)} / ${fmtSize(total)}` : "Downloading\u2026";
                            box.outerHTML = progressHtml(text, pct);
                        });
                        if (err) {
                            const box = document.getElementById("upd-progress");
                            if (box) box.outerHTML = progressHtml(`Update failed — ${err}`, 0);
                            if (btn) { btn.disabled = false; btn.textContent = "Download & install"; }
                            return;
                        }
                        closeDialog();
                        dialog({
                            title: "Update installed",
                            body: `<div class="ic-row"><span>Version</span><b>v${esc(update.version)}</b></div>
                                   <div class="ic-fact">The app will restart to apply the update.</div>`,
                            actions: [
                                { label: "Restart now", kind: "primary", onClick: () => void update.relaunch() },
                                { label: "Later" },
                            ],
                        });
                    })();
                },
            },
            { label: "Later" },
        ],
    });
}
