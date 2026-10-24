# Workflow host observation record adapter

`createWorkflowHostObservationAdapter(deps)` owns only the direct record's active
event jobs. `accept(event, forward?)` synchronously establishes a 25 second owner
and cancellation timer before forwarding the complete normal subscription body.
The independent microtask verifies the authoritative stored identity and calls
the gateway's commit port. Hook and subscription join by event id, never run id.

`verifyStored` captures the original direct record, app and event store. It rejects
absent/foreign/duplicate identities and unavailable owners without consulting a
replacement record. `ensureCommit` owns actual commit proof, strict reservation
and permanent per-event failure history; its strictAttempted metadata is copied
without guessing or keeping another attempt cache here.

`dispose()` revokes all owners before aborting jobs. Every job catches failures,
reports one safe terminal outcome, and removes its timer and map entry in finally.
The private controller is cancelled only through the adapter, so the adapter does
not install a redundant abort listener. Gateway owns and removes its own listener.
Late IO is observed but cannot call the gateway after cancellation.
Unknown exceptions are classified by the current phase; arbitrary message,
payload and cause never enter the outcome. A report callback must be synchronous;
its failure is isolated so it cannot strand lifecycle resources.

The gateway's original commit Promise must be returned directly and rejected
synchronously within the abort call stack with authoritative boolean attempt
metadata. The adapter attaches handlers directly to that Promise. Cancellation
first revokes the owner and aborts, then queues one microtask fallback. A compliant
gateway settlement runs first; an unresponsive port still terminates with failure
and `strictAttempted: "unknown"`. Unknown is allowed only on failed outcomes and
means no authoritative attempt metadata was obtained. Verify failures cannot prove
the history of an earlier job, and never imply false. No attempt history is kept
after a job completes. An already settled result consumed after cancellation can
provide attempt metadata but cannot produce a late completed outcome.

The adapter is transport independent: continuous desktop delivery and replayable
mobile repair retain gateway/publisher ownership. This module neither appends
events nor changes journal/run state. Protocol factory wiring and real direct
store verification are completed separately in Task4.
