import { describe, expect, test } from "bun:test";
import type { Draft } from "../../contracts/protocol";
import type { RawEntry } from "../../contracts/interfaces";
import { findGap, nextRound, resolveClarification, type AskTexts } from "../../src/interpreter/gaps";
import { normalizeEntry } from "../../src/interpreter/normalize";

const raw = (o: Partial<RawEntry & AskTexts>): RawEntry & AskTexts => ({
  action: "receiving", candidates: ["paneer"], item_heard: "paneer", quantity: 5, unit: "kg", reason: null, temperature_c: null,
  ask_item: null, ask_quantity: null, ask_unit: null, ...o,
});
const build = (raws: (RawEntry & AskTexts)[], lang = "hi-IN") => ({ raws, entries: raws.map((r) => normalizeEntry(r, lang)) });
const pendingWith = (round: 1 | 2 | null): Draft => ({
  draft_id: "p", transcript: "", language: "hi-IN", intent: round ? "needs_clarification" : "log", entries: [], confirm_text: "",
  clarification: round ? { field: "item_id", entry_index: 0, question: "?", options: [], round } : null,
  speak_text: "", replaced_pending: false,
  meta: { model: "m", prompt_version: "v", llm_ms: 0, local_cache_hit: false, prompt_cache_read_tokens: 0 },
});

describe("findGap order", () => {
  test("2+ candidates → item_id with catalog labels in the speaker's language", () => {
    const { raws, entries } = build([raw({ candidates: ["rice", "rice_basmati"], item_heard: "chawal", quantity: 10 })]);
    const g = findGap(entries, raws, "hi-IN")!;
    expect(g.field).toBe("item_id");
    expect(g.options).toEqual([{ value: "rice", label: "साधारण चावल" }, { value: "rice_basmati", label: "बासमती चावल" }]);
  });

  test("ambiguity beats missing quantity beats unit mismatch, across entries", () => {
    const { raws, entries } = build([
      raw({ quantity: 2, unit: "l" }),                                 // mismatch
      raw({ candidates: ["milk"], quantity: null, unit: "none" }),     // missing quantity
      raw({ candidates: ["rice", "rice_basmati"], quantity: 10 }),     // ambiguous
    ]);
    expect(findGap(entries, raws, "hi-IN")).toMatchObject({ field: "item_id", entry_index: 2 });
    const two = build(raws.slice(0, 2));
    expect(findGap(two.entries, two.raws, "hi-IN")).toMatchObject({ field: "quantity", entry_index: 1, options: [] });
    const one = build(raws.slice(0, 1));
    expect(findGap(one.entries, one.raws, "hi-IN")).toMatchObject({ field: "unit", entry_index: 0, options: [{ value: "kg", label: "किलो" }, { value: "g", label: "ग्राम" }] });
  });

  test("unit options follow the item's base", () => {
    const { raws, entries } = build([raw({ candidates: ["eggs"], quantity: 2, unit: "kg" })]);
    expect(findGap(entries, raws, "en-IN")!.options.map((o) => o.value)).toEqual(["pcs", "dozen", "packet"]);
  });

  test("unit merely missing is not a gap", () => {
    const a = build([raw({ quantity: 20, unit: "none" })]);
    expect(findGap(a.entries, a.raws, "hi-IN")).toBeNull();
  });

  test("item not in the catalog → asked once (item_id, no options), never on a later round", () => {
    const b = build([raw({ candidates: [], item_heard: "star fruit", quantity: 4, unit: "kg" })]);
    const g = findGap(b.entries, b.raws, "hi-IN");
    expect(g).toMatchObject({ field: "item_id", entry_index: 0, options: [], unknown: true });
    const first = resolveClarification(b.entries, b.raws, null, "hi-IN", null);
    expect(first.clarification).toMatchObject({ field: "item_id", round: 1, options: [] });
    expect(first.clarification!.question.length).toBeGreaterThan(0);
    const again = resolveClarification(b.entries, b.raws, pendingWith(1), "hi-IN", null);
    expect(again.clarification).toBeNull();
    expect(again.entries[0]!.warnings).not.toContain("unresolved");
    expect(again.entries[0]!.item_id).toBe("unknown");
    // cleaning/incident with an unknown "item" (an area) is fine
    const c = build([raw({ action: "cleaning", candidates: [], item_heard: "back counter", quantity: null, unit: "none" })]);
    expect(findGap(c.entries, c.raws, "hi-IN")).toBeNull();
  });

  test("unknown at entry 1 is still asked (round 2) after a 'which rice?' question about entry 0", () => {
    const b = build([raw({ candidates: ["rice_basmati"], item_heard: "chawal", quantity: 2 }), raw({ candidates: [], item_heard: "star fruit", quantity: 3, unit: "kg" })]);
    const askedRice: Draft = { ...pendingWith(1), clarification: { field: "item_id", entry_index: 0, question: "?", options: [{ value: "rice", label: "r" }, { value: "rice_basmati", label: "b" }], round: 1 } };
    const r = resolveClarification(b.entries, b.raws, askedRice, "hi-IN", null);
    expect(r.clarification).toMatchObject({ field: "item_id", entry_index: 1, options: [], round: 2 });
    // …but not a third time about the same entry
    const askedStar: Draft = { ...askedRice, clarification: { field: "item_id", entry_index: 1, question: "?", options: [], round: 2 } };
    expect(resolveClarification(b.entries, b.raws, askedStar, "hi-IN", null).clarification).toBeNull();
  });

  test("cleaning/incident never ask for a quantity", () => {
    const { raws, entries } = build([raw({ action: "cleaning", candidates: ["freezer"], quantity: null, unit: "none" })]);
    expect(findGap(entries, raws, "hi-IN")).toBeNull();
  });
});

describe("resolveClarification", () => {
  const ambiguous = () => build([raw({ candidates: ["rice", "rice_basmati"], item_heard: "chawal", quantity: 10, ask_item: "कौन सा चावल?" })]);

  test("round 1 with no pending; uses the model's question text", () => {
    const { raws, entries } = ambiguous();
    const r = resolveClarification(entries, raws, null, "hi-IN", null);
    expect(r.clarification).toMatchObject({ field: "item_id", round: 1, question: "कौन सा चावल?" });
  });

  test("falls back to a templated question when the model wrote none", () => {
    const { raws, entries } = build([raw({ candidates: ["milk"], quantity: null, unit: "none" })]);
    const r = resolveClarification(entries, raws, null, "kn-IN", null);
    expect(r.clarification!.question).toBe("ಹಾಲು ಎಷ್ಟು?");
  });

  test("continues the chain: pending round 1 → 2; pending plain card → 1", () => {
    const { raws, entries } = ambiguous();
    expect(resolveClarification(entries, raws, pendingWith(1), "hi-IN", null).clarification!.round).toBe(2);
    expect(resolveClarification(entries, raws, pendingWith(null), "hi-IN", null).clarification!.round).toBe(1);
    expect(nextRound(pendingWith(2))).toBe(3);
  });

  test("third round is never asked: unresolved warning instead", () => {
    const { raws, entries } = ambiguous();
    const r = resolveClarification(entries, raws, pendingWith(2), "hi-IN", null);
    expect(r.clarification).toBeNull();
    expect(r.entries[0]!.warnings).toContain("unresolved");
    expect(r.entries[0]!.item_id).toBe("unknown");
  });

  test("model-proposed question accepted only when no rule gap exists", () => {
    const clean = build([raw({})]);
    const proposal = { entry_index: 0, field: "reason" as const, question: "खराब कैसे हुआ?", option_labels: ["spoiled", "burnt"] };
    const r = resolveClarification(clean.entries, clean.raws, null, "hi-IN", proposal);
    expect(r.clarification).toMatchObject({ field: "reason", question: "खराब कैसे हुआ?", options: [{ value: "spoiled", label: "spoiled" }, { value: "burnt", label: "burnt" }] });
    const amb = ambiguous();
    expect(resolveClarification(amb.entries, amb.raws, null, "hi-IN", proposal).clarification!.field).toBe("item_id");
  });

  test("model-proposed question about the ACTION is never asked (SPEC §10 rule 4)", () => {
    const clean = build([raw({})]);
    const proposal = { entry_index: 0, field: "action" as const, question: "खराब या इस्तेमाल?", option_labels: ["wastage", "usage"] };
    expect(resolveClarification(clean.entries, clean.raws, null, "hi-IN", proposal).clarification).toBeNull();
  });
});
