/**
 * playwright.config.ts — Example configuration wiring the governance reporter.
 *
 * Copy this file to your project root and adjust paths/projects as needed.
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,

  reporter: [
    // Standard reporters
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    // ← Governance agent reporter (runs after every test session)
    ["./src/reporter.ts"],
  ],

  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
