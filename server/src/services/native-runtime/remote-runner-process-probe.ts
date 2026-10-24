/** Process generation receipts for the explicitly supported remote host platforms. */

// Darwin has no /proc. libproc supplies kernel start seconds + microseconds,
// which survive exec and distinguish PID reuse; the boot UUID distinguishes boots.
// proc_bsdinfo is the public 136-byte SDK layout (PROC_PIDTBSDINFO = 3).
const DARWIN_PROCESS_PROBE = `
import ctypes, errno, os, re, subprocess, sys, time
pid_text, expected, mode = sys.argv[1:4]
if not re.fullmatch(r"[1-9][0-9]*", pid_text): sys.exit(46)
pid = int(pid_text)
if pid > 2147483647: sys.exit(46)
def liveness():
    try: os.kill(pid, 0)
    except OSError as error: sys.exit(45 if error.errno == errno.ESRCH else 46)
if mode == "alive":
    liveness()
    sys.exit(0)
class ProcBsdInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in ("flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "reserved")] + [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)] + [(name, ctypes.c_uint32) for name in ("nfiles", "pgid", "pjobc", "e_tdev", "e_tpgid")] + [("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]
try:
    if ctypes.sizeof(ProcBsdInfo) != 136: sys.exit(46)
    lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    lib.proc_pidinfo.restype = ctypes.c_int
    item = ProcBsdInfo()
    for attempt in range(6):
        ctypes.set_errno(0)
        got = lib.proc_pidinfo(pid, 3, 0, ctypes.byref(item), ctypes.sizeof(item))
        if got == ctypes.sizeof(item): break
        if got == 0 and ctypes.get_errno() == errno.ESRCH:
            liveness()
            # libproc may hide an exited, not-yet-reaped child. Wait briefly
            # for normal reaping; only a fresh ESRCH from kill confirms exit.
            if attempt < 5:
                time.sleep(0.05)
                continue
        sys.exit(46)
    if item.pid != pid or not item.start_sec or item.start_usec >= 1000000: sys.exit(46)
    boot = subprocess.check_output(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], text=True, stderr=subprocess.DEVNULL, timeout=2).strip().lower()
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", boot): sys.exit(46)
    fingerprint = "darwin:%s:%d:%d" % (boot, item.start_sec, item.start_usec)
    if mode == "capture":
        if item.status == 5: sys.exit(45)
        sys.stdout.write(fingerprint)
        sys.exit(0)
    if fingerprint != expected: sys.exit(47)
    if item.status == 5: sys.exit(45)
    sys.exit(44 if mode == "zombie" else 0)
except Exception:
    sys.exit(46)
`;

function darwinProbe(mode: "capture" | "alive" | "verify" | "zombie") {
  return `/usr/bin/python3 -c '${DARWIN_PROCESS_PROBE}' "$pid" "\${5:-}" "${mode}"`;
}

const LINUX_PROCESS_FINGERPRINT =
  `node -e 'const fs=require("node:fs");try{const stat=fs.readFileSync("/proc/"+process.argv[1]+"/stat","utf8");const end=stat.lastIndexOf(") ");const ticks=stat.slice(end+2).trim().split(/\\s+/)[19];const boot=fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim();if(end<0||!/^\\d+$/.test(ticks||"")||!/^[-a-fA-F0-9]+$/.test(boot))process.exit(4);process.stdout.write("linux:"+boot+":"+ticks)}catch{process.exit(4)}' "$pid"`;

export const REMOTE_RUNNER_PROCESS_FINGERPRINT_SCRIPT =
  `process_fingerprint=$(case "$(uname -s)" in (Linux) ${LINUX_PROCESS_FINGERPRINT} ;; (Darwin) ${darwinProbe("capture")} ;; (*) exit 46 ;; esac)`;

export function isRemoteRunnerProcessFingerprint(value: string): boolean {
  if (value.trim() !== value) return false;
  if (/^linux:[0-9a-f-]+:[0-9]+$/.test(value)) return true;
  const darwin = /^darwin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:([1-9][0-9]*):([0-9]+)$/.exec(value);
  return !!darwin && Number.isSafeInteger(Number(darwin[1])) && Number.isSafeInteger(Number(darwin[2])) && Number(darwin[2]) < 1_000_000;
}

// A missing runtime is an explicit pre-launch failure. Do not replace precise
// errno checks with shell kill -0 failure, which conflates ESRCH with EPERM.
export const REMOTE_RUNNER_PROCESS_PROBE_PREREQUISITE_SCRIPT =
  `set -eu; pid=$$; case "$(uname -s)" in (Linux) command -v node >/dev/null 2>&1 || exit 46; ${LINUX_PROCESS_FINGERPRINT} >/dev/null || exit 46 ;; (Darwin) ${darwinProbe("capture")} >/dev/null || exit 46 ;; (*) exit 46 ;; esac`;

export const REMOTE_RECOVERY_LIVENESS_CHECK_SCRIPT = `if command -v node >/dev/null 2>&1; then node -e '
const pid = process.argv[1];
try { process.kill(Number(pid), 0); }
catch (error) { process.exit(error && error.code === "ESRCH" ? 45 : 46); }
' "$pid"; elif test "$(uname -s)" = Darwin; then ${darwinProbe("alive")}; else exit 46; fi`;

export function remoteRecoveryGenerationCheck(zombieOnly: boolean) {
  const linux = `node -e '
const fs = require("node:fs");
const [pid, expected] = process.argv.slice(1);
try {
  const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
  const end = stat.lastIndexOf(") ");
  if (end < 0 || !stat.startsWith(pid + " (")) process.exit(46);
  const fields = stat.slice(end + 2).trim().split(/\\s+/);
  if (${zombieOnly} && fields[0] !== "Z") process.exit(44);
  const ticks = fields[19];
  const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!ticks || !/^[0-9]+$/.test(ticks) || !boot) process.exit(46);
  if ("linux:" + boot + ":" + ticks !== expected) process.exit(47);
  process.exit(fields[0] === "Z" ? 45 : 0);
} catch (error) {
  if (error && error.code === "ENOENT") {
    try { process.kill(Number(pid), 0); }
    catch (probeError) {
      if (probeError && probeError.code === "ESRCH") process.exit(45);
    }
  }
  process.exit(46);
}
' "$pid" "\${5:-}"`;
  return `case "\${5:-}" in (darwin:*) ${darwinProbe(zombieOnly ? "zombie" : "verify")} ;; (*) ${linux} ;; esac`;
}
