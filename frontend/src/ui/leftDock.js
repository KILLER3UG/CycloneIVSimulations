// leftDock.js — Zones 2: the vertically split left dock.
// Top pane: Project Navigator (Hierarchy | Files | Examples) — the active
// FPGA target, the entity tree, project files and bundled examples.
// Bottom pane: Tasks — the interactive compilation pipeline modeled on
// Quartus (Analysis & Synthesis -> Pin Assignment -> Simulation -> Load
// Virtual Board), each stage showing live state, semantic checkmarks and
// stage durations. Clicking a stage jumps to its view.

import { icon } from "./icons.js";

const TASK_STATES = {
    idle: { glyph: "&#9675;", cls: "" },
    run: { glyph: "&#9203;", cls: "run" },
    done: { glyph: "&#10003;", cls: "done" },
    error: { glyph: "&#10007;", cls: "error" },
};

export const TASKS = [
    { id: "compile", label: "Compile Design", hint: "master run action" },
    { id: "analysis", label: "Analysis & Synthesis", hint: "HDL parse + GHDL analyze" },
    { id: "pins", label: "Pin Assignment (Fitter)", hint: "auto-map / .qsf validation" },
    { id: "sim", label: "Simulation & Stimulus", hint: "GHDL run + peripheral decode" },
    { id: "board", label: "Load Virtual Board", hint: "push state to the 3D PCB" },
];

export function createLeftDock(navigatorHost, tasksHost, h) {
    navigatorHost.classList.add("navigator");
    navigatorHost.innerHTML = `
        <div class="nv-head">
            <span class="nv-title">${icon("chip")}<span>Project Navigator</span></span>
            <button type="button" class="icon-btn nv-collapse" data-act="collapse-left" title="Collapse navigator">${icon("chevron")}</button>
        </div>
        <div class="nv-modes" role="tablist" aria-label="Navigator views">
            <button type="button" class="nv-mode active" data-nmode="hierarchy" role="tab" aria-selected="true">Hierarchy</button>
            <button type="button" class="nv-mode" data-nmode="files" role="tab" aria-selected="false">Files</button>
            <button type="button" class="nv-mode" data-nmode="examples" role="tab" aria-selected="false">Examples</button>
        </div>
        <div class="nv-body">
            <div class="nv-pane" data-npane="hierarchy">
                <div class="nv-target">
                    <span class="nv-target-label">FPGA target</span>
                    <b id="nv-board">Cyclone IV E: EP4CE6E22C8</b>
                </div>
                <div class="nv-tree" id="nv-tree"></div>
            </div>
            <div class="nv-pane hidden" data-npane="files">
                <div class="nv-filelist" id="nv-files"></div>
            </div>
            <div class="nv-pane hidden" data-npane="examples">
                <div class="nv-filelist" id="nv-examples"></div>
            </div>
        </div>
    `;

    tasksHost.classList.add("tasks");
    tasksHost.innerHTML = `
        <div class="tk-head">
            <span class="tk-title">${icon("activity")}<span>Tasks</span></span>
            <span class="tk-sub">Compilation Flow</span>
        </div>
        <div class="tk-list" id="tk-list">
            ${TASKS.map((task, i) => `
                <button type="button" class="tk-row" data-task="${i}" title="${task.hint}">
                    <span class="tk-glyph" data-glyph>${TASK_STATES.idle.glyph}</span>
                    <span class="tk-label">${task.label}</span>
                    <span class="tk-time" data-time></span>
                </button>`).join("")}
        </div>
        <div class="tk-shortcuts">
            <button type="button" class="tk-shortcut" data-jump="pinmap">${icon("sliders")}<span>Edit Pin Assignments</span></button>
            <button type="button" class="tk-shortcut" data-jump="boardimport">${icon("chip")}<span>Board Settings</span></button>
        </div>
    `;

    let mode = "hierarchy";
    const panes = Object.fromEntries(
        Array.from(navigatorHost.querySelectorAll(".nv-pane")).map((p) => [p.dataset.npane, p]),
    );

    function showMode(next) {
        mode = next;
        navigatorHost.querySelectorAll(".nv-mode").forEach((t) => {
            const on = t.dataset.nmode === next;
            t.classList.toggle("active", on);
            t.setAttribute("aria-selected", String(on));
        });
        Object.entries(panes).forEach(([key, pane]) => pane.classList.toggle("hidden", key !== next));
    }

    navigatorHost.addEventListener("click", (e) => {
        const modeBtn = e.target.closest(".nv-mode");
        if (modeBtn) { showMode(modeBtn.dataset.nmode); return; }
        if (e.target.closest("[data-act='collapse-left']")) { h.onToggleLeft?.(); return; }
        const fileBtn = e.target.closest("[data-file-i]");
        if (fileBtn) { h.onOpenFile?.(Number(fileBtn.dataset.fileI)); return; }
        const exBtn = e.target.closest("[data-example]");
        if (exBtn) { h.onExample?.(exBtn.dataset.example); return; }
        const port = e.target.closest("[data-port]");
        if (port) { h.onFocusPort?.(port.dataset.port); }
    });

    tasksHost.addEventListener("click", (e) => {
        const jump = e.target.closest("[data-jump]");
        if (jump) { h.onJump?.(jump.dataset.jump); return; }
        const row = e.target.closest("[data-task]");
        if (row) h.onTaskClick?.(Number(row.dataset.task));
    });

    // ------------------------------------------------------------- data ---
    function setBoardLabel(text) {
        const el = navigatorHost.querySelector("#nv-board");
        if (el) el.textContent = text || "—";
    }

    function setHierarchy(entity, topFile) {
        const tree = navigatorHost.querySelector("#nv-tree");
        if (!tree) return;
        if (!entity) {
            tree.innerHTML = `<div class="nv-empty">No top entity — compile to populate.</div>`;
            return;
        }
        const rows = [];
        rows.push(`<div class="nv-node nv-entity">${icon("chip")}<span>${entity.name}</span><em>top</em></div>`);
        for (const port of entity.ports || []) {
            const dir = port.direction === "in" ? "in" : "out";
            rows.push(`
                <div class="nv-node nv-port nv-${dir}" data-port="${port.name}">
                    <span class="nv-dir">${dir}</span>
                    <span class="nv-port-name">${port.name}</span>
                    <span class="nv-port-type">${port.type || port.typeName || ""}${port.width > 1 ? ` [${port.width}]` : ""}</span>
                </div>`);
        }
        tree.innerHTML = rows.join("");
    }

    function setFiles(files, activeIndex, topIndex) {
        const list = navigatorHost.querySelector("#nv-files");
        if (!list) return;
        list.innerHTML = (files || []).map((f, i) => `
            <button type="button" class="nv-file ${i === activeIndex ? "active" : ""}" data-file-i="${i}">
                ${icon("file")}<span class="nv-file-name">${f.name}</span>
                ${i === topIndex ? `<em class="nv-top">TOP</em>` : ""}
            </button>`).join("") || `<div class="nv-empty">No files.</div>`;
    }

    function setExamples(list) {
        const host = navigatorHost.querySelector("#nv-examples");
        if (!host) return;
        host.innerHTML = (list || []).map((ex) => `
            <button type="button" class="nv-file" data-example="${ex.id}">
                ${icon("play")}<span class="nv-file-name">${ex.name || ex.id}</span>
                <em class="nv-ex-desc">${ex.entity || ""}</em>
            </button>`).join("") || `<div class="nv-empty">No examples.</div>`;
    }

    function setTask(index, state, durationText) {
        const row = tasksHost.querySelector(`[data-task="${index}"]`);
        if (!row) return;
        const spec = TASK_STATES[state] || TASK_STATES.idle;
        const glyph = row.querySelector("[data-glyph]");
        glyph.innerHTML = spec.glyph;
        glyph.className = `tk-glyph ${spec.cls}${state === "run" ? " spin" : ""}`;
        row.classList.toggle("active", state === "run");
        row.classList.toggle("done", state === "done");
        row.classList.toggle("error", state === "error");
        const time = row.querySelector("[data-time]");
        if (time) time.textContent = durationText || "";
    }

    function resetTasks() {
        TASKS.forEach((_t, i) => setTask(i, "idle", ""));
    }

    return { showMode, setBoardLabel, setHierarchy, setFiles, setExamples, setTask, resetTasks, root: navigatorHost };
}
