import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isUnarchivableTarDiagnostic, summarizeTarArchiveFailure, syncDirectoryToSsh } from "./ssh.js";

// Shape of the production failure: every relative `..` symlink in a source
// mounted with SSHFS 3.7.6 (contain_symlinks) fails readlink with EPERM.
function sshfsReadlinkStderr(count: number): string {
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(`tar: ./agents/skills/group-${index % 7}/skill-${index}: Cannot readlink: Operation not permitted`);
  }
  lines.push("tar: .: file changed as we read it");
  lines.push("tar: Exiting with failure status due to previous errors");
  return `${lines.join("\n")}\n`;
}

describe("tar archive diagnostics for SSH uploads", () => {
  it("recognizes entries tar could not archive", () => {
    expect(isUnarchivableTarDiagnostic("tar: ./a/link: Cannot readlink: Operation not permitted")).toBe(true);
    expect(isUnarchivableTarDiagnostic("tar: ./secret: Cannot open: Permission denied")).toBe(true);
    expect(isUnarchivableTarDiagnostic("tar: ./dangling: Cannot stat: No such file or directory")).toBe(true);
    expect(isUnarchivableTarDiagnostic("tar: ./big.bin: Read error at byte 0, while reading 9216 bytes: Input/output error")).toBe(true);
    expect(isUnarchivableTarDiagnostic("tar: ./link: Couldn't read link data: Operation not permitted")).toBe(true);
    // Warnings and trailers are not an early-stop signal by themselves.
    expect(isUnarchivableTarDiagnostic("tar: .: file changed as we read it")).toBe(false);
    expect(isUnarchivableTarDiagnostic("tar: ./sock: socket ignored")).toBe(false);
    expect(isUnarchivableTarDiagnostic("tar: ./x: Warning: Cannot open: Permission denied")).toBe(false);
    expect(isUnarchivableTarDiagnostic("tar: Exiting with failure status due to previous errors")).toBe(false);
    // A write error on the archive stream means the SSH side failed; it reports its own cause.
    expect(isUnarchivableTarDiagnostic("tar: -: Cannot write: Broken pipe")).toBe(false);
  });

  it("groups hundreds of identical tar errors into a bounded, actionable message", () => {
    const message = summarizeTarArchiveFailure({
      stderr: sshfsReadlinkStderr(391),
      localDir: "/home/hermes/projects/homelab",
      label: "workspace",
      exitCode: 2,
    });
    expect(message).toContain('Upload of workspace "/home/hermes/projects/homelab" over SSH failed');
    expect(message).toContain("tar reported 392 entries (391 could not be archived) and exited with code 2.");
    expect(message).toContain("- Cannot readlink: Operation not permitted: 391 entries, e.g. ./agents/skills/group-0/skill-0,");
    expect(message).toContain("and 386 more");
    expect(message).toContain("- file changed as we read it: 1 entry, e.g. .");
    expect(message).toContain("contain_symlinks");
    expect(message).not.toContain("Exiting with failure status");
    expect(message.split("\n").length).toBeLessThanOrEqual(6);
    expect(message.length).toBeLessThan(1_500);
  });

  it("keeps unrecognized tar output and reports the exit code", () => {
    const message = summarizeTarArchiveFailure({
      stderr: "tar: -: Cannot write: Broken pipe\ntar: Error is not recoverable: exiting now\n",
      localDir: "/workspace",
      exitCode: 2,
    });
    expect(message).toContain('Upload of directory "/workspace" over SSH failed');
    expect(message).toContain("- Cannot write: Broken pipe: 1 entry, e.g. -");
    expect(message).toContain("- tar: Error is not recoverable: exiting now");
    expect(message).not.toContain("contain_symlinks");
  });
});

describe("syncDirectoryToSsh with an entry tar cannot archive", () => {
  const cleanupDirs: string[] = [];
  const originalPath = process.env.PATH;

  afterEach(async () => {
    process.env.PATH = originalPath;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await chmod(path.join(dir, "workspace", "unreadable.txt"), 0o600).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // Root can read mode-000 files, so the unreadable entry cannot be simulated.
  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "stops the upload with a grouped error instead of tar's raw per-entry output",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-tar-diagnostics-"));
      cleanupDirs.push(root);
      const binDir = path.join(root, "bin");
      const localDir = path.join(root, "workspace");
      const sink = path.join(root, "ssh-stdin.tar");
      await mkdir(binDir, { recursive: true });
      await mkdir(localDir, { recursive: true });
      await writeFile(path.join(localDir, "readable.txt"), "ok\n", "utf8");
      await writeFile(path.join(localDir, "unreadable.txt"), "secret\n", "utf8");
      await chmod(path.join(localDir, "unreadable.txt"), 0o000);
      // Stand-in for the remote `tar -xf -`: consume the stream without a network.
      await writeFile(path.join(binDir, "ssh"), `#!/bin/sh\ncat > ${JSON.stringify(sink)}\n`, { mode: 0o755 });
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

      const upload = syncDirectoryToSsh({
        spec: {
          host: "remote.invalid",
          port: 22,
          username: "paperclip",
          remoteWorkspacePath: "/remote",
          remoteCwd: "/remote",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: false,
        },
        localDir,
        remoteDir: "/remote/workspace",
        progressLabel: "workspace",
      });

      const error = await upload.then(() => null, (reason: unknown) => reason as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain(`Upload of workspace "${localDir}" over SSH was stopped`);
      expect(error?.message).toContain("- Cannot open: Permission denied: 1 entry, e.g. ./unreadable.txt");
      expect(error?.message).not.toMatch(/^tar: /m);
      // The fake remote may or may not have received bytes before the stop;
      // it must never have been given the unreadable file's contents.
      const received = await stat(sink).then(() => readFile(sink, "latin1"), () => "");
      expect(received).not.toContain("secret");
    },
    30_000,
  );
});
