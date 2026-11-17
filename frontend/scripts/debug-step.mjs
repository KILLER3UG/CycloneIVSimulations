import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const child = spawn(exe, ["--headless=new", "--remote-debugging-port=9343",
    `--user-data-dir=${join(mkdtempSync(join(tmpdir(), "stepdebug-")), "p")}`,
    "--no-first-run", "--disable-features=msStartupBoost", "--disable-gpu",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1600,900", "about:blank"],
    { stdio: "ignore", detached: true });
child.unref();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 60 && !ready; i += 1) { await wait(500); try { const r = await fetch("http://127.0.0.1:9343/json/version"); ready = r.ok; } catch {} }
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9343", defaultViewport: { width: 1600, height: 900 } });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8000/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__cyclone, { timeout: 60000 });
await wait(2000);
const src = readFileSync(resolve(HERE, "../../tests/qa/designs/board/seg_hex_digit.vhd"), "utf-8");
await page.evaluate((s) => {
    window.__cyclone.editor.setFiles([{ name: "seg_hex_digit.vhd", content: s }], false);
    window.__cyclone.editor.setTopEntity("seg_hex_digit");
}, src);
await page.evaluate(() => window.__cyclone.run());
for (let i = 0; i < 60; i += 1) {
    await wait(400);
    const running = await page.evaluate(() =>
        [...document.querySelectorAll("#console-log .log-line")].some((l) => l.textContent.includes("Simulation running")));
    if (running) break;
}
await wait(400);
await page.evaluate(() => window.__cyclone.pause());
await wait(400);
for (const k of [0, 1, 2, 3]) {
    await page.evaluate(() => window.__cyclone.resetSim());
    await wait(250);
    await page.evaluate((n) => window.__cyclone.stepSim(n), k + 1);
    await wait(200);
    const st = await page.evaluate(() => {
        const d = window.__cyclone.board.io.display;
        return {
            cursor: window.__cyclone.state.cursorCycle,
            paused: window.__cyclone.state.paused,
            running: window.__cyclone.state.running,
            seven: window.__cyclone.state.liveValues?.seven_seg,
            dtube: window.__cyclone.state.liveValues?.dtube,
            segTarget07: Array.from(d.segTarget.slice(0, 8)),
            digitOn: [...d.digitOn],
        };
    });
    console.log(`k=${k}:`, JSON.stringify(st));
}
await browser.disconnect();
try { spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch {}
try { spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(HERE, "reap-browsers.ps1"), "-BeforePids", ""], { stdio: "ignore" }); } catch {}
process.exit(0);
