# Shared workspace recovery and routine execution ownership

A native provider failure wrote `workspace_finalize=failed` for an SSH shared
workspace even after its exact remote owner had stopped. The workspace-selection
guard treated that historical provider error as pending copyback forever.

The guard now accepts this narrow settled case: terminal coordinator with no
accepted result, no finalizer owner or workspace-sync reference, every lease has
a matching durable termination receipt and successful cleanup, and every
realization explicitly has shared-workspace mode with zero outbound restore
paths. Existing failure history remains unchanged. Unknown receipts, pending
exports, accepted output and active ownership still block replacement.

Routine dispatch previously searched only live runs while the database unique
index included stale non-null execution pointers. A subsequent scheduled wake
failed with `issues_open_routine_execution_uq`. Under the existing routine lock,
dispatch now calls the issue service's guarded terminal-owner cleanup before
searching for active work. Queue-first explicit continuation claims remain owned
and coalesce; live owners and independent routine fingerprints are preserved.

Regression coverage uses real PostgreSQL and the existing service entry points.
No database schema, human review policy, UI, provider binaries, or copied
workspace data are changed. This repair establishes safe admission; it does not
claim the interrupted provider command succeeded or that Omi feature tests passed.
