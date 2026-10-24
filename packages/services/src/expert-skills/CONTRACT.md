# Expert skill cache store

磁盘缓存骨架（spec：`docs/specs/ccode-expert-skills-distribution.md` §5.1/§5.2/§6.3）。
端口类型在 `@zcode/shared/expert-skills`；本模块是唯一写入者实现，不做网络与验签
（验签属调用方，transport 属后续卡）。

不变量：

- 磁盘布局 `<baseDir>/identities/<sha256(identity)>/entries/<digest>`（内容寻址：
  同 digest 即同内容，不重复落盘）；`index.json` 是唯一提交点，temp+rename 原子写。
  任何中断最多留下孤儿目录（加载/写入时 sweep），不会留下半份条目或指向已删目录
  的索引；替换失败保留上一个仍有效版本。
- `get` 返回条目前逐文件 sha256 复验：字节被改 → `HASH_MISMATCH`；文件缺失 →
  `CACHE_CORRUPT`；索引损坏 → `CACHE_CORRUPT`。被篡改内容不进入会话上下文，
  由调用方走重新获取路径。
- 按登录身份隔离：身份键经 sha256 后作目录名；`clearIdentity` 后旧身份缓存不可读。
- 上限（maxEntries/maxTotalBytes）对整个缓存区跨身份生效，LRU 按 lastUsedAt 淘汰；
  读路径只触碰内存 recency，磁盘 lastUsedAt 随下一次变更持久化。单条目超过
  maxTotalBytes 时 put 直接拒绝（CAPACITY_EXCEEDED），不驱逐其他条目迁就。
- 有效期届满不等于不可加载（离线降级仍用缓存，spec §6.3）；`revoked` 条目保留并
  带 state 返回，由调用方拒绝加载、不静默回退。
- store 假定单进程唯一写入者（spec §5.1）：所有操作经进程内全局串行链，
  index.json 原子写不加跨进程锁。

交接钩子：put 输入的 payloadDigest 与 controller grant digest 同源（payload 原始
字节 SHA-256）；Skill 面 discover/load 接线与 Main 装配属后续卡。
