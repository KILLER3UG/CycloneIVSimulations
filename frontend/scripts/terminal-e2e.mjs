// terminal-e2e.mjs — interactive bottom-dock terminal gate.
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/evidence");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "terminal-e2e.log");
writeFileSync(LOG, "");
const EXE = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p));
const BASE = process.argv[2] || "http://127.0.0.1:8000/";
const PORT = 9352;
const profileDir = mkdtempSync(join(tmpdir(), "terminal-e2e-"));
let failures = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function step(name, ok, detail = "") {
    const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`;
    console.log(line);
    appendFileSync(LOG, line + "\n");
    if (!ok) failures += 1;
}
function reap() {
    const tag = basename(profileDir);
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match '${tag}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    try { spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" }); } catch { /* ignore */ }
}
process.on("exit", reap);

let child = spawn(EXE, [
    "--headless=new", `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(profileDir, "p")}`,
    "--no-first-run", "--no-default-browser-check", "--disable-features=msStartupBoost",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-gpu", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1280,800", "--hide-scrollbars", "about:blank",
], { stdio: "ignore", detached: true });
child.unref();
let ready = false;
for (let i = 0; i < 90 && !ready; i += 1) {
    await wait(500);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); ready = r.ok; } catch { /* not yet */ }
}
if (!ready) { step("browser started", false); process.exit(1); }

let browser = null;
try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: { width: 1280, height: 800 } });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__cyclone?.terminal && window.__cyclone?.state, { timeout: 60000 });

    // Open the bottom dock and select its Terminal tab.
    await page.evaluate(() => {
        document.querySelector("#bottom")?.classList.remove("collapsed");
        document.querySelector('[data-btab="terminal"]')?.click();
    });
    step("bottom dock Terminal tab opened",
        await page.evaluate(() => !!document.querySelector('[data-btab="terminal"].active')
            && !document.querySelector("#bottom")?.classList.contains("collapsed")));

    // Wait for the PTY to announce readiness.
    let termReady = false;
    try {
        await page.waitForFunction(() => {
            const t = window.__cyclone.terminal;
            return (typeof t?.isReady === "function" && t.isReady())
                || /ready/.test(document.querySelector("#term-status")?.textContent || "");
        }, { timeout: 15000 });
        termReady = true;
    } catch { /* reported below */ }
    const status = await page.evaluate(() => document.querySelector("#term-status")?.textContent || "");
    step("terminal PTY ready", termReady, `status=${status}`);
    if (!termReady) throw new Error("terminal never became ready");

    const hasInput = await page.evaluate(() => !!document.querySelector("#terminal-input")
        && typeof window.__cyclone.terminal.runLine === "function");
    step("command bar + runLine API present", hasInput);

    // Two real shell commands through the interactive command bar API.
    await page.evaluate(() => window.__cyclone.terminal.runLine("ghdl --version"));
    await page.waitForFunction(() => /GHDL/i.test(document.querySelector("#terminal-output")?.textContent || ""),
        { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => window.__cyclone.terminal.runLine("echo SIM_TERMINAL_OK"));

    const deadline = Date.now() + 10000;
    let text = "";
    while (Date.now() < deadline) {
        text = await page.evaluate(() => document.querySelector("#terminal-output")?.textContent || "");
        if (/GHDL/i.test(text) && /SIM_TERMINAL_OK/.test(text)) break;
        await wait(150);
    }
    const ghdlOk = /GHDL/i.test(text);
    const echoOk = /SIM_TERMINAL_OK/.test(text);
    step('ghdl --version printed "GHDL"', ghdlOk, text.slice(-400).replace(/\s+/g, " "));
    step('echo printed "SIM_TERMINAL_OK"', echoOk);
    appendFileSync(LOG, "OUTPUT Tail: " + text.slice(-1200).replace(/\r/g, "\\r") + "\n");
} catch (err) {
    step("e2e completed", false, err?.stack || String(err));
} finally {
    try { await browser?.close(); } catch { /* ignore */ }
    reap();
}
const summary = `${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — ${BASE}`;
console.log(summary);
appendFileSync(LOG, summary + "\n");
process.exit(failures === 0 ? 0 : 1);
