import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/reporter.ts"], // Playwright-only, needs special env
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
      },
    },
    testTimeout: 15_000,
    hookTimeout: 10_000,
  },
});
