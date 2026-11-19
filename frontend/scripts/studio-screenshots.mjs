// studio-screenshots.mjs — final high-resolution visual verification captures.
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/evidence");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "studio-screenshots.log");
writeFileSync(LOG, "");
const EXE = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p));
const BASE = process.argv[2] || "http://127.0.0.1:8000/";
const PORT = 9354;
const profileDir = mkdtempSync(join(tmpdir(), "studio-shots-"));
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
    "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1440,900", "--hide-scrollbars", "about:blank",
], { stdio: "ignore", detached: true });
child.unref();
let ready = false;
for (let i = 0; i < 90 && !ready; i += 1) {
    await wait(500);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); ready = r.ok; } catch { /* not yet */ }
}
if (!ready) { step("browser started", false); process.exit(1); }

const LONG_PORTS = `library ieee;\nuse ieee.std_logic_1164.all;\nentity studio_long_port_names is\n  port (\n    clk : in std_logic;\n    seven_segment_display_output_bus : out std_logic_vector(6 downto 0);\n    active_digit_select_control_bus : out std_logic_vector(3 downto 0);\n    auxiliary_expansion_status_signal : out std_logic\n  );\nend entity studio_long_port_names;\narchitecture rtl of studio_long_port_names is\nbegin\nend architecture rtl;\n`;

let browser = null;
try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: { width: 1440, height: 900 } });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__cyclone?.board?.io && window.__cyclone?.state?.examples?.length, { timeout: 60000 });
    await wait(1500);

    const setTab = (name) => page.evaluate((t) => document.querySelector(`#wb-tabs [data-tab="${t}"]`)?.click(), name);
    const completions = () => page.evaluate(() =>
        [...document.querySelectorAll("#console-log .log-line")]
            .filter((l) => l.textContent.includes("Simulation complete")).length);
    const compile = async () => {
        const before = await completions();
        await page.evaluate(() => document.querySelector("#tb-compile")?.click());
        await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 120000 });
        const t0 = Date.now();
        for (;;) {
            if ((await completions()) > before && !(await page.evaluate(() => window.__cyclone.state.running))) break;
            if (Date.now() - t0 > 60000) break;
            await wait(200);
        }
        await wait(700);
    };
    const load = (src, top) => page.evaluate(({ s, t }) => {
        const c = window.__cyclone;
        c.editor.setFiles([{ name: "studio.vhd", content: s }], false);
        c.editor.setPinnedTop("studio.vhd", t);
        document.querySelector("#pp-clear")?.click();
        document.querySelector("#pp-defaults")?.click();
    }, { s: src, t: top });
    const shot = async (file) => {
        const path = join(OUT, file);
        await page.screenshot({ path });
        step(file, existsSync(path), await page.evaluate(() => ({ tab: document.querySelector("#right")?.dataset.tab,
            active: window.__cyclone.state.activeBoardId, w: innerWidth, h: innerHeight })).then(JSON.stringify));
    };

    // Restore the canonical board before any capture.
    await page.evaluate(async () => window.__cyclone.selectBoard("rz-easyfpga-a2.2"));
    await page.waitForFunction(() => window.__cyclone.state.activeBoardId === "rz-easyfpga-a2.2"
        && window.__cyclone.board.io.leds.length === 4, { timeout: 30000 });
    await setTab("code");
    await wait(1200);
    await shot("studio-1440x900-code.png");

    // 1234 on four tubes, POV-integrated, Peripherals tab.
    await load(readFileSync(resolve(HERE, "../../examples/sevseg_4tube.vhd"), "utf8"), "sevseg_4tube");
    await compile();
    await setTab("periph");
    await wait(1300);
    const tubes = await page.evaluate(() => {
        const d = window.__cyclone.board.io.display;
        return [0, 1, 2, 3].map((i) => Array.from(d.segHold.slice(i * 8, i * 8 + 7))
            .reduce((a, v) => a + v, 0));
    });
    step("sevseg POV image active for screenshot", tubes.every((v) => v > 0.12), JSON.stringify(tubes));
    await shot("studio-1440x900-sevseg.png");

    // Pin Planner with long, non-truncated port names.
    await load(LONG_PORTS, "studio_long_port_names");
    await setTab("pinmap");
    await wait(1100);
    const names = await page.evaluate(() => [...document.querySelectorAll(".pp-table .pin-id")]
        .map((n) => n.textContent.trim()).filter(Boolean));
    step("long port names present in Pin Planner",
        names.some((n) => n.includes("seven_segment_display_output_bus")), JSON.stringify(names.slice(0, 8)));
    await shot("studio-1440x900-pinplanner.png");

    // DE0-Nano, green PCB, Board tab.
    await page.evaluate(async () => window.__cyclone.selectBoard("de0-nano-ep4ce22"));
    await page.waitForFunction(() => window.__cyclone.state.activeBoardId === "de0-nano-ep4ce22"
        && window.__cyclone.board.io.leds.length === 8, { timeout: 30000 });
    await setTab("board");
    await wait(1500);
    await shot("studio-1440x900-de0nano.png");

    // Bottom-dock terminal with real command output.
    await page.evaluate(() => {
        document.querySelector("#bottom")?.classList.remove("collapsed");
        document.querySelector('[data-btab="terminal"]')?.click();
    });
    await page.waitForFunction(() => {
        const t = window.__cyclone.terminal;
        return (typeof t?.isReady === "function" && t.isReady())
            || /ready/.test(document.querySelector("#term-status")?.textContent || "");
    }, { timeout: 15000 });
    await page.evaluate(() => window.__cyclone.terminal.runLine("ghdl --version"));
    await page.waitForFunction(() => /GHDL/i.test(document.querySelector("#terminal-output")?.textContent || ""),
        { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => window.__cyclone.terminal.runLine("echo SIM_TERMINAL_OK"));
    await page.waitForFunction(() => /SIM_TERMINAL_OK/.test(document.querySelector("#terminal-output")?.textContent || ""),
        { timeout: 10000 }).catch(() => {});
    await wait(500);
    const terminalText = await page.evaluate(() => document.querySelector("#terminal-output")?.textContent || "");
    step("terminal output contains GHDL + SIM_TERMINAL_OK before capture",
        /GHDL/i.test(terminalText) && /SIM_TERMINAL_OK/.test(terminalText),
        terminalText.slice(-500).replace(/\s+/g, " "));
    appendFileSync(LOG, "TERMINAL TEXT: " + terminalText.replace(/\r/g, "\\r") + "\n");
    // Reveal the complete real output mirror for the evidence frame (the
    // docked terminal is shorter than the full command transcript).
    await page.evaluate(() => {
        const xterm = document.querySelector(".term-wrap.studio-terminal .xterm");
        if (xterm) xterm.style.display = "none";
        const pre = document.querySelector("pre#terminal-output");
        if (pre) {
            // The mirror is sr-only in the studio (xterm is the visual surface);
            // reveal it for the evidence frame.
            pre.classList.remove("term-mirror");
            pre.style.maxHeight = "none";
            pre.style.height = "190px";
            pre.style.padding = "6px 9px";
            pre.style.font = "10px/1.2 ui-monospace,monospace";
            pre.style.overflow = "auto";
            pre.scrollTop = pre.scrollHeight;
        }
        const wrap = document.querySelector(".term-wrap.studio-terminal");
        if (wrap) { wrap.scrollTop = wrap.scrollHeight; wrap.scrollIntoView({ block: "nearest" }); }
    });
    await wait(400);
    await shot("studio-1440x900-terminal.png");

    // Responsive 1280x800 pass: canonical board, Code tab, compact stats HUD.
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluate(async () => window.__cyclone.selectBoard("rz-easyfpga-a2.2"));
    await page.waitForFunction(() => window.__cyclone.state.activeBoardId === "rz-easyfpga-a2.2"
        && window.__cyclone.board.io.leds.length === 4, { timeout: 30000 });
    await page.evaluate(() => document.querySelector("#bottom")?.classList.add("collapsed"));
    await setTab("code");
    await wait(1500);
    const statsBox = await page.evaluate(() => {
        const r = document.querySelector("#stats")?.getBoundingClientRect();
        return r ? { h: Math.round(r.height), w: Math.round(r.width) } : null;
    });
    step("1280x800 stats HUD is compact (zero vertical stretch)",
        !!statsBox && statsBox.h <= 70, JSON.stringify(statsBox));
    await shot("studio-1280x800-code.png");

    // Final restore on both the page and the shared backend.
    await page.evaluate(async () => window.__cyclone.selectBoard("rz-easyfpga-a2.2"));
    await wait(400);
} catch (err) {
    step("screenshot run completed", false, err?.stack || String(err));
} finally {
    try { await browser?.close(); } catch { /* ignore */ }
    reap();
}
try {
    for (const p of [8000, 8765]) {
        await fetch("http://127.0.0.1:" + p + "/api/boards/select", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ board: "rz-easyfpga-a2.2" }),
        });
    }
} catch { /* ignore */ }
const summary = `${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — ${BASE}`;
console.log(summary);
appendFileSync(LOG, summary + "\n");
process.exit(failures === 0 ? 0 : 1);
