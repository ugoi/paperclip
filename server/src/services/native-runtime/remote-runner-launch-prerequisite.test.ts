import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT } from "./native-session-executor.js";
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
