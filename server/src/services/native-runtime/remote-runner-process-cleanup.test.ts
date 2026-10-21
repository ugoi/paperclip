import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REMOTE_RUNNER_FAILED_IDENTITY_CLEANUP_SCRIPT } from "./remote-runner-process-cleanup.js";
import { REMOTE_RUNNER_PROCESS_FINGERPRINT_SCRIPT } from "./remote-runner-process-probe.js";

function execute(script: string, args: string[]) {
  return new Promise<number | null>(resolve => execFile("sh", ["-c", script, "cleanup-test", ...args], { timeout: 15_000 }, error => {
    resolve(error ? typeof error.code === "number" ? error.code : null : 0);
  }));
}

describe("failed startup cleanup ownership", () => {
  it.each(["generation", "nonce", "missing_fingerprint", "unsafe_marker", "permission", "marker_changed_before_signal"])("does not signal or remove an unproven %s marker", async problem => {
    const root = await mkdtemp(join(tmpdir(), "remote-cleanup-proof-"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--runner-id", "cleanup-owned"], { stdio: "ignore" });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
      const marker = join(root, "identity");
      const fingerprint = execFileSync("sh", ["-c", 'pid=$1; ' + REMOTE_RUNNER_PROCESS_FINGERPRINT_SCRIPT + '; printf "%s" "$process_fingerprint"', "capture", String(child.pid)], { encoding: "utf8" });
      const saved = problem === "generation" ? fingerprint.replace(/:[0-9]+$/, ":1") : fingerprint;
      const content = `${problem === "nonce" ? "other" : "nonce"}\n${child.pid}\n2026-10-21T00:00:00Z\ncleanup-owned\n${problem === "missing_fingerprint" ? "" : saved}\n`;
      await writeFile(problem === "unsafe_marker" ? join(root, "target") : marker, content);
      if (problem === "unsafe_marker") await symlink(join(root, "target"), marker);
      let script = REMOTE_RUNNER_FAILED_IDENTITY_CLEANUP_SCRIPT;
      if (problem === "permission") script = script.replaceAll('process.kill(Number(pid), 0)', '(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); })()').replaceAll('os.kill(pid, 0)', '(_ for _ in ()).throw(PermissionError(errno.EPERM, "denied"))');
      if (problem === "marker_changed_before_signal") script = 'ps() { printf changed > "$identity_path"; command ps "$@"; }; ' + script;
      const code = await execute(script, [marker, "nonce", "cleanup-owned"]);
      expect(code).not.toBe(0);
      expect(code).not.toBeNull();
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(existsSync(marker)).toBe(true);
      if (problem !== "marker_changed_before_signal") expect(await readFile(marker, "utf8")).toBe(content);
    } finally { child.kill("SIGKILL"); await exited; await rm(root, { recursive: true, force: true }); }
  });

  it("stops the matching owned process and removes only its unchanged marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-cleanup-matching-"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--runner-id", "cleanup-owned"], { stdio: "ignore" });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
      const marker = join(root, "identity");
      const fingerprint = execFileSync("sh", ["-c", 'pid=$1; ' + REMOTE_RUNNER_PROCESS_FINGERPRINT_SCRIPT + '; printf "%s" "$process_fingerprint"', "capture", String(child.pid)], { encoding: "utf8" });
      await writeFile(marker, `nonce\n${child.pid}\n2026-10-21T00:00:00Z\ncleanup-owned\n${fingerprint}\n`);
      expect(await execute(REMOTE_RUNNER_FAILED_IDENTITY_CLEANUP_SCRIPT, [marker, "nonce", "cleanup-owned"])).toBe(0);
      await exited;
      expect(existsSync(marker)).toBe(false);
    } finally { child.kill("SIGKILL"); await exited; await rm(root, { recursive: true, force: true }); }
  });
});
