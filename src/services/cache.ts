/** Tiny in-memory TTL cache — cuts repeated RPC / Blockscout lag. */

type Entry<T> = { v: T; exp: number };

const store = new Map<string, Entry<unknown>>();

export function cacheGet<T>(key: string): T | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (Date.now() > e.exp) {
    store.delete(key);
    return undefined;
  }
  return e.v as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { v: value, exp: Date.now() + ttlMs });
  // Soft cap
  if (store.size > 500) {
    const now = Date.now();
    for (const [k, ent] of store) {
      if (ent.exp < now) store.delete(k);
    }
  }
}

export async function cacheGetOrSet<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const v = await fn();
  cacheSet(key, v, ttlMs);
  return v;
}
