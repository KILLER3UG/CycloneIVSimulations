// board-shot.mjs — headless screenshot harness for the 3D board model.
//
// Uses the system Edge via puppeteer-core (no browser download) to capture
// the Vite build served by the backend at http://127.0.0.1:8000. The backend
// must already be running (`python -m backend serve --port 8000`).
//
// Edge's "startup boost" hands the launcher process off (exit code 0), so we
// spawn msedge.exe detached with --remote-debugging-port and puppeteer.connect
// to it, then kill the process tree when done.
//
// Usage (from frontend/):
//   node scripts/board-shot.mjs                     # top/iso/front/ports + run shots + assertions
//   node scripts/board-shot.mjs --views iso,top     # subset of presets
//   node scripts/board-shot.mjs --no-run            # skip the counter-demo run shots
//   node scripts/board-shot.mjs --no-assert         # skip contract assertions
//   node scripts/board-shot.mjs --out <dir> --url <url> --settle <ms> --run-wait <ms>
//
// Screenshots land in tests/.audit-scratch/board-fidelity/<name>.png; a
// stats snapshot is written next to them as stats.json and echoed to stdout.

import puppeteer from "puppeteer-core";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "..");
const DEFAULT_OUT = resolve(FRONTEND, "../tests/.audit-scratch/board-fidelity");

const EDGE_CANDIDATES = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return dflt;
    const v = args[i + 1];
    return v && !v.startsWith("--") ? v : true;
};
const flag = (name) => args.includes(`--${name}`);
const has = (name) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`) || a === `--no-${name}`);

const VIEWS = String(has("views") ? opt("views", "top,iso,front,ports") : "top,iso,front,ports")
    .split(",").map((s) => s.trim()).filter(Boolean);
const OUT_DIR = resolve(String(opt("out", DEFAULT_OUT)));
const URL_APP = String(opt("url", "http://127.0.0.1:8000"));
const SETTLE = Number(opt("settle", 800));
const RUN_WAIT = Number(opt("run-wait", 6500));
const PORT = Number(opt("port", 9333));
const DO_RUN = !flag("no-run");
const ASSERT = !flag("no-assert");

const exe = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!exe) {
    console.error("msedge.exe not found; edit EDGE_CANDIDATES in scripts/board-shot.mjs");
    process.exit(1);
}

const profileDir = mkdtempSync(join(tmpdir(), "edge-shot-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function killTree(pid) {
    if (process.platform === "win32") {
        await new Promise((r) => execFile("taskkill", ["/F", "/T", "/PID", String(pid)], () => r()));
    } else {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
}
// belt-and-braces: reap any Edge still holding our edge-shot temp profiles
// (matched by command line, so a user-opened Edge is never touched).
// MUST run before the spawn below — the fresh child also matches 'edge-shot'.
async function reapHarnessEdge() {
    if (process.platform !== "win32") return;
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | " +
        "Where-Object { $_.CommandLine -match 'edge-shot' } | ForEach-Object { " +
        "taskkill /F /T /PID $_.ProcessId 2>$null | Out-Null }";
    await new Promise((r) => execFile("powershell", ["-NoProfile", "-Command", ps], () => r()));
}
await reapHarnessEdge(); // clean up leftovers from a crashed previous run

const child = spawn(exe, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(profileDir, "p")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--window-size=1600,900",
    "--hide-scrollbars",
    "about:blank",
], { stdio: "ignore", detached: true });
child.unref();

let browser = null;
process.on("exit", () => { if (child.pid) killTree(child.pid); });
for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => { await reapHarnessEdge(); process.exit(130); });
}

try {
    // poll the DevTools endpoint (SwiftShader boots can be slow on a loaded box)
    let ready = false;
    for (let i = 0; i < 90 && !ready; i += 1) {
        await wait(500);
        for (const host of ["127.0.0.1", "localhost"]) {
            try {
                const res = await fetch(`http://${host}:${PORT}/json/version`);
                ready = ready || res.ok;
            } catch { /* not yet */ }
        }
    }
    if (!ready) {
        await killTree(child.pid);
        await reapHarnessEdge();
        throw new Error(`Edge DevTools port ${PORT} never opened — rerun the script to retry`);
    }

    browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${PORT}`,
        defaultViewport: { width: 1600, height: 900 },
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    page.on("pageerror", (err) => console.error("[pageerror]", err.message));
    page.on("console", (msg) => {
        if (msg.type() === "error") console.error("[console.error]", msg.text());
    });

    // domcontentloaded: the app keeps a WebSocket open, so networkidle never settles
    await page.goto(URL_APP, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(
        () => window.__cyclone && window.__cyclone.board && document.querySelector("#board-host canvas"),
        { timeout: 45000 },
    );
    await page.waitForFunction(
        () => window.__cyclone.board.container?.dataset?.ready === "1",
        { timeout: 30000 },
    );

    mkdirSync(OUT_DIR, { recursive: true });
    const shots = [];

    const bootStats = await page.evaluate(() => window.__cyclone.board.stats());
    console.log("stats boot:", JSON.stringify(bootStats));

    for (const view of VIEWS) {
        await page.evaluate((v) => window.__cyclone.board.setPreset(v), view);
        await wait(SETTLE);
        const file = join(OUT_DIR, `idle-${view}.png`);
        await page.screenshot({ path: file });
        shots.push(file);
        console.log("shot", file);
    }

    if (DO_RUN) {
        // boot the auto-loaded counter example and let the LEDs/digits go live
        await page.evaluate(() => window.__cyclone.run());
        await wait(RUN_WAIT);
        await page.evaluate(() => window.__cyclone.board.setPreset("iso"));
        await wait(SETTLE);
        const file = join(OUT_DIR, "run-iso.png");
        await page.screenshot({ path: file });
        shots.push(file);
        console.log("shot", file);

        await page.evaluate(() => window.__cyclone.board.setPreset("top"));
        await wait(SETTLE);
        const fileTop = join(OUT_DIR, "run-top.png");
        await page.screenshot({ path: fileTop });
        shots.push(fileTop);
        console.log("shot", fileTop);
    }

    if (ASSERT) {
        const before = await page.evaluate(() => {
            const b = window.__cyclone.board;
            return {
                pickables: (b.pickables || []).length,
                probes: b.probePoints().length,
                stats: b.stats(),
                ledLevels: (b.io?.leds || []).map((l) => Number(l.level.toFixed(3))),
                segLit: b.io?.display ? Array.from(b.io.display.segCurrent).filter((v) => v > 0.25).length : -1,
                dipCount: (b.io?.dip || []).length,
                keyCount: (b.io?.keys || []).length,
            };
        });
        // drive one known cycle: LED1 + LED4 lit (active-low), digits "8888"
        await page.evaluate(() => {
            window.__cyclone.board.applyCycle({
                pins: { PIN_87: 0, PIN_86: 1, PIN_85: 1, PIN_84: 0 },
                chars: ["8", "8", "8", "8"],
            });
        });
        await wait(900); // let LED easing converge
        const after = await page.evaluate(() => ({
            ledLevels: (window.__cyclone.board.io?.leds || []).map((l) => Number(l.level.toFixed(3))),
            segLit: window.__cyclone.board.io?.display
                ? Array.from(window.__cyclone.board.io.display.segCurrent).filter((v) => v > 0.25).length
                : -1,
        }));
        const file = join(OUT_DIR, "assert-cycle.png");
        await page.screenshot({ path: file });
        shots.push(file);
        // a real pixel check: clip-screenshot the canvas and require a rich PNG
        const canvasEl = await page.$("#board-host canvas");
        const canvasShot = await canvasEl.screenshot({ encoding: "binary" });
        console.log("canvas shot bytes:", canvasShot.length);
        console.log("assert-before:", JSON.stringify(before));
        console.log("assert-after:", JSON.stringify(after));
        console.log("shot", file);

        const failures = [];
        if (before.pickables < 10) failures.push(`pickables too few: ${before.pickables}`);
        if (before.probes < 10) failures.push(`probes too few: ${before.probes}`);
        if (canvasShot.length < 60000) failures.push(`canvas render looks blank (${canvasShot.length} bytes)`);
        if (after.ledLevels[0] < 0.5 || after.ledLevels[3] < 0.5) failures.push(`LEDs did not light: ${after.ledLevels}`);
        if (after.ledLevels[1] > 0.3 || after.ledLevels[2] > 0.3) failures.push(`LED2/LED3 should be dark: ${after.ledLevels}`);
        if (after.segLit < 28) failures.push(`7-seg segments did not light: ${after.segLit}/32`);
        if (failures.length) {
            console.error("ASSERT FAILED:\n  " + failures.join("\n  "));
            process.exitCode = 2;
        } else {
            console.log("ASSERT OK");
        }
    }

    const finalStats = await page.evaluate(() => window.__cyclone.board.stats());
    console.log("stats final:", JSON.stringify(finalStats));
    writeFileSync(join(OUT_DIR, "stats.json"), JSON.stringify(finalStats, null, 2));
    console.log("DONE", shots.length, "shots ->", OUT_DIR);
} finally {
    if (browser) await browser.disconnect().catch(() => {});
    await killTree(child.pid);
    await reapHarnessEdge();
    await wait(700);
    try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Edge may lag releasing files */ }
}
