import { and, eq, inArray, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { queuedCommentIdsFromWakePayload, withQueuedCommentIdsInWakePayload } from "./issue-queued-comment-queue.js";

export interface CommentInputRevision { id: string; updatedAt: string }

/** Only called after adapter-owned provider evidence. Never from prompt preparation. */
export async function recordAcceptedCommentInputs(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string;
  offered: CommentInputRevision[]; accepted: CommentInputRevision[];
}) {
  const offered = new Set(input.offered.map(entry => `${entry.id}:${entry.updatedAt}`));
  const accepted = input.accepted.filter(entry => offered.has(`${entry.id}:${entry.updatedAt}`));
  if (!accepted.length) return [];
  return db.transaction(async tx => {
    // The same task lock serializes queue edits, promotion and receipt pruning.
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
    )).for("update");
    if (!issue) return [];
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`,
    )).for("update");
    if (!run) return [];
    const previous = Array.isArray(run.contextSnapshot?.acceptedCommentInputs) ? run.contextSnapshot.acceptedCommentInputs : [];
    const receipts = [...previous, ...accepted].filter((entry, index, all) =>
      all.findIndex(other => other.id === entry.id && other.updatedAt === entry.updatedAt) === index);
    await tx.update(heartbeatRuns).set({
      contextSnapshot: { ...run.contextSnapshot, acceptedCommentInputs: receipts }, updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, run.id));
    const comments = await tx.select({ id: issueComments.id, updatedAt: issueComments.updatedAt })
      .from(issueComments).where(and(eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId), inArray(issueComments.id, accepted.map(entry => entry.id))));
    const consumed = new Set(comments.filter(comment => accepted.some(entry =>
      entry.id === comment.id && entry.updatedAt === comment.updatedAt.toISOString())).map(comment => comment.id));
    const pending = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    )).for("update");
    for (const wake of pending) {
      const ids = queuedCommentIdsFromWakePayload(wake.payload);
      const remaining = ids.filter(id => !consumed.has(id));
      if (remaining.length === ids.length) continue;
      await tx.update(agentWakeupRequests).set({
        payload: withQueuedCommentIdsInWakePayload(wake.payload, remaining), updatedAt: new Date(),
        ...(remaining.length === 0 ? { status: "coalesced", runId: input.runId } : {}),
      }).where(eq(agentWakeupRequests.id, wake.id));
    }
    return receipts as CommentInputRevision[];
  });
}
