// leftDock.js — Zone 2: Quartus Prime Project Navigator & Tasks panels.
// Matches the screenshots:
// - Project Navigator with Hierarchy dropdown, "Entity:Instance" header,
//   device "Cyclone IV E: EP4CE6E22C8", and top-level entity tree.
// - Tasks panel with Compilation dropdown, "Task" header,
//   Compile Design > Analysis & Synthesis, Fitter (Place & Route), Assembler,
//   Timing Analysis, EDA Netlist Writer, plus Edit Settings & Program Device.

import { icon } from "./icons.js";

const TASK_STATES = {
    idle: { glyph: "", cls: "" },
    run: { glyph: "&#9696;", cls: "run" },
    done: { glyph: "&#10003;", cls: "done" },
    error: { glyph: "&#10007;", cls: "error" },
};

export const TASKS = [
    { id: "analysis", label: "Analysis & Synthesis", icon: "qSynth", hint: "Run quartus_map (Analysis & Synthesis)" },
    { id: "fitter", label: "Fitter (Place & Route)", icon: "qFitter", hint: "Run quartus_fit (Place & Route)" },
    { id: "assembler", label: "Assembler (Generate programming files)", icon: "qAsm", hint: "Run quartus_asm (.sof output)" },
    { id: "timing", label: "Timing Analysis", icon: "qTiming", hint: "Run quartus_sta (TimeQuest Timing Analysis)" },
    { id: "eda", label: "EDA Netlist Writer", icon: "qEda", hint: "Run quartus_eda (ModelSim .vho + .sdo)" },
];

export function createLeftDock(navigatorHost, tasksHost, h) {
    navigatorHost.classList.add("navigator");
    navigatorHost.innerHTML = `
        <div class="q-pane-titlebar">
            <span class="q-pane-title">Project Navigator</span>
            <span class="q-pane-ico" aria-hidden="true">${icon("qHierarchy")}</span>
            <select id="nv-mode-select" class="q-pane-select" aria-label="Project Navigator view">
                <option value="hierarchy" selected>Hierarchy</option>
                <option value="files">Files</option>
                <option value="examples">Examples</option>
            </select>
            <div class="q-pane-btns">
                <button type="button" class="q-win-btn" data-act="collapse-left" title="Collapse Project Navigator">&times;</button>
            </div>
        </div>
        <div class="nv-body">
            <div class="nv-pane" data-npane="hierarchy">
                <div class="q-col-head">Entity:Instance</div>
                <div class="nv-tree" id="nv-tree">
                    <div class="nv-node nv-device" id="nv-device-row">
                        <span class="nv-caret">&#9662;</span>
                        ${icon("qDeviceChip")}
                        <span id="nv-board">Cyclone IV E: EP4CE6E22C8</span>
                    </div>
                    <div id="nv-entity-tree"></div>
                </div>
            </div>
            <div class="nv-pane hidden" data-npane="files">
                <div class="q-col-head">Project Files</div>
                <div class="nv-filelist" id="nv-files"></div>
            </div>
            <div class="nv-pane hidden" data-npane="examples">
                <div class="q-col-head">Built-in Examples</div>
                <div class="nv-filelist" id="nv-examples"></div>
            </div>
        </div>
    `;

    tasksHost.classList.add("tasks");
    tasksHost.innerHTML = `
        <div class="q-pane-titlebar">
            <span class="q-pane-title">Tasks</span>
            <select id="tk-flow-select" class="q-pane-select" aria-label="Tasks flow">
                <option value="compilation" selected>Compilation</option>
                <option value="simulation">Simulation</option>
            </select>
        </div>
        <div class="q-col-head">Task</div>
        <div class="tk-list" id="tk-list">
            <div class="tk-group" id="tk-compile-group">
                <button type="button" class="tk-row tk-parent" data-task-parent="compile" title="Double-click or click to run Full Compilation (Ctrl+L)">
                    <span class="tk-glyph" id="tk-master-glyph"></span>
                    <span class="tk-arrow" id="tk-compile-arrow">&#9662;</span>
                    <span class="tk-ico">${icon("qCompile")}</span>
                    <span class="tk-label">Compile Design</span>
                    <span class="tk-time" id="tk-master-time"></span>
                </button>
                <div class="tk-children" id="tk-children">
                    ${TASKS.map((task, i) => `
                        <button type="button" class="tk-row tk-child" data-task="${i}" data-stage="${task.id}" title="${task.hint}">
                            <span class="tk-glyph" data-glyph></span>
                            <span class="tk-arrow-sub">&#9656;</span>
                            <span class="tk-ico">${icon(task.icon)}</span>
                            <span class="tk-label">${task.label}</span>
                            <span class="tk-time" data-time></span>
                        </button>`).join("")}
                </div>
            </div>
            <button type="button" class="tk-row tk-extra" data-jump="settings" title="Configure Quartus path &amp; project settings">
                <span class="tk-glyph"></span>
                <span class="tk-ico">${icon("qSettings")}</span>
                <span class="tk-label">Edit Settings</span>
            </button>
            <button type="button" class="tk-row tk-extra" data-jump="pinmap" title="Open Pin Planner">
                <span class="tk-glyph"></span>
                <span class="tk-ico">${icon("qChip")}</span>
                <span class="tk-label">Pin Planner</span>
            </button>
            <button type="button" class="tk-row tk-extra" data-jump="programmer" title="Program Device (Open Programmer)">
                <span class="tk-glyph"></span>
                <span class="tk-ico">${icon("qPgm")}</span>
                <span class="tk-label">Program Device (Open Programmer)</span>
            </button>
        </div>
    `;

    const modeSelect = navigatorHost.querySelector("#nv-mode-select");
    const flowSelect = tasksHost.querySelector("#tk-flow-select");
    const panes = Object.fromEntries(
        Array.from(navigatorHost.querySelectorAll(".nv-pane")).map((p) => [p.dataset.npane, p]),
    );

    function showMode(next) {
        if (modeSelect) modeSelect.value = next;
        Object.entries(panes).forEach(([key, pane]) => pane.classList.toggle("hidden", key !== next));
    }

    modeSelect?.addEventListener("change", () => showMode(modeSelect.value));
    flowSelect?.addEventListener("change", () => {
        if (flowSelect.value === "simulation") h.onJump?.("simulate");
    });

    navigatorHost.addEventListener("click", (e) => {
        if (e.target.closest("[data-act='collapse-left']")) { h.onToggleLeft?.(); return; }
        const fileBtn = e.target.closest("[data-file-i]");
        if (fileBtn) { h.onOpenFile?.(Number(fileBtn.dataset.fileI)); return; }
        const exBtn = e.target.closest("[data-example]");
        if (exBtn) { h.onExample?.(exBtn.dataset.example); return; }
        const port = e.target.closest("[data-port]");
        if (port) { h.onFocusPort?.(port.dataset.port); return; }
        const entRow = e.target.closest(".nv-entity");
        if (entRow) {
            const portsBox = navigatorHost.querySelector("#nv-entity-ports");
            if (portsBox) {
                portsBox.classList.toggle("hidden");
                const caret = entRow.querySelector(".nv-ent-caret");
                if (caret) caret.innerHTML = portsBox.classList.contains("hidden") ? "&#9656;" : "&#9662;";
            }
        }
    });

    tasksHost.addEventListener("click", (e) => {
        if (e.target.closest("#tk-compile-arrow")) {
            tasksHost.querySelector("#tk-children")?.classList.toggle("hidden");
            const arrow = tasksHost.querySelector("#tk-compile-arrow");
            if (arrow) arrow.innerHTML = tasksHost.querySelector("#tk-children")?.classList.contains("hidden") ? "&#9656;" : "&#9662;";
            return;
        }
        const jump = e.target.closest("[data-jump]");
        if (jump) { h.onJump?.(jump.dataset.jump); return; }
        if (e.target.closest("[data-task-parent='compile']")) {
            h.onRunAll?.();
            return;
        }
        const row = e.target.closest("[data-task]");
        if (row) h.onTaskClick?.(Number(row.dataset.task), row.dataset.stage);
    });

    function setBoardLabel() {
        const el = navigatorHost.querySelector("#nv-board");
        if (el) el.textContent = "Cyclone IV E: EP4CE6E22C8";
    }

    function setHierarchy(entity) {
        const tree = navigatorHost.querySelector("#nv-entity-tree");
        if (!tree) return;
        if (!entity) {
            tree.innerHTML = `<div class="nv-node nv-entity selected"><span class="nv-indent"></span>${icon("qEntityChip")}<span class="nv-ent-name">design</span></div>`;
            return;
        }
        const rows = [];
        rows.push(`<div class="nv-node nv-entity selected" title="Top-level entity: ${entity.name}"><span class="nv-caret nv-ent-caret">&#9656;</span>${icon("qEntityChip")}<span class="nv-ent-name">${entity.name}</span></div>`);
        rows.push(`<div id="nv-entity-ports" class="hidden">`);
        for (const port of entity.ports || []) {
            const dir = port.direction === "in" ? "in" : "out";
            rows.push(`
                <div class="nv-node nv-port nv-${dir}" data-port="${port.name}">
                    <span class="nv-dir">${dir}</span>
                    <span class="nv-port-name">${port.name}</span>
                    <span class="nv-port-type">${port.type || port.typeName || ""}${port.width > 1 ? ` [${port.width}]` : ""}</span>
                </div>`);
        }
        rows.push(`</div>`);
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
        if (glyph) {
            glyph.innerHTML = spec.glyph;
            glyph.className = `tk-glyph ${spec.cls}${state === "run" ? " spin" : ""}`;
        }
        row.classList.toggle("active", state === "run");
        row.classList.toggle("done", state === "done");
        row.classList.toggle("error", state === "error");
        const time = row.querySelector("[data-time]");
        if (time) time.textContent = durationText || "";
    }

    function setMasterState(state, durationText = "") {
        const glyph = tasksHost.querySelector("#tk-master-glyph");
        const spec = TASK_STATES[state] || TASK_STATES.idle;
        if (glyph) {
            glyph.innerHTML = spec.glyph;
            glyph.className = `tk-glyph ${spec.cls}${state === "run" ? " spin" : ""}`;
        }
        const time = tasksHost.querySelector("#tk-master-time");
        if (time) time.textContent = durationText || "";
    }

    function resetTasks() {
        setMasterState("idle", "");
        TASKS.forEach((_t, i) => setTask(i, "idle", ""));
    }

    return { showMode, setBoardLabel, setHierarchy, setFiles, setExamples, setTask, setMasterState, resetTasks, root: navigatorHost };
}
