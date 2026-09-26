// In-memory LRU result cache: identical (normalized text, language hint, pending draft+round)
// → identical Draft without a model call. This is the "seed" the founders asked for.
import type { Draft } from "../../contracts/protocol";

export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase().replace(/[\s.,!?।॥]+$/u, "");
}

export function cacheKey(text: string, languageHint: string | null, pending: Draft | null): string {
  const p = pending ? `${pending.draft_id}:${pending.clarification?.round ?? 0}` : "";
  return `${normalizeText(text)}|${languageHint ?? ""}|${p}`;
}

export class DraftCache {
  private map = new Map<string, Draft>();
  constructor(private readonly max = 500) {}

  get(key: string): Draft | null {
    const v = this.map.get(key);
    if (!v) return null;
    this.map.delete(key);
    this.map.set(key, v); // refresh recency
    return {
      ...structuredClone(v),
      draft_id: crypto.randomUUID(),
      meta: { ...v.meta, local_cache_hit: true, llm_ms: 0 },
    };
  }

  set(key: string, draft: Draft): void {
    this.map.set(key, structuredClone(draft));
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  get size(): number { return this.map.size; }
}
