import { describe, it, expect, vi } from "vitest";
import {
  checkLeaseResumable,
  destroyLeaseResources,
  waitForLeaseDeletion,
  isKubeNotFoundError,
} from "../../src/lease-lifecycle.js";

const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1alpha1";
const SANDBOX_PLURAL = "sandboxes";

function notFound(): Error {
  return Object.assign(new Error("not found"), { code: 404 });
}

function readySandboxCr(podName?: string): Record<string, unknown> {
  return {
    metadata: { uid: "uid-1" },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      ...(podName ? { podName } : {}),
    },
  };
}

describe("isKubeNotFoundError", () => {
  it("matches code=404 and statusCode=404", () => {
    expect(isKubeNotFoundError({ code: 404 })).toBe(true);
    expect(isKubeNotFoundError({ statusCode: 404 })).toBe(true);
  });

  it("does not match other errors", () => {
    expect(isKubeNotFoundError({ code: 500 })).toBe(false);
    expect(isKubeNotFoundError(new Error("boom"))).toBe(false);
  });
});

describe("checkLeaseResumable (sandbox-cr backend)", () => {
  it("resumes a live lease whose Sandbox is Ready and pod is Running", async () => {
    const clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue({
          metadata: {},
          status: { phase: "Running" },
        }),
      },
    };
    const result = await checkLeaseResumable(clients as never, {
      namespace: "paperclip-acme",
      name: "pc-abc",
      backend: "sandbox-cr",
      readyTimeoutMs: 1_000,
      pollMs: 10,
    });
    expect(result).toEqual({ resumable: true, podName: "pc-abc-pod", phase: "Running" });
    expect(clients.core.readNamespacedPod).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-pod",
    });
  });

  it("is not resumable when the Sandbox CR is gone (404)", async () => {
    const clients = {
      custom: { getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      core: { readNamespacedPod: vi.fn() },
    };
    const result = await checkLeaseResumable(clients as never, {
      namespace: "ns",
      name: "pc-abc",
      backend: "sandbox-cr",
      readyTimeoutMs: 1_000,
      pollMs: 10,
    });
    expect(result.resumable).toBe(false);
    if (!result.resumable) expect(result.reason).toMatch(/no longer exists/);
  });

  it("is not resumable when the Sandbox is terminally Failed", async () => {
    const clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: { uid: "uid-1" },
          status: {
            phase: "Failed",
            conditions: [
              { type: "Failed", status: "True", reason: "ImagePullFailed", message: "no image" },
            ],
          },
        }),
      },
      core: { readNamespacedPod: vi.fn() },
    };
    const result = await checkLeaseResumable(clients as never, {
      namespace: "ns",
      name: "pc-abc",
      backend: "sandbox-cr",
      readyTimeoutMs: 1_000,
      pollMs: 10,
    });
    expect(result.resumable).toBe(false);
    if (!result.resumable) expect(result.reason).toMatch(/failed/i);
  });

  it("is not resumable when the Sandbox never reaches Ready within the bounded wait", async () => {
    const clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: { uid: "uid-1" },
          status: { phase: "Pending" },
        }),
      },
      core: { readNamespacedPod: vi.fn() },
    };
    const result = await checkLeaseResumable(clients as never, {
      namespace: "ns",
      name: "pc-abc",
      backend: "sandbox-cr",
      readyTimeoutMs: 30,
      pollMs: 5,
    });
    expect(result.resumable).toBe(false);
    if (!result.resumable) expect(result.reason).toMatch(/did not reach Ready/);
  });

  it("is not resumable when the backing pod is gone (404)", async () => {
    const clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: { readNamespacedPod: vi.fn().mockRejectedValue(notFound()) },
    };
    const result = await checkLeaseResumable(clients as never, {
      namespace: "ns",
      name: "pc-abc",
      backend: "sandbox-cr",
      readyTimeoutMs: 1_000,
      pollMs: 10,
    });
    expect(result.resumable).toBe(false);
    if (!result.resumable) expect(result.reason).toMatch(/pc-abc-pod no longer exists/);
  });

  it("is not resumable when the pod is being torn down (deletionTimestamp set)", async () => {
    const clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue({
          metadata: { deletionTimestamp: "2026-06-10T00:00:00Z" },
          status: { phase: "Running" },
        }),
      },
    };
    const result = await checkLeaseResumable(clients as never, {
      namespace: "ns",
      name: "pc-abc",
      backend: "sandbox-cr",
      readyTimeoutMs: 1_000,
      pollMs: 10,
    });
    expect(result.resumable).toBe(false);
    if (!result.resumable) expect(result.reason).toMatch(/terminating/);
  });

  it("rethrows unexpected (non-404) pod read errors", async () => {
    const clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: {
        readNamespacedPod: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error("forbidden"), { code: 403 })),
      },
    };
    await expect(
      checkLeaseResumable(clients as never, {
        namespace: "ns",
        name: "pc-abc",
        backend: "sandbox-cr",
        readyTimeoutMs: 1_000,
        pollMs: 10,
      }),
    ).rejects.toThrow("forbidden");
  });
});

describe("checkLeaseResumable (job backend)", () => {
  it("resumes a Running Job lease", async () => {
    const clients = {
      batch: {
        readNamespacedJobStatus: vi.fn().mockResolvedValue({ status: { active: 1 } }),
      },
      core: {
        listNamespacedPod: vi.fn().mockResolvedValue({
          items: [{ metadata: { name: "pc-job-pod" }, status: { phase: "Running" } }],
        }),
      },
    };
    const result = await checkLeaseResumable(clients as never, {
      namespace: "ns",
      name: "pc-job",
      backend: "job",
    });
    expect(result).toEqual({ resumable: true, podName: "pc-job-pod", phase: "Running" });
  });

  it("is not resumable when the Job is gone (404)", async () => {
    const clients = {
      batch: { readNamespacedJobStatus: vi.fn().mockRejectedValue(notFound()) },
      core: { listNamespacedPod: vi.fn() },
    };
    const result = await checkLeaseResumable(clients as never, {
      namespace: "ns",
      name: "pc-job",
      backend: "job",
    });
    expect(result.resumable).toBe(false);
    if (!result.resumable) expect(result.reason).toMatch(/no longer exists/);
  });

  it("is not resumable when the Job already finished (terminal phase)", async () => {
    const clients = {
      batch: {
        readNamespacedJobStatus: vi.fn().mockResolvedValue({
          status: { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] },
        }),
      },
      core: { listNamespacedPod: vi.fn() },
    };
    const result = await checkLeaseResumable(clients as never, {
      namespace: "ns",
      name: "pc-job",
      backend: "job",
    });
    expect(result.resumable).toBe(false);
    if (!result.resumable) expect(result.reason).toMatch(/Succeeded/);
  });
});

describe("destroyLeaseResources", () => {
  function makeClients() {
    return {
      custom: { deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}) },
      batch: { deleteNamespacedJob: vi.fn().mockResolvedValue({}) },
      core: {
        deleteNamespacedPod: vi.fn().mockResolvedValue({}),
        deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
      },
    };
  }

  it("deletes the Sandbox CR, pod, and per-run Secret (sandbox-cr backend)", async () => {
    const clients = makeClients();
    await destroyLeaseResources(clients as never, {
      namespace: "paperclip-acme",
      name: "pc-abc",
      backend: "sandbox-cr",
      podName: "pc-abc-pod",
      secretName: "pc-abc-env",
    });
    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: "paperclip-acme",
      plural: SANDBOX_PLURAL,
      name: "pc-abc",
      propagationPolicy: "Foreground",
    });
    expect(clients.core.deleteNamespacedPod).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-pod",
    });
    expect(clients.core.deleteNamespacedSecret).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-env",
    });
    expect(clients.batch.deleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("deletes the Job instead of the Sandbox CR (job backend)", async () => {
    const clients = makeClients();
    await destroyLeaseResources(clients as never, {
      namespace: "ns",
      name: "pc-job",
      backend: "job",
      podName: null,
      secretName: "pc-job-env",
    });
    expect(clients.batch.deleteNamespacedJob).toHaveBeenCalledWith({
      namespace: "ns",
      name: "pc-job",
      propagationPolicy: "Foreground",
    });
    expect(clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
    expect(clients.core.deleteNamespacedPod).not.toHaveBeenCalled();
    expect(clients.core.deleteNamespacedSecret).toHaveBeenCalledWith({
      namespace: "ns",
      name: "pc-job-env",
    });
  });

  it("is idempotent: every 404 is treated as success", async () => {
    const clients = {
      custom: { deleteNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      batch: { deleteNamespacedJob: vi.fn() },
      core: {
        deleteNamespacedPod: vi.fn().mockRejectedValue(notFound()),
        deleteNamespacedSecret: vi.fn().mockRejectedValue(notFound()),
      },
    };
    await expect(
      destroyLeaseResources(clients as never, {
        namespace: "ns",
        name: "pc-abc",
        backend: "sandbox-cr",
        podName: "pc-abc-pod",
        secretName: "pc-abc-env",
      }),
    ).resolves.toBeUndefined();
    expect(clients.core.deleteNamespacedSecret).toHaveBeenCalled();
  });

  it("rethrows unexpected (non-404) delete errors", async () => {
    const clients = {
      custom: {
        deleteNamespacedCustomObject: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error("forbidden"), { code: 403 })),
      },
      batch: { deleteNamespacedJob: vi.fn() },
      core: { deleteNamespacedPod: vi.fn(), deleteNamespacedSecret: vi.fn() },
    };
    await expect(
      destroyLeaseResources(clients as never, {
        namespace: "ns",
        name: "pc-abc",
        backend: "sandbox-cr",
        podName: null,
        secretName: null,
      }),
    ).rejects.toThrow("forbidden");
  });
});


describe("confirmed lease deletion", () => {
  const input = { namespace: "ns", name: "pc-one", backend: "sandbox-cr" as const, podName: "pod-one", secretName: "pc-one-env" };
  function clients() {
    return { custom: { getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      core: { listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }), readNamespacedSecret: vi.fn().mockRejectedValue(notFound()) } };
  }
  it("waits for terminating owned pods after the controller is gone, ignoring another lease", async () => {
    const api = clients();
    api.core.listNamespacedPod.mockResolvedValueOnce({ items: [{ metadata: { name: "pod-one", deletionTimestamp: "now" } }] })
      .mockResolvedValue({ items: [{ metadata: { name: "pod-other", ownerReferences: [{ kind: "Sandbox", name: "pc-other" }] } }] });
    await waitForLeaseDeletion(api as never, input, { pollMs: 1 });
    expect(api.core.listNamespacedPod).toHaveBeenCalledTimes(2);
  });
  it("does not certify an orphan with an unknown pod name but a matching owner", async () => {
    const api = clients();
    api.core.listNamespacedPod.mockResolvedValue({ items: [{ metadata: { name: "unexpected-name", ownerReferences: [{ kind: "Sandbox", name: "pc-one" }] } }] });
    await expect(waitForLeaseDeletion(api as never, { ...input, podName: null }, { timeoutMs: 0 })).rejects.toThrow(/not confirmed/);
  });
  it("does not certify a controller that still exists", async () => {
    const api = clients(); api.custom.getNamespacedCustomObject.mockResolvedValue({ metadata: { deletionTimestamp: "now" } });
    await expect(waitForLeaseDeletion(api as never, input, { timeoutMs: 0 })).rejects.toThrow(/not confirmed/);
  });
  it("preserves permission and transport failures instead of treating them as absence", async () => {
    const api = clients(); api.core.listNamespacedPod.mockRejectedValue(Object.assign(new Error("denied"), { code: 403 }));
    await expect(waitForLeaseDeletion(api as never, input)).rejects.toThrow("denied");
  });
  it("waits for credential cleanup", async () => {
    const api = clients(); api.core.readNamespacedSecret.mockResolvedValue({});
    await expect(waitForLeaseDeletion(api as never, input, { timeoutMs: 0 })).rejects.toThrow(/not confirmed/);
  });
});
