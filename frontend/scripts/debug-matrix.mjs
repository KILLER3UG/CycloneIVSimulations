// debug-matrix.mjs — measure app-path run latency for the matrix display
// designs and confirm segHold carries the POV image (segTarget stays stale
// on the compact path). Times each design from run() to "Simulation complete".
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const QA = resolve(HERE, "../../tests/qa/designs/board");
const EXE = ["C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const PORT = 9351;
const BASE = process.argv[2] || "http://127.0.0.1:8771/";
const profileDir = mkdtempSync(join(tmpdir(), "dbgmat-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function reap() {
    const tag = basename(profileDir);
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match '${tag}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    try { spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" }); } catch { /* ignore */ }
}
process.on("exit", reap);

let child = spawn(EXE, [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(profileDir, "p")}`,
    "--no-first-run", "--autoplay-policy=no-user-gesture-required", "--disable-gpu",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--hide-scrollbars", "about:blank",
], { stdio: "ignore", detached: true });
child.unref();
let ready = false;
for (let i = 0; i < 90 && !ready; i += 1) { await wait(500); try { ready = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { } }
if (!ready) { console.log("browser did not start"); process.exit(1); }

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}` });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__cyclone && window.__cyclone.board, { timeout: 60000 });
await wait(1000);

const completions = () => page.evaluate(() =>
    [...document.querySelectorAll("#console-log .log-line")]
        .filter((l) => l.textContent.includes("Simulation complete")).length);

for (const name of ["seg_hex_sw", "seg_mux4sel", "seg_mux_slowsel", "key_led4"]) {
    const src = readFileSync(join(QA, `${name}.vhd`), "utf-8");
    const top = name.replace(/\.vhd$/, "");
    await page.evaluate(({ s, t }) => {
        const c = window.__cyclone;
        c.editor.setFiles([{ name: "design.vhd", content: s }], false);
        c.editor.setPinnedTop("design.vhd", t);
        document.querySelector('[data-tab="pinmap"]')?.click();
        document.querySelector("#pp-clear")?.click();
        document.querySelector("#pp-defaults")?.click();
    }, { s: src, t: top });
    await wait(300);
    const before = await completions();
    const t0 = Date.now();
    await page.evaluate(() => window.__cyclone.run());
    const ok = await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 90000 }).then(() => true).catch(() => false);
    const tProg = Date.now() - t0;
    let tDone = -1, done = false;
    if (ok) {
        for (let i = 0; i < 240; i += 1) { await wait(350); if ((await completions()) > before) { done = true; break; } }
        tDone = Date.now() - t0;
    }
    const info = await page.evaluate(() => {
        const b = window.__cyclone.board;
        const d = b.io.display;
        const sl = (a) => [0, 1, 2, 3].map((i) => Array.from(a.slice(i * 8, i * 8 + 7)).map((v) => Math.round(v * 100) / 100));
        return { scanHz: b._scanHz, segHold: sl(d.segHold), segTarget: sl(d.segTarget), digitOn: Array.from(d.digitOn) };
    });
    console.log(`\n=== ${name} === programmed=${ok} done=${done} tProgram=${(tProg / 1000).toFixed(1)}s tComplete=${(tDone / 1000).toFixed(1)}s scanHz=${info.scanHz} digitOn=${JSON.stringify(info.digitOn)}`);
    console.log("  segHold:  ", JSON.stringify(info.segHold));
    console.log("  segTarget:", JSON.stringify(info.segTarget));
}
await browser.close();
reap();
process.exit(0);
