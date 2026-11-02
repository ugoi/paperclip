# Deployment fork

The `deploy/stefan-production` branch follows upstream `paperclipai/paperclip`
and carries reviewed changes for a Linux control plane with Linux and macOS SSH
workers. It is a downstream build, not an official Paperclip release. Upstream
PR #17073 was carried until 2026-11-01; upstream replaced it with #17799.

## Change and verification policy

Fetch upstream and rebuild the fork on `upstream/master`: create an update branch
from upstream and re-apply the downstream commits one by one, dropping those that
upstream has replaced. Review the resulting diff and rerun the affected regression
tests before building or deploying. A Git pull alone does not upgrade a running
container. `UPDATE_REPORT.md` records the decisions of the latest update.

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

## Upstream snapshot integration: 2026-11-01

The fork was rebuilt on upstream master `1a6017d6460267ad89d7e1784e2b521c28d8e9ac`.
Upstream #17799 replaced the carried #17073; the Darwin generation receipt now
sits in front of upstream's Linux process check. Upstream no longer hashes
Paperclip source into ACPX profile digests, so fork source changes no longer
need Copilot profile refreshes; the fork's historical profile 53–59 fixtures were
not carried forward. Upstream #17878 replaced the fork's task-directory
continuation. Upstream Hermes PRs #18434 and #18528 are included until upstream
merges them. See `UPDATE_REPORT.md` for every decision, migrations and rollout.
