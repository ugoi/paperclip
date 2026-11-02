import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { spawnRunner, type RunnerProcessHandle, type RunnerProcessLaunchSpec, type RunnerProcessResult } from "../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";

it.each(["start", "resume"] as const)("does not spend the PRP command budget while the remote launch is staging (%s)", async mode => {
  const root = await mkdtemp(join(tmpdir(), "runner-launch-readiness-"));
  let announceLaunch!: () => void;
  const launchRequested = new Promise<void>(resolve => { announceLaunch = resolve; });
  let ready!: () => void;
  const launchReady = new Promise<void>(resolve => { ready = resolve; });
  let finish!: (result: RunnerProcessResult) => void;
  const completion = new Promise<RunnerProcessResult>(resolve => { finish = resolve; });
  let actual: RunnerProcessHandle | undefined;
  let spec!: RunnerProcessLaunchSpec;
  const options = {
    stateDirectory: root, sourceCodexHome: "", environment: {}, closeGraceMs: 2_000,
    runnerBinary: resolve(import.meta.dirname, "../../runner/target/debug/paperclip-runnerd"),
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "fake-codex-state.json")],
    prpIdentity: { runnerInstanceId: "runner-launch-ready", environmentLeaseId: "lease-launch-ready", runId: "run-launch-ready", normalizedSessionId: "session-launch-ready", turnId: "turn-launch-ready", itemId: "item-launch-ready" },
  };
  let resumeProviderSession: { driverSessionId: string; providerSessionId: string } | undefined;
  if (mode === "resume") {
    const first = createCapabilityRunnerdCodexTransport(options);
    try {
      const result = await first.transport.request("thread/start", { cwd: root, dynamicTools: [] });
      const thread = result.thread as { id: string; sessionId: string };
      resumeProviderSession = { driverSessionId: thread.id, providerSessionId: thread.sessionId };
    } finally { await first.transport.close(); }
  }
  const onSpawn = vi.fn();
  const bundle = createCapabilityRunnerdCodexTransport({
    ...options, resumeProviderSession, onSpawn,
    runnerProcessLauncher: input => {
      spec = input;
      announceLaunch();
      return {
        child: {
          get pid() { return actual?.child.pid; },
          get exitCode() { return actual?.child.exitCode ?? null; },
          kill: signal => actual?.child.kill(signal) ?? false,
        },
        completion,
        launchReady,
      };
    },
  });
  let outcome = "pending";
  let openingError: string | undefined;
  const opening = bundle.transport.request(mode === "start" ? "thread/start" : "thread/read", { cwd: root, dynamicTools: [] });
  void opening.then(() => { outcome = "opened"; }, error => { outcome = "failed"; openingError = String(error); });
  try {
    await launchRequested;
    await new Promise(resolve => setTimeout(resolve, 20));
    // Advance only the wall clock: the normal polling loop still runs, but
    // no native process exists yet. This reproduces >30s of remote staging.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 35_000);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect({ outcome, openingError }).toEqual({ outcome: "pending", openingError: undefined });
    vi.useRealTimers();
    actual = spawnRunner({ ...spec.nativeRunner!, runnerBinaryPath: spec.command, environment: spec.environment });
    void actual.completion.then(finish);
    // The remote launcher owns publication with its exact worker marker time.
    const remoteIdentity = { pid: actual.child.pid!, processGroupId: null, startedAt: "2026-10-21T14:54:54.000Z" };
    await onSpawn(remoteIdentity);
    ready();
    await expect(opening).resolves.toHaveProperty("thread.id");
    expect(onSpawn).toHaveBeenCalledExactlyOnceWith(remoteIdentity);
    await bundle.transport.close();
    expect(bundle.evidence().runnerExited).toBe(true);
  } finally {
    vi.useRealTimers();
    if (!actual) finish({ code: 0, signal: null, stdout: "", stderr: "fixture never launched" });
    ready();
    await opening.catch(() => undefined);
    await bundle.transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

it.each(["setup-failure", "cancel", "launch-timeout", "command-timeout"] as const)(
  "keeps remote launch failure and cancellation bounded (%s)", async mode => {
    const root = await mkdtemp(join(tmpdir(), "runner-launch-boundary-"));
    let announceLaunch!: () => void;
    const launched = new Promise<void>(resolve => { announceLaunch = resolve; });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const launchReady = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void launchReady.catch(() => undefined);
    let finish!: (result: RunnerProcessResult) => void;
    const completion = new Promise<RunnerProcessResult>(resolve => { finish = resolve; });
    const cancelPendingLaunch = vi.fn();
    const bundle = createCapabilityRunnerdCodexTransport({
      stateDirectory: root, sourceCodexHome: "", environment: {}, closeGraceMs: 200,
      // Only the launcher fixture owns execution; these stable bytes are
      // hashed as the runner artifact but never executed.
      runnerBinary: resolve(import.meta.dirname, "../../package.json"),
      runnerProcessLauncher: () => {
        announceLaunch();
        return { child: { exitCode: null, kill: () => false }, completion, launchReady, cancelPendingLaunch };
      },
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const opening = bundle.transport.request("thread/start", { cwd: root, dynamicTools: [] });
    void opening.catch(() => undefined);
    try {
      await launched;
      await vi.advanceTimersByTimeAsync(0);
      if (mode === "setup-failure") {
        rejectReady(new Error("specific artifact preparation failure"));
        await expect(opening).rejects.toThrow("specific artifact preparation failure");
        expect(cancelPendingLaunch).toHaveBeenCalled();
      } else if (mode === "cancel") {
        const closing = bundle.transport.close("cancel pending remote staging");
        let closed = false;
        void closing.then(() => { closed = true; }, () => { closed = true; });
        await expect(opening).rejects.toThrow("closed during provider startup");
        expect(cancelPendingLaunch).toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(100);
        expect(closed).toBe(false);
        finish({ code: 0, signal: null, stdout: "", stderr: "" });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(closing).resolves.toBeUndefined();
      } else if (mode === "launch-timeout") {
        const failure = expect(opening).rejects.toThrow("runner_process_launch_timed_out");
        await vi.advanceTimersByTimeAsync(60_001);
        await failure;
        expect(cancelPendingLaunch).toHaveBeenCalled();
      } else {
        resolveReady();
        await vi.advanceTimersByTimeAsync(0);
        const failure = expect(opening).rejects.toThrow("PRP command run.prepare timed out");
        await vi.advanceTimersByTimeAsync(30_001);
        await failure;
      }
    } finally {
      finish({ code: 0, signal: null, stdout: "", stderr: "fixture never launched" });
      resolveReady();
      await opening.catch(() => undefined);
      vi.useRealTimers();
      await bundle.transport.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000,
);
