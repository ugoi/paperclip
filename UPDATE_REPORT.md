# Upstream update 2026-11-01: `update/upstream-20261101`

**Status: prepared, not deployed.** Do not merge before Stefan approves. Merging
pushes `deploy/stefan-production`, which would start the `Stefan production image`
workflow (it builds and publishes an image candidate; it does not deploy) — but
GitHub Actions currently starts no runs in this fork (see Tests).
Nothing was deployed or restarted, no migration was run, and no production
configuration was changed. Production reads used `GET` only.

| | |
| --- | --- |
| Upstream base | `paperclipai/paperclip` master `1a6017d6460267ad89d7e1784e2b521c28d8e9ac` (2026-11-01) |
| Previous fork | `deploy/stefan-production` `8c4531520` (production runs `da248c1ff`, runtime-identical) |
| Previous upstream | `75fcb0b3fca427774cff8f4f7ed43de9ab7f626b` (2026-10-23), 539 upstream commits ago |
| Method | New branch from upstream master; fork commits re-applied one by one with `cherry-pick -x` |
| Result | 21 fork commits re-applied (8 adapted, 2 partly, 11 clean); 2 dropped (#17073, profile-only `cb6476ee1`) plus 2 merge commits not replayed, 3 upstream Hermes commits added, 2 fixes for tonight's live problems, 1 CI workflow, 6 integration fixes found by the checks (1 product, 5 test) |
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
- **Live problem (a), CTO stuck in `pausing`:** two historical cancelled runs can
  never produce the stop proof the pause gate demands (an SSH lease without a
  termination receipt from 2026-10-23, and tonight's `claude_local` retry cancelled
  before it entered the adapter). Not caused by the host rename. Guarded SQL
  recovery prepared for approval; the branch adds an audited operator attestation
  endpoint, a stop-blocker view and a receipt for pre-adapter cancellations.
- **CI:** GitHub Actions does not start any run in the fork since 2026-10-22; all
  test results are local (Linux VM202 under heavy load, plus a clean macOS run).

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
| `8447e1e44` | test(ui): the re-applied nested status filter test mocked the old single `parentId` child read; upstream #17756 batches hierarchy reads through `parentIds`. Test only. |
| `b3de43884` | fix(ssh): fail fast with a bounded error on unreadable workspace uploads, handle `EPIPE`, remove the partial per-run copy (live problem b). |
| `76ef882bd` | docs: this report and `doc/deployment-fork.md`. |
| `b6184395a` | `-s ours` merge of the old `deploy/stefan-production` (`8c4531520`): records it as an ancestor so the PR merges without conflicts; takes no content (tree verified unchanged). |
| `2a8cb3364` | ci: `Stefan fork PR` workflow on GitHub-hosted runners (upstream `pr.yml` only runs on upstream's AWS runners). |
| `4427c8eeb` | fix(lifecycle): stop-blocker inspection, legacy pre-adapter stop receipt, audited operator stop attestation (live problem a). |
| `120268c9a` | test: duplicate `environmentLeases` import from re-applying `da248c1ff` broke the executor test file. |
| `757382cf0` | fix(native): missing import of `REMOTE_RECOVERY_PROCESS_FINGERPRINT_CHECK_SCRIPT` in the re-applied signal path (found by server `tsc`). |
| `9a07785c4` | test(native): upstream launcher tests taught about the fork's process-probe prerequisite and upstream's Node runner-id match. |
| `3a3b41ba3` | test(native): upstream's fake-`/proc` exit-receipt test answers the fork's prerequisite probe (failed on Linux only). |
| `d589ff555` | test(native): keep the fork's prerequisite probes out of upstream's 5 s health-outage window (Linux timing under load). |
| final docs commit | report update with final results. |

## Live problem (a): CTO stuck in `pausing`

Investigation was read-only (API `GET`, `ps`/`who -b` on VM202). Re-checked at
01:35 CET: CTO `5dfad677-bc96-4750-97c8-87f29317010f` is `status=paused`,
`lifecycleState=pausing`, `lifecycleHolds=[]`, `lifecycleVersion=6`,
`lifecycleError=null`, `pausedAt=2026-11-01T22:10:41Z`.

**Why it never completes.** The lifecycle worker completes `pausing` only when
`stopInvocationsForAgents()` → `agentExecutionsHaveStopped()`
(`server/src/services/agent-execution-stop.ts`, identical in fork and upstream)
finds stop proof for **every cancelled run in the agent's history** (651 runs). A
"pending" host step is deferred by 2 s with no error, no attempt cap and no
timeout — it fails closed by design, silently. Two runs can never produce proof:

| | Run | Why it blocks |
| --- | --- | --- |
| A | `291cd527-78cf-42ac-b685-3a6004674880` (2026-10-23, native `paperclip_runner`, cancelled `issue_reassigned`) | Its SSH lease `28c3f2d6-af6a-4f1d-bb0d-fdb7d649fe3a` on the old environment `2a7e5bc1` is `expired`, `cleanupStatus=null`, no `remoteExecutionTermination` receipt. Only a live native Runner close writes that receipt; expired leases are never retried. Blocking since 2026-10-23 21:21 UTC; tonight was the first pause since. |
| B | `dfeeb9a3-8404-445b-a627-d5cd0f505cb8` (tonight, legacy `claude_local`, automatic retry of failed `9c1b8864`) | The pause cancelled it during startup: no lease, no PID, no `adapter.invoke`, `executionStage=settled`. For a PID-less legacy run the gate needs `executionCancellation.state=acknowledged` or a non-conversation adapter; `claude_local` is a conversation adapter, so no proof path exists. |

**The Tailscale rename is not the cause:** no stop path for these runs contacts a
host. `agent-services` and `agents` are the same machine (same pinned host key).

**Latent, same mechanism (not blocking yet):**

- Every Stop/cancel of a *running* `claude_local` run over SSH leaves an SSH lease
  without a receipt (the SSH driver never writes one), so that agent's next pause
  or terminate will hang the same way. Affects CEO, QA, Claude Engineer and the
  Foehn agents.
- CEO `d99bcd35` has lease `9d0a42ce-9928-4492-8320-78be0459bc4b` (env `2a7e5bc1`)
  in `pending_cleanup` / `cleanupStatus=failed` against the unreachable old host.
  **Do not pause or terminate the CEO** until that lease is repaired.
- Do not delete environment `2a7e5bc1`: leases keep their history with
  `environment_id=NULL`, and the blockers stay.

### Safe recovery today (needs approval; not executed)

Evidence (read-only): VM202 booted 2026-10-25 21:56 CET, after run A ended
(2026-10-23 21:21:53 UTC); no process for `291cd527`, `dfeeb9a3` or `9c1b8864`
exists; run B never got a runtime directory. This mirrors the STE-334 recovery of
2026-10-23 (run `cfba53cc` acknowledged by SQL, CTO resumed).

1. Decide the end state. Holds are empty, so once the stop completes the CTO goes
   `resuming` → `ready` and picks up queued work. To keep it paused, call
   `POST /api/agents/5dfad677-bc96-4750-97c8-87f29317010f/pause` first.
2. On VM203 as the database owner, in a maintenance window, run the read-only
   diagnostic query from `cto-pausing-investigation.md` §5 (it mirrors the stop
   gate). Expected: exactly one `remote_termination_unconfirmed` row (A) and one
   `legacy_stop_unconfirmed` row (B). Anything else: stop and re-assess.
3. One guarded transaction (each `UPDATE` must report `UPDATE 1`, re-run the
   diagnostic inside the transaction, expect 0 rows, else `ROLLBACK`):

   ```sql
   BEGIN;
   SELECT id, lifecycle_state, lifecycle_holds, lifecycle_version
     FROM agents WHERE id = '5dfad677-bc96-4750-97c8-87f29317010f' FOR UPDATE;

   UPDATE environment_leases
      SET cleanup_status = 'success',
          metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('remoteExecutionTermination', jsonb_build_object(
            'schema', 'paperclip.remote-termination.v1',
            'companyId', company_id::text, 'runId', heartbeat_run_id::text, 'leaseId', id::text,
            'provider', provider, 'providerLeaseId', provider_lease_id, 'state', 'stopped',
            'confirmedAt', now(), 'proof', 'operator_verified_host_reboot',
            'verification', 'VM202 (= agent-services, same host key) booted 2026-10-25T20:56Z, after run end 2026-10-23T21:21:53Z',
            'recoveryTask', 'cto-pausing-2026-11-01')),
          updated_at = now()
    WHERE id = '28c3f2d6-af6a-4f1d-bb0d-fdb7d649fe3a'
      AND heartbeat_run_id = '291cd527-78cf-42ac-b685-3a6004674880'
      AND provider = 'ssh' AND status = 'expired' AND released_at IS NOT NULL
      AND cleanup_status IS NULL AND metadata->'remoteExecutionTermination' IS NULL;

   UPDATE heartbeat_runs
      SET result_json = coalesce(result_json, '{}'::jsonb) || jsonb_build_object('executionCancellation', jsonb_build_object(
            'state', 'acknowledged', 'acknowledgedAt', now(), 'proof', 'operator_verified_no_adapter_entry',
            'verification', 'Pause cancelled the run during startup: no environment lease, no process identity, no adapter.invoke event; executor settled 2026-11-01T22:12:43Z',
            'originalWorkerAcknowledgmentMissing', true, 'recoveryTask', 'cto-pausing-2026-11-01')),
          updated_at = now()
    WHERE id = 'dfeeb9a3-8404-445b-a627-d5cd0f505cb8'
      AND agent_id = '5dfad677-bc96-4750-97c8-87f29317010f'
      AND status = 'cancelled' AND runtime_mode = 'legacy' AND execution_stage = 'settled'
      AND process_pid IS NULL AND process_group_id IS NULL AND process_started_at IS NULL
      AND result_json->'executionCancellation' IS NULL
      AND NOT EXISTS (SELECT 1 FROM environment_leases WHERE heartbeat_run_id = 'dfeeb9a3-8404-445b-a627-d5cd0f505cb8')
      AND NOT EXISTS (SELECT 1 FROM heartbeat_run_events WHERE run_id = 'dfeeb9a3-8404-445b-a627-d5cd0f505cb8'
                        AND event_type = 'adapter.invoke');
   COMMIT;
   ```

4. Wake the worker: `POST /api/agents/5dfad677-bc96-4750-97c8-87f29317010f/lifecycle/retry`
   (or wait 2–10 minutes). Expect `lifecycleState=ready` (version 8) or `paused`
   if step 1 re-paused. If it is still `pausing` after ~10 minutes the remaining
   blocker is in-memory in Core; only a Core restart clears that — not while the
   experiments run.
5. Undo, if ever needed: remove `metadata->'remoteExecutionTermination'` /
   `result_json->'executionCancellation'` and reset `cleanup_status` to `NULL`.

Not recommended: setting `agents.lifecycle_state` directly (skips wakeup
cancellation and leaves both gaps), deleting environment `2a7e5bc1`, or a Core
restart alone (creates no evidence).

### Fix on this branch: `4427c8eeb` (fix(lifecycle): let operators settle unprovable stops …)

- `inspectAgentExecutionStop()` returns the blocking runs/leases with a reason;
  `agentExecutionsHaveStopped()` keeps its semantics on top of it.
- The heartbeat executor records `legacyStartupSettledAt` on a cancelled legacy run
  that never entered the adapter (no lease, no PID, no `adapter.invoke`) — this
  prevents case B in future.
- `POST /api/agents/:id/lifecycle/attest-stopped` (board + **instance admin**, body
  `{runIds, confirm: "processes_stopped", note}`, audited as
  `agent.execution_stop_attested`) records an operator stop attestation on exact
  cancelled runs while the agent is pausing/terminating. It requires settled lease
  cleanup, never overrides a live local PID or controller lease, and is not a
  provider receipt (grants no continuation or reconstruction authority).
- `GET /api/agents/:id/lifecycle/stop-blockers` shows why a stop is pending.

After deployment the CTO recovery becomes, without SQL:
`GET …/lifecycle/stop-blockers`, then
`POST …/lifecycle/attest-stopped {"runIds":["291cd527-78cf-42ac-b685-3a6004674880","dfeeb9a3-8404-445b-a627-d5cd0f505cb8"],"confirm":"processes_stopped","note":"VM202 rebooted 2026-10-25 after 291cd527; dfeeb9a3 never entered the adapter"}`.
The CEO lease `9d0a42ce` still needs its cleanup settled first (the endpoint
deliberately refuses unsettled leases).

Tests: 4 new embedded-PostgreSQL cases (`operator-stop-attestation.test.ts`); with
the patch, `agent-lifecycle` `lifecycle.test.ts` (66) + `driver-scope.test.ts` (1)
+ the 4 new = 71/71 passed on upstream master (scratch worktree). Results on this
branch: see the test table. Not covered by tests: the heartbeat executor write
path and the two routes (no route test).

Follow-ups: the SSH driver could write a receipt for legacy runs once the adapter
child exited after a confirmed remote kill (today legacy SSH runs have no receipt
producer at all, so the endpoint is their only way out); show "waiting for stop
proof (run X)" in the UI instead of `lifecycleError=null`; repair CEO lease
`9d0a42ce`.

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
2. **CTO recovery** (see the CTO section) is independent of the image: either
   before the cutover with the guarded SQL, or after deployment with the new
   `attest-stopped` endpoint (no SQL). Do not pause or terminate the CEO until its
   lease `9d0a42ce` on the retired host is settled.
3. **Preflight** queries above; **backup** as described.
4. **CI / build.** GitHub Actions in `ugoi/paperclip` has not started a single
   run since 2026-10-22 11:23 UTC (no runs for PRs #7–#11, for pushes to
   `deploy/stefan-production`, or for this PR, although Actions is enabled and
   GitHub reports no incident). First check *Settings → Actions* and the account's
   Actions status. If it works again, this PR runs `Stefan fork PR` (new, see
   `2a8cb3364`), and merging runs `Stefan production image` (Core + Linux runner +
   Darwin arm64 runner, published to GHCR, no deploy). Otherwise build locally
   with the Homelab recipe in `apps/paperclip/` (`Dockerfile.core-build`,
   `Dockerfile.core-artifact`, `Dockerfile.runtime-access`) exactly as for
   `da248c1`, and build the Darwin runner on the Mac; in that case the Rust
   tests must be run as part of that build. Merge only after approval.
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
   `agents`), the nested status filter, an observer-agent 403 probe, and
   `GET /api/agents/<id>/lifecycle/stop-blockers` for each agent (expect only the
   known historical blockers). Test Stop/cancel only on a disposable agent: a
   cancelled running `claude_local` SSH run cannot produce a stop receipt, so that
   agent's next pause will need an attestation. Then disable drain.

## Tests and checks

**No GitHub CI ran.** GitHub Actions in `ugoi/paperclip` has not started any run
since 2026-10-22 11:23 UTC (none for PRs #7–#11, pushes to the deploy branch, or
this PR), although Actions is enabled, all workflows are `active` and GitHub
reports no incident. In addition, upstream's `pr.yml` now only calls
`paperclipai/paperclip`'s trusted workflow on the upstream AWS runner group, so it
could not run in the fork anyway. This PR therefore adds `Stefan fork PR`
(`2a8cb3364`), which runs the same lanes on GitHub-hosted runners once Actions
starts runs again. All results below are local.

Where: VM202 (`agents`, Linux) ran while the overnight experiments were executing
(load average 60–126 on 12 cores), all with `nice`, so many timing-sensitive
upstream tests timed out there. The same suites were therefore repeated on the
MacBook (macOS arm64, 8 cores, Node 24.21.0, pnpm 9.15.4, Rust 1.97.1 in an
isolated toolchain) from a clean clone of this branch. Every remaining failure was
checked for its cause.

| Check | Where | Result |
| --- | --- | --- |
| Runner `typecheck:typescript` (incl. `check:acpx-profiles`, protocol/schema checks, both tsconfigs) | Linux | **pass** |
| Server `typecheck` (full script: Runner vendor release build, plugin SDK, `tsc --noEmit`) | macOS | **pass** at `9a07785c4` (first run found a missing import → fixed in `757382cf0`) |
| UI `typecheck` | macOS | **pass** (Linux run raced the plugin-SDK build: only `@paperclipai/plugin-sdk/ui` unresolved) |
| Root `pnpm run typecheck` (all workspace packages) | macOS | **pass** (all workspace packages, at `9a07785c4`) |
| Hermes adapter / Kubernetes plugin / `adapter-utils` typecheck | Linux | **pass** / **pass** / **pass** |
| Rust: `cargo test --release --locked --workspace` (= `test:rust`) | macOS | **810 passed, 0 failed**, 3 ignored, 38 suites |
| UI `IssuesList.test.tsx` + `issue-hierarchy-context.test.ts` | macOS | **67/67** (`8447e1e44` fixed the re-applied test for upstream's batched `parentIds` reads) |
| Server DB suites, embedded PostgreSQL: SSH termination receipt, task workspace binding, routines, issue mutation ownership, heartbeat workspace session, operator stop attestation, agent lifecycle (66), driver scope | macOS | **674/674** |
| Server native runtime: observer boundary, provider config, Hermes session id, native input, preconfigured home, launch prerequisite, process cleanup/probe, recovery diagnostics, setup readiness | macOS | **235/237**; the 2 failures are macOS test-environment only (`/var` → `/private/var` realpath, macOS `kill` ESRCH) and passed on Linux |
| Server `native-session-executor.test.ts` | macOS + Linux | macOS **1025/1027** after `120268c9a`, `757382cf0`, `9a07785c4`, `3a3b41ba3`, `d589ff555`; the 2 macOS failures mock Linux `/proc`/`uname` and pass on Linux. Linux, all 55 remote-runner launcher/supervision cases plus the exit-receipt and HTTP-Stop-during-staging cases: **pass**. The upstream gateway health-outage case allows 5 s from launch to the first healthy probe; with the fork's two real prerequisite probes it missed that window twice under load, and passes (4.97 s) once the mock answers the probes (`d589ff555`) |
| Runner: native-execution, codex security/context, provider launch, native-session-runtime | macOS | **pass** (367/369 in the first run; the 2 remaining launch-readiness cases needed the debug `paperclip-runnerd` and pass in the next row) |
| Runner `runnerd-codex-transport.test.ts` + `runner-launch-readiness.test.ts` with a freshly built debug `paperclip-runnerd` | macOS | **330/330** |
| Same Runner transport/readiness files + `codex-security-config.test.ts`, Linux debug `paperclip-runnerd` built with Rust 1.97.1 | Linux | **339/348 not confirmed**: first run 329/348 at load 80–120; a serial rerun of the 19 failures passed 10. The remaining 9 (cold-restore of a suspended session, real OpenCode proxy boundary ×3, event-backlog suspension, setup hello with late remote release, one launch-readiness case, Codex command resolution with `spawnSync … ETIMEDOUT`) fail with timeouts or a quiescence race. The same files pass 330/330 on macOS and the touched transport logic is platform-independent, so this is most likely host load — but it is **not verified on an idle Linux host**; run these before merging. |
| `adapter-utils` `ssh-tar-diagnostics` + `remote-managed-runtime` | Linux | **12/12**, three consecutive runs, no unhandled errors (macOS: 11/12, temp-dir realpath in the expected message) |
| Hermes `execute.resume-args.test.ts` | Linux | **1/1** |
| Kubernetes plugin unit tests (standalone install) | Linux | **214/216**; the 2 failures are upstream `file-sync.test.ts` 5 s timeouts (one streams > 100 MB); all fork-touched files pass |

Real defects found by these checks and fixed on the branch: a missing import in
the re-applied remote launcher signal path (`757382cf0`, would have thrown
`ReferenceError` when signalling a fingerprinted remote runner), a duplicate import
that broke the executor test file (`120268c9a`), stale test mocks after upstream
changes (`8447e1e44`, `9a07785c4`, `3a3b41ba3`, `d589ff555`), and an unhandled `EPIPE` in the new upload
early stop (fixed inside `b3de43884`).

Not run: the complete upstream monorepo suite (12 server shards, chat, workspace
groups, E2E, Storybook), the Docker image build, and the live Linux/Mac
native-runner acceptance (needs the deployed artifacts).

## Risks

1. **Size of the upstream jump.** 539 upstream commits, most of them in the native
   runtime, recovery and workspace code that the fork also patches. Conflict
   resolutions were made by reading both sides; they are listed per commit above.
   The highest-risk resolutions are in `native-session-executor.ts`
   (launcher cancellation/readiness), `runnerd-codex-transport.ts` (admission
   deadlines) and `remote-runner-recovery-diagnostics.ts` (Darwin dispatch in front
   of upstream's Linux check). Rust tests and the server process-probe/executor
   suites ran on macOS, but no live Mac worker run was possible before deployment.
2. **Migrations are one-way.** 46 migrations, including three data backfills and a
   new unique constraint on `issue_comments` that fails on duplicates. Rollback
   after boot requires the database restore; an image-only downgrade is not safe.
3. **No CI signal.** GitHub Actions does not start runs in the fork (since
   2026-10-22). Rust tests passed on macOS arm64 only (Linux Rust tests not run);
   9 Linux Runner transport cases remain unconfirmed under VM202 load (they pass
   on macOS); the full upstream suite has not run. The native Linux and Darwin
   artifacts still have to be built and hash-verified.
4. **Local test signal is partial.** Focused suites for every fork-touched area
   passed (see the table); unrelated upstream suites were not run, and VM202 timed
   out many upstream tests under load. Treat the Docker/default-entrypoint cold
   start against a disposable PostgreSQL (all 46 migrations) and the live
   acceptance as mandatory gates.
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
9. **Stop proof for `claude_local` over SSH.** Until a receipt producer exists for
   legacy SSH runs, every cancelled running `claude_local` SSH run makes that
   agent's next pause/terminate wait for an operator attestation (new endpoint) or
   SQL. The CEO already has an unsettled lease (`9d0a42ce`) on the retired host:
   do not pause or terminate the CEO before that lease is repaired.
