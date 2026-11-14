// sidebar.js — left sidebar: Peripherals / Pin Map / Examples tabs + search,
// and the pinned board-specs card (mockup: part, VERIFIED, summary, All specs).

import { icon } from "./icons.js";
import { dialog } from "./toast.js";

// Attachable module catalog (virtual modules — UI-level binding to a port).
const ATTACHABLE = [
    { id: "ledbar", name: "LED bar", icon: "slider", desc: "8 discrete LEDs", width: 8 },
    { id: "lcd", name: "1602 LCD", icon: "lcd", desc: "character display", width: 8 },
    { id: "servo", name: "Servo", icon: "toggle", desc: "PWM horn angle", width: 8 },
    { id: "bargraph", name: "Bargraph", icon: "activity", desc: "10-level meter", width: 10 },
];

export function createSidebar(root, h) {
    root.classList.add("sidebar");
    root.innerHTML = `
        <div class="sb-search">
            <span class="sb-search-icon">${icon("search")}</span>
            <input id="sb-search" type="text" placeholder="Search components or pins" aria-label="Search components or pins">
        </div>
        <div class="sb-tabs" role="tablist">
            <button class="sb-tab active" data-tab="periph" role="tab" aria-selected="true">Peripherals</button>
            <button class="sb-tab" data-tab="pinmap" role="tab" aria-selected="false">Pin Map</button>
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
    let entity = null;
    let liveValues = {};
    let examples = [];

    // ------------------------------------------------------------- search --
    search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        root.querySelectorAll(".sb-item").forEach((el) => {
            const hay = (el.dataset.search || "").toLowerCase();
            el.classList.toggle("hidden", !!q && !hay.includes(q));
        });
        root.querySelectorAll(".sb-group").forEach((g) => {
            const any = g.querySelector(".sb-item:not(.hidden)");
            g.classList.toggle("hidden", !any && !g.dataset.always);
        });
        // pins: filter the Pin Map rows on the same query
        root.querySelectorAll(".pin-row").forEach((tr) => {
            const hay = (tr.dataset.search || "").toLowerCase();
            tr.classList.toggle("hidden", !!q && !hay.includes(q));
        });
    });

    root.querySelector(".sb-tabs").addEventListener("click", (e) => {
        const tab = e.target.closest(".sb-tab");
        if (!tab) return;
        root.querySelectorAll(".sb-tab").forEach((t) => {
            t.classList.toggle("active", t === tab);
            t.setAttribute("aria-selected", String(t === tab));
        });
        for (const [key, pane] of Object.entries(panes)) {
            pane.classList.toggle("hidden", key !== tab.dataset.tab);
        }
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
                desc: `${dev.package || "EQFP-144"} \u00b7 ${dev.logicElements ? dev.logicElements.toLocaleString() + " LE" : "Cyclone IV E"}`,
                icon: "chip", onSelect: () => showInfo(fpgaInfo()),
            },
        ], true));

        p.appendChild(group("Clock / reset", "activity", [
            { id: "X1", name: "50 MHz oscillator", desc: b.clockPin ? `X1 \u00b7 ${b.clockPin}` : "X1 \u00b7 PIN_23", icon: "activity", onSelect: () => showInfo(clockInfo()) },
            { id: "RESET", name: "RESET key", desc: b.resetPin ? `${b.resetPin} \u00b7 active-${b.resetActiveLow === false ? "high" : "low"}` : "PIN_25 \u00b7 active-low", icon: "reset", onSelect: () => showInfo(resetInfo()) },
        ], true));

        p.appendChild(group("User I/O", "toggle", [
            { id: "LED1", name: "LED1\u2013LED4", desc: b.leds ? `${b.leds.count} \u00d7 red \u00b7 ${b.leds.activeLow ? "active-low" : "active-high"}` : "4 red LEDs", icon: "slider", onSelect: () => showInfo(ledsInfo()) },
            { id: "S1", name: "Keys KEY1\u2013KEY4", desc: b.buttons ? `${b.buttons.count} tact \u00b7 ${b.buttons.activeLow ? "active-low" : "active-high"}` : "4 tact keys", icon: "toggle", onSelect: () => showInfo(buttonsInfo()) },
            { id: "SW2", name: "DIP switch SW2", desc: b.switches ? `${b.switches.count}-pos \u00b7 shares KEY nets` : "4-pos", icon: "slider", onSelect: () => showInfo(dipInfo()) },
            { id: "DISP1", name: "7-segment display", desc: b.displays?.part || "4-digit multiplexed", icon: "lcd", onSelect: () => showInfo(displayInfo()) },
            { id: "SP1", name: "Buzzer SP1", desc: b.buzzer ? `${b.buzzer.type} \u00b7 ${b.buzzer.pin}` : "passive \u00b7 PIN_110", icon: "activity", onSelect: () => showInfo(buzzerInfo()) },
        ], true));

        p.appendChild(group("Memories", "ram", [
            { id: "U6", name: "HY57V641620 SDRAM", desc: "U6 \u00b7 TSOP-II 54 \u00b7 64 Mbit", icon: "ram", onSelect: () => showInfo(sdramInfo()) },
            { id: "U7", name: "EPCS16 config flash", desc: b.config?.flash || "U7 \u00b7 AS serial flash", icon: "ram", onSelect: () => showInfo(flashInfo()) },
            { id: "U8", name: "AT24C08 EEPROM", desc: "U8 \u00b7 I2C 0x50 \u00b7 1 KB", icon: "ram", onSelect: () => showInfo(eepromInfo()) },
        ], true));

        p.appendChild(group("Connectors", "cable", [
            { id: "J1", name: "DC power jack", desc: b.inputVoltage ? `${b.inputVoltage} input` : "5 V input", icon: "plug", onSelect: () => showInfo(powerInfo()) },
            { id: "USB", name: "USB / UART", desc: b.uart?.transceiver || "MAX3232E \u00b7 DB9", icon: "cable", onSelect: () => showInfo(uartInfo()) },
            { id: "VGA", name: "VGA DB15", desc: b.vga ? `${b.vga.colors} colours \u00b7 1-bit RGB` : "8 colours", icon: "monitor", onSelect: () => showInfo(vgaInfo()) },
            { id: "PS2", name: "PS/2 port", desc: b.ps2 ? "6-pin DIN \u00b7 open-collector" : "keyboard/mouse", icon: "cable", onSelect: () => showInfo(ps2Info()) },
            { id: "JTAG", name: "JTAG header", desc: "10-pin \u00b7 volatile programming", icon: "plug", onSelect: () => showInfo(jtagInfo()) },
        ], true));

        p.appendChild(group("Headers", "globe", [
            { id: "P1", name: "P1 expansion header", desc: b.headers?.P1?.size || "19\u00d72 \u00b7 2.54 mm", icon: "globe", onSelect: () => showInfo(headerInfo("P1")) },
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
        title: `FPGA \u2014 ${profile?.device?.part || "EP4CE6E22C8N"}`,
        body: kv([
            ["Family", profile?.device?.family || "Cyclone IV E"],
            ["Package", profile?.device?.package || "EQFP-144"],
            ["Speed grade", profile?.device?.speedGrade || "8"],
            ["Logic elements", (profile?.device?.logicElements || 6272).toLocaleString()],
            ["M9K blocks", `${profile?.device?.m9kBlocks || 30} (${profile?.device?.m9kKbit || 270} Kbit)`],
            ["Multipliers 18\u00d718", profile?.device?.multipliers18x18 || 15],
            ["PLLs", profile?.device?.plls || 2],
            ["User I/O", profile?.device?.userIo || 91],
            ["Core voltage", profile?.device?.coreVoltage || "1.2 V"],
        ]) + facts(["F01", "F02", "F03", "F04"]),
    });
    const clockInfo = () => ({
        title: "Clock \u2014 X1 50 MHz oscillator",
        body: kv([
            ["Frequency", `${((profile?.board?.clockHz || 50000000) / 1e6).toFixed(0)} MHz`],
            ["FPGA pin", profile?.board?.clockPin || "PIN_23"],
            ["Port alias", `${profile?.board?.clockPort || "CLOCK_50"} / FPGA_CLK / CLK`],
            ["Source", profile?.board?.clockSource || "active oscillator, 3.3 V"],
        ]) + facts(["F05"]),
    });
    const resetInfo = () => ({
        title: "Reset \u2014 RESET key",
        body: kv([
            ["FPGA pin", profile?.board?.resetPin || "PIN_25"],
            ["Polarity", profile?.board?.resetActiveLow === false ? "active-high" : "active-low (shorts to GND)"],
            ["Pull-up", profile?.board?.resetPullup || "R2 10 k\u03a9 + C10 100 nF"],
        ]) + facts(["F06"]),
    });
    const ledsInfo = () => ({
        title: "LED1\u2013LED4",
        body: kv([
            ["Count", profile?.board?.leds?.count || 4],
            ["Pins", (profile?.board?.leds?.pins || ["PIN_87", "PIN_86", "PIN_85", "PIN_84"]).join(", ")],
            ["Polarity", profile?.board?.leds?.activeLow ? "active-low (lit = 0)" : "active-high"],
            ["Driver", profile?.board?.leds?.wiring || "anodes to 3.3 V, cathodes via 470 \u03a9"],
        ]) + facts(["F09"]),
    });
    const buttonsInfo = () => ({
        title: "Keys KEY1\u2013KEY4",
        body: kv([
            ["Count", profile?.board?.buttons?.count || 4],
            ["Pins", (profile?.board?.buttons?.pins || ["PIN_88", "PIN_89", "PIN_90", "PIN_91"]).join(", ")],
            ["Polarity", profile?.board?.buttons?.activeLow ? "active-low (pressed = 0)" : "active-high"],
            ["Series R", profile?.board?.buttons?.seriesResistor || "220 \u03a9 (R34\u2013R37)"],
        ]) + facts(["F07", "F08"]),
    });
    const dipInfo = () => ({
        title: "DIP switch SW2",
        body: kv([
            ["Positions", profile?.board?.switches?.count || 4],
            ["Nets", "shared with KEY1\u2013KEY4 (pins 88\u201391)"],
            ["ON level", `closed = ${profile?.board?.switches?.onValue ?? 0}`],
            ["Pull-up", profile?.board?.switches?.pullup || "10 k\u03a9 (R42\u2013R45)"],
        ]) + facts(["F08"]),
    });
    const displayInfo = () => ({
        title: "7-segment display \u2014 DISP1",
        body: kv([
            ["Part", profile?.board?.displays?.part || "4-digit common-anode, 12-pin"],
            ["Segments", `SEG[7..0] ${JSON.stringify(profile?.board?.displays?.segBitMap || {})}`],
            ["Digit select", `DIG[3..0] \u00b7 ${profile?.board?.displays?.digitActiveLow ? "active-low" : "active-high"}`],
            ["Drivers", profile?.board?.displays?.digitResistors || "8550 PNP high-side"],
        ]) + facts([]),
    });
    const buzzerInfo = () => ({
        title: "Buzzer SP1",
        body: kv([
            ["Type", profile?.board?.buzzer?.type || "passive"],
            ["Pin", profile?.board?.buzzer?.pin || "PIN_110"],
            ["Polarity", profile?.board?.buzzer?.activeLow ? "active-low drive" : "active-high"],
            ["Status", profile?.board?.buzzer?.typeConfidence || "unverified on real hardware"],
        ]) + facts([]),
    });
    const sdramInfo = () => ({
        title: "SDRAM \u2014 U6 HY57V641620",
        body: kv([
            ["Organisation", `${profile?.board?.sdram?.banks || 4} banks \u00d7 ${profile?.board?.sdram?.dataBits || 16} bit`],
            ["Refresh", `${profile?.board?.sdram?.refreshCycles || 4096} cycles / ${profile?.board?.sdram?.refreshMs || 64} ms`],
            ["Model", "pin map only (no timing model)"],
        ]) + facts([]),
    });
    const flashInfo = () => ({
        title: "Configuration flash \u2014 U7",
        body: kv([
            ["Part", profile?.board?.config?.flash || "EPCS16"],
            ["Size", `${((profile?.board?.config?.flashSizeBits || 16777216) / 1048576).toFixed(0)} Mbit`],
            ["Note", profile?.board?.config?.flashMarkingNote || ""],
        ]) + facts([]),
    });
    const eepromInfo = () => {
        const bus = (profile?.board?.i2c?.buses || []).find((x) => /eeprom/i.test(x.name)) || {};
        return {
            title: "EEPROM \u2014 U8 AT24C08",
            body: kv([
                ["Bus", `${bus.scl || "PIN_99"} / ${bus.sda || "PIN_98"}`],
                ["Address", `0x${(bus.device?.address || 0x50).toString(16)}`],
                ["Size", `${bus.device?.bytes || 1024} B \u00b7 page ${bus.device?.pageSize || 16} B`],
                ["WP", "tied to VCC \u2014 writes blocked, reads work"],
            ]) + facts([]),
        };
    };
    const powerInfo = () => ({
        title: "Power input \u2014 J1",
        body: kv([
            ["Input", profile?.board?.inputVoltage || "5 V DC"],
            ["Rails", (profile?.board?.rails || []).map((r) => `${r.net || r.name} ${r.voltage || ""}`).join(" \u00b7 ") || "3.3 V / 1.2 V"],
            ["Switch", "SW1 self-locking latching button"],
        ]) + facts([]),
    });
    const uartInfo = () => ({
        title: "UART \u2014 MAX3232E",
        body: kv([
            ["Transceiver", profile?.board?.uart?.transceiver || "MAX3232E"],
            ["Pins", `TXD ${profile?.board?.uart?.pins?.UART_TXD || "PIN_114"} \u00b7 RXD ${profile?.board?.uart?.pins?.UART_RXD || "PIN_115"}`],
            ["DB9", profile?.board?.uart?.db9Note || "TX=7 RX=8 GND=5 (non-standard)"],
        ]) + facts([]),
    });
    const vgaInfo = () => ({
        title: "VGA \u2014 DB15",
        body: kv([
            ["Colour depth", `${profile?.board?.vga?.colors || 8} colours (1-bit RGB)`],
            ["Sync", `HS ${profile?.board?.vga?.pins?.VGA_HSYNC || "PIN_101"} \u00b7 VS ${profile?.board?.vga?.pins?.VGA_VSYNC || "PIN_103"}`],
            ["Resistors", profile?.board?.vga?.resistors || "R/G/B 1 k\u03a9"],
        ]) + facts([]),
    });
    const ps2Info = () => ({
        title: "PS/2 port",
        body: kv([
            ["Connector", profile?.board?.ps2?.connector || "6-pin DIN"],
            ["Pins", `CLK ${profile?.board?.ps2?.pins?.PS_CLOCK || "PIN_119"} \u00b7 DATA ${profile?.board?.ps2?.pins?.PS_DATA || "PIN_120"}`],
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
            ["Size", profile?.board?.headers?.[id]?.size || "2\u00d7n \u00b7 2.54 mm"],
            ["Note", profile?.board?.headers?.[id]?.note || "power rails + FPGA I/O"],
        ]) + facts([]),
    });

    function showInfo(info) {
        infoCard.classList.remove("hidden");
        infoCard.innerHTML = `<div class="ic-title">${info.title}</div>${info.body}`;
    }

    // ---------------------------------------------------------- specs card --
    function renderSpecsCard() {
        const dev = profile?.device || {};
        const part = dev.part || "EP4CE6E22C8N";
        const verified = (profile?.facts || []).some((f) => /VERIFIED/.test(f.tag || ""));
        specCard.innerHTML = `
            <div class="spc-top"><b class="spc-part">${part}</b><span class="tag ${verified ? "tag-ok" : "tag-warn"}">${verified ? "VERIFIED" : "DRAFT"}</span></div>
            <div class="spc-rows">
                <div class="spc-row"><span>${dev.family || "Cyclone IV E"}</span><span>${dev.package || "EQFP-144"}</span></div>
                <div class="spc-row"><span>${(dev.logicElements || 6272).toLocaleString()} LE</span><span>${dev.userIo || 91} user I/O</span></div>
                <div class="spc-row"><span>${dev.m9kBlocks || 30} M9K</span><span>${dev.plls || 2} PLLs</span></div>
            </div>
            <button type="button" class="btn spc-all" id="sb-allspecs">All specs</button>`;
        specCard.querySelector("#sb-allspecs").addEventListener("click", showAllSpecs);
    }

    function showAllSpecs() {
        const dev = profile?.device || {};
        const rows = [
            ["Family", dev.family], ["Part", dev.part], ["Package", dev.package],
            ["Speed grade", dev.speedGrade], ["Logic elements", (dev.logicElements || 6272).toLocaleString()],
            ["M9K blocks", `${dev.m9kBlocks || 30} (${dev.m9kKbit || 270} Kbit)`],
            ["Multipliers 18\u00d718", dev.multipliers18x18 || 15], ["PLLs", dev.plls || 2],
            ["User I/O", dev.userIo || 91], ["I/O standard", dev.defaultIoStandard],
            ["Core voltage", dev.coreVoltage],
        ].filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `<div class="ic-row"><span>${k}</span><b>${v}</b></div>`).join("");
        const facts = (profile?.facts || []).map((f) =>
            `<div class="ic-fact"><span class="tag ${/VERIFIED/.test(f.tag) ? "tag-ok" : "tag-warn"}">${f.tag}</span>${f.statement}</div>`
        ).join("");
        dialog({
            title: `Board specs \u2014 ${dev.part || "EP4CE6E22C8N"}`,
            body: `<div class="ic-title">Device</div>${rows}<div class="ic-title" style="margin-top:12px">Verified board facts</div><div class="ic-facts">${facts || "<div class='bp-empty'>No facts loaded.</div>"}</div>`,
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
            h.log?.(`Attached ${def.name}${port ? " \u2192 " + port : " (no output port \u2014 bind one below)"}`, "info");
        }
        renderAttachedChips();
        h.onAttachedChanged?.(attached);
    }

    function pickPort(def) {
        if (!entity) return "";
        const outs = entity.ports.filter((p) => p.direction !== "in");
        const pref = outs.find((p) => p.name.toLowerCase().includes(def.id === "ledbar" ? "led" : def.id));
        return pref ? pref.name : (outs[0] ? outs.name ?? outs[0].name : "");
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
                    <span>${a.def.name}${a.port ? " \u2192 " + a.port : ""}</span>
                    <b class="attach-val" data-id="${a.def.id}">--</b>
                    <button type="button" aria-label="Detach ${a.def.name}">\u00d7</button>
                </div>`).join("")
            : `<div class="attach-empty">No modules attached \u2014 pick one above.</div>`;
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
            if (a.def.id === "servo") el.textContent = `${Math.round((num / 255) * 180 - 90)}\u00b0`;
            else if (a.def.id === "lcd") el.textContent = "0x" + (num & 0xff).toString(16).toUpperCase();
            else el.textContent = `${num} / ${(1 << a.def.width) - 1}`;
        }
    }

    // ------------------------------------------------------------ pin map --
    function renderPinMap() {
        const p = panes.pinmap;
        p.innerHTML = "";
        const table = document.createElement("table");
        table.className = "pin-table";
        table.innerHTML = `<thead><tr><th>Pin</th><th>Signal</th><th>Dir</th><th>Value</th></tr></thead><tbody></tbody>`;
        const tbody = table.querySelector("tbody");
        const pinMap = profile?.pinMap || {};
        const dirOf = (signal) => {
            const base = signal.replace(/\[\d+\]$/, "");
            const port = entity?.ports?.find((x) => x.name.toLowerCase() === base.toLowerCase());
            if (port) return port.direction === "in" ? "in" : "out";
            if (/^(LED|SEG|DIG|VGA|UART_TXD|LCD|FPGA_BUZZER|SDRAM|LDQM|UDQM)/i.test(signal)) return "out";
            if (/^(KEY|SW|RESET|CLK|CLOCK|FPGA_RST|UART_RXD|PS_|IR)/i.test(signal)) return "in";
            return "\u2014";
        };
        const rows = [];
        for (const [signal, pins] of Object.entries(pinMap)) {
            const list = Array.isArray(pins) ? pins : [pins];
            list.forEach((pin, idx) => {
                rows.push({ pin, signal: list.length > 1 ? `${signal} [${idx}]` : signal, key: signal, idx });
            });
        }
        rows.sort((a, b) => a.pin.localeCompare(b.pin, undefined, { numeric: true }));
        for (const r of rows) {
            const tr = document.createElement("tr");
            tr.className = "pin-row";
            tr.dataset.search = `${r.pin} ${r.signal}`.toLowerCase();
            tr.dataset.pin = r.pin;
            tr.dataset.key = r.key;
            tr.dataset.idx = r.idx;
            tr.innerHTML = `<td class="pin-id">${r.pin}</td><td>${r.signal}</td><td class="pin-dir">${dirOf(r.signal)}</td><td class="pin-val" data-v="--">--</td>`;
            tr.addEventListener("click", () => {
                p.querySelectorAll("tr.selected").forEach((x) => x.classList.remove("selected"));
                tr.classList.add("selected");
                h.onHighlightPin?.(r.pin);
            });
            tbody.appendChild(tr);
        }
        p.appendChild(table);
        updatePinValues();
    }

    function updatePinValues() {
        const fmt = (v) => (v === undefined || v === null ? "--" : String(v));
        panes.pinmap.querySelectorAll(".pin-row").forEach((tr) => {
            const key = tr.dataset.key;
            const idx = Number(tr.dataset.idx);
            let v = liveValues[key];
            if (v === undefined) {
                const alt = Object.keys(liveValues).find((k) => k.toLowerCase() === key.toLowerCase());
                if (alt) v = liveValues[alt];
            }
            let text = "--";
            if (typeof v === "number") text = String((v >>> idx) & 1);
            else if (typeof v === "string") text = idx === 0 ? v.toUpperCase() : "--";
            const cell = tr.querySelector(".pin-val");
            cell.textContent = text;
            cell.classList.toggle("v1", text === "1");
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
        renderPeripherals();
        renderPinMap();
        renderSpecsCard();
    }
    function setEntity(e) { entity = e; renderPinMap(); renderAttachedChips(); }
    function setExamples(list) { examples = list || []; renderExamples(); }
    function setLiveValues(values) {
        liveValues = values || {};
        updatePinValues();
        updateAttached();
    }
    function setFilter(q) { search.value = q; search.dispatchEvent(new Event("input")); }

    renderPeripherals();
    renderPinMap();

    return { setProfile, setEntity, setExamples, setLiveValues, setFilter, root };
}
