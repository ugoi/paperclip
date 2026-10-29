import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

// Resolve the account's home from the OS account database, never from an
// environment variable supplied by the controller or a login profile.
export const REMOTE_ACCOUNT_HOME_SCRIPT =
  'set -eu; case "$(uname -s)" in Darwin) /usr/bin/python3 -c \'import os,pwd; print(pwd.getpwuid(os.getuid()).pw_dir)\' ;; *) getent passwd "$(id -u)" | cut -d: -f6 ;; esac';

const VALIDATE_CODEX_HOME_PYTHON = `import os,stat,sys
p=sys.argv[1]
if not os.path.isabs(p) or os.path.realpath(p)!=p: sys.exit(2)
s=os.stat(p)
if not stat.S_ISDIR(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode & 0o022: sys.exit(2)
print(p)`;

export const REMOTE_CODEX_HOME_VALIDATION_SCRIPT =
  'set -eu; case "$(uname -s)" in Darwin) python=/usr/bin/python3 ;; *) python=$(command -v python3) ;; esac; exec "$python" -c ' +
  `'${VALIDATE_CODEX_HOME_PYTHON.replaceAll("'", "'\\''")}' "$1"`;

export async function resolveRemotePreconfiguredHome(
  runner: CommandManagedRuntimeRunner,
  remoteCodexHome?: string,
): Promise<{ home: string; codexHome?: string }> {
  const discovered = await runner.execute({
    command: "sh", args: ["-c", REMOTE_ACCOUNT_HOME_SCRIPT],
    bypassSession: true, timeoutMs: 10_000,
  });
  const home = discovered.stdout.trim();
  if (discovered.exitCode !== 0 || discovered.timedOut || !home.startsWith("/") || /[\0\r\n]/.test(home)) {
    throw new Error("runner_preconfigured_remote_home_unavailable");
  }
  if (remoteCodexHome === undefined) return { home };
  if (!remoteCodexHome.startsWith("/") || /[\0\r\n]/.test(remoteCodexHome)) {
    throw new Error("runner_preconfigured_remote_codex_home_invalid");
  }
  const validated = await runner.execute({
    command: "sh",
    args: ["-c", REMOTE_CODEX_HOME_VALIDATION_SCRIPT, "paperclip-codex-home", remoteCodexHome],
    bypassSession: true, timeoutMs: 10_000,
  });
  if (validated.exitCode !== 0 || validated.timedOut || validated.stdout.trim() !== remoteCodexHome) {
    throw new Error("runner_preconfigured_remote_codex_home_invalid");
  }
  return { home, codexHome: remoteCodexHome };
}
