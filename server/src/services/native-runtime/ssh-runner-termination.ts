import { and, eq } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { environmentService } from "../environments.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";

export interface SshRunnerStopAuthority {
  companyId: string;
  agentId: string;
  runId: string;
  runnerInstanceId: string;
  normalizedSessionId: string;
  /** Authenticated durable protocol scope, not necessarily a database lease id. */
  environmentLeaseId: string;
  ssh: { host: string; port: number; username: string; remoteWorkspacePath: string };
}

/** Called only by the Runner transport's confirmed close callback. A lease is
 * bookkeeping on a shared SSH host, so releasing it cannot prove process exit.
 * Keep the current run and exact lease locked while recording that observation;
 * a late close from an old warm authority must not settle its successor. */
export async function recordSshRunnerTermination(db: Db, authority: SshRunnerStopAuthority) {
  return db.transaction(async tx => {
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, authority.runId), eq(heartbeatRuns.companyId, authority.companyId),
    )).for("update");
    if (!run || run.runtimeMode !== "native" || run.agentId !== authority.agentId ||
        run.runnerInstanceId !== authority.runnerInstanceId ||
        run.nativeSessionId !== authority.normalizedSessionId) return false;
    // SSH's durable environment identity can be a workspace id, or the
    // original run placeholder across projectless warm handoffs. Resolve the
    // current authenticated run's actual lease instead of treating that scope
    // as a database primary key or capturing the transport constructor's lease.
    const execution = run.runnerProfileJson?.nativeExecutionInput as
      { binding?: Record<string, unknown> } | undefined;
    const binding = execution?.binding;
    if (!binding || binding.companyId !== run.companyId || binding.agentId !== run.agentId ||
        binding.runId !== run.id || typeof binding.executionWorkspaceId !== "string" ||
        !binding.executionWorkspaceId || !authority.environmentLeaseId) return false;
    const leases = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, authority.companyId),
      eq(environmentLeases.heartbeatRunId, authority.runId),
    )).for("update");
    // Multiple rows are ambiguous authority, even if they share an SSH endpoint.
    if (leases.length !== 1) return false;
    const lease = leases[0]!;
    if (lease.provider !== "ssh" || !lease.providerLeaseId ||
        (lease.executionWorkspaceId ?? run.id) !== binding.executionWorkspaceId ||
        lease.metadata?.host !== authority.ssh.host || lease.metadata?.port !== authority.ssh.port ||
        lease.metadata?.username !== authority.ssh.username ||
        lease.metadata?.remoteWorkspacePath !== authority.ssh.remoteWorkspacePath ||
        typeof lease.metadata?.remoteCwd !== "string" ||
        lease.providerLeaseId !== `ssh://${authority.ssh.username}@${authority.ssh.host}:${authority.ssh.port}${lease.metadata.remoteCwd}` ||
        !["active", "released", "expired", "failed"].includes(lease.status) ||
        lease.cleanupStatus === "failed") return false;
    const receipt = remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" });
    if (!receipt) return false;
    await environmentService(tx as unknown as Db).releaseLease(lease.id,
      lease.status === "active" ? "released" : lease.status as "released" | "expired" | "failed", {
        cleanupStatus: "success",
        remoteExecutionTermination: { ...receipt, proof: "authenticated_runner_close",
          runnerInstanceId: authority.runnerInstanceId, normalizedSessionId: authority.normalizedSessionId,
          durableEnvironmentLeaseId: authority.environmentLeaseId },
      });
    return true;
  });
}
