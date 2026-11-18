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
import { join, resolve } from "node:path";

const CDP = process.argv[2] || "http://127.0.0.1:9229";
const OUT = resolve("docs/evidence/installed-app");
const LOG = resolve("docs/evidence/installed-app-e2e.log");
mkdirSync(OUT, { recursive: true });

let failures = 0;
const step = (name, ok, detail = "") => {
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    appendFileSync(LOG, `${ok ? "PASS" : "FAIL"}  ${name}  | ${detail}\n`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ------------------------------------------------------------------ step 1 --
// Code tab + 3D viewport: background, PCB colour, framing, HUD, no duplicates.
{
    const s = await page.evaluate(() => {
        const b = window.__cyclone.board;
        const stats = document.getElementById("stats");
        const pill = document.querySelector(".board-hud-pill");
        // project the board's 8 bounding corners into NDC with the live camera
        const P = b.camera.projectionMatrix.elements;
        const V = b.camera.matrixWorldInverse.elements;
        const proj = (x, y, z) => {
            const vx = V[0] * x + V[4] * y + V[8] * z + V[12];
            const vy = V[1] * x + V[5] * y + V[9] * z + V[13];
            const vz = V[2] * x + V[6] * y + V[10] * z + V[14];
            const vw = V[3] * x + V[7] * y + V[11] * z + V[15];
            const cx = P[0] * vx + P[4] * vy + P[8] * vz + P[12] * vw;
            const cy = P[1] * vx + P[5] * vy + P[9] * vz + P[13] * vw;
            const cw = P[3] * vx + P[7] * vy + P[11] * vz + P[15] * vw;
            return [cx / cw, cy / cw];
        };
        const ndc = [];
        for (const x of [-66, 66]) for (const y of [0, 14]) for (const z of [-52, 52]) ndc.push(...proj(x, y, z));
        return {
            bg: "#" + b.scene.background.getHexString(),
            pcb: "#" + b.mats.pcbTop.color.getHexString(),
            ndcMinX: Math.min(...ndc.map((p) => p[0])).toFixed(3),
            ndcMaxX: Math.max(...ndc.map((p) => p[0])).toFixed(3),
            ndcMinY: Math.min(...ndc.map((p) => p[1])).toFixed(3),
            ndcMaxY: Math.max(...ndc.map((p) => p[1])).toFixed(3),
            statsH: Math.round(stats.getBoundingClientRect().height),
            statsOverflow: stats.scrollWidth - stats.clientWidth,
            pillH: Math.round(pill.getBoundingClientRect().height),
            fps: document.getElementById("st-fps")?.textContent || null,
            epRun: document.querySelectorAll("#ep-run, .ep-run").length,
            epMsgs: document.querySelectorAll("#ep-messages, .ep-msg-list").length,
        };
    });
    step("01 board/viewport: #0a0a0b background + #111315 PCB", s.bg === "#0a0a0b" && s.pcb === "#111315", JSON.stringify(s));
    step("01 board 100% framed (all corners inside NDC ±0.98)",
        Math.abs(s.ndcMinX) <= 0.98 && Math.abs(s.ndcMaxX) <= 0.98 && Math.abs(s.ndcMinY) <= 0.98 && Math.abs(s.ndcMaxY) <= 0.98,
        `x=[${s.ndcMinX},${s.ndcMaxX}] y=[${s.ndcMinY},${s.ndcMaxY}]`);
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
    await page.click("#tb-compile");
    await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 120000 });
    await wait(800);
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
        const st = window.__cyclone.state;
        const ring = window.__cyclone.board._buzzerRing;
        return {
            ms: Math.round((performance.now() - t0) * 100) / 100,
            freq: st.buzzer?.frequency,
            badge: document.getElementById("tb-audio-badge")?.textContent,
            oscGain: window.__cyclone.audio.state().oscGain,
            ringVisible: ring ? ring.visible : null,
            ringOpacity: ring ? Math.round(ring.material.opacity * 1000) / 1000 : null,
        };
    });
    await wait(600);
    const httpCount = await page.evaluate(() => window.__http);
    step("02 K1 press: interactive < 25 ms and ZERO http requests",
        press.ms < 25 && httpCount === 0 && press.freq === 800, `${press.ms} ms, http=${httpCount}, freq=${press.freq}`);
    step("02 audio: badge 800 Hz + oscillator gain > 0",
        press.badge === "800 Hz" && press.oscGain > 0, `badge=${press.badge} oscGain=${press.oscGain}`);
    step("02 SP1 pulse ring visible (opacity ≥ 0.85)",
        press.ringVisible === true && press.ringOpacity >= 0.85, `visible=${press.ringVisible} opacity=${press.ringOpacity}`);
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
    await page.click('[data-act="reset"]');
    await wait(400);
    await page.click('[data-act="power"]'); // Power On — auto-restore, no recompile
    await wait(500);
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, true));
    await wait(500);
    const restored = await page.evaluate(() => ({
        badge: document.getElementById("tb-audio-badge")?.textContent,
        oscGain: window.__cyclone.audio.state().oscGain,
        ring: (() => { const r = window.__cyclone.board._buzzerRing; return r ? { v: r.visible, o: r.material.opacity } : null; })(),
    }));
    const compilesAfter = await page.evaluate(() =>
        [...document.querySelectorAll("#console-log .log-line")].filter((l) => /Compiling top-level/i.test(l.textContent)).length);
    step("02 Power On restores the design without re-compiling (800 Hz + ring back)",
        restored.badge === "800 Hz" && restored.oscGain > 0 && restored.ring?.v && compilesAfter === compilesBefore,
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
    await page.click("#tb-compile");
    await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 120000 });
    await wait(800);
    const tubes = await page.evaluate(() => {
        const d = window.__cyclone.board.io.display;
        return [0, 1, 2, 3].map((i) => Array.from(d.segHold.slice(i * 8, i * 8 + 7)).map((v) => Math.round(v * 1000) / 1000));
    });
    const lit = tubes.filter((t) => t.some((v) => v > 0.12)).length;
    const vivid = tubes.flat().filter((v) => v > 0.12).every((v) => v >= 0.18);
    step("03 sevseg_4tube: all 4 tubes lit (distinct POV glyphs)", lit === 4 && new Set(tubes.map((t) => JSON.stringify(t))).size === 4, JSON.stringify(tubes));
    step("03 lit segments are vivid (duty ≥ 0.18)", vivid, JSON.stringify(tubes.flat()));
    const press = await page.evaluate(() => {
        const t0 = performance.now();
        window.__cyclone.setPhysicalKeyPressed(0, true);
        const d = window.__cyclone.board.io.display;
        const t = [0, 1, 2, 3].map((i) => Array.from(d.segHold.slice(i * 8, i * 8 + 7)).map((v) => Math.round(v * 100) / 100));
        return { ms: Math.round((performance.now() - t0) * 100) / 100, t };
    });
    const one = press.t.every((t) => t[1] > 0.85 && t[2] > 0.85 && t.slice(3).every((v) => v < 0.12) && t[0] < 0.12);
    step("03 K1 -> 1111 on all tubes in < 25 ms", press.ms < 25 && one, `${press.ms} ms ${JSON.stringify(press.t)}`);
    await page.screenshot({ path: join(OUT, "installed-03-sevseg-4tube.png") });
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, false));
    await wait(300);
}

// ------------------------------------------------------------------ step 4 --
// Pin Planner: single-line rows, unclipped names, Diagnostics badge wired.
{
    await page.click('[data-tab="pinmap"]');
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
    await page.click('[data-tab="periph"]');
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

// ------------------------------------------------------------------ wrap ----
step("no page errors during the whole installed-app session", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
await browser.disconnect();

const summary = `${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — installed app @ ${CDP}`;
console.log(summary);
appendFileSync(LOG, summary + "\n");
process.exit(failures === 0 ? 0 : 1);
