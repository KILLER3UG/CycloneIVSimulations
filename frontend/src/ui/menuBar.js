// menuBar.js — Zone 0: exact Quartus Prime Standard Edition menu bar.
// File, Edit, View, Project, Assignments, Processing, Tools, Window, Help.

import { icon } from "./icons.js";

const MENUS = [
    {
        label: "File",
        items: [
            { id: "new-vhd", label: "New...", hint: "Ctrl+N", icon: "qNew" },
            { id: "open-file", label: "Open...", hint: "Ctrl+O", icon: "qOpen" },
            { id: "close-file", label: "Close", hint: "Ctrl+F4" },
            { sep: true },
            { id: "new-project", label: "New Project Wizard...", icon: "qProjNew" },
            { id: "open-project", label: "Open Project...", hint: "Ctrl+J", icon: "qProjOpen" },
            { id: "save-project", label: "Save Project" },
            { id: "close-project", label: "Close Project" },
            { sep: true },
            { id: "save-file", label: "Save", hint: "Ctrl+S", icon: "qSave" },
            { id: "save-as", label: "Save As..." },
            { id: "save-all", label: "Save All", hint: "Ctrl+Shift+S", icon: "qSaveAll" },
            { sep: true },
            { id: "export-zip", label: "Export Project Archive (.zip)" },
            { id: "export-vcd", label: "Export Waveform VCD" },
            { sep: true },
            { id: "examples", label: "Open Example Project..." },
            { sep: true },
            { id: "exit", label: "Exit", hint: "Alt+F4" },
        ],
    },
    {
        label: "Edit",
        items: [
            { id: "undo", label: "Undo", hint: "Ctrl+Z" },
            { id: "redo", label: "Redo", hint: "Ctrl+Y" },
            { sep: true },
            { id: "cut", label: "Cut", hint: "Ctrl+X" },
            { id: "copy", label: "Copy", hint: "Ctrl+C" },
            { id: "paste", label: "Paste", hint: "Ctrl+V" },
            { sep: true },
            { id: "find", label: "Find / Replace...", hint: "Ctrl+F" },
            { id: "goto", label: "Go to Line...", hint: "Ctrl+G" },
        ],
    },
    {
        label: "View",
        items: [
            { id: "toggle-left", label: "Project Navigator & Tasks" },
            { id: "toggle-right", label: "3D Devboard Sidebar", hint: "Ctrl+\\" },
            { id: "toggle-bottom", label: "Messages & Terminal Dock" },
            { sep: true },
            { id: "cam-top", label: "Devboard Camera: Top" },
            { id: "cam-iso", label: "Devboard Camera: 45\u00b0" },
            { id: "cam-front", label: "Devboard Camera: Front" },
            { id: "cam-fit", label: "Devboard Camera: Fit Board" },
            { sep: true },
            { id: "pin-labels", label: "Toggle Pin Labels" },
        ],
    },
    {
        label: "Project",
        items: [
            { id: "add-file", label: "Add/Remove Files in Project..." },
            { id: "set-top", label: "Set Active File as Top-Level Entity" },
            { sep: true },
            { id: "open-quartus", label: "Open in Quartus Prime..." },
        ],
    },
    {
        label: "Assignments",
        items: [
            { id: "pin-planner", label: "Pin Planner" },
            { id: "device-info", label: "Device (Cyclone IV E: EP4CE6E22C8)" },
            { sep: true },
            { id: "settings", label: "Settings..." },
        ],
    },
    {
        label: "Processing",
        items: [
            { id: "compile", label: "Start Compilation", hint: "Ctrl+L" },
            { id: "stop", label: "Stop Compilation", hint: "Esc" },
            { sep: true },
            { id: "stage-analysis", label: "Start Analysis & Synthesis" },
            { id: "stage-fitter", label: "Start Fitter (Place & Route)" },
            { id: "stage-assembler", label: "Start Assembler" },
            { id: "stage-timing", label: "Start Timing Analysis" },
            { id: "stage-eda", label: "Start EDA Netlist Writer" },
            { sep: true },
            { id: "sim-fast", label: "Run Interactive Board Simulation", hint: "Ctrl+Enter" },
            { id: "comp-report", label: "Compilation Report" },
        ],
    },
    {
        label: "Tools",
        items: [
            { id: "programmer", label: "Programmer" },
            { id: "sim-netlist", label: "Run Simulation Tool (ModelSim / Built-in)" },
            { sep: true },
            { id: "terminal", label: "Terminal (ConPTY)" },
            { id: "settings", label: "Options / Quartus Path..." },
            { id: "update", label: "Check for Updates" },
        ],
    },
    {
        label: "Window",
        items: [
            { id: "win-sources", label: "Source Editor" },
            { id: "win-report", label: "Compilation Report" },
            { id: "win-pinmap", label: "Pin Planner" },
            { id: "win-3d", label: "3D Devboard" },
            { id: "win-terminal", label: "Terminal" },
        ],
    },
    {
        label: "Help",
        items: [
            { id: "about", label: "About Quartus Prime Standard Edition" },
            { id: "shortcuts", label: "Keyboard Shortcuts" },
        ],
    },
];

export function createMenuBar(root, h) {
    root.classList.add("menubar");
    root.innerHTML = `
        ${MENUS.map((menu, i) => `
            <div class="mb-item" data-menu="${i}">
                <button type="button" class="mb-label" aria-haspopup="true" aria-expanded="false">${menu.label}</button>
                <div class="mb-dropdown" hidden role="menu">
                    ${menu.items.map((item) => item.sep
                        ? `<div class="mb-sep" role="separator"></div>`
                        : `<button type="button" class="mb-entry" role="menuitem" data-act="${item.id}">
                               <span class="mb-ico">${item.icon ? icon(item.icon) : ""}</span>
                               <span class="mb-entry-label">${item.label}</span>${item.hint ? `<code>${item.hint}</code>` : ""}
                           </button>`).join("")}
                </div>
            </div>`).join("")}
        <span class="mb-flex"></span>
        <span class="mb-entity hidden" id="mb-top-entity" title="Top-level entity">&mdash;</span>
        <form class="mb-search" id="mb-search-form" role="search">
            <input type="text" id="mb-search-input" class="mb-search-input" placeholder="Search altera.com" aria-label="Search">
            <button type="submit" class="mb-search-btn" title="Find in Editor">${icon("search")}</button>
        </form>
    `;

    root.querySelector("#mb-search-form")?.addEventListener("submit", (e) => {
        e.preventDefault();
        h.onAction?.("find");
    });

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
