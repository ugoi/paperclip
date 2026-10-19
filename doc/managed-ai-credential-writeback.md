# Managed AI credential write-back boundary

A subscription provider may atomically replace its staged `auth.json`. Treat
that staging directory as agent-controlled when reading the result. The native
cleanup opens every path component without following symlinks, checks ownership,
mode 0600, one link, regular-file type and a 64 KiB bound on the descriptor, and
reads only that descriptor. Changed metadata during the read fails closed.

The merge predicate must compare exactly the bytes subsequently written to the
secret service. It now receives two private snapshots in a fresh server-owned
directory outside the agent home. It never writes `current-auth.json` in the
agent's directory and never reopens the agent's auth pathname for comparison.
The existing account identity/freshness predicate, secret-row lock, company
lock retries and session-epoch behavior are unchanged. Comparison scratch files
are removed even on failure; a failed write-back still preserves the original
provider home for retry. No credential content is included in read errors.

`server/src/__tests__/managed-ai-credential-snapshot.test.ts` covers atomic
replacement, links, special files, private permissions, size, replacement after
open, mutation during read and comparison cleanup. The native integration
regression in `ai-connections.test.ts` checks the host-canary symlink and a
valid refresh together, then verifies rejection of an auth symlink without
losing the retained credential. Existing tests cover lock/database failure
retries and account/freshness behavior. These tests use synthetic credentials.

Linux uses descriptor-relative opens; Darwin uses the existing all-component
no-follow open. The temporary root is canonicalized before creating staging.
Unsupported platforms fail closed. The private comparison directory protects
the isolated child identity; it is not a security boundary against arbitrary
other processes with the server's own UID. A production account refresh, model
run and device delivery require separate evidence.
