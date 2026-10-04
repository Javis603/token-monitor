# Current hosted-cloud source investigation

Checked on 2026-10-05 (Asia/Shanghai), starting from `682e624`. This is a source-discovery and live-read investigation, not a completed cloud-token integration. The installed test application and production Token Monitor are unchanged by this investigation.

## New evidence: the modern cloud directory is separate

The installed desktop client retains a `cloud-aeon-sidebar-cache-v1` object in its persisted state. Its host is `durable`, not the local app-server. Only a field-minimized projection was retained for this investigation; conversation text, titles, profile descriptions, account identities and credentials were not exported.

The cached sample contains 28 threads: 24 `aeon_child`, two `subagent`, one `dreaming`, and one `aeon`. All are associated with one `orbit` profile. The cached attachment records provide parent links for 27 threads, whereas native thread metadata exposes `parentThreadId` for only two. A dot/profile attachment relation and an engine spawn relation are therefore not interchangeable. Treating a null engine parent as absence of delegation would lose real relationship information.

This is cached metadata, not a newly authenticated directory response or a complete account inventory. Its account continuity and completeness are unverified. No token counters are present. Some cloud rows use `modelProvider: local` and a machine-like working directory: neither value establishes local execution. The sampled cloud identities were absent from the local `state_5.sqlite` thread catalog.

A separate, account-partitioned `cloud-thread-prototype-threads-by-account-v1` map also retains actual engine-thread-to-cloud-environment associations. These are metadata pointers, not counters or proof of current access.

## Read-only static corroboration

The installed desktop JavaScript contains separate modern cloud/profile directory and attachment reads. Its legacy `cloudTasks` list instead uses the older `wham` task API. The modern cloud catalog is used to seed the `durable` host's thread summaries only when the client considers its account and user identities current.

This distinction explains why a local catalog or a legacy CLI task list cannot be used to assert that no modern cloud/dot tasks exist. The observed application implementation is not a published stable third-party API contract. Static code does not establish permission to call a service, or that the service returns actual token fields.

The `account/usage/read` service response and active engine token events remain distinct sources; see the [official App Server guide](https://learn.chatgpt.com/docs/app-server) and [dot task model](https://learn.chatgpt.com/docs/dots/tasks-and-memory). Account summaries cannot be allocated to individual cloud tasks by subtraction or guessed proportions.

## Correct cloud IDs still yield unavailable per-thread usage

Using the existing read-only app-server adapter, three real cloud identifiers were queried: a cached `aeon_child`, an explicitly cloud-environment-associated coding thread, and a native cloud subagent. Every successful RPC response had the keys `summary`, `dailyUsageBuckets`, and `threadUsage`, but `threadUsage` was null in all three cases.

Thus the missing values are not resolved merely by replacing the previous local test IDs with cloud IDs. The precise reason for the unavailable billing route or remote usage remains unknown; this result does not prove that no cloud token records exist or that the user's subscription prohibits them. The local app-server is not itself verified as the modern durable engine's transport.

## Blocked cloud read and unchanged safety boundary

One direct authenticated read of the observed modern cloud directory was blocked by the platform tool safety check before execution. It did not reach the service, so there is no HTTP response, authorization verdict or cloud payload to interpret. The operation was not retried through another tool, browser route, executable or delegated agent. No credential was requested from the user.

A separately dispatched static-only analysis task timed out without a final result; it is not counted as completed independent review and was not replayed. It was never delegated a live authenticated service request.

## Saved evidence and acceptance gap

Private field-minimized metadata projections and relationship counts are saved under the existing local task-notes `cloud-bridge` directory, outside the repository. Copied application assets used for static inspection are not committed or distributed. No synthetic counters, profile labels or manually invented task-to-thread joins were substituted for service data.

The remaining gate is an accessible, authorized cloud read/export that provides task/engine identities and actual token events or clearly labeled usage counters. It must allow account/host scope verification and distinguish dot attachment, engine-parent and aggregate coverage. Until that evidence exists, the software must not show a complete cloud total, treat unavailable usage as zero, or add account summaries to local/request totals. No cloud-token bridge is marked complete by this document.
