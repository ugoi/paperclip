import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openRunnerApiWorkspaceFile } from "./native-runtime/runner-api-files.js";

const MAX_CREDENTIAL_BYTES = 64 * 1024;
const READ_ERROR = "Managed AI credential snapshot is not a private, stable regular file";

/** The agent controls the staging names. Validate and read one descriptor,
 * without following links at any path component or reopening after validation. */
export async function readManagedAiCredentialSnapshot(filename: string): Promise<string> {
  const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
  let file: Awaited<ReturnType<typeof openRunnerApiWorkspaceFile>> | undefined;
  try {
    file = await openRunnerApiWorkspaceFile(filename);
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1
        || (before.mode & 0o777) !== 0o600 || before.size > MAX_CREDENTIAL_BYTES) throw new Error(READ_ERROR);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (length > MAX_CREDENTIAL_BYTES || length !== before.size || after.nlink !== 1
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode
        || before.uid !== after.uid) throw new Error(READ_ERROR);
    return buffer.subarray(0, length).toString("utf8");
  } catch {
    // Filesystem errors may expose paths; never include credential contents.
    throw new Error(READ_ERROR);
  } finally {
    buffer.fill(0);
    await file?.close();
  }
}

/** Never put the database credential or merge inputs back in agent-writable
 * staging. Both predicate inputs are immutable snapshots in a new private
 * server directory outside the home passed to the agent. The exact source
 * bytes checked here are also the bytes committed to the secret service. */
export async function withManagedAiCredentialComparison<T>(
  refreshed: string,
  current: string,
  decide: (source: string, destination: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "paperclip-ai-merge-"));
  try {
    const source = path.join(directory, "refreshed.json");
    const destination = path.join(directory, "current.json");
    await writeFile(source, refreshed, { mode: 0o600, flag: "wx" });
    await writeFile(destination, current, { mode: 0o600, flag: "wx" });
    return await decide(source, destination);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
