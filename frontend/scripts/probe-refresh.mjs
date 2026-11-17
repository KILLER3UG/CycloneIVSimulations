// Measure live-refresh latency: input change -> board output update, and
// confirm input changes skip the compile pipeline.
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const PORT = 9351;
const profileDir = mkdtempSync(join(tmpdir(), "refresh-probe-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanup() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match 'refresh-probe-' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" }); } catch {}
}
let child = spawn(EXE, ["--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(profileDir, "p")}`, "--no-first-run", "--no-default-browser-check",
  "--disable-features=msStartupBoost", "--disable-gpu", "--enable-unsafe-swiftshader",
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist",
  "--window-size=1400,850", "--hide-scrollbars", "about:blank"], { stdio: "ignore", detached: true });
child.unref();
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) { await wait(500); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); ready = r.ok; } catch {} }
  if (!ready) throw new Error("port never opened");
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: { width: 1400, height: 850 } });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:8000/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => window.__cyclone && document.querySelector("#board-host canvas"), { timeout: 40000 });
  await wait(1500);

  async function runAndLoad(designName, entity) {
    const src = await (await fetch("http://127.0.0.1:8000/api/examples")).json();
    // upload via editor
    const content = await page.evaluate(async (n) => {
      const ex = (await (await fetch("/api/examples")).json()).examples.find((e) => e.id === n);
      return ex ? ex.source : null;
    }, designName).catch(() => null);
    // use the QA design files instead (not in examples): read from disk
    return content;
  }

  // Use counter design from examples for a clocked check; use the editor to load sevseg_keys
  await page.evaluate(async () => {
    const ex = (await (await fetch("/api/examples")).json()).examples.find((e) => e.id === "sevseg_keys");
    window.__cyclone.editor.setFiles([{ name: ex.file, content: ex.source }], false);
    window.__cyclone.editor.setTopEntity("sevseg");
  });
  // full run
  await page.evaluate(() => window.__cyclone.run());
  await page.waitForFunction(() => window.__cyclone.state.simTimeNs > 0 && !window.__cyclone.state.running, { timeout: 60000 });

  // Now toggle a DIP switch and measure time to board update (dtube change) with NO compile step.
  const before = await page.evaluate(() => ({
    t: window.__cyclone.state.simTimeNs,
    dtube: window.__cyclone.state.liveValues.dtube,
    compiles: document.querySelectorAll(".tb-step.done").length,
  }));
  const t0 = Date.now();
  // click strip switch 0 (S1) -> refresh
  await page.evaluate(() => document.querySelector('#bc-row .bc-switch[data-index="0"]').click());
  // poll until dtube changes (board updated)
  let changed = false;
  for (let i = 0; i < 200; i++) {
    await wait(50);
    const v = await page.evaluate(() => window.__cyclone.state.liveValues.dtube);
    if (v !== before.dtube) { changed = true; break; }
  }
  const elapsed = Date.now() - t0;
  const after = await page.evaluate(() => ({
    dtube: window.__cyclone.state.liveValues.dtube,
    status: window.__cyclone.state.status,
    refreshing: window.__cyclone.state.refreshing,
    // pipeline steps should NOT re-run compile (steps stay done, no re-active)
    activeStep: document.querySelector(".tb-step.active")?.textContent?.trim() || null,
  }));
  console.log(JSON.stringify({ before, after, changed, elapsedMs: elapsed }, null, 2));
  await browser.disconnect();
} catch (e) {
  console.log("PROBE ERROR:", e.message);
} finally {
  cleanup(); await wait(400); cleanup();
}
process.exit(0);