import type { DocItem, DocStore } from "@/storage/types";

interface Entry<T extends DocItem = DocItem> {
  item: T;
  expiresAt?: number;
}

export const createMemoryDocStore = (now: () => number = () => Date.now()): DocStore => {
  const map = new Map<string, Entry>();
  const key = (pk: string, sk: string) => `${pk}\0${sk}`;

  const live = <T extends DocItem>(pk: string, sk: string): T | null => {
    const entry = map.get(key(pk, sk));
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= now()) {
      map.delete(key(pk, sk));
      return null;
    }
    return { ...entry.item } as T;
  };

  return {
    async get(pk, sk) {
      return live(pk, sk);
    },
    async put(pk, sk, item, opts = {}) {
      map.set(key(pk, sk), {
        item: { ...item, PK: pk, SK: sk },
        expiresAt: opts.ttlSeconds !== undefined ? now() + opts.ttlSeconds * 1000 : undefined,
      });
    },
    async update(pk, sk, set, remove = []) {
      const current = live(pk, sk) ?? ({ PK: pk, SK: sk } as DocItem);
      const next = { ...current, ...set };
      for (const field of remove) {
        delete next[field];
      }
      map.set(key(pk, sk), { item: next });
    },
    async query(pk, skPrefix = "") {
      const out: DocItem[] = [];
      for (const [rawKey] of map) {
        const [entryPk, entrySk] = rawKey.split("\0");
        if (entryPk === pk && entrySk?.startsWith(skPrefix)) {
          const item = live(pk, entrySk);
          if (item) out.push(item);
        }
      }
      return out.sort((a, b) => String(a.SK ?? "").localeCompare(String(b.SK ?? ""))) as never;
    },
    async delete(pk, sk) {
      map.delete(key(pk, sk));
    },
  };
};
