// Live 3D WebGL smoke gate:
//  * page loads with zero console/WebGL errors,
//  * compile & run reaches the live co-simulation (pace pill visible),
//  * the 3D canvas keeps rendering while the board is active (FPS > 0),
//  * keyboard shortcut "1" (KEY1) drives a live input without errors,
//  * screenshots of both board profiles.
import { test, expect } from "@playwright/test";

test("live 3D board smoke", async ({ page }) => {
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.goto("/");
    await expect(page.locator("#board-host canvas")).toBeVisible({ timeout: 30_000 });

    // Load the counter example and compile & run it.
    const exampleSelect = page.locator("#tb-examples");
    await exampleSelect.selectOption({ index: 1 }).catch(() => {});
    await page.locator("#tb-compile").click();

    // The Pin Planner ships empty: the app must warn that no port is mapped
    // to board hardware yet (actionable toast pointing at the Pin Planner).
    await expect(page.locator(".toast-warn").filter({ hasText: "No pins assigned" }))
        .toBeVisible({ timeout: 30_000 });

    // The live pill appears once the batch capture hands over to live mode.
    await expect(page.locator("#tb-live-pill")).toBeVisible({ timeout: 60_000 });

    // Hold KEY1 (keyboard shortcut "1") — the live input must not error, and
    // the interactive board keeps rendering (FPS counter > 0; a static board
    // legitimately sleeps its loop, so check AFTER driving an input).
    await page.keyboard.down("1");
    await page.waitForTimeout(1500);
    const fps = await page.evaluate(
        () => window.__cyclone?.board?.stats?.()?.fps ?? 0,
    );
    expect(fps).toBeGreaterThan(0);
    await page.keyboard.up("1");

    // Screenshots of the active (A2.2) board.
    await page.screenshot({ path: "../docs/evidence/live-smoke-a22.png", fullPage: false });

    // Switch to the DE0-Nano profile and screenshot it too.
    const boardSelect = page.locator("#tb-board-select");
    const nanoValue = await boardSelect.evaluate(
        (sel) => (Array.from(sel.options).find((o) => /de0-nano/i.test(o.value || o.text)) || {}).value || "",
    );
    if (nanoValue) {
        await boardSelect.selectOption(nanoValue);
        await page.waitForTimeout(1500);
        await page.screenshot({ path: "../docs/evidence/live-smoke-de0nano.png", fullPage: false });
    }

    expect(consoleErrors).toEqual([]);
});
