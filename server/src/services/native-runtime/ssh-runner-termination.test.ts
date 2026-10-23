import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, heartbeatRuns,
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { agentExecutionsHaveStopped } from "../agent-execution-stop.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { environmentService } from "../environments.js";
import { recordSshRunnerTermination, type SshRunnerStopAuthority } from "./ssh-runner-termination.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`SSH stop database tests unavailable: ${support.reason}`);

suite("SSH Runner termination receipt", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("ssh-runner-stop-test-");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
  });
  afterAll(async () => { await cleanup?.(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    const runnerInstanceId = randomUUID(), normalizedSessionId = randomUUID();
    const environmentLeaseId = randomUUID();
    const providerLeaseId = "ssh://test@shared.invalid:22/shared";
    const ssh = { host: "shared.invalid", username: "test", port: 22, remoteWorkspacePath: "/shared" };
    await db.insert(companies).values({ id: companyId, name: "SSH stop fixture", issuePrefix: `T${companyId.replaceAll("-", "").slice(0, 8).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Test", role: "engineer",
      adapterType: "paperclip_runner", status: "paused" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "cancelled",
      runtimeMode: "native", runnerInstanceId, nativeSessionId: normalizedSessionId,
      startedAt: new Date(), finishedAt: new Date() });
    await db.insert(environmentLeases).values({ id: environmentLeaseId, companyId,
      heartbeatRunId: runId, provider: "ssh", providerLeaseId, status: "active",
      metadata: { retainedFixture: true, ...ssh, remoteCwd: "/shared" } });
    const authority: SshRunnerStopAuthority = { companyId, agentId, runId, runnerInstanceId,
      normalizedSessionId, environmentLeaseId, ssh };
    const read = async () => (await db.select().from(environmentLeases)
      .where(eq(environmentLeases.id, environmentLeaseId)))[0]!;
    return { authority, agentId, read };
  }

  it("keeps cancelled SSH work blocked until exact confirmed close reaches the lease", async () => {
    const { authority, agentId, read } = await seed();
    // Reproduces the old release path: terminal bookkeeping has no stop proof.
    await environmentService(db).releaseLease(authority.environmentLeaseId, "expired");
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    expect(hasRemoteTerminationReceipt(await read())).toBe(false);
    expect(await recordSshRunnerTermination(db, authority)).toBe(true);
    expect(await read()).toMatchObject({ status: "expired", cleanupStatus: "success",
      metadata: { retainedFixture: true, remoteExecutionTermination: {
        proof: "authenticated_runner_close", runId: authority.runId,
        leaseId: authority.environmentLeaseId, runnerInstanceId: authority.runnerInstanceId,
      } } });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
    // A later lease release invalidates the old stop, as before this patch.
    await environmentService(db).releaseLease(authority.environmentLeaseId);
    expect(hasRemoteTerminationReceipt(await read())).toBe(false);
  });

  it.each(["companyId", "agentId", "runId", "runnerInstanceId", "normalizedSessionId", "environmentLeaseId"] as const)(
    "rejects a stale or mismatched %s", async field => {
      const { authority, agentId, read } = await seed();
      const before = await read();
      expect(await recordSshRunnerTermination(db, { ...authority, [field]: randomUUID() })).toBe(false);
      expect(await read()).toEqual(before);
      expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    },
  );

  it("acknowledges the current warm successor without using its proof for the original run", async () => {
    const original = await seed();
    const originalBefore = await original.read();
    const successor = { ...original.authority, runId: randomUUID(),
      runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: successor.runId, companyId: successor.companyId,
      agentId: successor.agentId, status: "cancelled", runtimeMode: "native",
      runnerInstanceId: successor.runnerInstanceId, nativeSessionId: successor.normalizedSessionId,
      startedAt: new Date(), finishedAt: new Date() });
    await db.insert(environmentLeases).values({ ...originalBefore, id: successor.environmentLeaseId,
      heartbeatRunId: successor.runId });
    expect(await recordSshRunnerTermination(db, successor)).toBe(true);
    const [released] = await db.select().from(environmentLeases)
      .where(eq(environmentLeases.id, successor.environmentLeaseId));
    expect(hasRemoteTerminationReceipt(released!)).toBe(true);
    expect(await original.read()).toEqual(originalBefore);
    expect(await recordSshRunnerTermination(db, { ...successor,
      runnerInstanceId: original.authority.runnerInstanceId })).toBe(false);
  });

  it("rejects another SSH endpoint even with the same run and session identity", async () => {
    const { authority, read } = await seed();
    const before = await read();
    expect(await recordSshRunnerTermination(db, { ...authority,
      ssh: { ...authority.ssh, host: "other.invalid" } })).toBe(false);
    expect(await read()).toEqual(before);
  });

  it("does not release other work on the shared SSH endpoint or override failed cleanup", async () => {
    const first = await seed(), other = await seed();
    const otherBefore = await other.read();
    expect(first.authority.ssh).toEqual(other.authority.ssh);
    expect(await recordSshRunnerTermination(db, first.authority)).toBe(true);
    expect(await other.read()).toEqual(otherBefore);
    await db.update(environmentLeases).set({ cleanupStatus: "failed", status: "pending_cleanup" })
      .where(eq(environmentLeases.id, other.authority.environmentLeaseId));
    expect(await recordSshRunnerTermination(db, other.authority)).toBe(false);
    expect(hasRemoteTerminationReceipt(await other.read())).toBe(false);
  });
});
