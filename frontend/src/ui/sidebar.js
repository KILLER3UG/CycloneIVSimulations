// sidebar.js — left sidebar: collapsible header, Peripherals / Pin Planner /
// Examples tabs + search, live pin values, QSF import/export, and board specs.

import { icon } from "./icons.js";
import { dialog, toast } from "./toast.js";
import {
    IO_STANDARDS,
    buildPinCatalog,
    expandEntityNodes,
    exportPlannerToQsf,
    getEntityAssignments,
    loadPlannerStore,
    normalizePin,
    parseQsfToPlanner,
    setEntityAssignments,
    suggestBoardDefaults,
    validateAssignments,
} from "../pinPlanner.js";

const ATTACHABLE = [
    { id: "ledbar", name: "LED bar", icon: "slider", desc: "8 discrete LEDs", width: 8 },
    { id: "lcd", name: "1602 LCD", icon: "lcd", desc: "character display", width: 8 },
    { id: "servo", name: "Servo", icon: "toggle", desc: "PWM horn angle", width: 8 },
    { id: "bargraph", name: "Bargraph", icon: "activity", desc: "10-level meter", width: 10 },
];

function escHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
}

export function createSidebar(root, h) {
    root.classList.add("sidebar");
    root.innerHTML = `
        <div class="sb-head" title="Board peripherals & Pin Planner">
            <span class="sb-head-title">${icon("chip")}<span>Board</span></span>
            <button class="icon-btn" type="button" data-act="collapse-left" title="Collapse left sidebar" aria-label="Collapse left sidebar">${icon("chevron")}</button>
        </div>
        <div class="sb-search">
            <span class="sb-search-icon">${icon("search")}</span>
            <input id="sb-search" type="text" placeholder="Search components or pins" aria-label="Search components or pins">
        </div>
        <div class="sb-tabs" role="tablist">
            <button class="sb-tab active" data-tab="periph" role="tab" aria-selected="true">Peripherals</button>
            <button class="sb-tab" data-tab="pinmap" role="tab" aria-selected="false">Pin Planner</button>
            <button class="sb-tab" data-tab="examples" role="tab" aria-selected="false">Examples</button>
        </div>
        <div class="sb-body">
            <div class="sb-pane" data-pane="periph"></div>
            <div class="sb-pane hidden" data-pane="pinmap"></div>
            <div class="sb-pane hidden" data-pane="examples"></div>
        </div>
        <div class="sb-infocard hidden" id="sb-infocard"></div>
        <div class="sb-speccard" id="sb-speccard"></div>
    `;

    const collapseBtn = root.querySelector('[data-act="collapse-left"]');
    const search = root.querySelector("#sb-search");
    const panes = {
        periph: root.querySelector('[data-pane="periph"]'),
        pinmap: root.querySelector('[data-pane="pinmap"]'),
        examples: root.querySelector('[data-pane="examples"]'),
    };
    const infoCard = root.querySelector("#sb-infocard");
    const specCard = root.querySelector("#sb-speccard");
    const attached = []; // {id, def, port}
    let profile = null;
    let catalog = buildPinCatalog(null);
    let plannerStore = loadPlannerStore();
    let entity = null; // top-level entity { name, ports }
    let nodes = [];
    let assignments = {};
    let liveValues = {};
    let examples = [];

    // --------------------------------------------------------- collapse ----
    function setCollapsed(collapsed) {
        root.classList.toggle("collapsed", collapsed);
        if (collapseBtn) {
            const label = collapsed ? "Expand left sidebar" : "Collapse left sidebar";
            collapseBtn.title = label;
            collapseBtn.setAttribute("aria-label", label);
        }
        h.onCollapsed?.(collapsed);
    }

    function expand() {
        setCollapsed(false);
    }

    root.querySelector(".sb-head").addEventListener("click", (e) => {
        const btn = e.target.closest('[data-act="collapse-left"]');
        if (btn) {
            if (document.body.classList.contains("drawer-left")) {
                document.body.classList.remove("drawer-left");
                document.getElementById("drawer-backdrop")?.setAttribute("hidden", "");
                setCollapsed(false);
            } else {
                setCollapsed(!root.classList.contains("collapsed"));
            }
            return;
        }
        if (root.classList.contains("collapsed")) expand();
    });

    // ------------------------------------------------------------- search --
    function applySearch() {
        const q = search.value.trim().toLowerCase();
        root.querySelectorAll(".sb-item").forEach((el) => {
            const hay = (el.dataset.search || "").toLowerCase();
            el.classList.toggle("hidden", !!q && !hay.includes(q));
        });
        root.querySelectorAll(".sb-group").forEach((g) => {
            const any = g.querySelector(".sb-item:not(.hidden)");
            g.classList.toggle("hidden", !any && !g.dataset.always);
        });
        root.querySelectorAll(".pin-row").forEach((tr) => {
            const hay = (tr.dataset.search || "").toLowerCase();
            tr.classList.toggle("hidden", !!q && !hay.includes(q));
        });
    }
    search.addEventListener("input", applySearch);

    function showTab(key) {
        root.querySelectorAll(".sb-tab").forEach((t) => {
            const on = t.dataset.tab === key;
            t.classList.toggle("active", on);
            t.setAttribute("aria-selected", String(on));
        });
        for (const [k, pane] of Object.entries(panes)) {
            pane.classList.toggle("hidden", k !== key);
        }
    }

    root.querySelector(".sb-tabs").addEventListener("click", (e) => {
        const tab = e.target.closest(".sb-tab");
        if (tab) showTab(tab.dataset.tab);
    });

    // -------------------------------------------------------- peripherals --
    function group(title, iconName, items, always = false) {
        const g = document.createElement("div");
        g.className = "sb-group";
        if (always) g.dataset.always = "1";
        g.innerHTML = `<div class="sb-group-title">${icon(iconName)}<span>${title}</span></div>`;
        for (const it of items) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sb-item";
            btn.dataset.search = `${it.name} ${it.desc || ""} ${it.id || ""}`;
            btn.innerHTML = `<span class="sb-item-icon">${icon(it.icon || "chip")}</span>
                <span class="sb-item-text"><span class="sb-item-name">${it.name}</span>
                ${it.desc ? `<span class="sb-item-desc">${it.desc}</span>` : ""}</span>`;
            btn.addEventListener("click", () => {
                root.querySelectorAll(".sb-item.selected").forEach((s) => s.classList.remove("selected"));
                btn.classList.add("selected");
                if (it.focus !== false && it.id) h.onFocus?.(it.id);
                it.onSelect?.();
            });
            g.appendChild(btn);
        }
        return g;
    }

    function renderPeripherals() {
        const p = panes.periph;
        p.innerHTML = "";
        const b = profile?.board || {};
        const dev = profile?.device || {};

        p.appendChild(group("FPGA", "chip", [
            {
                id: "U5", name: b.fpga || dev.part || "EP4CE6E22C8N",
                desc: `${dev.package || "EQFP-144"} · ${dev.logicElements ? dev.logicElements.toLocaleString() + " LE" : "Cyclone IV E"}`,
                icon: "chip", onSelect: () => showInfo(fpgaInfo()),
            },
        ], true));

        p.appendChild(group("Clock / reset", "activity", [
            { id: "X1", name: "50 MHz oscillator", desc: b.clockPin ? `X1 · ${b.clockPin}` : "X1 · 50 MHz", icon: "activity", onSelect: () => showInfo(clockInfo()) },
            { id: "RESET", name: "RESET key", desc: b.resetPin ? `${b.resetPin} · active-${b.resetActiveLow === false ? "high" : "low"}` : "RESET · active-low", icon: "reset", onSelect: () => showInfo(resetInfo()) },
        ], true));

        p.appendChild(group("User I/O", "toggle", [
            { id: "LED1", name: "LED1–LED4", desc: b.leds ? `${b.leds.count} × red · ${b.leds.activeLow ? "active-low" : "active-high"}` : "4 red LEDs", icon: "slider", onSelect: () => showInfo(ledsInfo()) },
            { id: "S1", name: "Keys KEY1–KEY4", desc: b.buttons ? `${b.buttons.count} tact · ${b.buttons.activeLow ? "active-low" : "active-high"}` : "4 tact keys", icon: "toggle", onSelect: () => showInfo(buttonsInfo()) },
            { id: "SW2", name: "DIP switch SW2", desc: b.switches ? `${b.switches.count}-pos · shares KEY nets` : "4-pos", icon: "slider", onSelect: () => showInfo(dipInfo()) },
            { id: "DISP1", name: "7-segment display", desc: b.displays?.part || "4-digit multiplexed", icon: "lcd", onSelect: () => showInfo(displayInfo()) },
            { id: "SP1", name: "Buzzer SP1", desc: b.buzzer ? `${b.buzzer.type} · ${b.buzzer.pin}` : "passive · SP1", icon: "activity", onSelect: () => showInfo(buzzerInfo()) },
        ], true));

        p.appendChild(group("Memories", "ram", [
            { id: "U6", name: "HY57V641620 SDRAM", desc: "U6 · TSOP-II 54 · 64 Mbit", icon: "ram", onSelect: () => showInfo(sdramInfo()) },
            { id: "U7", name: "EPCS16 config flash", desc: b.config?.flash || "U7 · AS serial flash", icon: "ram", onSelect: () => showInfo(flashInfo()) },
            { id: "U8", name: "AT24C08 EEPROM", desc: "U8 · I2C 0x50 · 1 KB", icon: "ram", onSelect: () => showInfo(eepromInfo()) },
        ], true));

        p.appendChild(group("Connectors", "cable", [
            { id: "J1", name: "DC power jack", desc: b.inputVoltage ? `${b.inputVoltage} input` : "5 V input", icon: "plug", onSelect: () => showInfo(powerInfo()) },
            { id: "USB", name: "USB / UART", desc: b.uart?.transceiver || "MAX3232E · DB9", icon: "cable", onSelect: () => showInfo(uartInfo()) },
            { id: "VGA", name: "VGA DB15", desc: b.vga ? `${b.vga.colors} colours · 1-bit RGB` : "8 colours", icon: "monitor", onSelect: () => showInfo(vgaInfo()) },
            { id: "PS2", name: "PS/2 port", desc: b.ps2 ? "6-pin DIN · open-collector" : "keyboard/mouse", icon: "cable", onSelect: () => showInfo(ps2Info()) },
            { id: "JTAG", name: "JTAG header", desc: "10-pin · volatile programming", icon: "plug", onSelect: () => showInfo(jtagInfo()) },
        ], true));

        p.appendChild(group("Headers", "globe", [
            { id: "P1", name: "P1 expansion header", desc: b.headers?.P1?.size || "19×2 · 2.54 mm", icon: "globe", onSelect: () => showInfo(headerInfo("P1")) },
            { id: "P2", name: "P2 expansion header", desc: b.headers?.P2?.size || "IO header", icon: "globe", onSelect: () => showInfo(headerInfo("P2")) },
        ], true));

        const modGroup = group("Attachable modules", "plug", ATTACHABLE.map((def) => ({
            id: null, name: def.name, desc: def.desc, icon: def.icon, focus: false,
            onSelect: () => toggleAttach(def),
        })), true);
        p.appendChild(modGroup);
        renderAttachedChips();
    }

    // ---------------------------------------------------------- info cards --
    const kv = (rows) => rows.filter(Boolean).map(([k, v]) => `<div class="ic-row"><span>${k}</span><b>${v}</b></div>`).join("");
    const facts = (ids) => {
        const list = (profile?.facts || []).filter((f) => ids.includes(f.id));
        if (!list.length) return "";
        return `<div class="ic-facts">${list.map((f) => `<div class="ic-fact"><span class="tag ${/VERIFIED/.test(f.tag) ? "tag-ok" : "tag-warn"}">${f.tag}</span>${f.statement}</div>`).join("")}</div>`;
    };

    const fpgaInfo = () => ({
        title: `FPGA — ${profile?.device?.part || "EP4CE6E22C8N"}`,
        body: kv([
            ["Family", profile?.device?.family || "Cyclone IV E"],
            ["Package", profile?.device?.package || "EQFP-144"],
            ["Speed grade", profile?.device?.speedGrade || "8"],
            ["Logic elements", (profile?.device?.logicElements || 6272).toLocaleString()],
            ["M9K blocks", `${profile?.device?.m9kBlocks || 30} (${profile?.device?.m9kKbit || 270} Kbit)`],
            ["Multipliers 18×18", profile?.device?.multipliers18x18 || 15],
            ["PLLs", profile?.device?.plls || 2],
            ["User I/O", profile?.device?.userIo || 91],
            ["Core voltage", profile?.device?.coreVoltage || "1.2 V"],
        ]) + facts(["F01", "F02", "F03", "F04"]),
    });
    const clockInfo = () => ({
        title: "Clock — X1 50 MHz oscillator",
        body: kv([
            ["Frequency", `${((profile?.board?.clockHz || 50000000) / 1e6).toFixed(0)} MHz`],
            ["FPGA pin", profile?.board?.clockPin || "—"],
            ["Port alias", `${profile?.board?.clockPort || "CLOCK_50"} / FPGA_CLK / CLK`],
            ["Source", profile?.board?.clockSource || "active oscillator, 3.3 V"],
        ]) + facts(["F05"]),
    });
    const resetInfo = () => ({
        title: "Reset — RESET key",
        body: kv([
            ["FPGA pin", profile?.board?.resetPin || "—"],
            ["Polarity", profile?.board?.resetActiveLow === false ? "active-high" : "active-low (shorts to GND)"],
            ["Pull-up", profile?.board?.resetPullup || "R2 10 kΩ + C10 100 nF"],
        ]) + facts(["F06"]),
    });
    const ledsInfo = () => ({
        title: "LED1–LED4",
        body: kv([
            ["Count", profile?.board?.leds?.count || 4],
            ["Pins", (profile?.board?.leds?.pins || []).join(", ") || "—"],
            ["Polarity", profile?.board?.leds?.activeLow ? "active-low (lit = 0)" : "active-high"],
            ["Driver", profile?.board?.leds?.wiring || "anodes to 3.3 V, cathodes via 470 Ω"],
        ]) + facts(["F09"]),
    });
    const buttonsInfo = () => ({
        title: "Keys KEY1–KEY4",
        body: kv([
            ["Count", profile?.board?.buttons?.count || 4],
            ["Pins", (profile?.board?.buttons?.pins || []).join(", ") || "—"],
            ["Polarity", profile?.board?.buttons?.activeLow ? "active-low (pressed = 0, open = 1)" : "active-high"],
            ["Pull-ups", profile?.board?.buttons?.pullup || "10 kΩ to 3.3 V (R38–R41)"],
        ]) + facts(["F07", "F08"]),
    });
    const dipInfo = () => ({
        title: "DIP switch SW2",
        body: kv([
            ["Positions", profile?.board?.switches?.count || 4],
            ["Nets", "shared with KEY1–KEY4 (pins 88–91)"],
            ["ON level", `closed = ${profile?.board?.switches?.onValue ?? 0}`],
            ["Pull-up", profile?.board?.switches?.pullup || "10 kΩ (R42–R45)"],
        ]) + facts(["F08"]),
    });
    const displayInfo = () => ({
        title: "7-segment display — DISP1",
        body: kv([
            ["Part", profile?.board?.displays?.part || "4-digit common-anode, 12-pin"],
            ["Segments", `SEG[7..0] ${JSON.stringify(profile?.board?.displays?.segBitMap || {})}`],
            ["Digit select", `DIG[3..0] · ${profile?.board?.displays?.digitActiveLow ? "active-low" : "active-high"}`],
            ["Drivers", profile?.board?.displays?.digitResistors || "8550 PNP high-side"],
        ]) + facts([]),
    });
    const buzzerInfo = () => ({
        title: "Buzzer SP1",
        body: kv([
            ["Type", profile?.board?.buzzer?.type || "passive"],
            ["Pin", profile?.board?.buzzer?.pin || "—"],
            ["Polarity", profile?.board?.buzzer?.activeLow ? "active-low drive" : "active-high"],
            ["Status", profile?.board?.buzzer?.typeConfidence || "unverified on real hardware"],
        ]) + facts([]),
    });
    const sdramInfo = () => ({
        title: "SDRAM — U6 HY57V641620",
        body: kv([
            ["Organisation", `${profile?.board?.sdram?.banks || 4} banks × ${profile?.board?.sdram?.dataBits || 16} bit`],
            ["Refresh", `${profile?.board?.sdram?.refreshCycles || 4096} cycles / ${profile?.board?.sdram?.refreshMs || 64} ms`],
            ["Model", "pin map only (no timing model)"],
        ]) + facts([]),
    });
    const flashInfo = () => ({
        title: "Configuration flash — U7",
        body: kv([
            ["Part", profile?.board?.config?.flash || "EPCS16"],
            ["Size", `${((profile?.board?.config?.flashSizeBits || 16777216) / 1048576).toFixed(0)} Mbit`],
            ["Note", profile?.board?.config?.flashMarkingNote || ""],
        ]) + facts([]),
    });
    const eepromInfo = () => {
        const bus = (profile?.board?.i2c?.buses || []).find((x) => /eeprom/i.test(x.name)) || {};
        return {
            title: "EEPROM — U8 AT24C08",
            body: kv([
                ["Bus", `${bus.scl || "—"} / ${bus.sda || "—"}`],
                ["Address", `0x${(bus.device?.address || 0x50).toString(16)}`],
                ["Size", `${bus.device?.bytes || 1024} B · page ${bus.device?.pageSize || 16} B`],
                ["WP", "tied to VCC — writes blocked, reads work"],
            ]) + facts([]),
        };
    };
    const powerInfo = () => ({
        title: "Power input — J1",
        body: kv([
            ["Input", profile?.board?.inputVoltage || "5 V DC"],
            ["Rails", (profile?.board?.rails || []).map((r) => `${r.net || r.name} ${r.voltage || ""}`).join(" · ") || "3.3 V / 1.2 V"],
            ["Switch", "SW1 self-locking latching button"],
        ]) + facts([]),
    });
    const uartInfo = () => ({
        title: "UART — MAX3232E",
        body: kv([
            ["Transceiver", profile?.board?.uart?.transceiver || "MAX3232E"],
            ["Pins", `TXD ${profile?.board?.uart?.pins?.UART_TXD || "—"} · RXD ${profile?.board?.uart?.pins?.UART_RXD || "—"}`],
            ["DB9", profile?.board?.uart?.db9Note || "TX=7 RX=8 GND=5 (non-standard)"],
        ]) + facts([]),
    });
    const vgaInfo = () => ({
        title: "VGA — DB15",
        body: kv([
            ["Colour depth", `${profile?.board?.vga?.colors || 8} colours (1-bit RGB)`],
            ["Sync", `HS ${profile?.board?.vga?.pins?.VGA_HSYNC || "—"} · VS ${profile?.board?.vga?.pins?.VGA_VSYNC || "—"}`],
            ["Resistors", profile?.board?.vga?.resistors || "R/G/B 1 kΩ"],
        ]) + facts([]),
    });
    const ps2Info = () => ({
        title: "PS/2 port",
        body: kv([
            ["Connector", profile?.board?.ps2?.connector || "6-pin DIN"],
            ["Pins", `CLK ${profile?.board?.ps2?.pins?.PS_CLOCK || "—"} · DATA ${profile?.board?.ps2?.pins?.PS_DATA || "—"}`],
            ["Bus", profile?.board?.ps2?.bus || "open-collector, idle high"],
        ]) + facts([]),
    });
    const jtagInfo = () => ({
        title: "JTAG header",
        body: kv([
            ["Pins", "TCK TMS TDI TDO + VCC/GND"],
            ["Use", "volatile in-system programming"],
            ["AS flash", "separate 4-pin AS header (U7)"],
        ]) + facts([]),
    });
    const headerInfo = (id) => ({
        title: `${id} expansion header`,
        body: kv([
            ["Size", profile?.board?.headers?.[id]?.size || "2×n · 2.54 mm"],
            ["Note", profile?.board?.headers?.[id]?.note || "power rails + FPGA I/O"],
        ]) + facts([]),
    });

    function showInfo(info) {
        infoCard.classList.remove("hidden");
        infoCard.innerHTML = `<div class="ic-title">${info.title}</div>${info.body}`;
    }

    // ---------------------------------------------------------- specs card --
    // The static device-specs card was removed so the Pin Planner uses the
    // full sidebar height. Device facts live in the Peripherals tab and the
    // About dialog.
    function renderSpecsCard() {
        if (!specCard) return;
        specCard.innerHTML = "";
        specCard.classList.add("hidden");
    }

    function showAllSpecs() {
        const dev = profile?.device || {};
        const rows = [
            ["Family", dev.family], ["Part", dev.part], ["Package", dev.package],
            ["Speed grade", dev.speedGrade], ["Logic elements", (dev.logicElements || 6272).toLocaleString()],
            ["M9K blocks", `${dev.m9kBlocks || 30} (${dev.m9kKbit || 270} Kbit)`],
            ["Multipliers 18×18", dev.multipliers18x18 || 15], ["PLLs", dev.plls || 2],
            ["User I/O", dev.userIo || 91], ["I/O standard", dev.defaultIoStandard],
            ["Core voltage", dev.coreVoltage],
        ].filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `<div class="ic-row"><span>${k}</span><b>${v}</b></div>`).join("");
        const factsHtml = (profile?.facts || []).map((f) =>
            `<div class="ic-fact"><span class="tag ${/VERIFIED/.test(f.tag) ? "tag-ok" : "tag-warn"}">${f.tag}</span>${f.statement}</div>`
        ).join("");
        dialog({
            title: `Board specs — ${dev.part || "EP4CE6E22C8N"}`,
            body: `<div class="ic-title">Device</div>${rows}<div class="ic-title" style="margin-top:12px">Verified board facts</div><div class="ic-facts">${factsHtml || "<div class='bp-empty'>No facts loaded.</div>"}</div>`,
            actions: [{ label: "Close", kind: "primary" }],
            wide: true,
        });
    }

    // ------------------------------------------------------ attachables ----
    function toggleAttach(def) {
        const i = attached.findIndex((a) => a.def.id === def.id);
        if (i >= 0) {
            attached.splice(i, 1);
        } else {
            const port = pickPort(def);
            attached.push({ def, port });
            h.log?.(`Attached ${def.name}${port ? " → " + port : " (no output port — bind one below)"}`, "info");
        }
        renderAttachedChips();
        h.onAttachedChanged?.(attached);
    }

    function pickPort(def) {
        if (!entity) return "";
        const outs = entity.ports.filter((p) => p.direction !== "in");
        const pref = outs.find((p) => p.name.toLowerCase().includes(def.id === "ledbar" ? "led" : def.id));
        return pref ? pref.name : (outs[0] ? outs[0].name : "");
    }

    function renderAttachedChips() {
        let holder = panes.periph.querySelector("#sb-attached");
        if (!holder) {
            holder = document.createElement("div");
            holder.id = "sb-attached";
            holder.className = "sb-attached";
            panes.periph.appendChild(holder);
        }
        holder.innerHTML = attached.length
            ? attached.map((a, i) => `
                <div class="attach-chip" data-i="${i}">
                    <span>${a.def.name}${a.port ? " → " + a.port : ""}</span>
                    <b class="attach-val" data-id="${a.def.id}">--</b>
                    <button type="button" aria-label="Detach ${a.def.name}">×</button>
                </div>`).join("")
            : `<div class="attach-empty">No modules attached — pick one above.</div>`;
        holder.querySelectorAll(".attach-chip button").forEach((btn) => {
            btn.addEventListener("click", () => {
                attached.splice(Number(btn.closest(".attach-chip").dataset.i), 1);
                renderAttachedChips();
                h.onAttachedChanged?.(attached);
            });
        });
    }

    function updateAttached() {
        for (const a of attached) {
            const el = panes.periph.querySelector(`.attach-val[data-id="${a.def.id}"]`);
            if (!el) continue;
            const v = liveValues[a.port] ?? liveValues[String(a.port).toUpperCase()];
            const num = typeof v === "number" ? v : parseInt(String(v), 10) || 0;
            if (a.def.id === "servo") el.textContent = `${Math.round((num / 255) * 180 - 90)}°`;
            else if (a.def.id === "lcd") el.textContent = "0x" + (num & 0xff).toString(16).toUpperCase();
            else el.textContent = `${num} / ${(1 << a.def.width) - 1}`;
        }
    }

    // -------------------------------------------------------- pin planner --
    function refreshPinValidationUI() {
        const res = validateAssignments(nodes, assignments, catalog);
        const infoEl = panes.pinmap.querySelector("#pp-summary");
        if (infoEl) {
            infoEl.textContent = entity?.name
                ? `${entity.name}: ${res.assignedCount}/${nodes.length} pinned`
                : "No top-level entity";
        }
        const errByNode = new Map();
        for (const err of res.errors) {
            const m = /'([^']+)'/.exec(err.message);
            if (m) errByNode.set(m[1], err.message);
            const m2 = /and '([^']+)'/.exec(err.message);
            if (m2) errByNode.set(m2[1], err.message);
        }
        panes.pinmap.querySelectorAll(".pin-row[data-node]").forEach((tr) => {
            const nName = tr.dataset.node;
            const hasLoc = !!String(assignments[nName]?.location || "").trim();
            const errMsg = errByNode.get(nName);
            tr.classList.toggle("pp-row-err", Boolean(errMsg));
            tr.classList.toggle("pp-row-warn", !hasLoc && !errMsg);
            tr.title = errMsg || (!hasLoc ? "Unassigned — does nothing on the board" : `${nName} -> ${assignments[nName].location}`);
        });
        return res;
    }

    function persistAndNotify() {
        if (entity?.name) {
            setEntityAssignments(plannerStore, entity.name, assignments);
        }
        refreshPinValidationUI();
        updatePinValues();
        h.onPinAssignmentsChanged?.(getPinPlan());
    }

    function renderPinPlanner() {
        const p = panes.pinmap;
        p.innerHTML = "";
        catalog = buildPinCatalog(profile);

        // Top toolbar: Apply board defaults / Clear / Import .qsf / Export .qsf
        const bar = document.createElement("div");
        bar.className = "pp-bar";
        bar.innerHTML = `
            <div class="pp-bar-top">
                <span class="pp-summary" id="pp-summary">${entity?.name ? `${escHtml(entity.name)}: 0/${nodes.length} pinned` : "No top-level entity"}</span>
            </div>
            <div class="pp-actions">
                <button type="button" class="btn pp-btn" id="pp-defaults" title="Fill assignments matching known board port names">Apply board defaults</button>
                <button type="button" class="btn pp-btn" id="pp-clear" title="Clear pin assignments for this entity">Clear</button>
                <button type="button" class="btn pp-btn" id="pp-import" title="Import .qsf pin assignments">Import .qsf</button>
                <button type="button" class="btn pp-btn" id="pp-export" title="Export assignments as .qsf">Export .qsf</button>
                <input type="file" id="pp-qsf-file" accept=".qsf" class="hidden">
            </div>
            <datalist id="pp-pin-datalist">
                ${catalog.list.map((c) => `<option value="${escHtml(c.pin)}" label="${escHtml(c.pin)} — ${escHtml(c.label)}"></option>`).join("")}
            </datalist>
        `;
        p.appendChild(bar);

        bar.querySelector("#pp-defaults").addEventListener("click", () => {
            if (!nodes.length) return;
            assignments = suggestBoardDefaults(nodes, profile, assignments);
            persistAndNotify();
            renderPinPlanner();
            h.log?.(`Applied board default pins for ${entity?.name || "top entity"}`, "ok");
        });
        bar.querySelector("#pp-clear").addEventListener("click", () => {
            assignments = {};
            persistAndNotify();
            renderPinPlanner();
            h.log?.(`Cleared pin assignments for ${entity?.name || "top entity"}`, "info");
        });
        const qsfInput = bar.querySelector("#pp-qsf-file");
        bar.querySelector("#pp-import").addEventListener("click", () => qsfInput.click());
        qsfInput.addEventListener("change", (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                importQsfText(String(reader.result || ""), file.name);
            };
            reader.readAsText(file);
        });
        bar.querySelector("#pp-export").addEventListener("click", () => {
            const devPart = profile?.device?.quartusDevice || "EP4CE6E22C8";
            const qsfText = exportPlannerToQsf(entity?.name || "top", nodes, assignments, devPart);
            const blob = new Blob([qsfText], { type: "text/plain;charset=utf-8" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `${entity?.name || "project"}.qsf`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            h.log?.(`Exported ${nodes.length} node rules to ${a.download}`, "ok");
        });

        if (!nodes.length) {
            const empty = document.createElement("div");
            empty.className = "sb-empty";
            empty.textContent = "Open or create an entity/module with ports to assign board pins.";
            p.appendChild(empty);
            return;
        }

        const table = document.createElement("table");
        table.className = "pin-table pp-table";
        table.innerHTML = `<thead><tr><th>Node Name</th><th>Dir</th><th>Location</th><th>I/O Std</th><th>Val</th></tr></thead><tbody></tbody>`;
        const tbody = table.querySelector("tbody");

        const optionsHtml = `<option value="">Unassigned</option>`
            + catalog.list.map((c) => {
                const tag = c.priority > 0 ? `${c.pin} — ${c.label}` : c.pin;
                return `<option value="${escHtml(c.pin)}">${escHtml(tag)}</option>`;
            }).join("");

        for (const n of nodes) {
            const entry = assignments[n.nodeName] || { location: "", ioStandard: "3.3-V LVTTL" };
            const curLoc = normalizePin(entry.location || "");
            const tr = document.createElement("tr");
            tr.className = "pin-row";
            tr.dataset.node = n.nodeName;
            tr.dataset.port = n.portName;
            tr.dataset.bitOffset = String(n.bitOffset || 0);
            tr.dataset.pin = curLoc;
            tr.dataset.search = `${n.nodeName} ${n.direction} ${curLoc} ${catalog.byPin.get(curLoc)?.label || ""}`.toLowerCase();

            tr.innerHTML = `
                <td class="pin-id" title="${escHtml(n.nodeName)}">${escHtml(n.nodeName)}</td>
                <td class="pin-dir">${escHtml(n.direction === "input" ? "in" : n.direction === "output" ? "out" : "io")}</td>
                <td class="pp-loc-cell">
                    <input type="text" class="pp-loc-input" list="pp-pin-datalist" value="${escHtml(entry.location || "")}" placeholder="Unassigned" spellcheck="false" aria-label="Pin location for ${escHtml(n.nodeName)}">
                </td>
                <td>
                    <select class="pp-std-select" aria-label="I/O Standard for ${escHtml(n.nodeName)}">
                        ${IO_STANDARDS.map((s) => `<option value="${escHtml(s)}"${s === (entry.ioStandard || "3.3-V LVTTL") ? " selected" : ""}>${escHtml(s)}</option>`).join("")}
                    </select>
                </td>
                <td class="pin-val" data-v="--">--</td>
            `;

            const locInp = tr.querySelector(".pp-loc-input");
            const stdSel = tr.querySelector(".pp-std-select");

            locInp.addEventListener("input", () => {
                const raw = locInp.value.trim();
                const norm = normalizePin(raw);
                tr.dataset.pin = norm;
                assignments[n.nodeName] = { location: norm || raw, ioStandard: stdSel.value };
                tr.dataset.search = `${n.nodeName} ${n.direction} ${norm} ${catalog.byPin.get(norm)?.label || ""}`.toLowerCase();
                persistAndNotify();
            });
            stdSel.addEventListener("change", () => {
                assignments[n.nodeName] = { location: locInp.value.trim(), ioStandard: stdSel.value };
                persistAndNotify();
            });
            tr.addEventListener("click", (e) => {
                if (e.target.closest("input, select, button")) return;
                p.querySelectorAll("tr.selected").forEach((x) => x.classList.remove("selected"));
                tr.classList.add("selected");
                const pin = tr.dataset.pin;
                if (pin) h.onHighlightPin?.(pin);
            });
            tbody.appendChild(tr);
        }
        p.appendChild(table);
        refreshPinValidationUI();
        updatePinValues();
        applySearch();
    }

    function importQsfText(qsfText, sourceName = "project.qsf") {
        const imported = parseQsfToPlanner(qsfText, nodes);
        const count = Object.keys(imported).length;
        if (!count) {
            toast(`No pin location assignments found in ${sourceName}`, { kind: "warn" });
            return 0;
        }
        assignments = { ...assignments, ...imported };
        persistAndNotify();
        renderPinPlanner();
        h.log?.(`Imported ${count} pin assignment(s) from ${sourceName} into Pin Planner`, "ok");
        toast(`Imported ${count} pin assignment(s) from ${sourceName}`, { kind: "ok" });
        return count;
    }

    function updatePinValues() {
        panes.pinmap.querySelectorAll(".pin-row[data-port]").forEach((tr) => {
            const port = tr.dataset.port;
            const offset = Number(tr.dataset.bitOffset || 0);
            let v = liveValues[port];
            if (v === undefined) {
                const alt = Object.keys(liveValues).find((k) => k.toLowerCase() === port.toLowerCase());
                if (alt) v = liveValues[alt];
            }
            let text = "--";
            if (typeof v === "number") text = String((v >>> offset) & 1);
            else if (typeof v === "string") text = offset === 0 ? v.toUpperCase() : "--";
            const cell = tr.querySelector(".pin-val");
            if (cell) {
                cell.textContent = text;
                cell.classList.toggle("v1", text === "1");
            }
        });
    }

    // ----------------------------------------------------------- examples --
    function renderExamples() {
        const p = panes.examples;
        p.innerHTML = "";
        if (!examples.length) {
            p.innerHTML = `<div class="sb-empty">No examples available (backend offline?).</div>`;
            return;
        }
        for (const ex of examples) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sb-item sb-example";
            btn.dataset.search = `${ex.name} ${ex.description || ""}`.toLowerCase();
            btn.innerHTML = `<span class="sb-item-icon">${icon("file")}</span>
                <span class="sb-item-text"><span class="sb-item-name">${ex.name}</span>
                <span class="sb-item-desc">${ex.description || ex.entity || ""}</span></span>`;
            btn.addEventListener("click", () => {
                p.querySelectorAll(".sb-example.selected").forEach((s) => s.classList.remove("selected"));
                btn.classList.add("selected");
                h.onExample?.(ex.id);
            });
            p.appendChild(btn);
        }
    }

    // -------------------------------------------------------------- api ----
    function setProfile(p) {
        profile = p;
        catalog = buildPinCatalog(profile);
        renderPeripherals();
        renderPinPlanner();
        renderSpecsCard();
    }

    function setEntity(e) {
        const sameEntity = entity?.name && e?.name && entity.name.toLowerCase() === e.name.toLowerCase();
        entity = e;
        nodes = expandEntityNodes(entity);
        if (!sameEntity) {
            assignments = entity?.name ? getEntityAssignments(plannerStore, entity.name) : {};
        } else if (entity?.name) {
            assignments = { ...getEntityAssignments(plannerStore, entity.name), ...assignments };
        }
        renderPinPlanner();
        renderAttachedChips();
    }

    function getPinPlan() {
        const validation = validateAssignments(nodes, assignments, catalog);
        const portPins = {};
        const bitPins = {};
        for (const n of nodes) {
            const pin = validation.validByNode.get(n.nodeName);
            if (!pin) continue;
            if (!bitPins[n.portName]) bitPins[n.portName] = {};
            const bitKey = n.bit !== null ? n.bit : 0;
            bitPins[n.portName][bitKey] = pin;
            if (!portPins[n.portName]) portPins[n.portName] = new Array(n.width || 1).fill("");
            portPins[n.portName][n.bitOffset || 0] = pin;
        }
        return {
            entity,
            nodes,
            assignments: { ...assignments },
            catalog,
            validation,
            portPins,
            bitPins,
            qsfText: exportPlannerToQsf(entity?.name || "top", nodes, assignments, profile?.device?.quartusDevice || "EP4CE6E22C8"),
        };
    }

    function setExamples(list) { examples = list || []; renderExamples(); }
    function setLiveValues(values) {
        liveValues = values || {};
        updatePinValues();
        updateAttached();
    }
    function setFilter(q) { search.value = q; search.dispatchEvent(new Event("input")); }

    renderPeripherals();
    renderPinPlanner();

    return {
        setProfile, setEntity, setExamples, setLiveValues, setFilter,
        getPinPlan, importQsfText, showTab,
        setCollapsed, expand, root,
    };
}
