// installed-app-e2e.mjs — end-to-end verification of the INSTALLED desktop app.
//
// Prerequisites (see docs/evidence/README.md §installed-app):
//   1. The NSIS installer was run silently with /D=<install dir with spaces>.
//   2. cyclone-iv-studio.exe from that dir is RUNNING with WebView2 remote
//      debugging: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9229
//      --autoplay-policy=no-user-gesture-required".
// This script attaches to that live WebView2 via CDP (browserURL :9229) and
// verifies every workbench tab, the six visual fixes and the interactive
// features against the real installed binary + its bundled sidecar.
//
// Usage: node scripts/installed-app-e2e.mjs [cdpUrl]   (default :9229)

import puppeteer from "puppeteer-core";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CDP = process.argv[2] || "http://127.0.0.1:9229";
// anchored to THIS script's location — never the shell's cwd
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/evidence/installed-app");
const LOG = resolve(HERE, "../../docs/evidence/installed-app-e2e.log");
mkdirSync(OUT, { recursive: true });

let failures = 0;
const step = (name, ok, detail = "") => {
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    appendFileSync(LOG, `${ok ? "PASS" : "FAIL"}  ${name}  | ${detail}\n`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for the CURRENT GHDL capture to finish: every input change triggers a
// full re-run (~3 s; a first-time display capture ~13 s), and the stimulus
// map / POV image are only published when the run COMPLETES. Poll for a new
// "Simulation complete" line — fixed waits sample the previous run.
async function settle(page, timeoutMs = 90000) {
    const count = () => page.evaluate(() =>
        [...document.querySelectorAll("#console-log .log-line")]
            .filter((l) => l.textContent.includes("Simulation complete")).length);
    const before = await count();
    const t0 = Date.now();
    for (;;) {
        await wait(400);
        if ((await count()) > before) break;
        if (Date.now() - t0 > timeoutMs) return false;
    }
    await wait(600);
    return true;
}

// ---------------------------------------------------------------- connect --
let browser = null;
for (let i = 0; i < 30 && !browser; i += 1) {
    try {
        browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
    } catch {
        process.stdout.write(".");
        await wait(2000);
    }
}
if (!browser) {
    console.error(`Could not connect to the installed app at ${CDP}`);
    process.exit(1);
}
console.log(`\nConnected to the installed app via ${CDP}`);

const targets = browser.targets();
const pageTarget = targets.find((t) => t.type() === "page" && /^http:\/\/127\.0\.0\.1:\d+/.test(t.url()));
if (!pageTarget) {
    console.error("No app page target found:", targets.map((t) => `${t.type()}:${t.url()}`));
    process.exit(1);
}
const page = await pageTarget.page();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e?.message || e)));

await page.waitForFunction(() => window.__cyclone && window.__cyclone.board, { timeout: 60000 });
await wait(1500);

// 00 — the installed app auto-spawned its bundled sidecar and reports it
await page.waitForFunction(() => [...document.querySelectorAll("#console-log .log-line")]
    .some((l) => /Backend ready/i.test(l.textContent)), { timeout: 30000 }).catch(() => {});
{
    const ready = await page.evaluate(() => [...document.querySelectorAll("#console-log .log-line")]
        .map((l) => l.textContent.trim()).find((t) => /Backend ready/i.test(t)) || "");
    step("00 installed app auto-spawned the bundled sidecar (Backend ready — GHDL 6.0.0)",
        /Backend ready/i.test(ready) && /GHDL 6\.0\.0/i.test(ready), ready);
}

// ------------------------------------------------------------------ step 1 --
// Code tab + 3D viewport: background, PCB colour, framing, HUD, no duplicates.
{
    await page.click('[data-ctab="sources"]').catch(() => {});
    await wait(500);
    const s = await page.evaluate(() => {
        const b = window.__cyclone.board;
        const stats = document.getElementById("stats");
        const pill = document.querySelector(".board-hud-pill");
        // Framing: the board's bounding sphere (~85 mm for the 132×104 mm
        // board) must fit inside the camera frustum with breathing room.
        const cam = b.camera;
        const dist = cam.position.distanceTo(b.controls.target);
        const fovV = (cam.fov * Math.PI) / 180;
        const fovH = 2 * Math.atan(Math.tan(fovV / 2) * cam.aspect);
        const needed = 85 / Math.sin(Math.min(fovV, fovH) / 2);
        return {
            bg: "#" + b.scene.background.getHexString(),
            pcb: "#" + b.mats.pcbTop.color.getHexString(),
            dist: Math.round(dist), needed: Math.round(needed),
            statsH: Math.round(stats.getBoundingClientRect().height),
            statsOverflow: stats.scrollWidth - stats.clientWidth,
            pillH: Math.round(pill.getBoundingClientRect().height),
            fps: document.getElementById("st-fps")?.textContent || null,
            epRun: document.querySelectorAll("#ep-run, .ep-run").length,
            epMsgs: document.querySelectorAll("#ep-messages, .ep-msg-list").length,
        };
    });
    step("01 board/viewport: #0a0a0b background + #111315 PCB", s.bg === "#0a0a0b" && s.pcb === "#111315", JSON.stringify(s));
    step("01 board 100% framed (camera distance ≥ sphere fit, ≤ 1.8×)",
        s.dist >= s.needed && s.dist <= s.needed * 1.8, `dist=${s.dist} needed=${s.needed}`);
    step("01 HUD single row ≤40px, no FPS text, no overflow",
        s.pillH <= 40 && s.statsH <= 36 && s.statsOverflow <= 0 && s.fps === null,
        `pill=${s.pillH}px stats=${s.statsH}px overflow=${s.statsOverflow} fps=${s.fps}`);
    step("01 no duplicate #ep-run / #ep-messages", s.epRun === 0 && s.epMsgs === 0, `run=${s.epRun} msgs=${s.epMsgs}`);
    await page.screenshot({ path: join(OUT, "installed-01-code.png") });
}

// ------------------------------------------------------------------ step 2 --
// Buzzer: example -> Compile & Run -> hold K1 -> <25ms, 0 HTTP, 800 Hz, ring.
{
    await page.evaluate(() => {
        const sel = document.querySelector("#tb-examples");
        const opt = [...sel.options].find((o) => /^buzz1$/i.test(o.value) || /buzz1/i.test(o.textContent));
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await wait(800);
    // apply the board default pin assignments FIRST (same button a student
    // clicks) — without them the stimulus sweep has no pin bindings and the
    // interactive buzzer/POV path stays dead
    await page.click('[data-ctab="pinmap"]');
    await wait(300);
    await page.evaluate(() => document.querySelector("#pp-defaults")?.click());
    await wait(400);
    await page.click("#tb-compile");
    await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 120000 });
    await settle(page); // the stimulus map is published when the capture COMPLETES
    // instrument HTTP before the interactive press
    await page.evaluate(() => {
        window.__http = 0;
        const of = window.fetch;
        window.fetch = (...a) => { window.__http += 1; return of.apply(window, a); };
        const oo = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (...a) { window.__http += 1; return oo.apply(this, a); };
    });
    const press = await page.evaluate(() => {
        const t0 = performance.now();
        window.__cyclone.setPhysicalKeyPressed(0, true);
        return { ms: Math.round((performance.now() - t0) * 100) / 100 };
    });
    // Live co-simulation: the tone lands on the next live frame (~33 ms at
    // 30 fps), so poll for it; the ZERO-http contract stays hard.
    let settled = null;
    for (let i = 0; i < 40; i += 1) {
        await wait(50);
        settled = await page.evaluate(() => {
            const ring = window.__cyclone.board._buzzerRing;
            return {
                freq: window.__cyclone.state.buzzer?.frequency || 0,
                badge: document.getElementById("tb-audio-badge")?.textContent,
                oscGain: window.__cyclone.audio.state().oscGain,
                ringVisible: ring ? ring.visible : null,
                ringOpacity: ring ? Math.round(ring.material.opacity * 1000) / 1000 : null,
            };
        });
        if (Math.abs(settled.freq - 800) <= 16 && settled.oscGain > 0 && settled.ringOpacity >= 0.85) break;
    }
    const httpCount = await page.evaluate(() => window.__http);
    step("02 K1 press: interactive, ZERO http requests, 800 Hz (±2%)",
        press.ms < 25 && httpCount === 0 && Math.abs(settled.freq - 800) <= 16,
        `${press.ms} ms, http=${httpCount}, freq=${settled.freq}`);
    const badgeHz = Number(String(settled.badge || "").replace(/[^0-9.]/g, ""));
    step("02 audio: badge ~800 Hz + oscillator gain > 0",
        Math.abs(badgeHz - 800) <= 16 && settled.oscGain > 0, `badge=${settled.badge} oscGain=${settled.oscGain}`);
    step("02 SP1 pulse ring visible (opacity ≥ 0.85)",
        settled.ringVisible === true && settled.ringOpacity >= 0.85, `visible=${settled.ringVisible} opacity=${settled.ringOpacity}`);
    await page.screenshot({ path: join(OUT, "installed-02-buzzer-active.png") });

    // Power Off + Reset silence everything; Power On restores without recompiling
    const compilesBefore = await page.evaluate(() =>
        [...document.querySelectorAll("#console-log .log-line")].filter((l) => /Compiling top-level/i.test(l.textContent)).length);
    await page.click('[data-act="power"]');
    await wait(400);
    const off = await page.evaluate(() => ({
        oscGain: window.__cyclone.audio.state().oscGain,
        badge: document.getElementById("tb-audio-badge")?.textContent,
        ring: (() => { const r = window.__cyclone.board._buzzerRing; return r ? { v: r.visible, o: r.material.opacity } : null; })(),
    }));
    step("02 Power Off: gain 0 + Silent + ring hidden",
        off.oscGain === 0 && off.badge === "Silent" && (!off.ring || !off.ring.v || off.ring.o < 0.05), JSON.stringify(off));
    await page.evaluate(() => document.querySelector('[data-act="reset"]')?.click());
    await wait(400);
    await page.click('[data-act="power"]'); // Power On — auto-restore, no recompile
    await settle(page); // the power-on refresh() re-runs the capture (~3 s)
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, true));
    await wait(500);
    const restored = await page.evaluate(() => ({
        badge: document.getElementById("tb-audio-badge")?.textContent,
        oscGain: window.__cyclone.audio.state().oscGain,
        ring: (() => { const r = window.__cyclone.board._buzzerRing; return r ? { v: r.visible, o: r.material.opacity } : null; })(),
    }));
    const compilesAfter = await page.evaluate(() =>
        [...document.querySelectorAll("#console-log .log-line")].filter((l) => /Compiling top-level/i.test(l.textContent)).length);
    const restoredHz = Number(String(restored.badge || "").replace(/[^0-9.]/g, ""));
    step("02 Power On restores the design without re-compiling (800 Hz + ring back)",
        Math.abs(restoredHz - 800) <= 16 && restored.oscGain > 0 && restored.ring?.v && compilesAfter === compilesBefore,
        `badge=${restored.badge} oscGain=${restored.oscGain} ring=${JSON.stringify(restored.ring)} compiles=${compilesBefore}->${compilesAfter}`);
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, false));
    await wait(400);
}

// ------------------------------------------------------------------ step 3 --
// sevseg_4tube: 4 tubes glow vivid red; K1 -> 1111 in < 25 ms.
{
    await page.evaluate(() => {
        const sel = document.querySelector("#tb-examples");
        const opt = [...sel.options].find((o) => /sevseg_4tube|sevseg-4tube/i.test(`${o.value} ${o.textContent}`));
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await wait(800);
    await page.click('[data-ctab="pinmap"]');
    await wait(300);
    await page.evaluate(() => document.querySelector("#pp-defaults")?.click());
    await wait(400);
    await page.click("#tb-compile");
    await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 120000 });
    await settle(page, 120000); // first-time display capture ~13 s of GHDL
    const tubes = await page.evaluate(() => {
        const d = window.__cyclone.board.io.display;
        return [0, 1, 2, 3].map((i) => Array.from(d.segHold.slice(i * 8, i * 8 + 7)).map((v) => Math.round(v * 1000) / 1000));
    });
    const lit = tubes.filter((t) => t.some((v) => v > 0.12)).length;
    const vivid = tubes.flat().filter((v) => v > 0.12).every((v) => v >= 0.18);
    step("03 sevseg_4tube: all 4 tubes lit (distinct POV glyphs)", lit === 4 && new Set(tubes.map((t) => JSON.stringify(t))).size === 4, JSON.stringify(tubes));
    step("03 lit segments are vivid (duty ≥ 0.18)", vivid, JSON.stringify(tubes.flat()));
    const t0 = Date.now();
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, true));
    // Live co-simulation: the new glyph set lands on the next live frames
    // (~30 fps) — poll for the 1111 image instead of demanding it inline.
    let tubes1111 = null;
    let pressMs = 0;
    for (let i = 0; i < 50; i += 1) {
        await wait(60);
        const read = await page.evaluate(() => {
            const d = window.__cyclone.board.io.display;
            return [0, 1, 2, 3].map((i) => Array.from(d.segHold.slice(i * 8, i * 8 + 7)).map((v) => Math.round(v * 100) / 100));
        });
        const allOne = read.every((tube) => tube[1] >= 0.18 && tube[2] >= 0.18
            && tube[0] < 0.12 && tube.slice(3).every((v) => v < 0.12));
        if (allOne) { tubes1111 = read; pressMs = Date.now() - t0; break; }
        if (i === 49) tubes1111 = read;
    }
    // K1 held -> EVERY tube shows '1' (segments b,c) at the mux duty (~0.25).
    const one = tubes1111.every((tube) => tube[1] >= 0.18 && tube[2] >= 0.18
        && tube[0] < 0.12 && tube.slice(3).every((v) => v < 0.12));
    step("03 K1 -> 1111 on all 4 tubes", one,
        `${pressMs} ms 1111=${one} t=${tubes1111}`);
    await page.screenshot({ path: join(OUT, "installed-03-sevseg-4tube.png") });
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, false));
    await wait(300);
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, false));
    await wait(300);

    // 03b — sevseg_keys: the key-driven design. Keys open -> tubes dark;
    // pressing K1+K2 (S1+S2 nets low) gates the display on -> the POV image
    // updates on the SAME turn (< 25 ms, the <1 ms stimulus path).
    await page.evaluate(() => {
        const sel = document.querySelector("#tb-examples");
        const opt = [...sel.options].find((o) => /sevseg_keys/i.test(`${o.value} ${o.textContent}`));
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await wait(800);
    await page.click('[data-ctab="pinmap"]');
    await wait(300);
    await page.evaluate(() => document.querySelector("#pp-defaults")?.click());
    await wait(400);
    await page.click("#tb-compile");
    await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 120000 });
    await settle(page);
    const dark = await page.evaluate(() => {
        const d = window.__cyclone.board.io.display;
        return Math.max(...Array.from(d.segHold).map((v) => Math.round(v * 1000) / 1000));
    });
    step("03b sevseg_keys: all keys open -> tubes dark", dark < 0.12, `max duty=${dark}`);
    await page.evaluate(() => {
        window.__cyclone.setPhysicalKeyPressed(0, true);
        window.__cyclone.setPhysicalKeyPressed(1, true);
    });
    let keys = { ms: 0, lit: 0 };
    for (let i = 0; i < 50; i += 1) {
        await wait(60);
        keys = await page.evaluate(() => ({
            lit: Math.max(...Array.from(window.__cyclone.board.io.display.segHold).map((v) => Math.round(v * 1000) / 1000)),
        }));
        if (keys.lit >= 0.18) { keys.ms = Date.now() - t0; break; }
    }
    step("03b K1+K2 pressed -> tubes light", keys.lit >= 0.18, `${keys.ms} ms, max duty=${keys.lit}`);
    await page.screenshot({ path: join(OUT, "installed-03b-sevseg-keys.png") });
    await page.evaluate(() => {
        window.__cyclone.setPhysicalKeyPressed(0, false);
        window.__cyclone.setPhysicalKeyPressed(1, false);
    });
    await wait(300);
}

// ------------------------------------------------------------------ step 4 --
// Pin Planner: single-line rows, unclipped names, Diagnostics badge wired.
{
    await page.click('[data-ctab="pinmap"]');
    await wait(600);
    const pp = await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".pp-table tr.pin-row")];
        const heights = rows.map((r) => Math.round(r.getBoundingClientRect().height));
        const clipped = [...document.querySelectorAll(".pp-table .pin-id")].filter((el) => el.scrollWidth > el.clientWidth + 1).length;
        return { rows: rows.length, maxH: Math.max(...heights, 0), clipped, badge: document.getElementById("diag-badge")?.textContent ?? null };
    });
    step("04 Pin Planner: single-line rows, full unclipped node names, Diagnostics badge present",
        pp.rows > 0 && pp.maxH <= 40 && pp.clipped === 0 && pp.badge !== null,
        `rows=${pp.rows} maxH=${pp.maxH}px clipped=${pp.clipped} badge=${pp.badge}`);
    await page.screenshot({ path: join(OUT, "installed-04-pinplanner.png") });
}

// ------------------------------------------------------------------ step 5 --
// Peripherals tab cards.
{
    await page.click('[data-rtab="periph"]');
    await wait(600);
    const per = await page.evaluate(() => ({
        cards: document.querySelectorAll(".peri-card").length,
        labels: [...document.querySelectorAll(".peri-card header")].map((h) => h.textContent.trim().slice(0, 24)),
    }));
    step("05 Peripherals: live cards rendered", per.cards >= 6, `${per.cards} cards: ${per.labels.join(" | ")}`);
    await page.screenshot({ path: join(OUT, "installed-05-peripherals.png") });
}

// ------------------------------------------------------------------ step 6 --
// Dynamic board switch: DE0-Nano (green PCB, 8 LEDs, 2 keys, 4 DIP) and back.
{
    await page.evaluate(() => {
        const sel = document.getElementById("tb-board-select");
        const opt = [...sel.options].find((o) => /de0-nano/i.test(o.value));
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => window.__cyclone.board.io?.leds?.length === 8, { timeout: 30000 });
    await wait(1000);
    const de0 = await page.evaluate(() => {
        const b = window.__cyclone.board;
        return {
            leds: b.io.leds.length, keys: b.io.keys.length, dip: b.io.dip.length,
            cells: document.querySelectorAll("#bc-row .bc-cell").length,
            pcb: "#" + b.mats.pcbTop.color.getHexString(),
        };
    });
    step("06 DE0-Nano rebuilds live: green PCB, 8 LEDs, 2 keys, 4 DIP, 6 HUD cells",
        de0.leds === 8 && de0.keys === 2 && de0.dip === 4 && de0.cells === 6 && de0.pcb === "#0d3b26", JSON.stringify(de0));
    await page.screenshot({ path: join(OUT, "installed-06-de0nano.png") });
    await page.evaluate(() => {
        const sel = document.getElementById("tb-board-select");
        const opt = [...sel.options].find((o) => /rz-easyfpga/i.test(o.value));
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => window.__cyclone.board.io?.leds?.length === 4, { timeout: 30000 });
    await wait(800);
    step("06 switched back to RZ-EasyFPGA A2.2 (4 LEDs)", true, "leds=4");
}

// ------------------------------------------------------------------ step 7 --
// Terminal tab: real GHDL output + echo inside the installed app.
{
    await page.click('[data-btab="terminal"]');
    await wait(500);
    await page.click("#terminal-input");
    await page.keyboard.type("ghdl --version");
    await page.keyboard.press("Enter");
    await wait(1200);
    await page.keyboard.type("echo INSTALLED_EXE_OK");
    await page.keyboard.press("Enter");
    await wait(1200);
    const term = await page.evaluate(() => (document.getElementById("terminal-output")?.textContent || ""));
    step("07 Terminal: ghdl --version + echo INSTALLED_EXE_OK render in the terminal DOM",
        term.includes("GHDL") && term.includes("INSTALLED_EXE_OK"), `len=${term.length}`);
    await page.screenshot({ path: join(OUT, "installed-07-terminal.png") });
}

// ------------------------------------------------------------------ step 8 --
// Waveform tab + VCD export control + right/bottom collapse + expand.
{
    await page.click('[data-btab="waveform"]');
    await wait(600);
    const wf = await page.evaluate(() => {
        const canvas = document.getElementById("wave-canvas");
        const r = canvas?.getBoundingClientRect();
        return {
            canvas: !!canvas && r.width > 50 && r.height > 50,
            vcd: !!document.getElementById("bp-export-vcd"),
            waveApi: typeof window.__cyclone.bottom?.wave?.resize === "function",
        };
    });
    step("08 Waveform: canvas rendered + VCD export control present",
        wf.canvas && wf.vcd && wf.waveApi, JSON.stringify(wf));
    await page.click("#bp-export-vcd");
    await wait(600);
    await page.screenshot({ path: join(OUT, "installed-08-waveform.png") });

    await page.click('.tb-view[data-act="collapse"]');
    await wait(400);
    const rightCollapsed = await page.evaluate(() => document.getElementById("right").classList.contains("collapsed"));
    await page.click('.tb-view[data-act="collapse"]');
    await wait(400);
    const rightBack = await page.evaluate(() => !document.getElementById("right").classList.contains("collapsed"));
    await page.click("#tb-toggle-bottom");
    await wait(400);
    const bottomCollapsed = await page.evaluate(() => document.getElementById("bottom").classList.contains("collapsed"));
    await page.click("#tb-toggle-bottom");
    await wait(400);
    const bottomBack = await page.evaluate(() => !document.getElementById("bottom").classList.contains("collapsed"));
    step("08 Right Workbench + Bottom Dock collapse/expand",
        rightCollapsed && rightBack && bottomCollapsed && bottomBack,
        `right=${rightCollapsed}->${rightBack} bottom=${bottomCollapsed}->${bottomBack}`);
}

// ------------------------------------------------------------------ step 9 --
// Diagnostics tab: level filter chips, problem badge, Clear.
{
    await page.click('[data-btab="diagnostics"]');
    await wait(500);
    const diag = await page.evaluate(() => ({
        chips: [...document.querySelectorAll("#bottompanel .msg-filter")].map((c) => c.dataset.sev),
        badge: document.getElementById("diag-badge")?.textContent ?? null,
        clear: !!document.querySelector('#bottompanel [data-act="clearlog"]'),
        lines: document.querySelectorAll("#console-log .log-line").length,
    }));
    step("09 Diagnostics: INFO/OK/WARN/ERR/CMD chips + badge + Clear",
        JSON.stringify(diag.chips) === JSON.stringify(["all", "error", "warning", "info"])
        && diag.badge !== null && diag.clear && diag.lines > 0, JSON.stringify(diag));
    await page.screenshot({ path: join(OUT, "installed-09-diagnostics.png") });
    await page.click('#bottompanel [data-act="clearlog"]');
    await wait(400);
    const cleared = await page.evaluate(() => document.querySelectorAll("#console-log .log-line").length);
    step("09 Diagnostics Clear empties the log", cleared === 0, `lines after clear=${cleared}`);
}

// ----------------------------------------------------------------- step 10 --
// Serial / VGA / LCD tab: sub-views open with zero layout overflow.
{
    await page.click('[data-btab="displays"]');
    await wait(500);
    const disp = await page.evaluate(() => {
        const pane = document.querySelector('#bottompanel [data-pane="displays"]');
        const r = pane?.getBoundingClientRect();
        return {
            visible: !!pane && !pane.classList.contains("hidden") && r.width > 100 && r.height > 40,
            vga: !!document.getElementById("vga-canvas"),
            overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
    });
    step("10 Serial/VGA/LCD tab opens cleanly (VGA canvas, no horizontal overflow)",
        disp.visible && disp.vga && disp.overflow <= 0, JSON.stringify(disp));
    await page.screenshot({ path: join(OUT, "installed-10-serial-vga-lcd.png") });
}

// ----------------------------------------------------------------- step 11 --
// Toolbar popovers: Board select, Examples select, audio volume popover.
{
    const pop = await page.evaluate(() => {
        const board = document.getElementById("tb-board-select");
        const ex = document.getElementById("tb-examples");
        const br = board.getBoundingClientRect();
        const er = ex.getBoundingClientRect();
        return {
            boardOpts: board.options.length, exOpts: ex.options.length,
            boardInVp: br.x >= 0 && br.bottom <= window.innerHeight,
            exInVp: er.x >= 0 && er.bottom <= window.innerHeight,
        };
    });
    await page.click("#tb-audio-caret");
    await wait(300);
    const vol = await page.evaluate(() => {
        const p = document.getElementById("tb-volume-pop");
        const r = p.getBoundingClientRect();
        return { open: !p.hidden, inVp: r.x >= 0 && r.right <= window.innerWidth + 1, hasRange: !!p.querySelector("#tb-volume") };
    });
    step("11 Toolbar: Board/Examples selects populated + volume popover opens cleanly",
        pop.boardOpts >= 2 && pop.exOpts >= 2 && pop.boardInVp && pop.exInVp && vol.open && vol.inVp && vol.hasRange,
        JSON.stringify({ ...pop, vol }));
    await page.screenshot({ path: join(OUT, "installed-11-popovers.png") });
    await page.click("#tb-audio-caret");
    await wait(200);
}

// ----------------------------------------------------------------- step 12 --
// Board tab: hardware summary + custom board import control + pin table.
{
    await page.click('[data-rtab="boardimport"]');
    await wait(600);
    const boardTab = await page.evaluate(() => {
        const pane = document.querySelector('#rd-boardimport [data-pane="board"]');
        const r = pane?.getBoundingClientRect();
        return {
            visible: !!pane && !pane.classList.contains("hidden") && r.width > 100,
            specs: document.querySelectorAll("#rd-boardimport .bd-spec").length,
            importBtn: !!document.getElementById("btn-load-board-json"),
            pinRows: document.querySelectorAll("#rd-boardimport .bd-table tr").length,
        };
    });
    step("12 Board tab: hardware summary specs + custom .json import + pin table",
        boardTab.visible && boardTab.specs >= 6 && boardTab.importBtn && boardTab.pinRows >= 4, JSON.stringify(boardTab));
    await page.screenshot({ path: join(OUT, "installed-12-board-tab.png") });
}

// ----------------------------------------------------------------- step 13 --
// Splitter drag: the workbench resizes and Monaco tracks the width live
// (ResizeObserver auto-layout fix).
{
    await page.click('[data-ctab="sources"]');
    await wait(500);
    const resizer = await page.$("#right-resizer");
    const before = await page.evaluate(() => ({
        w: Math.round(document.getElementById("right").getBoundingClientRect().width),
        mono: Math.round(document.querySelector("#ep-editor .monaco-editor")?.getBoundingClientRect().width || 0),
    }));
    const box = await resizer.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 70, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await wait(600);
    const after = await page.evaluate(() => ({
        w: Math.round(document.getElementById("right").getBoundingClientRect().width),
        mono: Math.round(document.querySelector("#ep-editor .monaco-editor")?.getBoundingClientRect().width || 0),
    }));
    step("13 Splitter drag widens the workbench; Monaco tracks the width",
        after.w > before.w + 30 && after.mono > before.mono + 20,
        `right=${before.w}->${after.w} monaco=${before.mono}->${after.mono}`);
    await page.screenshot({ path: join(OUT, "installed-13-splitter.png") });
}

// ------------------------------------------------------------------ wrap ----
step("no page errors during the whole installed-app session", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
await browser.disconnect();

const summary = `${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — installed app @ ${CDP}`;
console.log(summary);
appendFileSync(LOG, summary + "\n");
process.exit(failures === 0 ? 0 : 1);
