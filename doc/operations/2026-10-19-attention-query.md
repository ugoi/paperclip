# Indexed attention supersession lookup

The attention feed read every newer context snapshot for agents with an old
exhausted run. Selecting `context_snapshot ->> 'issueId'` still decompresses the
stored JSON document. A small set of five old failures triggered a scan over
roughly 1,650 runs and 167 MB of stored run data on the observed instance.
Concurrent dashboard requests then waited for database work.

The feed now checks each failed run with an existence query over the existing
company/issue/time expression indexes. It returns only one run ID. Company,
agent, `issueId` precedence, `taskId` fallback, empty IDs and arbitrary newer
statuses retain their previous meaning. No schema or historical data changes.

PostgreSQL timestamps contain microseconds, while the old JavaScript Date
comparison used milliseconds. The new lower bound is the next millisecond,
so a failed row cannot count as its own successor because its stored timestamp
contains a fractional millisecond.

Validation on 2026-10-19:

- The focused real-PostgreSQL test covers ten identity cases, company/agent
  isolation, equal timestamps and sub-millisecond timestamps. Passed.
- Focused TypeScript checking and compilation of both changed modules passed.
- A read-only comparison of the full old and new attention services returned
  the same six item identities: 11.00 seconds before and 1.05 seconds after.
- The broad attention suite could not import the shared development checkout's
  `@paperclipai/shared/aggregator-apps`. The focused test used the exact installed
  database and ORM packages; no broad-suite success is claimed.
- The pre-change compiled service matches the installed service after syntax
  and whitespace normalization. Deployment changes only the two service files
  and source maps, retaining the managed package and its other runtime files.

The production rollout uses the official `paperclipai service restart`, which
records active-run adoption. Retain the prior module bytes for rollback and
verify the hot-restart report plus actual API/browser latency after activation.


Activation succeeded for the bounded module hotfix. Direct authenticated API
checks returned dashboard in 344 ms and attention in 945 ms; the browser rendered
the dashboard with no JavaScript errors. Concurrent startup/API traffic still
costs several seconds, so these timings are not a full-page latency guarantee.

The Linux service manager's default `KillMode=control-group` interrupted two
existing runs before Paperclip wrote its shutdown snapshot. The built-in recovery
continued both tasks automatically. The empty restart report alone was misleading
because the snapshot was missing; the actual run records revealed `process_lost`.
The host configuration now declares `KillMode=process` to allow the server to
manage its ordered DB/worker shutdown. See `ugoi/homelab` operational record
`docs/service-loading-20261019.md` for precise evidence, rollout and limitations.
