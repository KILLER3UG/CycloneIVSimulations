// ui-verify.mjs — headless layout + functional check of the styled UI.
// Usage: node scripts/ui-verify.mjs [outDir]
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outDir = resolve(process.argv[2] || "../tests/.audit-scratch/ui-restyle");
mkdirSync(outDir, { recursive: true });

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ["--disable-gpu", "--enable-unsafe-swiftshader", "--window-size=1600,900", "--hide-scrollbars"],
    defaultViewport: { width: 1600, height: 900 },
});

const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

await page.goto("http://127.0.0.1:8000/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => window.__cyclone && document.querySelector("#board-host canvas"), { timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));

const rect = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
}, sel);

const layout = {};
for (const sel of ["#toolbar", "#tb-pipeline", "#cam-presets", "#board-topbar .viewtools", "#stats",
    "#board-host canvas", "#right", ".ep-footer", "#ep-run", "#bottom", ".bp-main", ".bp-dock", "#sb-speccard"]) {
    layout[sel] = await rect(sel);
}
layout.state = await page.evaluate(() => ({
    viewport: [innerWidth, innerHeight],
    ssSummary: document.getElementById("ep-ss-summary")?.textContent,
    badge: document.getElementById("status-badge")?.textContent,
    steps: [...document.querySelectorAll(".tb-step")].map((s) => s.className),
    tabs: [...document.querySelectorAll(".bp-tab")].map((t) => t.textContent.trim()),
    soloConsole: document.querySelector(".bottom-panel")?.classList.contains("solo-console"),
    overflowX: document.documentElement.scrollWidth > innerWidth,
    overflowY: document.documentElement.scrollHeight > innerHeight,
    iconMax: Math.max(...[...document.querySelectorAll(".icon")].map((s) => s.getBoundingClientRect().width)),
}));

await page.screenshot({ path: resolve(outDir, "01-boot.png") });

// functional: run the counter example end to end
await page.evaluate(() => window.__cyclone.run());
await new Promise((r) => setTimeout(r, 9000));
const run = await page.evaluate(() => ({
    badge: document.getElementById("status-badge")?.textContent,
    logs: [...document.querySelectorAll("#console-log .log-line")].slice(-6).map((l) => l.textContent.trim()),
    simTime: document.getElementById("st-time")?.textContent,
    waveCycles: window.__cyclone?.state?.totalCycles,
    fps: document.getElementById("st-fps")?.textContent,
}));
await page.screenshot({ path: resolve(outDir, "02-after-run.png") });

writeFileSync(resolve(outDir, "verify.json"), JSON.stringify({ layout, run, errors }, null, 2));
console.log(JSON.stringify({ layout, run, errors }, null, 2));
await browser.close();
