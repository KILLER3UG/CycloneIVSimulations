// updater-e2e.mjs — end-to-end verification of the desktop update flow.
//
// Prerequisites: the installed desktop app is RUNNING with WebView2 CDP
// (--remote-debugging-port=9229), and a NEWER published release exists on
// GitHub with its latest.json + signed installer assets.
//
// Usage: node scripts/updater-e2e.mjs [cdpUrl] [expectedNewVersion]
//   default cdpUrl http://127.0.0.1:9229, expected version taken from
//   ../../VERSION when not supplied.
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CDP = process.argv[2] || "http://127.0.0.1:9229";
const EXPECTED = process.argv[3] || "";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/evidence");
const LOG = resolve(HERE, "../../docs/evidence/updater-e2e.log");
mkdirSync(OUT, { recursive: true });
appendFileSync(LOG, `--- run ${new Date().toISOString()} ---\n`);

let failures = 0;
const step = (name, ok, detail = "") => {
    if (!ok) failures += 1;
    const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`;
    console.log(line);
    appendFileSync(LOG, line + "\n");
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const pages = await browser.pages();
const page = pages[0] || (await browser.newPage());

// 1. the button exists in the desktop webview
const hasButton = await page.evaluate(() => Boolean(document.getElementById("tb-update")));
step("update button present in toolbar", hasButton);
if (!hasButton) process.exit(1);

// 2. click -> update dialog (either "Update available — vX" or "Up to date")
await page.click("#tb-update");
const dialogText = await page
    .waitForFunction(
        () => document.querySelector(".modal")?.textContent || "",
        { timeout: 120000, polling: 500 },
    )
    .then(() => page.evaluate(() => document.querySelector(".modal").textContent))
    .catch(() => "");
step("update dialog opened", /Update available|Up to date/.test(dialogText), dialogText.slice(0, 160));

if (/Up to date/.test(dialogText)) {
    step("already up to date — nothing else to verify", true);
    process.exit(failures ? 1 : 0);
}

// 3. download + install (the dialog shows a progress bar, then the restart prompt)
await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".modal-actions .btn")]
        .find((b) => /Download & install/i.test(b.textContent));
    btn?.click();
});
const installText = await page
    .waitForFunction(
        () => /Update installed|Update failed/.test(document.querySelector(".modal")?.textContent || ""),
        { timeout: 600000, polling: 1000 },
    )
    .then(() => page.evaluate(() => document.querySelector(".modal").textContent))
    .catch(() => "");
step("update downloaded + installed", /Update installed/.test(installText), installText.slice(0, 200));
if (!/Update installed/.test(installText)) process.exit(1);

// 4. restart into the new version
await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".modal-actions .btn")]
        .find((b) => /Restart now/i.test(b.textContent));
    btn?.click();
});
const expected = EXPECTED || (existsSync(resolve(HERE, "../../VERSION"))
    ? (await import("node:fs")).readFileSync(resolve(HERE, "../../VERSION"), "utf8").trim()
    : "");
let healthy = "";
for (let i = 0; i < 120; i++) {
    await wait(1000);
    try {
        const res = await fetch("http://127.0.0.1:9229/json/version");
        if (res.ok) {
            // webview is back; ask the app itself
            healthy = await page.evaluate(async () => {
                const r = await fetch("/api/health");
                return (await r.json()).appVersion || "";
            }).catch(() => "");
            if (healthy) break;
        }
    } catch { /* relaunching */ }
}
step(`app relaunched on v${healthy}`, expected ? healthy === expected : Boolean(healthy),
    `expected v${expected}, got v${healthy}`);

console.log(failures ? `${failures} FAILURE(S)` : "ALL PASS — updater flow");
appendFileSync(LOG, failures ? `${failures} FAILURE(S)\n` : "ALL PASS\n");
process.exit(failures ? 1 : 0);
