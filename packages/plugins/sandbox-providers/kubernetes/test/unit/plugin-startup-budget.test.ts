import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";

const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown>, exec: vi.fn() }));
vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({ getCurrentCluster: () => ({ server: "https://cluster.example" }) })),
  makeKubeClients: vi.fn(() => h.clients),
}));
vi.mock("../../src/tenant-orchestrator.js", () => ({ ensureTenant: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/pod-exec.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/pod-exec.js")>(), execInPod: h.exec,
}));

import plugin from "../../src/plugin.js";
import manifest from "../../src/manifest.js";

const CONFIG = { inCluster: true, backend: "sandbox-cr" };
const ACQUIRE = { driverKey: "kubernetes", companyId: "acme", environmentId: "env-1",
  runId: "cold-start", config: CONFIG };
const notFound = () => Object.assign(new Error("not found"), { code: 404 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  h.exec.mockReset().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
});
afterEach(() => vi.useRealTimers());

describe("fresh Sandbox startup budget", () => {
  it("keeps job acquisition pending without waiting for the one-shot workload", async () => {
    h.clients = {
      batch: { createNamespacedJob: vi.fn().mockResolvedValue({ metadata: { uid: "owned-job" } }) },
      core: { createNamespacedSecret: vi.fn().mockResolvedValue({}),
        listNamespacedPod: vi.fn().mockResolvedValue({ items: [{ metadata: { name: "owned-job-pod" } }] }) },
    };
    await expect(plugin.definition.onEnvironmentAcquireLease!({ ...ACQUIRE,
      config: { ...CONFIG, backend: "job" } })).resolves.toMatchObject({
      metadata: { phase: "Pending", podName: "owned-job-pod", nativeFileSyncUnsupported: true },
    });
    expect(h.exec).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits through a 20s guest/init startup before a 15s cwd command receives its full budget", async () => {
    const read = vi.fn(async () => ({ metadata: { uid: "owned-uid" }, status: {
      podName: "owned-pod", conditions: [{ type: "Ready", status: Date.now() >= 20_000 ? "True" : "False" }],
    } }));
    h.clients = {
      custom: { createNamespacedCustomObject: vi.fn().mockResolvedValue({ metadata: { uid: "owned-uid" } }),
        getNamespacedCustomObject: read },
      core: { createNamespacedSecret: vi.fn().mockResolvedValue({}) },
    };
    let acquired = false;
    const pending = plugin.definition.onEnvironmentAcquireLease!(ACQUIRE).then(lease => {
      acquired = true;
      return lease;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(acquired).toBe(false);
    expect(h.exec).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    const lease = await pending;
    expect(lease.metadata).toMatchObject({ phase: "Running", podName: "owned-pod" });
    const readyReads = read.mock.calls.length;
    await expect(plugin.definition.onEnvironmentExecute!({
      ...ACQUIRE, lease, command: "/bin/sh", args: ["-c", "[ -d /workspace ]"], timeoutMs: 15_000,
    })).resolves.toMatchObject({ exitCode: 0, timedOut: false });
    expect(read).toHaveBeenCalledTimes(readyReads);
    expect(h.exec.mock.calls[0][6]).toBe(15_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(manifest.environmentDrivers?.[0].defaultAcquireTimeoutMs).toBe(300_000);
  });

  it("deletes and observes its allocation after startup timeout instead of returning a leaked lease", async () => {
    let deleted = false;
    const remove = vi.fn(async () => { deleted = true; });
    const removeSecret = vi.fn().mockResolvedValue({});
    const create = vi.fn().mockResolvedValue({ metadata: { uid: "owned-uid" } });
    h.clients = {
      custom: { createNamespacedCustomObject: create, deleteNamespacedCustomObject: remove,
        getNamespacedCustomObject: vi.fn(async () => {
          if (deleted) throw notFound();
          return { status: { conditions: [{ type: "Ready", status: "False" }] } };
        }) },
      core: { createNamespacedSecret: vi.fn().mockResolvedValue({}), deleteNamespacedSecret: removeSecret,
        readNamespacedSecret: vi.fn().mockRejectedValue(notFound()), listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }) },
    };
    const pending = plugin.definition.onEnvironmentAcquireLease!({ ...ACQUIRE,
      config: { ...CONFIG, podActivityDeadlineSec: 1 } });
    const rejected = expect(pending).rejects.toThrow(/did not reach Ready/);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    const name = create.mock.calls[0][0].body.metadata.name;
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ namespace: "paperclip-acme", name }));
    expect(removeSecret).toHaveBeenCalledWith({ namespace: "paperclip-acme", name: `${name}-env` });
    expect(h.exec).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains exact ownership for host cleanup retry when startup teardown is uncertain", async () => {
    const create = vi.fn().mockResolvedValue({ metadata: { uid: "owned-uid" } });
    h.clients = {
      custom: { createNamespacedCustomObject: create,
        getNamespacedCustomObject: vi.fn().mockResolvedValue({ status: { phase: "Failed" } }),
        deleteNamespacedCustomObject: vi.fn().mockRejectedValue(new Error("private-provider-error")) },
      core: { createNamespacedSecret: vi.fn().mockResolvedValue({}) },
    };
    const error = await plugin.definition.onEnvironmentAcquireLease!(ACQUIRE).catch(error => error);
    const name = create.mock.calls[0][0].body.metadata.name;
    expect(error.message).toBe("Kubernetes sandbox startup failed; cleanup remains unconfirmed");
    expect(readEnvironmentCreationCleanupError(error)).toMatchObject({
      providerLeaseId: name, observedProviderLeaseId: name, companyId: "acme", environmentId: "env-1", runId: "cold-start",
    });
    expect(h.exec).not.toHaveBeenCalled();
  });
});
