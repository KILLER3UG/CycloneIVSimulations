// geometry-check.mjs — Phase 4 layout gate.
// Opens the studio at 1440x900 and 1280x800 and asserts the Quartus-style
// shell geometry: every zone present, nothing clipped or overflowing, the
// status bar exactly 24px, the HUD/cam pill inside the board dock, and zero
// console/page errors. Screenshots land in docs/evidence/phase4/.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:8123/";
const OUT = resolve(import.meta.dirname, "../../docs/evidence/phase4");
mkdirSync(OUT, { recursive: true });

const SIZES = [
    { w: 1440, h: 900 },
    { w: 1280, h: 800 },
];

const fails = [];
function check(name, ok, detail) {
    if (!ok) fails.push(`${name}: ${detail}`);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

const browser = await chromium.launch();
try {
    for (const { w, h } of SIZES) {
        const page = await browser.newPage({ viewport: { width: w, height: h } });
        const errors = [];
        page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(BASE, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#board-host canvas", { timeout: 30_000 });
        await page.waitForTimeout(1200);

        const geo = await page.evaluate(() => {
            const rect = (sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: r.x, y: r.y, w: r.width, h: r.height,
                         visible: r.width > 0 && r.height > 0 };
            };
            return {
                menubar: rect("#menubar"),
                toolbar: rect("#toolbar"),
                left: rect("#left"),
                center: rect("#center"),
                right: rect("#right"),
                bottom: rect("#bottom"),
                statusbar: rect("#statusbar"),
                compile: rect("#tb-compile"),
                boardSelect: rect("#tb-board-select"),
                camPill: rect("#cam-presets"),
                hud: rect(".board-hud-pill"),
                canvas: rect("#board-host canvas"),
                docOverflowX: document.documentElement.scrollWidth > window.innerWidth,
            };
        });

        check(`[${w}x${h}] menubar present`, geo.menubar?.visible, JSON.stringify(geo.menubar));
        check(`[${w}x${h}] menubar 30px`, Math.abs((geo.menubar?.h ?? 0) - 30) <= 2, `h=${geo.menubar?.h}`);
        check(`[${w}x${h}] toolbar 42px`, Math.abs((geo.toolbar?.h ?? 0) - 42) <= 2, `h=${geo.toolbar?.h}`);
        check(`[${w}x${h}] statusbar 24px`, Math.abs((geo.statusbar?.h ?? 0) - 24) <= 2, `h=${geo.statusbar?.h}`);
        check(`[${w}x${h}] navigator dock present`, geo.left?.visible && geo.left.w > 150, JSON.stringify(geo.left));
        check(`[${w}x${h}] center editor dock present`, geo.center?.visible && geo.center.w > 200, JSON.stringify(geo.center));
        check(`[${w}x${h}] board dock present`, geo.right?.visible && geo.right.w > 200, JSON.stringify(geo.right));
        check(`[${w}x${h}] bottom dock present`, geo.bottom?.visible, JSON.stringify(geo.bottom));
        check(`[${w}x${h}] no horizontal document overflow`, !geo.docOverflowX, `overflowX=${geo.docOverflowX}`);
        check(`[${w}x${h}] Compile & Run visible`, geo.compile?.visible, JSON.stringify(geo.compile));
        check(`[${w}x${h}] board selector visible`, geo.boardSelect?.visible, JSON.stringify(geo.boardSelect));
        check(`[${w}x${h}] camera pill inside board dock`,
            geo.camPill?.visible && geo.camPill.x >= geo.right.x && geo.camPill.x + geo.camPill.w <= geo.right.x + geo.right.w,
            JSON.stringify(geo.camPill));
        check(`[${w}x${h}] HUD inside board dock`,
            geo.hud?.visible && geo.hud.x >= geo.right.x && geo.hud.x + geo.hud.w <= geo.right.x + geo.right.w,
            JSON.stringify(geo.hud));
        check(`[${w}x${h}] 3D canvas fills the board dock`,
            geo.canvas?.visible && geo.canvas.w > 100 && geo.canvas.h > 100, JSON.stringify(geo.canvas));
        // No zone may spill past the viewport.
        for (const [name, r] of Object.entries(geo)) {
            if (!r || typeof r.x !== "number") continue;
            check(`[${w}x${h}] ${name} inside viewport`,
                r.x >= -1 && r.y >= -1 && r.x + r.w <= w + 1 && r.y + r.h <= h + 1,
                JSON.stringify(r));
        }
        check(`[${w}x${h}] zero console/page errors`, errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

        await page.screenshot({ path: resolve(OUT, `studio-${w}x${h}.png`), fullPage: false });
        await page.close();
    }
} finally {
    await browser.close();
}

console.log(fails.length ? `\nGEOMETRY CHECK FAILED: ${fails.length} problem(s)` : "\nGEOMETRY CHECK PASSED");
process.exit(fails.length ? 1 : 0);
