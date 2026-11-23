// compilationReport.js — Quartus Prime Compilation Report view.
// Displays Flow Summary, Resource Usage, Timing Analysis, EDA Netlist Writer,
// and Flow Elapsed Time from real Quartus .rpt/.summary outputs.

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
}

export function createCompilationReportView(root) {
    root.classList.add("creport-root");
    root.innerHTML = `
        <div class="cr-split">
            <aside class="cr-toc" aria-label="Report Table of Contents">
                <div class="cr-toc-head">Table of Contents</div>
                <div class="cr-toc-list" id="cr-toc-list">
                    <button type="button" class="cr-toc-item active" data-sec="flow">Flow Summary</button>
                    <button type="button" class="cr-toc-item" data-sec="resources">Resource Usage Summary</button>
                    <button type="button" class="cr-toc-item" data-sec="timing">Timing Analyzer Summary</button>
                    <button type="button" class="cr-toc-item" data-sec="eda">EDA Netlist Writer</button>
                    <button type="button" class="cr-toc-item" data-sec="elapsed">Flow Elapsed Time</button>
                </div>
            </aside>
            <div class="cr-body" id="cr-body">
                <div class="cr-empty">Compile a design (Ctrl+L) to generate the Compilation Report.</div>
            </div>
        </div>
    `;

    let currentReport = null;
    let activeSec = "flow";

    const bodyEl = root.querySelector("#cr-body");
    const tocEl = root.querySelector("#cr-toc-list");

    function renderTable(title, headers, rows) {
        if (!rows || !rows.length) {
            return `<h3 class="cr-sec-title">${esc(title)}</h3><div class="cr-empty">No data reported for this section.</div>`;
        }
        return `
            <h3 class="cr-sec-title">${esc(title)}</h3>
            <table class="cr-table">
                ${headers ? `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>` : ""}
                <tbody>
                    ${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}
                </tbody>
            </table>
        `;
    }

    function render() {
        if (!currentReport) {
            bodyEl.innerHTML = `<div class="cr-empty">Compile a design (Ctrl+L) to generate the Compilation Report.</div>`;
            return;
        }
        const r = currentReport;
        if (activeSec === "flow") {
            const raw = r.flowSummary || [];
            const headers = raw.length > 1 ? raw[0] : ["Item", "Value"];
            const rows = raw.length > 1 ? raw.slice(1) : (r.resourceUsage || []).map((kv) => [kv.key, kv.value]);
            bodyEl.innerHTML = renderTable(`Flow Summary (${r.projectName})`, headers, rows);
        } else if (activeSec === "resources") {
            const rows = (r.resourceUsage || []).map((kv) => [kv.key, kv.value]);
            bodyEl.innerHTML = renderTable("Fitter / Synthesis Resource Usage", ["Resource", "Usage"], rows);
        } else if (activeSec === "timing") {
            const rows = (r.timing || []).map((kv) => [kv.key, kv.value]);
            const rawSta = r.raw?.sta ? `<pre class="cr-raw">${esc(r.raw.sta)}</pre>` : "";
            bodyEl.innerHTML = renderTable("TimeQuest Timing Analyzer Summary", ["Metric", "Value"], rows) + rawSta;
        } else if (activeSec === "eda") {
            const files = (r.edaFiles || []).map((f) => [f]);
            const rawEda = r.raw?.eda ? `<pre class="cr-raw">${esc(r.raw.eda)}</pre>` : "";
            bodyEl.innerHTML = renderTable("Generated EDA Simulation Netlist Files", ["File Path"], files) + rawEda;
        } else if (activeSec === "elapsed") {
            const raw = r.elapsedTimes || [];
            const headers = raw.length > 1 ? raw[0] : ["Module", "Elapsed Time"];
            const rows = raw.length > 1 ? raw.slice(1) : [];
            bodyEl.innerHTML = renderTable("Flow Elapsed Time", headers, rows);
        }
    }

    tocEl?.addEventListener("click", (e) => {
        const btn = e.target.closest(".cr-toc-item");
        if (!btn) return;
        activeSec = btn.dataset.sec;
        tocEl.querySelectorAll(".cr-toc-item").forEach((b) => b.classList.toggle("active", b === btn));
        render();
    });

    function setReport(report) {
        currentReport = report || null;
        render();
    }

    return { setReport, root };
}
