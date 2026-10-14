import { describe, expect, it } from "vitest";
import { createPromptContextFixture } from "./test-fixtures/prompt-context.js";
import { renderedCommentInputs } from "./comment-input-receipts.js";

describe("rendered input revisions", () => {
  it("selects the actual resume delta, excluding stale historical revisions and deleted entries", () => {
    const context = createPromptContextFixture();
    const continuation = context.executionContinuation;
    continuation.messages[0].deleted = true;
    const delta = continuation.resumeDelta!.messages;
    delta[0] = { ...delta[0], updatedAt: "2026-10-14T00:00:00.000Z" };
    expect(renderedCommentInputs(continuation, true)).toEqual(delta.map(({ id, updatedAt }) => ({ id, updatedAt })));
    expect(renderedCommentInputs(undefined, false)).toEqual([]);
    expect(renderedCommentInputs(continuation, false).map(input => input.id)).not.toContain(continuation.messages[0].id);
  });
});
