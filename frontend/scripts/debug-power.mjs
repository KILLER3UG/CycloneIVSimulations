// debug-power.mjs — minimal diagnostic for the Power Off/On state flags.
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../../examples/buzz1.vhd"), "utf-8");
const EXE = ["C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const PORT = 9346;
const profileDir = mkdtempSync(join(tmpdir(), "dbgpow-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function reap() {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'dbgpow-' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
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
for (let i = 0; i < 60 && !ready; i += 1) { await wait(500); try { if ((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json())) ready = true; } catch { } }

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}` });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => console.log("CONSOLE", m.type(), m.text().slice(0, 200)));
await page.goto("http://127.0.0.1:8765/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__cyclone && window.__cyclone.board, { timeout: 60000 });
await wait(1000);
await page.evaluate((s) => {
    const c = window.__cyclone;
    c.editor.setFiles([{ name: "buzz1.vhd", content: s }], false);
    c.editor.setPinnedTop("buzz1.vhd", "buzz1");
    document.querySelector('[data-tab="pinmap"]')?.click();
    document.querySelector("#pp-defaults")?.click();
}, SRC);
await wait(400);
await page.evaluate(() => document.querySelector("#ep-run")?.click());
await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 60000 }).catch(() => {});
const dump = (tag) => page.evaluate((t) => {
    const S = window.__cyclone.state;
    return {
        tag: t, programmed: S.programmed, power: S.power, running: S.running,
        backendOk: S.backendOk, compileOk: S.compileResult?.ok ?? null,
        entity: S.entity?.name ?? null, totalCycles: S.totalCycles,
        boardProgrammed: window.__cyclone.board.programmed,
    };
}, tag);
console.log("A:", JSON.stringify(await dump("after-compile")));
await page.evaluate(() => document.querySelector('#toolbar [data-act="power"]')?.click());
await wait(600);
console.log("B:", JSON.stringify(await dump("after-power-off")));
await page.evaluate(() => document.querySelector('#toolbar [data-act="power"]')?.click());
await wait(600);
console.log("C:", JSON.stringify(await dump("after-power-on")));
await wait(3000);
console.log("D:", JSON.stringify(await dump("after-power-on-3s")));
await browser.close();
reap();
process.exit(0);