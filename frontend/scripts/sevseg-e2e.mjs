// sevseg-e2e.mjs — UI end-to-end proof for the 4-digit tube display.
//
// Loads the sevseg_keys example (user's textbook code: dtube/seven_seg/s1..s4
// ports), runs it through the styled UI, verifies the 4-tube multiplexed
// values against expectations declared from the design's own equations, then
// toggles the on-screen DIP strip and verifies the display responds like the
// real board (auto re-run).
//
// Usage (from frontend/): node scripts/sevseg-e2e.mjs
import puppeteer from "puppeteer-core";
import { execFile, spawn, spawnSync } from "node:child_process";
import { dirname as _dirname } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";
const __dirname_ps = _dirname(_fileURLToPath(import.meta.url));
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";

const EDGE_CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const OUT = resolve("../tests/.audit-scratch/ui-restyle");
mkdirSync(OUT, { recursive: true });

// ---- expectations declared BEFORE the run, from the design's equations ----
// dtube(i) = not(en_i); en_i = ge and phase; ge = k1 and (k2 or k3 or k4);
// k = not s (active-low keys); phase p3..p0 from cnt(15 downto 14).
// IMPORTANT: the segment lines sa..sg are NOT gated by ge in this design —
// they keep driving the phase pattern; only the digit enables are gated.
// Capture window = 65546 cycles (reset + one full 65536-cycle scan rotation):
// cnt at the end = 65546 mod 65536 = 10 -> cnt(15:14) = 00 -> phase p3.
// All four keys closed (stimulus 0) -> ge = 1:
//   tube index 3 selected -> dtube = 0b0111 = 7;
//   glyph p3: a,b,c,d,f,g on -> seven_seg = not(0b1110111) = 16.
// S1 open (stimulus 1) -> ge = 0 -> every tube unselected: dtube = 0b1111
//   = 15 (display dark — the functional check); seven_seg keeps the p3
//   pattern = 16 (invisible on hardware with no tube selected).
const EXPECT = {
    allClosed_short: { dtube: 7, seven_seg: 16 },   // digit 3 shown, glyph p3
    s1Open: { dtube: 15, seven_seg: 16 },           // ge=0: no tube selected
    s1ClosedAgain: { dtube: 7, seven_seg: 16 },
};

const exe = EDGE_CANDIDATES.find((p) => existsSync(p));
const profileDir = mkdtempSync(join(tmpdir(), "sevseg-e2e-"));
const PORT = 9334;
// Guaranteed cleanup even on a mid-run crash: reap this test's headless
// browsers (matched by the sevseg-e2e- temp-profile prefix, which also covers
// the retry's fresh profile). Leaked SwiftShader browsers peg a CPU core.
function reapOwnBrowser() {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match 'sevseg-e2e-' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    try { spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" }); } catch { /* ignore */ }
}
process.on("exit", reapOwnBrowser);
// snapshot pre-existing browser PIDs — the exit reap kills ONLY newcomers
// (probe-spawned browsers, incl. relaunch roots that lost their marker flags)
const BEFORE_PIDS = spawnSync("powershell", ["-NoProfile", "-Command",
    "(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\").ProcessId -join ','"],
    { encoding: "utf-8" }).stdout.trim();

let child = (function spawnEdge() {
    const c = spawn(exe, [
        "--headless=new", `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${join(profileDir, "p")}`,
        "--no-first-run", "--no-default-browser-check",
        "--disable-features=msStartupBoost",
        "--disable-gpu", "--enable-unsafe-swiftshader",
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-webgl", "--ignore-gpu-blocklist",
        "--window-size=1600,900", "--hide-scrollbars", "about:blank",
    ], { stdio: "ignore", detached: true });
    c.unref();
    return c;
})();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectEdge() {
    // poll the DevTools endpoint first (SwiftShader boots can be slow)
    let ready = false;
    for (let i = 0; i < 90 && !ready; i += 1) {
        await wait(500);
        for (const host of ["127.0.0.1", "localhost"]) {
            try {
                const res = await fetch(`http://${host}:${PORT}/json/version`);
                ready = ready || res.ok;
            } catch { /* not yet */ }
        }
    }
    if (!ready) throw new Error(`Edge DevTools port ${PORT} never opened`);
    return puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: { width: 1600, height: 900 } });
}

let browser = null;
let page = null;
for (let attempt = 1; attempt <= 3 && !page; attempt += 1) {
    try {
        browser = await connectEdge();
        page = await browser.newPage();
        await page.setViewport({ width: 1600, height: 900 });
    } catch (err) {
        console.error(`[attempt ${attempt}] Edge/page setup failed: ${err.message}`);
        try { await browser?.disconnect(); } catch { /* ignore */ }
        browser = null;
        page = null;
        if (child.pid) { try { process.kill(child.pid); } catch { /* ignore */ } }
        await wait(2000);
        child = (function spawnEdge() {
            const c = spawn(exe, [
                "--headless=new", `--remote-debugging-port=${PORT}`,
                `--user-data-dir=${join(mkdtempSync(join(tmpdir(), "sevseg-e2e-")), "p")}`,
                "--no-first-run", "--no-default-browser-check",
                "--disable-gpu", "--enable-unsafe-swiftshader",
                "--use-gl=angle", "--use-angle=swiftshader",
                "--enable-webgl", "--ignore-gpu-blocklist",
                "--window-size=1600,900", "--hide-scrollbars", "about:blank",
            ], { stdio: "ignore", detached: true });
            c.unref();
            return c;
        })();
    }
}
if (!page) {
    console.error("Could not get a working Edge page after 3 attempts");
    process.exit(1);
}
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

const results = { steps: [], errors };
const step = (name, pass, detail) => {
    results.steps.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${detail ?? ""}`);
};

await page.goto("http://127.0.0.1:8000/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => window.__cyclone && document.querySelector("#board-host canvas"), { timeout: 30000 });
await wait(2000);

// 1 — load the example through the sidebar (it appears via /api/examples)
const loaded = await page.evaluate(async () => {
    const ex = (await (await fetch("/api/examples")).json()).examples.find((e) => e.id === "sevseg_keys");
    if (!ex) return null;
    window.__cyclone.editor.setFiles([{ name: ex.file, content: ex.source }], false);
    window.__cyclone.editor.setTopEntity("sevseg");
    return { entity: ex.entity, source: ex.source?.length };
});
step("example listed + loaded", !!loaded, JSON.stringify(loaded));

// 2 — run with the fixed 1.5 ms capture and wait for completion
await page.evaluate(() => window.__cyclone.run());
let done = false;
for (let i = 0; i < 60 && !done; i++) {
    await wait(1000);
    done = await page.evaluate(() =>
        [...document.querySelectorAll("#console-log .log-line")].some((l) => l.textContent.includes("Simulation complete")));
}
const run1 = await page.evaluate(() => {
    const v = window.__cyclone.state.liveValues;
    return {
        dtube: v.dtube, seven_seg: v.seven_seg, s1: v.s1, s2: v.s2,
        totalCycles: window.__cyclone.state.totalCycles,
        stripVisible: !document.getElementById("board-controls").classList.contains("hidden"),
        switches: [...document.querySelectorAll("#bc-row .bc-switch")].map((b) => b.classList.contains("on")),
        stepClasses: [...document.querySelectorAll(".tb-step")].map((s) => s.className.replace("tb-step", "").trim()),
    };
});
step("run completed (pipeline done)", done && run1.stepClasses.every((c) => c.includes("done")), JSON.stringify(run1.stepClasses));
step("DIP strip bound to s1..s4", run1.stripVisible && run1.switches.length === 4, `switches=${JSON.stringify(run1.switches)}`);
step(
    "tubes display p3 glyph with all keys closed",
    run1.dtube === EXPECT.allClosed_short.dtube && run1.seven_seg === EXPECT.allClosed_short.seven_seg,
    `dtube=${run1.dtube} (exp ${EXPECT.allClosed_short.dtube}) seven_seg=${run1.seven_seg} (exp ${EXPECT.allClosed_short.seven_seg})`,
);
await page.screenshot({ path: join(OUT, "03-sevseg-tubes.png") });

// 3 — toggle S1 open on the strip -> auto re-run -> display goes dark
await page.evaluate(() => document.querySelector('#bc-row .bc-switch[data-index="0"]').click());
let done2 = false;
for (let i = 0; i < 90 && !done2; i++) {
    await wait(1000);
    done2 = await page.evaluate(() => {
        const logs = [...document.querySelectorAll("#console-log .log-line")];
        const completes = logs.filter((l) => l.textContent.includes("Simulation complete")).length;
        return completes >= 2;
    });
}
const run2 = await page.evaluate(() => {
    const v = window.__cyclone.state.liveValues;
    return { dtube: v.dtube, seven_seg: v.seven_seg, s1: v.s1 };
});
step(
    "S1 open -> display disabled (auto re-run)",
    done2 && run2.dtube === EXPECT.s1Open.dtube && run2.seven_seg === EXPECT.s1Open.seven_seg && run2.s1 === 1,
    `dtube=${run2.dtube} (exp ${EXPECT.s1Open.dtube}) seven_seg=${run2.seven_seg} (exp ${EXPECT.s1Open.seven_seg}) s1=${run2.s1}`,
);
await page.screenshot({ path: join(OUT, "04-sevseg-dark.png") });

// 4 — close S1 again -> display returns
await page.evaluate(() => document.querySelector('#bc-row .bc-switch[data-index="0"]').click());
let done3 = false;
for (let i = 0; i < 90 && !done3; i++) {
    await wait(1000);
    done3 = await page.evaluate(() => {
        const logs = [...document.querySelectorAll("#console-log .log-line")];
        return logs.filter((l) => l.textContent.includes("Simulation complete")).length >= 3;
    });
}
const run3 = await page.evaluate(() => {
    const v = window.__cyclone.state.liveValues;
    return { dtube: v.dtube, seven_seg: v.seven_seg };
});
step(
    "S1 closed again -> tube lights again",
    done3 && run3.dtube === EXPECT.s1ClosedAgain.dtube && run3.seven_seg === EXPECT.s1ClosedAgain.seven_seg,
    `dtube=${run3.dtube} (exp ${EXPECT.s1ClosedAgain.dtube}) seven_seg=${run3.seven_seg} (exp ${EXPECT.s1ClosedAgain.seven_seg})`,
);

results.expect = EXPECT;
writeFileSync(join(OUT, "sevseg-e2e.json"), JSON.stringify(results, null, 2));
console.log(`\n${results.steps.filter((s) => s.pass).length}/${results.steps.length} steps passed`);

await browser.disconnect();
try { spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch { /* ignore */ }
try {
        spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", resolve(__dirname_ps, "reap-browsers.ps1"), "-BeforePids", BEFORE_PIDS], { stdio: "ignore" });
    } catch { /* ignore */ }
try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 400 }); } catch { /* Edge may linger */ }
process.exit(results.steps.every((s) => s.pass) ? 0 : 1);
