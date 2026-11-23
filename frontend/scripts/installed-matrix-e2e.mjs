// installed-matrix-e2e.mjs — Phase 5 live verification inside the INSTALLED
// desktop .exe (attaches via WebView2 CDP like installed-app-e2e.mjs).
//
// Covers what the standard installed-app suite does not:
//   * the Phase 4 IDE shell (menubar, Tasks pipeline, Messages filters,
//     status bar) renders inside the installed binary,
//   * buzzb.vhd: all four tones on ALL FOUR keys AND DIP switches with the
//     exact 500/800/1000/1600 Hz audio + SP1 ring + badge,
//   * a stateful button counter keeps its count across presses (live co-sim,
//     no stateless snap-back),
//   * DE0-Nano board switch inside the installed app.
//
// Usage: node scripts/installed-matrix-e2e.mjs [cdpUrl]   (default :9229)

import puppeteer from "puppeteer-core";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CDP = process.argv[2] || "http://127.0.0.1:9229";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/evidence/installed-app");
const LOG = resolve(HERE, "../../docs/evidence/installed-matrix-e2e.log");
mkdirSync(OUT, { recursive: true });

let failures = 0;
const step = (name, ok, detail = "") => {
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    appendFileSync(LOG, `${ok ? "PASS" : "FAIL"}  ${name}  | ${detail}\n`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;
for (let i = 0; i < 30 && !browser; i += 1) {
    try {
        browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
    } catch {
        process.stdout.write(".");
        await wait(2000);
    }
}
if (!browser) {
    console.error(`Could not connect to the installed app at ${CDP}`);
    process.exit(1);
}
console.log(`\nConnected to the installed app via ${CDP}`);
const pageTarget = browser.targets().find((t) => t.type() === "page" && /^http:\/\/127\.0\.0\.1:\d+/.test(t.url()));
if (!pageTarget) {
    console.error("No app page target found");
    process.exit(1);
}
const page = await pageTarget.page();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e?.message || e)));
await page.waitForFunction(() => window.__cyclone && window.__cyclone.board, { timeout: 60000 });
await wait(1200);

function frequencyOf(state) {
    return state?.buzzer?.frequency || 0;
}

/** Compile an example through the UI and wait for the live handover. */
async function compileExample(id) {
    await page.evaluate((exId) => {
        const sel = document.querySelector("#tb-examples");
        const opt = [...sel.options].find((o) => new RegExp(exId, "i").test(`${o.value} ${o.textContent}`));
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, id);
    await wait(700);
    await page.click('[data-ctab="pinmap"]');
    await wait(300);
    await page.evaluate(() => document.querySelector("#pp-defaults")?.click());
    await wait(400);
    await page.click("#tb-compile");
    await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 120000 });
    // The live pill appears once the batch capture hands over to live mode.
    await page.waitForFunction(() => !document.getElementById("tb-live-pill")?.hidden, { timeout: 90000 });
    await wait(800);
}

// ---------------------------------------------------------------- step A --
// The Phase 4 IDE shell renders inside the installed binary.
{
    const shell = await page.evaluate(() => ({
        menus: [...document.querySelectorAll("#menubar .mb-label")].map((m) => m.textContent),
        tasks: [...document.querySelectorAll("#tasks-host .tk-row .tk-label")].map((t) => t.textContent),
        statusCells: ["st-cursor", "st-lang", "st-board", "st-elapsed"].filter((id) => !!document.getElementById(id)),
        msgFilters: [...document.querySelectorAll("#bottompanel .msg-filter")].map((b) => b.dataset.sev),
        boardDockTab: document.querySelector("#right-tabs .rt-tab.active")?.dataset.rtab || null,
        entity: document.getElementById("mb-top-entity")?.textContent || null,
    }));
    step("A menubar: File/Edit/View/Assignments/Processing/Tools",
        JSON.stringify(shell.menus) === JSON.stringify(["File", "Edit", "View", "Assignments", "Processing", "Tools"]),
        shell.menus.join("|"));
    step("A Tasks pipeline: five live stages",
        shell.tasks.length === 5 && /Compile Design/.test(shell.tasks[0]) && /Load Virtual Board/.test(shell.tasks[4]),
        shell.tasks.join(" -> "));
    step("A status bar: cursor + language + board + elapsed cells",
        shell.statusCells.length === 4, shell.statusCells.join(","));
    step("A Messages: All/Errors/Warnings/Info severity filters",
        JSON.stringify(shell.msgFilters) === JSON.stringify(["all", "error", "warning", "info"]),
        shell.msgFilters.join("|"));
    step("A board dock defaults to the 3D board", shell.boardDockTab === "board3d", shell.boardDockTab);
    await page.screenshot({ path: join(OUT, "matrix-00-shell.png") });
}

// ---------------------------------------------------------------- step B --
// buzzb.vhd: four tones x (keys + DIP), exact frequencies, ring, badge.
{
    await compileExample("buzzb");
    const entity = await page.evaluate(() => window.__cyclone.state.entity?.name);
    step("B buzzb compiled with auto pin map (top entity buzzb)", entity === "buzzb", entity);

    const pins = await page.evaluate(() => window.__cyclone.state.compileBoard?.pins || {});
    step("B auto pin map: btn1..4 -> KEY1..4, buzzerb -> BUZZER pin, no manual editing",
        JSON.stringify(pins.btn1) === JSON.stringify(["PIN_88"])
        && JSON.stringify(pins.btn4) === JSON.stringify(["PIN_91"])
        && JSON.stringify(pins.buzzerb) === JSON.stringify(["PIN_110"]),
        JSON.stringify(pins));

    // Idle: silent.
    const idle = await page.evaluate(() => {
        window.__cyclone.setPhysicalKeyPressed(0, false);
        const st = window.__cyclone.state;
        return { freq: frequencyOf(st), badge: document.getElementById("tb-audio-badge")?.textContent };
    });
    await wait(400);
    step("B idle: 0 Hz + Silent badge", frequencyOf(await page.evaluate(() => window.__cyclone.state)) === 0
        && (await page.evaluate(() => document.getElementById("tb-audio-badge")?.textContent)) === "Silent",
        JSON.stringify(idle));

    // All four keys AND all four DIP switches -> exact tones.
    const expectations = [[0, 500], [1, 800], [2, 1000], [3, 1600]];
    for (const [index, hz] of expectations) {
        for (const kind of ["key", "dip"]) {
            const r = await page.evaluate(([ch, k]) => {
                window.__cyclone.toggleDip(ch); // noop for keys; ensures DIP state exists
                return true;
            }, [index, kind]).catch(() => false);
            void r;
            const press = await page.evaluate(([ch, k]) => {
                const t0 = performance.now();
                if (k === "key") window.__cyclone.setPhysicalKeyPressed(ch, true);
                else window.__cyclone.toggleDip(ch);
                const st = window.__cyclone.state;
                const ring = window.__cyclone.board._buzzerRing;
                return {
                    ms: Math.round((performance.now() - t0) * 100) / 100,
                    freq: st.buzzer?.frequency || 0,
                    badge: document.getElementById("tb-audio-badge")?.textContent,
                    gain: window.__cyclone.audio.state().oscGain,
                    ringOpacity: ring ? Math.round(ring.material.opacity * 1000) / 1000 : 0,
                };
            }, [index, kind]);
            await wait(700);
            const measured = await page.evaluate(() => window.__cyclone.state.buzzer?.frequency || 0);
            const ok = Math.abs(measured - hz) <= hz * 0.02 && press.gain > 0 && press.ringOpacity >= 0.85;
            step(`B ${kind.toUpperCase()}${index + 1} -> ${hz} Hz (±2%) + ring + gain`,
                ok, `press=${press.freq} settled=${measured} badge=${press.badge} ring=${press.ringOpacity} ${press.ms}ms`);
            const release = await page.evaluate(([ch, k]) => {
                if (k === "key") window.__cyclone.setPhysicalKeyPressed(ch, false);
                else window.__cyclone.toggleDip(ch);
                return true;
            }, [index, kind]);
            void release;
            await wait(350);
        }
    }
    await page.screenshot({ path: join(OUT, "matrix-01-buzzb.png") });

    // Mid-hold tone switch: press K1, release (hold), press K2 -> 800 Hz now.
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, true));
    await wait(600);
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, false));
    await wait(300);
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(1, true));
    await wait(900);
    const switched = await page.evaluate(() => window.__cyclone.state.buzzer?.frequency || 0);
    step("B mid-hold switch K1->K2 retunes to 800 Hz immediately", Math.abs(switched - 800) <= 16, `freq=${switched}`);
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(1, false));
    await wait(300);

    // Power Off silences instantly.
    await page.click('[data-act="power"]');
    await wait(400);
    const off = await page.evaluate(() => ({
        gain: window.__cyclone.audio.state().oscGain,
        badge: document.getElementById("tb-audio-badge")?.textContent,
    }));
    step("B Power Off: instant silence (gain 0, Silent)", off.gain === 0 && off.badge === "Silent", JSON.stringify(off));
    await page.click('[data-act="power"]');
    await wait(800);
}

// ---------------------------------------------------------------- step C --
// Stateful button counter: the count persists across presses (live co-sim).
const COUNTER = `
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity key_counter is
  port (clk : in std_logic; key1 : in std_logic; key2 : in std_logic;
        led : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of key_counter is
  signal cnt : unsigned(3 downto 0) := (others => '0');
  signal s1 : std_logic := '1'; signal p1 : std_logic := '1';
begin
  process (clk) begin
    if rising_edge(clk) then
      s1 <= key1; p1 <= s1;
      if key2 = '0' then cnt <= (others => '0');
      elsif p1 = '0' and s1 = '1' then cnt <= cnt + 1; end if;
    end if;
  end process;
  led <= std_logic_vector(cnt);
end architecture;
`;
{
    await page.evaluate((src) => {
        window.__cyclone.editor.setFiles([{ name: "key_counter.vhd", content: src }], false);
    }, COUNTER);
    await wait(600);
    await page.click("#tb-compile");
    await page.waitForFunction(() => window.__cyclone.state.programmed === true, { timeout: 120000 });
    await page.waitForFunction(() => !document.getElementById("tb-live-pill")?.hidden, { timeout: 90000 });
    await wait(800);
    const ledValue = () => page.evaluate(() => window.__cyclone.state.liveValues?.led ?? -1);
    // press+release K1 three times: count 1, 2, 3 — each persists.
    for (const expected of [1, 2, 3]) {
        await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, true));
        await wait(350);
        await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(0, false));
        await wait(700);
        const v = await ledValue();
        step(`C counter advances to ${expected} and persists`, v === expected, `led=${v}`);
    }
    // K2 clears.
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(1, true));
    await wait(350);
    await page.evaluate(() => window.__cyclone.setPhysicalKeyPressed(1, false));
    await wait(700);
    const cleared = await ledValue();
    step("C K2 clears the counter to 0", cleared === 0, `led=${cleared}`);
    await page.screenshot({ path: join(OUT, "matrix-02-counter.png") });
}

// ---------------------------------------------------------------- step D --
// DE0-Nano live board switch inside the installed app.
{
    await page.evaluate(() => {
        const sel = document.getElementById("tb-board-select");
        const opt = [...sel.options].find((o) => /de0-nano/i.test(o.value));
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => window.__cyclone.board.io?.leds?.length === 8, { timeout: 30000 });
    const de0 = await page.evaluate(() => ({
        leds: window.__cyclone.board.io.leds.length,
        keys: window.__cyclone.board.io.keys.length,
        pcb: "#" + window.__cyclone.board.mats.pcbTop.color.getHexString(),
    }));
    step("D DE0-Nano live switch: green PCB, 8 LEDs, 2 keys",
        de0.leds === 8 && de0.keys === 2 && de0.pcb === "#0d3b26", JSON.stringify(de0));
    await page.screenshot({ path: join(OUT, "matrix-03-de0nano.png") });
    await page.evaluate(() => {
        const sel = document.getElementById("tb-board-select");
        const opt = [...sel.options].find((o) => /rz-easyfpga/i.test(o.value));
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => window.__cyclone.board.io?.leds?.length === 4, { timeout: 30000 });
    step("D switched back to RZ-EasyFPGA (4 LEDs)", true, "leds=4");
}

step("no page errors during the matrix session", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
await browser.disconnect();

const summary = `${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — installed matrix @ ${CDP}`;
console.log(summary);
appendFileSync(LOG, summary + "\n");
process.exit(failures === 0 ? 0 : 1);
