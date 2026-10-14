import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

export interface AcceptedCommentInput {
  id: string;
  updatedAt: string;
}

/** Select exactly the continuation revisions rendered in this provider turn.
 * Preparation alone must never publish the returned values as receipts.
 */
export function renderedCommentInputs(
  continuation: ExecutionContinuationEnvelope | null | undefined,
  resumedSession: boolean,
): AcceptedCommentInput[] {
  const messages = resumedSession && continuation?.resumeDelta
    ? continuation.resumeDelta.messages : continuation?.messages ?? [];
  return messages.filter(message => !message.deleted).map(message => ({
    id: message.id, updatedAt: message.updatedAt,
  }));
}
