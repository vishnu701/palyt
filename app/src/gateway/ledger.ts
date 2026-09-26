// Inventory ledger and stats. Pure: replays confirmed records over the catalog's opening stock.
// Rules (SPEC §11): receiving +, usage/wastage −, stock_count = overwrite,
// temperature_check/cleaning/incident no change.
// Menu items have NO stock of their own: logging n portions (usage, wastage, prep) consumes
// n × the recipe from the ingredients. Receiving/stock_count of a dish is ignored.
import { CATALOG, BY_ID, RECIPES, MENU, displayName } from "../../contracts/catalog";
import type { Entry, Ingredient, InventoryItem, LogRecord } from "../../contracts/protocol";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const CONSUMES = new Set(["usage", "wastage", "prep"]);

export interface Delta { item_id: string; kind: "add" | "set"; amount: number }

/** Every stock movement an entry causes. Menu items explode into their ingredients. */
export function explode(e: Entry): Delta[] {
  if (e.item_id === "unknown" || e.quantity_base == null) return [];
  const item = BY_ID.get(e.item_id);
  if (item?.menu) {
    if (!CONSUMES.has(e.action)) return [];
    const recipe = RECIPES[e.item_id] ?? [];
    return recipe.map((l) => ({ item_id: l.item_id, kind: "add" as const, amount: -round3(l.quantity_base * e.quantity_base!) }));
  }
  switch (e.action) {
    case "receiving":
    case "prep":
      return [{ item_id: e.item_id, kind: "add", amount: e.quantity_base }];
    case "usage":
    case "wastage":
      return [{ item_id: e.item_id, kind: "add", amount: -e.quantity_base }];
    case "stock_count":
      return [{ item_id: e.item_id, kind: "set", amount: e.quantity_base }];
    default:
      return [];
  }
}

export class Ledger {
  private current = new Map<string, number>();
  private changedAt = new Map<string, string>();
  private records: LogRecord[] = [];

  constructor(records: LogRecord[] = []) {
    this.reset();
    for (const r of records) this.apply(r);
  }

  reset(): void {
    this.current.clear();
    this.changedAt.clear();
    this.records = [];
    for (const item of CATALOG) if (!item.menu) this.current.set(item.id, item.opening);
  }

  apply(record: LogRecord): void {
    this.records.push(record);
    for (const e of record.entries) {
      for (const d of explode(e)) {
        const cur = this.current.get(d.item_id) ?? 0;
        this.current.set(d.item_id, round3(d.kind === "set" ? d.amount : cur + d.amount));
        this.changedAt.set(d.item_id, record.created_at);
      }
    }
  }

  stock(item_id: string): number {
    return this.current.get(item_id) ?? 0;
  }

  isMenu(item_id: string): boolean {
    return !!BY_ID.get(item_id)?.menu;
  }

  /** Stock after this entry would be applied (review card). null for menu items and non-stock actions. */
  stockAfter(e: Entry): number | null {
    if (this.isMenu(e.item_id)) return null;
    const d = explode(e)[0];
    if (!d) return null;
    return round3(d.kind === "set" ? d.amount : this.stock(d.item_id) + d.amount);
  }

  /** Recipe explosion for a menu-item entry, with per-ingredient stock after. undefined for non-menu items. */
  ingredients(e: Entry, language: string): Ingredient[] | undefined {
    if (!this.isMenu(e.item_id) || e.quantity_base == null || !CONSUMES.has(e.action)) return undefined;
    return (RECIPES[e.item_id] ?? []).map((l) => {
      const ing = BY_ID.get(l.item_id)!;
      const qty = round3(l.quantity_base * e.quantity_base!);
      return {
        item_id: l.item_id,
        label: displayName(l.item_id, language),
        quantity_base: qty,
        base_unit: ing.base,
        value_inr: Math.round(qty * ing.price),
        stock_after: round3(this.stock(l.item_id) - qty),
      };
    });
  }

  /** Wastage/usage larger than what is in stock (any ingredient, for menu items). */
  exceedsStock(e: Entry): boolean {
    if (e.item_id === "unknown" || e.quantity_base == null) return false;
    if (this.isMenu(e.item_id)) return CONSUMES.has(e.action) && explode(e).some((d) => -d.amount > this.stock(d.item_id));
    if (e.action !== "wastage" && e.action !== "usage") return false;
    return e.quantity_base > this.stock(e.item_id);
  }

  inventory(): InventoryItem[] {
    return CATALOG.filter((i) => i.base !== "c" && !i.menu).map((i) => {
      const current = this.stock(i.id);
      return {
        item_id: i.id,
        label: i.names.en,
        base_unit: i.base,
        opening: i.opening,
        current,
        value_inr: Math.round(current * i.price),
        low: current < i.low_threshold,
        changed_at: this.changedAt.get(i.id) ?? null,
      };
    });
  }

  menu() {
    return MENU.map((m) => {
      const recipe = RECIPES[m.id] ?? [];
      let possible = Infinity;
      let limiting: string | null = null;
      for (const l of recipe) {
        const n = Math.floor(this.stock(l.item_id) / l.quantity_base);
        if (n < possible) { possible = n; limiting = l.item_id; }
      }
      return {
        item_id: m.id,
        label: m.names.en,
        cost_inr: m.price,
        portions_possible: recipe.length ? Math.max(0, possible) : 0,
        limiting_item: limiting,
        ingredients: recipe.map((l) => ({ item_id: l.item_id, label: BY_ID.get(l.item_id)!.names.en, quantity_base: l.quantity_base, base_unit: BY_ID.get(l.item_id)!.base, stock: this.stock(l.item_id) })),
      };
    });
  }

  stats(now: Date = new Date(), correctedIds: ReadonlySet<string> = new Set()) {
    const today = this.records.filter((r) => istDay(r.created_at) === istDay(now.toISOString()));
    const by_action: Record<string, number> = {};
    let wastage_inr = 0;
    let receiving_inr = 0;
    const languages = new Set<string>();
    const totals: number[] = [];
    let corrected_by_voice = 0;
    let clarified = 0;
    for (const r of today) {
      languages.add(r.language);
      if (r.timings) totals.push(r.timings.total_ms);
      if (r.clarified) clarified++;
      if (correctedIds.has(r.record_id)) corrected_by_voice++;
      for (const e of r.entries) {
        by_action[e.action] = (by_action[e.action] ?? 0) + 1;
        if (e.value_inr == null) continue;
        if (e.action === "wastage") wastage_inr += e.value_inr;
        if (e.action === "receiving") receiving_inr += e.value_inr;
      }
    }
    return {
      today: {
        entries: today.length,
        wastage_inr: Math.round(wastage_inr),
        receiving_inr: Math.round(receiving_inr),
        by_action,
        languages: [...languages],
        latency_ms: { p50: percentile(totals, 0.5), p99: percentile(totals, 0.99) },
        corrected_by_voice,
        clarified,
      },
    };
  }
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

function istDay(iso: string): string {
  return new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export { BY_ID };
