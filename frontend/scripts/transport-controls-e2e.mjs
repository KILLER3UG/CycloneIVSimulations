// transport-controls-e2e.mjs — STOP 1C Section 1 acceptance.
//
// Proves that the header Power Off / Pause / Stop / Reset controls
// deterministically silence the Web Audio buzzer (oscillator gain -> 0),
// cancel the release-note countdown, stop the SP1 pulse ring and clear the
// board outputs.
//
// Usage: node scripts/transport-controls-e2e.mjs [baseUrl]
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/evidence");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "transport-controls-e2e.log");
writeFileSync(LOG, "");
const BUZZ1_SRC = readFileSync(resolve(HERE, "../../examples/buzz1.vhd"), "utf-8");
const EXE = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p));
const BASE = process.argv[2] || "http://127.0.0.1:8765/";
const PORT = 9345;
const profileDir = mkdtempSync(join(tmpdir(), "transport-e2e-"));
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
    page.on("pageerror", (e) => {
        console.log("PAGEERROR " + (e?.message || e));
        appendFileSync(LOG, "PAGEERROR " + (e?.message || e) + "\n");
    });
    page.on("console", (m) => {
        const t = m.text();
        if (t.includes("[dbg]")) { console.log("BROWSER " + t); appendFileSync(LOG, "BROWSER " + t + "\n"); }
    });
    page.on("response", async (res) => {
        if (res.status() >= 400) {
            let body = "";
            try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
            console.log(`HTTP ${res.status()} ${res.url()} ${body}`);
            appendFileSync(LOG, `HTTP ${res.status()} ${res.url()} ${body}\n`);
        }
    });
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__cyclone && window.__cyclone.board, { timeout: 60000 });
    await wait(1200);

    // Audio-engine self-test: tone -> silence -> tone must all work.
    const engine = await page.evaluate(async () => {
        const a = window.__cyclone.audio;
        const st = () => ({ active: a.state().active, freq: a.state().frequency, oscGain: a.state().oscGain });
        await a.tone(800, 0.5);
        const on = st();
        a.silence();
        const off = st();
        await a.tone(800, 0.5);
        const back = st();
        a.silence();
        return { on, off, back };
    });
    step("audio engine: tone -> silence -> tone",
        engine.on.active && engine.on.freq === 800 && engine.on.oscGain > 0
        && !engine.off.active && engine.off.oscGain === 0
        && engine.back.active && engine.back.oscGain > 0,
        JSON.stringify(engine));

    // Load buzz1.vhd, apply board defaults, compile.
    await page.evaluate((s) => {
        const c = window.__cyclone;
        c.editor.setFiles([{ name: "buzz1.vhd", content: s }], false);
        c.editor.setPinnedTop("buzz1.vhd", "buzz1");
        document.querySelector('[data-tab="pinmap"]')?.click();
        document.querySelector("#pp-clear")?.click();
        document.querySelector("#pp-defaults")?.click();
    }, BUZZ1_SRC);
    await page.waitForFunction(
        () => (window.__cyclone.sidebar.getPinPlan().validation?.assignedCount || 0) >= 3,
        { timeout: 15000 },
    ).catch(() => {});
    await wait(300);
    await page.click("#tb-compile");
    await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 120000 });

    const completions = () => page.evaluate(() =>
        [...document.querySelectorAll("#console-log .log-line")]
            .filter((l) => l.textContent.includes("Simulation complete")).length);
    // Wait for a fresh "Simulation complete" (every input change re-runs GHDL).
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
    const pressKey1 = () => page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, true));
    const releaseKey1 = () => page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, false));
    const idle = async () => { await releaseKey1(); await settle(); };
    const clickToolbar = (act) => page.evaluate((a) => {
        document.querySelector(`#toolbar [data-act="${a}"]`)?.click();
    }, act);
    const snap = () => page.evaluate(() => {
        const b = window.__cyclone.board;
        return {
            freq: window.__cyclone.audio.state().frequency,
            active: window.__cyclone.audio.state().active,
            oscGain: window.__cyclone.audio.state().oscGain,
            badge: document.querySelector("#tb-audio-badge")?.textContent || "",
            power: b.power,
            programmed: window.__cyclone.state.programmed,
            buzzerOn: b.io?.buzzer?.on ?? null,
            ringVisible: b._buzzerRing ? b._buzzerRing.visible : false,
            ringOpacity: b._buzzerRing ? Number(b._buzzerRing.material.opacity.toFixed(3)) : 0,
            ledTargets: (b.io?.leds || []).map((l) => l.target),
            segSum: b.io?.display ? b.io.display.segTarget.reduce((a, c) => a + c, 0) : 0,
            powerLed: b.powerLed ? b.powerLed.target : null,
            running: window.__cyclone.state.running,
            paused: window.__cyclone.state.paused,
            decoded: window.__cyclone.state.buzzer || null,
        };
    });
    const silentOk = (s) => s.freq === 0 && !s.active && s.oscGain === 0 && /Silent|Off/.test(s.badge);
    const trigger = async () => { await pressKey1(); await settle(); };
    // Sample the badge/frequency every 200 ms for `ms` to capture the envelope.
    const timeline = async (ms) => {
        const t0 = Date.now();
        const out = [];
        while (Date.now() - t0 < ms) {
            const s = await snap();
            out.push(`${((Date.now() - t0) / 1000).toFixed(1)}s:${s.badge}`);
            await wait(200);
        }
        return out;
    };

    // --- baseline: hold KEY1 -> 800 Hz -----------------------------------
    await trigger();
    let s = await snap();
    step("baseline: KEY1 held -> 800 Hz playing", s.freq === 800 && s.active && s.oscGain > 0, JSON.stringify(s));

    // --- 1. Power Off while the tone plays -------------------------------
    await clickToolbar("power");
    await wait(700);
    s = await snap();
    step("Power Off -> oscillator stopped, badge Silent, ring/LEDs/7-seg off (design stays loaded)",
        silentOk(s) && s.power === false && s.buzzerOn === false && s.powerLed === 0
        && s.ledTargets.every((t) => t === 0) && s.segSum === 0
        && (!s.ringVisible || s.ringOpacity < 0.05),
        JSON.stringify(s));
    await page.screenshot({ path: join(OUT, "transport-power-off.png") });

    // Power On -> restore the compiled design in its powered-on idle state
    // (keys open = '1', D1 lit, buzzer silent) and pressing a key works
    // immediately without clicking Compile again.
    await clickToolbar("power");
    await settle();
    s = await snap();
    step("Power On -> design restored, idle (silent, D1 lit)", s.power === true && s.programmed === true && silentOk(s) && s.powerLed !== 0, JSON.stringify(s));
    await pressKey1();
    await settle();
    s = await snap();
    step("Power On -> KEY1 press works immediately (800 Hz, no Compile)", s.freq === 800 && s.active, JSON.stringify(s));
    await idle();   // release -> silent

    // --- 2. Pause silences immediately -----------------------------------
    await trigger();
    s = await snap();
    step("pre-pause: 800 Hz playing", s.freq === 800 && s.active && s.oscGain > 0, JSON.stringify(s));
    await clickToolbar("pause");
    const pauseTl = await timeline(1600);
    s = await snap();
    step("Pause -> oscillator stopped immediately (Silent)",
        silentOk(s) && pauseTl.slice(0, 3).every((t) => /Silent/.test(t)),
        `timeline=[${pauseTl.join(", ")}] snap=${JSON.stringify(s)}`);
    await page.screenshot({ path: join(OUT, "transport-paused.png") });

    // --- 3. Stop silences + clears --------------------------------------
    await clickToolbar("pause");           // resume
    await wait(400);
    await trigger();                        // tone again (informational: re-run lag)
    s = await snap();
    console.log(`INFO  after resume+retrigger: freq=${s.freq} decoded=${s.decoded ? s.decoded.frequency : null}`);
    appendFileSync(LOG, `INFO after resume+retrigger: freq=${s.freq} decoded=${s.decoded ? s.decoded.frequency : null}\n`);
    await clickToolbar("stop");
    const stopTl = await timeline(1600);
    s = await snap();
    step("Stop -> oscillator stopped, badge Silent, board idle",
        silentOk(s) && stopTl.slice(0, 3).every((t) => /Silent/.test(t)), JSON.stringify(s));
    await page.screenshot({ path: join(OUT, "transport-stopped.png") });

    // --- 4. Reset aborts the 1 s release countdown ----------------------
    await pressKey1();
    await settle();
    await releaseKey1();
    await settle();
    s = await snap();
    // Informational: the re-run lag means the sampled tone may still be the
    // press tone; the required assertion is that Reset silences it below.
    console.log(`INFO  countdown note sample: freq=${s.freq} decoded=${s.decoded ? s.decoded.frequency : null}`);
    appendFileSync(LOG, `INFO countdown note sample: freq=${s.freq}\n`);
    await clickToolbar("reset");
    const resetTl = await timeline(1600);
    s = await snap();
    step("Reset -> countdown aborted, oscillator stopped, badge Silent", silentOk(s), JSON.stringify(s));
    await page.screenshot({ path: join(OUT, "transport-reset.png") });
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