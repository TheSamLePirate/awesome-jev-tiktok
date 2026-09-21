import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end: the real server (bun) serving the production build on its own port, with an isolated runtime and
 * recordings directory (see e2e/server.ts), driven by Chromium. `bun run e2e` runs everything; the live spec talks
 * to a real TikTok stream (E2E_LIVE, default @equinoxerpfr) and is skipped with E2E_SKIP_LIVE=1.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3999);

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/.report" }]],
  outputDir: "e2e/.results",
  use: { baseURL: `http://127.0.0.1:${E2E_PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure", viewport: { width: 1680, height: 1000 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1680, height: 1000 } } }],
  webServer: {
    command: "bun e2e/server.ts",
    url: `http://127.0.0.1:${E2E_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { E2E_PORT: String(E2E_PORT) },
  },
});
