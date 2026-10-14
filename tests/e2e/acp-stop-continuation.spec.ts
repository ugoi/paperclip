import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  const body = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body);
}

for (const { unfinishedWrite, stopResponse, holdFirstFollowup } of [
  { unfinishedWrite: false, stopResponse: false, holdFirstFollowup: false },
  { unfinishedWrite: true, stopResponse: false, holdFirstFollowup: false },
  { unfinishedWrite: false, stopResponse: true, holdFirstFollowup: false },
  { unfinishedWrite: false, stopResponse: false, holdFirstFollowup: true },
]) {
  test(`embedded ACP Stop: ${holdFirstFollowup ? "receipts clear local state before the next real queue input" : unfinishedWrite ? "Interrupt continues without replaying the write" : stopResponse ? "composer Stop preserves queued input and accepts a new direction" : "Interrupt delivers queued input in the same session"}`, async ({ page, request }, testInfo) => {
    test.setTimeout(holdFirstFollowup ? 180_000 : 120_000);
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-stop-browser-"));
    const company = await json(await request.post("/api/companies", { data: { name: `ACP Stop ${Date.now()}` } }));
    const originalSettings = await json(await request.get("/api/instance/settings/experimental"));
    try {
      await json(await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: false } }));
      const owner = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
        name: "ACP Stop fixture", role: "engineer", adapterType: "claude_local",
        adapterConfig: { engine: "acp", cwd: root, stateDir: path.join(root, "state"),
          agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("scripts/mcp-fixtures/servers/acp-stop-agent.mjs"))}`,
          env: { PAPERCLIP_STOP_FIXTURE_ROOT: root, PAPERCLIP_STOP_FIXTURE_FINISH_TASK: "1", ...(unfinishedWrite ? { PAPERCLIP_STOP_FIXTURE_TOOL: "write" } : {}), ...(holdFirstFollowup ? { PAPERCLIP_STOP_FIXTURE_HOLD_FIRST_FOLLOWUP: "1" } : {}) },
        }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      } }));
      const issue = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
        title: "ACP Stop continuation", status: "backlog", assigneeAgentId: owner.id,
      } }));
      await json(await request.patch(`/api/issues/${issue.id}`, { data: { status: "todo" } }));
      await expect.poll(async () => (await readFile(path.join(root, "prompts"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length, { timeout: 45_000 }).toBe(1);
      const [active] = await json(await request.get(`/api/issues/${issue.id}/live-runs`));
      expect(active).toBeTruthy();
      await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
      const editor = page.getByRole("textbox", { name: "editable markdown" });
      await editor.fill("List my recent Drive files.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(async () => JSON.stringify(await json(await request.get(`/api/issues/${issue.id}/queued-comments`))), { timeout: 20_000 })
        .toContain("List my recent Drive files.");

      await testInfo.attach("before-interrupt", { body: JSON.stringify(await json(await request.get(`/api/issues/${issue.id}/runs`))), contentType: "application/json" });
      // Both actions stop the response; composer Stop must not create a task hold.
      let stopped;
      if (stopResponse) {
        await page.getByRole("button", { name: "Stop", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "Interrupt", exact: true }).click();
      }
      await expect.poll(async () => {
        stopped = await json(await request.get(`/api/heartbeat-runs/${active.id}`));
        return stopped.resultJson?.executionCancellation?.state;
      }, { timeout: 30_000 }).toBe("acknowledged");
      expect(stopped.status).toBe("cancelled");
      expect(stopped.resultJson.executionCancellation.state).toBe("acknowledged");
      const writesAtStop = unfinishedWrite ? await readFile(path.join(root, "writes"), "utf8") : null;
      if (stopResponse) {
        await page.reload();
        await expect(page.getByTestId("paused-composer-takeover")).toHaveCount(0);
        await expect(editor).toBeVisible();
        expect((await json(await request.get(`/api/issues/${issue.id}/tree-control/state`))).activePauseHold).toBeNull();
        await expect(page.getByRole("button", { name: "Resume task", exact: true })).toHaveCount(0);
        const saved = await json(await request.get(`/api/issues/${issue.id}/queued-comments`));
        expect(JSON.stringify(saved.entries)).toContain("List my recent Drive files.");
        expect((await readFile(path.join(root, "prompts"), "utf8")).trim().split("\n")).toHaveLength(1);
        await editor.fill("Please continue with the saved request.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
      }
      if (holdFirstFollowup) {
        await expect(page.getByText("Accepted first follow-up.", { exact: false })).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId("task-chat-queued-messages")).toHaveCount(0);
        await editor.fill("Now check the second saved request.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect.poll(async () => JSON.stringify(await json(await request.get(`/api/issues/${issue.id}/queued-comments`))), { timeout: 20_000 }).toContain("Now check the second saved request.");
        await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeEnabled();
        await testInfo.attach("received-input-removed-next-queue-operable", { body: await page.screenshot(), contentType: "image/png" });
        await page.getByRole("button", { name: "Interrupt", exact: true }).click();
      }
      await expect(page.getByText("Answered the pending follow-up once.", { exact: false })).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => (await json(await request.get(`/api/issues/${issue.id}/live-runs`))).length, { timeout: 30_000 }).toBe(0);
      const prompts = (await readFile(path.join(root, "prompts"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(prompts).toHaveLength(holdFirstFollowup ? 3 : 2);
      expect(new Set(prompts.map(prompt => prompt.sessionId)).size).toBe(1);
      // Interrupt delivers immediately; after Stop, the new direction includes saved input.
      const continuationPrompts = prompts.slice(1);
      expect(JSON.stringify(continuationPrompts)).toContain("List my recent Drive files.");
      expect(await readFile(path.join(root, "completed"), "utf8")).toBe("follow-up\n");
      const completedIssue = await json(await request.get(`/api/issues/${issue.id}`));
      expect(completedIssue.executionBlocker).toBeNull();
      expect(completedIssue.status).toBe("done");
      await expect(page.getByTestId("task-chat-queued-messages")).toHaveCount(0);
      if (unfinishedWrite) expect(await readFile(path.join(root, "writes"), "utf8")).toBe(writesAtStop);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        const tasks = await json(await request.get(`/api/companies/${company.id}/issues`));
        for (const task of tasks) {
          const runs = await json(await request.get(`/api/issues/${task.id}/runs`));
          const evidence = await Promise.all(runs.map(async (run: any) => {
            const full = await json(await request.get(`/api/heartbeat-runs/${run.runId}`));
            return { runId: run.runId, status: full.status, error: full.error, errorCode: full.errorCode, resultJson: full.resultJson };
          }));
          await testInfo.attach("fixture-runs", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
        }
      }
      await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
      await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: originalSettings.enableClassicTaskInterface } });
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("queued reservation receives a later comment exactly once after capacity is released", async ({ page, request, context }, testInfo) => {
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-stop-browser-reservation-"));
  const company = await json(await request.post("/api/companies", { data: { name: "Late reservation receipt" } }));
  const original = await json(await request.get("/api/instance/settings/experimental"));
  try {
    await json(await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: false } }));
    const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "Reserved receipt fixture", role: "engineer", adapterType: "claude_local",
      adapterConfig: { engine: "acp", cwd: root, stateDir: path.join(root, "state"),
        agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("scripts/mcp-fixtures/servers/acp-stop-agent.mjs"))}`,
        env: { PAPERCLIP_STOP_FIXTURE_ROOT: root, PAPERCLIP_STOP_FIXTURE_FINISH_TASK: "1" } },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
    } }));
    const create = (title: string) => request.post(`/api/companies/${company.id}/issues`, { data: { title, status: "todo", assigneeAgentId: agent.id } }).then(json);
    const occupying = await create("Occupy isolated capacity");
    await expect.poll(async () => (await readFile(path.join(root, "prompts"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length, { timeout: 45_000 }).toBe(1);
    const task = await create("Wait for capacity, then accept later input");
    let reserved: any;
    await expect.poll(async () => {
      reserved = (await json(await request.get(`/api/issues/${task.id}/runs`))).find((run: any) => run.status === "queued");
      return Boolean(reserved);
    }, { timeout: 20_000 }).toBe(true);
    const comment = await json(await request.post(`/api/issues/${task.id}/comments`, { data: { body: "Arrived after reservation: handle this once." } }));
    expect(new Date(comment.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(reserved.createdAt).getTime());
    await page.goto(`/${company.issuePrefix}/issues/${task.identifier}`);
    // The scheduler may coalesce this input into the already reserved run.
    // It remains visible, but is not a provider receipt before capacity frees.
    await expect(page.getByText("Arrived after reservation: handle this once.", { exact: true })).toBeVisible({ timeout: 30_000 });
    const beforeStart = await json(await request.get(`/api/issues/${task.id}/runs`));
    expect(beforeStart.some((run: any) => run.acceptedCommentInputs?.some((input: any) => input.id === comment.id))).toBe(false);
    await testInfo.attach("input-before-start", { body: await page.screenshot(), contentType: "image/png" });
    const occupyingPage = await context.newPage();
    await occupyingPage.goto(`/${company.issuePrefix}/issues/${occupying.identifier}`);
    const [occupiedRun] = await json(await request.get(`/api/issues/${occupying.id}/live-runs`));
    await occupyingPage.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(async () => (await json(await request.get(`/api/heartbeat-runs/${occupiedRun.id}`))).resultJson?.executionCancellation?.state, { timeout: 30_000 }).toBe("acknowledged");
    await occupyingPage.close();
    await expect.poll(async () => (await readFile(path.join(root, "completed"), "utf8").catch(() => "")), { timeout: 60_000 }).toBe("follow-up\n");
    await expect.poll(async () => (await json(await request.get(`/api/issues/${task.id}/queued-comments`))).entries, { timeout: 30_000 }).toEqual([]);
    let runs: any[] = [];
    await expect.poll(async () => {
      runs = await json(await request.get(`/api/issues/${task.id}/runs`));
      return runs.some((run: any) => run.acceptedCommentInputs?.some((input: any) => input.id === comment.id && input.updatedAt === comment.updatedAt));
    }, { timeout: 30_000 }).toBe(true);
    const prompts = (await readFile(path.join(root, "prompts"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain("Arrived after reservation: handle this once.");
    await expect(page.getByTestId("task-chat-queued-messages")).toHaveCount(0);
    await testInfo.attach("reservation-and-receipt", { body: JSON.stringify({ reserved, commentId: comment.id, createdAt: comment.createdAt, runs }, null, 2), contentType: "application/json" });
  } finally {
    await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
    await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: original.enableClassicTaskInterface } });
    await rm(root, { recursive: true, force: true });
  }
});
