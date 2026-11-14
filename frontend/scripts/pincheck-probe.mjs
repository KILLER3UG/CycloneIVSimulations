import puppeteer from "puppeteer-core";
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
const profileDir = mkdtempSync(join(tmpdir(), "sevseg-e2e-"));
const child = spawn(exe, [
    "--headless=new", "--remote-debugging-port=9335",
    `--user-data-dir=${join(profileDir, "p")}`,
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
    try { const r = await fetch("http://127.0.0.1:9335/json/version"); ready = r.ok; } catch { /* not yet */ }
}
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9335", defaultViewport: { width: 1600, height: 900 } });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8000/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__cyclone, { timeout: 30000 });
await wait(1500);
const out = await page.evaluate(async () => {
    const ex = (await (await fetch("/api/examples")).json()).examples.find((e) => e.id === "sevseg_keys");
    window.__cyclone.editor.setFiles([{ name: ex.file, content: ex.source }], false);
    window.__cyclone.editor.setTopEntity("sevseg");
    const api = await window.__cyclone.api.compile({ vhdl: ex.source, top: "sevseg" });
    return {
        compileOk: api.data?.ok,
        compilePins: Object.keys(api.data?.board?.pins || {}),
    };
});
console.log(JSON.stringify(out, null, 2));
await browser.disconnect();
try { execFile("taskkill", ["/F", "/T", "/PID", String(child.pid)]); } catch { /* ignore */ }
process.exit(0);
