import { readProcessStartedAt } from "./hot-restart.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { hasOperatorStopAttestation } from "./operator-stop-attestation.js";

type Run = typeof heartbeatRuns.$inferSelect;

/** Written by the executor after it settled preparation and lease cleanup
 * without entering the legacy adapter. Missing process identity alone is not
 * this proof; the executor must record it. */
export const LEGACY_STARTUP_SETTLED_KEY = "legacyStartupSettledAt";

export function hasLegacyStartupSettlement(run: Pick<Run, "runtimeMode" | "status" | "processPid" |
  "processGroupId" | "processStartedAt" | "resultJson">): boolean {
  return run.runtimeMode === "legacy" && run.status === "cancelled" && !run.processPid && !run.processGroupId &&
    !run.processStartedAt && typeof run.resultJson?.[LEGACY_STARTUP_SETTLED_KEY] === "string";
}

export type AgentExecutionStopBlockerReason =
  | "environment_lease_unsettled"
  | "native_owner_active"
  | "native_controller_alive"
  | "run_not_terminal"
  | "run_controller_lease_active"
  | "remote_termination_unconfirmed"
  | "local_process_alive"
  | "native_stop_unconfirmed"
  | "legacy_stop_unconfirmed";

export interface AgentExecutionStopBlocker {
  reason: AgentExecutionStopBlockerReason;
  runId: string | null;
  leaseId?: string;
}

/**
 * Cancellation changes admission. Process and lease evidence controls cleanup.
 * Read-only unless `settle` is set: only then is an expired native owner
 * released, and only after every execution has stop proof.
 */
export async function inspectAgentExecutionStop(db: Db, agentIds: string[],
  options: { settle?: boolean; limit?: number } = {}) {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const blockers: AgentExecutionStopBlocker[] = [];
  const block = (blocker: AgentExecutionStopBlocker) => { blockers.push(blocker); return blockers.length >= limit; };
  const result = () => ({ stopped: blockers.length === 0, blockers });
  if (!agentIds.length) return result();
  const runs = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ));
  for (const lease of leases) {
    if (((!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) ||
        lease.status === "pending_cleanup" || lease.cleanupStatus === "failed") &&
        block({ reason: "environment_lease_unsettled", runId: lease.heartbeatRunId, leaseId: lease.id })) return result();
  }
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = new Date();
  const abandoned = coordinators.filter(row => row.leaseOwner);
  for (const row of abandoned) {
    if ((!row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
        runs.find(run => run.id === row.runId)?.status !== "cancelled") &&
        block({ reason: "native_owner_active", runId: row.runId })) return result();
  }
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if ((!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) &&
        block({ reason: "native_controller_alive", runId: coordinator.runId })) return result();
  }
  for (const run of runs) {
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) {
      if (block({ reason: "run_not_terminal", runId: run.id })) return result();
      continue;
    }
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) {
      if (block({ reason: "run_controller_lease_active", runId: run.id })) return result();
      continue;
    }
    // Operator attestation and the legacy pre-adapter receipt replace only
    // missing provider or process evidence. Lease cleanup, live controllers and
    // a host-observed live process still keep the stop pending.
    const attested = hasOperatorStopAttestation(run);
    const settledBeforeAdapter = hasLegacyStartupSettlement(run);
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if (run.status === "cancelled" && !attested && !settledBeforeAdapter) {
        const missing = runLeases.find(lease => !hasRemoteTerminationReceipt(lease));
        if (missing && block({ reason: "remote_termination_unconfirmed", runId: run.id, leaseId: missing.id })) return result();
      }
      continue;
    }
    let processAlive = Boolean(run.processPid && !absent(run.processPid));
    let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
    if (processAlive && run.processStartedAt) {
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
        processAlive = false;
        if (run.processGroupId === run.processPid) groupAlive = false;
      }
    }
    if (processAlive || groupAlive) {
      if (block({ reason: "local_process_alive", runId: run.id })) return result();
      continue;
    }
    if (run.status !== "cancelled" || !run.startedAt || attested || settledBeforeAdapter) continue;
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) {
      if (block({ reason: "native_stop_unconfirmed", runId: run.id })) return result();
      continue;
    }
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !(run.executionStage === "settled" && !await runUsedConversationAdapter(db, run)) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) {
      if (block({ reason: "legacy_stop_unconfirmed", runId: run.id })) return result();
      continue;
    }
  }
  if (blockers.length || !options.settle) return result();
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        eq(nativeRunFinalizations.leaseExpiresAt, coordinator.leaseExpiresAt!),
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) {
      block({ reason: "native_owner_active", runId: coordinator.runId });
      return result();
    }
  }
  return result();
}

export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  return (await inspectAgentExecutionStop(db, agentIds, { settle: true, limit: 1 })).stopped;
}
