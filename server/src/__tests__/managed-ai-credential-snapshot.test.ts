import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import * as confined from "../services/native-runtime/runner-api-files.js";
import { readManagedAiCredentialSnapshot, withManagedAiCredentialComparison } from "../services/managed-ai-credential-snapshot.js";

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "managed-auth-test-"));
  directories.push(directory);
  const filename = path.join(directory, "auth.json");
  await writeFile(filename, "synthetic-refresh", { mode: 0o600 });
  return { directory, filename };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

describe("managed credential snapshots", () => {
  it("reads an atomic private credential replacement", async () => {
    const { directory, filename } = await fixture();
    const replacement = path.join(directory, "replacement");
    await writeFile(replacement, "new-refresh", { mode: 0o600 });
    await rename(replacement, filename);
    expect(await readManagedAiCredentialSnapshot(filename)).toBe("new-refresh");
  });
  it.each(["symlink", "ancestor", "hardlink", "fifo", "directory", "mode", "oversize"])("rejects %s before returning credential bytes", async kind => {
    const { directory, filename } = await fixture();
    if (kind === "symlink") { await rename(filename, filename + ".real"); await symlink(filename + ".real", filename); }
    if (kind === "ancestor") { await symlink(directory, directory + "-link"); directories.push(directory + "-link"); await expect(readManagedAiCredentialSnapshot(path.join(directory + "-link", "auth.json"))).rejects.toThrow("private, stable regular file"); return; }
    if (kind === "hardlink") await link(filename, filename + ".link");
    if (kind === "fifo") { await rm(filename); expect(spawnSync("mkfifo", [filename]).status).toBe(0); }
    if (kind === "directory") { await rm(filename); await mkdir(filename); }
    if (kind === "mode") await chmod(filename, 0o644);
    if (kind === "oversize") await writeFile(filename, "x".repeat(65537));
    await expect(readManagedAiCredentialSnapshot(filename)).rejects.toThrow("private, stable regular file");
  });
  it("never reopens the name when replaced after the descriptor is opened", async () => {
    const { directory, filename } = await fixture();
    const canary = path.join(directory, "host-canary");
    await writeFile(canary, "unrelated-secret", { mode: 0o600 });
    const open = confined.openRunnerApiWorkspaceFile;
    vi.spyOn(confined, "openRunnerApiWorkspaceFile").mockImplementationOnce(async name => {
      const handle = await open(name);
      await rename(filename, filename + ".pinned");
      await symlink(canary, filename);
      return handle;
    });
    expect(await readManagedAiCredentialSnapshot(filename)).toBe("synthetic-refresh");
    expect(await readFile(canary, "utf8")).toBe("unrelated-secret");
  });
  it("rejects in-place mutation during the descriptor read", async () => {
    const { filename } = await fixture();
    const open = confined.openRunnerApiWorkspaceFile;
    vi.spyOn(confined, "openRunnerApiWorkspaceFile").mockImplementationOnce(async name => {
      const handle = await open(name);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce(async (...args: any[]) => {
        const result = await (read as any)(...args);
        await chmod(filename, 0o644);
        return result;
      });
      return handle;
    });
    await expect(readManagedAiCredentialSnapshot(filename)).rejects.toThrow("private, stable regular file");
  });
  it.each([false, true])("isolates comparison inputs and removes them after failure=%s", async fail => {
    const { directory } = await fixture();
    const canary = path.join(directory, "host-canary");
    await writeFile(canary, "keep", { mode: 0o600 });
    await symlink(canary, path.join(directory, "current-auth.json"));
    let snapshotDirectory = "";
    const decision = withManagedAiCredentialComparison("new", "old", async (source, destination) => {
      snapshotDirectory = path.dirname(source);
      expect(snapshotDirectory).not.toBe(directory);
      expect((await stat(snapshotDirectory)).mode & 0o777).toBe(0o700);
      expect(await readFile(source, "utf8")).toBe("new");
      expect(await readFile(destination, "utf8")).toBe("old");
      if (fail) throw new Error("predicate failure");
      return 10;
    });
    if (fail) await expect(decision).rejects.toThrow("predicate failure");
    else expect(await decision).toBe(10);
    await expect(stat(snapshotDirectory)).rejects.toHaveProperty("code", "ENOENT");
    expect(await readFile(canary, "utf8")).toBe("keep");
  });
});
