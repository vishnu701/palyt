// Deterministic clarification rules. Code decides WHETHER to ask; the model only wrote the words.
import { BY_ID, displayName } from "../../contracts/catalog";
import type { Clarification, Draft, Entry } from "../../contracts/protocol";
import type { RawEntry } from "../../contracts/interfaces";
import { QUANTITY_ACTIONS, convertibleUnits } from "./normalize";
import { fallbackQuestion, unitLabel } from "./text";

export type Option = { value: string; label: string };

export interface Gap {
  field: Clarification["field"];
  entry_index: number;
  options: Option[];
  /** Question text proposed by the model for this gap, if it wrote one. */
  question: string | null;
  /** The item is not in the catalog at all (asked once, never looped). */
  unknown?: boolean;
}

/** Per-entry question texts the model may have pre-written (schema.ts adds these to RawEntry). */
export interface AskTexts {
  ask_item?: string | null;
  ask_quantity?: string | null;
  ask_unit?: string | null;
}

/** Optional model-proposed question, accepted only when no rule fires. */
export interface ModelClarify {
  entry_index: number;
  field: Clarification["field"];
  question: string;
  option_labels: string[] | null;
}

const ASKABLE = (e: Entry) => QUANTITY_ACTIONS.has(e.action) || e.action === "temperature_check";

/**
 * First gap, rules in order across all entries:
 *   1. 2+ catalog candidates → which item (options from the catalog, speaker's language)
 *   1b. stock item not in the catalog at all ("star fruit") → say so, ask which item; asked
 *       ONCE (resolveClarification skips it on later rounds) so the card then shows it flagged
 *   2. missing quantity on a quantity-bearing action → free voice answer
 *   3. spoken unit cannot convert to the item's base → which unit
 * Returns null when nothing needs asking.
 */
export function findGap(entries: Entry[], raws: (RawEntry & AskTexts)[], language: string): Gap | null {
  for (let i = 0; i < entries.length; i++) {
    const ids = [...new Set(raws[i]?.candidates.filter((id) => BY_ID.has(id)) ?? [])];
    if (ids.length >= 2) {
      return {
        field: "item_id", entry_index: i,
        options: ids.map((id) => ({ value: id, label: displayName(id, language) })),
        question: raws[i]?.ask_item ?? null,
      };
    }
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.item_id === "unknown" && QUANTITY_ACTIONS.has(e.action)) {
      return { field: "item_id", entry_index: i, options: [], question: raws[i]?.ask_item ?? null, unknown: true };
    }
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.item_id !== "unknown" && ASKABLE(e) && e.warnings.includes("missing_quantity")) {
      return { field: "quantity", entry_index: i, options: [], question: raws[i]?.ask_quantity ?? null };
    }
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.item_id !== "unknown" && e.base_unit && e.warnings.includes("unit_mismatch")) {
      return {
        field: "unit", entry_index: i,
        options: convertibleUnits(e.base_unit).map((u) => ({ value: u, label: unitLabel(u, language) })),
        question: raws[i]?.ask_unit ?? null,
      };
    }
  }
  return null;
}

/** Round for a new question: continues the pending chain, else 1. */
export function nextRound(pending: Draft | null): number {
  return pending?.clarification ? pending.clarification.round + 1 : 1;
}

export interface Resolved {
  clarification: Clarification | null;
  entries: Entry[];
}

/**
 * Turn the rule gap (or, failing that, the model's own proposal) into a Clarification,
 * honouring the two-round limit: a third round is never asked; the entry gets `unresolved`.
 */
export function resolveClarification(
  entries: Entry[],
  raws: (RawEntry & AskTexts)[],
  pending: Draft | null,
  language: string,
  modelClarify: ModelClarify | null,
): Resolved {
  let gap = findGap(entries, raws, language);
  // SPEC §10 rule 4: an unclear action is the model's to pick, never a question.
  if (!gap && modelClarify && modelClarify.field !== "action" && modelClarify.entry_index < entries.length) {
    const labels = modelClarify.option_labels ?? [];
    gap = {
      field: modelClarify.field, entry_index: modelClarify.entry_index,
      options: labels.map((l) => ({ value: l, label: l })),
      question: modelClarify.question,
    };
  }
  if (!gap) return { clarification: null, entries };

  const round = nextRound(pending);
  // An item that is not in the catalog is asked about once PER ENTRY. If the answer still isn't
  // a catalog item, the card is shown with `unknown_item` (client renders "not in inventory").
  // A question about a different entry (e.g. "which rice?") does not count.
  const pc = pending?.clarification;
  const alreadyAskedThisUnknown = !!pc && pc.field === "item_id" && pc.options.length === 0 && pc.entry_index === gap.entry_index;
  if (gap.unknown && alreadyAskedThisUnknown) return { clarification: null, entries };
  if (round > 2) {
    const out = entries.map((e, i) =>
      i === gap!.entry_index && !e.warnings.includes("unresolved") ? { ...e, warnings: [...e.warnings, "unresolved" as const] } : e,
    );
    return { clarification: null, entries: out };
  }

  const entry = entries[gap.entry_index]!;
  const question = gap.question?.trim()
    || (gap.field === "item_id" || gap.field === "quantity" || gap.field === "unit"
      ? fallbackQuestion(gap.field, entry, gap.options, language)
      : fallbackQuestion("quantity", entry, gap.options, language));
  return {
    clarification: { field: gap.field, entry_index: gap.entry_index, question, options: gap.options, round },
    entries,
  };
}
