import fs from "node:fs/promises";
import path from "node:path";
import { onboard } from "../../../cli/src/commands/onboard.js";

// Never inherit a real run's identity into the disposable control plane.
const home = process.env.PAPERCLIP_HOME;
if (!home || !path.basename(home).startsWith("paperclip-e2e-home-")) {
  throw new Error("Queued receipt integration requires a throwaway PAPERCLIP_HOME");
}
for (const key of ["PAPERCLIP_TASK_ID", "PAPERCLIP_RUN_ID", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_AGENT_ID", "PAPERCLIP_API_KEY", "PAPERCLIP_AGENT_PRIVATE_KEY", "PAPERCLIP_AGENT_PUBLIC_KEY", "PAPERCLIP_AGENT_KEY_ID"]) delete process.env[key];
await onboard({ yes: true, invokedByRun: true, installService: false });
await fs.writeFile(path.join(home, "queued-receipts-server.pid"), String(process.pid));
// Source checkout start: the user's optional global CLI shim is not this
// throwaway home's managed install. No global install/doctor repair is needed.
const { startServer } = await import("../../../server/src/index.js");
const started = await startServer();
if (started.listenPort !== Number(process.env.PORT)) {
  await started.shutdown();
  throw new Error("Disposable test port was occupied; refusing a different listener");
}
await fs.writeFile(path.join(home, "queued-receipts-ready.json"), JSON.stringify({ pid: process.pid, port: started.listenPort }));
