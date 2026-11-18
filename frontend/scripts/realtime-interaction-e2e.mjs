// realtime-interaction-e2e.mjs — zero-latency interactive play gate.
//
// Proves that after a compiled design has finished its capture, keys/DIPs are
// resolved CLIENT-SIDE from window.__cyclone.state.stimulusMap:
//   * no /api/ HTTP request and no outbound "run" WS frame during play
//   * every observable board/audio update lands in < 25 ms
//   * the 0.5 s release note and the 4-tube POV image stay correct
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/evidence");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "realtime-interaction-e2e.log");
writeFileSync(LOG, "");
const EXE = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p));
const BASE = process.argv[2] || "http://127.0.0.1:8000/";
const PORT = 9351;
const profileDir = mkdtempSync(join(tmpdir(), "realtime-e2e-"));
let failures = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
function step(name, ok, detail = "") {
    const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`;
    console.log(line);
    appendFileSync(LOG, line + "\n");
    if (!ok) failures += 1;
}
function timing(label, ms, detail = "") {
    const line = `TIMING  ${label}: ${r3(ms)} ms${detail ? "  — " + detail : ""}`;
    appendFileSync(LOG, line + "\n");
}
function reap() {
    const tag = basename(profileDir);
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match '${tag}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    try { spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" }); } catch { /* ignore */ }
}
process.on("exit", reap);

let child = spawn(EXE, [
    "--headless=new", `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(profileDir, "p")}`,
    "--no-first-run", "--no-default-browser-check", "--disable-features=msStartupBoost",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-gpu", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1280,800", "--hide-scrollbars", "about:blank",
], { stdio: "ignore", detached: true });
child.unref();
let ready = false;
for (let i = 0; i < 90 && !ready; i += 1) {
    await wait(500);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); ready = r.ok; } catch { /* not yet */ }
}
if (!ready) { step("browser started", false); process.exit(1); }

let browser = null;
try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: { width: 1280, height: 800 } });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));

    // Instrument WebSocket.send BEFORE the app loads so the terminal and
    // simulation sockets are both counted.
    await page.evaluateOnNewDocument(() => {
        window.__wsRunFrames = 0;
        const originalSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function patchedSend(data) {
            try {
                const msg = typeof data === "string" ? JSON.parse(data) : null;
                if (msg && (msg.type === "run" || msg.run === true)) window.__wsRunFrames += 1;
            } catch { /* non-JSON frames are not run frames */ }
            return originalSend.call(this, data);
        };
    });
    let apiRequests = 0;
    let playActive = false;
    page.on("request", (r) => {
        if (playActive && /\/api\//.test(r.url())) apiRequests += 1;
    });

    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__cyclone?.board && window.__cyclone?.state, { timeout: 60000 });

    const completions = () => page.evaluate(() =>
        [...document.querySelectorAll("#console-log .log-line")]
            .filter((l) => l.textContent.includes("Simulation complete")).length);
    const load = (src, top) => page.evaluate(({ s, t }) => {
        const c = window.__cyclone;
        c.editor.setFiles([{ name: "design.vhd", content: s }], false);
        c.editor.setPinnedTop("design.vhd", t);
        document.querySelector('[data-tab="pinmap"]')?.click();
        document.querySelector("#pp-clear")?.click();
        document.querySelector("#pp-defaults")?.click();
    }, { s: src, t: top });
    const compile = async () => {
        const before = await completions();
        await page.click("#ep-run");
        await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 120000 });
        await page.waitForFunction(() => !!window.__cyclone.state.stimulusMap?.vectors, { timeout: 120000 });
        // Let the capture's sim_done land before measuring interaction; a
        // finishing capture properly re-applies held inputs, but measuring
        // across it would mix stream latency with channel latency.
        const t0 = Date.now();
        for (;;) {
            if ((await completions()) > before && !(await page.evaluate(() => window.__cyclone.state.running))) break;
            if (Date.now() - t0 > 60000) break;
            await wait(200);
        }
        await wait(200);
    };
    const loadSrc = (name) => readFileSync(resolve(HERE, "../../examples", name), "utf8");

    // ------------------------------------------------ buzz_4tone key sweep --
    await load(loadSrc("buzz_4tone.vhd"), "buzz_4tone");
    await compile();
    step("buzz_4tone compiled: stimulusMap populated",
        await page.evaluate(() => !!window.__cyclone.state.stimulusMap?.vectors));

    playActive = true; // interaction window starts: no example loads allowed
    const wsAtPlayStart = await page.evaluate(() => window.__wsRunFrames);
    const latencies = [];

    const press = (index, expected) => page.evaluate((i) => {
        const c = window.__cyclone;
        const t0 = performance.now();
        c.setPhysicalKeyPressed(i, true);
        const dt = performance.now() - t0;
        const a = c.audio.state();
        return { dt, key: !!c.state.keyState[i], freq: c.state.buzzer?.frequency,
            oscFreq: a.oscFreq, oscGain: a.oscGain, active: a.active };
    }, index).then((r) => { latencies.push(r.dt); return r; });

    for (const [index, expected, label] of [
        [0, 500, "KEY1"], [1, 800, "KEY2"], [2, 1000, "KEY3"], [3, 1600, "KEY4"],
    ]) {
        const r = await press(index, expected);
        timing(`${label} press`, r.dt, JSON.stringify(r));
        step(`${label} press -> ${expected} Hz in <25 ms, zero HTTP`,
            r.dt < 25 && r.key && r.freq === expected && r.oscFreq === expected
                && r.oscGain > 0 && r.active && apiRequests === 0,
            `${r3(r.dt)}ms freq=${r.freq} osc=${r.oscFreq} gain=${r3(r.oscGain)} api=${apiRequests}`);
        await page.evaluate((i) => window.__cyclone.setPhysicalKeyPressed(i, false), index);
        await wait(30);
    }

    // Release note: KEY4 held again, then released -> 1600 Hz immediately,
    // then silence after the 25,000,000-cycle (0.5 s @ 50 MHz) countdown.
    await press(3, 1600);
    const release = await page.evaluate(() => {
        const c = window.__cyclone;
        const t0 = performance.now();
        c.setPhysicalKeyPressed(3, false);
        const dt = performance.now() - t0;
        const a = c.audio.state();
        return { dt, freq: c.state.buzzer?.frequency, oscFreq: a.oscFreq, oscGain: a.oscGain,
            countdown: c.state.releaseDeadlineMs - Date.now() };
    });
    latencies.push(release.dt);
    timing("KEY4 release (countdown note starts)", release.dt, JSON.stringify(release));
    step("KEY4 release -> 1600 Hz note stays active immediately (<25 ms)",
        release.dt < 25 && release.freq === 1600 && release.oscFreq === 1600 && release.oscGain > 0,
        `${r3(release.dt)}ms freq=${release.freq} osc=${release.oscFreq} countdown=${release.countdown}ms`);
    await wait(550);
    const silencePoll = await page.evaluate(async () => {
        const c = window.__cyclone;
        const t0 = performance.now();
        for (;;) {
            const a = c.audio.state();
            if (!a.active && a.oscGain === 0) return { silent: true, ms: performance.now() - t0, freq: a.frequency };
            if (performance.now() - t0 > 350) return { silent: false, ms: performance.now() - t0, freq: a.frequency };
            await new Promise((r) => setTimeout(r, 20));
        }
    });
    step("KEY4 release note silences after ~550 ms", silencePoll.silent,
        `after 550ms + ${r3(silencePoll.ms)}ms, freq=${silencePoll.freq}`);

    // DIP toggles: each must update the 3D board and the resolved buzzer
    // state synchronously, with no backend round trip.
    for (let i = 0; i < 4; i += 1) {
        const r = await page.evaluate((idx) => {
            const c = window.__cyclone;
            const before = !!c.state.dipState[idx];
            const t0 = performance.now();
            c.toggleDip(idx);
            const dt = performance.now() - t0;
            const b = c.board;
            const bz = c.state.buzzer || {};
            return {
                dt, before, dip: !!c.state.dipState[idx],
                visual: (b.io?.dip || []).map((d) => !!d.on),
                freq: bz.frequency || 0, tone: !!bz.tone,
                coherent: !!bz.tone === (Number(bz.frequency) > 0),
            };
        }, i);
        latencies.push(r.dt);
        timing(`SW${i + 1} toggle`, r.dt, JSON.stringify(r));
        step(`SW${i + 1} toggle updates 3D board + buzzer state in <25 ms`,
            r.dt < 25 && r.dip !== r.before && r.visual.some((v) => v === r.dip) && r.coherent
                && apiRequests === 0,
            `${r3(r.dt)}ms dip=${r.dip} visual=${JSON.stringify(r.visual)} freq=${r.freq}`);
    }

    playActive = false; // example loading below is not interactive play

    // --------------------------------------------- sevseg_4tube interactive --
    await load(loadSrc("sevseg_4tube.vhd"), "sevseg_4tube");
    await compile();
    const tubes = await page.evaluate(() => {
        const d = window.__cyclone.board.io.display;
        return [0, 1, 2, 3].map((i) => Array.from(d.segHold.slice(i * 8, i * 8 + 7))
            .map((v) => Math.round(v * 1000) / 1000));
    });
    const lit = tubes.map((t) => t.some((v) => v > 0.12));
    const duties = tubes.flat().filter((v) => v > 0.12);
    const dutyOk = duties.length > 0 && duties.every((v) => v >= 0.18 && v <= 0.35);
    step("sevseg_4tube: all four tubes lit at ~1/4 POV duty",
        lit.every(Boolean) && dutyOk, `lit=${JSON.stringify(lit)} duties=${JSON.stringify(duties)}`);

    playActive = true; // second interaction window
    const segToggle = await page.evaluate(() => {
        const c = window.__cyclone;
        const t0 = performance.now();
        c.setPhysicalKeyPressed(0, true);
        const dt = performance.now() - t0;
        const d = c.board.io.display;
        const hold = [0, 1, 2, 3].map((i) => Array.from(d.segHold.slice(i * 8, i * 8 + 7))
            .reduce((a, v) => a + v, 0));
        return { dt, hold, key: !!c.state.keyState[0] };
    });
    latencies.push(segToggle.dt);
    timing("sevseg KEY1 interactive toggle", segToggle.dt, JSON.stringify(segToggle));
    step("sevseg_4tube interactive toggle in <25 ms keeps 4-tube POV image",
        segToggle.dt < 25 && segToggle.key && segToggle.hold.every((v) => v > 0.12)
            && apiRequests === 0,
        `${r3(segToggle.dt)}ms hold=${JSON.stringify(segToggle.hold)}`);
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, false));
    playActive = false;

    // -------------------------------------------------------- hard gates ----
    const duringPlay = apiRequests;
    const wsRunFrames = (await page.evaluate(() => window.__wsRunFrames)) - wsAtPlayStart;
    step("HARD: zero /api/ requests during interactive play", duringPlay === 0, `api=${duringPlay}`);
    step("HARD: zero outbound run WS frames during interactive play", wsRunFrames === 0, `runFrames=${wsRunFrames}`);
    step("HARD: every interaction latency < 25 ms", latencies.every((v) => v < 25),
        `n=${latencies.length} max=${r3(Math.max(...latencies))}ms all=${JSON.stringify(latencies.map(r3))}`);

    appendFileSync(LOG, `SUMMARY  apiDuringPlay=${duringPlay} runFrames=${wsRunFrames} `
        + `interactions=${latencies.length} maxLatencyMs=${r3(Math.max(...latencies))} ${BASE}\n`);
} catch (err) {
    step("e2e completed", false, err?.stack || String(err));
} finally {
    try { await browser?.close(); } catch { /* ignore */ }
    reap();
}
const summary = `${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — ${BASE}`;
console.log(summary);
appendFileSync(LOG, summary + "\n");
process.exit(failures === 0 ? 0 : 1);
