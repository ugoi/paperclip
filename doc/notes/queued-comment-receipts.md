# Accepted comment revisions and saved interruption intent

STE-151 repairs the legacy queued-comment path. The source baseline is the
installed npm `2026.1007.0-nightly.0`, commit
`03cf6a6ecb0caf5e6f9c4e6af87dc723e5e3bca2`. Both the installed server's
`dist/build-info.json` and the npm provenance identify this commit. No schema
migration, production configuration change, or installed-file modification is
part of this patch.

## Contract

- Wake IDs and a rendered prompt describe scheduling/preparation. They are not
  delivery receipts. The shared ACP executor records the exact rendered comment
  IDs and `updatedAt` revisions after turn-local provider output/tool activity,
  or a successful completed turn. A cancelled turn without that evidence does
  not acknowledge its input. On resume, only the rendered resume delta counts.
- The server validates receipts against the offered snapshot, persists them on
  the receiving run, and removes only matching current revisions from deferred
  queues under the task lock. Edits and unknown inputs remain pending.
- The UI checks receipts before applying local state, timestamp heuristics or
  local target-map entries. It removes consumed map entries individually. A
  local unconfirmed row never removes the authoritative server queue ID.
- Interrupt acknowledges a saved request, not message delivery. Its request is
  bound to queue, comment revisions and original target run. Early queued and
  deferred states are both legal. The existing sweep retries saved intent after
  the original target becomes interruptible; it never acquires stop authority
  over a successor. The existing scheduler/admission/cleanup gates still apply.
- Saved intent is not a permanent authorization grant. Revalidate current board
  policy before claiming Stop and again after cleanup and under admission lock.
  The generic release path cannot promote or fail these requests: only the
  intent dispatcher may consume them. A pause remains retryable. Admission
  adopts only unchanged selected revisions; edited/unselected input remains
  deferred, including when only part of the selection is still valid.
- A repeated older selection cannot erase another saved input on the same target.
  Concurrent requests merge current revisions under the task lock.
- Historical intents without selected revisions cannot certify a later edit.
  Keep their messages visible and the action available for a fresh verifiable
  request; never fabricate a revision during upgrade.
- Edits invalidate the selected revision. If all selected revisions disappear,
  the old intent no longer disables the action for the remaining edited inputs.
  A receipt/discard is rechecked under the task lock before Stop and again at
  admission after asynchronous provider cleanup.
- Reload/closing the browser after acknowledgement does not lose the saved
  intent. Before acknowledgement, UI publication/CAS retries are bounded and
  keep the original target and selected revisions. A real gate conflict is not
  blindly retried. No optimistic hiding of interrupted messages remains.

The receipt callback is an adapter extension point. This patch supplies the
producer in the shared ACP engine (used by this installation's Codex agents)
and at the native executor's committed PRP boundary. Native offered revisions
are frozen alongside the execution input. The full bootstrap and compact continuation have separate offered snapshots.
A receipt must match the durable submitted prompt and its accepted provider turn;
a disposition-only recovery cannot acknowledge the original input. Codex turn.accepted follows
its provider response. ACPX/OpenCode emit accepted before send, so those events
cannot acknowledge input; provider agent output or successful completion is
required. Submission, cancellation, failure and unknown transports do not create
receipts. Duplicate durable events repeat only idempotent receipt reconciliation, closing
the crash window between event append and receipt persistence. Native steering
retains its separate provider acknowledgement path.
Historical browser state is not reconstructed.

## Reproducible checks

Use Node 24 and the committed pnpm lockfile. Install dependencies in an isolated
checkout. The tests use only disposable local instances/databases and fixture
providers. Do not point them at a user task or a shared Paperclip home.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
pnpm --filter @paperclipai/paperclip-runner run build:typescript
pnpm exec vitest run ui/src/api/issues.test.ts ui/src/pages/IssueDetail.test.tsx ui/src/lib/optimistic-issue-comments.test.ts ui/src/lib/issue-queued-comment-queue.test.ts ui/src/components/task-chat/TaskChatQueuedMessages.test.tsx packages/adapter-utils/src/comment-input-receipts.test.ts server/src/services/issue-queued-comment-queue.test.ts
pnpm exec vitest run packages/adapter-utils/src/acpx-engine/execute.test.ts -t 'receipt|accepted|cancelled turn'
pnpm exec vitest run server/src/__tests__/issue-queued-comments-routes.test.ts server/src/__tests__/issue-queued-comments-races.test.ts
pnpm exec vitest run server/src/services/explicit-native-continuation.test.ts
pnpm exec vitest run server/src/modules/wake-queue/application/use-cases.test.ts server/src/services/native-runtime/native-comment-input-receipts.test.ts
pnpm --filter @paperclipai/server exec tsc --noEmit
pnpm --filter @paperclipai/ui exec tsc --noEmit
pnpm --filter @paperclipai/adapter-utils exec tsc --noEmit
pnpm check:token-gates
pnpm --filter @paperclipai/ui build --outDir ../server/ui-dist --emptyOutDir
PAPERCLIP_E2E_PORT=32151 pnpm exec playwright test --config tests/e2e/queued-receipts.config.ts
PAPERCLIP_E2E_PORT=32152 pnpm exec playwright test --config tests/e2e/queued-receipts-restart.config.ts
```

`PAPERCLIP_TEST_BROWSER_EXECUTABLE` may select an existing isolated Chromium
binary. Neither suite uses the personal browser or CDP9222. Run these shards
sequentially on a busy host. They create fresh `paperclip-e2e-home-*` directories,
strip real run credentials, and stop only their own servers. The restart shard
uses a paused fixture agent, confirms saved intent through reload, stops and
starts that test server, then resumes the fixture and checks exact receipts and
one provider completion. The normal shard exercises a live local-map transition
without a reload, followed by another real pending input.

## Managed rollout preparation

The handoff report identifies the final reviewed commit and independent QA.
Source and tests are retained in the local branch and internal Git bundle; do not hotpatch production
`dist` files or silently return to the older local checkout. A managed git
payload pinned to the reviewed commit is the supported source-build path.
The installed baseline CLI omits the UI build before staging a bundled server;
the complete rehearsal exposed an ENOENT for `server/ui-dist`. Use the corrected
CLI built from a disposable checkout of the reviewed commit for the initial
upgrade, rather than invoking the old installed CLI. Build that bootstrap CLI
with Node 24, `pnpm install --frozen-lockfile`, then
`bash scripts/build-npm.sh --skip-checks --skip-typecheck` after the separately
recorded checks have passed. The installer now explicitly prepares the static UI
before copying bundled server files and aborts if the UI build fails. It also
matches `release.sh` by staging the repository runtime skills into the server,
Claude-local and Codex-local packages. Already built bundled packages are packed
with `--ignore-scripts`: their source-relative prepack scripts are unavailable
in staging. This does not suppress lifecycle hooks during the final consumer
installation. Missing runtime skills abort staging rather than silently shipping
an incomplete adapter/server package. The extracted archive must contain a
nonempty regular `skills/paperclip/SKILL.md` before any build runs; an existing
empty skills directory is not sufficient. Rejection preserves the active
payload, manifest, shim and user data, and a corrected archive can be retried.

```sh
PAPERCLIP_BUILD_COMMIT=<reviewed-full-commit> node <disposable-checkout>/cli/dist/index.js install --repo ugoi/paperclip --ref <reviewed-full-commit> --yes
```

This command builds and changes the managed `current` pointer. It is a rollout
command, **not a harmless preview**. The commit must first exist on the stated
remote. The current internal handoff does not establish external publication
permission or remote availability. Do not run it against the real home until
CEO has coordinated active work and accepted the tested payload. First rehearse
it under a disposable home/install store with Node 24, pnpm and the Rust build
toolchain. The complete source installer also rebuilds the unchanged native
runner; the scoped TypeScript checks above do not certify that packaging step.
No production installation or service interruption was performed for this patch.

Before real activation: retain the current npm payload, manifest and a verified
preactivation database backup; record active work; use the existing native drain
and managed service validation path. Do not stop foreign runs. Validate source
SHA, health/startup recovery, served UI fingerprints, and the isolated acceptance
suite before scheduling any real smoke check. Report actual rollout separately
from source verification.

Rollback uses the managed payload history (`paperclipai update --rollback`).
Confirm the previous entry is the retained `2026.1007.0-nightly.0` payload before
executing it. This patch adds JSON fields but no schema changes; rollback ignores
those extra fields, and restores the old product behavior. A payload rollback is
not a database restore. If later packaging introduces migrations, reassess the
backup/restore boundary first. Ordinary updates preserve a full Git-SHA pin,
including when npm-version flags are supplied; the git-pin branch returns before
remote resolution. Deliberately installing another source or changing the pin
requires re-running these regressions. No NixOS change is required by this source patch.
