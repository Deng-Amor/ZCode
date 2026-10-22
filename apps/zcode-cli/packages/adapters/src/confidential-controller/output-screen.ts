const WINDOW = 24;
const STRIDE = 12;
const MAX_CHARS = 4 * 1024 * 1024;
const BASE = 31;
const MAX_NODES = 100_000;
const MAX_DEPTH = 128;
const MAX_COLLISIONS = 32;

function assertJsonValue(root: unknown): void {
  const pending = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let chars = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('OUTPUT_REJECTED');
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    if (typeof value === 'string') {
      chars += value.length;
      if (chars > MAX_CHARS) throw new Error('OUTPUT_REJECTED');
      continue;
    }
    if (typeof value !== 'object' || seen.has(value)) throw new Error('OUTPUT_REJECTED');
    seen.add(value);
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (array && prototype !== Array.prototype) throw new Error('OUTPUT_REJECTED');
    if (!array && prototype !== Object.prototype && prototype !== null) throw new Error('OUTPUT_REJECTED');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (array && (value.length > MAX_NODES || keys.length !== value.length + 1)) throw new Error('OUTPUT_REJECTED');
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new Error('OUTPUT_REJECTED');
      const descriptor = descriptors[key]!;
      if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('OUTPUT_REJECTED');
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new Error('OUTPUT_REJECTED');
      chars += key.length;
      if (chars > MAX_CHARS || pending.length >= MAX_NODES) throw new Error('OUTPUT_REJECTED');
      pending.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
}

function normalize(text: string): string {
  return text.normalize('NFKC').replace(/[\s\p{P}\p{S}\p{Cf}]/gu, '').toLowerCase();
}

/** Bounded exact-fragment check, not a promise to detect paraphrase or encoding. */
export function screenControllerOutput(instruction: string, value: unknown): unknown {
  // 禁止 JSON 快照静默改变 Date/Map/非有限数值或触发 getter；模型结果必须是纯 JSON 树。
  assertJsonValue(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length > MAX_CHARS) throw new Error('OUTPUT_REJECTED');
  const source = normalize(instruction);
  if (!source.length || source.length > MAX_CHARS) throw new Error('OUTPUT_REJECTED');
  // JSON escapes can split a copied rule; inspect decoded strings as well as keys.
  const strings: string[] = [];
  const keys: string[] = [];
  const deltas: string[] = [];
  const snapshot: unknown = JSON.parse(serialized, (key: string, item: unknown) => {
    if (key) keys.push(key);
    if (typeof item === 'string') strings.push(item);
    if ((key === 'text' || key === 'delta') && typeof item === 'string') deltas.push(item);
    return item;
  });
  const output = normalize(strings.join('') + keys.join('') + deltas.join(''));
  if (source.length < WINDOW) {
    if (output.includes(source)) throw new Error('OUTPUT_REJECTED');
    return snapshot;
  }
  if (output.length < WINDOW) return snapshot;
  let power = 1;
  for (let index = 1; index < WINDOW; index++) power = Math.imul(power, BASE) >>> 0;
  const hashAt = (text: string, start: number) => {
    let hash = 0;
    for (let offset = 0; offset < WINDOW; offset++)
      hash = (Math.imul(hash, BASE) + text.charCodeAt(start + offset)) >>> 0;
    return hash;
  };
  const fingerprints = new Map<number, number[]>();
  for (let start = 0; start + WINDOW <= source.length; start += STRIDE) {
    const hash = hashAt(source, start);
    const offsets = fingerprints.get(hash);
    // Store one copy of repeated windows, bounding pathological repetitive input.
    if (offsets) {
      if (offsets.length >= MAX_COLLISIONS) throw new Error('OUTPUT_REJECTED');
      if (!offsets.some((offset) => source.slice(offset, offset + WINDOW) === source.slice(start, start + WINDOW)))
        offsets.push(start);
    } else fingerprints.set(hash, [start]);
  }
  let hash = hashAt(output, 0);
  for (let start = 0; start + WINDOW <= output.length; start++) {
    if (fingerprints.get(hash)?.some((offset) =>
      source.slice(offset, offset + WINDOW) === output.slice(start, start + WINDOW)))
      throw new Error('OUTPUT_REJECTED');
    if (start + WINDOW < output.length)
      hash = (Math.imul((hash - Math.imul(output.charCodeAt(start), power)) >>> 0, BASE)
        + output.charCodeAt(start + WINDOW)) >>> 0;
  }
  return snapshot;
}
