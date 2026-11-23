// menuBar.js — Zone 0: the slim Quartus-style IDE menu.
// File / Edit / View / Assignments / Processing / Tools — calm monochrome
// dropdowns that route to the existing studio actions (no duplicate logic).

import { icon } from "./icons.js";

const MENUS = [
    {
        label: "File", items: [
            { id: "new-vhd", label: "New VHDL File", hint: ".vhd" },
            { id: "new-v", label: "New Verilog File", hint: ".v" },
            { id: "examples", label: "Open Example\u2026" },
            { sep: true },
            { id: "export-vcd", label: "Export Waveform VCD" },
        ],
    },
    {
        label: "Edit", items: [
            { id: "find", label: "Find in File", hint: "Ctrl+F" },
            { id: "goto", label: "Go to Line\u2026", hint: "Ctrl+G" },
        ],
    },
    {
        label: "View", items: [
            { id: "toggle-left", label: "Toggle Project Navigator" },
            { id: "toggle-right", label: "Toggle Board Dock" },
            { id: "toggle-bottom", label: "Toggle Messages Dock" },
            { sep: true },
            { id: "cam-top", label: "Camera: Top" },
            { id: "cam-iso", label: "Camera: 45\u00b0" },
            { id: "cam-front", label: "Camera: Front" },
            { id: "cam-fit", label: "Camera: Fit Board" },
            { sep: true },
            { id: "pin-labels", label: "Toggle Pin Labels" },
        ],
    },
    {
        label: "Assignments", items: [
            { id: "pin-planner", label: "Pin Planner" },
            { id: "board-settings", label: "Board / Import Settings" },
        ],
    },
    {
        label: "Processing", items: [
            { id: "compile", label: "Compile & Run", hint: "Ctrl+Enter" },
            { id: "pause", label: "Pause / Resume" },
            { id: "stop", label: "Stop", hint: "Esc" },
            { id: "reset", label: "Reset" },
            { id: "step", label: "Step One Cycle" },
        ],
    },
    {
        label: "Tools", items: [
            { id: "terminal", label: "Open Terminal" },
            { id: "update", label: "Check for Updates" },
        ],
    },
];

export function createMenuBar(root, h) {
    root.classList.add("menubar");
    root.innerHTML = `
        <span class="mb-brand">${icon("chip")}<b>Cyclone IV Studio</b></span>
        ${MENUS.map((menu, i) => `
            <div class="mb-item" data-menu="${i}">
                <button type="button" class="mb-label" aria-haspopup="true" aria-expanded="false">${menu.label}</button>
                <div class="mb-dropdown" hidden role="menu">
                    ${menu.items.map((item) => item.sep
                        ? `<div class="mb-sep" role="separator"></div>`
                        : `<button type="button" class="mb-entry" role="menuitem" data-act="${item.id}">
                               <span>${item.label}</span>${item.hint ? `<code>${item.hint}</code>` : ""}
                           </button>`).join("")}
                </div>
            </div>`).join("")}
        <span class="mb-flex"></span>
        <span class="mb-entity" id="mb-top-entity" title="Top-level entity">&mdash;</span>
    `;

    let openMenu = null;
    const close = () => {
        if (openMenu === null) return;
        const item = root.querySelector(`[data-menu="${openMenu}"]`);
        item?.querySelector(".mb-dropdown")?.setAttribute("hidden", "");
        item?.querySelector(".mb-label")?.setAttribute("aria-expanded", "false");
        openMenu = null;
    };

    root.addEventListener("click", (e) => {
        const label = e.target.closest(".mb-label");
        if (label) {
            const item = label.closest(".mb-item");
            const idx = item.dataset.menu;
            if (openMenu === idx) { close(); return; }
            close();
            openMenu = idx;
            item.querySelector(".mb-dropdown").removeAttribute("hidden");
            label.setAttribute("aria-expanded", "true");
            return;
        }
        const entry = e.target.closest(".mb-entry");
        if (entry) {
            close();
            h.onAction?.(entry.dataset.act);
            return;
        }
        if (!e.target.closest(".mb-item")) close();
    });
    root.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    document.addEventListener("click", (e) => {
        if (!root.contains(e.target)) close();
    });

    function setTopEntity(name) {
        const el = root.querySelector("#mb-top-entity");
        if (el) el.textContent = name || "\u2014";
    }

    return { setTopEntity, root };
}
