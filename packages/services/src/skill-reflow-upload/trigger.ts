// ============================================================
// skill-reflow-upload 触发日界判定（spec §6.1 触发与补传）
// ============================================================
// 纯函数：日界用本地时区自然日（与「每日首次启动」的用户语义一致；跨时区漫游导致
// 的日界漂移不构成故障，spec §6.1）；幂等依据为持久化标记 lastTriggerDate
// （同日多次重启不重复扫描；进程崩溃不造成当日重复会话）。

/** 本地时区自然日键（YYYY-MM-DD，本地 getFullYear/Month/Date）。 */
export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 日界判定：lastTriggerDate ≠ 今日 → 触发；同日 → 不触发（幂等）。 */
export function shouldTriggerDailyScan(
  lastTriggerDate: string | undefined,
  now: Date,
): boolean {
  return lastTriggerDate !== localDayKey(now);
}

/** 距下一个本地自然日零点的毫秒数（供触发器调度端口计算下次排程时刻）。 */
export function millisecondsUntilNextLocalMidnight(now: Date): number {
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);
  return Math.max(0, nextMidnight.getTime() - now.getTime());
}
