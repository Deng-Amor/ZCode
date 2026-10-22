# Controller startup configuration

`createControllerApplication` is instantiated once per application. It owns one
startup assembly Promise per authenticated login generation, exposed privately as
`getBootstrap(): Promise<{ version: number; digest: string; systemPrompt: string }>`.
Concurrent initialization shares authorization, download and signature verification.
Failures can be retried. A successful immutable result remains available throughout
that login; download-grant expiry does not limit runtime execution. No periodic
renewal, execution lease, per-model authorization or offline fallback is installed
by the default application composition.

The source authenticates the current identity. The grant binds a controller version
and SHA-256 of signed payload bytes. Assembly checks the deployed trust root,
signature, version, digest, download deadline and UTF-8 Markdown resources. The
verified body remains in memory and is never exposed on renderer/mobile RPC,
logged, persisted in session state, passed through environment variables or written
to installation resources. The verifier and HTTP transport enforce bundle limits.

Identity changes synchronously abort the previous assembly and clear its Promise.
Late results cannot replace the next generation; cancellation of one consumer only
ends that consumer's wait. Initial authentication restoration does not revoke the
consumer that requested it. Logout or account switching emits `invalidated` on each
application channel. Host closes all attached CLI peers and clears their mappings,
but retains its once-transferred Main port so a subsequent login can create peers.
Application disposal closes every transport. The authentication owner alone manages
credentials; ordinary access-token refresh preserves the login generation.

The private channel accepts `{type: "bootstrap", requestId}` and replies once with
`{type: "bootstrap-ready", requestId, version, digest, systemPrompt}`. No `complete`
is required. IDs are positive safe integers increasing strictly per connection.
`cancel` stops a waiting request. Invalid commands close the connection; payloads
and transport errors must not enter logs. The channel bounds pending requests to 8
and application channels to 16. The Host relay bounds peers to 32 and pending calls
to 8, translates peer IDs, validates events, suppresses cancelled responses and
unicasts only to the originating peer. It holds no task state or controller body.

The account-only surface exposes state, tenant listing, login and logout. Access
tokens stay in memory. The optional private session store uses asynchronous IO and
OS encryption for refresh credentials and tenant/user/API-base binding only.
Restore verifies and rotates credentials before success. Explicit rejection clears
credentials; transient failures retain them for retry. Logout deletes credentials;
application disposal clears memory without deleting the saved login. Storage writes
and deletes are serialized and guarded against stale login generations.

HTTP source endpoints are POST relative to the trusted HTTPS API base:
`system/ccode-controller/authorize` receives `{skillId,version?}` and
`system/ccode-controller/content` receives `{skillId,version,digest}`. Responses use
`{code:0,data:...}` and require `Cache-Control: no-store`. Authentication uses Bearer
and tenant-id; the server independently validates tenant membership. Redirects are
rejected. Deployment and live server acceptance remain separate from unit tests.

The legacy `ConfidentialControllerCache`, lease API and acquire/ready/complete
messages remain available for historical consumers and tests. They are not used by
the default application startup path. Task routing owner/lease and mobile replay
semantics are unrelated and remain unchanged.