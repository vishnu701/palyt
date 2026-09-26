import { describe, expect, test } from "bun:test";
import { Ledger, percentile } from "../../src/gateway/ledger";
import type { Entry, LogRecord } from "../../contracts/protocol";
import { JsonlStore } from "../../src/gateway/store";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const META = { model: "t", prompt_version: "t", llm_ms: 100, local_cache_hit: false, prompt_cache_read_tokens: 0 };
function e(p: Partial<Entry> & { action: Entry["action"]; item_id: string }): Entry {
  return { item_label: p.item_id, item_heard: p.item_id, quantity: p.quantity_base ?? null, unit: "kg", quantity_base: null, base_unit: "kg", value_inr: null, reason: null, temperature_c: null, stock_after: null, warnings: [], ...p };
}
function rec(entries: Entry[], extra: Partial<LogRecord> = {}): LogRecord {
  return { record_id: crypto.randomUUID(), draft_id: "d", created_at: new Date().toISOString(), session_id: "s", language: "hi-IN", transcript: "t", entries, edited: false, clarified: false, photo_url: null, timings: { stt_ms: 100, llm_ms: 400, total_ms: 600 }, meta: META, ...extra };
}

describe("ledger", () => {
  test("replay table", () => {
    const l = new Ledger();
    expect(l.stock("paneer")).toBe(12);
    l.apply(rec([e({ action: "receiving", item_id: "paneer", quantity_base: 3 })]));
    expect(l.stock("paneer")).toBe(15);
    l.apply(rec([e({ action: "wastage", item_id: "paneer", quantity_base: 5 }), e({ action: "usage", item_id: "paneer", quantity_base: 2.5 })]));
    expect(l.stock("paneer")).toBe(7.5);
    l.apply(rec([e({ action: "stock_count", item_id: "paneer", quantity_base: 4 })]));
    expect(l.stock("paneer")).toBe(4);
    // Menu item: no stock of its own; 20 portions of dal makhani consume the recipe from ingredients.
    const dal0 = l.stock("dal"), butter0 = l.stock("butter");
    l.apply(rec([e({ action: "prep", item_id: "dal_makhani", quantity_base: 20, base_unit: "portion" })]));
    expect(l.stock("dal_makhani")).toBe(0);
    expect(l.stock("dal")).toBe(dal0 - 1.6);
    expect(l.stock("butter")).toBe(butter0 - 0.4);
    // receiving a dish is ignored; wasting one portion consumes one recipe
    l.apply(rec([e({ action: "receiving", item_id: "dal_makhani", quantity_base: 5, base_unit: "portion" })]));
    expect(l.stock("dal")).toBe(dal0 - 1.6);
    l.apply(rec([e({ action: "wastage", item_id: "dal_makhani", quantity_base: 1, base_unit: "portion" })]));
    expect(l.stock("dal")).toBe(dal0 - 1.68);
    l.apply(rec([e({ action: "temperature_check", item_id: "walkin_fridge", temperature_c: 4, base_unit: "c" }), e({ action: "cleaning", item_id: "unknown" })]));
    expect(l.stock("paneer")).toBe(4);
  });

  test("stockAfter / exceedsStock / unknown item", () => {
    const l = new Ledger();
    expect(l.stockAfter(e({ action: "wastage", item_id: "paneer", quantity_base: 5 }))).toBe(7);
    expect(l.stockAfter(e({ action: "stock_count", item_id: "paneer", quantity_base: 2 }))).toBe(2);
    expect(l.stockAfter(e({ action: "wastage", item_id: "unknown", quantity_base: 5 }))).toBeNull();
    expect(l.stockAfter(e({ action: "temperature_check", item_id: "walkin_fridge" }))).toBeNull();
    expect(l.exceedsStock(e({ action: "wastage", item_id: "paneer", quantity_base: 13 }))).toBe(true);
    expect(l.exceedsStock(e({ action: "wastage", item_id: "paneer", quantity_base: 12 }))).toBe(false);
    expect(l.exceedsStock(e({ action: "receiving", item_id: "paneer", quantity_base: 999 }))).toBe(false);
  });

  test("inventory excludes temperature items, flags low, tracks changed_at", () => {
    const l = new Ledger();
    const r = rec([e({ action: "wastage", item_id: "paneer", quantity_base: 10 })]);
    l.apply(r);
    const inv = l.inventory();
    expect(inv.find((i) => i.item_id === "walkin_fridge")).toBeUndefined();
    expect(inv.find((i) => i.item_id === "dal_makhani")).toBeUndefined();
    const p = inv.find((i) => i.item_id === "paneer")!;
    expect(p.current).toBe(2);
    expect(p.low).toBe(true);
    expect(p.value_inr).toBe(700);
    expect(p.changed_at).toBe(r.created_at);
    expect(inv.find((i) => i.item_id === "milk")!.changed_at).toBeNull();
  });

  test("stats: today only (IST), sums, percentiles, corrected/clarified", () => {
    const l = new Ledger();
    const yesterday = new Date(Date.now() - 36 * 3600_000).toISOString();
    l.apply(rec([e({ action: "wastage", item_id: "paneer", quantity_base: 1, value_inr: 350 })], { created_at: yesterday }));
    const r1 = rec([e({ action: "wastage", item_id: "paneer", quantity_base: 5, value_inr: 1750 })], { timings: { stt_ms: 100, llm_ms: 400, total_ms: 600 } });
    const r2 = rec([e({ action: "receiving", item_id: "milk", quantity_base: 20, value_inr: 1200 })], { language: "kn-IN", clarified: true, timings: { stt_ms: 100, llm_ms: 400, total_ms: 900 } });
    l.apply(r1); l.apply(r2);
    const s = l.stats(new Date(), new Set([r1.record_id])).today;
    expect(s.entries).toBe(2);
    expect(s.wastage_inr).toBe(1750);
    expect(s.receiving_inr).toBe(1200);
    expect(s.by_action).toEqual({ wastage: 1, receiving: 1 });
    expect(s.languages.sort()).toEqual(["hi-IN", "kn-IN"]);
    expect(s.latency_ms.p50).toBe(600);
    expect(s.latency_ms.p99).toBe(900);
    expect(s.corrected_by_voice).toBe(1);
    expect(s.clarified).toBe(1);
  });

  test("menu: ingredients breakdown, exceeds via ingredient, portions possible", () => {
    const l = new Ledger();
    const w = e({ action: "wastage", item_id: "dal_makhani", quantity_base: 2, base_unit: "portion" });
    const ing = l.ingredients(w, "hi-IN")!;
    expect(ing.map((i) => i.item_id)).toEqual(["dal", "butter", "cream", "tomato", "onion"]);
    expect(ing[0]).toMatchObject({ label: "तूर दाल", quantity_base: 0.16, base_unit: "kg", value_inr: 19, stock_after: 14.84 });
    expect(l.stockAfter(w)).toBeNull();
    expect(l.ingredients(e({ action: "receiving", item_id: "dal_makhani", quantity_base: 2 }), "hi-IN")).toBeUndefined();
    expect(l.ingredients(e({ action: "wastage", item_id: "paneer", quantity_base: 2 }), "hi-IN")).toBeUndefined();
    expect(l.exceedsStock(e({ action: "wastage", item_id: "dal_makhani", quantity_base: 500, base_unit: "portion" }))).toBe(true);
    const menu = l.menu();
    const dm = menu.find((m) => m.item_id === "dal_makhani")!;
    expect(dm.cost_inr).toBeGreaterThan(20);
    expect(dm.portions_possible).toBe(Math.min(Math.floor(15 / 0.08), Math.floor(5 / 0.02), Math.floor(8 / 0.03), Math.floor(20 / 0.05), Math.floor(25 / 0.03)));
    expect(dm.limiting_item).toBe("dal");
  });

  test("percentile", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.99)).toBe(5);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.99)).toBe(4);
  });
});

describe("jsonl store", () => {
  test("append, update (last wins), replay oldest first, bad lines skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kv-store-"));
    const s = new JsonlStore(dir);
    const a = rec([], { created_at: "2026-09-26T05:00:00.000Z" });
    const b = rec([], { created_at: "2026-09-26T04:00:00.000Z" });
    await s.append(a); await s.append(b);
    await s.update({ ...a, photo_url: "/photos/x.jpg" });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(dir, "records.jsonl"), "not json\n");
    const all = await s.all();
    expect(all.map((r) => r.record_id)).toEqual([b.record_id, a.record_id]);
    expect(all[1]!.photo_url).toBe("/photos/x.jpg");
    const l = new Ledger(all);
    expect(l.stats(new Date("2026-09-26T12:00:00Z")).today.entries).toBe(2);
    expect(l.stats(new Date("2026-09-27T12:00:00Z")).today.entries).toBe(0);
  });
});
