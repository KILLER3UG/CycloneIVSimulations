// dynamic-board-e2e.mjs — runtime board switching + SDK import gate.
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/evidence");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "dynamic-board-e2e.log");
writeFileSync(LOG, "");
const EXE = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p));
const BASE = process.argv[2] || "http://127.0.0.1:8000/";
const PORT = 9353;
const profileDir = mkdtempSync(join(tmpdir(), "dynboard-e2e-"));
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

const CUSTOM = {
    id: "custom-sdk-e2e",
    name: "Custom SDK Board",
    vendor: "SDK E2E",
    fpga_part: "EP4CE10E22C8N",
    clock_hz: 50000000,
    clock_pin: "PIN_23",
    reset_pin: "PIN_25",
    reset_active_low: true,
    pins: [
        { number: "PIN_23", name: "CLOCK_50", role: "clock", input_only: true, pull: "none", shared_group: "" },
        { number: "PIN_25", name: "RESET_N", role: "reset", input_only: true, pull: "up", shared_group: "" },
        { number: "PIN_87", name: "LED[0]", role: "led", input_only: false, pull: "none", shared_group: "" },
        { number: "PIN_86", name: "LED[1]", role: "led", input_only: false, pull: "none", shared_group: "" },
        { number: "PIN_88", name: "KEY[0]", role: "button", input_only: true, pull: "up", shared_group: "" },
    ],
    peripherals: {
        leds: { port: "LED", count: 2, pins: ["PIN_87", "PIN_86"], activeLow: true },
        buttons: { port: "KEY", count: 1, pins: ["PIN_88"], activeLow: true },
        switches: { port: "SW", count: 0, pins: [], sharedWithButtons: false, activeLow: false },
        seven_segment: { count: 0, segmentActiveLow: true, digitActiveLow: true, pins: { SEG: [], DIG: [] } },
        buzzer: { port: "BUZZER", pin: "PIN_110", type: "passive", activeLow: true },
        i2c_devices: [],
    },
    layout3d: {
        pcb: { w: 60, d: 40, thickness: 1.6, cornerRadius: 2 },
        pcbColor: "#1e293b",
    },
};

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
    await page.waitForFunction(() => window.__cyclone?.board?.io && window.__cyclone?.state?.boardsList?.length, { timeout: 60000 });

    const snap = () => page.evaluate(() => {
        const c = window.__cyclone;
        const b = c.board;
        const plan = c.sidebar.getPinPlan();
        const labels = (plan.catalog?.list || []).flatMap((e) => [e.label, ...(e.aliases || [])]);
        return {
            active: c.state.activeBoardId,
            leds: (b.io.leds || []).length,
            keys: (b.io.keys || []).length,
            dip: (b.io.dip || []).length,
            cells: document.querySelectorAll("#bc-row .bc-cell").length,
            selected: document.querySelector("#tb-board-select")?.value,
            hasLed7: labels.includes("LED[7]"),
            hasSw0: labels.includes("SW[0]"),
        };
    });

    const initial = await snap();
    step("initial RZ-EasyFPGA A2.2 board: 4 LEDs / 4 keys / 4 DIP",
        initial.active === "rz-easyfpga-a2.2" && initial.leds === 4 && initial.keys === 4 && initial.dip === 4,
        JSON.stringify(initial));

    // Switch through the real UI selector (falls back to the public API if the
    // option list has not been populated yet).
    await page.evaluate(async () => {
        const sel = document.querySelector("#tb-board-select");
        if (sel && [...sel.options].some((o) => o.value === "de0-nano-ep4ce22")) {
            sel.value = "de0-nano-ep4ce22";
            sel.dispatchEvent(new Event("change", { bubbles: true }));
        } else await window.__cyclone.selectBoard("de0-nano-ep4ce22");
    });
    await page.waitForFunction(() => window.__cyclone.state.activeBoardId === "de0-nano-ep4ce22"
        && window.__cyclone.board.io.leds.length === 8, { timeout: 30000 });
    await wait(250);
    const de0 = await snap();
    step("DE0-Nano rebuilds live: 8 LEDs / 2 keys / 4 DIP",
        de0.active === "de0-nano-ep4ce22" && de0.leds === 8 && de0.keys === 2 && de0.dip === 4,
        JSON.stringify(de0));
    step("DE0-Nano #bc-row rebuilds with 6 I/O cells", de0.cells === 6, `cells=${de0.cells}`);
    step("DE0-Nano Pin Planner catalog has LED[7] and SW[0]",
        de0.hasLed7 && de0.hasSw0, `LED[7]=${de0.hasLed7} SW[0]=${de0.hasSw0}`);

    // SDK custom board import (2 LEDs, 1 button, custom PCB geometry).
    const imported = await page.evaluate(async (manifest) => {
        await window.__cyclone.importCustomBoard(manifest);
        const c = window.__cyclone;
        const b = c.board;
        return { active: c.state.activeBoardId, leds: (b.io.leds || []).length,
            keys: (b.io.keys || []).length, name: c.state.boardProfile?.board?.name || "" };
    }, CUSTOM);
    step("custom SDK board imported: active=custom-sdk-e2e, 2 LEDs / 1 key",
        imported.active === "custom-sdk-e2e" && imported.leds === 2 && imported.keys === 1,
        JSON.stringify(imported));

    // Switch back to the canonical profile.
    await page.evaluate(async () => window.__cyclone.selectBoard("rz-easyfpga-a2.2"));
    await page.waitForFunction(() => window.__cyclone.state.activeBoardId === "rz-easyfpga-a2.2"
        && window.__cyclone.board.io.leds.length === 4, { timeout: 30000 });
    const restored = await snap();
    step("restored RZ-EasyFPGA A2.2: 4 LEDs", restored.active === "rz-easyfpga-a2.2" && restored.leds === 4,
        JSON.stringify(restored));
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
