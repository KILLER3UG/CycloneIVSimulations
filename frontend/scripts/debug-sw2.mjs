import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const child = spawn(exe, ["--headless=new", "--remote-debugging-port=9345",
    `--user-data-dir=${join(mkdtempSync(join(tmpdir(), "sw2debug-")), "p")}`,
    "--no-first-run", "--disable-features=msStartupBoost", "--disable-gpu",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1600,900", "about:blank"],
    { stdio: "ignore", detached: true });
child.unref();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 60 && !ready; i += 1) { await wait(500); try { const r = await fetch("http://127.0.0.1:9345/json/version"); ready = r.ok; } catch {} }
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9345", defaultViewport: { width: 1600, height: 900 } });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8000/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__cyclone, { timeout: 60000 });
await wait(2000);
const src = readFileSync(resolve(HERE, "../../tests/qa/designs/board/seg_mux4sel.vhd"), "utf-8");
await page.evaluate((s) => {
    window.__cyclone.editor.setFiles([{ name: "seg_mux4sel.vhd", content: s }], false);
    window.__cyclone.editor.setTopEntity("seg_mux4sel");
}, src);
const completions = () => page.evaluate(() =>
    [...document.querySelectorAll("#console-log .log-line")].filter((l) => l.textContent.includes("Simulation complete")).length);
await page.evaluate(() => window.__cyclone.run());
for (let i = 0; i < 60; i += 1) { await wait(500); if (await completions() > 0) break; }
await page.evaluate(() => { for (let i = 0; i < 4; i += 1) { const el = document.querySelector(`#bc-row .bc-switch[data-index="${i}"]`); if (el && !el.classList.contains("on")) el.click(); } });
for (let i = 0; i < 60; i += 1) { await wait(500); if (await completions() > 1) break; }
const out = await page.evaluate(() => {
    const b = window.__cyclone.board;
    const d = b.io.display;
    const lv = window.__cyclone.state.liveValues || {};
    return {
        live: { sw: lv.sw, seven_seg: lv.seven_seg, dtube: lv.dtube, clk: lv.clk },
        pinLevels: { PIN_128: lv.PIN_128, PIN_121: lv.PIN_121, PIN_124: lv.PIN_124, PIN_133: lv.PIN_133, PIN_135: lv.PIN_135, PIN_136: lv.PIN_136, PIN_137: lv.PIN_137 },
        segTarget: Array.from(d.segTarget),
        digitOn: [...d.digitOn],
        swState: [...document.querySelectorAll("#bc-row .bc-switch")].map((x) => x.classList.contains("on")),
        cursor: window.__cyclone.state.cursorCycle,
        total: window.__cyclone.state.totalCycles,
    };
});
console.log(JSON.stringify(out, null, 2));
await browser.disconnect();
try { spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch {}
try { spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(HERE, "reap-browsers.ps1")], { stdio: "ignore" }); } catch {}
process.exit(0);
