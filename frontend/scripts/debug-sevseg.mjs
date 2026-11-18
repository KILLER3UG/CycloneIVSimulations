// debug-sevseg.mjs — diagnostic for the sevseg 4-tube e2e. Mirrors the e2e
// flow for all three designs and reports per-design pin assignment, compile
// result, programmed state and tube values, so the hanging step is visible.
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const EXE = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p));
const PORT = 9349;
const profileDir = mkdtempSync(join(tmpdir(), "dbgsev-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function reap() {
    const tag = basename(profileDir);
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match '${tag}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    try { spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" }); } catch { /* ignore */ }
}
process.on("exit", reap);

const HEAD = `library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;\n`;
const VHDL = {
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
        "1111001" when "00", "0100100" when "01",
        "0110000" when "10", "0011001" when others;
end architecture rtl;`,
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
        "1111001" when "00", "0100100" when "01",
        "0110000" when "10", "0011001" when others;
end architecture rtl;`,
    stat: HEAD + `entity sev4_stat is
    port (clk : in std_logic; key : in std_logic_vector(3 downto 0);
          dtube : out std_logic_vector(3 downto 0);
          seven_seg : out std_logic_vector(6 downto 0));
end sev4_stat;
architecture rtl of sev4_stat is
begin
    dtube <= "0000";
    with key select seven_seg <=
        "1111001" when "1110", "0100100" when "1101",
        "0110000" when "1011", "0011001" when "0111",
        "1111111" when others;
end architecture rtl;`,
};

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
if (!ready) { console.log("browser did not start"); process.exit(1); }

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: { width: 1280, height: 800 } });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 300)));
await page.goto("http://127.0.0.1:8765/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__cyclone && window.__cyclone.board, { timeout: 60000 });
console.log("boot ok");
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
    await wait(450);
};

for (const [top, src] of Object.entries(VHDL)) {
    await page.evaluate(({ s, t }) => {
        const c = window.__cyclone;
        c.editor.setFiles([{ name: "design.vhd", content: s }], false);
        c.editor.setPinnedTop("design.vhd", t);
        document.querySelector('[data-tab="pinmap"]')?.click();
        document.querySelector("#pp-clear")?.click();
        document.querySelector("#pp-defaults")?.click();
    }, { s: src, t: top });
    await wait(400);
    const pins = await page.evaluate(() => {
        const p = window.__cyclone.sidebar.getPinPlan();
        return { assigned: p.validation?.assignedCount, errors: (p.validation?.errors || []).slice(0, 3) };
    });
    await page.click("#tb-compile");
    const ok = await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 45000 })
        .then(() => true).catch(() => false);
    const st = await page.evaluate(() => {
        const S = window.__cyclone.state;
        return {
            programmed: S.programmed, compileOk: S.compileResult?.ok ?? null,
            compileErrors: (S.compileResult?.errors || []).slice(0, 3),
        };
    });
    await settle();
    const dbg = await page.evaluate(() => {
        const b = window.__cyclone.board;
        const d = b.io.display;
        const sl = (a) => [0, 1, 2, 3].map((i) => Array.from(a.slice(i * 8, i * 8 + 7)).map((v) => Math.round(v * 100) / 100));
        return {
            scanHz: b._scanHz, dutyTotal: b._dutyTotal,
            dutyLit: sl(b._dutyLit), segHold: sl(d.segHold), segCurrent: sl(d.segCurrent),
            segTarget: sl(d.segTarget), ghost: sl(b._ghost), digitOn: Array.from(d.digitOn),
        };
    });
    console.log(`\n=== ${top} ===`);
    console.log("  pins:", JSON.stringify(pins));
    console.log("  programmed:", ok, JSON.stringify(st));
    console.log("  scanHz:", dbg.scanHz, "dutyTotal:", dbg.dutyTotal, "digitOn:", JSON.stringify(dbg.digitOn));
    console.log("  dutyLit:   ", JSON.stringify(dbg.dutyLit));
    console.log("  segHold:   ", JSON.stringify(dbg.segHold));
    console.log("  segCurrent:", JSON.stringify(dbg.segCurrent));
    console.log("  segTarget: ", JSON.stringify(dbg.segTarget));
    console.log("  ghost:     ", JSON.stringify(dbg.ghost));
}
await browser.close();
reap();
process.exit(0);
