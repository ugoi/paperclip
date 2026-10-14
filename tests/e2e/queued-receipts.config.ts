import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("PAPERCLIP_") && !["DATABASE_URL", "NODE_OPTIONS"].includes(key),
));
const baseServer = base.webServer as { env: Record<string, string> };
const fixtureEnv = Object.fromEntries([
  "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_CONFIG", "PAPERCLIP_API_URL", "PORT",
].map(key => [key, baseServer.env[key]]));

// Same throwaway-home guarantees as the ordinary browser suite. The caller
// builds server/ui-dist once before running this targeted integration shard.
export default defineConfig({
  ...base,
  use: { ...base.use, launchOptions: process.env.PAPERCLIP_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.PAPERCLIP_TEST_BROWSER_EXECUTABLE } : {} },
  outputDir: "test-results/normal-receipts",
  reporter: [["list"], ["json", { outputFile: "test-results/normal-receipts.json" }]],
  testMatch: "acp-stop-continuation.spec.ts",
  webServer: {
    ...base.webServer as object,
    command: "node cli/node_modules/tsx/dist/cli.mjs tests/e2e/fixtures/start-queued-receipts.ts",
    timeout: 240_000,
    env: {
      ...inherited, ...fixtureEnv, NODE_ENV: "test",
      PAPERCLIP_UI_DEV_MIDDLEWARE: "false", PAPERCLIP_OPEN_ON_LISTEN: "false",
      PAPERCLIP_DEPLOYMENT_MODE: "local_trusted", PAPERCLIP_BIND: "loopback",
      PAPERCLIP_AGENT_JWT_SECRET: "isolated-queued-receipts-agent-key",
      PAPERCLIP_DECISION_SIGNING_SECRET: "isolated-queued-receipts-decision-key",
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "isolated-queued-receipts-action-key",
      PAPERCLIP_TELEMETRY_ENABLED: "false",
    },
  },
});
