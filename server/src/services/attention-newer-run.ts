import { and, eq, gte, isNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

/** Check one failed run's identity using the existing JSON expression indexes.
 * Projecting ids out of every newer snapshot still detoasts the full contexts.
 */
export async function hasNewerAttentionRun(
  db: Db,
  companyId: string,
  run: { agentId: string; createdAt: Date },
  issueId: string | null,
): Promise<boolean> {
  const contextIssueId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
  const contextTaskId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'taskId'`;
  // Match readRunIssueId's nullish fallback, including an empty issueId that
  // intentionally does not fall back to taskId. Do not trim identity strings.
  const sameIssue = issueId === null
    ? sql`coalesce(${contextIssueId}, ${contextTaskId}, '') = ''`
    : or(
      eq(contextIssueId, issueId),
      and(isNull(contextIssueId), eq(contextTaskId, issueId)),
    );
  const [newer] = await db.select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, run.agentId),
      // The previous Date comparison had millisecond precision. PostgreSQL
      // stores microseconds: > run.createdAt would match the failed row itself
      // when its database timestamp lies inside that same millisecond.
      gte(heartbeatRuns.createdAt, new Date(run.createdAt.getTime() + 1)),
      sameIssue,
    ))
    .limit(1);
  return Boolean(newer);
}
