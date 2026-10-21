import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isRemoteRunnerProcessFingerprint,
  REMOTE_RUNNER_PROCESS_FINGERPRINT_SCRIPT,
  REMOTE_RUNNER_PROCESS_PROBE_PREREQUISITE_SCRIPT,
} from "./remote-runner-process-probe.js";
import { REMOTE_RECOVERY_PROCESS_FINGERPRINT_CHECK_SCRIPT } from "./remote-runner-recovery-diagnostics.js";

function shellStatus(script: string, args: string[], environment?: NodeJS.ProcessEnv) {
  try {
    execFileSync("/bin/sh", ["-c", script, "process-probe-test", ...args], { env: environment, stdio: "pipe", timeout: 5_000 });
    return 0;
  } catch (error) { return (error as { status: number }).status; }
}

describe("portable remote process generation", () => {
  it.each([
    ["linux:abcd-1234:123", true],
    ["linux:boot:123", false],
    ["linux:abcd-1234:0;kill", false],
    ["darwin:55ae343f-6e1c-4f03-8398-e9af90c458ce:1792584000:123456", true],
    ["darwin:55ae343f-6e1c-4f03-8398-e9af90c458ce:1792584000:0", true],
    ["darwin:55ae343f-6e1c-4f03-8398-e9af90c458ce:0:1", false],
    ["darwin:55ae343f-6e1c-4f03-8398-e9af90c458ce:1792584000:1000000", false],
    ["darwin:55ae343f-6e1c-4f03-8398-e9af90c458ce:9999999999999999999999:1", false],
    ["darwin:bad-boot:1792584000:1", false],
    ["darwin:55ae343f-6e1c-4f03-8398-e9af90c458ce:1792584000:1\n", false],
  ] as const)("validates fingerprint %s", (value, expected) => {
    expect(isRemoteRunnerProcessFingerprint(value)).toBe(expected);
  });

  it.skipIf(process.platform !== "linux")("refuses a missing Linux probe runtime before any worker starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-process-prerequisite-"));
    const started = join(root, "worker-started");
    try {
      const uname = execFileSync("sh", ["-c", "command -v uname"], { encoding: "utf8" }).trim();
      await symlink(uname, join(root, "uname"));
      expect(shellStatus(REMOTE_RUNNER_PROCESS_PROBE_PREREQUISITE_SCRIPT + '; printf started > "$1"', [started], { PATH: root, HOME: root })).toBe(46);
      expect(existsSync(started)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("captures and verifies a real owned process generation, then confirms its exit", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    const pid = String(child.pid);
    try {
      const capture = 'set -eu; pid=$1; ' + REMOTE_RUNNER_PROCESS_FINGERPRINT_SCRIPT + '; printf "%s" "$process_fingerprint"';
      const fingerprint = execFileSync("sh", ["-c", capture, "capture", pid], { encoding: "utf8", timeout: 5_000 });
      expect(isRemoteRunnerProcessFingerprint(fingerprint)).toBe(true);
      const verify = 'set -eu; pid=$4; ' + REMOTE_RECOVERY_PROCESS_FINGERPRINT_CHECK_SCRIPT;
      const args = ["marker", "nonce", "runner", pid, fingerprint];
      expect(shellStatus(verify, args)).toBe(0);
      const changed = fingerprint.replace(/:[0-9]+$/, suffix => `:${Number(suffix.slice(1)) + 1}`);
      expect(shellStatus(verify, [...args.slice(0, 4), changed])).toBe(47);
      child.kill("SIGTERM");
      await exited;
      expect(shellStatus(verify, args)).toBe(45);
    } finally { child.kill("SIGKILL"); await exited; }
  });
});
