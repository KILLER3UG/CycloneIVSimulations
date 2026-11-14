// boot-default-probe.mjs — one-off check: does the app boot with sevseg_keys
// as the default example and the rotation-friendly duration?
import puppeteer from "puppeteer-core";
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
const child = spawn(exe, [
    "--headless=new", "--remote-debugging-port=9337",
    `--user-data-dir=${join(mkdtempSync(join(tmpdir(), "bootprobe-")), "p")}`,
    "--no-first-run", "--disable-features=msStartupBoost", "--disable-gpu", "--enable-unsafe-swiftshader",
    "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-webgl", "--ignore-gpu-blocklist",
    "--window-size=1600,900", "about:blank",
], { stdio: "ignore", detached: true });
child.unref();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 60 && !ready; i += 1) {
    await wait(500);
    try { const r = await fetch("http://127.0.0.1:9337/json/version"); ready = r.ok; } catch { /* not yet */ }
}
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9337", defaultViewport: { width: 1600, height: 900 } });
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
const targetUrl = process.argv[2] || "http://127.0.0.1:8000/";
await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
// dev mode serves ~1300 unbundled modules; give the cold start a long budget
let booted = true;
try {
    await page.waitForFunction(() => window.__cyclone, { timeout: 90000 });
} catch {
    booted = false;
}
await wait(2500);
const out = await page.evaluate(() => ({
    fileTab: document.querySelector(".ep-tab")?.textContent?.trim(),
    topEntity: document.getElementById("ep-top")?.value,
    duration: document.getElementById("ss-duration")?.value,
    logHasSevseg: [...document.querySelectorAll("#console-log .log-line")].some((l) => l.textContent.includes("sevseg")),
    viteErrorOverlay: !!document.querySelector("vite-error-overlay"),
}));
console.log(JSON.stringify({ booted, ...out, consoleErrors: consoleErrors.slice(0, 5) }));
await browser.disconnect();
try { execFile("taskkill", ["/F", "/T", "/PID", String(child.pid)]); } catch { /* ignore */ }
process.exit(0);
