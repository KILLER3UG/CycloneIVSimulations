// debug-hud-probe.mjs — dump computed layout of the bottom HUD bar.
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:8765/";
const chromeDir = "C:/Program Files/Google/Chrome/Application";
const exe = readdirSync(chromeDir).find((f) => /^chrome\.exe$/i.test(f));
const child = spawn(join(chromeDir, exe || "chrome.exe"), [
    "--headless=new", "--remote-debugging-port=9345", "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "about:blank",
], { stdio: "ignore", detached: true });
child.unref();
await new Promise((r) => setTimeout(r, 2500));

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9345", defaultViewport: { width: 1280, height: 800 } });
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__cyclone && window.__cyclone.board, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));
// reproduce the buzz1-e2e boot state: example -> pin defaults -> compile
await page.evaluate(() => {
    const sel = document.querySelector("#tb-examples");
    const opt = sel && [...sel.options].find((o) => /buzz1/i.test(`${o.value} ${o.textContent}`));
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
});
await new Promise((r) => setTimeout(r, 1000));
await page.click('[data-tab="pinmap"]').catch(() => {});
await new Promise((r) => setTimeout(r, 300));
await page.evaluate(() => document.querySelector("#pp-defaults")?.click());
await new Promise((r) => setTimeout(r, 500));
await page.click("#tb-compile");
await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 60000 })
    .catch(() => console.log("RING never programmed"));
await new Promise((r) => setTimeout(r, 1000));
// hold K1 so the buzzer sounds, then dump the 3D ring state
await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, true));
await page.waitForFunction(() => document.getElementById("tb-audio-badge")?.textContent === "800 Hz", { timeout: 8000 })
    .catch(() => console.log("RING badge never reached 800 Hz"));
await new Promise((r) => setTimeout(r, 1200));
const ring = await page.evaluate(() => {
    const b = window.__cyclone.board;
    const r = b._buzzerRing;
    return {
        buzzerOn: b.io?.buzzer?.on ?? null, programmed: b.programmed, power: b.power, running: b.running,
        badge: document.getElementById("tb-audio-badge")?.textContent,
        sbBuzzer: window.__cyclone.state?.buzzer || null,
        mapVectors: window.__cyclone.state?.stimulusMap?.vectors ? Object.keys(window.__cyclone.state.stimulusMap.vectors).length : 0,
        ring: r ? {
            visible: r.visible, opacity: Number(r.material.opacity.toFixed(3)),
            depthTest: r.material.depthTest, renderOrder: r.renderOrder,
            inScene: !!r.parent, pos: r.position.toArray().map((v) => Math.round(v * 10) / 10),
        } : null,
    };
});
console.log("RING " + JSON.stringify(ring));
const info = await page.evaluate(() => {
    const dump = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        return { sel, pos: cs.position, display: cs.display, width: cs.width, height: cs.height,
            rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
            order: cs.order, flexDir: cs.flexDirection };
    };
    return {
        pill: dump(".board-hud-pill"),
        stats: dump("#stats"),
        controls: dump("#board-controls"),
        row: dump("#bc-row"),
        statsKids: [...document.querySelectorAll("#stats > *")].map((s) => ({
            t: s.textContent.trim(), w: Math.round(s.getBoundingClientRect().width),
        })),
        statsScroll: (() => { const el = document.getElementById("stats"); return { sw: el.scrollWidth, cw: el.clientWidth }; })(),
        ctrlKids: [...document.querySelectorAll("#bc-row > *")].map((s) => ({
            t: s.textContent.trim(), w: Math.round(s.getBoundingClientRect().width),
        })),
    };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
try { browser.disconnect(); } catch { /* ignore */ }
try { process.kill(-child.pid); } catch { /* ignore */ }
