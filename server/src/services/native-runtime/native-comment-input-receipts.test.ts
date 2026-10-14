import { describe, expect, it } from "vitest";
import { isNativeInputAcceptance, nativePromptCommentInputs, nativeSubmittedCommentInputs } from "./native-comment-input-receipts.js";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

describe("native input receipt contract", () => {
  it("does not infer receipts from unknown transports", () => {
    expect(isNativeInputAcceptance(undefined, {eventType:"turn.completed",turnId:"t"})).toBe(false);
  });
  it("tracks all bootstrap context and only exact compact-delta revisions", () => {
    const messages = ["wake", "between-reservation-and-start", "historical", "deleted"].map(id => ({ id, body: id, updatedAt: "2026-10-14T12:00:00Z", deleted: id === "deleted" }));
    const execution = {task:{prompt:"full rendered bootstrap"}, continuationPrompt:JSON.stringify({messages:[messages[1], {...messages[2],updatedAt:"other-revision"},messages[3]]})};
    const offered = nativePromptCommentInputs({messages} as ExecutionContinuationEnvelope, execution);
    expect(offered.bootstrap.map(input=>input.id)).toEqual(messages.slice(0,3).map(message=>message.id));
    expect(offered.continuation).toEqual([{id:messages[1].id,updatedAt:messages[1].updatedAt}]);
    const full = JSON.stringify({schema:"paperclip.native-model-envelope.v3",task:{prompt:execution.task.prompt}});
    expect(nativeSubmittedCommentInputs(execution,offered,full)).toEqual(offered.bootstrap);
    expect(nativeSubmittedCommentInputs({...execution,task:{prompt:"rebound prompt"}},offered,JSON.stringify({schema:"paperclip.native-model-envelope.v3",task:{prompt:"rebound prompt"}}))).toEqual([]);
    expect(nativeSubmittedCommentInputs(execution,offered,JSON.stringify({schema:"paperclip.native-continuation.v1",events:execution.continuationPrompt}))).toEqual(offered.continuation);
    expect(nativeSubmittedCommentInputs(execution,offered,JSON.stringify({schema:"paperclip.native-model-envelope.v3",task:{prompt:"Disposition-only recovery"}}))).toEqual([]);
    expect(nativeSubmittedCommentInputs(execution,offered,JSON.stringify({schema:"paperclip.native-continuation.v1",events:"different turn"}))).toEqual([]);
    expect(nativeSubmittedCommentInputs(execution,offered,"unstructured text")).toEqual([]);
    expect(nativePromptCommentInputs(undefined,{})).toEqual({bootstrap:[],continuation:[],bootstrapPromptSha256:null,continuationPromptSha256:null});
  });
  it.each(["codex", "acpx", "opencode", "claude_managed", "aws_agentcore"])("uses provider evidence for %s; submission/status/cancellation cannot acknowledge input", provider => {
    for (const eventType of ["turn.submitted", "turn.started", "turn.failed", "turn.cancelled", "turn.interrupted", "session.started"]) {
      expect(isNativeInputAcceptance(provider,{eventType,turnId:"t"})).toBe(false);
    }
    expect(isNativeInputAcceptance(provider,{eventType:"turn.accepted",turnId:"t"})).toBe(provider === "codex");
    expect(isNativeInputAcceptance(provider,{eventType:"item.completed",turnId:"t",payload:{kind:"agentMessage"}})).toBe(true);
    expect(isNativeInputAcceptance(provider,{eventType:"item.completed",turnId:"t",payload:{kind:"toolResult"}})).toBe(false);
    expect(isNativeInputAcceptance(provider,{eventType:"turn.completed",turnId:"t"})).toBe(true);
    expect(isNativeInputAcceptance(provider,{eventType:"turn.completed"})).toBe(false);
  });
});
