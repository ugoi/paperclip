import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { includeIssueHierarchyContext, loadIssueHierarchyChildren } from "./issue-hierarchy-context";

const task = (id: string, parentId: string | null = null, status = "todo") => ({ id, parentId, status, companyId: "company" } as Issue);

describe("task hierarchy context", () => {
  it("retains ancestors and descendants without promoting siblings or orphans", () => {
    const match = task("human", "agent-parent");
    const context = [task("agent-parent", "grandparent"), task("grandparent"), task("agent-child", "human"), task("grandchild", "agent-child"), task("unrelated"), task("orphan", "missing"), task("sibling", "agent-parent")];
    expect(includeIssueHierarchyContext([match], context).map((issue) => issue.id)).toEqual([
      "human", "agent-parent", "grandparent", "agent-child", "grandchild",
    ]);
    expect(includeIssueHierarchyContext([], context)).toEqual([]);
  });
  it("deduplicates matches and terminates cycles", () => {
    const match = task("human", "parent");
    expect(includeIssueHierarchyContext([match], [match, task("parent", "human")]).map((issue) => issue.id)).toEqual(["human", "parent"]);
  });

  it("keeps selected-status descendants without restoring completed tasks or hiding active grandchildren", () => {
    const match = task("human", null, "in_progress");
    const context = [task("grandchild", "completed"), task("completed", "human", "done"), task("pending", "human"), task("cancelled", "human", "cancelled")];
    expect(includeIssueHierarchyContext([match], context, ["in_progress", "todo"]).map((issue) => issue.id)).toEqual([
      "human", "pending", "grandchild",
    ]);
  });

  it("preserves matching ancestor context across excluded ancestors without admitting their other children", () => {
    const match = task("human", "completed-parent");
    const context = [task("completed-parent", "active-ancestor", "done"), task("active-ancestor", null, "in_progress"), task("sibling", "completed-parent")];
    expect(includeIssueHierarchyContext([match], context, ["in_progress", "todo"]).map((issue) => issue.id)).toEqual([
      "human", "active-ancestor",
    ]);
  });

  it("retains all hierarchy statuses when the status filter is cleared", () => {
    const match = task("human", "completed-parent");
    expect(includeIssueHierarchyContext([match], [task("completed-parent", null, "done"), task("completed-child", "human", "done")], []).map((issue) => issue.id)).toEqual([
      "human", "completed-parent", "completed-child",
    ]);
  });
});

describe("bounded hierarchy reads", () => {
  it("caps rows and requests, and shares overlapping matching subtrees", async () => {
    const root = task("root");
    const child = task("child", "root");
    const calls: string[] = [];
    const read = async (id: string, limit: number, offset: number) => {
      calls.push(id);
      const rows = id === "root" ? [child] : id === "child"
        ? Array.from({ length: 500 }, (_, index) => task(`nested-${index}`, "child")) : [];
      return rows.slice(offset, offset + limit);
    };
    const first = await loadIssueHierarchyChildren("company", [root, child], [], 5, read);
    expect(first.issues).toHaveLength(5);
    expect(first.hasMore).toBe(true);
    expect(calls).toEqual(["root", "child"]);
    calls.length = 0;
    expect((await loadIssueHierarchyChildren("company", [root, child], [], 10, read)).issues).toHaveLength(10);
    expect(calls).toEqual(["root", "child"]);
  });
  it("probes collapsed parents without fetching their tree and rejects foreign-company rows", async () => {
    const calls: Array<[string, number]> = [];
    const rows = await loadIssueHierarchyChildren("company", [task("root")], ["root"], 5,
      async (id, limit) => { calls.push([id, limit]); return [task("child", "root")]; });
    expect(rows.issues.map((issue) => issue.id)).toEqual(["child"]);
    expect(calls).toEqual([["root", 1]]);
    expect(await loadIssueHierarchyChildren("company", [task("root")], [], 1,
      async () => [{ ...task("foreign", "root"), companyId: "other" }])).toEqual({ issues: [], hasMore: true });
  });
});
