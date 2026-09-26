// Fakes for tests and for running the gateway before the real interpreter/providers exist.
// FakeInterpreter is driven by the transcripts in contracts/fixtures/session.json.
import { randomUUID } from "node:crypto";
import type { Interpreter, InterpretRequest, SttCallbacks, SttProvider, SttSession, TtsProvider } from "../../contracts/interfaces";
import { BY_ID, displayName } from "../../contracts/catalog";
import type { Draft, Entry, EntryEdit, LogRecord } from "../../contracts/protocol";

const META = { model: "fake", prompt_version: "fake", llm_ms: 0, local_cache_hit: false, prompt_cache_read_tokens: 0 };

function entry(p: Partial<Entry> & { action: Entry["action"]; item_id: string; unit: Entry["unit"] }, language: string): Entry {
  const item = BY_ID.get(p.item_id);
  const qb = p.quantity_base ?? (item && p.quantity != null ? p.quantity : null);
  return {
    action: p.action,
    item_id: p.item_id,
    item_label: p.item_label ?? (item ? displayName(p.item_id, language) : p.item_heard ?? p.item_id),
    item_heard: p.item_heard ?? p.item_label ?? p.item_id,
    quantity: p.quantity ?? null,
    unit: p.unit,
    quantity_base: item ? qb : null,
    base_unit: item ? item.base : null,
    value_inr: item && qb != null && item.price > 0 ? Math.round(qb * item.price) : null,
    reason: p.reason ?? null,
    temperature_c: p.temperature_c ?? null,
    stock_after: null,
    warnings: p.warnings ?? [],
  };
}

function draft(p: Partial<Draft> & { transcript: string; language: string; intent: Draft["intent"] }): Draft {
  return {
    draft_id: randomUUID(),
    transcript: p.transcript,
    language: p.language,
    intent: p.intent,
    entries: p.entries ?? [],
    confirm_text: p.confirm_text ?? "",
    clarification: p.clarification ?? null,
    speak_text: p.speak_text ?? p.confirm_text ?? p.clarification?.question ?? "",
    replaced_pending: p.replaced_pending ?? false,
    meta: { ...META },
  };
}

export class FakeInterpreter implements Interpreter {
  readonly model = "fake";
  warmCalls = 0;
  delayMs = 0;

  async warm() { this.warmCalls++; }

  async interpret(req: InterpretRequest): Promise<Draft> {
    if (this.delayMs) await Bun.sleep(this.delayMs);
    const text = req.text.trim();
    const pending = req.pending;

    if (req.tapAnswer && pending?.clarification) {
      const { item_label: _old, quantity_base: _qb, ...e } = pending.entries[pending.clarification.entry_index]!;
      const fixed = entry({ ...e, item_id: text }, pending.language);
      const line = `${fixed.quantity} किलो ${fixed.item_label} आया — सही है?`;
      return draft({ transcript: pending.transcript, language: pending.language, intent: "log", entries: [fixed], confirm_text: line, speak_text: line });
    }
    if (text === "ಇಪ್ಪತ್ತು ಲೀಟರ್ ಹಾಲು ಬಂದಿದೆ") {
      const line = "20 ಲೀಟರ್ ಹಾಲು ಬಂದಿದೆ — ಸರಿಯೇ?";
      return draft({ transcript: text, language: "kn-IN", intent: "log", confirm_text: line, speak_text: line,
        entries: [entry({ action: "receiving", item_id: "milk", item_heard: "ಹಾಲು", quantity: 20, unit: "l" }, "kn-IN")] });
    }
    if (text === "दस किलो चावल आया") {
      const q = "कौन सा चावल — बासमती या साधारण?";
      return draft({ transcript: text, language: "hi-IN", intent: "needs_clarification", speak_text: q,
        clarification: { field: "item_id", entry_index: 0, round: 1, question: q, options: [
          { value: "rice_basmati", label: "बासमती चावल" }, { value: "rice", label: "साधारण चावल" } ] },
        entries: [{ ...entry({ action: "receiving", item_id: "unknown", item_heard: "चावल", item_label: "चावल", quantity: 10, unit: "kg" }, "hi-IN") }] });
    }
    if (text === "twenty eggs received") {
      const line = "20 eggs received — is this correct?";
      return draft({ transcript: text, language: "en-IN", intent: "log", confirm_text: line, speak_text: line,
        entries: [entry({ action: "receiving", item_id: "eggs", item_heard: "eggs", quantity: 20, unit: "pcs" }, "en-IN")] });
    }
    if (text === "पाँच किलो पनीर खराब हो गया") {
      const line = "5 किलो पनीर खराब हुआ — क्या यह सही है?";
      return draft({ transcript: text, language: "hi-IN", intent: "log", confirm_text: line, speak_text: line,
        entries: [entry({ action: "wastage", item_id: "paneer", item_heard: "पनीर", quantity: 5, unit: "kg", reason: "spoiled" }, "hi-IN")] });
    }
    if (/cancel|रहने दो/.test(text)) return draft({ transcript: text, language: "hi-IN", intent: "cancel", speak_text: "ठीक है, हटा दिया।" });
    if (pending && /^नहीं/.test(text)) {
      const e = { ...pending.entries[0]!, quantity: 3 };
      const fixed = entry(e, pending.language);
      const line = "3 किलो पनीर खराब हुआ — क्या यह सही है?";
      return draft({ transcript: text, language: pending.language, intent: "correction", entries: [fixed], confirm_text: line, speak_text: line });
    }
    return draft({ transcript: text, language: req.languageHint ?? "hi-IN", intent: "unclear", speak_text: "समझ नहीं आया, फिर से बोलें।" });
  }

  applyEdits(entries: Entry[], edits: EntryEdit[], language: string): Entry[] {
    const out = entries.map((e) => ({ ...e }));
    for (const ed of edits) {
      const e = out[ed.index];
      if (!e) continue;
      const next = { ...e };
      if (ed.quantity !== undefined) next.quantity = ed.quantity;
      if (ed.unit !== undefined) next.unit = ed.unit;
      if (ed.item_id !== undefined) next.item_id = ed.item_id;
      out[ed.index] = entry({ ...next, item_heard: e.item_heard, item_label: ed.item_id ? undefined : e.item_label, quantity_base: undefined }, language);
    }
    return out;
  }

  readback(record: LogRecord): string {
    const e = record.entries[0];
    if (!e) return "दर्ज हो गया।";
    return `${e.quantity ?? ""} ${e.unit} ${e.item_label}, दर्ज हो गया।${e.stock_after != null ? ` बचा ${e.stock_after}।` : ""}`;
  }
}

/** Scriptable STT. Tests call `script()` before a turn; each audio frame emits the next partial; stop() emits the final. */
export interface SttTurnScript { partials: { text: string; language: string | null }[]; final: { text: string; language: string | null; confidence: number | null } | null; finalDelayMs?: number }

export class FakeSttProvider implements SttProvider {
  sessions: FakeSttSession[] = [];
  next: SttTurnScript[] = [];
  script(t: SttTurnScript) { this.next.push(t); }
  async open(cb: SttCallbacks): Promise<SttSession> {
    const s = new FakeSttSession(cb, () => this.next.shift() ?? { partials: [], final: { text: "", language: null, confidence: null } });
    this.sessions.push(s);
    return s;
  }
}

export class FakeSttSession implements SttSession {
  alive = true;
  starts = 0;
  reopens = 0;
  private turn: SttTurnScript | null = null;
  private i = 0;
  constructor(private cb: SttCallbacks, private nextTurn: () => SttTurnScript) {}
  async start() { this.starts++; if (!this.alive) { this.alive = true; this.reopens++; } this.turn = this.nextTurn(); this.i = 0; }
  audio(_pcm: Uint8Array) {
    const p = this.turn?.partials[this.i++];
    if (p) queueMicrotask(() => this.cb.onPartial(p.text, p.language));
  }
  stop() {
    const t = this.turn;
    if (!t || !t.final) return; // simulate a lost final
    const f = t.final;
    setTimeout(() => this.cb.onFinal(f.text, f.language, f.confidence), t.finalDelayMs ?? 0);
  }
  close() { this.alive = false; }
  kill() { this.alive = false; }
}

export class FakeTtsProvider implements TtsProvider {
  calls: { text: string; language: string }[] = [];
  delayMs = 0;
  async synthesize(text: string, language: string) {
    this.calls.push({ text, language });
    if (this.delayMs) await Bun.sleep(this.delayMs);
    return { audio_b64: "UklGRgAAAABXQVZF" };
  }
}
