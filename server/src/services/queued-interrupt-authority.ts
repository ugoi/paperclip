import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { authorizationService, type AuthorizationActor } from "./authorization.js";

/** A saved click is intent, not a permanent grant. Use the current DB policy. */
export async function canExecuteQueuedInterrupt(
  db: Db, companyId: string, issueId: string, intent: Record<string, unknown>,
): Promise<boolean> {
  if (typeof intent.actorId !== "string" || !intent.actorId) return false;
  const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  if (!issue || (issue.conversationAgentId && issue.conversationUserId !== intent.actorId)) return false;
  // This source is recorded only by the authenticated board route, never
  // accepted from a wake payload. Do not persist memberships/admin decisions.
  const source: AuthorizationActor["source"] = ["local_implicit", "session", "board_key", "mcp_oauth", "cloud_tenant", "cloud_control"].includes(String(intent.actorSource))
    ? intent.actorSource as AuthorizationActor["source"] : "session";
  const decision = await authorizationService(db).decide({
    actor: { type: "board", userId: intent.actorId, source }, action: "issue:comment",
    resource: { type: "issue", companyId, issueId, projectId: issue.projectId,
      parentIssueId: issue.parentId, assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId, status: issue.status },
    scope: { issueId, projectId: issue.projectId, parentIssueId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId },
  });
  return decision.allowed;
}
