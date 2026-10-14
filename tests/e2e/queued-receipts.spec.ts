import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, type APIResponse } from "@playwright/test";
import { createDb, closeRegisteredClients, agents, agentWakeupRequests, heartbeatRuns, issues, issueComments } from "../../packages/db/src/index.ts";
import { eq } from "../../server/node_modules/drizzle-orm/index.js";

const port = Number(process.env.PAPERCLIP_E2E_PORT ?? 32152);
const baseURL = `http://127.0.0.1:${port}`;
let home: string;
let server: ChildProcess;
let db: ReturnType<typeof createDb>;
let databaseUrl: string | undefined;
let testEnv: NodeJS.ProcessEnv;
async function json(response: APIResponse) {
  const body = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body);
}
async function start() {
  const log = createWriteStream(path.join(home, "server.log"), { flags: "a" });
  server = spawn(process.execPath, ["--import", path.resolve("cli/node_modules/tsx/dist/loader.mjs"), "tests/e2e/fixtures/start-queued-receipts.ts"], {
    cwd: process.cwd(), env: testEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.pipe(log, { end: false }); server.stderr!.pipe(log, { end: false });
  server.once("close", () => log.end());
  await expect.poll(async () => {
    if (server.exitCode !== null) throw new Error(`Isolated server exited ${server.exitCode}: ${await readFile(path.join(home, "server.log"), "utf8")}`);
    const ready = await readFile(path.join(home, "queued-receipts-ready.json"), "utf8").then(JSON.parse).catch(() => null);
    if (ready?.pid !== server.pid || ready?.port !== port) return false;
    return fetch(`${baseURL}/api/health`).then(response => response.ok).catch(() => false);
  }, { timeout: 240_000, intervals: [250, 500, 1000] }).toBe(true);
}
async function stop() {
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned test server did not stop")), 30_000); })]);
  } finally { clearTimeout(timer!); }
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-e2e-home-receipts-"));
  testEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PAPERCLIP_") && !["DATABASE_URL", "NODE_OPTIONS"].includes(key)));
  Object.assign(testEnv, { NODE_ENV: "test", PAPERCLIP_HOME: home, PAPERCLIP_INSTANCE_ID: "receipts", PAPERCLIP_CONFIG: path.join(home, "instances/receipts/config.json"),
    PAPERCLIP_UI_DEV_MIDDLEWARE: "false", PAPERCLIP_OPEN_ON_LISTEN: "false", PAPERCLIP_DEPLOYMENT_MODE: "local_trusted", PORT: String(port),
    PAPERCLIP_API_URL: baseURL, PAPERCLIP_AGENT_JWT_SECRET: "isolated-receipt-fixture", PAPERCLIP_DECISION_SIGNING_SECRET: "isolated-receipt-decisions-0123456789abcdef", PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "isolated-receipt-actions-0123456789abcdef",
    HEARTBEAT_SCHEDULER_INTERVAL_MS: "10000", PAPERCLIP_TELEMETRY_ENABLED: "false" });
  await start();
  const config = JSON.parse(await readFile(testEnv.PAPERCLIP_CONFIG!, "utf8"));
  const pid = await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8");
  databaseUrl = `postgres://paperclip:paperclip@127.0.0.1:${pid.split("\n")[3]}/paperclip`;
  db = createDb(databaseUrl);
});

test.afterAll(async () => { if (databaseUrl) await closeRegisteredClients(databaseUrl); if (server && server.exitCode === null) await stop(); });

test("saved intent survives browser disconnect and a real server restart; paused input is received once", async ({ page, request }, testInfo) => {
  test.setTimeout(240_000);
  const fixture = path.join(home, "provider");
  await import("node:fs/promises").then(fs => fs.mkdir(fixture));
  await writeFile(path.join(fixture, "continued"), "ready");
  const company = await json(await request.post("/api/companies", { data: { name: "Receipt integration" } }));
  await json(await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: false } }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
    name: "Receipt fixture", role: "engineer", adapterType: "claude_local",
    adapterConfig: { engine: "acp", cwd: fixture, stateDir: path.join(fixture, "state"),
      agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("scripts/mcp-fixtures/servers/acp-stop-agent.mjs"))}`,
      env: { PAPERCLIP_STOP_FIXTURE_ROOT: fixture, PAPERCLIP_STOP_FIXTURE_FINISH_TASK: "1" } },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
  } }));
  await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agent.id));
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, { data: { title: "Late context and early interrupt", status: "backlog", assigneeAgentId: agent.id } }));
  const runId = randomUUID(), initialWake = randomUUID(), queueId = randomUUID(), commentId = randomUUID();
  const reservedAt = new Date(Date.now() - 1000), receivedAt = new Date();
  await db.insert(agentWakeupRequests).values({ id: initialWake, companyId: company.id, agentId: agent.id, source: "assignment", reason: "issue_assigned", status: "queued", requestedByActorType: "user", requestedByActorId: "local-board", payload: { issueId: issue.id } });
  await db.insert(heartbeatRuns).values({ id: runId, companyId: company.id, agentId: agent.id, status: "queued", runtimeMode: "legacy", wakeupRequestId: initialWake, createdAt: reservedAt, responsibleUserId: "local-board", contextSnapshot: { issueId: issue.id, wakeReason: "issue_assigned" } });
  await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, initialWake));
  await db.update(issues).set({ status: "in_progress", executionRunId: runId }).where(eq(issues.id, issue.id));
  await db.insert(issueComments).values({ id: commentId, companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: "local-board", body: "This arrived after reservation. Deliver exactly once.", createdAt: receivedAt, updatedAt: receivedAt });
  await db.insert(agentWakeupRequests).values({ id: queueId, companyId: company.id, agentId: agent.id, source: "on_demand", reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "local-board", payload: { issueId: issue.id, commentId, _paperclipWakeContext: { issueId: issue.id, wakeCommentId: commentId, wakeCommentIds: [commentId] } } });
  await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
  const interrupt = page.getByTestId(`task-chat-queued-interrupt-${commentId}`);
  await expect(interrupt).toBeEnabled();
  const beforeClick = await json(await request.get(`/api/issues/${issue.id}/queued-comments`));
  await interrupt.click();
  await expect.poll(async () => (await json(await request.get(`/api/issues/${issue.id}/queued-comments`))).interruptRequestedAt, { timeout: 20_000 }).toBeTruthy();
  const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
  // Admission may already cancel the preparing run because the agent is paused.
  // The click is bound to the actual queue target, including its stopped/null state.
  expect(saved.payload?.queuedCommentInterrupt.targetRunId).toBe(beforeClick.targetRunId);
  expect((await readFile(path.join(fixture, "completed"), "utf8").catch(() => ""))).toBe(""); // pause remains a real gate
  await page.reload();
  await expect(interrupt).toHaveText("Interrupt requested");
  await expect(interrupt).toBeDisabled();
  await testInfo.attach("persisted-early-intent", { body: await page.screenshot(), contentType: "image/png" });
  await page.goto("about:blank");
  const oldPid = server.pid;
  await stop();
  await start();
  expect(server.pid).not.toBe(oldPid);
  const persisted = await json(await request.get(`/api/issues/${issue.id}/queued-comments`));
  expect(persisted.interruptRequestedAt).toBe(saved.payload?.queuedCommentInterrupt.requestedAt);
  await json(await request.post(`/api/agents/${agent.id}/resume`));
  await expect.poll(async () => (await readFile(path.join(fixture, "completed"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean), { timeout: 90_000 }).toEqual(["follow-up"]);
  await expect.poll(async () => (await json(await request.get(`/api/issues/${issue.id}/queued-comments`))).entries, { timeout: 30_000 }).toEqual([]);
  const runs = await json(await request.get(`/api/issues/${issue.id}/runs`));
  expect(runs.some((run: any) => run.acceptedCommentInputs?.some((input: any) => input.id === commentId && input.updatedAt === receivedAt.toISOString()))).toBe(true);
  await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
  await expect(page.getByRole("button", { name: /^Interrupt/ })).toHaveCount(0);
  await testInfo.attach("restart-evidence", { body: JSON.stringify({ oldPid, newPid: server.pid, queueId, runId, commentId, receipt: runs.flatMap((run: any) => run.acceptedCommentInputs ?? []) }, null, 2), contentType: "application/json" });
});
