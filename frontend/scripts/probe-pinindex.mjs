import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const exe = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
const child = spawn(exe, ["--headless=new", "--remote-debugging-port=9341",
    `--user-data-dir=${join(mkdtempSync(join(tmpdir(), "pinprobe-")), "p")}`,
    "--no-first-run", "--disable-features=msStartupBoost", "--disable-gpu",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1600,900", "about:blank"],
    { stdio: "ignore", detached: true });
child.unref();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 60 && !ready; i += 1) { await wait(500); try { const r = await fetch("http://127.0.0.1:9341/json/version"); ready = r.ok; } catch {} }
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9341", defaultViewport: { width: 1600, height: 900 } });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8000/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__cyclone, { timeout: 60000 });
await wait(2000);
const out = await page.evaluate(() => {
    const idx = window.__cyclone.board.pinIndex.index;
    const grab = (pin) => {
        const e = idx.get(pin);
        return e ? { kind: e.kind, el: e.elementIndex, pol: e.polarity } : null;
    };
    return {
        PIN_128: grab("PIN_128"), PIN_121: grab("PIN_121"), PIN_124: grab("PIN_124"), PIN_127: grab("PIN_127"),
        PIN_133: grab("PIN_133"), PIN_137: grab("PIN_137"),
        segBitMap: window.__cyclone.board.io.display.bitToName,
    };
});
console.log(JSON.stringify(out, null, 2));
await browser.disconnect();
try { spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch {}
try { spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(dirname(fileURLToPath(import.meta.url)), "reap-browsers.ps1"), "-BeforePids", ""], { stdio: "ignore" }); } catch {}
process.exit(0);
