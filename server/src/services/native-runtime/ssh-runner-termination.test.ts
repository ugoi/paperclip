import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns,
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { agentExecutionsHaveStopped } from "../agent-execution-stop.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { environmentService } from "../environments.js";
import { environmentRuntimeService } from "../environment-runtime.js";
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
    const leaseId = randomUUID(), environmentLeaseId = randomUUID(), environmentId = randomUUID();
    const providerLeaseId = "ssh://test@shared.invalid:22/shared";
    const ssh = { host: "shared.invalid", username: "test", port: 22, remoteWorkspacePath: "/shared" };
    await db.insert(companies).values({ id: companyId, name: "SSH stop fixture", issuePrefix: `T${companyId.replaceAll("-", "").slice(0, 8).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Test", role: "engineer",
      adapterType: "paperclip_runner", status: "paused" });
    await db.insert(executionWorkspaces).values({ id: environmentLeaseId, companyId,
      mode: "shared", strategyType: "shared", name: "SSH workspace", cwd: "/shared" });
    const binding = { companyId, agentId, runId, executionWorkspaceId: environmentLeaseId };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "cancelled",
      runtimeMode: "native", runnerInstanceId, nativeSessionId: normalizedSessionId,
      runnerProfileJson: { nativeExecutionInput: { binding } },
      startedAt: new Date(), finishedAt: new Date() });
    await db.insert(environments).values({ id: environmentId, name: `SSH test ${environmentId}`, driver: "ssh", config: ssh });
    await db.insert(environmentLeases).values({ id: leaseId, environmentId, companyId, executionWorkspaceId: environmentLeaseId,
      heartbeatRunId: runId, provider: "ssh", providerLeaseId, status: "active",
      metadata: { retainedFixture: true, ...ssh, remoteCwd: "/shared" } });
    const authority: SshRunnerStopAuthority = { companyId, agentId, runId, runnerInstanceId,
      normalizedSessionId, environmentLeaseId, ssh };
    const read = async () => (await db.select().from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId)))[0]!;
    return { authority, leaseId, agentId, read, environment: (await environmentService(db).getById(environmentId))! };
  }

  it("keeps cancelled SSH work blocked until exact confirmed close reaches the lease", async () => {
    const { authority, leaseId, agentId, read } = await seed();
    // Reproduces the old release path: terminal bookkeeping has no stop proof.
    await environmentService(db).releaseLease(leaseId, "expired");
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    expect(hasRemoteTerminationReceipt(await read())).toBe(false);
    expect(await recordSshRunnerTermination(db, authority)).toBe(true);
    expect(await read()).toMatchObject({ status: "expired", cleanupStatus: "success",
      metadata: { retainedFixture: true, remoteExecutionTermination: {
        proof: "authenticated_runner_close", runId: authority.runId,
        leaseId, durableEnvironmentLeaseId: authority.environmentLeaseId, runnerInstanceId: authority.runnerInstanceId,
      } } });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
    // A later lease release invalidates the old stop, as before this patch.
    await environmentService(db).releaseLease(leaseId);
    expect(hasRemoteTerminationReceipt(await read())).toBe(false);
  });

  it("preserves confirmed close through ordinary and stale-snapshot SSH finalization", async () => {
    const { authority, leaseId, agentId, read, environment } = await seed();
    const runtime = environmentRuntimeService(db);
    // releaseRunLeases selected this active row before close completed.
    const selectedBeforeClose = (await environmentService(db).getLeaseById(leaseId))!;
    expect(await recordSshRunnerTermination(db, authority)).toBe(true);
    const confirmed = await read();
    // The normal later heartbeat-finally path sees no active lease.
    expect(await runtime.releaseRunLeases(authority.runId, "expired")).toEqual([]);
    expect(await read()).toEqual(confirmed);
    // An already in-flight finalizer reaches the real SSH driver after close.
    await runtime.getDriver("ssh")!.releaseRunLease({ environment,
      lease: selectedBeforeClose, status: "expired" });
    expect(await read()).toEqual(confirmed);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
  });

  it("does not preserve a stale receipt after lease reactivation or release a different owner", async () => {
    const { authority, leaseId, read, environment } = await seed();
    const driver = environmentRuntimeService(db).getDriver("ssh")!;
    const selected = (await environmentService(db).getLeaseById(leaseId))!;
    const before = await read();
    expect(await driver.releaseRunLease({ environment,
      lease: { ...selected, heartbeatRunId: randomUUID() }, status: "expired" })).toBeNull();
    expect(await read()).toEqual(before);
    expect(await recordSshRunnerTermination(db, authority)).toBe(true);
    // Even if an old metadata receipt remains, active ownership invalidates it.
    await db.update(environmentLeases).set({ status: "active", releasedAt: null, cleanupStatus: null })
      .where(eq(environmentLeases.id, leaseId));
    await driver.releaseRunLease({ environment, lease: selected, status: "expired" });
    expect(hasRemoteTerminationReceipt(await read())).toBe(false);
    expect((await read()).metadata?.remoteExecutionTermination).toBeUndefined();
  });

  it.each(["companyId", "agentId", "runId", "runnerInstanceId", "normalizedSessionId"] as const)(
    "rejects a stale or mismatched %s", async field => {
      const { authority, leaseId, agentId, read } = await seed();
      const before = await read();
      expect(await recordSshRunnerTermination(db, { ...authority, [field]: randomUUID() })).toBe(false);
      expect(await read()).toEqual(before);
      expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    },
  );

  it("acknowledges the current warm successor without using its proof for the original run", async () => {
    const original = await seed();
    const originalBefore = await original.read();
    const successor = { ...original.authority, runId: randomUUID() };
    const successorLeaseId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: successor.runId, companyId: successor.companyId,
      agentId: successor.agentId, status: "cancelled", runtimeMode: "native",
      runnerInstanceId: successor.runnerInstanceId, nativeSessionId: successor.normalizedSessionId,
      runnerProfileJson: { nativeExecutionInput: { binding: { companyId: successor.companyId,
        agentId: successor.agentId, runId: successor.runId, executionWorkspaceId: successor.environmentLeaseId } } },
      startedAt: new Date(), finishedAt: new Date() });
    await db.insert(environmentLeases).values({ ...originalBefore, id: successorLeaseId,
      heartbeatRunId: successor.runId });
    expect(await recordSshRunnerTermination(db, successor)).toBe(true);
    const [released] = await db.select().from(environmentLeases)
      .where(eq(environmentLeases.id, successorLeaseId));
    expect(hasRemoteTerminationReceipt(released!)).toBe(true);
    expect(await original.read()).toEqual(originalBefore);
    expect(await recordSshRunnerTermination(db, { ...successor,
      runnerInstanceId: randomUUID() })).toBe(false);
  });


  it("rejects mismatched frozen workspace ownership and ambiguous current-run leases", async () => {
    const fixture = await seed();
    const before = await fixture.read();
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: { binding: {
      companyId: fixture.authority.companyId, agentId: fixture.authority.agentId,
      runId: fixture.authority.runId, executionWorkspaceId: randomUUID(),
    } } } }).where(eq(heartbeatRuns.id, fixture.authority.runId));
    expect(await recordSshRunnerTermination(db, fixture.authority)).toBe(false);
    expect(await fixture.read()).toEqual(before);
    const ambiguous = await seed();
    const first = await ambiguous.read();
    await db.insert(environmentLeases).values({ ...first, id: randomUUID() });
    expect(await recordSshRunnerTermination(db, ambiguous.authority)).toBe(false);
    expect(await ambiguous.read()).toEqual(first);
  });


  it("retains projectless warm protocol scope while resolving the successor's own lease", async () => {
    const original = await seed();
    original.authority.environmentLeaseId = original.authority.runId;
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: { binding: {
      companyId: original.authority.companyId, agentId: original.authority.agentId,
      runId: original.authority.runId, executionWorkspaceId: original.authority.runId,
    } } } }).where(eq(heartbeatRuns.id, original.authority.runId));
    await db.update(environmentLeases).set({ executionWorkspaceId: null })
      .where(eq(environmentLeases.id, original.leaseId));
    const before = await original.read();
    const runId = randomUUID(), leaseId = randomUUID();
    // The retained protocol placeholder belongs to the original run. The
    // successor's frozen workspace placeholder is its own id, with no DB row.
    const authority = { ...original.authority, runId, environmentLeaseId: original.authority.runId };
    await db.insert(heartbeatRuns).values({ id: runId, companyId: authority.companyId,
      agentId: authority.agentId, status: "cancelled", runtimeMode: "native",
      runnerInstanceId: authority.runnerInstanceId, nativeSessionId: authority.normalizedSessionId,
      runnerProfileJson: { nativeExecutionInput: { binding: {
        companyId: authority.companyId, agentId: authority.agentId, runId, executionWorkspaceId: runId,
      } } }, startedAt: new Date(), finishedAt: new Date() });
    await db.insert(environmentLeases).values({ ...before, id: leaseId,
      heartbeatRunId: runId, executionWorkspaceId: null });
    expect(await recordSshRunnerTermination(db, authority)).toBe(true);
    const [current] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    expect(current?.metadata?.remoteExecutionTermination).toMatchObject({ runId, leaseId,
      durableEnvironmentLeaseId: original.authority.runId });
    expect(await original.read()).toEqual(before);
  });

  it("rejects missing or foreign frozen execution binding", async () => {
    const fixture = await seed(), before = await fixture.read();
    for (const binding of [undefined, { companyId: randomUUID(), agentId: fixture.authority.agentId,
      runId: fixture.authority.runId, executionWorkspaceId: fixture.authority.environmentLeaseId }]) {
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: { binding } } })
        .where(eq(heartbeatRuns.id, fixture.authority.runId));
      expect(await recordSshRunnerTermination(db, fixture.authority)).toBe(false);
      expect(await fixture.read()).toEqual(before);
    }
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
      .where(eq(environmentLeases.id, other.leaseId));
    expect(await recordSshRunnerTermination(db, other.authority)).toBe(false);
    expect(hasRemoteTerminationReceipt(await other.read())).toBe(false);
  });
});
