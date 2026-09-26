// Pure normalization: RawEntry (model output) → Entry (contract). All maths lives here.
import { BY_ID, displayName } from "../../contracts/catalog";
import type { BaseUnit, Entry, SpokenUnit, Warning } from "../../contracts/protocol";
import type { RawEntry } from "../../contracts/interfaces";

/** Actions whose entries carry a stock quantity. */
export const QUANTITY_ACTIONS = new Set<Entry["action"]>(["receiving", "usage", "wastage", "prep", "stock_count"]);

/** Spoken units that convert to each base, with the multiplier. Order = preferred first. */
export const CONVERSIONS: Record<BaseUnit, Partial<Record<SpokenUnit, number>>> = {
  kg: { kg: 1, g: 0.001 },
  l: { l: 1, ml: 0.001 },
  pcs: { pcs: 1, dozen: 12, packet: 1 },
  portion: { portion: 1 },
  c: { c: 1 },
};

export function convertibleUnits(base: BaseUnit): SpokenUnit[] {
  return Object.keys(CONVERSIONS[base]) as SpokenUnit[];
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Canonical 2-letter → BCP-47 used by the whole interpreter. */
export function normLang(lang: string | null | undefined, fallback = "en-IN"): string {
  if (!lang) return fallback;
  const m = /^([a-z]{2})(?:[-_]([a-z]{2}))?/i.exec(lang.trim());
  if (!m) return fallback;
  const short = m[1]!.toLowerCase();
  const region = (m[2] ?? "IN").toUpperCase();
  return `${short}-${region}`;
}

/**
 * Decide the unit when nothing was spoken. Base unit, except "matcha-like" items
 * (base kg, stocked below 1 kg) where a number ≥ 5 is almost certainly grams.
 */
export function assumeUnit(itemId: string, quantity: number | null): SpokenUnit | null {
  const item = BY_ID.get(itemId);
  if (!item) return null;
  if (item.base === "kg" && item.opening < 1 && quantity !== null && quantity >= 5) return "g";
  return item.base;
}

export function normalizeEntry(raw: RawEntry, language: string): Entry {
  const warnings: Warning[] = [];
  const candidates = [...new Set(raw.candidates.filter((id) => BY_ID.has(id)))];
  const itemId = candidates.length === 1 ? candidates[0]! : "unknown";
  const item = BY_ID.get(itemId) ?? null;
  const action = raw.action;

  let unit: SpokenUnit = raw.unit;
  let quantity = raw.quantity;
  let temperature_c = raw.temperature_c;

  if (action === "temperature_check") {
    // The number is a temperature whichever slot the model put it in.
    if (temperature_c === null && quantity !== null) temperature_c = quantity;
    quantity = temperature_c;
    unit = "c";
  }

  if (itemId === "unknown") warnings.push("unknown_item");

  const quantityBearing = QUANTITY_ACTIONS.has(action) || action === "temperature_check";
  if (quantityBearing && quantity === null) warnings.push("missing_quantity");

  if (quantityBearing && item && unit === "none" && quantity !== null) {
    const assumed = assumeUnit(itemId, quantity);
    if (assumed) {
      unit = assumed;
      if (action !== "temperature_check") warnings.push("unit_assumed");
    }
  }

  let quantity_base: number | null = null;
  let base_unit: BaseUnit | null = item ? item.base : null;
  if (item && quantityBearing) {
    const factor = CONVERSIONS[item.base][unit];
    if (factor === undefined) {
      if (unit !== "none") warnings.push("unit_mismatch");
    } else if (quantity !== null) {
      quantity_base = round3(quantity * factor);
    }
  }

  let value_inr: number | null = null;
  if (item && QUANTITY_ACTIONS.has(action) && quantity_base !== null && item.base !== "c") {
    value_inr = Math.round(quantity_base * item.price);
  }

  return {
    action,
    item_id: itemId,
    item_label: item ? displayName(itemId, language) : raw.item_heard,
    item_heard: raw.item_heard,
    quantity,
    unit,
    quantity_base,
    base_unit,
    value_inr,
    reason: raw.reason,
    temperature_c,
    stock_after: null,
    warnings,
  };
}

/** Entry → RawEntry-equivalent so an already-normalized entry can be re-normalized after a patch. */
export function toRaw(entry: Entry, candidates?: string[]): RawEntry {
  return {
    action: entry.action,
    candidates: candidates ?? (entry.item_id === "unknown" ? [] : [entry.item_id]),
    item_heard: entry.item_heard,
    quantity: entry.quantity,
    unit: entry.unit,
    reason: entry.reason,
    temperature_c: entry.temperature_c,
  };
}

/**
 * Apply a partial change to a normalized entry and recompute everything derived.
 * `unit_assumed` survives unless the unit itself was changed by the caller.
 */
export function renormalize(
  entry: Entry,
  patch: { quantity?: number | null; unit?: SpokenUnit; item_id?: string },
  language: string,
): Entry {
  const raw = toRaw(entry);
  if (patch.quantity !== undefined) raw.quantity = patch.quantity;
  if (patch.unit !== undefined) raw.unit = patch.unit;
  if (patch.item_id !== undefined) raw.candidates = BY_ID.has(patch.item_id) ? [patch.item_id] : [];
  const next = normalizeEntry(raw, language);
  const keep = entry.warnings.filter((w) => (w === "unit_assumed" && patch.unit === undefined) || w === "unresolved");
  for (const w of keep) if (!next.warnings.includes(w)) next.warnings.push(w);
  return { ...next, stock_after: entry.stock_after };
}
