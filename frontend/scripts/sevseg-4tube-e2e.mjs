// sevseg-4tube-e2e.mjs — STOP 1D Section 1: 4-tube 7-segment acceptance.
//
// 1. 4-tube multiplexed scan (cnt(15 downto 14) divider) showing 1/2/3/4 —
//    all four tubes integrate via POV at ~25% duty (brightness normalization).
// 2. Partial 2-tube design (dtube(2 downto 1) -> DIG0=PIN_133, DIG1=PIN_135,
//    dp PIN_127 unassigned) — D3/D4 (the two rightmost tubes) light,
//    D1/D2 (leftmost) stay dark.
// 3. 4-tube static drive (all DIG pins '0', all segments lit) — all four tubes
//    fully lit; pressing KEY1 changes every tube to digit '1'.
//
// Assertions read `board.io.display.segHold` — the rendered persistence-of-
// vision image (per-(tube,segment) duty cycle) that drives the 3D mesh.
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/evidence");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "sevseg-4tube-e2e.log");
writeFileSync(LOG, "");
const EXE = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p));
const BASE = process.argv[2] || "http://127.0.0.1:8765/";
const PORT = 9347;
const profileDir = mkdtempSync(join(tmpdir(), "sevseg4tube-e2e-"));
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
    "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1280,800", "--hide-scrollbars", "about:blank",
], { stdio: "ignore", detached: true });
child.unref();
let ready = false;
for (let i = 0; i < 90 && !ready; i += 1) {
    await wait(500);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); ready = r.ok; } catch { /* not yet */ }
}
if (!ready) { step("browser started", false); process.exit(1); }

const HEAD = `library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;\n`;
const VHDL = {
    // 1) multiplexed: cnt(15 downto 14) selects digit -> 16384 cycles/digit
    mux: HEAD + `entity sev4_mux is
    port (clk : in std_logic; dtube : out std_logic_vector(3 downto 0);
          seven_seg : out std_logic_vector(6 downto 0));
end sev4_mux;
architecture rtl of sev4_mux is
    signal cnt : unsigned(15 downto 0) := (others => '0');
begin
    process(clk) begin
        if rising_edge(clk) then cnt <= cnt + 1; end if;
    end process;
    process(cnt) begin
        case cnt(15 downto 14) is
            when "00" => dtube <= "1110";
            when "01" => dtube <= "1101";
            when "10" => dtube <= "1011";
            when others => dtube <= "0111";
        end case;
    end process;
    with cnt(15 downto 14) select seven_seg <=
        "1111001" when "00",   -- 1
        "0100100" when "01",   -- 2
        "0110000" when "10",   -- 3
        "0011001" when others; -- 4
end architecture rtl;`,
    // 2) partial: only dtube(2 downto 1) -> DIG0 (PIN_133) + DIG1 (PIN_135)
    partial: HEAD + `entity sev4_part is
    port (clk : in std_logic; dtube : out std_logic_vector(2 downto 1);
          seven_seg : out std_logic_vector(6 downto 0));
end sev4_part;
architecture rtl of sev4_part is
    signal cnt : unsigned(15 downto 0) := (others => '0');
begin
    process(clk) begin
        if rising_edge(clk) then cnt <= cnt + 1; end if;
    end process;
    process(cnt) begin
        case cnt(15 downto 14) is
            when "00" => dtube <= "11";
            when "01" => dtube <= "10";
            when "10" => dtube <= "01";
            when others => dtube <= "11";
        end case;
    end process;
    with cnt(15 downto 14) select seven_seg <=
        "1111001" when "00",   -- 1
        "0100100" when "01",   -- 2
        "0110000" when "10",   -- 3
        "0011001" when others; -- 4
end architecture rtl;`,
    // 3) static: all four digit enables held '0', all segments lit when released
    stat: HEAD + `entity sev4_stat is
    port (clk : in std_logic; key : in std_logic_vector(3 downto 0);
          dtube : out std_logic_vector(3 downto 0);
          seven_seg : out std_logic_vector(6 downto 0));
end sev4_stat;
architecture rtl of sev4_stat is
begin
    dtube <= "0000";
    with key select seven_seg <=
        "1111001" when "1110",   -- KEY1 -> 1
        "0100100" when "1101",   -- KEY2 -> 2
        "0110000" when "1011",   -- KEY3 -> 3
        "0011001" when "0111",   -- KEY4 -> 4
        "0000000" when others;   -- released -> all segments lit
end architecture rtl;`,
};

let browser = null;
try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: { width: 1280, height: 800 } });
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__cyclone && window.__cyclone.board, { timeout: 60000 });
    await wait(1200);

    const completions = () => page.evaluate(() =>
        [...document.querySelectorAll("#console-log .log-line")]
            .filter((l) => l.textContent.includes("Simulation complete")).length);
    const settle = async (timeoutMs = 40000) => {
        const before = await completions();
        const t0 = Date.now();
        for (;;) {
            await wait(250);
            if ((await completions()) > before) break;
            if (Date.now() - t0 > timeoutMs) break;
        }
        await wait(600);
    };
    // load() is async now: changing files/pins triggers debounced auto re-runs
    // (ENG-10) whose completions must NOT be mistaken for the compile's own
    // capture — let them finish here, before compile() snapshots the counter.
    const load = async (src, top) => {
        await page.evaluate(({ s, t }) => {
            const c = window.__cyclone;
            c.editor.setFiles([{ name: "design.vhd", content: s }], false);
            c.editor.setPinnedTop("design.vhd", t);
            document.querySelector('[data-tab="pinmap"]')?.click();
            document.querySelector("#pp-clear")?.click();
            document.querySelector("#pp-defaults")?.click();
        }, { s: src, t: top });
        await wait(400);
        await settle(60000);
    };
    // wait for a "Simulation complete" line logged AFTER this click — the
    // capture that belongs to the design compiled here (programmed is already
    // true from the previous design, so it cannot discriminate).
    const compile = async () => {
        const before = await completions();
        await page.click("#tb-compile");
        await page.waitForFunction((n) => {
            return [...document.querySelectorAll("#console-log .log-line")]
                .filter((l) => l.textContent.includes("Simulation complete")).length > n;
        }, { timeout: 120000, polling: 250 }, before);
        await wait(800);
    };
    // segHold[d*8 + b] = rendered POV duty for tube d, segment b (a..g = 0..6).
    // tube 0 = DIG0 = rightmost = board label D4; tube 3 = DIG3 = leftmost = D1.
    const tubes = () => page.evaluate(() => {
        const d = window.__cyclone.board.io.display;
        return [0, 1, 2, 3].map((i) =>
            Array.from(d.segHold.slice(i * 8, i * 8 + 7)).map((v) => Math.round(v * 1000) / 1000));
    });
    const lit = (tube, thr = 0.12) => tube.some((v) => v > thr);

    // ---- 1. 4-tube multiplexed scan -> 1/2/3/4 via POV -----------------
    await load(VHDL.mux, "sev4_mux");
    await compile();
    await settle();
    let t = await tubes();
    const litCount = t.filter((x) => lit(x)).length;
    const distinct = new Set(t.map((x) => JSON.stringify(x))).size;
    // 1-of-4 mux: every lit segment is on ~25% of the scan (brightness norm)
    const duties = t.flat().filter((v) => v > 0.12);
    const dutyOk = duties.length > 0 && duties.every((v) => v >= 0.18 && v <= 0.35);
    step("1) 4-tube mux: all 4 tubes lit via POV", litCount === 4, `lit=${litCount} tubes=${JSON.stringify(t)}`);
    step("1a) 4-tube mux: four distinct digit images", distinct === 4, `distinct=${distinct}`);
    step("1b) 4-tube mux: lit-segment duty normalized to ~1/4 scan", dutyOk, `duties=${JSON.stringify(duties)}`);
    await page.screenshot({ path: join(OUT, "sevseg-4tube-mux.png") });

    // ---- 2. partial 2-tube (only DIG0+DIG1 assigned) -------------------
    await load(VHDL.partial, "sev4_part");
    await compile();
    await settle();
    t = await tubes();
    // DIG0/DIG1 = board labels D4/D3 (rightmost two) -> lit; D1/D2 dark
    step("2) partial 2-tube (DIG0,DIG1) -> D3+D4 lit, D1+D2 dark",
        lit(t[0]) && lit(t[1]) && !lit(t[2]) && !lit(t[3]), JSON.stringify(t));
    // dp (bit 7, PIN_127) is unassigned -> must stay dark on the lit tubes
    const dp = await page.evaluate(() => {
        const d = window.__cyclone.board.io.display;
        return [0, 1].map((i) => Math.round(d.segHold[i * 8 + 7] * 1000) / 1000);
    });
    step("2a) unassigned dp (PIN_127) stays dark", dp.every((v) => v <= 0.12), `dp=${JSON.stringify(dp)}`);
    await page.screenshot({ path: join(OUT, "sevseg-4tube-partial.png") });

    // ---- 3. static drive: all tubes fully lit --------------------------
    await load(VHDL.stat, "sev4_stat");
    await compile();
    await settle();
    t = await tubes();
    const allLit = t.every((x) => x.every((v) => v > 0.85));
    step("3) static drive (all DIG '0', seg '0000000') -> all 4 tubes fully lit", allLit, JSON.stringify(t));
    await page.screenshot({ path: join(OUT, "sevseg-4tube-static.png") });

    // ---- 3b. KEY1 pressed -> every tube shows digit '1' (segments b,c) --
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, true));
    await settle();
    t = await tubes();
    // digit '1' lights segments b (index 1) and c (index 2)
    const one = t.every((x) => x[1] > 0.85 && x[2] > 0.85 && x.slice(3).every((v) => v < 0.12) && x[0] < 0.12);
    step("3b) KEY1 pressed -> all tubes show '1' (segments b,c)", one, JSON.stringify(t));
    await page.screenshot({ path: join(OUT, "sevseg-4tube-key1.png") });

    // ---- 4. the BUNDLED sevseg_4tube example is interactive on K1..K4 ----
    // Load it from [Examples v], compile, then press K1..K4: each press must
    // show that digit on ALL four tubes in < 25 ms with ZERO http requests
    // (the pre-computed stimulus map applies the state synchronously).
    await page.evaluate(() => {
        const sel = document.querySelector("#tb-examples");
        const opt = [...sel.options].find((o) => /sevseg_4tube/i.test(`${o.value} ${o.textContent}`));
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await wait(800);
    await page.click('[data-tab="pinmap"]');
    await wait(300);
    await page.evaluate(() => document.querySelector("#pp-defaults")?.click());
    await wait(400);
    await page.click("#tb-compile");
    await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 120000 });
    await settle();
    await page.evaluate(() => {
        window.__http = 0;
        const of = window.fetch;
        window.fetch = (...a) => { window.__http += 1; return of.apply(window, a); };
        const oo = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (...a) { window.__http += 1; return oo.apply(this, a); };
    });
    const digitSegs = { 1: [1, 2], 2: [0, 1, 3, 4, 6], 3: [0, 1, 2, 3, 6], 4: [1, 2, 5, 6] };
    const latencies = [];
    let keysOk = true;
    for (let k = 0; k < 4; k += 1) {
        const r = await page.evaluate((idx) => {
            const t0 = performance.now();
            window.__cyclone.setPhysicalKeyPressed(idx, true);
            const d = window.__cyclone.board.io.display;
            const tt = [0, 1, 2, 3].map((i) => Array.from(d.segHold.slice(i * 8, i * 8 + 7)).map((v) => Math.round(v * 100) / 100));
            return { ms: Math.round((performance.now() - t0) * 100) / 100, tt };
        }, k);
        latencies.push(r.ms);
        const want = digitSegs[k + 1];
        const glyphOk = r.tt.every((tube) => want.every((b) => tube[b] >= 0.18)
            && tube.every((v, i) => (want.includes(i) ? v >= 0.18 : v < 0.12)));
        if (!(glyphOk && r.ms < 25)) keysOk = false;
        await page.screenshot({ path: join(OUT, `sevseg-4tube-key${k + 1}-bundled.png`) });
        await page.evaluate((idx) => window.__cyclone.setPhysicalKeyPressed(idx, false), k);
        await wait(250);
    }
    // toggling S1 (DIP shares the KEY net) must behave exactly like K1
    await page.evaluate(() => window.__cyclone.toggleDip(0));
    await wait(400);
    const dipT = await tubes();
    const dipOk = dipT.every((tube) => tube[1] >= 0.18 && tube[2] >= 0.18 && tube[0] < 0.12 && tube.slice(3).every((v) => v < 0.12));
    await page.evaluate(() => window.__cyclone.toggleDip(0));
    await wait(250);
    const httpCount = await page.evaluate(() => window.__http);
    step("4) bundled sevseg_4tube: K1..K4 each show their digit on all tubes < 25 ms, zero HTTP",
        keysOk && httpCount === 0, `latencies=${latencies} http=${httpCount}`);
    step("4a) toggling S1 shows 1111 (shared KEY/DIP nets)", dipOk, JSON.stringify(dipT));
    await page.screenshot({ path: join(OUT, "sevseg-4tube-dip.png") });
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
