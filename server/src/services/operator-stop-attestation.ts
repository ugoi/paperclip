import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { conflict, unprocessable } from "../errors.js";

export const OPERATOR_STOP_ATTESTATION_SCHEMA = "paperclip.operator-stop-attestation.v1";
const STOP_PENDING_STATES = ["pausing", "terminating", "cleaning_up"];

type Run = typeof heartbeatRuns.$inferSelect;

/**
 * An instance operator's statement that a cancelled execution has stopped,
 * used when the host can no longer produce stop proof (for example a renamed
 * or retired SSH host, or a run that predates provider receipts). It satisfies
 * only the agent lifecycle stop gate. It is never a provider receipt, so it
 * grants no native continuation, workspace reconstruction or cleanup authority.
 */
export function hasOperatorStopAttestation(run: Pick<Run, "id" | "companyId" | "agentId" | "status" | "resultJson">): boolean {
  const attestation = run.resultJson?.operatorStopAttestation as Record<string, unknown> | undefined;
  return run.status === "cancelled" && Boolean(attestation &&
    attestation.schema === OPERATOR_STOP_ATTESTATION_SCHEMA && attestation.companyId === run.companyId &&
    attestation.agentId === run.agentId && attestation.runId === run.id &&
    typeof attestation.attestedByUserId === "string" && attestation.attestedByUserId.length > 0 &&
    typeof attestation.attestedAt === "string");
}

/**
 * Records the attestation on exact cancelled runs of an agent whose stop is
 * pending. Lease bookkeeping must already be settled: an active or failed
 * cleanup is not something an operator statement can replace.
 */
export async function attestAgentExecutionsStopped(db: Db, input: {
  agentId: string; runIds: string[]; attestedByUserId: string; note: string;
}) {
  const runIds = [...new Set(input.runIds)];
  if (!runIds.length) throw unprocessable("Name at least one cancelled run to attest");
  return db.transaction(async tx => {
    const [agent] = await tx.select().from(agents).where(eq(agents.id, input.agentId)).for("update");
    if (!agent) return null;
    if (!STOP_PENDING_STATES.includes(agent.lifecycleState)) {
      throw conflict("Stop attestation is accepted only while the agent is pausing or terminating");
    }
    const runs = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, agent.companyId),
      eq(heartbeatRuns.agentId, agent.id), inArray(heartbeatRuns.id, runIds))).for("update");
    if (runs.length !== runIds.length) throw unprocessable("Every attested run must belong to this agent");
    const leases = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, agent.companyId), inArray(environmentLeases.heartbeatRunId, runIds)));
    const now = new Date();
    for (const run of runs) {
      if (run.status !== "cancelled") throw conflict("Only cancelled runs need stop attestation", { runId: run.id });
      if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > now) {
        throw conflict("A controller still owns this run", { runId: run.id });
      }
      const unsettled = leases.find(lease => lease.heartbeatRunId === run.id && (!lease.releasedAt ||
        lease.status === "active" || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"));
      if (unsettled) throw conflict("This run's environment lease cleanup has not settled", { runId: run.id, leaseId: unsettled.id });
    }
    const attested = [];
    for (const run of runs) {
      const attestation = {
        schema: OPERATOR_STOP_ATTESTATION_SCHEMA, companyId: run.companyId, agentId: run.agentId, runId: run.id,
        attestedByUserId: input.attestedByUserId, attestedAt: now.toISOString(), note: input.note,
        leaseIds: leases.filter(lease => lease.heartbeatRunId === run.id).map(lease => lease.id).sort(),
      };
      const [updated] = await tx.update(heartbeatRuns).set({
        resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
          ${JSON.stringify({ operatorStopAttestation: attestation })}::jsonb`,
        updatedAt: now,
      }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "cancelled")))
        .returning({ id: heartbeatRuns.id });
      if (!updated) throw conflict("The run changed while it was being attested", { runId: run.id });
      attested.push(attestation);
    }
    return { companyId: agent.companyId, agentId: agent.id, lifecycleState: agent.lifecycleState, attested };
  });
}
