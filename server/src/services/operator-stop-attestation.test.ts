import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { agentExecutionsHaveStopped, inspectAgentExecutionStop, LEGACY_STARTUP_SETTLED_KEY } from "./agent-execution-stop.js";
import { attestAgentExecutionsStopped, hasOperatorStopAttestation } from "./operator-stop-attestation.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("operator stop attestation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-operator-stop-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop test", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "CTO", adapterType: "claude_local",
      status: "paused", lifecycleState: "pausing", lifecycleHolds: [] });
  });

  async function cancelledRun(values: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "cancelled",
      invocationSource: "automation", runtimeMode: "legacy", startedAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(), resultJson: { conversationContinuation: "continue_conversation_v1" }, ...values }).returning();
    return run!;
  }

  async function sshLease(runId: string, values: Partial<typeof environmentLeases.$inferInsert> = {}) {
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId, provider: "ssh",
      providerLeaseId: "ssh://hermes@agent-services.example:22/home/hermes/projects", status: "expired",
      releasedAt: new Date(), cleanupStatus: null, metadata: { agentId }, ...values }).returning();
    return lease!;
  }

  it("names a cancelled SSH run without a provider receipt and accepts an operator attestation for it", async () => {
    const run = await cancelledRun({ runtimeMode: "native", resultJson: {} });
    const lease = await sshLease(run.id);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    expect(await inspectAgentExecutionStop(db, [agentId])).toEqual({ stopped: false,
      blockers: [{ reason: "remote_termination_unconfirmed", runId: run.id, leaseId: lease.id }] });

    const result = await attestAgentExecutionsStopped(db, { agentId, runIds: [run.id],
      attestedByUserId: "user-1", note: "Host rebooted after the run ended" });
    expect(result?.attested).toEqual([expect.objectContaining({ runId: run.id, leaseIds: [lease.id], attestedByUserId: "user-1" })]);
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(hasOperatorStopAttestation(stored!)).toBe(true);
    // The attestation is not a provider receipt and leaves the lease untouched.
    const [storedLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    expect(storedLease!.metadata).toEqual({ agentId });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
  });

  it("does not let an attestation replace unsettled lease cleanup or a live local process", async () => {
    const pendingRun = await cancelledRun();
    await sshLease(pendingRun.id, { status: "pending_cleanup", cleanupStatus: "failed" });
    await expect(attestAgentExecutionsStopped(db, { agentId, runIds: [pendingRun.id],
      attestedByUserId: "user-1", note: "Host is gone for good" })).rejects.toThrow(/lease cleanup has not settled/);

    const liveRun = await cancelledRun({ processPid: process.pid, processStartedAt: null });
    await db.delete(environmentLeases).where(eq(environmentLeases.heartbeatRunId, pendingRun.id));
    await attestAgentExecutionsStopped(db, { agentId, runIds: [pendingRun.id, liveRun.id],
      attestedByUserId: "user-1", note: "Operator checked the host" });
    expect(await inspectAgentExecutionStop(db, [agentId])).toEqual({ stopped: false,
      blockers: [{ reason: "local_process_alive", runId: liveRun.id }] });
  });

  it("accepts attestations only while a stop is pending and only for this agent's cancelled runs", async () => {
    const run = await cancelledRun();
    const succeeded = await cancelledRun({ status: "succeeded" });
    await expect(attestAgentExecutionsStopped(db, { agentId, runIds: [succeeded.id],
      attestedByUserId: "user-1", note: "Not needed for this run" })).rejects.toThrow(/Only cancelled runs/);
    await expect(attestAgentExecutionsStopped(db, { agentId, runIds: [randomUUID()],
      attestedByUserId: "user-1", note: "Unknown run identifier" })).rejects.toThrow(/belong to this agent/);
    await db.update(agents).set({ lifecycleState: "ready", status: "idle" }).where(eq(agents.id, agentId));
    await expect(attestAgentExecutionsStopped(db, { agentId, runIds: [run.id],
      attestedByUserId: "user-1", note: "Agent is not stopping" })).rejects.toThrow(/only while the agent is pausing/);
    // A copied attestation for another run grants nothing.
    await db.update(heartbeatRuns).set({ resultJson: { operatorStopAttestation: {
      schema: "paperclip.operator-stop-attestation.v1", companyId, agentId, runId: succeeded.id,
      attestedByUserId: "user-1", attestedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, run.id));
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(hasOperatorStopAttestation(stored!)).toBe(false);
  });

  it("treats a legacy run cancelled before adapter entry as stopped only with the executor receipt", async () => {
    const run = await cancelledRun({ executionStage: "settled" });
    expect(await inspectAgentExecutionStop(db, [agentId])).toEqual({ stopped: false,
      blockers: [{ reason: "legacy_stop_unconfirmed", runId: run.id }] });
    await db.update(heartbeatRuns).set({ resultJson: { conversationContinuation: "continue_conversation_v1",
      [LEGACY_STARTUP_SETTLED_KEY]: new Date().toISOString() } }).where(eq(heartbeatRuns.id, run.id));
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
    // Recorded process identity means the adapter started; the receipt is void.
    await db.update(heartbeatRuns).set({ processStartedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });
});
