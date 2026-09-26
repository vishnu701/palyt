// Interpreter: transcript (+ language hint + pending draft) → Draft. One model call per
// turn; tap answers and cache hits make none. Gateway sees only the `Interpreter` interface.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { BY_ID } from "../../contracts/catalog";
import type { Interpreter, InterpretRequest, RawEntry } from "../../contracts/interfaces";
import { Draft, SpokenUnit, type Entry, type EntryEdit, type LogRecord } from "../../contracts/protocol";
import { DraftCache, cacheKey } from "./cache";
import { nextRound, resolveClarification } from "./gaps";
import { normLang, normalizeEntry, renormalize, toRaw as entryToRaw } from "./normalize";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt";
import { ModelOutput, type ModelEntry } from "./schema";
import { cancelledText, confirmText, readbackText, unclearText } from "./text";
import { extractNumbers, extractUnits, repairAction, matchItemAnswer, findItemsInText, entriesFromText } from "./transcript";

export { PROMPT_VERSION } from "./prompt";
export { normalizeEntry } from "./normalize";
export { findGap } from "./gaps";

const DEFAULT_MODEL = "claude-opus-5";

// ONE block, cache_control on it, nothing variable inside — reused by interpret() and warm().
const SYSTEM_BLOCK: TextBlockParam[] = [
  { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
];

export interface InterpreterOptions {
  model?: string;
  apiKey?: string;
}

function isHaiku(model: string): boolean {
  return model.startsWith("claude-haiku");
}

/** What the model sees about the pending card: enough to decide correction/replace/cancel/answer. */
function describePending(p: Draft): string {
  const entries = p.entries.map((e, i) => ({
    index: i, action: e.action, item_id: e.item_id, item_heard: e.item_heard,
    quantity: e.quantity, unit: e.unit, reason: e.reason, temperature_c: e.temperature_c,
  }));
  const open = p.clarification
    ? { field: p.clarification.field, entry_index: p.clarification.entry_index, question: p.clarification.question, options: p.clarification.options.map((o) => o.value) }
    : null;
  return JSON.stringify({ language: p.language, intent: p.intent, entries, open_question: open });
}

function userTurn(req: InterpretRequest): string {
  return [
    `language_hint: ${req.languageHint ?? "none"}`,
    `pending_draft: ${req.pending ? describePending(req.pending) : "none"}`,
    `transcript: ${req.text}`,
  ].join("\n");
}

function fromModel(e: ModelEntry, text: string): RawEntry {
  return {
    action: repairAction(e.action, text), candidates: e.candidates, item_heard: e.item_heard,
    quantity: e.quantity, unit: e.unit, reason: e.reason, temperature_c: e.temperature_c,
  };
}

export function createInterpreter(opts: InterpreterOptions = {}): Interpreter {
  const model = opts.model ?? process.env.CLAUDE_MODEL ?? DEFAULT_MODEL;
  const client = new Anthropic({ apiKey: opts.apiKey, timeout: 8000, maxRetries: 1 });
  const cache = new DraftCache(500);
  const format = zodOutputFormat(ModelOutput);
  const haiku = isHaiku(model);

  const meta = (llm_ms: number, cacheRead: number) => ({
    model: provider === "sarvam" ? sarvamModel : model, prompt_version: PROMPT_VERSION, llm_ms, local_cache_hit: false, prompt_cache_read_tokens: cacheRead,
  });

  /** Tap on an option: no model. Patch the pending entry, re-normalize, re-check gaps. */
  function answerByTap(req: InterpretRequest, pending: Draft): Draft {
    const c = pending.clarification!;
    const language = pending.language;
    const entries = pending.entries.slice();
    const target = entries[c.entry_index];
    if (!target) throw new Error("pending clarification points at a missing entry");
    const value = req.text.trim();
    const patch: { quantity?: number | null; unit?: SpokenUnit; item_id?: string } = {};
    if (c.field === "item_id") patch.item_id = value;
    else if (c.field === "unit") patch.unit = SpokenUnit.parse(value);
    else if (c.field === "quantity") {
      const nums = extractNumbers(value);
      const n = nums.length === 1 ? nums[0]! : Number(value.replace(/[^\d.]/g, ""));
      patch.quantity = Number.isFinite(n) && value !== "" ? n : null;
      const units = extractUnits(value);
      if (units.length === 1) patch.unit = units[0]!;
    } else {
      // reason / action from a model-proposed question: reason is free text, action is an enum
      entries[c.entry_index] = c.field === "reason"
        ? { ...target, reason: value }
        : renormalize({ ...target, action: Draft.shape.entries.element.shape.action.parse(value) }, {}, language);
    }
    if (Object.keys(patch).length) entries[c.entry_index] = renormalize(target, patch, language);

    const raws = entries.map((e) => entryToRaw(e));
    const { clarification, entries: finalEntries } = resolveClarification(entries, raws, pending, language, null);
    const intent = clarification ? "needs_clarification" : (pending.intent === "correction" ? "correction" : "log");
    const confirm = clarification ? "" : confirmText(finalEntries, language);
    return Draft.parse({
      draft_id: crypto.randomUUID(),
      transcript: req.text,
      language,
      intent,
      entries: finalEntries,
      confirm_text: confirm,
      clarification,
      speak_text: clarification ? clarification.question : confirm,
      replaced_pending: false,
      meta: meta(0, 0),
    });
  }

  // Sampling shape. Measured 2026-09-26 (Opus 5, 4.7K-token cached prompt, ~95 output tokens):
  //   structured output (output_config.format) → first token ~2.3 s, whole answer in one burst
  //   plain JSON in the prompt, thinking off      → first token ~1.26 s, done ~1.9 s
  // So the primary path asks for JSON in the prompt and validates with zod; the structured-output
  // call is kept only as a fallback for the rare malformed reply.
  const SAMPLING = haiku ? {} : { thinking: { type: "disabled" as const }, output_config: { effort: "low" as const } };

  function extractJson(text: string): unknown {
    const cleaned = text.replace(/```(?:json)?/gi, "").trim();
    const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
    if (a < 0 || b <= a) throw new Error("no JSON object in reply");
    return JSON.parse(cleaned.slice(a, b + 1));
  }

  // Alternative provider: Sarvam chat completions (India-hosted; ~0.4 s per turn). Enabled with
  // LLM_PROVIDER=sarvam; model from SARVAM_LLM_MODEL (default sarvam-105b-conversations).
  const provider = process.env.LLM_PROVIDER === "sarvam" ? "sarvam" : "anthropic";
  const sarvamModel = process.env.SARVAM_LLM_MODEL ?? "sarvam-105b-conversations";
  async function callSarvam(req: InterpretRequest): Promise<{ out: ModelOutput; llm_ms: number; cacheRead: number }> {
    const t0 = performance.now();
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { "api-subscription-key": process.env.SARVAM_API_KEY ?? "", "content-type": "application/json" },
      body: JSON.stringify({ model: sarvamModel, temperature: 0, max_tokens: 400, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userTurn(req) }] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`sarvam llm ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = (body.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
    const out = ModelOutput.parse(extractJson(text));
    return { out, llm_ms: Math.round(performance.now() - t0), cacheRead: 0 };
  }

  async function callModel(req: InterpretRequest): Promise<{ out: ModelOutput; llm_ms: number; cacheRead: number }> {
    if (provider === "sarvam") return callSarvam(req);
    const t0 = performance.now();
    const messages = [{ role: "user" as const, content: userTurn(req) }];
    const res = await client.messages.create({ model, max_tokens: 400, ...SAMPLING, system: SYSTEM_BLOCK, messages });
    if (res.stop_reason === "refusal") throw new Error("model refused the transcript");
    const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    const parsed = (() => { try { return ModelOutput.safeParse(extractJson(text)); } catch (e) { return { success: false as const, error: e as Error }; } })();
    if (parsed.success) {
      return { out: parsed.data, llm_ms: Math.round(performance.now() - t0), cacheRead: res.usage.cache_read_input_tokens ?? 0 };
    }
    console.warn(`[interpreter] JSON reply invalid (${(parsed as { error: { message: string } }).error.message.slice(0, 120)}); retrying with structured output`);
    const res2 = await client.messages.parse({
      model, max_tokens: 400,
      ...(haiku ? {} : { thinking: { type: "adaptive" as const } }),
      output_config: { format, ...(haiku ? {} : { effort: "low" as const }) },
      system: SYSTEM_BLOCK, messages,
    });
    if (res2.stop_reason === "refusal") throw new Error("model refused the transcript");
    if (!res2.parsed_output) throw new Error(`model returned no parsable output (stop_reason=${res2.stop_reason})`);
    return { out: ModelOutput.parse(res2.parsed_output), llm_ms: Math.round(performance.now() - t0), cacheRead: res2.usage.cache_read_input_tokens ?? 0 };
  }

  async function interpret(req: InterpretRequest): Promise<Draft> {
    if (!req.text.trim()) throw new Error("empty transcript");
    const pending = req.pending;

    if (req.tapAnswer && pending?.clarification) return answerByTap(req, pending);

    // Voice answers to our own question are resolved in code whenever the text is unambiguous
    // (instant, deterministic); the model only sees answers it cannot parse.
    if (pending?.clarification && !req.tapAnswer) {
      const c = pending.clarification;
      if (c.field === "item_id") {
        const id = matchItemAnswer(req.text, c.options.length ? c.options.map((o) => o.value) : null);
        if (id) return answerByTap({ ...req, text: id, tapAnswer: true }, pending);
      } else if (c.field === "quantity") {
        if (extractNumbers(req.text).length === 1) return answerByTap({ ...req, tapAnswer: true }, pending);
      } else if (c.field === "unit") {
        const units = extractUnits(req.text);
        if (units.length === 1) return answerByTap({ ...req, text: units[0]!, tapAnswer: true }, pending);
      }
    }

    const key = cacheKey(req.text, req.languageHint, pending);
    const hit = cache.get(key);
    if (hit) return hit;

    const { out, llm_ms, cacheRead } = await callModel(req);
    const language = normLang(out.language, normLang(req.languageHint, "en-IN"));

    let intent: Draft["intent"] = out.intent;
    if ((intent === "correction" || intent === "cancel") && !pending) intent = out.entries.length ? "log" : "unclear";
    // Model returned no entries (or a "cancel" nobody said) although the text names a catalog
    // item with a quantity: build the entries from the text. The model never gets to lose a log line.
    const saidCancel = /rehne do|rahne do|chhod|chod do|cancel|beda|nako|galat|रहने दो|छोड़|रद्द|ರದ್ದು|ಬೇಡ|नको/iu.test(req.text);
    if (!out.entries.length && (intent === "unclear" || (intent === "cancel" && !saidCancel))) {
      const built = entriesFromText(req.text);
      if (built.length && built.some((b) => b.quantity != null)) { out.entries = built; intent = "log"; }
    }
    // SPEC §10, decided in code: while a card is pending (no open question), an utterance about a
    // DIFFERENT item is a new entry that replaces the card; the same item is a correction.
    if (pending && !pending.clarification && out.entries.length && (intent === "log" || intent === "correction")) {
      const pendingIds = new Set(pending.entries.map((e) => e.item_id));
      const sameItem = out.entries.some((e) => e.candidates.some((c) => pendingIds.has(c)));
      intent = sameItem ? "correction" : "log";
      out.replaced_pending = !sameItem;
    }

    const raws = out.entries.map((e) => fromModel(e, req.text));
    // The catalog lives in code: when the model says "no match" but item_heard (or, for a single
    // entry, the whole transcript) names a catalog item in any script, fill candidates from the text.
    // Also, when item_heard itself names catalog items, those override a sloppy candidate list
    // (Sarvam once gave both entries of "makhan aur dahi" the same ["butter","curd"]).
    for (const r of raws) {
      const heard = findItemsInText(r.item_heard);
      if (heard.length) {
        const both = heard.filter((id) => r.candidates.includes(id));
        r.candidates = both.length ? both : heard;
      } else if (!r.candidates.length && raws.length === 1) {
        r.candidates = findItemsInText(req.text);
      }
    }
    // Answer path: entries the previous round already resolved stay resolved. The model only
    // gets to change the entry the question was about; elsewhere it must not "forget" an id
    // or a quantity it had (observed once: rice_basmati → [] after answering about tomato).
    // What the transcript states literally beats what the model wrote: quantities and unit words
    // are read from the text when they line up one-to-one with the entries.
    if (!pending?.clarification && raws.length) {
      const nums = extractNumbers(req.text);
      const units = extractUnits(req.text);
      // "aadha kilo makhan aur dedh kilo dahi" sometimes comes back as ONE entry with two
      // candidates. Two quantities + a conjunction + one entry per quantity's worth of candidates
      // → it was two items: split, one entry per candidate, in order.
      if (raws.length === 1 && nums.length >= 2 && raws[0]!.candidates.length === nums.length && /\b(aur|and|mattu|ani|matte)\b|और|आणि|ಮತ್ತು|மற்றும்|మరియు/iu.test(req.text)) {
        const r0 = raws[0]!;
        raws.splice(0, 1, ...r0.candidates.map((id) => ({ ...r0, candidates: [id], item_heard: id })));
      }
      if (nums.length === raws.length) raws.forEach((r, i) => { if (r.action === "temperature_check") r.temperature_c = nums[i]!; else r.quantity = nums[i]!; });
      if (units.length === raws.length) raws.forEach((r, i) => { r.unit = r.action === "temperature_check" ? "c" : units[i]!; });
      else if (units.length === 0 && !pending) raws.forEach((r) => { if (r.action !== "temperature_check") r.unit = "none"; });
    }
    if (pending?.clarification && (out.intent === "log" || out.intent === "correction") && !out.replaced_pending) {
      // An answer changes only the entry that was asked about. Every other entry is copied
      // verbatim from the pending draft (models sometimes drop or alter them), and if the model
      // returned nothing for the asked entry, that entry is kept as it was (still unknown → flagged).
      const asked = pending.clarification.entry_index;
      const fromModel_ = raws[asked] ?? raws.find((r) => r.candidates.length) ?? null;
      const rebuilt = pending.entries.map((pe, i) => {
        if (i === asked) return fromModel_ ? { ...fromModel_, quantity: fromModel_.quantity ?? pe.quantity, unit: fromModel_.unit === "none" ? pe.unit : fromModel_.unit } : entryToRaw(pe, pe.item_id === "unknown" ? [] : [pe.item_id]);
        return entryToRaw(pe, pe.item_id === "unknown" ? [] : [pe.item_id]);
      });
      raws.splice(0, raws.length, ...rebuilt);
    }
    let entries: Entry[] = intent === "cancel" || intent === "unclear" ? [] : raws.map((r) => normalizeEntry(r, language));

    let clarification: Draft["clarification"] = null;
    if (intent === "log" || intent === "correction") {
      const resolved = resolveClarification(entries, raws, pending, language, null);
      clarification = resolved.clarification;
      entries = resolved.entries;
    }
    if (clarification) intent = "needs_clarification";

    // A new log while a plain card (no open question) is pending necessarily replaces it.
    const replaced_pending = !!pending && (
      (intent === "log" && (pending.clarification ? out.replaced_pending : true))
      || (intent === "needs_clarification" && !pending.clarification)
    );

    const confirm_text = (intent === "log" || intent === "correction")
      ? confirmText(entries, language)
      : "";
    const speak_text = clarification ? clarification.question
      : intent === "cancel" ? cancelledText(language)
      : intent === "unclear" ? unclearText(language)
      : confirm_text;

    const draft = Draft.parse({
      draft_id: crypto.randomUUID(),
      transcript: req.text,
      language,
      intent,
      entries,
      confirm_text,
      clarification,
      speak_text,
      replaced_pending,
      meta: meta(llm_ms, cacheRead),
    });
    cache.set(key, draft);
    return draft;
  }

  async function warm(): Promise<void> {
    try {
      // Same prefix as the primary call (system block; no output format), 1 output token.
      await client.messages.create({ model, max_tokens: 1, ...SAMPLING, system: SYSTEM_BLOCK, messages: [{ role: "user", content: "warm" }] });
    } catch {
      // never throws; a failed warm-up only costs latency on the first real call
    }
  }

  function applyEdits(entries: Entry[], edits: EntryEdit[], language: string): Entry[] {
    const out = entries.slice();
    for (const edit of edits) {
      const cur = out[edit.index];
      if (!cur) continue;
      const patch: { quantity?: number | null; unit?: SpokenUnit; item_id?: string } = {};
      if (edit.quantity !== undefined) patch.quantity = edit.quantity;
      if (edit.unit !== undefined) patch.unit = edit.unit;
      if (edit.item_id !== undefined && (edit.item_id === "unknown" || BY_ID.has(edit.item_id))) patch.item_id = edit.item_id;
      out[edit.index] = renormalize(cur, patch, language);
    }
    return out;
  }

  function readback(record: LogRecord): string {
    return readbackText(record.entries, record.language);
  }

  return { interpret, warm, applyEdits, readback };
}

export { nextRound };
