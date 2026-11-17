// board-matrix.mjs — full hardware-behavior matrix through the real UI:
// uploads each reference design via the editor (same code path as upload),
// presses Run, and asserts the 3D board's display/LED state. Scan phases and
// glyph selection are driven through the DIP/keys strip, exactly like the
// physical switches — no simulation configuration exists any more (the
// capture is 65546 cycles at the 50 MHz clock: reset + one full rotation of
// the textbook 16384-cycle/digit scan).
//
// Declared expectations live in GLYPHS + MUX_GLYPH below (bit0 = segment a,
// 1 = lit on the active-low cathodes). End-of-capture counter phases were
// derived from the design equations AND verified against a backend run:
//   seg_hex_sw:    cnt(3:0)  = 10 -> glyph = (10 + sw) & 15
//   seg_mux4sel:   cnt(3:2)  = 2  -> phase = (2 + sw(1:0)) & 3
//   seg_mux_slowsel: cnt(15:14) = 0 -> phase = sw(1:0) & 3
//   counter4:      count = 65544 (65546 edges - 2 reset) -> led nibble = 8
// Usage: node scripts/board-matrix.mjs [baseUrl]
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGNS = resolve(HERE, "../../tests/qa/designs/board");
const OUT = resolve(HERE, "../../tests/.audit-scratch/board-matrix");
mkdirSync(OUT, { recursive: true });

const EXE = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
const PORT = 9339;
const profileDir = mkdtempSync(join(tmpdir(), "board-matrix-"));
let child = spawn(EXE, [
    "--headless=new", `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(profileDir, "p")}`,
    "--no-first-run", "--no-default-browser-check",
    "--disable-features=msStartupBoost",
    "--disable-gpu", "--enable-unsafe-swiftshader",
    "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-webgl", "--ignore-gpu-blocklist",
    "--window-size=1600,900", "--hide-scrollbars", "about:blank",
], { stdio: "ignore", detached: true });
child.unref();

// Guaranteed cleanup: even if an assertion throws mid-run, reap THIS run's
// browser tree by its unique temp profile dir. Headless SwiftShader browsers
// render on the CPU; leaking them pegs a core (the laptop-usability complaint).
const ownProfileTag = basename(profileDir);
function reapOwnBrowser() {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match '${ownProfileTag}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    try { spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" }); } catch { /* ignore */ }
}
process.on("exit", reapOwnBrowser);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 90 && !ready; i += 1) {
    await wait(500);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); ready = r.ok; } catch { /* not yet */ }
}
if (!ready) { console.error("browser debug port never opened"); process.exit(1); }
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: { width: 1600, height: 900 } });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });

const BASE = process.argv[2] || "http://127.0.0.1:8000/";
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__cyclone && window.__cyclone.board, { timeout: 60000 });
await wait(2000);

// ------------------------------------------------------- declared expectations
// Active-low segment bits per glyph, a..g as bit 0..6 (1 = lit).
const GLYPH = {
    0: [1, 1, 1, 1, 1, 1, 0],
    1: [0, 1, 1, 0, 0, 0, 0],
    2: [1, 1, 0, 1, 1, 0, 1],
    3: [1, 1, 1, 1, 0, 0, 1],
    4: [0, 1, 1, 0, 0, 1, 1],
    5: [1, 0, 1, 1, 0, 1, 1],
    6: [1, 0, 1, 1, 1, 1, 1],
    7: [1, 1, 1, 0, 0, 0, 0],
    8: [1, 1, 1, 1, 1, 1, 1],
    9: [1, 1, 1, 1, 0, 1, 1],
    10: [1, 1, 1, 0, 1, 1, 1], // A
    11: [0, 0, 1, 1, 1, 1, 1], // B
    12: [1, 0, 0, 1, 1, 1, 0], // C
    13: [0, 1, 1, 1, 1, 0, 1], // D
    14: [1, 0, 0, 1, 1, 1, 1], // E
    15: [1, 0, 0, 0, 1, 1, 1], // F
};
// digit index d -> expected glyph for the mux designs ('1','2','3','4')
const MUX_GLYPH = { 0: GLYPH[1], 1: GLYPH[2], 2: GLYPH[3], 3: GLYPH[4] };

const results = [];
const step = (name, pass, detail = "") => {
    results.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
    // persist incrementally so a mid-run crash still leaves the progress
    try { writeFileSync(join(OUT, "matrix.json"), JSON.stringify(results, null, 2)); } catch { /* ignore */ }
};

const design = (name) => readFileSync(join(DESIGNS, name), "utf-8");

async function upload(name, entity) {
    const src = design(name);
    await page.evaluate((n, s, e) => {
        const c = window.__cyclone;
        c.editor.setFiles([{ name: n, content: s }], false);
        c.editor.setTopEntity(e);
        // strictPins: the backend only sees explicit assignments, so reset and
        // apply the board defaults for the new top entity.
        document.querySelector('[data-tab="pinmap"]')?.click();
        document.querySelector("#pp-clear")?.click();
        document.querySelector("#pp-defaults")?.click();
    }, name, src, entity);
    await wait(250);
}

const completions = () => page.evaluate(() =>
    [...document.querySelectorAll("#console-log .log-line")]
        .filter((l) => l.textContent.includes("Simulation complete")).length);

async function waitRunComplete(before, timeoutMs = 60000) {
    const t0 = Date.now();
    for (;;) {
        await wait(350);
        const n = await completions();
        if (n > before) return true;
        if (Date.now() - t0 > timeoutMs) return false;
    }
}

// Wait until a run completed AND the session stays idle for two consecutive
// polls. A DIP change can fire several debounced re-runs; waiting for the
// first completion would read a stale intermediate state, so wait for the
// LAST one to finish and the board to settle.
async function waitSettled(before, timeoutMs = 60000) {
    const t0 = Date.now();
    let idleStreak = 0;
    for (;;) {
        await wait(300);
        const s = await page.evaluate(() => ({
            n: [...document.querySelectorAll("#console-log .log-line")]
                .filter((l) => l.textContent.includes("Simulation complete")).length,
            running: window.__cyclone.state.running,
            paused: window.__cyclone.state.paused,
        }));
        idleStreak = (s.n > before && !s.running && !s.paused) ? idleStreak + 1 : 0;
        if (idleStreak >= 2) return true;
        if (Date.now() - t0 > timeoutMs) return false;
    }
}

async function runAndWait(timeoutMs = 60000) {
    const before = await completions();
    await page.evaluate(() => window.__cyclone.run());
    const ok = await waitRunComplete(before, timeoutMs);
    await wait(250);
    if (!ok) {
        const logs = await page.evaluate(() =>
            [...document.querySelectorAll("#console-log .log-line")].slice(-6).map((l) => l.textContent.trim()));
        console.log(`  [runAndWait] run did NOT complete — logs: ${JSON.stringify(logs)}`);
    }
    return { ok };
}

// Set the shared KEY net to the 4-bit value v (ON/closed = bit 0) and re-run.
// The stimulus is set deterministically through the editor (the same store the
// DIP strip writes) and the strip visuals are synced, then ONE run is fired —
// incremental switch clicks race the 250 ms re-run debounce and can simulate an
// intermediate value. The physical click -> stimulus path is proven separately
// by M10 (3D key press uses the same driveKeyNet handler as the strip).
async function setSw(v) {
    const before = await completions();
    const changed = await page.evaluate((val) => {
        const btns = [...document.querySelectorAll("#bc-row .bc-dip")];
        if (!btns.length) return false;
        for (const btn of btns) {
            const i = Number(btn.dataset.index);
            const want = ((val >> i) & 1) === 0; // ON/closed = bit 0
            if (btn.classList.contains("on") !== want) btn.click();
        }
        return true;
    }, v);
    if (!changed) return false;
    const ok = await waitSettled(before);
    await wait(250);
    return ok;
}

const display = () => page.evaluate(() => {
    const b = window.__cyclone.board;
    const d = b.io?.display || {};
    return {
        segTarget: d.segTarget ? Array.from(d.segTarget) : [],
        segCurrent: d.segCurrent ? Array.from(d.segCurrent).map((v) => Math.round(v * 1000) / 1000) : [],
        digitOn: d.digitOn ? [...d.digitOn] : [],
        ledLevels: (b.io?.leds || []).map((l) => Number(l.level.toFixed(3))),
        swState: [...document.querySelectorAll("#bc-row .bc-switch")].map((b) => b.classList.contains("on")),
    };
});

// per-digit segTarget slice (bit 0 = segment a)
const slice = (disp, d) => disp.segTarget.slice(d * 8, d * 8 + 7);
const eqArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const gl = (n) => GLYPH[n];

// ---------------------------------------------------------------- M1 boot/UI
const boot = await page.evaluate(() => ({
    tab: document.querySelector(".ep-tab")?.textContent?.trim(),
    entity: window.__cyclone.state.entity?.name
        || (window.__cyclone.editor.getActiveFile?.() || "").replace(/\.[^.]+$/, ""),
    setupGone: !document.querySelector(".ep-simsetup"),
    headerRunGone: !document.querySelector("#toolbar [data-act='run']"),
    stimuliBtnGone: !document.querySelector(".ep-stimuli-btn"),
    overlayGone: !document.querySelector(".board-overlay"),
    sidebarRun: !!document.querySelector("#ep-run"),
    gpu: window.__cyclone.board.gpuName,
    gpuSw: window.__cyclone.board.gpuIsSoftware,
}));
step("M1 default example = sevseg_keys; sim-setup panel, header Run, Stimuli button and Not-programmed overlay removed; sidebar Run is the only Run",
    (boot.tab === "VHDsevseg_keys.vhd" || /sevseg_keys\.vhd/.test(boot.tab || "")) && boot.entity === "sevseg_keys" && boot.setupGone && boot.headerRunGone && boot.stimuliBtnGone && boot.overlayGone && boot.sidebarRun,
    `tab=${boot.tab} entity=${boot.entity}`);
step("M1 GPU renderer reported (headless probes use SwiftShader; real browsers report the GPU)",
    typeof boot.gpu === "string" && boot.gpu.length > 0, `${boot.gpu} (software=${boot.gpuSw})`);

// ------------------------------------- M0 unprogrammed board: inert but orbitable
{
    const inert = await page.evaluate(() => {
        const b = window.__cyclone.board;
        return {
            programmed: b.programmed,
            running: b.running,
            leds: b.io.leds.map((l) => l.level),
            segSum: Array.from(b.io.display.segCurrent).reduce((a, v) => a + v, 0),
        };
    });
    // orbit drag on the canvas must move the camera even with no program
    const cam0 = await page.evaluate(() => window.__cyclone.board.camera.position.toArray());
    const box = await page.evaluate(() => {
        const r = window.__cyclone.board.renderer.domElement.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 40, { steps: 8 });
    await page.mouse.up();
    await wait(400);
    const cam1 = await page.evaluate(() => window.__cyclone.board.camera.position.toArray());
    const moved = Math.hypot(cam1[0] - cam0[0], cam1[1] - cam0[1], cam1[2] - cam0[2]) > 1;
    step("M0 unprogrammed board is inert (no LEDs/segments) and the 3D view still orbits",
        !inert.programmed && !inert.running && inert.leds.every((v) => v < 0.05) && inert.segSum < 0.5 && moved,
        `programmed=${inert.programmed} leds=${JSON.stringify(inert.leds)} cameraMoved=${moved}`);
}

// --------------------------------------------- M2 hex glyphs 0-F on digit 0
try {
await upload("seg_hex_sw.vhd", "seg_hex_sw");
await runAndWait();
let m2pass = true;
const m2detail = [];
for (let v = 0; v < 16; v += 1) {
    await setSw(v);
    const disp = await display();
    const got = slice(disp, 0);
    // the design shows glyph = sw (pure DIP selection); the strip drives sw = v
    const want = gl(v);
    if (!eqArr(got, want)) { m2pass = false; m2detail.push(`sw=${v} got[${got}] want[${want}]`); }
    // digit 0 (rightmost tube) must be the only one selected
    if (disp.digitOn[0] !== 1 || disp.digitOn.slice(1).some((x) => x !== 0)) {
        m2pass = false; m2detail.push(`sw=${v} digitOn=[${disp.digitOn}]`);
    }
}
step("M2 hex glyphs 0-F on digit 0 (rightmost tube), walked via the DIP strip", m2pass, m2detail.join("; ").slice(0, 240));
} catch (e) { step("M2 hex glyphs 0-F on digit 0 (rightmost tube), walked via the DIP strip", false, String(e).slice(0, 180)); }

// --------------------------------------- M3 all four digits, different glyphs
await upload("seg_mux4sel.vhd", "seg_mux4sel");
await runAndWait();
let m3pass = true;
const m3detail = [];
for (let v = 0; v < 4; v += 1) {
    await setSw(v);
    const disp = await display();
    const phase = (2 + v) % 4; // capture end: cnt(3:2)=2, so phase = (2 + sw(1:0)) & 3
    for (let dig = 0; dig < 4; dig += 1) {
        const got = slice(disp, dig);
        const want = dig === phase ? MUX_GLYPH[dig] : [0, 0, 0, 0, 0, 0, 0];
        if (!eqArr(got, want)) { m3pass = false; m3detail.push(`sw=${v} phase${phase} dig${dig} got[${got}]`); }
    }
}
step("M3 multiplexed: all four tubes show DIFFERENT glyphs ('1'..'4') via scan", m3pass, m3detail.join("; ").slice(0, 240));
await page.screenshot({ path: join(OUT, "mux4-state.png") });

// --------------------------------------------------- M4 segment order a / g
await upload("seg_order_a_d0.vhd", "seg_order_a_d0");
await runAndWait();
let d4 = await display();
step("M4a digit 0 + segment 'a' only -> rightmost tube, segment a lit", eqArr(slice(d4, 0), [1, 0, 0, 0, 0, 0, 0]) && slice(d4, 3).every((v) => v === 0), JSON.stringify(slice(d4, 0)));

await upload("seg_order_g_d3.vhd", "seg_order_g_d3");
await runAndWait();
d4 = await display();
step("M4b digit 3 + segment 'g' only -> LEFTMOST tube, segment g lit", eqArr(slice(d4, 3), [0, 0, 0, 0, 0, 0, 1]) && slice(d4, 0).every((v) => v === 0), JSON.stringify(slice(d4, 3)));

// ------------------------------------------------------------- M5 polarity
await upload("seg_polarity_inverted.vhd", "seg_polarity_inverted");
await runAndWait();
d4 = await display();
const allDark = d4.segTarget.every((v) => v === 0);
step("M5 polarity: active-high 'lit' code keeps every tube DARK (board is active-low)", allDark, `segTarget sum=${d4.segTarget.reduce((a, b) => a + b, 0)}`);

// ---------------------------------------------------------------- M6 all on
await upload("seg_allon.vhd", "seg_allon");
await runAndWait();
d4 = await display();
const litCount = d4.segTarget.reduce((a, b) => a + b, 0);
// a-g on all 4 digits = 28. SEG7/dp is UNDRIVEN by the 7-bit port: unused
// pins are weak-pull-up tri-stated (vendor .qsf), so dp stays OFF — the
// simulator must not read a nonexistent bit 7 as 0 and light it.
const dpOff = [0, 1, 2, 3].every((dig) => d4.segTarget[dig * 8 + 7] === 0);
step("M6 all digits + all segments on -> 28/28 driven segments lit; undriven dp OFF (weak pull-up)", litCount === 28 && dpOff, `lit=${litCount}/28 dpOff=${dpOff}`);
await page.screenshot({ path: join(OUT, "allon-state.png") });

// --------------------------------------------------------------- M7 scan rates
await upload("seg_mux_slowsel.vhd", "seg_mux_slowsel");
await runAndWait();
let m7a = true;
const m7adetail = [];
for (let v = 0; v < 4; v += 1) {
    await setSw(v);
    const disp = await display();
    const phase = v % 4; // capture end: cnt(15:14)=0, so the phase is exactly sw(1:0)
    for (let dig = 0; dig < 4; dig += 1) {
        const got = slice(disp, dig);
        const want = dig === phase ? MUX_GLYPH[dig] : [0, 0, 0, 0, 0, 0, 0];
        if (!eqArr(got, want)) { m7a = false; m7adetail.push(`sw=${v} dig${dig} got[${got}] want[${want}]`); }
    }
}
step("M7a slow scan (16384 cycles/digit): each run ends with exactly ONE tube showing its glyph", m7a, m7adetail.join("; ").slice(0, 240));

// fast scan POV: a multiplexed display integrates all four tubes via the
// persistence-of-vision hold (segHold). After the capture settles, the frozen
// image must show the tubes lit together — the eye sees them simultaneously on
// real hardware. Checking the settled image is deterministic (polling during
// the stream races the render/state timers).
await upload("seg_mux4sel.vhd", "seg_mux4sel");
{
    const before = await completions();
    await page.evaluate(() => window.__cyclone.run());
    await waitSettled(before);
    await wait(400); // let segCurrent ease to the frozen segHold
}
const pov = await page.evaluate(() => {
    const cur = Array.from(window.__cyclone.board.io.display.segCurrent);
    const tubes = [0, 1, 2, 3].map((d) => cur.slice(d * 8, d * 8 + 7));
    return tubes.filter((t) => t.some((v) => v > 0.12)).length;
});
step("M7b fast scan -> persistence of vision (3+ tubes integrate into the held image)", pov >= 3, `simultaneously glowing tubes in the settled POV image: ${pov}`);

// ------------------------------------------------------- M8 LEDs mirror keys
await upload("key_led4.vhd", "key_led4");
await runAndWait();
let led1 = await display();
const allLit = led1.ledLevels.every((v) => v > 0.5);
await setSw(0b0001); // S1 open -> key0 reads 1 -> LED1 dark
let led2 = await display();
const s1Open = led2.ledLevels[0] < 0.5 && led2.ledLevels.slice(1).every((v) => v > 0.5);
await setSw(0b0000); // all closed again
let led3 = await display();
step("M8 keys mirror to LEDs: all closed -> all lit; S1 open -> LED1 dark (bounce-free constant drive)", allLit && s1Open && led3.ledLevels.every((v) => v > 0.5),
    `closed=${JSON.stringify(led1.ledLevels)} open=${JSON.stringify(led2.ledLevels)} reclosed=${JSON.stringify(led3.ledLevels)}`);

// ------------------------------------------------- M9 clock-driven counter
await upload("counter4.vhd", "counter4");
await runAndWait();
const m9 = await display();
const m9led = await page.evaluate(() => window.__cyclone.state.liveValues.led);
// the capture ends at cycle 65545 with reset released after cycle 1 ->
// count = 65544 -> nibble 8 = 0b1000 -> LED1-3 lit (0), LED4 dark (1); this
// exact value requires one increment per clock across all 65544 counted
// cycles and the board's active-low reset asserted for the first 2 cycles.
// LED levels ease asymptotically, so compare lit/dark by threshold.
const wantLit = [true, true, true, false];
const gotLit = m9.ledLevels.map((v) => v > 0.5);
step("M9 clock-driven counter: LED nibble = 8 at cycle 65545 (one increment per clock, 65544 counted cycles, active-low reset)",
    m9led === 8 && eqArr(gotLit, wantLit), `led=${m9led} (expect 8) ledLevels=${JSON.stringify(m9.ledLevels)} lit=${JSON.stringify(gotLit)}`);
await page.screenshot({ path: join(OUT, "counter-final.png") });

// ------------------------------------ M10 3D key press drives the shared net
// Press S1 on the 3D board (pointer events on the key cap, like a finger):
// the stimulus must flip and a re-run must start; release flips back.
// Tested from the all-open state so the press has a visible contrast.
{
    await upload("key_led4.vhd", "key_led4");
    await runAndWait();
    await setSw(0b1111); // all keys open -> stim 15 -> every LED dark
    const openState = await display();
    const before = await completions();
    await page.evaluate(() => window.__cyclone.board.focusComponent("S1"));
    await wait(900); // camera tween frames the key cap
    const pt = await page.evaluate(() => {
        const b = window.__cyclone.board;
        const key = b.io.keys[0];
        const v = key.cap.getWorldPosition(b.camera.position.clone());
        v.project(b.camera);
        const r = b.renderer.domElement.getBoundingClientRect();
        return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
    });
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.down();
    await wait(600); // hold past the 250 ms re-run debounce
    const held = await page.evaluate(() => ({
        pressed: window.__cyclone.board.io.keys[0].pressed,
        stim: window.__cyclone.editor.getStimulusValue("key"),
    }));
    const okPress = await waitRunComplete(before, 60000); // press re-run
    await wait(250);
    const heldLeds = await display();
    await page.mouse.up();
    const okRelease = await waitRunComplete(before + 1, 60000); // release re-run
    await wait(250);
    const after = await page.evaluate(() => ({
        stim: window.__cyclone.editor.getStimulusValue("key"),
        leds: window.__cyclone.board.io.leds.map((l) => Number(l.level.toFixed(2))),
    }));
    // held: key net bit0 = 0 -> LED1 lit, others dark; released: all dark.
    // (The key-cap visual is cleared by resetVisual on re-run, so the proof
    // is the stimulus flip + LED response, not the cap position.)
    const heldOk = heldLeds.ledLevels[0] > 0.5 && heldLeds.ledLevels.slice(1).every((v) => v < 0.5);
    step("M10 3D key press drives the design (press -> key0=0 re-run lights LED1; release -> key0=1 re-run darkens it)",
        openState.ledLevels.every((v) => v < 0.5) && held.stim === 14 && okPress && heldOk
            && okRelease && after.stim === 15 && after.leds.every((v) => v < 0.5),
        `held=${JSON.stringify(held)} heldLeds=${JSON.stringify(heldLeds.ledLevels)} after=${JSON.stringify(after)}`);
}

// ----------------------------------------- M11 power cycle loses the config
{
    const progBefore = await page.evaluate(() => window.__cyclone.board.programmed);
    await page.evaluate(() => document.querySelector('#toolbar [data-act="power"]').click());
    await wait(300);
    const off = await page.evaluate(() => ({
        programmed: window.__cyclone.board.programmed,
        power: window.__cyclone.board.power,
        leds: window.__cyclone.board.io.leds.map((l) => Number(l.level.toFixed(2))),
    }));
    await page.evaluate(() => document.querySelector('#toolbar [data-act="power"]').click());
    await wait(300);
    const on = await page.evaluate(() => ({
        programmed: window.__cyclone.board.programmed,
        power: window.__cyclone.board.power,
    }));
    step("M11 power off clears outputs AND the volatile JTAG config; power on stays unprogrammed until Run",
        progBefore && !off.programmed && !off.power && off.leds.every((v) => v < 0.3) && on.power && !on.programmed,
        `off=${JSON.stringify(off)} on=${JSON.stringify(on)}`);
    // reprogram for the final screenshot
    await runAndWait();
}

// ------------------------------------- M12 run state settles (CPU idle tier)
{
    const settled = await page.evaluate(() => ({
        running: window.__cyclone.board.running,
        programmed: window.__cyclone.board.programmed,
        stateRunning: window.__cyclone.state.running,
    }));
    step("M12 after completion the board leaves the streaming state (render drops to the idle tier)",
        !settled.running && !settled.stateRunning && settled.programmed,
        JSON.stringify(settled));
}

writeFileSync(join(OUT, "matrix.json"), JSON.stringify(results, null, 2));
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} matrix checks passed`);
await browser.disconnect();
try { spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch { /* ignore */ }
try { spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(HERE, "reap-browsers.ps1")], { stdio: "ignore" }); } catch { /* ignore */ }
process.exit(passed === results.length ? 0 : 1);
