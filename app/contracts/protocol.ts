// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — shared by Client, Gateway and Interpreter. Do not edit.
// Every frame on the wire must pass ClientMsg.parse / ServerMsg.parse.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from "zod";

// ── Domain ───────────────────────────────────────────────────────────────────

export const ACTIONS = [
  "receiving", "usage", "wastage", "prep", "stock_count", "temperature_check", "cleaning", "incident",
] as const;
export const Action = z.enum(ACTIONS);
export type Action = z.infer<typeof Action>;

/** Units a speaker may use. "c" = degrees Celsius. "none" = nothing said. */
export const SPOKEN_UNITS = ["kg", "g", "l", "ml", "pcs", "dozen", "portion", "packet", "c", "none"] as const;
export const SpokenUnit = z.enum(SPOKEN_UNITS);
export type SpokenUnit = z.infer<typeof SpokenUnit>;

/** Units the catalog stores stock in. */
export const BASE_UNITS = ["kg", "l", "pcs", "portion", "c"] as const;
export const BaseUnit = z.enum(BASE_UNITS);
export type BaseUnit = z.infer<typeof BaseUnit>;

export const WARNINGS = [
  "unit_assumed",       // no unit spoken; catalog base unit assumed
  "unit_mismatch",      // spoken unit cannot convert to the item's base unit ("litre" of paneer)
  "missing_quantity",
  "unknown_item",       // item_id === "unknown"
  "exceeds_stock",      // wastage/usage larger than current stock (GATEWAY adds)
  "low_stt_confidence", // STT language_confidence < 0.5 (GATEWAY adds)
  "unresolved",         // clarification rounds exhausted
] as const;
export const Warning = z.enum(WARNINGS);
export type Warning = z.infer<typeof Warning>;

/** One ingredient consumed by a menu-item entry (GATEWAY fills from the recipe). */
export const Ingredient = z.object({
  item_id: z.string(),
  label: z.string(),                         // in the speaker's language
  quantity_base: z.number(),                 // total for this entry (recipe × portions)
  base_unit: BaseUnit,
  value_inr: z.number(),
  stock_after: z.number(),
});
export type Ingredient = z.infer<typeof Ingredient>;

/** One normalized log line. Interpreter produces it; Gateway fills stock_after; Client shows it. */
export const Entry = z.object({
  action: Action,
  item_id: z.string(),                      // catalog id, or "unknown"
  item_label: z.string(),                   // catalog name in the speaker's language; else item_heard
  item_heard: z.string(),                   // what was actually said
  quantity: z.number().nullable(),          // as spoken
  unit: SpokenUnit,                         // as spoken (or assumed → warning unit_assumed)
  quantity_base: z.number().nullable(),     // converted to base_unit by code, 3 dp
  base_unit: BaseUnit.nullable(),
  value_inr: z.number().nullable(),         // round(quantity_base × price); null when n/a
  reason: z.string().nullable(),            // short English: "spoiled", "burnt", "expired", "dropped"
  temperature_c: z.number().nullable(),
  stock_after: z.number().nullable(),       // GATEWAY fills from the ledger; interpreter sets null
  warnings: z.array(Warning),
  ingredients: z.array(Ingredient).optional(), // GATEWAY fills for menu items (recipe explosion); absent otherwise
});
export type Entry = z.infer<typeof Entry>;

export const Intent = z.enum(["log", "correction", "cancel", "unclear", "needs_clarification"]);
export type Intent = z.infer<typeof Intent>;

export const ClarifyField = z.enum(["item_id", "quantity", "unit", "reason", "action"]);

export const Clarification = z.object({
  field: ClarifyField,
  entry_index: z.number().int().min(0),
  question: z.string(),                     // speaker's language, native script
  options: z.array(z.object({               // tap targets; empty → free (voice) answer expected
    value: z.string(),                      // item_id | unit | action | reason text
    label: z.string(),                      // speaker's language
  })),
  round: z.number().int().min(1).max(2),
});
export type Clarification = z.infer<typeof Clarification>;

export const DraftMeta = z.object({
  model: z.string(),
  prompt_version: z.string(),
  llm_ms: z.number(),                       // 0 when served from the local result cache
  local_cache_hit: z.boolean(),
  prompt_cache_read_tokens: z.number(),
});

export const Draft = z.object({
  draft_id: z.string(),
  transcript: z.string(),
  language: z.string(),                     // BCP-47 the interpreter DECIDED (STT value is only a hint)
  intent: Intent,
  entries: z.array(Entry),
  confirm_text: z.string(),                 // speaker's language; "" unless intent is log/correction
  clarification: Clarification.nullable(),  // non-null iff intent === "needs_clarification"
  speak_text: z.string(),                   // what TTS says for this draft (question, confirm, or "didn't catch")
  replaced_pending: z.boolean(),            // true when a NEW log replaced an unconfirmed draft
  meta: DraftMeta,
});
export type Draft = z.infer<typeof Draft>;

export const Timings = z.object({
  stt_ms: z.number().nullable(),            // ptt.stop → stt final; null for typed text / tap answers
  llm_ms: z.number(),
  total_ms: z.number(),                     // ptt.stop (or text/answer received) → draft sent
});
export type Timings = z.infer<typeof Timings>;

export const LogRecord = z.object({
  record_id: z.string(),
  draft_id: z.string(),
  created_at: z.string(),                   // ISO 8601, UTC
  session_id: z.string(),
  language: z.string(),
  transcript: z.string(),
  entries: z.array(Entry),
  edited: z.boolean(),                      // staff changed something on the review card
  clarified: z.boolean(),                   // at least one clarification round happened
  photo_url: z.string().nullable(),         // "/photos/<record_id>.jpg", attached after save
  timings: Timings.nullable(),
  meta: DraftMeta,
});
export type LogRecord = z.infer<typeof LogRecord>;

export const EntryEdit = z.object({
  index: z.number().int().min(0),
  quantity: z.number().nullable().optional(),
  unit: SpokenUnit.optional(),
  item_id: z.string().optional(),
});
export type EntryEdit = z.infer<typeof EntryEdit>;

export const InventoryItem = z.object({
  item_id: z.string(),
  label: z.string(),                        // English name
  base_unit: BaseUnit,
  opening: z.number(),
  current: z.number(),
  value_inr: z.number(),                    // round(current × price)
  low: z.boolean(),
  changed_at: z.string().nullable(),        // ISO of the last record that touched it
});
export type InventoryItem = z.infer<typeof InventoryItem>;

/** What is happening on a staff phone right now (dashboards show it as a strip). */
export const Activity = z.object({
  session_id: z.string(),
  state: z.enum(["idle", "listening", "thinking", "asking", "reviewing"]),
  text: z.string(),                         // live transcript / question / card summary
  language: z.string().nullable(),
});
export type Activity = z.infer<typeof Activity>;

// ── WebSocket /ws : Client → Gateway ─────────────────────────────────────────
// Text frames: JSON matching ClientMsg. Binary frames: raw PCM s16le, mono, 16 kHz,
// 40 ms per frame (1280 bytes), sent only between ptt.start and ptt.stop.

export const ClientMsg = z.discriminatedUnion("type", [
  // Always the FIRST frame. Gateway opens STT + warms the interpreter on it.
  z.object({ type: z.literal("hello"), client_id: z.string(), role: z.enum(["staff", "dashboard"]) }),
  z.object({ type: z.literal("ptt.start"), turn: z.number().int() }),
  z.object({ type: z.literal("ptt.stop"), turn: z.number().int() }),
  // Typed fallback; same interpreter path, languageHint null.
  z.object({ type: z.literal("text"), turn: z.number().int(), text: z.string().min(1) }),
  // Tap answer to a clarification (voice answers just use ptt again).
  z.object({ type: z.literal("draft.answer"), draft_id: z.string(), value: z.string() }),
  z.object({ type: z.literal("draft.confirm"), draft_id: z.string(), edits: z.array(EntryEdit).optional() }),
  z.object({ type: z.literal("draft.cancel"), draft_id: z.string() }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

// ── WebSocket /ws : Gateway → Client ─────────────────────────────────────────

export const ERROR_CODES = [
  "BAD_MESSAGE", "STT_UNAVAILABLE", "EMPTY_TRANSCRIPT", "INTERPRET_FAILED", "DRAFT_NOT_FOUND", "NO_PENDING_DRAFT",
] as const;
export const ErrorCode = z.enum(ERROR_CODES);

export const ServerMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), session_id: z.string(), stt: z.enum(["ok", "down"]), tts: z.enum(["ok", "down"]), model: z.string() }),
  z.object({ type: z.literal("stt.partial"), turn: z.number().int(), text: z.string(), language: z.string().nullable() }),
  z.object({ type: z.literal("stt.final"), turn: z.number().int(), text: z.string(), language: z.string().nullable() }),
  // A new draft, a corrected draft, or a clarification question (see draft.intent).
  z.object({ type: z.literal("draft"), turn: z.number().int(), draft: Draft, timings: Timings }),
  z.object({ type: z.literal("draft.cleared"), draft_id: z.string(), reason: z.enum(["cancelled", "replaced", "confirmed", "expired"]) }),
  // One clip per spoken line. Client: stop any playing clip on ptt.start.
  z.object({ type: z.literal("tts"), ref: z.string(), text: z.string(), language: z.string(), audio_b64: z.string(), mime: z.literal("audio/wav") }),
  z.object({ type: z.literal("record.saved"), record: LogRecord }),                  // to the confirming client only
  z.object({ type: z.literal("record.new"), record: LogRecord }),                    // broadcast to every client
  z.object({ type: z.literal("record.updated"), record: LogRecord }),                // broadcast (photo attached)
  z.object({ type: z.literal("inventory.update"), items: z.array(InventoryItem) }),  // broadcast after every record
  z.object({ type: z.literal("activity"), activity: Activity }),                    // to dashboards only
  z.object({ type: z.literal("error"), code: ErrorCode, message: z.string(), turn: z.number().int().optional() }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerMsg = z.infer<typeof ServerMsg>;

// ── HTTP ─────────────────────────────────────────────────────────────────────

export const HealthRes = z.object({ ok: z.boolean(), stt: z.enum(["ok", "down"]), tts: z.enum(["ok", "down"]), model: z.string(), uptime_s: z.number() });

export const CatalogRes = z.object({
  items: z.array(z.object({
    id: z.string(), base: BaseUnit, price: z.number(), opening: z.number(), low_threshold: z.number(),
    names: z.record(z.string(), z.string()),
    menu: z.boolean().optional(),            // true = menu item, no stock of its own
  })),
  recipes: z.record(z.string(), z.array(z.object({ item_id: z.string(), quantity_base: z.number() }))).optional(),
});

/** Menu items with live "portions possible" from current stock. */
export const MenuRes = z.object({
  items: z.array(z.object({
    item_id: z.string(),
    label: z.string(),
    cost_inr: z.number(),                    // recipe cost per portion
    portions_possible: z.number(),           // floor(min over ingredients of stock / per-portion)
    limiting_item: z.string().nullable(),    // ingredient that runs out first
    ingredients: z.array(z.object({ item_id: z.string(), label: z.string(), quantity_base: z.number(), base_unit: BaseUnit, stock: z.number() })),
  })),
});

export const RecordsRes = z.object({ records: z.array(LogRecord) });          // newest first, ?limit= (default 50)
export const InventoryRes = z.object({ items: z.array(InventoryItem) });      // catalog order
export const StatsRes = z.object({
  today: z.object({
    entries: z.number(),
    wastage_inr: z.number(),
    receiving_inr: z.number(),
    by_action: z.record(z.string(), z.number()),
    languages: z.array(z.string()),                                          // distinct, e.g. ["hi-IN","kn-IN"]
    latency_ms: z.object({ p50: z.number().nullable(), p99: z.number().nullable() }),
    corrected_by_voice: z.number(),
    clarified: z.number(),
  }),
});
export const InterpretReq = z.object({ text: z.string().min(1), language: z.string().nullable().optional() });
export const InterpretRes = z.object({ draft: Draft, timings: Timings });    // debugging only
export const PhotoRes = z.object({ record_id: z.string(), photo_url: z.string() });

/*
HTTP routes (Gateway):
  GET  /                          app/public/index.html      (phone)
  GET  /dashboard                 app/public/dashboard.html  (owner)
  GET  /present                   app/public/present.html    (projector)
  GET  /healthz                   HealthRes
  GET  /api/catalog               CatalogRes
  GET  /api/records?limit=        RecordsRes
  GET  /api/inventory             InventoryRes
  GET  /api/menu                  MenuRes
  GET  /api/stats                 StatsRes
  POST /api/interpret             InterpretReq → InterpretRes
  POST /api/photo/:record_id      multipart field "photo" (image/jpeg ≤ 2 MB) → PhotoRes; broadcasts record.updated
  GET  /photos/:record_id.jpg
  WS   /ws
*/
