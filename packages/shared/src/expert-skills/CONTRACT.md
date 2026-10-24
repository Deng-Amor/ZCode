# Expert skill distribution contracts

Types only (plus one error class): the client-side contract for fetching,
negotiating and caching platform-distributed expert skills. Public entrypoint:
`@zcode/shared/expert-skills`. Spec: `docs/specs/ccode-expert-skills-distribution.md`.

不变量：

- Transport is a dumb pipe: trust roots are deployed in the client and
  verification runs on the caller side; nothing here trusts the channel.
  Implementations must not embed credentials in this contract.
- `ExpertSkillVerifiedInput.payloadDigest` is SHA-256 over the original payload
  bytes (same derivation as the controller grant digest). Payload bytes are not
  retained after verification, so the digest must be carried explicitly — the
  spec §5.4 draft `put(identity, verified)` signature cannot reconstruct it.
- The cache store is the sole writer of the expert cache area. `put` is an
  atomic replace; `get` re-verifies every file hash before returning an entry;
  tampering surfaces as `ExpertSkillCacheError` and never enters sessions.
- `validUntil` expiring does not make an entry unloadable (offline degradation
  loads the cached version while refreshing in the background, spec §6.3);
  `revoked` entries are returned with their state and must be refused by
  callers — no silent fallback.

交接钩子：CLI 侧命名空间判定（`isExpertSkillIdentity` 保留名家族）在
`apps/zcode-cli/packages/contracts/src/skills`；磁盘缓存骨架在
`packages/services/src/expert-skills`（managed 模块 expert-skills-cache）。
