# Exact schedule state restore

Use exact state restore when a larger operation temporarily pauses or resumes a schedule and must
undo that change without moving its deadline.

Call `schedule.state.transition.request` with a caller-generated operation ID, schedule ID, and
target status. The daemon records the schedule's `status`, `pausedAt`, and `nextRunAt` before the
transition and the state it actually wrote. Call `schedule.state.restore.request` with the same
operation ID and schedule ID to restore those three fields.

The operation ID identifies a persisted receipt. It grants no authority. Both RPCs require the existing `schedule/pause` and `schedule/resume` input grants.
Their responses require both corresponding response grants. A receipt cannot be used with another schedule. Repeating a request after a
lost response returns the recorded result without applying the transition again. `replayed` says the
response came from an existing receipt; `isCurrent` says the recorded result still matches the live
schedule.

Restore succeeds only while the schedule is still at the mutation version written by that
operation. Any intervening managed write invalidates ownership, including a change that returns the
visible fields to their previous values. A deleted and recreated schedule ID has a different
generation. The daemon refuses restore instead of overwriting either case. Completed schedules
cannot start a state operation.

The journal writes a prepared receipt before the schedule and marks it applied afterward. A retry
after a process exit reconciles only these cases:

- The schedule still matches `before`: write the recorded `after` state.
- The schedule matches `after`: mark the receipt applied.
- The schedule matches neither: refuse to continue or restore.

Restore uses the same staged write shape. Recovery happens when the operation is retried; daemon
startup does not sweep receipts.

## Scope

Schedule mutations are serialized inside one daemon process. The verified recovery boundary is a
daemon process exit followed by a retry after the prepared or schedule-file rename completed. The
atomic writer uses a temporary file and rename but does not `fsync` the file or parent directory, so
receipt and schedule writes are not guaranteed to survive or retain order across host power loss.

The journal does not fence multiple daemon or external filesystem writers. Do not point two daemons
at one `PASEO_HOME`.

Restore changes only `status`, `pausedAt`, and `nextRunAt`. It does not undo cadence, target, run
history, expiry, or other schedule changes. Those changes invalidate the receipt instead. Operation
receipts are retained so an ID cannot be reused; automatic pruning is not included.
