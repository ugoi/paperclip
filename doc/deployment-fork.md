# Deployment fork

The `deploy/stefan-production` branch follows upstream `paperclipai/paperclip`
and carries reviewed changes for a Linux control plane with Linux and macOS SSH
workers. It includes upstream PR #17073 at `306781d2a6fcfa4f7f38cd1208114cbbdaba215f`.
It is a downstream build, not an official Paperclip release.

## Change and verification policy

Fetch upstream and merge `upstream/master` into this branch. Resolve conflicts,
review the resulting diff and rerun the affected regression tests before building
or deploying. A Git pull alone does not upgrade a running container.

The process-exit regression was first reproduced using compiled code copied from
the unmodified deployed `f3af9887ca796117d54280a04e2ed08bc5e76a75` image. Real owned
processes demonstrated both the fingerprint-read race and a matching Linux zombie.
The same scheduling boundary passes after the change. This is evidence for that
process classification mechanism, not proof that every cleanup quarantine shares
its cause. Historical holds are not automatically cleared.

Downstream changes add strong Darwin process generation receipts and an explicit
trusted-host Codex opt-in. Missing monitoring prerequisites now reject a launch
before starting a worker. This deliberately replaces the old missing-Node path:
shell `kill -0` alone cannot distinguish absence from permission denial. Failed
startup cleanup validates the saved generation before signalling and confirms exit
before deleting its marker. An unreadable Darwin zombie remains uncertain until a
fresh kernel probe proves it has been reaped.

`codexSandboxMode: "danger-full-access"` and `remoteCodexHome` require a selected
SSH environment and `homeMode: "preconfigured"`. Ordinary agents keep their
existing policy, and planning remains read-only. Remote home selection is explicit
and checked on the remote host; controller paths never implicitly select it.

The first deployed fork also reproduced a distinct startup failure: remote staging
and mandatory identity probes consumed the 30-second `run.prepare` deadline
before the worker started. A deterministic delayed-launch test preserves that
failure. Launch readiness now has its own bootstrap-lifetime bound, followed by
the unchanged provider command budget. Cancellation during staging prevents late
launch; cancellation crossing dispatch retains exact process cleanup ownership.
Both fresh startup and session recovery exercise this boundary.

## Building and operating

For the nested status-filter correction, `Dockerfile.ui-update` rebuilds only
the UI on the immutable accepted `ccce203` image. Its workflow rejects changes
to the backend, worker sources or dependency manifests. It runs the relevant
UI regression tests, UI typecheck and token gates before building the browser
assets. This preserves the exact Linux and Darwin worker bytes and avoids
changing an unrelated runtime during a UI repair.

The image's `io.paperclip.ui.revision` label and `/build-revision.json` record
the new UI source. `io.paperclip.core.revision` and `/api/health` retain the
unchanged backend revision. The image digest identifies the complete deployed
combination. Use the normal full-source workflow for backend, dependency or
worker changes. The normal build also includes the filter correction.

Build the Linux Core from the normal `Dockerfile`, supplying the full reviewed Git
commit as `PAPERCLIP_BUILD_COMMIT`. Build the Darwin arm64 runner from the exact same
commit on macOS, using the package-owned Rust toolchain and Cargo lockfile. Preserve
source manifests, binary hashes, build metadata and the test results together.

The fork's `Stefan production image` GitHub Actions workflow builds both platforms
from one commit on separate disposable hosted runners. A push to
`deploy/stefan-production` publishes a candidate at
`ghcr.io/ugoi/paperclip:stefan-<full-commit>`; its summary records the immutable
image digest and Darwin checksum. It never deploys automatically. Keep the tested
digest in the infrastructure repository, not a moving tag. The existing upstream
release workflows and official registry are not used for this downstream build.

For a manual build, wrap the Core with `Dockerfile.remote-runner`. Its `PAPERCLIP_CORE_IMAGE` argument
selects the tested Linux image. The named `darwin-runner` context provides
`paperclip-runnerd`; `DARWIN_RUNNER_SHA256` pins its reviewed bytes. The wrapper
checks the checksum and Mach-O architecture and installs the daemon in both
supported package roots. Never put binaries, credentials or runtime state in Git.

The infrastructure repository owns deployment configuration, image selection,
backups and worker artifact pins. Drain active runs, preserve the database and
configuration, then deploy matching Core/worker artifacts. Check health, native
task completion, continuation and cancellation on every changed platform. Keep
the prior image, database backup and adapter configuration available for rollback.

## Upstream snapshot integration: 2026-10-23

The maintenance update merges upstream master at
`75fcb0b3fca427774cff8f4f7ed43de9ab7f626b`. It retains the downstream process
identity, cleanup, remote launch readiness, preconfigured SSH home, trusted-host
Codex, and nested status-filter fixes. The upstream optional working-directory
path and plugin execution paths keep their separate authority checks.

Upstream and this fork independently assigned Copilot profile versions 53–55.
The upstream historical fixtures keep their canonical filenames. The historical
fork fixtures are preserved with `-stefan-identity.json` names, and their existing
regression assertions remain. The merged implementation has a new profile 59
identity; neither historical digest is reused to authorize the new source.

This is a full Core and runner update. The UI-only image recipe is not suitable
for it. Build both Linux and Darwin runners from the same final source, verify
their embedded metadata and package/vendor copies, then stage a separate
coordinated deployment. Source integration is not production acceptance.
