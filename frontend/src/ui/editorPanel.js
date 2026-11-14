// editorPanel.js — right panel: project files (tabs/tree/upload/zip), Monaco
// editor with custom grammars + squiggles, run controls (progress steps, pin
// check, entity/device pickers) and the simulation setup / stimulus editor.

import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import JSZip from "jszip";
import { icon } from "./icons.js";
import { registerLanguages, languageForFile } from "./grammars.js";
import { toast } from "./toast.js";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
registerLanguages(monaco);

const ALLOWED = [".vhd", ".vhdl", ".v", ".sv", ".qsf", ".qpf", ".mif", ".hex"];
const DEVICES = [
    { key: "ep4ce6", label: "EP4CE6E22C8N" },
    { key: "ep4ce10", label: "EP4CE10E22C8N" },
];

export function createEditorPanel(root, h) {
    root.classList.add("editor-panel");
    root.innerHTML = `
        <div class="ep-resizer" aria-hidden="true" title="Drag to resize"></div>
        <div class="ep-head">
            <span class="ep-title">${icon("file")}<span>Source</span></span>
            <span class="ep-head-actions">
                <button class="icon-btn" data-act="upload" title="Upload files (.vhd .v .sv .qsf .qpf .mif .hex)">${icon("upload")}</button>
                <button class="icon-btn" data-act="new" title="New file">${icon("plus")}</button>
                <button class="icon-btn" data-act="rename" title="Rename file">${icon("pencil")}</button>
                <button class="icon-btn" data-act="delete" title="Delete file">${icon("trash")}</button>
                <button class="icon-btn" data-act="zip" title="Download all as zip">${icon("zip")}</button>
                <button class="icon-btn" data-act="collapse" title="Collapse panel">${icon("chevron")}</button>
            </span>
        </div>
        <div class="ep-tabs" id="ep-tabs" role="tablist"></div>
        <div class="ep-editor-wrap" id="ep-drop">
            <div id="ep-editor"></div>
            <div class="ep-drop-hint hidden" id="ep-drop-hint">Drop VHDL / Verilog / QSF / MIF / HEX files here</div>
        </div>
        <div class="ep-editor-tools">
            <label class="ep-tool"><input type="checkbox" id="ep-minimap"> minimap</label>
            <span class="ep-tool-group">
                <button class="icon-btn" data-act="fontdown" title="Decrease font size">${icon("zoomOut")}</button>
                <span id="ep-fontsize">13px</span>
                <button class="icon-btn" data-act="fontup" title="Increase font size">${icon("zoomIn")}</button>
            </span>
            <span class="ep-flex"></span>
            <button class="btn" data-act="find" title="Find / replace">${icon("search")}<span>Find</span></button>
        </div>
        <div class="ep-pincheck hidden" id="ep-pincheck">
            <span class="pc-icon">${icon("alert")}</span>
            <div class="pc-text">
                <b>Unknown ports: <span id="pc-list"></span></b>
                <span>These entity ports have no pin on the board profile. Assign locations in a QSF or remove them.</span>
                <label><input type="checkbox" id="pc-override"> Run anyway (override pin check)</label>
            </div>
        </div>
        <div class="ep-fields">
            <label class="ep-field">Top entity
                <input id="ep-top" list="ep-top-list" placeholder="auto" spellcheck="false">
                <datalist id="ep-top-list"></datalist>
            </label>
            <label class="ep-field">Device
                <select id="ep-device">
                    ${DEVICES.map((d) => `<option value="${d.key}">${d.label}</option>`).join("")}
                </select>
            </label>
        </div>
        <div class="ep-simsetup">
            <div class="ep-ss-head" data-toggle="simsetup">${icon("chevron")}<span>Simulation setup</span><span class="ep-ss-summary" id="ep-ss-summary"></span></div>
            <div class="ep-ss-body" id="ep-ssbody">
                <div class="ep-ss-grid">
                    <label>Duration ns<input id="ss-duration" type="number" min="1" step="10" value="1000"></label>
                    <label>Clock ns<input id="ss-clock" type="number" min="1" step="1" value="10"></label>
                    <label>Reset cycles<input id="ss-reset" type="number" min="0" step="1" value="2"></label>
                    <label class="ss-check"><input id="ss-resetlow" type="checkbox" checked> Reset active-low</label>
                </div>
                <div class="ep-stimuli" id="ep-stimuli"></div>
            </div>
        </div>
        <div class="ep-footer">
            <button class="btn btn-primary ep-run" id="ep-run" title="Compile + program + run (Ctrl+Enter)">${icon("play")}<span>Run on board</span></button>
            <button class="btn ep-stimuli-btn" id="ep-stimuli-btn" title="Configure input stimuli">Stimuli</button>
        </div>
        <input type="file" id="ep-file" multiple accept=".vhd,.vhdl,.v,.sv,.qsf,.qpf,.mif,.hex" class="hidden">
    `;

    // ------------------------------------------------------------- monaco --
    const editorHost = root.querySelector("#ep-editor");
    const editor = monaco.editor.create(editorHost, {
        value: "",
        language: "c4-vhdl",
        theme: "c4-light",
        minimap: { enabled: false },
        fontSize: 13,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderWhitespace: "selection",
        tabSize: 4,
        find: { addExtraSpaceOnTop: false, autoFindInSelection: "never" },
        lineNumbersMinChars: 3,
    });

    const models = new Map(); // name → model
    let files = [];
    let activeFile = -1;
    let fontSize = 13;
    let entity = null;

    function modelFor(name, content) {
        let m = models.get(name);
        if (!m) {
            m = monaco.editor.createModel(content ?? "", languageForFile(name), monaco.Uri.parse(`inmemory://project/${encodeURIComponent(name)}`));
            m.updateOptions({ tabSize: 4 });
            models.set(name, m);
        } else if (typeof content === "string" && m.getValue() !== content) {
            m.setValue(content);
        }
        return m;
    }

    function renderTabs() {
        const tabs = root.querySelector("#ep-tabs");
        tabs.innerHTML = "";
        files.forEach((f, i) => {
            const t = document.createElement("button");
            t.type = "button";
            t.className = `ep-tab ${i === activeFile ? "active" : ""}`;
            t.setAttribute("role", "tab");
            const dot = (models.get(f.name)?.getValue() || "").length ? "" : " empty";
            t.innerHTML = `<span class="ep-tab-lang">${langBadge(f.name)}</span>${f.name}`;
            t.title = f.name;
            t.addEventListener("click", () => selectFile(i));
            tabs.appendChild(t);
        });
    }

    function langBadge(name) {
        const l = languageForFile(name);
        if (l === "c4-vhdl") return "VHD";
        if (l === "c4-verilog") return "VLG";
        if (l === "c4-qsf") return "QSF";
        return "DAT";
    }

    function selectFile(i) {
        if (i < 0 || i >= files.length) return;
        activeFile = i;
        const f = files[i];
        editor.setModel(modelFor(f.name, f.content));
        renderTabs();
        renderTree();
    }

    function renderTree() {
        // compact tree strip under the tabs (flat project listing)
        let tree = root.querySelector("#ep-tree");
        if (!tree) {
            tree = document.createElement("div");
            tree.id = "ep-tree";
            tree.className = "ep-tree";
            root.querySelector(".ep-editor-wrap").before(tree);
        }
        tree.innerHTML = files.map((f, i) => `
            <button type="button" class="ep-tree-item ${i === activeFile ? "active" : ""}" data-i="${i}">
                ${icon("file")}<span>${f.name}</span>
            </button>`).join("");
        tree.querySelectorAll(".ep-tree-item").forEach((b) => {
            b.addEventListener("click", () => selectFile(Number(b.dataset.i)));
        });
    }

    function setFiles(next, keepActive = true) {
        // dispose removed models
        const names = new Set(next.map((f) => f.name));
        for (const [name, m] of models) {
            if (!names.has(name)) { m.dispose(); models.delete(name); }
        }
        files = next.map((f) => ({ ...f }));
        for (const f of files) modelFor(f.name, f.content);
        if (!files.length) files = [{ name: "design.vhd", content: "" }];
        const cur = files[keepActive ? Math.min(Math.max(activeFile, 0), files.length - 1) : 0];
        activeFile = files.findIndex((f) => f.name === cur.name);
        selectFile(activeFile);
        h.onFilesChanged?.(files);
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
                h.log?.(`Rejected upload (unsupported type): ${rejected.join(", ")}`, "warn");
            }
            if (!added.length) return;
            const merged = files.filter((f) => !added.some((a) => a.name === f.name));
            merged.push(...added);
            setFiles(merged, false);
            h.log?.(`Added ${added.length} file(s): ${added.map((a) => a.name).join(", ")}`, "ok");
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

    // ------------------------------------------------------- file actions --
    root.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        const modeBtn = e.target.closest("[data-mode]");
        if (modeBtn) {
            root.querySelector(".run-menu").classList.add("hidden");
            h.onRunMode?.(modeBtn.dataset.mode);
            return;
        }
        if (!btn) return;
        switch (btn.dataset.act) {
            case "upload": root.querySelector("#ep-file").click(); break;
            case "new": {
                const name = prompt("New file name:", "design2.vhd");
                if (!name) return;
                if (!ALLOWED.some((ext) => name.toLowerCase().endsWith(ext))) {
                    toast(`Allowed file types: ${ALLOWED.join(" ")}`, { kind: "error" });
                    return;
                }
                if (files.some((f) => f.name === name)) { toast("A file with that name exists", { kind: "error" }); return; }
                setFiles([...files, { name, content: "" }], false);
                break;
            }
            case "rename": {
                const f = files[activeFile];
                if (!f) return;
                const name = prompt("Rename file to:", f.name);
                if (!name || name === f.name) return;
                if (!ALLOWED.some((ext) => name.toLowerCase().endsWith(ext))) {
                    toast(`Allowed file types: ${ALLOWED.join(" ")}`, { kind: "error" });
                    return;
                }
                const old = models.get(f.name);
                const next = files.map((x) => (x === f ? { ...x, name } : x));
                if (old) { models.delete(f.name); old.dispose(); }
                setFiles(next, true);
                break;
            }
            case "delete": {
                if (files.length <= 1) { toast("Cannot delete the last file", { kind: "warn" }); return; }
                const f = files[activeFile];
                if (!confirm(`Delete ${f.name}?`)) return;
                setFiles(files.filter((x) => x !== f), false);
                h.log?.(`Deleted ${f.name}`, "info");
                break;
            }
            case "zip": downloadZip(); break;
            case "fontup": setFontSize(fontSize + 1); break;
            case "fontdown": setFontSize(fontSize - 1); break;
            case "find": editor.getAction("editor.action.startFindReplaceAction")?.run(); break;
            case "runmenu": root.querySelector(".run-menu").classList.toggle("hidden"); break;
            case "collapse":
                root.classList.toggle("collapsed");
                h.onCollapsed?.(root.classList.contains("collapsed"));
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
        root.querySelector("#ep-fontsize").textContent = `${fontSize}px`;
    }

    root.querySelector("#ep-minimap").addEventListener("change", (e) => {
        editor.updateOptions({ minimap: { enabled: e.target.checked } });
    });

    document.addEventListener("click", (e) => {
        if (!e.target.closest(".run-wrap")) root.querySelector(".run-menu").classList.add("hidden");
    });

    // expand/collapse from outside (hamburger on mobile)
    function expand() {
        root.classList.remove("collapsed");
        h.onCollapsed?.(false);
    }

    // --------------------------------------------------------- sim setup ---
    const ssBody = root.querySelector("#ep-ssbody");
    const ssSummary = root.querySelector("#ep-ss-summary");
    function updateSummary() {
        const s = readSetup();
        ssSummary.textContent = `${s.duration} ns \u00b7 ${s.clockPeriod} ns clk \u00b7 ${s.resetCycles} reset`;
    }
    for (const id of ["ss-duration", "ss-clock", "ss-reset"]) {
        root.querySelector(`#${id}`).addEventListener("input", updateSummary);
    }
    updateSummary();
    root.querySelector(".ep-ss-head").addEventListener("click", () => {
        ssBody.classList.toggle("hidden");
    });
    root.querySelector("#ep-stimuli-btn").addEventListener("click", () => {
        ssBody.classList.remove("hidden");
        root.querySelector("#ep-stimuli").scrollIntoView({ block: "nearest", behavior: "smooth" });
    });

    function readSetup() {
        return {
            duration: Math.max(1, Number(root.querySelector("#ss-duration").value) || 1000),
            clockPeriod: Math.max(1, Number(root.querySelector("#ss-clock").value) || 10),
            resetCycles: Math.max(0, parseInt(root.querySelector("#ss-reset").value, 10) || 0),
            resetActiveLow: root.querySelector("#ss-resetlow").checked,
        };
    }

    const stimConfig = new Map(); // port → {kind, value, period}
    function getConfig(port) {
        if (!stimConfig.has(port)) stimConfig.set(port, { kind: "constant", value: "0", period: "1" });
        return stimConfig.get(port);
    }

    function renderStimuli() {
        const holder = root.querySelector("#ep-stimuli");
        holder.innerHTML = "";
        if (!entity) {
            holder.innerHTML = `<div class="stim-empty">Compile a design to configure input stimuli (clock and reset are automatic).</div>`;
            return;
        }
        const inputs = entity.ports.filter((p) => p.direction === "in");
        if (!inputs.length) {
            holder.innerHTML = `<div class="stim-empty">No free inputs (clock and reset are automatic).</div>`;
            return;
        }
        holder.innerHTML = `<div class="stim-title">Stimuli</div>`;
        for (const port of inputs) {
            const cfg = getConfig(port.name);
            const row = document.createElement("div");
            row.className = "stim-row";
            row.innerHTML = `
                <span class="stim-name" title="${port.type || ""}">${port.name}</span>
                <select data-f="kind">
                    <option value="constant">constant</option>
                    <option value="toggle">toggle</option>
                    <option value="pulse">pulse</option>
                    <option value="sequence">sequence</option>
                </select>
                <input data-f="value" type="text" spellcheck="false" placeholder="${(port.width || 1) > 1 ? "0x0" : "0/1"}">
                <input data-f="period" type="number" min="1" step="1" title="period in clock cycles">
            `;
            const kind = row.querySelector('[data-f="kind"]');
            const value = row.querySelector('[data-f="value"]');
            const period = row.querySelector('[data-f="period"]');
            kind.value = cfg.kind;
            value.value = cfg.value;
            period.value = cfg.period;
            kind.addEventListener("change", () => {
                cfg.kind = kind.value;
                value.placeholder = cfg.kind === "sequence" ? "0,1,2,3" : (port.width || 1) > 1 ? "0x0" : "0/1";
            });
            value.addEventListener("input", () => { cfg.value = value.value; });
            period.addEventListener("input", () => { cfg.period = period.value; });
            holder.appendChild(row);
        }
    }

    // Numeric value of a port's current stimulus config (for the board
    // DIP/key control strip). Follows buildStimuli's parsing rules.
    function getStimulusValue(port) {
        const cfg = stimConfig.get(port);
        const raw = String(cfg?.value ?? "0").trim();
        if (/^0x[0-9a-f]+$/i.test(raw)) return parseInt(raw.slice(2), 16);
        if (/^[01]+$/.test(raw)) return parseInt(raw, 2);
        const n = Number(raw);
        return Number.isFinite(n) ? Math.trunc(n) : 0;
    }

    // Force a port's stimulus to a constant numeric value (board controls,
    // auto re-run). renderStimuli() refreshes the visible rows from configs.
    function setStimulusValue(port, value) {
        const cfg = getConfig(port);
        cfg.kind = "constant";
        cfg.value = String(value);
        renderStimuli();
    }

    function buildStimuli(clockPort, resetPort) {        const out = [];
        for (const [port, cfg] of stimConfig) {
            if (port === clockPort || port === resetPort) continue;
            const p = entity?.ports?.find((x) => x.name === port);
            const width = p?.width || 1;
            const parse = (text) => {
                const raw = String(text ?? "").trim();
                if (width === 1) return /^1|true/i.test(raw) ? 1 : 0;
                if (/^0x[0-9a-f]+$/i.test(raw)) return parseInt(raw.slice(2), 16);
                if (/^[01]+$/.test(raw)) return parseInt(raw, 2);
                const n = Number(raw);
                return Number.isFinite(n) ? Math.trunc(n) : 0;
            };
            out.push({
                port,
                kind: cfg.kind,
                value: parse(cfg.value),
                values: cfg.kind === "sequence"
                    ? String(cfg.value).split(",").map((s) => parse(s)).filter((v) => Number.isFinite(v))
                    : [],
                periodCycles: Math.max(1, parseInt(cfg.period, 10) || 1),
                pulseCycles: Math.max(1, parseInt(cfg.period, 10) || 1),
            });
        }
        return out;
    }

    // ---------------------------------------------------------- pin check --
    const pinCheckBox = root.querySelector("#ep-pincheck");
    function setPinCheck(unknown, blocked) {
        pinCheckBox.classList.toggle("hidden", !unknown.length);
        root.querySelector("#pc-list").textContent = unknown.join(", ");
        pinCheckBox.classList.toggle("blocked", blocked);
    }
    root.querySelector("#pc-override").addEventListener("change", (e) => {
        h.onPinOverride?.(e.target.checked);
    });

    // -------------------------------------------------------------- run ----
    function setRunState(running, paused = false) {
        const btn = root.querySelector("#ep-run");
        btn.classList.toggle("running", running && !paused);
        btn.querySelector("span").textContent = running && !paused ? "Running\u2026" : "Run on board";
    }

    function setEntity(e) {
        entity = e;
        const list = root.querySelector("#ep-top-list");
        list.innerHTML = e ? `<option value="${e.name}"></option>` : "";
        renderStimuli();
    }

    function setProblems(problems) {
        // markers per file model
        for (const [, model] of models) monaco.editor.setModelMarkers(model, "compile", []);
        const byFile = new Map();
        for (const p of problems) {
            const file = p.file || files[activeFile]?.name || files[0]?.name;
            if (!byFile.has(file)) byFile.set(file, []);
            byFile.get(file).push(p);
        }
        for (const [file, list] of byFile) {
            const model = models.get(file);
            if (!model) continue;
            monaco.editor.setModelMarkers(model, "compile", list.map((p) => {
                const line = Math.max(1, p.line || 1);
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
    root.querySelector("#ep-top").addEventListener("input", (e) => h.onTopEntity?.(e.target.value.trim()));

    function setTopEntity(name) { root.querySelector("#ep-top").value = name || ""; }
    function getTopEntity() { return root.querySelector("#ep-top").value.trim(); }

    // ----------------------------------------------------------- resizer --
    const resizer = root.querySelector(".ep-resizer");
    resizer.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = root.getBoundingClientRect().width;
        const move = (ev) => {
            const w = Math.max(280, Math.min(680, startW + (startX - ev.clientX)));
            document.documentElement.style.setProperty("--right-w", `${w}px`);
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            document.body.classList.remove("resizing");
        };
        document.body.classList.add("resizing");
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    });

    setFiles([{ name: "counter.vhd", content: h.initialSource || "" }], false);
    renderStimuli();

    return {
        root, editor,
        setFiles, selectFile,
        getFiles: () => files.map((f) => ({ name: f.name, content: modelFor(f.name).getValue() })),
        getActiveFile: () => files[activeFile]?.name,
        openFile: (name, line, col) => {
            const i = files.findIndex((f) => f.name === name);
            if (i >= 0) selectFile(i);
            if (line) {
                editor.revealLineInCenter(line);
                editor.setPosition({ lineNumber: line, column: Math.max(1, col || 1) });
                editor.focus();
            }
        },
        setEntity, setProblems, setPinCheck,
        setRunState, setTheme, setDevice, setTopEntity, getTopEntity,
        readSetup, buildStimuli, getStimulusValue, setStimulusValue, expand,
    };
}
