import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "queued-receipts.spec.ts", workers: 1,
  timeout: 120_000, retries: 0, expect: { timeout: 30_000 },
  use: { baseURL: `http://127.0.0.1:${process.env.PAPERCLIP_E2E_PORT ?? 32152}`, headless: true, launchOptions: process.env.PAPERCLIP_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.PAPERCLIP_TEST_BROWSER_EXECUTABLE } : {}, screenshot: "only-on-failure", trace: "retain-on-failure" },
  outputDir: "test-results/queued-receipts",
  reporter: [["list"], ["json", { outputFile: "test-results/queued-receipts.json" }]],
});
