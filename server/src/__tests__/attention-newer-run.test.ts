import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { hasNewerAttentionRun } from "../services/attention-newer-run.js";

describe("indexed attention supersession", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-attention-lookup-");
    db = createDb(temp.connectionString);
  }, 90_000);
  afterAll(async () => { await temp?.cleanup(); }, 30_000);
  async function seedCompany(prefix: string) {
    const companyId = randomUUID(), workerId = randomUUID(), reviewerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lookup test", issuePrefix: prefix });
    await db.insert(agents).values([workerId, reviewerId].map(id => ({id, companyId, name: id, role: "engineer", status: "idle" as const, adapterType: "codex_local"})));
    return { companyId, workerId, reviewerId };
  }
  it("bounds newer-run lookup by company, agent, time and nullish issue identity", async () => {
    const { companyId, workerId, reviewerId } = await seedCompany("ANI");
    const issueId = randomUUID();
    const failedAt = new Date("2026-07-09T12:00:00.000Z");
    const newerAt = new Date("2026-07-09T12:01:00.000Z");
    const cases = [
      { context: { issueId }, key: issueId, expected: true },
      { context: { taskId: issueId }, key: issueId, expected: true },
      { context: { issueId: null, taskId: issueId }, key: issueId, expected: true },
      { context: { issueId: "different", taskId: issueId }, key: issueId, expected: false },
      { context: { issueId: "", taskId: issueId }, key: issueId, expected: false },
      { context: { issueId: "", taskId: issueId }, key: null, expected: true },
      { context: {}, key: null, expected: true },
      { context: { taskId: issueId }, key: null, expected: false },
      { context: { issueId: " " }, key: null, expected: false },
      // The previous newer-run projection used ->>, including scalar conversion.
      { context: { issueId: 123 }, key: "123", expected: true },
    ];
    for (const testCase of cases) {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id, companyId, agentId: workerId, status: "succeeded",
        contextSnapshot: { ...testCase.context, prompt: "large context ".repeat(10_000) },
        createdAt: newerAt,
      });
      expect(await hasNewerAttentionRun(db, companyId, { agentId: workerId, createdAt: failedAt }, testCase.key))
        .toBe(testCase.expected);
      expect(await hasNewerAttentionRun(db, randomUUID(), { agentId: workerId, createdAt: failedAt }, testCase.key)).toBe(false);
      expect(await hasNewerAttentionRun(db, companyId, { agentId: reviewerId, createdAt: failedAt }, testCase.key)).toBe(false);
      expect(await hasNewerAttentionRun(db, companyId, { agentId: workerId, createdAt: newerAt }, testCase.key)).toBe(false);
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    }
    const fractionalId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: fractionalId, companyId, agentId: workerId, status: "failed",
      contextSnapshot: { issueId },
      createdAt: sql`${failedAt.toISOString()}::timestamptz + interval '500 microseconds'`,
    });
    expect(await hasNewerAttentionRun(db, companyId, { agentId: workerId, createdAt: failedAt }, issueId)).toBe(false);
    await db.update(heartbeatRuns).set({ createdAt: new Date(failedAt.getTime() + 1) }).where(eq(heartbeatRuns.id, fractionalId));
    expect(await hasNewerAttentionRun(db, companyId, { agentId: workerId, createdAt: failedAt }, issueId)).toBe(true);
  });

});
