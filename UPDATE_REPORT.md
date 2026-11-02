# Upstream update 2026-11-01: `update/upstream-20261101`

**Status: prepared, not deployed.** Do not merge before Stefan approves. Merging
pushes `deploy/stefan-production`, which starts the `Stefan production image`
workflow (it builds and publishes an image candidate; it does not deploy).
Nothing was deployed or restarted, no migration was run, and no production
configuration was changed. Production reads used `GET` only.

| | |
| --- | --- |
| Upstream base | `paperclipai/paperclip` master `1a6017d6460267ad89d7e1784e2b521c28d8e9ac` (2026-11-01) |
| Previous fork | `deploy/stefan-production` `8c4531520` (production runs `da248c1ff`, runtime-identical) |
| Previous upstream | `75fcb0b3fca427774cff8f4f7ed43de9ab7f626b` (2026-10-23), 539 upstream commits ago |
| Method | New branch from upstream master; fork commits re-applied one by one with `cherry-pick -x` |
| Result | 21 fork commits re-applied (9 adapted, 3 partly), 4 dropped as superseded or obsolete, 3 upstream Hermes commits added, 3 new fixes |
| Database | 46 upstream migrations `0377`–`0422`; one can fail on duplicate data (preflight query below) |

## Summary

- **Dropped because upstream covers it:** #17073 (replaced by upstream #17799), the
  Copilot profile source-identity refreshes (upstream stopped binding Paperclip
  source into profile digests on 2026-10-30), and the task-directory continuation
  (upstream #17878).
- **Kept and adapted:** verified SSH native workers for Linux/macOS (Darwin libproc
  generation receipt now in front of upstream's new Linux check), bounded launch
  readiness, preconfigured SSH home checks, SSH stop receipts and lease binding,
  Kubernetes sandbox fixes, observer agent boundary and persistent Kata home, Hermes
  gateway human handoff, nested status filter UI fix, shared-workspace failure
  settlement, SSH cleanup scope, fork CI/build workflows.
- **Added:** upstream Hermes PRs #18434 and #18528 (still open upstream; only affect
  `hermes_local`, which production does not use yet).
- **Live problem (b), claude_local tar upload:** root cause found (read-only SSHFS
  view on Core + sshfs 3.7.6 `contain_symlinks`); fail-fast/bounded-error/cleanup fix
  on the branch; real fix (in-place SSH execution) is a follow-up. The Engineer and
  CEO were still failing this way at 00:37 CET — needs an operator decision.
- **Live problem (a), CTO stuck in `pausing`:** see its section.

## Commit-by-commit decisions

Base: upstream `paperclipai/paperclip` master `1a6017d64` (2026-11-01,
"fix(server): resume suspended sessions after controller replacement (#18554)").
Source: fork `deploy/stefan-production` at `8c4531520`, 30 commits on top of
merge-base `75fcb0b`. Merge commits were not replayed; their conflict
resolutions were reproduced inside the adapted commits below.

| Fork commit | Subject | Decision | New commit |
| --- | --- | --- | --- |
| `306781d2a` | fix(native): confirm remote runner exits during process checks (upstream PR #17073) | **Dropped.** Upstream closed #17073 on 2026-10-26 as superseded by #17799 (`718c73daf`, verified remote process exit receipts), which is in master. | — |
| `826f17241` | Merge upstream PR #17073 | Dropped (merge). | — |
| `0481a10d7` | Support verified Linux and macOS native workers | **Adapted**, 11 conflicted files. `createIsolatedCodexAppServerArgs` gained upstream's `disableWebSearch` parameter before the trusted-host flag; all callers and tests now pass both positions. Thread start/resume use upstream's `threadParams` / `#resumeThreadParams` helpers with the trusted-host grant added. Upstream #17799 rewrote the Linux recovery check into one Node script; the fork's Darwin libproc generation check is dispatched by `darwin:` fingerprint prefix in front of it instead of replacing it. The pre-launch probe prerequisite runs after upstream's cancel-before-dispatch check. Upstream's `ensureArtifact(spec)` source-recovery form is kept and the SSH launcher additionally requires a start fingerprint. | `948def39d` |
| `13ec080e7` | Refresh runner source identity; cache builds | **Partly.** CI cache steps kept. Copilot profile 52→53 refresh, fixture and doc dropped: since 2026-10-30 upstream no longer hashes Paperclip source into ACPX profile digests (`doc/architecture/runner-copilot-capabilities.md`). | `ff450517a` |
| `5520764c9` | Start remote command deadlines after bounded launch preparation | **Adapted.** Upstream now issues the bootstrap ticket and flushes the checkpoint before spawn; the launch deadline is taken there and cold admission starts after launch readiness. Recovery path keeps upstream's source-attachment deadline cap, evaluated after launch. Upstream's Stop-through-staging (`pendingSignal` / `cancelledBeforeDispatch`) coexists with `launchReady` / `cancelPendingLaunch`; cancel-before-dispatch also rejects `launchReady`. Profile 54 refresh dropped. | `c81b686a5` |
| `4ee750506` | test the preconfigured SSH account home | **Adapted.** Kept upstream's probe cleanup budget; doc section appended at the end of `doc/DEVELOPING.md`. Profile 55 refresh dropped. | `1b02795b4` |
| `ccce203d5` | narrow the remote setup target before transport access | Clean. | `1a668503a` |
| `7b84dd8fe` | build: publish UI-only updates on the verified runtime | Clean. Note: `Dockerfile.ui-update` pins the old `ccce203` Core and is not usable for this full Core+runner update. | `ecabad4d1` |
| `5acf56d46` | fix(ui): honor status filters in nested task context | **Adapted.** Upstream added the `routineTasksOnly` condition to the same expression; the status argument and memo dependency were added to upstream's version in both list components. Upstream's routine-task test kept next to the fork test. | `29291b036` |
| `1cc1c8ddf` | ci: allow UI-only builds | Clean. | `ab39c90d4` |
| `856c352c1` | build: restore catalog validation inputs in UI build stage | Clean; all copied paths still exist upstream. | `078ffb107` |
| `f5abebf39` | build: include UI typecheck golden fixture dependencies | Clean. | `24411ccb5` |
| `7077e9007` | Merge upstream 75fcb0b | Not replayed. Its resolutions (trusted-host flag in `threadParams`, trusted-host check next to the plugin-task guard) are reproduced in `948def39d`. Its Copilot profile 59 and `-stefan-identity` fixtures are obsolete (see `13ec080e7`). | — |
| `dbafe6d8e` | record SSH termination after confirmed native runner close | **Adapted.** Upstream added `retireController` to `releaseRunnerProcessOwnership`; the stop receipt callback is still published only after release, retirement, checkpoint and confirmed process exit. Upstream has no equivalent receipt (no upstream change to `remote-execution-termination.ts` / `agent-execution-stop.ts` since `75fcb0b`). | `dacf47e03` |
| `cb6476ee1` | Bind merged runner identity to SSH stop receipt callback | **Dropped.** Profile-59 digest refresh only. | — |
| `c58f91294` | preserve confirmed SSH stop across late lease finalization | Adapted (import line moved upstream). | `c1515199c` |
| `7aeb415d6` | bind SSH stop proof to the current database lease | Clean (doc appended). | `d657fef92` |
| `5d6e247b1` | let authenticated gateway runs hand tasks to humans | Clean. | `fce6755c3` |
| `99f37a275` | kubernetes: initialize sandbox workspace before setup sync | Clean. | `0fb472f29` |
| `3b09f5ccf` | kubernetes: attest sandbox termination after observed cleanup | Clean. | `8d57abd29` |
| `737740b8b` | kubernetes: wait for sandbox startup before short commands | Clean. | `f611e5d03` |
| `530957530` | observer agent boundary and persistent Kata home | **Adapted.** Upstream now mounts `connectionEventWakeRoutes` directly after the Cloud control middleware; the observer boundary is placed before it, so observers cannot reach that route either. | `a966723e5` |
| `84f0d603a` | settle shared workspace failures and stale routine owners | **Adapted.** Upstream independently added a "settled bootstrap failure with no provider work" exemption (`noWorkFailures`) in the same function. Both exemptions are combined; upstream's tests kept next to the fork's. | `a6c0b269c` |
| `da248c1ff` | native SSH cleanup scope and task directory continuations | **Partly.** SSH cleanup scope kept. Repository-free task-directory continuation (`isStoredIsolatedTaskDirectory`) dropped: upstream #17878 (`ac22b1b1f`) now binds retained task directories via `isBoundIsolatedTaskDirectory` / `reuseTaskDirectory`. | `1b229cade` |
| `8c4531520` | test: complete mocked provider after inspecting remote cleanup scope | Clean. | `2f1f05a88` |
| merges `41ad71d14`, `d3ba1a017`, `4b8a67aa6`, `b35679129`, `9f4755d70` | PR merges #7–#11 | Not replayed (no content of their own). | — |

### Optional upstream Hermes fixes (both still open upstream)

| Upstream PR | Change | Decision | New commit |
| --- | --- | --- | --- |
| #18434 (`34006a790`) | Accept Hermes `local-<64 hex>` session ids so `hermes_local` runs resume | Included; small regex change plus tests. | `8a08cf80b` |
| #18528 (`361ea4f33`, `35a00ac85`) | Do not resend Hermes creation flags on `--resume` | Included. | `7c2ff4fd6`, `fc9b60b59` |

Both only affect `hermes_local`. Production currently has no `hermes_local`
agent (Uncensor uses `hermes_gateway`), so they are inactive until such an agent
exists. They are kept as separate commits so they can be reverted alone if
upstream merges a different version.

### New commits in this update

| Commit | Change |
| --- | --- |
| `8447e1e44` | test(ui): the re-applied nested status filter test mocked the old single `parentId` child read; upstream #17756 batches hierarchy reads through `parentIds`. Test-only. |
| `b3de43884` | fix(ssh): fail fast with a bounded error on unreadable workspace uploads, handle `EPIPE`, remove the partial per-run copy (live problem b). |
| docs commit | `UPDATE_REPORT.md`, `doc/deployment-fork.md` update. |

## Live problem (a): CTO stuck in `pausing`

_Investigation in progress at the time of the first push; this section is updated
before the final report._

## Live problem (b): `claude_local` over SSH uploads the server-side cwd

Investigation was read-only (API `GET` only, `ps`/`find` on VM202, nothing on VM203).

**Failing run.** `9c1b8864-4be6-45b1-ae4b-58ddc8857d4b` (CTO, STE-577,
22:05:53–22:10:02 UTC). Workspace `project_primary`
`/home/hermes/projects/homelab`, realization `mode=copy` to
`stefan@agents.tailea77a9.ts.net:/home/stefan/projects`. The run error was
393 lines / 43,477 characters: 391 ×
`tar: ./agents/skills/...: Cannot readlink: Operation not permitted`, then
`tar: .: file changed as we read it`, after 128 MB had been streamed.

**Root cause (environment).** Inside the Core container on VM203,
`/home/hermes/projects/homelab` and `/home/hermes/projects/sovenli-video-projects`
are read-only `fuse.sshfs` views of VM202 (`homelab/modules/paperclip-production.nix`,
`readOnlyWorkerView`, added for Core-side `local_path` validation only). The
Production closure ships sshfs 3.7.6, which enables `contain_symlinks` by default:
`readlink()` returns `EPERM` for every symlink whose target is absolute or contains
`..`. homelab has exactly 391 such symlinks (all `..`-relative) — 391/391 match.
Reading the same links through VM202's SFTP server works, so the server side is fine.

**Root cause (code path).** The legacy (non-native) `claude_local` SSH lane treats
the Core-side cwd as the source of truth: `prepareRemoteManagedRuntime` →
`prepareWorkspaceForSshExecution` → `syncDirectoryToSsh` runs
`tar -C <cwd> -cf - .` (excluding only `._*`, `.git`, `.paperclip-runtime`) into
`/home/stefan/projects/.paperclip-runtime/runs/<runId>/workspace` on VM202. The cwd
precedence is project primary workspace → saved task-session cwd →
`adapterConfig.cwd`, so tonight's per-role `paperclip-claude-cwd/<role>` cwd does
not apply to project tasks. Sessions created while the agents' cwd was
`/home/hermes/projects` keep that cwd and upload the whole controller workspace
including both SSHFS views. The code is identical in the fork and upstream master
`1a6017d`; upstream has not fixed it.

**`INSTRUCTION_COLLECTION_UNAVAILABLE` is a consequence.** The instruction working
copy is registered before the adapter starts; the adapter fails during the
workspace upload, so no Claude process ever ran and nothing could be collected.
At lease release the copy is marked `unavailable` ("No instruction save is
claimed"). No instruction edits were lost.

**Even with readable symlinks this lane cannot work for these projects**: after the
run, the restore writes back into the Core-side directory, which is the read-only
SSHFS view (`EROFS`). Remounting with `no_contain_symlinks` would only move the
failure to after a full agent turn.

**Still happening at 00:37 CET (observed, not acted on):** Claude Engineer
`87401d62` has failed 10 homelab runs the same way (15–20 min each) and had 4 more
running; run `d3be9875` was uploading the whole `/home/hermes/projects` (2.9 GB so
far); CEO run `85f52ff9` was uploading the 4 GB sovenli project. Failed runs left
about 6.1 GB under `/home/stefan/projects/.paperclip-runtime/runs` on VM202.
A push notification was sent; no run was cancelled.

### Fix on this branch: `b3de43884` (fix(ssh): stop unreadable workspace uploads early …)

- Stop tar and ssh at the first entry tar cannot archive (`Cannot readlink|open|stat`,
  `Read error`, bsdtar `Couldn't`/`Can't`). Such an archive always fails; there is
  no point streaming the rest of the tree.
- Replace raw tar stderr with a grouped, bounded summary plus a hint naming the
  SSHFS `contain_symlinks` cause (production error: 43,477 → about 800 characters).
  When ssh failed, its exit code and stderr are appended.
- Ignore `EPIPE` on ssh stdin. Found while testing the early stop: killing ssh made
  the still-running tar pipe raise an unhandled stream error (an uncaught error in
  Core). Exit statuses already carry the outcome.
- Remove `.paperclip-runtime/runs/<runId>` on the SSH host when the workspace upload
  fails (the agent never started there; copies otherwise accumulate).

Tests: new `ssh-tar-diagnostics.test.ts` (4) with a real tar and a mode-000 file,
new failed-upload cleanup case in `remote-managed-runtime.test.ts`; 12/12 pass three
times in a row with no unhandled errors; `adapter-utils` `tsc --noEmit` clean.
Not tested against a real SSHFS `contain_symlinks` mount.

**What this does not fix:** project workspaces that only exist on Core as read-only
SSHFS views remain unusable for copy-mode `claude_local`. The real fix is in-place
execution on the SSH host (follow-up below).

### Operational workaround without a deploy (recommendation, not executed)

1. Pause Claude Engineer or move its homelab-project tasks
   (STE-352/375/131/246/347) to a native `paperclip_runner` agent (executes in place
   on VM202); each retry can only fail the same way. Cancel `d3be9875` and
   `85f52ff9` if still running.
2. After those runs are terminal, delete their per-run copies under
   `/home/stefan/projects/.paperclip-runtime/runs/<run id>`; never touch a running
   run's directory.
3. For `claude_local` agents, use tasks **without** a project workspace, reset task
   sessions whose saved cwd is `/home/hermes/projects`, and name the real VM202
   checkout (e.g. `/home/stefan/projects/homelab`) in the task. Claude runs on VM202
   as `stefan` and can work there directly.
4. Optional host change (VM203, separate approval): `no_contain_symlinks` on
   `readOnlyWorkerView` fixes Core-side previews of skill symlinks, not the copy lane.

### Follow-up (not in this branch)

In-place SSH execution for `claude_local`, mirroring `codex_local`
(`workspaceRealization.mode === "in_place"` → `syncWorkspace: false`,
`workspaceRemoteDir = authoritativeRoot`), plus an SSH environment option that makes
the SSH driver emit `in_place` with an explicit Core-path → host-path alias
(`/home/hermes/projects` → `/home/stefan/projects`). This touches the SSH driver,
the run orchestrator and the adapter, and changes write semantics (agents edit the
host checkout directly), so it needs its own reviewed change and live test.

## Upstream database migrations included

Production runs Core `da248c1ff` (read-only `GET /api/health`, process started
2026-11-01 19:09 UTC), whose newest migration is `0376`. This branch adds the
46 upstream migrations `0377`–`0422`. The fork itself adds no migration and does
not touch `packages/db`. Migrations run automatically when the new Core boots,
so **deploying the image is the migration step**.

| Kind | Migrations |
| --- | --- |
| New tables (empty) | 0394 `native_runner_checkpoints`, 0404 `user_workspace_preferences`, 0405 `issue_thread_interaction_idempotency_keys`, 0415 `skill_package_deletions`, 0417 `company_skill_mutation_receipts`, 0418 `sandbox_creation_operations`, 0421 `execution_workspace_snapshots`, 0422 `agent_file_roots` |
| New nullable columns | 0379 `projects.git_authorization_*`, 0380 `tool_mcp_gateway_tokens.responsible_user_id`, 0396 `chat_voice_inbound_calls.*cleanup*`, 0415 `company_skill_repository_snapshots.*`, 0420 `status_cards.next_eval_reason` |
| Indexes only | 0381–0393, 0395, 0397–0403, 0406–0414, 0416 (drops and recreates `heartbeat_runs_cancelled_workspace_preservation_idx` with a narrower predicate) |
| Functions / triggers | 0378 environment skill runtime hooks, 0415 skill package deletion receipts |
| **Data changes** | **0377** clears `process_pid/process_group_id/process_started_at` on native runs that finished more than a day ago **and** whose every lease carries a valid `paperclip.remote-termination.v1` stop receipt. **0396** backfills `cleanup_confirmed_at` for ended voice calls (batched). **0419** inserts `issue_read_states` for agent comments in conversation tasks (`ON CONFLICT DO NOTHING`), then promotes a new unique index to a constraint. |
| **Can fail on existing data** | **0419** `CREATE UNIQUE INDEX CONCURRENTLY issue_comments_agent_client_request_uq ON issue_comments (issue_id, author_agent_id, client_request_id)` fails if production already has duplicate non-null triples. Run the preflight query below first. |

No migration drops a table or column, changes a column type or rewrites
historic task content. `0377` interacts with this fork's SSH stop receipts:
runs whose SSH lease received an `authenticated_runner_close` receipt and are
older than one day lose their stale process identity, which is the intended
effect (it frees the "process may still be alive" fence).

### Backup and rollback plan

1. Before deploying: drain, then take a fresh native dump exactly as on
   2026-10-21/23 into
   `/srv/production-data/paperclip/migration-backups/fork-<newsha>-<date>`
   (the instance's own daily export is 13 h old and not enough). Restore it into
   a scratch database and compare all table counts; keep the private
   configuration archive next to it.
2. Keep the current image `sha256:e1d43136…af4f0`
   (`local/paperclip:da248c1-native-ssh`) and `apps/paperclip/build.json` at
   Homelab `main` untouched until acceptance passes.
3. Rollback after migrations ran: stop Core through Dockhand, restore the dump
   taken in step 1 into the stack's PostgreSQL, redeploy the previous image
   digest. **An image-only downgrade is not supported**: `da248c1` does not know
   tables/constraints `0377`–`0422`, and Drizzle has no down migrations.
4. Rollback before migrations ran (new Core failed to boot before migrating):
   redeploy the previous image; no restore needed. Verify with the migration
   journal (`drizzle.__drizzle_migrations` row count).

### Preflight (read-only, run on Production before deploying)

```sql
-- must return 0 rows, otherwise 0419 fails
SELECT issue_id, author_agent_id, client_request_id, count(*)
FROM issue_comments
WHERE client_request_id IS NOT NULL
GROUP BY 1, 2, 3 HAVING count(*) > 1;

-- journal: 375 entries up to 0376 before, 421 up to 0422 after
SELECT count(*), max(created_at) FROM drizzle.__drizzle_migrations;
```

## Deployment steps for approval (not executed)

Nothing below has been run. Production, VM203, the database and the agent
configuration were not changed.

1. **Wait** until the overnight hair dryer experiments and all other runs are
   finished. Enable task drain; confirm no active or queued runs.
2. **Recover the CTO first** (see the CTO section): its `pausing` state is
   unrelated to the image and should be resolved before the cutover, so the
   upgrade does not start with an unproven native session.
3. **Preflight** queries above; **backup** as described.
4. **CI**: wait for this PR's checks. Review the report; merge only after approval.
   Merging pushes `deploy/stefan-production`, which runs the
   `Stefan production image` workflow: it builds Core + Linux runner and the
   Darwin arm64 runner from the same commit and publishes
   `ghcr.io/ugoi/paperclip:stefan-<sha>`. It does not deploy.
   Alternatively build locally with the Homelab recipe in
   `apps/paperclip/` (`Dockerfile.core-build`, `Dockerfile.core-artifact`,
   `Dockerfile.runtime-access`) as for `da248c1`.
5. **Verify artifacts**: image source stamp = merge commit, Linux and Darwin
   `paperclip-runnerd` hashes in both package/vendor locations, UI build
   revision, default entrypoint cold start against a disposable PostgreSQL 18
   (this also exercises all 46 migrations on an empty schema).
6. **Homelab change** (separate reviewed commit): `apps/paperclip/compose.yaml`
   image id, `build.json` (source/upstream commits, runner hashes; Copilot
   profile fields are obsolete because upstream no longer binds source into
   profiles), and — only if a native `paperclip_runner` worker is still used on
   VM202 (communication worker) — the fixed runner pin in
   `modules/paperclip-runner-artifact.nix` plus a scoped `nixos-rebuild`.
   All production agents now use `claude_local`, so the Mac native runner is
   only needed if MacBook Codex is switched back.
7. **Deploy** through Dockhand stack 55 (Core only; PostgreSQL stays). Watch the
   boot log until migrations `0377`–`0422` are applied and
   `startupRecovery.phase` is `ready`.
8. **Acceptance**: `/api/health` commit, fresh browser login + WebSocket, three
   attachment downloads with matching SHA-256, unchanged agent/environment
   configuration, one bounded `claude_local` run per SSH environment (Linux
   `agents`), cancellation of a running task with confirmed process exit, the
   nested status filter, and an observer-agent 403 probe. Then disable drain.

## Tests and checks

VM202 ran the checks while the overnight experiments were executing (load average
60–77 on 12 cores); all local checks ran with `nice 19`. Many upstream tests with
5–15 s timeouts timed out for that reason; each timeout below was checked for a
real assertion failure. Rust is not installed on VM202, so the Rust build, Rust
tests and every TypeScript test that needs `runner/target/debug/paperclip-runnerd`
are covered only by the GitHub CI of this PR.

| Check | Result |
| --- | --- |
| Runner `typecheck:typescript` (incl. `check:acpx-profiles`, protocol/schema checks, both tsconfigs) | **pass** |
| Server `tsc --noEmit` | SERVER_TSC |
| UI typecheck | UI_TC |
| Hermes adapter typecheck / Kubernetes plugin typecheck | **pass** / **pass** |
| `adapter-utils` `tsc --noEmit` | **pass** |
| Hermes `execute.resume-args.test.ts` | **1/1 pass** |
| Kubernetes plugin unit tests (standalone install) | **214/216**; the 2 failures are upstream `file-sync.test.ts` 5 s timeouts (one streams >100 MB); all fork-touched files pass |
| adapter-utils `ssh-tar-diagnostics` + `remote-managed-runtime` | **12/12**, three consecutive runs, no unhandled errors |
| UI `IssuesList.test.tsx` + `issue-hierarchy-context.test.ts` | UI_TESTS |
| Runner: native-execution, codex security/context, launch readiness, provider launch, native-session-runtime | RUNNER_TESTS |
| Server: observer boundary, provider config, Hermes session id, native input, preconfigured home, launch prerequisite, process cleanup/probe, recovery diagnostics, setup readiness | SERVER_SMALL |
| Server DB suites (embedded PostgreSQL): SSH termination receipt, task workspace binding, routines, issue mutation ownership, heartbeat workspace session | SERVER_DB |
| Server `native-session-executor.test.ts` | SERVER_EXEC |
| Runner `runnerd-codex-transport.test.ts` | RUNNER_TRANSPORT |
| GitHub CI on this PR | see PR checks (CI_STATUS) |

## Risks

1. **Size of the upstream jump.** 539 upstream commits, most of them in the native
   runtime, recovery and workspace code that the fork also patches. Conflict
   resolutions were made by reading both sides; they are listed per commit above.
   The highest-risk resolutions are in `native-session-executor.ts`
   (launcher cancellation/readiness), `runnerd-codex-transport.ts` (admission
   deadlines) and `remote-runner-recovery-diagnostics.ts` (Darwin dispatch in front
   of upstream's Linux check). The Mac native worker path has no local test on real
   Darwin in this preparation; the Darwin probe script itself is unchanged.
2. **Migrations are one-way.** 46 migrations, including three data backfills and a
   new unique constraint on `issue_comments` that fails on duplicates. Rollback
   after boot requires the database restore; an image-only downgrade is not safe.
3. **Rust and native artifacts unverified locally.** No cargo on VM202; Rust build,
   Rust tests and binary-dependent TypeScript tests depend on this PR's CI and on
   the image workflow. Native artifact hashes must be recorded after the build.
4. **Local test signal is weak** because of machine load (timeouts). Treat the PR's
   GitHub CI as the authoritative regression signal.
5. **Hermes PRs are unmerged upstream.** If upstream merges different versions, the
   next update must drop `8a08cf80b`, `7c2ff4fd6`, `fc9b60b59`.
6. **`claude_local` project tasks on SSH stay broken until the in-place follow-up**;
   the branch only makes the failure fast, readable and non-leaking.
7. **Behaviour changes users may notice:** upstream changes since 2026-10-23 (UI,
   chat, decisions, skills, voice, tool gateway) are all included; this report does
   not re-verify every upstream feature. Copilot profile fields in Homelab
   `build.json` become obsolete.
8. **Workflow trigger on merge.** Merging publishes an image candidate to GHCR
   immediately (no deploy). Make sure that is wanted when merging.
