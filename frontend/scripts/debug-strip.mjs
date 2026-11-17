import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const child = spawn(exe, ["--headless=new", "--remote-debugging-port=9344",
    `--user-data-dir=${join(mkdtempSync(join(tmpdir(), "stripdebug-")), "p")}`,
    "--no-first-run", "--disable-features=msStartupBoost", "--disable-gpu",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1600,900", "about:blank"],
    { stdio: "ignore", detached: true });
child.unref();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 60 && !ready; i += 1) { await wait(500); try { const r = await fetch("http://127.0.0.1:9344/json/version"); ready = r.ok; } catch {} }
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9344", defaultViewport: { width: 1600, height: 900 } });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:8000/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__cyclone, { timeout: 60000 });
await wait(2000);
const src = readFileSync(resolve(HERE, "../../tests/qa/designs/board/seg_mux4sel.vhd"), "utf-8");
await page.evaluate((s) => {
    window.__cyclone.editor.setFiles([{ name: "seg_mux4sel.vhd", content: s }], false);
    window.__cyclone.editor.setTopEntity("seg_mux4sel");
}, src);
await page.evaluate(() => window.__cyclone.run());
for (let i = 0; i < 60; i += 1) {
    await wait(500);
    const done = await page.evaluate(() =>
        [...document.querySelectorAll("#console-log .log-line")].some((l) => l.textContent.includes("Simulation complete")));
    if (done) break;
}
const out = await page.evaluate(() => ({
    logs: [...document.querySelectorAll("#console-log .log-line")].slice(-10).map((l) => l.textContent.trim()),
    stripHTML: document.getElementById("bc-row")?.innerHTML?.slice(0, 200) ?? "NO #bc-row",
    stripHidden: document.getElementById("board-controls")?.classList.contains("hidden"),
}));
console.log(JSON.stringify(out, null, 2));
// setSw equivalent: click each switch as needed (fresh-read), wait rerun
const stripLog = [];
for (let v = 0; v < 4; v += 1) {
    const before = await page.evaluate(() =>
        [...document.querySelectorAll("#console-log .log-line")].filter((l) => l.textContent.includes("Simulation complete")).length);
    for (let i = 0; i < 4; i += 1) {
        const r = await page.evaluate((idx) => {
            const el = document.querySelector(`#bc-row .bc-switch[data-index="${idx}"]`);
            if (!el) return "MISSING";
            return el.classList.contains("on") ? "on" : "off";
        }, i);
        const wantOn = ((v >> i) & 1) === 0;
        if ((r === "on") !== wantOn) {
            await page.evaluate((idx) => document.querySelector(`#bc-row .bc-switch[data-index="${idx}"]`).click(), i);
            await wait(300);
        }
    }
    for (let i = 0; i < 40; i += 1) {
        await wait(400);
        const n = await page.evaluate(() =>
            [...document.querySelectorAll("#console-log .log-line")].filter((l) => l.textContent.includes("Simulation complete")).length);
        if (n > before) break;
    }
    const st = await page.evaluate(() => ({
        cursor: window.__cyclone.state.cursorCycle,
        sw: window.__cyclone.state.liveValues?.sw,
        digitOn: [...window.__cyclone.board.io.display.digitOn],
        segTarget: Array.from(window.__cyclone.board.io.display.segTarget),
    }));
    stripLog.push({ v, st });
}
console.log("STRIP:", JSON.stringify(stripLog));
await browser.disconnect();
try { spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch {}
try { spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(HERE, "reap-browsers.ps1")], { stdio: "ignore" }); } catch {}
process.exit(0);
