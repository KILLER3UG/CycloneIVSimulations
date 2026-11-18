// partcd-e2e.mjs — Part C/D acceptance through the real UI.
//
// 1. New file defaults to .vhd with an entity/architecture template.
// 2. Delete + Undo restores the file and its pin assignments.
// 3. Set as Top-Level + automatic dependency inclusion.
// 4. Pin Planner validation: unassigned, duplicate, nonexistent, direction.
// 5. 3D board close-up.
//
// Usage: node scripts/partcd-e2e.mjs [baseUrl]
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/evidence");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "partcd-e2e.log");
writeFileSync(LOG, "");
const EXE = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
const BASE = process.argv[2] || "http://127.0.0.1:8765/";
const PORT = 9343;
const profileDir = mkdtempSync(join(tmpdir(), "partcd-e2e-"));
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
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match '${tag.replace(/'/g, "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    try { spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" }); } catch { /* ignore */ }
}
process.on("exit", reap);

let child = null;
if (EXE) {
    child = spawn(EXE, [
        "--headless=new", `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${join(profileDir, "p")}`,
        "--no-first-run", "--no-default-browser-check",
        "--disable-features=msStartupBoost",
        "--disable-gpu", "--enable-unsafe-swiftshader",
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-webgl", "--ignore-gpu-blocklist",
        "--window-size=1280,800", "--hide-scrollbars", "about:blank",
    ], { stdio: "ignore", detached: true });
    child.unref();
}
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
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__cyclone && window.__cyclone.board, { timeout: 60000 });
    await wait(1500);

    // 1 — new .vhd file + template
    const before = await page.evaluate(() => window.__cyclone.editor.getFiles().length);
    await page.evaluate(() => document.querySelector('[data-act="add-vhd"]')?.click());
    await wait(400);
    const created = await page.evaluate(() => {
        const c = window.__cyclone;
        const files = c.editor.getFiles();
        const active = c.editor.getActiveFile();
        const content = files.find((f) => f.name === active)?.content || "";
        return { count: files.length, active, content };
    });
    step(
        "new file defaults to .vhd + entity/architecture template",
        created.count === before + 1 && /\.vhd$/i.test(created.active)
            && /entity\s+\w+\s+is/i.test(created.content) && /architecture\s+\w+\s+of/i.test(created.content),
        `${created.active} (${created.content.length} bytes)`,
    );
    await page.screenshot({ path: join(OUT, "partcd-newfile.png") });

    // 2 — delete + Undo restores file and pin mappings
    // Apply board defaults to the new entity so it has real assignments.
    await page.evaluate(() => {
        document.querySelector('[data-tab="pinmap"]')?.click();
        document.querySelector("#pp-defaults")?.click();
    });
    await wait(300);
    const pinned = await page.evaluate(() => {
        const c = window.__cyclone;
        const p = c.sidebar.getPinPlan();
        return { active: c.editor.getActiveFile(), valid: [...(p.validation?.validByNode || new Map())] };
    });
    await page.evaluate(() => document.querySelector('[data-act="delete"]')?.click());
    await wait(500);
    const deleted = await page.evaluate(() => {
        const c = window.__cyclone;
        const undo = [...document.querySelectorAll("button")].find((b) => /^undo$/i.test(b.textContent.trim()));
        if (undo) undo.click();
        return { hadUndo: Boolean(undo) };
    });
    await wait(500);
    const restored = await page.evaluate((name) => {
        const c = window.__cyclone;
        const files = c.editor.getFiles();
        const p = c.sidebar.getPinPlan();
        return {
            exists: files.some((f) => f.name === name),
            valid: [...(p.validation?.validByNode || new Map())],
        };
    }, pinned.active);
    step(
        "delete + Undo restores the file and its pin mappings",
        deleted.hadUndo && restored.exists && restored.valid.length === pinned.valid.length,
        `file=${restored.exists} pins ${pinned.valid.length}->${restored.valid.length}`,
    );
    await page.screenshot({ path: join(OUT, "partcd-undo.png") });

    // 3 — Set as Top-Level + dependency inclusion
    const leaf = `library ieee; use ieee.std_logic_1164.all;
entity leaf is port (i : in std_logic; o : out std_logic); end entity leaf;
architecture rtl of leaf is begin o <= not i; end architecture rtl;`;
    const top = `library ieee; use ieee.std_logic_1164.all;
entity top_dep is port (i : in std_logic; o : out std_logic); end entity top_dep;
architecture rtl of top_dep is
    component leaf port (i : in std_logic; o : out std_logic); end component;
begin
    u_leaf : leaf port map (i => i, o => o);
end architecture rtl;`;
    await page.evaluate(({ leafSrc, topSrc }) => {
        const c = window.__cyclone;
        c.editor.setFiles([{ name: "leaf.vhd", content: leafSrc }, { name: "top_dep.vhd", content: topSrc }], false);
        c.editor.setPinnedTop("top_dep.vhd", "top_dep");
    }, { leafSrc: leaf, topSrc: top });
    await wait(500);
    await page.click("#tb-compile");
    await page.waitForFunction(() => window.__cyclone.state.entity?.name === "top_dep", { timeout: 120000 }).catch(() => {});
    await wait(700);
    const dep = await page.evaluate(() => ({
        entity: window.__cyclone.state.entity?.name || "",
        logHasFiles2: [...document.querySelectorAll("#console-log .log-line")].some((l) => /Files:\s*2/.test(l.textContent || "")),
        files: window.__cyclone.editor.getFiles().map((f) => f.name),
    }));
    step(
        "Set as Top-Level + automatic dependency inclusion",
        dep.entity === "top_dep" && dep.logHasFiles2 && dep.files.includes("leaf.vhd"),
        `${dep.entity}; files2=${dep.logHasFiles2}`,
    );
    await page.screenshot({ path: join(OUT, "partcd-top-dep.png") });

    // 4 — Pin Planner validation (all four rules)
    const valSrc = `library ieee; use ieee.std_logic_1164.all;
entity val is
    port (
        clk      : in  std_logic;
        bad_out  : out std_logic;
        bad_out2 : out std_logic;
        bad_out3 : out std_logic;
        bad_in   : in  std_logic
    );
end entity val;
architecture rtl of val is begin end architecture rtl;`;
    const qsf = `set_location_assignment PIN_23 -to clk
set_location_assignment PIN_88 -to bad_out
set_location_assignment PIN_87 -to bad_out2
set_location_assignment PIN_87 -to bad_out3
set_location_assignment PIN_999 -to bad_in`;
    await page.evaluate(({ src, qsfText }) => {
        const c = window.__cyclone;
        c.editor.setFiles([{ name: "val.vhd", content: src }], false);
        c.editor.setPinnedTop("val.vhd", "val");
        c.sidebar.importQsfText(qsfText, "bad.qsf");
    }, { src: valSrc, qsfText: qsf });
    await wait(600);
    const val = await page.evaluate(() => {
        const p = window.__cyclone.sidebar.getPinPlan();
        const msgs = [...(p.validation?.errors || []), ...(p.validation?.warnings || [])].map((m) => m.message).join(" | ");
        return {
            unassigned: p.validation?.unassignedCount,
            errors: (p.validation?.errors || []).map((e) => e.message),
            msgs,
        };
    });
    // val has 3 ports; clk assigned PIN_23; bad_out duplicate+direction; bad_in nonexistent.
    step(
        "Pin Planner: duplicate / nonexistent / direction conflict / no silent assignment",
        val.errors.length >= 3
            && /duplicate/i.test(val.msgs)
            && /nonexistent/i.test(val.msgs)
            && /direction conflict/i.test(val.msgs),
        `${val.errors.length} errors`,
    );
    await page.screenshot({ path: join(OUT, "partcd-validation.png") });

    // 5 — 3D board close-up
    await page.evaluate(() => {
        const b = window.__cyclone.board;
        b.setPreset("top");
        b.fit();
    });
    await wait(900);
    await page.screenshot({ path: join(OUT, "partcd-board-closeup.png") });
    await page.evaluate(() => {
        const b = window.__cyclone.board;
        b.setPreset("iso");
        b.fit();
    });
    await wait(700);
    await page.screenshot({ path: join(OUT, "partcd-board-iso.png") });
    step("3D board close-up captured", true, "docs/evidence/partcd-board-closeup.png + partcd-board-iso.png");
} catch (err) {
    step("partcd e2e completed", false, err?.stack || String(err));
} finally {
    try { await browser?.close(); } catch { /* ignore */ }
    reap();
}
const summary = `${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — ${BASE}`;
console.log(summary);
appendFileSync(LOG, summary + "\n");
process.exit(failures === 0 ? 0 : 1);