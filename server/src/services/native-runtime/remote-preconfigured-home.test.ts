import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import {
  REMOTE_ACCOUNT_HOME_SCRIPT,
  REMOTE_CODEX_HOME_VALIDATION_SCRIPT,
  resolveRemotePreconfiguredHome,
} from "./remote-preconfigured-home.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const ownedHome = () => {
  const directory = mkdtempSync(join(tmpdir(), "paperclip codex home-"));
  directories.push(directory);
  return directory;
};
const validate = (path: string) => execFileSync("sh", ["-c", REMOTE_CODEX_HOME_VALIDATION_SCRIPT, "test", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

describe("remote preconfigured account home", () => {
  it("uses the OS account home despite an inherited HOME override", () => {
    expect(execFileSync("sh", ["-c", REMOTE_ACCOUNT_HOME_SCRIPT], { encoding: "utf8", env: { ...process.env, HOME: "/wrong-controller-home" } }).trim()).toBe(userInfo().homedir);
  });

  it("accepts an owned canonical directory, including spaces", () => {
    const directory = ownedHome();
    expect(validate(directory)).toBe(directory);
  });

  it("rejects a writable directory and a symlink instead of selecting another home", () => {
    const directory = ownedHome();
    chmodSync(directory, 0o777);
    expect(() => validate(directory)).toThrow();
    chmodSync(directory, 0o700);
    symlinkSync(directory, join(directory, "alias"));
    expect(() => validate(join(directory, "alias"))).toThrow();
  });

  it("passes an explicit path as an argument rather than executing shell text", () => {
    const directory = ownedHome();
    expect(() => validate(`${directory}/$(touch marker)`)).toThrow();
  });

  it("rejects an invalid account lookup before consulting an explicit Codex home", async () => {
    const execute = vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "", stderr: "" });
    await expect(resolveRemotePreconfiguredHome({ execute } as unknown as CommandManagedRuntimeRunner, "/trusted")).rejects.toThrow("runner_preconfigured_remote_home_unavailable");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("requires the remote validator to confirm the exact requested home", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, timedOut: false, stdout: "/Users/worker\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, timedOut: false, stdout: "/different\n", stderr: "" });
    await expect(resolveRemotePreconfiguredHome({ execute } as unknown as CommandManagedRuntimeRunner, "/trusted")).rejects.toThrow("runner_preconfigured_remote_codex_home_invalid");
  });
});
