// debug-pins.mjs — dump the resolved pin plan for seg_hex_sw's `sw` vector so
// the KEY/DIP net binding collapse (all bits on one pin) can be pinpointed.
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../../tests/qa/designs/board/seg_hex_sw.vhd"), "utf-8");
const EXE = ["C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const PORT = 9353;
const BASE = process.argv[2] || "http://127.0.0.1:8771/";
const profileDir = mkdtempSync(join(tmpdir(), "dbgpins-"));
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
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__cyclone && window.__cyclone.board, { timeout: 60000 });
await wait(1000);

await page.evaluate((s) => {
    const c = window.__cyclone;
    c.editor.setFiles([{ name: "seg_hex_sw.vhd", content: s }], false);
    c.editor.setPinnedTop("seg_hex_sw.vhd", "seg_hex_sw");
    document.querySelector('[data-tab="pinmap"]')?.click();
    document.querySelector("#pp-clear")?.click();
    document.querySelector("#pp-defaults")?.click();
}, SRC);
await wait(800);

const dump = await page.evaluate(() => {
    const plan = window.__cyclone.sidebar.getPinPlan();
    const keyPins = (window.__cyclone.state?.profile?.board?.buttons?.pins || []).map((p) => String(p).toUpperCase());
    const swNodes = (plan.nodes || []).filter((n) => n.portName === "sw").map((n) => ({
        node: n.nodeName, bit: n.bitOffset, dir: n.direction,
        pin: plan.validation?.validByNode?.get(n.nodeName) || null,
    }));
    return {
        keyPins,
        portPinsSw: plan.portPins?.sw || null,
        swNodes,
        bindings: keyPins.map((p) => (plan.nodes || [])
            .filter((n) => n.direction === "input" && plan.validation?.validByNode?.get(n.nodeName) === p)
            .map((n) => `${n.nodeName}@bit${n.bitOffset}`)),
    };
});
console.log(JSON.stringify(dump, null, 1));
await browser.close();
reap();
process.exit(0);
