// dev-diag.mjs — diagnose why the dev-server boot stalls: watch every module
// request, console message and failure for 45 s, then dump the page state.
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
    "--headless=new", "--remote-debugging-port=9338",
    `--user-data-dir=${join(mkdtempSync(join(tmpdir(), "devdiag-")), "p")}`,
    "--no-first-run", "--disable-gpu", "--enable-unsafe-swiftshader",
    "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-webgl", "--ignore-gpu-blocklist",
    "--window-size=1600,900", "about:blank",
], { stdio: "ignore", detached: true });
child.unref();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 60 && !ready; i += 1) {
    await wait(500);
    try { const r = await fetch("http://127.0.0.1:9338/json/version"); ready = r.ok; } catch { /* not yet */ }
}
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9338", defaultViewport: { width: 1600, height: 900 } });
const page = await browser.newPage();

const requests = new Map(); // url -> status|"pending"|"failed"
const consoleMsgs = [];
page.on("request", (r) => requests.set(r.url().split("?")[0], "pending"));
page.on("requestfinished", (r) => requests.set(r.url().split("?")[0], "ok"));
page.on("requestfailed", (r) => {
    requests.set(r.url().split("?")[0], "FAILED: " + (r.failure()?.errorText || "?"));
});
page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
        consoleMsgs.push(`${m.type()}: ${m.text().slice(0, 160)}`);
    }
});
page.on("pageerror", (e) => consoleMsgs.push("pageerror: " + String(e).slice(0, 200)));

await page.goto(process.argv[2] || "http://localhost:5174/", { waitUntil: "domcontentloaded", timeout: 60000 });
for (const tick of [10, 20, 45]) {
    await wait(tick === 10 ? 10000 : tick === 20 ? 10000 : 25000);
    const pending = [...requests.entries()].filter(([, s]) => s !== "ok");
    console.log(`--- t=${tick}s  modules=${requests.size}  pending/failed=${pending.length}`);
    for (const [u, s] of pending.slice(0, 12)) console.log("   ", s, u.slice(-100));
    for (const m of consoleMsgs.slice(-6)) console.log("   [console]", m);
}
const state = await page.evaluate(() => ({
    readyState: document.readyState,
    appChildren: document.getElementById("app")?.children.length,
    canvases: document.querySelectorAll("canvas").length,
    cyclone: !!window.__cyclone,
    overlay: !!document.querySelector("vite-error-overlay"),
}));
console.log("STATE:", JSON.stringify(state));
await browser.disconnect();
try { execFile("taskkill", ["/F", "/T", "/PID", String(child.pid)]); } catch { /* ignore */ }
process.exit(0);
