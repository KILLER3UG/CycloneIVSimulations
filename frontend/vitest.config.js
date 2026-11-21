import { defineConfig } from "vitest/config";

// Unit tests cover the pure logic modules under src/ only. The Playwright
// specs in e2e/ run separately via `npx playwright test` (see
// playwright.config.js) and must not be collected by vitest.
export default defineConfig({
    test: {
        include: ["src/**/*.{test,spec}.js"],
        exclude: ["e2e/**", "legacy/**", "node_modules/**"],
        environment: "node",
    },
});
