// sevseg-display-e2e.mjs — 7-segment multiplexing evidence through the real UI.
//
// Loads the bundled sevseg_keys example, applies board defaults, compiles, then
// closes all four DIP switches (the design's `ge` enable). Verifies:
//   * the 4-tube display is driven by the simulated scan (not a static glyph)
//   * the persistence-of-vision image integrates multiple tubes
//   * the DIP strip re-runs the design (live input path)
// Saves screenshots to docs/evidence/.
//
// Usage: node scripts/sevseg-display-e2e.mjs [baseUrl]
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/evidence");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "sevseg-display-e2e.log");
writeFileSync(LOG, "");

const EXE = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
const BASE = process.argv[2] || "http://127.0.0.1:8765/";
const PORT = 9342;
const profileDir = mkdtempSync(join(tmpdir(), "sevseg-display-e2e-"));
let failures = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function step(name, ok, detail = "") {
    const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`;
    console.log(line);
    appendFileSync(LOG, line + "\n");
    if (!ok) failures += 1;
}
function reapOwnBrowser() {
    const tag = basename(profileDir);
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match '${tag.replace(/'/g, "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    try { spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" }); } catch { /* ignore */ }
}
process.on("exit", reapOwnBrowser);

let child = null;
if (EXE) {
    child = spawn(EXE, [
        "--headless=new", `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${join(profileDir, "p")}`,
        "--no-first-run", "--no-default-browser-check",
        "--disable-features=msStartupBoost",
        "--disable-gpu", "--enable-unsafe-swiftshader",
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-webgl", "--ignore-gpu-blocklist",
        "--window-size=1280,800", "--hide-scrollbars", "about:blank",
    ], { stdio: "ignore", detached: true });
    child.unref();
}
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
    await wait(1500);

    await page.waitForFunction(
        () => (window.__cyclone.state.examples || []).some((e) => /sevseg_keys/i.test(`${e.id} ${e.name}`)),
        { timeout: 30000 },
    );
    await page.click('[data-tab="examples"]');
    await page.evaluate(() => {
        const btn = [...document.querySelectorAll(".sb-example")].find((b) => /sevseg_keys/i.test(b.textContent));
        btn?.click();
    });
    await wait(500);

    // strictPins: apply the board defaults explicitly
    await page.click('[data-tab="pinmap"]');
    await wait(200);
    await page.evaluate(() => {
        document.querySelector("#pp-clear")?.click();
        document.querySelector("#pp-defaults")?.click();
    });
    await wait(300);
    const plan = await page.evaluate(() => {
        const p = window.__cyclone.sidebar.getPinPlan();
        return { valid: [...(p.validation?.validByNode || new Map())], errors: p.validation?.errors || [] };
    });
    step("sevseg_keys pin defaults (s1..s4, dtube, seven_seg)", plan.valid.length >= 6 && plan.errors.length === 0, JSON.stringify(plan.valid));
    await page.screenshot({ path: join(OUT, "sevseg-pinplan.png") });

    await page.click("#ep-run");
    await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 120000 });
    await wait(800);

    const readDisplay = () => page.evaluate(() => {
        const d = window.__cyclone.board.io.display;
        const tubes = [0, 1, 2, 3].map((i) => Array.from(d.segCurrent.slice(i * 8, i * 8 + 7)));
        const litTubes = tubes.filter((t) => t.some((v) => v > 0.12)).length;
        return {
            segTarget: Array.from(d.segTarget),
            segCurrent: Array.from(d.segCurrent),
            segHold: Array.from(d.segHold),
            digitOn: [...d.digitOn],
            litTubes,
            entity: window.__cyclone.state.entity?.name || "",
        };
    });

    const open = await readDisplay();
    await page.screenshot({ path: join(OUT, "sevseg-keys-open.png") });
    step(
        "all keys open (enable low) -> display dark",
        open.entity.toLowerCase() === "sevseg" && open.segTarget.every((v) => v === 0) && open.segCurrent.every((v) => v < 0.05),
        `entity=${open.entity} segTargetSum=${open.segTarget.reduce((a, b) => a + b, 0)}`,
    );

    // Close all four DIP switches (the design's active-low enable).
    await page.evaluate(() => {
        document.querySelectorAll("#bc-row .bc-dip").forEach((btn) => {
            if (!btn.classList.contains("on")) btn.click();
        });
    });
    // wait for the debounced re-run + POV settle
    let closed = open;
    for (let i = 0; i < 40; i += 1) {
        await wait(250);
        closed = await readDisplay();
        if (closed.segTarget.some((v) => v > 0)) break;
    }
    await wait(400);
    closed = await readDisplay();
    await page.screenshot({ path: join(OUT, "sevseg-display.png") });

    const glyph = closed.segTarget.slice(0, 7);
    const litNow = closed.segCurrent.filter((v) => v > 0.12).length;
    step(
        "all keys closed -> segments lit (POV image)",
        litNow >= 6 && closed.digitOn.some((v) => v === 1),
        `segCurrent lit=${litNow} digitOn=${JSON.stringify(closed.digitOn)} segTarget[0..6]=${JSON.stringify(glyph)}`,
    );
    step(
        "persistence of vision integrates multiple tubes",
        closed.litTubes >= 2,
        `tubes glowing in the settled image: ${closed.litTubes}`,
    );
    step(
        "DIP strip re-ran the design (live input path)",
        open.litTubes === 0 && closed.litTubes >= 2,
        `openTubes=${open.litTubes} closedTubes=${closed.litTubes}`,
    );
} catch (err) {
    step("e2e completed", false, err?.stack || String(err));
} finally {
    try { await browser?.close(); } catch { /* ignore */ }
    reapOwnBrowser();
}
const summary = `${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — ${BASE}`;
console.log(summary);
appendFileSync(LOG, summary + "\n");
process.exit(failures === 0 ? 0 : 1);