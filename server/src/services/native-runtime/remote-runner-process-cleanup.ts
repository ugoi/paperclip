import {
  REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT,
  REMOTE_RECOVERY_PROCESS_FINGERPRINT_CHECK_SCRIPT,
} from "./remote-runner-recovery-diagnostics.js";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const probeScript = REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT + "; " + REMOTE_RECOVERY_PROCESS_FINGERPRINT_CHECK_SCRIPT;

/**
 * Failed startup must not turn a stale PID marker into authority to signal a new
 * process. Reuse the same generation proof as active supervision before every
 * signal; remove the unchanged marker only after a definite exit receipt.
 */
export const REMOTE_RUNNER_FAILED_IDENTITY_CLEANUP_SCRIPT = `set -eu
identity_path=$1; expected_nonce=$2; expected_runner_id=$3
marker_wait=0
while { test ! -f "$identity_path" || test -L "$identity_path"; } && test "$marker_wait" -lt 50; do
  marker_wait=$((marker_wait + 1)); sleep 0.1
done
test -f "$identity_path" && test ! -L "$identity_path" || exit 3
{ IFS= read -r nonce; IFS= read -r pid; IFS= read -r started_at; IFS= read -r runner_id; IFS= read -r fingerprint; } < "$identity_path" || exit 4
test "$nonce" = "$expected_nonce" && test "$runner_id" = "$expected_runner_id" && test -n "$started_at" && test -n "$fingerprint" || exit 4
case "$pid" in ""|*[!0-9]*) exit 4 ;; esac
test "$pid" -gt 0 || exit 4
marker_matches() {
  test -f "$identity_path" && test ! -L "$identity_path" || return 4
  { IFS= read -r final_nonce; IFS= read -r final_pid; IFS= read -r final_started_at; IFS= read -r final_runner_id; IFS= read -r final_fingerprint; } < "$identity_path" || return 4
  test "$final_nonce" = "$nonce" && test "$final_pid" = "$pid" && test "$final_started_at" = "$started_at" && test "$final_runner_id" = "$runner_id" && test "$final_fingerprint" = "$fingerprint"
}
probe() {
  marker_matches || return 4
  sh -c ${quote(probeScript)} paperclip-cleanup-probe "$identity_path" "$nonce" "$runner_id" "$pid" "$fingerprint"
}
probe_code=0; probe || probe_code=$?
case "$probe_code" in 0|45) ;; *) exit "$probe_code" ;; esac
if test "$probe_code" = 0; then
  signal_target=$pid
  if command -v ps >/dev/null 2>&1; then
    session_id=$(ps -o sid= -p "$pid" 2>/dev/null | tr -d " ") || true
    if test "$session_id" = "$pid"; then signal_target="-$pid"; fi
  fi
  # Recheck after process-group discovery, immediately before TERM.
  probe_code=0; probe || probe_code=$?
  case "$probe_code" in 0) kill -TERM -- "$signal_target" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true ;; 45) ;; *) exit "$probe_code" ;; esac
  term_wait=0
  while test "$probe_code" = 0 && test "$term_wait" -lt 50; do
    term_wait=$((term_wait + 1)); sleep 0.1
    probe_code=0; probe || probe_code=$?
    case "$probe_code" in 0|45) ;; *) exit "$probe_code" ;; esac
  done
  if test "$probe_code" = 0; then
    # The PID could have been recycled during the TERM grace period.
    probe_code=0; probe || probe_code=$?
    case "$probe_code" in 0) kill -KILL -- "$signal_target" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true ;; 45) ;; *) exit "$probe_code" ;; esac
    kill_wait=0
    while test "$probe_code" = 0 && test "$kill_wait" -lt 50; do
      kill_wait=$((kill_wait + 1)); sleep 0.1
      probe_code=0; probe || probe_code=$?
      case "$probe_code" in 0|45) ;; *) exit "$probe_code" ;; esac
    done
  fi
fi
test "$probe_code" = 45 || exit 5
marker_matches || exit 4
rm -f -- "$identity_path"
`;
