// buzz1-e2e.mjs — live browser acceptance for the classroom buzz1.vhd.
//
// Flow: load the bundled example through the real UI -> Compile (real click,
// also resumes AudioContext) -> verify:
//   1. idle (btn1=btn2 open) is silent
//   2. holding KEY1 gives 800 Hz (62,500 cycles/period at 50 MHz)
//   3. releasing KEY1 keeps 800 Hz for ~1.0 s, then silent
//   4. KEY2 behaves identically
//   5. screenshots land in docs/evidence/
//
// Usage: node scripts/buzz1-e2e.mjs [baseUrl]
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/evidence");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "buzz1-e2e.log");
writeFileSync(LOG, "");

const EXE = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
const BASE = process.argv[2] || "http://127.0.0.1:8765/";
const PORT = 9341;
const profileDir = mkdtempSync(join(tmpdir(), "buzz1-e2e-"));
let failures = 0;

function step(name, ok, detail = "") {
    const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`;
    console.log(line);
    appendFileSync(LOG, line + "\n");
    if (!ok) failures += 1;
}

function reapOwnBrowser() {
    const tag = basename(profileDir);
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match '${tag.replace(/'/g, "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    try { spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" }); } catch { /* ignore */ }
}
process.on("exit", reapOwnBrowser);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sleep = (ms) => wait(ms);

let child = null;
if (EXE) {
    child = spawn(EXE, [
        "--headless=new", `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${join(profileDir, "p")}`,
        "--no-first-run", "--no-default-browser-check",
        "--disable-features=msStartupBoost",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-gpu", "--enable-unsafe-swiftshader",
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-webgl", "--ignore-gpu-blocklist",
        "--window-size=1600,900", "--hide-scrollbars", "about:blank",
    ], { stdio: "ignore", detached: true });
    child.unref();
}

let ready = false;
for (let i = 0; i < 90 && !ready; i += 1) {
    await wait(500);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); ready = r.ok; } catch { /* not yet */ }
}
if (!ready) {
    step("browser started", false, "DevTools port never opened");
    process.exit(1);
}

let browser = null;
try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: { width: 1600, height: 900 } });
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    await page.setViewport({ width: 1280, height: 800 });
    page.on("pageerror", (e) => console.log("PAGEERROR", e?.message || e));
    page.on("error", (e) => console.log("PAGECRASH", e?.message || e));
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__cyclone && window.__cyclone.state, { timeout: 60000 });

    // 0 — example is listed
    await page.waitForFunction(
        () => (window.__cyclone.state.examples || []).some((e) => /buzz1/i.test(`${e.id} ${e.name}`)),
        { timeout: 30000 },
    );
    await page.click('[data-tab="examples"]');
    const loaded = await page.evaluate(() => {
        const btn = [...document.querySelectorAll(".sb-example")].find((b) => /buzz1/i.test(b.textContent));
        if (!btn) return false;
        btn.click();
        return true;
    });
    step("buzz1 example listed and loaded", loaded);
    await wait(500);

    // The Pin Planner never silently auto-assigns: apply the board defaults
    // explicitly (this is the same button a student clicks).
    await page.click('[data-tab="pinmap"]');
    await wait(200);
    const defaulted = await page.evaluate(() => {
        const btn = document.querySelector("#pp-defaults");
        if (!btn) return false;
        btn.click();
        return true;
    });
    await wait(400);
    const plan = await page.evaluate(() => {
        const p = window.__cyclone.sidebar.getPinPlan();
        return { valid: [...(p.validation?.validByNode || new Map())], errors: p.validation?.errors || [] };
    });
    step(
        "Apply board defaults assigns clk/btn1/btn2/buzzerb",
        defaulted && plan.valid.length >= 4 && plan.errors.length === 0,
        JSON.stringify(plan),
    );
    await page.screenshot({ path: join(OUT, "buzz1-pinplan.png") });

    // QSF export -> import round-trip (real UI functions)
    const qsf = await page.evaluate(() => window.__cyclone.sidebar.getPinPlan().qsfText || "");
    const qsfBack = await page.evaluate((text) => {
        window.__cyclone.sidebar.importQsfText(text, "buzz1.qsf");
        const p = window.__cyclone.sidebar.getPinPlan();
        return { ok: (p.validation?.errors || []).length === 0, valid: [...(p.validation?.validByNode || new Map())] };
    }, qsf);
    try { writeFileSync(join(OUT, "buzz1.qsf"), qsf); } catch { /* ignore */ }
    step(
        "QSF export/import round-trip",
        qsf.includes("PIN_110") && qsfBack.ok && qsfBack.valid.length >= 4,
        `${qsfBack.valid.length} assignments, ${qsf.split(/\r?\n/).length} lines`,
    );

    // 1 — compile (real click => AudioContext resume)
    await page.click("#ep-run");
    await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 120000 });
    await wait(700);

    const snap = () => page.evaluate(() => ({
        buzzer: window.__cyclone.state.buzzer || null,
        audio: window.__cyclone.audio.state(),
        badge: document.querySelector("#tb-audio-badge")?.textContent || "",
        entity: window.__cyclone.state.entity?.name || "",
        countdown: window.__cyclone.state.countdown || null,
    }));

    const dbg = await page.evaluate(() => {
        const p = window.__cyclone.sidebar.getPinPlan();
        return { valid: [...(p.validation?.validByNode || new Map())], errors: p.validation?.errors || [] };
    });
    console.log("Pin plan:", JSON.stringify(dbg.valid));

    const idle = await snap();
    step(
        "idle (buttons open) is Silent",
        idle.entity.toLowerCase() === "buzz1" && !idle.buzzer?.tone && idle.audio.frequency === 0 && /Silent|Muted/.test(idle.badge),
        JSON.stringify(idle),
    );
    await page.screenshot({ path: join(OUT, "buzz1-idle.png") });

    // 2 — hold KEY1
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, true));
    await page.waitForFunction(() => window.__cyclone.state.buzzer?.frequency === 800, { timeout: 15000 }).catch(() => {});
    await wait(400);
    const held = await snap();
    step(
        "hold KEY1 -> 800 Hz (62,500 cycles/period)",
        held.audio.frequency === 800 && /800 Hz/.test(held.badge) && held.buzzer?.cyclesPerPeriod === 62500,
        JSON.stringify(held),
    );
    await page.screenshot({ path: join(OUT, "buzz1-hold-800hz.png") });
    // SP1 close-up with the active pulse ring
    await page.evaluate(() => window.__cyclone.board.focusComponent("SP1"));
    await wait(800);
    await page.screenshot({ path: join(OUT, "buzz1-sp1-ring.png") });
    await page.evaluate(() => window.__cyclone.board.setPreset("iso"));

    // 3 — release KEY1 -> 1.0 s note, then silent. Wait for the refresh's new
    // buzzer object first (the 800 Hz from the hold is still current).
    await page.evaluate(() => {
        window.__buzzMark = window.__cyclone.state.buzzer;
        window.__cyclone.setPhysicalKeyPressed(0, false);
    });
    await page.waitForFunction(() => window.__cyclone.state.buzzer !== window.__buzzMark, { timeout: 15000 }).catch(() => {});
    await wait(1400);
    const released = await snap();
    step(
        "release KEY1 -> silent after ~1.0 s",
        released.audio.frequency === 0 && /Silent/.test(released.badge),
        JSON.stringify(released),
    );

    // 4 — KEY2 identical
    await page.evaluate(() => {
        window.__buzzMark3 = window.__cyclone.state.buzzer;
        window.__cyclone.setPhysicalKeyPressed(1, true);
    });
    await page.waitForFunction(() => window.__cyclone.state.buzzer !== window.__buzzMark3, { timeout: 15000 }).catch(() => {});
    await wait(400);
    const held2 = await snap();
    step(
        "hold KEY2 -> 800 Hz",
        held2.audio.frequency === 800 && /800 Hz/.test(held2.badge),
        JSON.stringify(held2),
    );
    await page.evaluate(() => {
        window.__buzzMark2 = window.__cyclone.state.buzzer;
        window.__cyclone.setPhysicalKeyPressed(1, false);
    });
    await page.waitForFunction(() => window.__cyclone.state.buzzer !== window.__buzzMark2, { timeout: 15000 }).catch(() => {});
    await wait(1400);
    const released2 = await snap();
    step(
        "release KEY2 -> silent after ~1.0 s",
        released2.audio.frequency === 0 && /Silent/.test(released2.badge),
        JSON.stringify(released2),
    );
    await page.screenshot({ path: join(OUT, "buzz1-released-silent.png") });

    // 5 — right sidebar is resizable (drag the left-edge handle)
    const before = await page.evaluate(() => {
        const r = document.querySelector(".ep-resizer")?.getBoundingClientRect();
        return { x: r ? r.x + 2 : 0, y: r ? r.y + 200 : 0, w: document.getElementById("right").getBoundingClientRect().width };
    });
    if (before.x) {
        await page.mouse.move(before.x, before.y);
        await page.mouse.down();
        await page.mouse.move(before.x - 110, before.y, { steps: 6 });
        await page.mouse.up();
    }
    await wait(250);
    const resized = await page.evaluate(() => ({
        w: document.getElementById("right").getBoundingClientRect().width,
        css: getComputedStyle(document.documentElement).getPropertyValue("--right-w").trim(),
    }));
    step("right sidebar drag-resizes", resized.w > before.w + 40, `before=${before.w.toFixed(0)} after=${resized.w.toFixed(0)} var=${resized.css}`);
    await page.screenshot({ path: join(OUT, "buzz1-sidebar-resized.png") });

    // 6 — Messages panel collapses to its summary
    const msgs = await page.evaluate(() => {
        const btn = document.querySelector('[data-act="toggle-msgs"]');
        if (!btn) return null;
        btn.click();
        const panel = document.querySelector("#ep-messages");
        const list = document.querySelector(".ep-msg-list");
        return {
            collapsed: panel.classList.contains("collapsed"),
            hidden: getComputedStyle(list).display === "none",
        };
    });
    step("messages panel collapsible", Boolean(msgs?.collapsed && msgs.hidden), JSON.stringify(msgs));
    await page.evaluate(() => document.querySelector('[data-act="toggle-msgs"]')?.click());

    // 7 — whole right sidebar collapses/expands (canvas reflows)
    await page.evaluate(() => document.querySelector('[data-act="collapse"]')?.click());
    await wait(350);
    const isCollapsed = await page.evaluate(() => document.getElementById("right").classList.contains("collapsed"));
    step("right sidebar collapses", isCollapsed);
    await page.screenshot({ path: join(OUT, "buzz1-sidebar-collapsed.png") });
    await page.evaluate(() => document.querySelector('[data-act="collapse"]')?.click());
    await wait(350);
    const isExpanded = await page.evaluate(() => !document.getElementById("right").classList.contains("collapsed"));
    step("right sidebar expands", isExpanded);
    await page.screenshot({ path: join(OUT, "buzz1-sidebar-expanded.png") });
    await page.screenshot({ path: join(OUT, "buzz1-messages-expanded.png") });

    // 8 — mute control exists and persists
    const mute = await page.evaluate(async () => {
        const before = window.__cyclone.audio.state().muted;
        window.__cyclone.audio.setMuted(!before);
        const after = window.__cyclone.audio.state().muted;
        window.__cyclone.audio.setMuted(before);
        return { before, after, stored: Boolean(localStorage.getItem("c4_audio_v1")) };
    });
    step("mute control toggles + persists", mute.after === !mute.before && mute.stored, JSON.stringify(mute));
} catch (err) {
    step("e2e completed", false, err?.stack || String(err));
} finally {
    try { await browser?.close(); } catch { /* ignore */ }
    try { browser?.disconnect(); } catch { /* ignore */ }
    reapOwnBrowser();
}

const summary = `${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — ${BASE}`;
console.log(summary);
appendFileSync(LOG, summary + "\n");
process.exit(failures === 0 ? 0 : 1);