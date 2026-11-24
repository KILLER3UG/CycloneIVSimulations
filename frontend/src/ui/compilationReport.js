// compilationReport.js — Exact Quartus Prime Standard Edition Compilation Report view.

import { icon } from "./icons.js";

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
}

const TOC_ITEMS = [
    { id: "flow", label: "Flow Summary", icon: "qRepTable" },
    { id: "flowSettings", label: "Flow Settings", icon: "qRepTable" },
    { id: "flowNonDefault", label: "Flow Non-Default Global Settings", icon: "qRepTable" },
    { id: "elapsed", label: "Flow Elapsed Time", icon: "qRepTable" },
    { id: "flowOs", label: "Flow OS Summary", icon: "qRepTable" },
    { id: "flowLog", label: "Flow Log", icon: "qRepDoc" },
    { id: "analysis", label: "Analysis & Synthesis", icon: "qRepFolder", folder: true },
    { id: "fitter", label: "Fitter", icon: "qRepFolder", folder: true },
    { id: "assembler", label: "Assembler", icon: "qRepFolder", folder: true },
    { id: "timing", label: "Timing Analyzer", icon: "qRepFolder", folder: true, timing: true },
    { id: "eda", label: "EDA Netlist Writer", icon: "qRepFolder", folder: true },
    { id: "messages", label: "Flow Messages", icon: "qInfo" },
    { id: "suppressed", label: "Flow Suppressed Messages", icon: "qInfo" },
];

export function createCompilationReportView(root) {
    root.classList.add("creport-root");
    root.innerHTML = `
        <div class="cr-split">
            <aside class="cr-toc" aria-label="Report Table of Contents">
                <div class="cr-toc-head">Table of Contents</div>
                <div class="cr-toc-list" id="cr-toc-list">
                    ${TOC_ITEMS.map((it, idx) => `
                        <button type="button" class="cr-toc-item ${idx === 0 ? "active" : ""}" data-sec="${it.id}">
                            <span class="cr-toc-caret">${it.folder ? "&#9656;" : ""}</span>
                            <span class="cr-toc-ico">${icon(it.icon)}</span>
                            <span class="cr-toc-label">${it.label}</span>
                        </button>`).join("")}
                </div>
            </aside>
            <div class="cr-main">
                <div class="cr-banner" id="cr-banner">Flow Summary</div>
                <div class="cr-filter-bar">
                    <span class="cr-filter-ico" aria-hidden="true">${icon("search")}</span>
                    <input type="text" id="cr-filter-input" class="cr-filter-input" placeholder="<<Filter>>" aria-label="Filter report">
                </div>
                <div class="cr-body" id="cr-body">
                    <div class="cr-empty">Compile a design (Ctrl+L) to generate the Compilation Report.</div>
                </div>
            </div>
        </div>
    `;

    let currentReport = null;
    let activeSec = "flow";
    let filterText = "";

    const bodyEl = root.querySelector("#cr-body");
    const bannerEl = root.querySelector("#cr-banner");
    const filterEl = root.querySelector("#cr-filter-input");
    const tocEl = root.querySelector("#cr-toc-list");

    function matchesQuery(row) {
        if (!filterText) return true;
        const q = filterText.toLowerCase();
        return row.some((c) => String(c ?? "").toLowerCase().includes(q));
    }

    function renderFlatKv(rows) {
        const filtered = (rows || []).filter(matchesQuery);
        if (!filtered.length) return `<div class="cr-empty">No matching rows.</div>`;
        return `
            <table class="cr-kv-table">
                <tbody>
                    ${filtered.map((r) => `
                        <tr>
                            <td class="cr-kv-k">${esc(r[0])}</td>
                            <td class="cr-kv-v">${esc(r.slice(1).join(" "))}</td>
                        </tr>`).join("")}
                </tbody>
            </table>
        `;
    }

    function renderGrid(headers, rows) {
        const filtered = (rows || []).filter(matchesQuery);
        if (!filtered.length) return `<div class="cr-empty">No matching data reported for this section.</div>`;
        return `
            <table class="cr-table">
                ${headers ? `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>` : ""}
                <tbody>
                    ${filtered.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}
                </tbody>
            </table>
        `;
    }

    function renderPre(text) {
        const lines = String(text || "").split(/\r?\n/);
        const filtered = filterText
            ? lines.filter((l) => l.toLowerCase().includes(filterText.toLowerCase()))
            : lines;
        if (!filtered.length) return `<div class="cr-empty">No log entries recorded.</div>`;
        return `<pre class="cr-raw">${esc(filtered.join("\n"))}</pre>`;
    }

    function updateTimingHighlight() {
        const timingBtn = tocEl?.querySelector('[data-sec="timing"]');
        if (!timingBtn) return;
        const hasWarn = Boolean(
            currentReport && (!currentReport.timing?.length || /not met|unconstrained|warning/i.test(currentReport.raw?.sta || "")),
        );
        timingBtn.classList.toggle("warn-red", hasWarn);
    }

    function render() {
        const meta = TOC_ITEMS.find((it) => it.id === activeSec) || TOC_ITEMS[0];
        if (bannerEl) bannerEl.textContent = meta.label;
        updateTimingHighlight();

        if (!currentReport) {
            bodyEl.innerHTML = `<div class="cr-empty">Compile a design (Ctrl+L) to generate the Compilation Report.</div>`;
            return;
        }
        const r = currentReport;
        if (activeSec === "flow") {
            const raw = r.flowSummary || [];
            const rows = raw.length > 1 ? raw.slice(1) : (r.resourceUsage || []).map((kv) => [kv.key, kv.value]);
            bodyEl.innerHTML = renderFlatKv(rows);
        } else if (activeSec === "flowSettings") {
            const raw = r.flowSettings || [];
            const rows = raw.length > 1 ? raw.slice(1) : [];
            bodyEl.innerHTML = renderFlatKv(rows);
        } else if (activeSec === "flowNonDefault") {
            const raw = r.flowNonDefault || [];
            const headers = raw.length > 1 ? raw[0] : ["Assignment Name", "Value", "Entity Name", "Section Id", "Target"];
            const rows = raw.length > 1 ? raw.slice(1) : [];
            bodyEl.innerHTML = renderGrid(headers, rows);
        } else if (activeSec === "elapsed") {
            const raw = r.elapsedTimes || [];
            const headers = raw.length > 1 ? raw[0] : ["Module", "Elapsed Time", "Peak Memory", "Peak Virtual Memory"];
            const rows = raw.length > 1 ? raw.slice(1) : [];
            bodyEl.innerHTML = renderGrid(headers, rows);
        } else if (activeSec === "flowOs") {
            const raw = r.flowOsSummary || [];
            const headers = raw.length > 1 ? raw[0] : ["Module Name", "OS Name", "OS Version", "Processor", "Host"];
            const rows = raw.length > 1 ? raw.slice(1) : [];
            bodyEl.innerHTML = renderGrid(headers, rows);
        } else if (activeSec === "flowLog") {
            bodyEl.innerHTML = renderPre(r.flowLog || r.raw?.flow || "");
        } else if (activeSec === "analysis") {
            const rows = (r.synthesisSummary || []).map((kv) => [kv.key, kv.value]);
            bodyEl.innerHTML = rows.length ? renderFlatKv(rows) : renderPre(r.raw?.map || "");
        } else if (activeSec === "fitter") {
            const rows = (r.resourceUsage || []).map((kv) => [kv.key, kv.value]);
            bodyEl.innerHTML = rows.length ? renderFlatKv(rows) : renderPre(r.raw?.fit || "");
        } else if (activeSec === "assembler") {
            const raw = r.assemblerSummary || [];
            if (Array.isArray(raw) && raw.length && Array.isArray(raw[0])) {
                bodyEl.innerHTML = renderFlatKv(raw.length > 1 ? raw.slice(1) : raw);
            } else {
                const rows = (raw || []).map((kv) => [kv.key, kv.value]);
                bodyEl.innerHTML = rows.length ? renderFlatKv(rows) : renderPre(r.raw?.asm || "");
            }
        } else if (activeSec === "timing") {
            const rows = (r.timing || []).map((kv) => [kv.key, kv.value]);
            bodyEl.innerHTML = (rows.length ? renderFlatKv(rows) : "") + (r.raw?.sta ? renderPre(r.raw.sta) : "");
        } else if (activeSec === "eda") {
            const files = (r.edaFiles || []).map((f) => [f]);
            bodyEl.innerHTML = renderGrid(["Generated Simulation Netlist Files"], files) + (r.raw?.eda ? renderPre(r.raw.eda) : "");
        } else if (activeSec === "messages") {
            bodyEl.innerHTML = renderPre(r.raw?.flow || "");
        } else if (activeSec === "suppressed") {
            bodyEl.innerHTML = `<div class="cr-empty">No suppressed messages recorded for ${esc(r.projectName)}.</div>`;
        }
    }

    tocEl?.addEventListener("click", (e) => {
        const btn = e.target.closest(".cr-toc-item");
        if (!btn) return;
        activeSec = btn.dataset.sec;
        tocEl.querySelectorAll(".cr-toc-item").forEach((b) => b.classList.toggle("active", b === btn));
        render();
    });

    filterEl?.addEventListener("input", () => {
        filterText = filterEl.value.trim();
        render();
    });

    function setReport(report) {
        currentReport = report || null;
        render();
    }

    return { setReport, root };
}
