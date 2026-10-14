import { createHash } from "node:crypto";
import { and, desc, eq, lte } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { recordAcceptedCommentInputs, type CommentInputRevision } from "../comment-input-receipts.js";

type NativeReceiptEvent = {
  eventType: string; turnId?: string | null; payload?: unknown;
  sourceInstanceId?: string; sourceSeq?: number;
};
type NativeOfferedInputs = { bootstrap: CommentInputRevision[]; continuation: CommentInputRevision[]; bootstrapPromptSha256: string | null; continuationPromptSha256: string | null };
const promptDigest = (value: unknown) => typeof value === "string" ? createHash("sha256").update(value).digest("hex") : null;
type ReceiptExecution = { provider?: { kind?: unknown }; task?: { prompt?: string }; continuationPrompt?: string | null };

/** The ordinary native bootstrap renders the full continuation envelope. A
 * retained provider session can receive only the constructed compact delta.
 * Neither snapshot is a receipt until its exact prompt has provider evidence.
 */
export function nativePromptCommentInputs(
  continuation: ExecutionContinuationEnvelope | null | undefined,
  execution: ReceiptExecution,
): NativeOfferedInputs {
  const bootstrap = (continuation?.messages ?? []).filter(message => !message.deleted)
    .map(({ id, updatedAt }) => ({ id, updatedAt }));
  let compact: { messages?: Array<{ id: string; updatedAt: string; deleted?: boolean }> } = {};
  try { compact = JSON.parse(execution.continuationPrompt ?? "{}"); } catch { /* unknown format stays unknown */ }
  return { bootstrap, bootstrapPromptSha256: promptDigest(execution.task?.prompt), continuationPromptSha256: promptDigest(execution.continuationPrompt), continuation: (Array.isArray(compact.messages) ? compact.messages : [])
    .filter(message => !message.deleted && bootstrap.some(input => input.id === message.id && input.updatedAt === message.updatedAt))
    .map(({ id, updatedAt }) => ({ id, updatedAt })) };
}

export function isNativeInputAcceptance(provider: unknown, event: NativeReceiptEvent) {
  if (!event.turnId || !["codex", "acpx", "opencode", "claude_managed", "aws_agentcore"].includes(String(provider))) return false;
  // Codex emits accepted only after validating turn/start's provider reply.
  // ACPX/OpenCode emit it before sending: that is NOT a receipt.
  if (event.eventType === "turn.accepted") return provider === "codex";
  const payload = event.payload as { kind?: string } | null;
  return event.eventType === "turn.completed" ||
    (event.eventType === "item.completed" && payload?.kind === "agentMessage");
}

export function nativeSubmittedCommentInputs(execution: ReceiptExecution, offered: NativeOfferedInputs, text: unknown) {
  if (typeof text !== "string") return [];
  let envelope: { schema?: string; task?: { prompt?: string }; events?: string };
  try { envelope = JSON.parse(text); } catch { return []; }
  if (envelope.schema === "paperclip.native-continuation.v1" &&
      execution.continuationPrompt && offered.continuationPromptSha256 === promptDigest(execution.continuationPrompt) && envelope.events === execution.continuationPrompt) return offered.continuation;
  if (["paperclip.native-model-envelope.v1", "paperclip.native-model-envelope.v2", "paperclip.native-model-envelope.v3"].includes(envelope.schema ?? "") &&
      execution.task?.prompt && offered.bootstrapPromptSha256 === promptDigest(execution.task.prompt) && typeof envelope.task?.prompt === "string" &&
      (envelope.task.prompt === execution.task.prompt || envelope.task.prompt.endsWith(`\n\n${execution.task.prompt}`))) return offered.bootstrap;
  // Disposition-only recovery and steering prompts do not resend these inputs.
  return [];
}

/** Committed and duplicate PRP callbacks share this idempotent projection.
 * Pair provider evidence with its durable submitted text, never just run ID.
 */
export async function recordNativeAcceptedCommentInputs(db: Db, binding: {
  companyId: string; issueId: string; agentId: string; runId: string;
}, event: NativeReceiptEvent) {
  if (!["turn.accepted", "turn.completed", "item.completed"].includes(event.eventType) || !event.turnId ||
      !event.sourceInstanceId || !Number.isSafeInteger(event.sourceSeq)) return [];
  const [run] = await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, binding.agentId),
  ));
  const execution = run?.profile?.nativeExecutionInput as ReceiptExecution | undefined;
  if (!execution || !isNativeInputAcceptance(execution.provider?.kind, event)) return [];
  const offered = run?.profile?.nativeCommentInputs as NativeOfferedInputs | undefined;
  const validInputs = (value: unknown): value is CommentInputRevision[] => Array.isArray(value) && value.every(input =>
    input && typeof input.id === "string" && typeof input.updatedAt === "string");
  if (!offered || !validInputs(offered.bootstrap) || !validInputs(offered.continuation)) return [];
  const scope = and(eq(heartbeatRunEvents.companyId, binding.companyId), eq(heartbeatRunEvents.runId, binding.runId),
    eq(heartbeatRunEvents.agentId, binding.agentId), eq(heartbeatRunEvents.sourceInstanceId, event.sourceInstanceId),
    lte(heartbeatRunEvents.sourceSeq, event.sourceSeq!));
  const [submitted] = await db.select().from(heartbeatRunEvents).where(and(scope, eq(heartbeatRunEvents.eventType, "turn.submitted")))
    .orderBy(desc(heartbeatRunEvents.sourceSeq)).limit(1);
  const [accepted] = await db.select().from(heartbeatRunEvents).where(and(scope, eq(heartbeatRunEvents.eventType, "turn.accepted")))
    .orderBy(desc(heartbeatRunEvents.sourceSeq)).limit(1);
  const submission = submitted?.payload?.prpEvent as NativeReceiptEvent | undefined;
  const acceptance = accepted?.payload?.prpEvent as NativeReceiptEvent | undefined;
  if (submitted?.sourceSeq == null || accepted?.sourceSeq == null || submitted.sourceSeq >= accepted.sourceSeq ||
      acceptance?.turnId !== event.turnId || (submission?.turnId && submission.turnId !== event.turnId)) return [];
  const inputs = nativeSubmittedCommentInputs(execution, offered, (submission?.payload as { text?: unknown } | undefined)?.text);
  return recordAcceptedCommentInputs(db, { ...binding, offered: inputs, accepted: inputs });
}
