// editorPanel.js — Quartus-style right sidebar:
// Project/file list (+ Add .vhd/.v, Set as Top-Level, Delete with Undo toast),
// Top-level indicator + Device selector, Monaco editor with tabs & empty state,
// single Compile button, and clickable Messages panel with compile summary.

import * as monaco from "monaco-editor";
import EditorWorker from "../monaco-editor.worker.js?worker";
import JSZip from "jszip";
import { icon } from "./icons.js";
import { registerLanguages, languageForFile } from "./grammars.js";
import { dialog, toast } from "./toast.js";
import { parseEntitiesWithPorts } from "../pinPlanner.js";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
registerLanguages(monaco);

const ALLOWED = [".vhd", ".vhdl", ".v", ".sv", ".qsf", ".qpf", ".mif", ".hex"];
const DEVICES = [
    { key: "ep4ce6", label: "EP4CE6E22C8N" },
    { key: "ep4ce10", label: "EP4CE10E22C8N" },
];
const BOARD_MODELS = new Set(["at24c08", "hd44780", "ir_nec", "lm75", "ps2_keyboard"]);
const VERILOG_BUILTIN = new Set([
    "if", "else", "case", "casex", "casez", "for", "while", "repeat", "forever",
    "always", "initial", "assign", "module", "endmodule", "function", "task",
    "begin", "end", "and", "or", "nand", "nor", "xor", "xnor", "buf", "not",
    "bufif0", "bufif1", "notif0", "notif1", "pulldown", "pullup", "posedge", "negedge",
]);

function escHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
}

function stripCommentsKeepLines(code, fileName) {
    if (/\.(v|sv)$/i.test(fileName || "")) {
        return String(code || "")
            .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat((m.match(/\n/g) || []).length))
            .replace(/\/\/.*/g, "");
    }
    return String(code || "").replace(/--.*/g, "");
}

function lineAtOffset(text, idx) {
    return (text.slice(0, idx).match(/\n/g) || []).length + 1;
}

function vhdlSkeleton(entityName) {
    return [
        "library IEEE;",
        "use IEEE.STD_LOGIC_1164.ALL;",
        "use IEEE.NUMERIC_STD.ALL;",
        "",
        `entity ${entityName} is`,
        "    port (",
        "        clk : in  std_logic;",
        "        led : out std_logic_vector(3 downto 0)",
        "    );",
        `end entity ${entityName};`,
        "",
        `architecture rtl of ${entityName} is`,
        "begin",
        '    led <= (others => \'1\');',
        "end architecture rtl;",
        "",
    ].join("\n");
}

function verilogSkeleton(moduleName) {
    return [
        `module ${moduleName} (`,
        "    input  wire       clk,",
        "    output wire [3:0] led",
        ");",
        "    assign led = 4'b1111;",
        "endmodule",
        "",
    ].join("\n");
}

export function createEditorPanel(root, h) {
    root.classList.add("editor-panel");
    root.innerHTML = `
        <div class="ep-resizer" aria-hidden="true" title="Drag to resize"></div>
        <div class="ep-head">
            <span class="ep-title">${icon("file")}<span>Project & Source</span></span>
            <span class="ep-head-actions">
                <span class="ep-add-group" role="group" aria-label="Add source file">
                    <button type="button" class="ep-mod-btn" data-act="add-vhd" title="Add new VHDL file (.vhd)">+ Add file</button>
                    <button type="button" class="ep-mod-btn ep-mod-v" data-act="add-v" title="Add new Verilog file (.v)">.v</button>
                </span>
                <button class="icon-btn" data-act="upload" title="Upload files (.vhd .v .sv .qsf .mif .hex)">${icon("upload")}</button>
                <button class="icon-btn" data-act="rename" title="Rename active file">${icon("pencil")}</button>
                <button class="icon-btn" data-act="delete" title="Delete active file">${icon("trash")}</button>
                <button class="icon-btn" data-act="zip" title="Download project as zip">${icon("zip")}</button>
                <button class="icon-btn" data-act="collapse" title="Collapse panel" aria-label="Collapse panel">${icon("chevron")}</button>
            </span>
        </div>

        <div class="ep-tabs-wrap">
            <div class="ep-tabs" id="ep-tabs" role="tablist"></div>
            <label class="ep-dev-inline" title="Target FPGA device">
                <select id="ep-device" aria-label="Target device">
                    ${DEVICES.map((d) => `<option value="${d.key}">${d.label}</option>`).join("")}
                </select>
            </label>
        </div>

        <div class="ep-editor-wrap" id="ep-drop">
            <div id="ep-editor"></div>
            <div class="ep-empty hidden" id="ep-empty">
                <p>No files in project</p>
                <div class="ep-empty-actions">
                    <button type="button" class="btn btn-primary" data-act="add-vhd">+ Add VHDL file (.vhd)</button>
                    <button type="button" class="btn" data-act="add-v">+ Add Verilog file (.v)</button>
                </div>
            </div>
            <div class="ep-drop-hint hidden" id="ep-drop-hint">Drop VHDL / Verilog / QSF / MIF / HEX files here</div>
        </div>

        <div class="ep-footer">
            <button class="btn btn-primary ep-run" id="ep-run" title="Compile design and load onto board (Ctrl+Enter)">${icon("play")}<span>Compile</span></button>
        </div>

        <div class="ep-messages" id="ep-messages" aria-label="Compile messages">
            <div class="ep-msg-head">
                <span class="ep-msg-title">Messages</span>
                <span class="ep-msg-summary" id="ep-msg-summary">Ready to compile</span>
                <button type="button" class="icon-btn ep-msg-toggle" data-act="toggle-msgs" title="Collapse messages" aria-label="Collapse messages" aria-expanded="true">${icon("chevron")}</button>
                <span class="ep-msg-filters">
                    <button type="button" class="ep-mf active" data-filter="all">All</button>
                    <button type="button" class="ep-mf" data-filter="error">Err</button>
                    <button type="button" class="ep-mf" data-filter="warning">Warn</button>
                    <button type="button" class="ep-mf" data-filter="info">Info</button>
                </span>
            </div>
            <div class="ep-msg-list" id="ep-msg-list">
                <div class="ep-msg-empty">Press Compile (Ctrl+Enter) to build and program the board.</div>
            </div>
        </div>

        <input type="file" id="ep-file" multiple accept=".vhd,.vhdl,.v,.sv,.qsf,.qpf,.mif,.hex" class="hidden">
    `;

    const editorHost = root.querySelector("#ep-editor");
    const emptyEl = root.querySelector("#ep-empty");
    const tabsEl = root.querySelector("#ep-tabs");
    const collapseBtn = root.querySelector('[data-act="collapse"]');
    const msgPanel = root.querySelector("#ep-messages");
    const msgToggle = root.querySelector('[data-act="toggle-msgs"]');

    const editor = monaco.editor.create(editorHost, {
        value: "",
        language: "c4-vhdl",
        theme: "c4-dark",
        minimap: { enabled: false },
        fontSize: 13,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderWhitespace: "selection",
        tabSize: 4,
        find: { addExtraSpaceOnTop: false, autoFindInSelection: "never" },
        lineNumbersMinChars: 3,
    });

    const models = new Map(); // name -> monaco.editor.ITextModel
    let files = [];
    let activeFile = -1;
    let fontSize = 13;
    let entity = null; // last compiled or parsed top entity
    let pinnedTop = null; // { fileName, entityName } | null
    let hasUserProject = false;
    let suppressModify = false;
    let refreshTimer = 0;
    let lastUndo = null;
    let messagesList = [];
    let msgFilter = "all";

    function snapshotFiles() {
        return files.map((f) => ({
            name: f.name,
            content: models.get(f.name)?.getValue() ?? f.content,
        }));
    }

    function isHdl(name) {
        return /\.(vhd|vhdl|v|sv)$/i.test(name || "");
    }

    // Parse declarations + instantiations in one HDL file for dependency resolution.
    function scanHdlFile(fileName, rawContent) {
        const entities = parseEntitiesWithPorts(rawContent, fileName);
        const clean = stripCommentsKeepLines(rawContent, fileName);
        const packages = [];
        const refs = [];
        const verilog = /\.(v|sv)$/i.test(fileName);

        if (!verilog) {
            let m;
            const pkgRe = /\bpackage\s+(?!body\b)([A-Za-z][A-Za-z0-9_]*)\s+is\b/gi;
            while ((m = pkgRe.exec(clean)) !== null) packages.push(m[1]);

            const useRe = /\buse\s+work\.([A-Za-z][A-Za-z0-9_]*)\b/gi;
            while ((m = useRe.exec(clean)) !== null) {
                refs.push({ kind: "package", name: m[1], line: lineAtOffset(clean, m.index) });
            }

            const directRe = /\bentity\s+(?:[A-Za-z][A-Za-z0-9_]*\.)?([A-Za-z][A-Za-z0-9_]*)\b(?!\s+is\b)/gi;
            while ((m = directRe.exec(clean)) !== null) {
                refs.push({ kind: "entity", name: m[1], line: lineAtOffset(clean, m.index) });
            }

            const compInstRe = /^\s*[A-Za-z][A-Za-z0-9_]*\s*:\s*(?:component\s+)?([A-Za-z][A-Za-z0-9_]*)\b[\s\S]*?(?:\bgeneric\s+map\b|\bport\s+map\b)/gim;
            while ((m = compInstRe.exec(clean)) !== null) {
                refs.push({ kind: "entity", name: m[1], line: lineAtOffset(clean, m.index) });
            }
        } else {
            // Strip module header parameter/port parentheses before scanning body instantiations
            const instRe = /\b([A-Za-z_][A-Za-z0-9_$]*)\s+(?:#\s*\([\s\S]*?\)\s*)?([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g;
            let m;
            while ((m = instRe.exec(clean)) !== null) {
                const modName = m[1];
                const instName = m[2];
                if (VERILOG_BUILTIN.has(modName.toLowerCase())) continue;
                if (VERILOG_BUILTIN.has(instName.toLowerCase())) continue;
                // Exclude `module name (` declaration itself
                if (modName.toLowerCase() === "module") continue;
                // Exclude primitive gates or declarations
                refs.push({ kind: "entity", name: modName, line: lineAtOffset(clean, m.index) });
            }
        }

        // Deduplicate refs per file preserving earliest line
        const seen = new Set();
        const uniqueRefs = [];
        for (const r of refs) {
            const k = `${r.kind}:${r.name.toLowerCase()}`;
            if (!seen.has(k)) {
                seen.add(k);
                uniqueRefs.push(r);
            }
        }
        return { name: fileName, entities, packages, refs: uniqueRefs };
    }

    function resolveCompilePlan() {
        const snap = snapshotFiles();
        const hdls = snap.filter((f) => isHdl(f.name));
        if (!hdls.length) {
            return {
                ok: false,
                topFile: "",
                topEntity: "",
                topEntityObj: null,
                includedFiles: [],
                ignoredFiles: [],
                ignoreInfos: [],
                missingErrors: [{ file: "", line: 1, column: 1, severity: "error", message: "No VHDL or Verilog source files in project." }],
            };
        }

        const scanned = new Map();
        const entityOwner = new Map(); // lower(entity) -> { fileName, ent }
        const pkgOwner = new Map();    // lower(pkg) -> fileName

        for (const f of hdls) {
            const info = scanHdlFile(f.name, f.content);
            scanned.set(f.name, info);
            for (const ent of info.entities) {
                if (!entityOwner.has(ent.name.toLowerCase())) {
                    entityOwner.set(ent.name.toLowerCase(), { fileName: f.name, ent });
                }
            }
            for (const pkg of info.packages) {
                if (!pkgOwner.has(pkg.toLowerCase())) pkgOwner.set(pkg.toLowerCase(), f.name);
            }
        }

        // Top-level selection: pinnedTop if set & valid, else active open HDL file (nearest HDL if QSF active)
        let topFileRec = null;
        if (pinnedTop) {
            topFileRec = hdls.find((f) => f.name === pinnedTop.fileName) || null;
            if (!topFileRec) pinnedTop = null;
        }
        if (!topFileRec) {
            const active = files[activeFile];
            if (active && isHdl(active.name)) {
                topFileRec = hdls.find((f) => f.name === active.name) || hdls[0];
            } else {
                topFileRec = hdls[0];
            }
        }

        const topScan = scanned.get(topFileRec.name);
        let topEntObj = null;
        if (pinnedTop?.entityName) {
            topEntObj = topScan.entities.find((e) => e.name.toLowerCase() === pinnedTop.entityName.toLowerCase()) || null;
        }
        if (!topEntObj && topScan.entities.length) {
            if (topScan.entities.length > 1) {
                const refSet = new Set(topScan.refs.map((r) => r.name.toLowerCase()));
                const nonTb = topScan.entities.filter((e) => !/^tb_/i.test(e.name));
                const pool = nonTb.length ? nonTb : topScan.entities;
                topEntObj = pool.find((e) => !refSet.has(e.name.toLowerCase())) || pool[0];
            } else {
                topEntObj = topScan.entities[0];
            }
        }
        const topEntityName = topEntObj?.name || pinnedTop?.entityName || topFileRec.name.replace(/\.[^.]+$/, "");

        // BFS dependency walk from topFileRec
        const includedOrder = [];
        const includedSet = new Set([topFileRec.name]);
        const queue = [topFileRec.name];
        const missingErrors = [];

        while (queue.length) {
            const curName = queue.shift();
            includedOrder.push(curName);
            const curScan = scanned.get(curName);
            if (!curScan) continue;

            for (const ref of curScan.refs) {
                const low = ref.name.toLowerCase();
                if (ref.kind === "package") {
                    const owner = pkgOwner.get(low);
                    if (owner && !includedSet.has(owner)) {
                        includedSet.add(owner);
                        queue.push(owner);
                    }
                    continue;
                }
                const found = entityOwner.get(low);
                if (found) {
                    if (!includedSet.has(found.fileName)) {
                        includedSet.add(found.fileName);
                        queue.push(found.fileName);
                    }
                } else if (!BOARD_MODELS.has(low)) {
                    missingErrors.push({
                        file: curName,
                        line: ref.line || 1,
                        column: 1,
                        severity: "error",
                        message: `Referenced entity/module '${ref.name}' could not be found in any project file.`,
                    });
                }
            }
        }

        // Order dependencies leaves-first, top-level last
        const includedFiles = [];
        for (const fn of [...includedOrder].reverse()) {
            const rec = hdls.find((x) => x.name === fn);
            if (rec) includedFiles.push(rec);
        }
        const ignoredFiles = hdls.filter((f) => !includedSet.has(f.name));
        const ignoreInfos = ignoredFiles.map((f) => ({
            file: f.name,
            line: 1,
            column: 1,
            severity: "info",
            message: `Ignored '${f.name}' — not in top-level '${topEntityName}' dependency tree.`,
        }));

        return {
            ok: missingErrors.length === 0,
            topFile: topFileRec.name,
            topEntity: topEntityName,
            topEntityObj: topEntObj,
            isPinned: Boolean(pinnedTop),
            includedSet,
            includedFiles,
            ignoredFiles,
            ignoreInfos,
            missingErrors,
            scanned,
        };
    }

    function getTopContext() {
        const plan = resolveCompilePlan();
        return {
            topFile: plan.topFile,
            topEntity: plan.topEntity,
            entityObj: plan.topEntityObj,
            isPinned: plan.isPinned,
            includedSet: plan.includedSet,
            ignoredFiles: plan.ignoredFiles,
        };
    }

    function refreshHierarchy(notifyTopChange = false) {
        const ctx = getTopContext();
        renderTabs(ctx);
        if (notifyTopChange) h.onTopContextChanged?.(ctx);
    }

    function scheduleHierarchyRefresh() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => refreshHierarchy(true), 120);
    }

    function modelFor(name, content) {
        let m = models.get(name);
        if (!m) {
            m = monaco.editor.createModel(
                content ?? "",
                languageForFile(name),
                monaco.Uri.parse(`inmemory://project/${encodeURIComponent(name)}`),
            );
            m.updateOptions({ tabSize: 4 });
            m.onDidChangeContent(() => {
                if (suppressModify) return;
                hasUserProject = true;
                scheduleHierarchyRefresh();
            });
            models.set(name, m);
        } else if (typeof content === "string" && m.getValue() !== content) {
            m.setValue(content);
        }
        return m;
    }

    function renderTabs(ctx = getTopContext()) {
        tabsEl.innerHTML = "";
        tabsEl.classList.toggle("hidden", !files.length);
        files.forEach((f, i) => {
            const isTop = f.name === ctx.topFile;
            const hdl = isHdl(f.name);
            const isPinnedHere = pinnedTop?.fileName === f.name;
            const tab = document.createElement("div");
            tab.className = `ep-tab ${i === activeFile ? "active" : ""}`;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-selected", String(i === activeFile));
            tab.title = isTop ? `${f.name} (Top-Level)` : f.name;
            tab.innerHTML = `
                <button type="button" class="ep-tab-main" data-i="${i}">
                    <span class="ep-tab-lang">${langBadge(f.name)}</span>
                    <span class="ep-tab-name">${escHtml(f.name)}</span>
                    ${isTop ? `<span class="ep-tab-top" title="Top-Level">TOP</span>` : ""}
                </button>
                ${hdl ? `<button type="button" class="ep-tab-settop ${isPinnedHere ? "pinned" : ""}" data-set-top="${i}" title="${isPinnedHere ? "Pinned as Top-Level (click to unpin)" : "Set as Top-Level"}" aria-label="Set as Top-Level">${isPinnedHere ? "★" : "☆"}</button>` : ""}
                <button type="button" class="ep-tab-del" data-del="${i}" title="Delete ${escHtml(f.name)}" aria-label="Delete ${escHtml(f.name)}">×</button>
            `;
            tab.querySelector(".ep-tab-main").addEventListener("click", () => selectFile(i));
            tab.querySelector("[data-set-top]")?.addEventListener("click", (e) => {
                e.stopPropagation();
                if (pinnedTop?.fileName === f.name) {
                    pinnedTop = null;
                    h.log?.("Top-level now follows the active file", "info");
                } else {
                    const ents = parseEntitiesWithPorts(models.get(f.name)?.getValue() ?? f.content, f.name);
                    const ent = ents[0]?.name || "";
                    pinnedTop = { fileName: f.name, entityName: ent };
                    h.log?.(`Set top-level to ${ent || f.name} (${f.name})`, "cmd");
                }
                refreshHierarchy(true);
            });
            tab.querySelector(".ep-tab-del").addEventListener("click", (e) => {
                e.stopPropagation();
                deleteFileAt(i);
            });
            tabsEl.appendChild(tab);
        });
    }

    function langBadge(name) {
        const l = languageForFile(name);
        if (l === "c4-vhdl") return "VHD";
        if (l === "c4-verilog") return "VLG";
        if (l === "c4-qsf") return "QSF";
        return "DAT";
    }

    function syncEmptyState() {
        const isEmpty = files.length === 0;
        editorHost.classList.toggle("hidden", isEmpty);
        emptyEl.classList.toggle("hidden", !isEmpty);
    }

    function selectFile(i) {
        if (!files.length) {
            activeFile = -1;
            syncEmptyState();
            refreshHierarchy(true);
            return;
        }
        if (i < 0 || i >= files.length) return;
        const changed = activeFile !== i;
        activeFile = i;
        syncEmptyState();
        const f = files[i];
        editor.setModel(modelFor(f.name, f.content));
        refreshHierarchy(changed && !pinnedTop);
    }

    function setFiles(next, keepActive = true, { userAction = false } = {}) {
        const list = Array.isArray(next) ? next : [];
        const names = new Set(list.map((f) => f.name));
        for (const [name, m] of models) {
            if (!names.has(name)) {
                m.dispose();
                models.delete(name);
            }
        }
        files = list.map((f) => ({ ...f }));
        suppressModify = true;
        try {
            for (const f of files) modelFor(f.name, f.content);
        } finally {
            suppressModify = false;
        }
        hasUserProject = Boolean(userAction);
        if (!userAction) pinnedTop = null;

        if (!files.length) {
            activeFile = -1;
            syncEmptyState();
            refreshHierarchy(true);
            h.onFilesChanged?.(files);
            return;
        }
        const curIdx = keepActive ? Math.min(Math.max(activeFile, 0), files.length - 1) : 0;
        activeFile = -1;
        selectFile(curIdx);
        h.onFilesChanged?.(files);
    }

    function nextUntitledName(ext) {
        const existing = new Set(files.map((f) => f.name.toLowerCase()));
        let idx = 1;
        while (true) {
            const stem = idx === 1 ? "untitled" : `untitled${idx}`;
            const candidate = `${stem}${ext}`;
            if (!existing.has(candidate.toLowerCase())) return { fileName: candidate, modName: stem };
            idx += 1;
        }
    }

    function addNewSourceFile(kind = "vhd") {
        const ext = kind === "v" ? ".v" : ".vhd";
        const { fileName, modName } = nextUntitledName(ext);
        const content = kind === "v" ? verilogSkeleton(modName) : vhdlSkeleton(modName);
        const cur = snapshotFiles();
        const next = [...cur, { name: fileName, content }];
        setFiles(next, false, { userAction: true });
        const idx = files.findIndex((f) => f.name === fileName);
        if (idx >= 0) selectFile(idx);
        h.log?.(`Created ${fileName} (${kind === "v" ? "module" : "entity"} ${modName})`, "ok");
    }

    function deleteFileAt(index) {
        if (index < 0 || index >= files.length) return;
        const cur = snapshotFiles();
        const removed = cur[index];
        const prevPinned = pinnedTop ? { ...pinnedTop } : null;
        const prevActive = activeFile;

        if (pinnedTop?.fileName === removed.name) {
            pinnedTop = null;
        }

        const remaining = cur.filter((_, i) => i !== index);
        const nearest = remaining.length
            ? (index === activeFile
                ? Math.min(index, remaining.length - 1)
                : (index < activeFile ? activeFile - 1 : activeFile))
            : -1;

        lastUndo = { removed, index, prevActive, prevPinned };
        setFiles(remaining, false, { userAction: true });
        if (nearest >= 0) selectFile(nearest);

        toast(`Deleted ${removed.name}`, {
            kind: "info",
            timeout: 6500,
            action: {
                label: "Undo",
                onClick: () => {
                    if (!lastUndo) return;
                    const snap = snapshotFiles();
                    if (!snap.some((f) => f.name === lastUndo.removed.name)) {
                        snap.splice(Math.min(lastUndo.index, snap.length), 0, lastUndo.removed);
                    }
                    pinnedTop = lastUndo.prevPinned;
                    setFiles(snap, false, { userAction: true });
                    const rIdx = files.findIndex((f) => f.name === lastUndo.removed.name);
                    if (rIdx >= 0) selectFile(rIdx);
                    lastUndo = null;
                },
            },
        });
        h.log?.(`Deleted ${removed.name}`, "info");
    }

    function openRenameDialog() {
        const f = files[activeFile];
        if (!f) return;
        const body = document.createElement("div");
        body.innerHTML = `
            <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
                <span>New file name (<code>.vhd</code> or <code>.v</code>):</span>
                <input type="text" id="ep-rename-inp" value="${escHtml(f.name)}" spellcheck="false">
            </label>
        `;
        const inp = body.querySelector("#ep-rename-inp");
        const applyRename = () => {
            const name = inp.value.trim();
            if (!name || name === f.name) return;
            if (!ALLOWED.some((ext) => name.toLowerCase().endsWith(ext))) {
                toast(`Allowed file types: ${ALLOWED.join(" ")}`, { kind: "error" });
                return;
            }
            if (files.some((x) => x.name !== f.name && x.name.toLowerCase() === name.toLowerCase())) {
                toast("A file with that name already exists", { kind: "error" });
                return;
            }
            const cur = snapshotFiles();
            if (pinnedTop?.fileName === f.name) pinnedTop.fileName = name;
            const old = models.get(f.name);
            const next = cur.map((x) => (x.name === f.name ? { ...x, name } : x));
            if (old) { models.delete(f.name); old.dispose(); }
            setFiles(next, true, { userAction: true });
        };
        const close = dialog({
            title: "Rename file",
            body,
            actions: [
                { label: "Cancel" },
                { label: "Rename", kind: "primary", onClick: applyRename },
            ],
        });
        setTimeout(() => { inp.focus(); inp.select(); }, 20);
        inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); applyRename(); close(); }
        });
    }

    // ------------------------------------------------------------- upload --
    function addFiles(fileList) {
        const incoming = Array.from(fileList || []);
        const rejected = [];
        const added = [];
        let pending = incoming.length;
        if (!pending) return;
        for (const file of incoming) {
            const lower = file.name.toLowerCase();
            if (!ALLOWED.some((ext) => lower.endsWith(ext))) {
                rejected.push(file.name);
                pending -= 1;
                continue;
            }
            const reader = new FileReader();
            reader.onload = () => {
                added.push({ name: file.name, content: String(reader.result || "") });
                pending -= 1;
                if (pending === 0) finishAdd();
            };
            reader.onerror = () => {
                pending -= 1;
                if (pending === 0) finishAdd();
            };
            reader.readAsText(file);
        }
        function finishAdd() {
            if (rejected.length) {
                toast(`Unsupported file type: ${rejected.join(", ")} — allowed: ${ALLOWED.join(" ")}`, { kind: "error", timeout: 5200 });
                h.log?.(`Rejected upload: ${rejected.join(", ")}`, "warn");
            }
            if (!added.length) return;
            const qsfFile = added.find((a) => /\.qsf$/i.test(a.name));
            const hdlsAdded = added.filter((a) => !/\.qsf$/i.test(a.name));

            const isUntouchedDefault = !hasUserProject && files.length <= 1;
            if (isUntouchedDefault && hdlsAdded.length >= 1) {
                setFiles(hdlsAdded, false, { userAction: true });
            } else if (hdlsAdded.length) {
                const cur = snapshotFiles();
                const merged = cur.filter((f) => !hdlsAdded.some((a) => a.name === f.name));
                merged.push(...hdlsAdded);
                setFiles(merged, false, { userAction: true });
                const idx = files.findIndex((f) => f.name === hdlsAdded[0].name);
                if (idx >= 0) selectFile(idx);
            }
            if (qsfFile) {
                h.onQsfUploaded?.(qsfFile.content, qsfFile.name);
            }
            h.log?.(`Added ${added.length} file(s): ${added.map((a) => a.name).join(", ")}`, "ok");
            h.onFilesUploaded?.(added, files);
        }
    }

    root.querySelector("#ep-file").addEventListener("change", (e) => {
        addFiles(e.target.files);
        e.target.value = "";
    });

    const dropZone = root.querySelector("#ep-drop");
    const dropHint = root.querySelector("#ep-drop-hint");
    ["dragenter", "dragover"].forEach((ev) => dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
        dropHint.classList.remove("hidden");
    }));
    dropZone.addEventListener("dragleave", (e) => {
        if (!dropZone.contains(e.relatedTarget)) {
            dropZone.classList.remove("dragover");
            dropHint.classList.add("hidden");
        }
    });
    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        dropHint.classList.add("hidden");
        addFiles(e.dataTransfer?.files);
    });

    // ------------------------------------------------------- collapse & acts --
    function setCollapsed(collapsed) {
        root.classList.toggle("collapsed", collapsed);
        if (collapseBtn) {
            const label = collapsed ? "Expand panel" : "Collapse panel";
            collapseBtn.title = label;
            collapseBtn.setAttribute("aria-label", label);
        }
        h.onCollapsed?.(collapsed);
    }

    function expand() {
        setCollapsed(false);
    }

    // Collapsible Quartus-style Messages panel (summary stays visible).
    function setMessagesCollapsed(collapsed) {
        if (!msgPanel) return;
        msgPanel.classList.toggle("collapsed", collapsed);
        if (msgToggle) {
            const label = collapsed ? "Expand messages" : "Collapse messages";
            msgToggle.title = label;
            msgToggle.setAttribute("aria-label", label);
            msgToggle.setAttribute("aria-expanded", String(!collapsed));
        }
        try { localStorage.setItem("c4_msgs_collapsed", collapsed ? "1" : "0"); } catch { /* ignore */ }
    }

    // Drag handle on the sidebar's left edge: resizes the 3D viewport column.
    const resizer = root.querySelector(".ep-resizer");
    if (resizer) {
        let drag = null;
        const applyWidth = (px, persist) => {
            const w = Math.min(900, Math.max(340, Math.round(px)));
            document.documentElement.style.setProperty("--right-w", `${w}px`);
            if (persist) {
                try { localStorage.setItem("c4_right_w", String(w)); } catch { /* ignore */ }
            }
            h.onResized?.();
        };
        resizer.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            drag = { x: e.clientX, w: root.getBoundingClientRect().width };
            try { resizer.setPointerCapture(e.pointerId); } catch { /* ignore */ }
            document.body.classList.add("resizing");
        });
        resizer.addEventListener("pointermove", (e) => {
            if (!drag) return;
            applyWidth(drag.w - (e.clientX - drag.x), false);
        });
        const endDrag = (e) => {
            if (!drag) return;
            const w = drag.w - (e.clientX - drag.x);
            drag = null;
            document.body.classList.remove("resizing");
            try { resizer.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            applyWidth(Number.isFinite(w) ? w : root.getBoundingClientRect().width, true);
        };
        resizer.addEventListener("pointerup", endDrag);
        resizer.addEventListener("pointercancel", endDrag);
        try {
            const saved = parseInt(localStorage.getItem("c4_right_w"), 10);
            if (Number.isFinite(saved)) applyWidth(saved, false);
        } catch { /* ignore */ }
    }
    try {
        if (localStorage.getItem("c4_msgs_collapsed") === "1") setMessagesCollapsed(true);
    } catch { /* ignore */ }

    root.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn) {
            if (root.classList.contains("collapsed") && e.target.closest(".ep-head")) expand();
            return;
        }
        switch (btn.dataset.act) {
            case "add-vhd": addNewSourceFile("vhd"); break;
            case "add-v": addNewSourceFile("v"); break;
            case "upload": root.querySelector("#ep-file").click(); break;
            case "rename": openRenameDialog(); break;
            case "delete": deleteFileAt(activeFile); break;
            case "zip": downloadZip(); break;
            case "fontup": setFontSize(fontSize + 1); break;
            case "fontdown": setFontSize(fontSize - 1); break;
            case "find": editor.getAction("editor.action.startFindReplaceAction")?.run(); break;
            case "collapse":
                if (document.body.classList.contains("drawer-right")) {
                    document.body.classList.remove("drawer-right");
                    document.getElementById("drawer-backdrop")?.setAttribute("hidden", "");
                    setCollapsed(false);
                } else {
                    setCollapsed(!root.classList.contains("collapsed"));
                }
                break;
            case "toggle-msgs":
                setMessagesCollapsed(!msgPanel.classList.contains("collapsed"));
                break;
            default: break;
        }
    });

    async function downloadZip() {
        if (!files.length) return;
        const zip = new JSZip();
        for (const f of files) zip.file(f.name, modelFor(f.name).getValue());
        const blob = await zip.generateAsync({ type: "blob" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "cyclone4-project.zip";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        h.log?.(`Exported ${files.length} file(s) to cyclone4-project.zip`, "ok");
    }

    function setFontSize(px) {
        fontSize = Math.max(9, Math.min(28, px));
        editor.updateOptions({ fontSize });
        const label = root.querySelector("#ep-fontsize");
        if (label) label.textContent = `${fontSize}px`;
    }

    // --------------------------------------------------------- messages ----
    function renderMessages() {
        const listEl = root.querySelector("#ep-msg-list");
        const visible = messagesList.filter((m) => msgFilter === "all" || m.sev === msgFilter);
        if (!visible.length) {
            listEl.innerHTML = `<div class="ep-msg-empty">${messagesList.length ? "No messages match filter." : "No messages."}</div>`;
            return;
        }
        listEl.innerHTML = visible.map((m, i) => {
            const loc = m.file ? `${escHtml(m.file)}${m.line ? ":" + m.line : ""}` : "";
            const cls = m.sev === "error" ? "err" : m.sev === "warning" ? "warn" : "info";
            return `
                <button type="button" class="ep-msg-row ep-msg-${cls}" data-idx="${i}" ${m.file ? "" : 'data-noloc="1"'}>
                    <span class="ep-msg-badge">${cls.toUpperCase()}</span>
                    <span class="ep-msg-text">${escHtml(m.message)}</span>
                    ${loc ? `<span class="ep-msg-loc">${loc}</span>` : ""}
                </button>`;
        }).join("");
        listEl.querySelectorAll(".ep-msg-row").forEach((row) => {
            const item = visible[Number(row.dataset.idx)];
            if (!item?.file) return;
            row.addEventListener("click", () => openFile(item.file, item.line, item.column));
        });
    }

    function setMessages(summaryText, items = []) {
        const sumEl = root.querySelector("#ep-msg-summary");
        if (sumEl) sumEl.textContent = summaryText || "";
        messagesList = (items || []).map((m) => {
            const raw = String(m.severity || "info").toLowerCase();
            const sev = /err/.test(raw) ? "error" : /warn/.test(raw) ? "warning" : "info";
            return { sev, message: m.message || String(m), file: m.file || "", line: m.line || 0, column: m.column || 1 };
        });
        renderMessages();
    }

    root.querySelectorAll(".ep-mf").forEach((btn) => {
        btn.addEventListener("click", () => {
            msgFilter = btn.dataset.filter;
            root.querySelectorAll(".ep-mf").forEach((b) => b.classList.toggle("active", b === btn));
            renderMessages();
        });
    });

    // --------------------------------------------------------- run setup ---
    const DEFAULT_SETUP = {
        // 50 MHz board clock: 1,310,920 ns / 20 ns = 65,546 cycles, the same
        // cycle window as before (so cycle-indexed tests/expectations hold),
        // but at the hardware-correct timebase. Long enough for one full
        // 800 Hz buzz1 period (1.25 ms) to be measured.
        duration: 1_310_920,
        clockPeriod: 20,
        resetCycles: 2,
        resetActiveLow: true,
    };

    function readSetup() {
        return { ...DEFAULT_SETUP };
    }

    const stimConfig = new Map();
    function defaultInputVal(portName, width = 1) {
        // Feature round 2 §4: active-low keys & switches default open -> logic 1
        // (btn1/btn2 included — buzz1.vhd uses those names).
        const isKeyOrSw = /^(?:key|sw|switch|btn|dip|ckey)[_]?\d+$|^(?:[sk][1-4])$|^(?:nrst|reset_?n)/i.test(portName || "");
        if (isKeyOrSw) return String((1 << Math.min(width, 16)) - 1);
        return "0";
    }

    function getConfig(port, width = 1) {
        if (!stimConfig.has(port)) {
            stimConfig.set(port, { kind: "constant", value: defaultInputVal(port, width), period: "1" });
        }
        return stimConfig.get(port);
    }

    function getStimulusValue(port) {
        const p = entity?.ports?.find((x) => x.name === port);
        const cfg = getConfig(port, p?.width || 1);
        const raw = String(cfg?.value ?? "0").trim();
        if (/^0x[0-9a-f]+$/i.test(raw)) return parseInt(raw.slice(2), 16);
        if (/^0b[01]+$/i.test(raw)) return parseInt(raw.slice(2), 2);
        const n = Number(raw);
        return Number.isFinite(n) ? Math.trunc(n) : 0;
    }

    function setStimulusValue(port, value) {
        const p = entity?.ports?.find((x) => x.name === port);
        const cfg = getConfig(port, p?.width || 1);
        cfg.kind = "constant";
        cfg.value = String(value);
    }

    // One press followed by a permanent release. Used when a key is released so
    // the design sees the edge that starts its own countdown (buzz1: 1 s).
    function setStimulusPulseOnce(port, holdCycles = 1) {
        const p = entity?.ports?.find((x) => x.name === port);
        const cfg = getConfig(port, p?.width || 1);
        const first = getStimulusValue(port) & 1;
        cfg.kind = "pulse_once";
        cfg.values = [first, first ? 0 : 1];
        cfg.value = String(first);
        cfg.holdCycles = Math.max(1, holdCycles | 0);
    }

    function buildStimuli(clockPort, resetPort) {
        const out = [];
        for (const [port, cfg] of stimConfig) {
            if (port === clockPort || port === resetPort) continue;
            const p = entity?.ports?.find((x) => x.name === port);
            if (!p || p.direction !== "in") continue;
            const width = p?.width || 1;
            const parse = (text) => {
                const raw = String(text ?? "").trim();
                if (width === 1) return /^1|true/i.test(raw) ? 1 : 0;
                if (/^0x[0-9a-f]+$/i.test(raw)) return parseInt(raw.slice(2), 16);
                if (/^0b[01]+$/i.test(raw)) return parseInt(raw.slice(2), 2);
                const n = Number(raw);
                return Number.isFinite(n) ? Math.trunc(n) : 0;
            };
            const seq = Array.isArray(cfg.values) && cfg.values.length
                ? cfg.values.map(parse)
                : String(cfg.value).split(",").map((s) => parse(s)).filter((v) => Number.isFinite(v));
            out.push({
                port,
                kind: cfg.kind,
                value: parse(cfg.value),
                values: cfg.kind === "sequence" || cfg.kind === "pulse_once" ? seq : [],
                periodCycles: Math.max(1, parseInt(cfg.period, 10) || 1),
                pulseCycles: Math.max(1, parseInt(cfg.period, 10) || 1),
                holdCycles: Math.max(1, parseInt(cfg.holdCycles, 10) || 1),
            });
        }
        return out;
    }

    // -------------------------------------------------------------- run ----
    function setRunState(running, paused = false) {
        const btn = root.querySelector("#ep-run");
        btn.classList.toggle("running", running && !paused);
        btn.querySelector("span").textContent = running && !paused ? "Compiling\u2026" : "Compile";
    }

    function setEntity(e) {
        entity = e;
        if (e) for (const port of e.ports) {
            if (port.direction === "in") getConfig(port.name, port.width || 1);
        }
        refreshHierarchy(false);
    }

    function setProblems(problems) {
        for (const [, model] of models) monaco.editor.setModelMarkers(model, "compile", []);
        const byFile = new Map();
        for (const p of problems) {
            const file = p.file || files[activeFile]?.name || files[0]?.name;
            if (!file || !models.has(file)) continue;
            if (!byFile.has(file)) byFile.set(file, []);
            byFile.get(file).push(p);
        }
        for (const [file, list] of byFile) {
            const model = models.get(file);
            if (!model) continue;
            monaco.editor.setModelMarkers(model, "compile", list.map((p) => {
                const line = Math.min(Math.max(1, p.line || 1), model.getLineCount());
                const col = Math.max(1, p.column || 1);
                const lineLen = model.getLineMaxColumn(line);
                return {
                    startLineNumber: line,
                    startColumn: Math.min(col, lineLen),
                    endLineNumber: line,
                    endColumn: Math.max(Math.min(col + 1, lineLen + 1), Math.min(col, lineLen) + 1),
                    message: p.message || String(p),
                    severity: /warn/i.test(p.severity || "")
                        ? monaco.MarkerSeverity.Warning
                        : monaco.MarkerSeverity.Error,
                };
            }));
        }
    }

    function setTheme(dark) {
        monaco.editor.setTheme(dark ? "c4-dark" : "c4-light");
    }

    function setDevice(key) {
        root.querySelector("#ep-device").value = key;
    }

    root.querySelector("#ep-device").addEventListener("change", (e) => {
        h.onDevice?.(e.target.value);
    });
    root.querySelector("#ep-run").addEventListener("click", () => h.onRun?.());

    function openFile(name, line, col) {
        const i = files.findIndex((f) => f.name === name);
        if (i >= 0) selectFile(i);
        if (line && files.length) {
            editor.revealLineInCenter(line);
            editor.setPosition({ lineNumber: line, column: Math.max(1, col || 1) });
            editor.focus();
        }
    }

    setFiles([{ name: "counter.vhd", content: h.initialSource || "" }], false);

    return {
        root, editor,
        setFiles, selectFile, openFile,
        addNewSourceFile, deleteFileAt,
        getFiles: snapshotFiles,
        getActiveFile: () => files[activeFile]?.name || "",
        resolveCompilePlan,
        getTopContext,
        setPinnedTop: (fileName, entityName = "") => {
            pinnedTop = fileName ? { fileName, entityName } : null;
            refreshHierarchy(true);
        },
        getTopEntity: () => getTopContext().topEntity,
        setTopEntity: () => refreshHierarchy(false),
        setEntity, setProblems, setMessages,
        setRunState, setTheme, setDevice,
        readSetup, buildStimuli, getStimulusValue, setStimulusValue,
        setStimulusPulseOnce,
        setCollapsed, expand,
    };
}
