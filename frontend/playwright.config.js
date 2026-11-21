// Playwright config — live 3D WebGL smoke gate.
// Boots the real backend (GHDL) + built frontend, drives the live
// co-simulation, and fails on console/WebGL errors or a dead render loop.
import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e",
    timeout: 120_000,
    retries: 0,
    use: {
        baseURL: "http://127.0.0.1:8137",
        viewport: { width: 1440, height: 900 },
    },
    webServer: {
        command: "python -m backend serve --host 127.0.0.1 --port 8137",
        cwd: "..",
        url: "http://127.0.0.1:8137/api/health",
        reuseExistingServer: false,
        timeout: 60_000,
    },
    projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
