import { recipeCost } from "../../contracts/catalog";
import { describe, expect, test } from "bun:test";
import { Entry } from "../../contracts/protocol";
import type { RawEntry } from "../../contracts/interfaces";
import { assumeUnit, normLang, normalizeEntry, renormalize } from "../../src/interpreter/normalize";
import { normalizeText, cacheKey, DraftCache } from "../../src/interpreter/cache";
import { confirmText, readbackText } from "../../src/interpreter/text";

const raw = (o: Partial<RawEntry>): RawEntry => ({
  action: "wastage", candidates: ["paneer"], item_heard: "paneer", quantity: 5, unit: "kg", reason: "spoiled", temperature_c: null, ...o,
});

describe("normalizeEntry", () => {
  test("clean kg wastage: base, value, label in hindi, no warnings", () => {
    const e = normalizeEntry(raw({}), "hi-IN");
    expect(Entry.parse(e)).toEqual(e);
    expect(e).toMatchObject({ item_id: "paneer", item_label: "पनीर", quantity_base: 5, base_unit: "kg", value_inr: 1750, stock_after: null, warnings: [] });
  });

  test("g → kg /1000, 3 dp, value rounded", () => {
    const e = normalizeEntry(raw({ candidates: ["matcha"], quantity: 20, unit: "g" }), "en-IN");
    expect(e.quantity_base).toBe(0.02);
    expect(e.value_inr).toBe(60);
  });

  test("ml → l, dozen → pcs ×12", () => {
    expect(normalizeEntry(raw({ candidates: ["milk"], action: "receiving", quantity: 500, unit: "ml" }), "hi-IN").quantity_base).toBe(0.5);
    const eggs = normalizeEntry(raw({ candidates: ["eggs"], action: "receiving", quantity: 2, unit: "dozen" }), "hi-IN");
    expect(eggs.quantity_base).toBe(24);
    expect(eggs.value_inr).toBe(168);
  });

  test("unit none → base assumed with unit_assumed", () => {
    const e = normalizeEntry(raw({ candidates: ["paneer"], quantity: 3, unit: "none" }), "hi-IN");
    expect(e.unit).toBe("kg");
    expect(e.quantity_base).toBe(3);
    expect(e.warnings).toEqual(["unit_assumed"]);
  });

  test("unit none on a matcha-like item with quantity ≥ 5 → grams", () => {
    const e = normalizeEntry(raw({ candidates: ["matcha"], action: "usage", quantity: 20, unit: "none" }), "en-IN");
    expect(e.unit).toBe("g");
    expect(e.quantity_base).toBe(0.02);
    expect(e.base_unit).toBe("kg");
    expect(e.warnings).toContain("unit_assumed");
    expect(assumeUnit("matcha", 2)).toBe("kg");
    expect(assumeUnit("paneer", 20)).toBe("kg");
    expect(assumeUnit("eggs", 20)).toBe("pcs");
    expect(assumeUnit("nope", 20)).toBeNull();
  });

  test("unconvertible unit → quantity_base null, unit_mismatch, value null", () => {
    const e = normalizeEntry(raw({ quantity: 2, unit: "l" }), "hi-IN");
    expect(e.quantity_base).toBeNull();
    expect(e.value_inr).toBeNull();
    expect(e.warnings).toEqual(["unit_mismatch"]);
  });

  test("missing quantity → warning, no maths", () => {
    const e = normalizeEntry(raw({ quantity: null, unit: "none" }), "hi-IN");
    expect(e.warnings).toEqual(["missing_quantity"]);
    expect(e.quantity_base).toBeNull();
    expect(e.unit).toBe("none");
  });

  test("no candidates → unknown, label = heard, value null", () => {
    const e = normalizeEntry(raw({ candidates: [], item_heard: "ब्रोकली", action: "receiving", quantity: 3 }), "hi-IN");
    expect(e).toMatchObject({ item_id: "unknown", item_label: "ब्रोकली", quantity: 3, unit: "kg", quantity_base: null, base_unit: null, value_inr: null });
    expect(e.warnings).toEqual(["unknown_item"]);
  });

  test("2+ candidates → unknown until clarified; invalid ids dropped", () => {
    const e = normalizeEntry(raw({ candidates: ["rice", "rice_basmati", "bogus"], action: "receiving", quantity: 10 }), "hi-IN");
    expect(e.item_id).toBe("unknown");
    const single = normalizeEntry(raw({ candidates: ["bogus", "paneer"] }), "hi-IN");
    expect(single.item_id).toBe("paneer");
  });

  test("temperature_check: number lands in temperature_c, unit c, value null", () => {
    const e = normalizeEntry(raw({ action: "temperature_check", candidates: ["walkin_fridge"], quantity: 4, unit: "none", temperature_c: null, reason: null }), "mr-IN");
    expect(e).toMatchObject({ temperature_c: 4, unit: "c", value_inr: null, item_label: "वॉक-इन फ्रिज", warnings: [] });
  });

  test("prep in portions, cleaning has no value", () => {
    const p = normalizeEntry(raw({ action: "prep", candidates: ["dal_makhani"], quantity: 20, unit: "portion", reason: null }), "hi-IN");
    // Menu items are priced from their recipe (contracts/catalog.ts recipeCost), not a flat number.
    expect(p).toMatchObject({ quantity_base: 20, base_unit: "portion", value_inr: Math.round(20 * recipeCost("dal_makhani")), warnings: [] });
    const c = normalizeEntry(raw({ action: "cleaning", candidates: ["freezer"], quantity: null, unit: "none", reason: null }), "hi-IN");
    expect(c).toMatchObject({ quantity_base: null, value_inr: null, warnings: [] });
  });
});

describe("renormalize", () => {
  const base = normalizeEntry(raw({ candidates: ["paneer"], quantity: 3, unit: "none" }), "hi-IN");
  test("quantity change keeps unit_assumed and recomputes value", () => {
    const e = renormalize(base, { quantity: 4 }, "hi-IN");
    expect(e).toMatchObject({ quantity: 4, quantity_base: 4, value_inr: 1400, warnings: ["unit_assumed"] });
  });
  test("unit change drops unit_assumed", () => {
    const e = renormalize(base, { unit: "g" }, "hi-IN");
    expect(e.warnings).toEqual([]);
    expect(e.quantity_base).toBe(0.003);
  });
  test("item change relabels and reprices", () => {
    const e = renormalize(base, { item_id: "curd" }, "kn-IN");
    expect(e).toMatchObject({ item_id: "curd", item_label: "ಮೊಸರು", value_inr: 210 });
  });
});

describe("normLang", () => {
  test("2-letter and underscore forms → BCP-47 IN", () => {
    expect(normLang("hi")).toBe("hi-IN");
    expect(normLang("kn_in")).toBe("kn-IN");
    expect(normLang("en-US")).toBe("en-US");
    expect(normLang(null, "hi-IN")).toBe("hi-IN");
    expect(normLang("??", "mr-IN")).toBe("mr-IN");
  });
});

describe("text templates", () => {
  const paneer = normalizeEntry(raw({}), "hi-IN");
  test("hindi confirm and readback with stock", () => {
    expect(confirmText([paneer], "hi-IN")).toBe("5 किलो पनीर खराब। सही है?");
    expect(readbackText([{ ...paneer, stock_after: 7 }], "hi-IN")).toBe("5 किलो पनीर खराब, दर्ज हो गया। बचा 7 किलो।");
  });
  test("kannada readback", () => {
    const milk = normalizeEntry(raw({ action: "receiving", candidates: ["milk"], quantity: 20, unit: "l", reason: null }), "kn-IN");
    expect(readbackText([{ ...milk, stock_after: 60 }], "kn-IN")).toBe("20 ಲೀಟರ್ ಹಾಲು ಬಂದಿದೆ, ದಾಖಲಾಗಿದೆ. ಉಳಿದಿದೆ 60 ಲೀಟರ್.");
  });
  test("english fallback for unsupported languages, no stock line when null", () => {
    expect(readbackText([paneer], "ta-IN")).toBe("5 kg பனீர் wasted, saved.");
  });
});

describe("cache", () => {
  test("key normalization: spaces, case, trailing punctuation", () => {
    expect(normalizeText("  Paanch  Kilo Paneer. ")).toBe("paanch kilo paneer");
    expect(cacheKey("a", null, null)).toBe("a||");
  });
  test("hit returns a fresh draft_id with cache meta; LRU evicts oldest", () => {
    const c = new DraftCache(2);
    const d = { draft_id: "x", meta: { model: "m", prompt_version: "v", llm_ms: 500, local_cache_hit: false, prompt_cache_read_tokens: 10 } } as any;
    c.set("k1", d); c.set("k2", d);
    const hit = c.get("k1")!;
    expect(hit.draft_id).not.toBe("x");
    expect(hit.meta).toMatchObject({ local_cache_hit: true, llm_ms: 0, prompt_cache_read_tokens: 10 });
    c.set("k3", d); // k2 is now the oldest
    expect(c.get("k2")).toBeNull();
    expect(c.get("k1")).not.toBeNull();
  });
});
