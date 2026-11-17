// user-tone-e2e.mjs — definitive tone-selection check for the user's 4-key
// design (btn1..btn4 -> 500/800/1000/1600 Hz, 1 s release note).
//
// Key fact being verified: KEY1..KEY4 share nets with the DIP switches, so the
// design's if/elsif priority encoder sees ALL buttons pressed whenever any
// DIP/key holds a net low. Each step waits for the re-simulation to settle.
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/evidence");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "user-tone-e2e.log");
writeFileSync(LOG, "");
const USER_VHD = resolve(HERE, "../../tests/.audit-scratch/user_buzz_4key.vhd");
const EXE = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p));
const BASE = process.argv[2] || "http://127.0.0.1:8765/";
const PORT = 9344;
const profileDir = mkdtempSync(join(tmpdir(), "user-tone-e2e-"));
let failures = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function step(name, ok, detail = "") {
    const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`;
    console.log(line);
    appendFileSync(LOG, line + "\n");
    if (!ok) failures += 1;
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
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__cyclone && window.__cyclone.board, { timeout: 60000 });
    await wait(1200);

    const src = readFileSync(USER_VHD, "utf-8");
    await page.evaluate((s) => {
        const c = window.__cyclone;
        c.editor.setFiles([{ name: "buzz_4key.vhd", content: s }], false);
        c.editor.setPinnedTop("buzz_4key.vhd", "buzz1");
        document.querySelector('[data-tab="pinmap"]')?.click();
        document.querySelector("#pp-defaults")?.click();
    }, src);
    await page.waitForFunction(
        () => (window.__cyclone.sidebar.getPinPlan().validation?.assignedCount || 0) >= 6,
        { timeout: 15000 },
    ).catch(() => {});
    await wait(300);
    await page.click("#ep-run");
    await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 120000 });

    // Wait until the re-simulation has fully settled (a new "Simulation
    // complete" log line appeared and the app is no longer refreshing).
    const completions = () => page.evaluate(() =>
        [...document.querySelectorAll("#console-log .log-line")]
            .filter((l) => l.textContent.includes("Simulation complete")).length);
    const settle = async (timeoutMs = 30000) => {
        const before = await completions();
        const t0 = Date.now();
        for (;;) {
            await wait(250);
            if ((await completions()) > before) break;
            if (Date.now() - t0 > timeoutMs) break;
        }
        await wait(350);
    };
    const snap = () => page.evaluate(() => ({
        freq: window.__cyclone.audio.state().frequency,
        badge: document.querySelector("#tb-audio-badge")?.textContent || "",
        active: window.__cyclone.audio.state().active,
        decoded: window.__cyclone.state.buzzer ? window.__cyclone.state.buzzer.frequency : null,
        dips: [...document.querySelectorAll("#bc-row .bc-dip")].map((b) => b.classList.contains("on")),
        stim: window.__cyclone.editor.buildStimuli("clk", null).map((s) => `${s.port}=${s.value}`).join(" "),
        payloadStim: (window.__cyclone.state.lastPayload?.stimuli || []).map((s) => `${s.port}=${s.value}`).join(" "),
        perEdges: window.__cyclone.state.lastPeripherals?.buzzer ? (window.__cyclone.state.lastPeripherals.buzzer.edges || []).length : -1,
        perFreq: window.__cyclone.state.lastPeripherals?.buzzer ? window.__cyclone.state.lastPeripherals.buzzer.frequency : null,
        running: window.__cyclone.state.running,
        refreshing: window.__cyclone.state.refreshing,
    }));

    // Close all four DIP switches -> all nets low -> priority picks btn1 (500 Hz)
    await page.evaluate(() => {
        document.querySelectorAll("#bc-row .bc-dip").forEach((b) => { if (!b.classList.contains("on")) b.click(); });
    });
    await settle();
    const allClosed = await snap();
    step("all 4 DIPs ON -> all nets low -> 500 Hz (priority), timer reloads so it never stops",
        allClosed.freq === 500 && allClosed.active,
        `freq=${allClosed.freq} decoded=${allClosed.decoded} stim=${allClosed.stim}`);

    // Open every DIP -> all nets released -> silent
    await page.evaluate(() => {
        document.querySelectorAll("#bc-row .bc-dip").forEach((b) => { if (b.classList.contains("on")) b.click(); });
    });
    await settle();
    const allOpen = await snap();
    step("all DIPs OFF -> Silent", allOpen.freq === 0 && !allOpen.active, `freq=${allOpen.freq}`);

    // One DIP at a time -> that key's tone
    const perDip = [[1, 800], [2, 1000], [3, 1600]];
    for (const [dip, freq] of perDip) {
        await page.evaluate((d) => {
            document.querySelectorAll("#bc-row .bc-dip").forEach((b, i) => {
                const want = i === d;
                if (b.classList.contains("on") !== want) b.click();
            });
        }, dip);
        await settle();
        const s = await snap();
        step(`only DIP${dip + 1} ON -> ${freq} Hz`, s.freq === freq && s.active, `freq=${s.freq} decoded=${s.decoded}`);
    }
    await page.screenshot({ path: join(OUT, "user-tone-dip3-1600hz.png") });

    // Open all, then press+release KEY1 -> 500 Hz note for 1.0 s, then silent
    await page.evaluate(() => {
        document.querySelectorAll("#bc-row .bc-dip").forEach((b) => { if (b.classList.contains("on")) b.click(); });
    });
    await settle();
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, true));
    await settle();
    const pressSnap = await snap();
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, false));
    // sample the note every 200 ms for 2.4 s to see the exact envelope
    const timeline = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
        const s = await snap();
        timeline.push(`${Math.round((Date.now() - t0) / 100) / 10}s:${s.badge}`);
        await wait(200);
    }
    await page.screenshot({ path: join(OUT, "user-tone-release.png") });
    const played = timeline.filter((t) => /Hz/.test(t) && !/Silent/.test(t)).length;
    const silentEnd = timeline.length > 0 && /Silent/.test(timeline[timeline.length - 1]);
    step("press+release KEY1 -> 500 Hz note ~1 s, then Silent",
        played >= 3 && silentEnd && pressSnap.badge.indexOf("500") !== -1,
        `press=${pressSnap.badge} timeline=[${timeline.join(", ")}]`);
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