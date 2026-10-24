# CLI startup controller configuration

The CCode entry point loads locked controller content on demand through
`createLockedContentClient`. A strict `locked-content-ready` response provides
version, digest and the SKILL.md body, which the protected SkillPort returns for
the current model context.
There is no model-time acquire/complete, lease expiry or renewal. The transport is
dedicated Node IPC, never normal stdio, renderer RPC, environment or argv. Invalid
responses, disconnect, caller cancellation and a 30-second startup timeout reject
initialization. CLI lifecycle owns disconnect after initialization.

Runtime system builders include the global segment but persistence and diagnostic
events exclude its body. Model request privacy preserves error classification while
removing payloads and request transcripts. It does not guarantee that a model cannot
paraphrase or disclose instructions in its own output.

## Legacy optional execution API

The following exported APIs remain for existing embedders/tests only. The CCode
entry point no longer creates these execution scopes or activates a protected Skill.

Node IPC adapter, never public stdio/RPC. Application owns content cache; this
consumer holds only in-flight calls and temporary callback state. IDs increase for
the connection lifetime; at most eight calls. Strict messages and phase checking.
Consumer callback must buffer/screen all output and perform no visible/persistent
or tool side effect. Only a completed authorization confirmation releases its value.
Before complete, the adapter checks a bounded JSON snapshot against normalized
instruction fragments, including concatenated text/delta fields. The checked clone
is returned so subsequent mutation of the consumer's object cannot bypass screening.
This catches exact fragments, not arbitrary paraphrase or encoded exfiltration.
Cancellation, expiry, malformed frames and disconnect reject pending work and
abort callback signals. Original errors, instruction and model output are not logged.
No physical memory erasure guarantee. Runtime activates only through the protected Skill gate.
Task execution scopes pin both version and digest synchronously on first content
admission, before invoking a consumer. A later mismatch rejects with VERSION_CHANGED,
including equal version numbers with different content. Recovery supplies both version
and digest from the immutable session/run binding. Runtime first uses a no-op consumer,
waits for completed authorization, then saves only version/digest before publishing the
active scope. No model consumer or child receives an unbound scope. Persistence failure
or a stale turn rejects activation. These identifiers never substitute for authorization.
Legacy tests cover phase validation and output screening; startup tests cover the
new bootstrap contract independently.
Protected SkillPort projects only public controller metadata without file paths.
It filters reserved local identities and rejects direct controller loads; activation
is owned by Runtime. Ordinary Skill discovery/load delegates to the supplied port.
