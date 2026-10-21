import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRemoteRunnerProcessLauncher, REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT } from "./native-session-executor.js";
import { REMOTE_RUNNER_PROCESS_PROBE_PREREQUISITE_SCRIPT } from "./remote-runner-process-probe.js";

describe("remote launch prerequisite boundary", () => {
  it.skipIf(process.platform !== "linux")("does not execute a worker if its launch environment cannot capture process identity", () => {
    const root = mkdtempSync(join(tmpdir(), "paperclip-launch-environment-"));
    try {
      const bin = join(root, "bin"); mkdirSync(bin);
      for (const command of ["sh", "date", "mkdir", "chmod", "mv", "uname"]) {
        const path = execFileSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).trim();
        symlinkSync(path, join(bin, command));
      }
      // The controller's ordinary probe environment is usable, but a distinct
      // child environment loses Node. Success above must not authorize this exec.
      execFileSync("sh", ["-c", REMOTE_RUNNER_PROCESS_PROBE_PREREQUISITE_SCRIPT]);
      const marker = join(root, "identity"); const canary = join(root, "worker-started");
      const fixture = join(root, "worker.cjs");
      writeFileSync(fixture, `require("node:fs").writeFileSync(${JSON.stringify(canary)}, "started");`);
      const result = spawnSync("/bin/sh", ["-c", REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT, "launch", marker, "nonce", "owned", join(root, "diagnostics"), process.execPath, fixture, "--runner-id", "owned"], {
        env: { PATH: bin, HOME: root }, encoding: "utf8", timeout: 5_000,
      });
      expect(result.status).not.toBe(0);
      expect(result.status).not.toBeNull();
      expect(existsSync(canary)).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("remote launch readiness", () => {
  const ok = { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
  const launchInput = {
    target: { kind: "remote" as const, transport: "sandbox" as const, environmentId: "environment", leaseId: "lease", remoteCwd: "/workspace" },
    remoteBinary: "/runtime/runnerd", processIdentityPath: "/state/identity", stateDirectory: "/state", diagnosticsDirectory: "/state/diagnostics", runnerInstanceId: "owned-runner",
    requireProcessStartFingerprint: true,
  };
  const spec = { command: "/controller/runnerd", args: [], cwd: "/workspace", environment: { HOME: "/worker-home" } };

  it.each(["staging", "prerequisite"] as const)("cancels during %s without dispatching a late worker or releasing preparation early", async phase => {
    const entered = deferred(); const release = deferred();
    const execute = vi.fn(async () => {
      entered.resolve(); await release.promise; return ok;
    });
    const handle = createRemoteRunnerProcessLauncher({ ...launchInput, runner: { execute } as never,
      ensureArtifact: async () => { if (phase === "staging") { entered.resolve(); await release.promise; } },
    })(spec);
    let drained = false;
    void handle.completion.then(() => { drained = true; }, () => { drained = true; });
    await entered.promise;
    handle.cancelPendingLaunch!();
    await expect(handle.launchReady).rejects.toThrow("runner_process_launch_cancelled");
    expect(drained).toBe(false);
    expect(handle.isExitConfirmed?.()).toBe(false);
    release.resolve();
    await expect(handle.completion).resolves.toMatchObject({ code: 0, stderr: "runner_process_launch_cancelled" });
    expect(handle.isExitConfirmed?.()).toBe(true);
    expect(execute).toHaveBeenCalledTimes(phase === "staging" ? 0 : 1);
    expect(handle.child.pid).toBeUndefined();
  });

  it("rejects readiness with the original staging failure and never dispatches", async () => {
    const execute = vi.fn(); const error = new Error("specific upload failure");
    const handle = createRemoteRunnerProcessLauncher({ ...launchInput, runner: { execute } as never,
      ensureArtifact: async () => { throw error; },
    })(spec);
    await expect(handle.launchReady).rejects.toBe(error);
    await expect(handle.completion).rejects.toBe(error);
    expect(execute).not.toHaveBeenCalled();
    expect(handle.isExitConfirmed?.()).toBe(true);
  });

  it.each([false, true])("publishes exact identity after both probes and retains cleanup ownership when dispatch crosses cancellation (cancel=%s)", async cancel => {
    const dispatched = deferred(); const releaseDispatch = deferred(); const monitorEntered = deferred(); const releaseMonitor = deferred();
    let nonce = "";
    const execute = vi.fn(async (request: { args?: string[]; env?: Record<string, string> }) => {
      const label = request.args?.[2];
      if (label === "paperclip-runner-launch") {
        nonce = request.args![4]!; dispatched.resolve(); await releaseDispatch.promise; return ok;
      }
      if (label === "paperclip-runner-process-identity") return { ...ok, stdout: `${nonce}\n43210\n2026-10-21T14:54:54Z\nowned-runner\nlinux:abcd-1234:42\n` };
      if (label === "paperclip-runner-monitor") { monitorEntered.resolve(); await releaseMonitor.promise; return { ...ok, exitCode: 45 }; }
      return ok;
    });
    const onSpawn = vi.fn(async () => undefined);
    const handle = createRemoteRunnerProcessLauncher({ ...launchInput, runner: { execute } as never, onSpawn })(spec);
    let ready = false; let drained = false;
    void handle.launchReady!.then(() => { ready = true; }, () => undefined);
    void handle.completion.then(() => { drained = true; }, () => { drained = true; });
    await dispatched.promise;
    expect(ready).toBe(false);
    expect(execute.mock.calls.slice(0, 2).map(([request]) => request.env)).toEqual([undefined, { HOME: "/worker-home" }]);
    if (cancel) { handle.cancelPendingLaunch!(); await expect(handle.launchReady).rejects.toThrow("runner_process_launch_cancelled"); }
    releaseDispatch.resolve();
    await monitorEntered.promise;
    if (!cancel) await handle.launchReady;
    expect(onSpawn).toHaveBeenCalledExactlyOnceWith({ pid: 43210, processGroupId: null, startedAt: "2026-10-21T14:54:54Z" });
    expect(drained).toBe(false);
    expect(handle.isExitConfirmed?.()).toBe(false);
    const signals = execute.mock.calls.filter(([request]) => request.args?.[2] === "paperclip-runner-signal");
    expect(signals).toHaveLength(cancel ? 1 : 0);
    if (cancel) expect(signals[0]![0].args!.slice(3)).toEqual(["/state/identity", nonce, "owned-runner", "43210", "linux:abcd-1234:42"]);
    releaseMonitor.resolve();
    await expect(handle.completion).resolves.toMatchObject({ code: null });
    expect(handle.isExitConfirmed?.()).toBe(true);
    expect(execute.mock.calls.filter(([request]) => request.args?.[2] === "paperclip-runner-launch")).toHaveLength(1);
  });
});
