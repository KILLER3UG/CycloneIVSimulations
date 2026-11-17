import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const child = spawn(exe, ["--headless=new", "--remote-debugging-port=9342",
    `--user-data-dir=${join(mkdtempSync(join(tmpdir(), "segdebug-")), "p")}`,
    "--no-first-run", "--disable-features=msStartupBoost", "--disable-gpu",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1600,900", "about:blank"],
    { stdio: "ignore", detached: true });
child.unref();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 60 && !ready; i += 1) { await wait(500); try { const r = await fetch("http://127.0.0.1:9342/json/version"); ready = r.ok; } catch {} }
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9342", defaultViewport: { width: 1600, height: 900 } });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8000/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__cyclone, { timeout: 60000 });
await wait(2000);
const src = readFileSync(resolve(HERE, "../../tests/qa/designs/board/seg_mux4sel.vhd"), "utf-8");
const out = await page.evaluate(async (src) => {
    const logs = [];
    window.__cyclone.editor.setFiles([{ name: "seg_order_a_d0.vhd", content: src }], false);
    window.__cyclone.editor.setTopEntity("seg_order_a_d0");
    const api = await window.__cyclone.api.compile({ vhdl: src, top: "seg_order_a_d0" });
    const pins = api.data?.board?.pins || {};
    return { ok: api.data?.ok, segPins: pins.seven_seg, digPins: pins.dtube };
}, src);
console.log("compile:", JSON.stringify(out));
// now run through the UI and dump cycle values at cycle 5
await page.evaluate((src) => { window.__cyclone.editor.setFiles([{ name: "seg_mux4sel.vhd", content: src }], false); }, src);
await page.evaluate(() => window.__cyclone.run());
for (let i = 0; i < 40; i += 1) {
    await wait(500);
    const done = await page.evaluate(() => [...document.querySelectorAll("#console-log .log-line")].some((l) => l.textContent.includes("Simulation complete")));
    if (done) break;
}
const state = await page.evaluate(() => {
    const b = window.__cyclone.board;
    const d = b.io.display;
    const idx = b.pinIndex.index;
    const pinLevel = (pin) => window.__cyclone.state.liveValues?.[Object.keys(window.__cyclone.state.liveValues || {}).find((k) => false)] ?? "n/a";
    return {
        cursor: window.__cyclone.state.cursorCycle,
        swLive: window.__cyclone.state.liveValues?.sw,
        sevenLive: window.__cyclone.state.liveValues?.seven_seg,
        dtubeLive: window.__cyclone.state.liveValues?.dtube,
        segTarget: Array.from(d.segTarget),
        segCurrent: Array.from(d.segCurrent).map((v) => Math.round(v * 100) / 100),
        digitOn: [...d.digitOn],
        bitToName: d.bitToName,
        pin128: idx.get("PIN_128")?.elementIndex,
        pin124: idx.get("PIN_124")?.elementIndex,
        pin133: idx.get("PIN_133")?.elementIndex,
        pin137: idx.get("PIN_137")?.elementIndex,
    };
});
console.log("state:", JSON.stringify(state, null, 2));
console.log("state:", JSON.stringify(state, null, 2));console.log("state:", JSON.stringify(state, null, 2));
await browser.disconnect();
try { spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch {}
try { spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(HERE, "reap-browsers.ps1"), "-BeforePids", ""], { stdio: "ignore" }); } catch {}
process.exit(0);
