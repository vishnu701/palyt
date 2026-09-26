// One Session per staff WebSocket: the state machine from briefs/02-gateway.md.
import { randomUUID } from "node:crypto";
import type { Interpreter, RecordStore, SttProvider, SttSession, TtsProvider } from "../../contracts/interfaces";
import type { ClientMsg, Draft, Entry, LogRecord, ServerMsg, Timings, Activity } from "../../contracts/protocol";
import { Ledger } from "./ledger";
import { fixedLine } from "./speak";

export interface SessionDeps {
  interpreter: Interpreter;
  stt: SttProvider | null;
  tts: TtsProvider | null;
  store: RecordStore;
  ledger: Ledger;
  send: (msg: ServerMsg) => void;
  broadcastAll: (msg: ServerMsg) => void;
  broadcastDashboards: (msg: ServerMsg) => void;
  onRecordSaved?: (record: LogRecord, corrected: boolean) => void;
  finalTimeoutMs: number;
  pendingTtlMs: number;
  interpretTimeoutMs?: number;
  minHoldMs?: number;
}

type State = "idle" | "listening" | "finalizing" | "interpreting";

export class Session {
  readonly id = randomUUID();
  private state: State = "idle";
  private turn = 0;
  private stt: SttSession | null = null;
  private sttOk = false;
  private lastPartial: { text: string; language: string | null } = { text: "", language: null };
  private lastLanguage: string | null = null;
  private finalWaiter: ((f: { text: string; language: string | null; confidence: number | null }) => void) | null = null;
  private frames = 0;
  pending: Draft | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Facts about the chain of drafts behind the current pending one. */
  private chain = { clarified: false, corrected: false, timings: null as Timings | null };

  constructor(private readonly d: SessionDeps) {}

  async init(): Promise<{ stt: "ok" | "down" }> {
    if (this.d.stt) {
      try {
        this.stt = await this.d.stt.open({
          onPartial: (text, language) => this.onPartial(text, language),
          onFinal: (text, language, confidence) => this.finalWaiter?.({ text, language, confidence }),
          onError: (message, fatal) => { console.warn(`[stt ${this.id.slice(0, 8)}] ${message}`); if (fatal) this.sttOk = false; },
        });
        this.sttOk = true;
      } catch (err) {
        console.warn(`[stt ${this.id.slice(0, 8)}] open failed: ${(err as Error).message}`);
        this.sttOk = false;
      }
    }
    void this.d.interpreter.warm();
    return { stt: this.sttOk ? "ok" : "down" };
  }

  close() {
    this.stt?.close();
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.activity("idle", "");
  }

  // ── inbound ────────────────────────────────────────────────────────────────

  async onBinary(pcm: Uint8Array) {
    if (this.state !== "listening") return;
    this.frames++;
    this.stt?.audio(pcm);
  }

  async onMessage(msg: ClientMsg) {
    switch (msg.type) {
      case "ping": this.d.send({ type: "pong" }); return;
      case "ptt.start": return this.onStart(msg.turn);
      case "ptt.stop": return this.onStop(msg.turn);
      case "text": return this.runInterpret({ text: msg.text, languageHint: null, tapAnswer: false, turn: msg.turn, t0: performance.now(), stt_ms: null, confidence: null });
      case "draft.answer": {
        if (!this.pending) return this.d.send({ type: "error", code: "NO_PENDING_DRAFT", message: "No draft is waiting for an answer" });
        if (this.pending.draft_id !== msg.draft_id) return this.d.send({ type: "error", code: "DRAFT_NOT_FOUND", message: "That draft is no longer pending" });
        return this.runInterpret({ text: msg.value, languageHint: this.pending.language, tapAnswer: true, turn: this.turn, t0: performance.now(), stt_ms: null, confidence: null });
      }
      case "draft.confirm": return this.onConfirm(msg.draft_id, msg.edits ?? []);
      case "draft.cancel": {
        if (!this.pending || this.pending.draft_id !== msg.draft_id) return this.d.send({ type: "error", code: "DRAFT_NOT_FOUND", message: "That draft is no longer pending" });
        this.clearPending("cancelled");
        this.activity("idle", "");
        return;
      }
      case "hello": return; // handled by the server
    }
  }

  private async onStart(turn: number) {
    if (this.state === "listening") return;
    this.turn = turn;
    this.state = "listening";
    this.frames = 0;
    this.lastPartial = { text: "", language: null };
    if (this.stt) {
      try { await this.stt.start(); this.sttOk = true; }
      catch (err) { console.warn(`[stt ${this.id.slice(0, 8)}] start failed: ${(err as Error).message}`); this.sttOk = false; }
    }
    this.activity("listening", "");
  }

  private onPartial(text: string, language: string | null) {
    if (this.state !== "listening" && this.state !== "finalizing") return;
    this.lastPartial = { text, language };
    this.d.send({ type: "stt.partial", turn: this.turn, text, language });
    this.activity("listening", text, language);
  }

  private async onStop(turn: number) {
    if (this.state !== "listening" || turn !== this.turn) return;
    const t0 = performance.now();
    this.state = "finalizing";
    const heldMs = this.frames * 40;

    if (!this.stt || !this.sttOk) {
      this.state = "idle";
      this.d.send({ type: "error", code: "STT_UNAVAILABLE", message: "Speech recognition is unavailable; type instead", turn });
      this.activity(this.pending ? "reviewing" : "idle", this.pending ? summary(this.pending) : "");
      return;
    }

    const finalP = new Promise<{ text: string; language: string | null; confidence: number | null }>((resolve) => { this.finalWaiter = resolve; });
    this.stt.stop();
    const timeout = Bun.sleep(this.d.finalTimeoutMs).then(() => null);
    let final = await Promise.race([finalP, timeout]);
    this.finalWaiter = null;
    if (final === null) {
      console.warn(`[stt ${this.id.slice(0, 8)}] final timeout; using last partial`);
      final = { ...this.lastPartial, confidence: null };
    }
    const stt_ms = Math.round(performance.now() - t0);
    const text = heldMs < (this.d.minHoldMs ?? 300) ? "" : final.text.trim();
    const language = final.language ?? this.lastPartial.language;
    if (language) this.lastLanguage = language;
    this.d.send({ type: "stt.final", turn, text, language: text ? language : null });

    if (!text) {
      this.state = "idle";
      this.d.send({ type: "error", code: "EMPTY_TRANSCRIPT", message: "Didn't catch that", turn });
      const line = fixedLine("didnt_catch", this.lastLanguage);
      void this.speak(`turn-${turn}`, line.text, line.language);
      this.activity(this.pending ? "reviewing" : "idle", this.pending ? summary(this.pending) : "");
      return;
    }
    await this.runInterpret({ text, languageHint: language, tapAnswer: false, turn, t0, stt_ms, confidence: final.confidence });
  }

  // ── interpret ──────────────────────────────────────────────────────────────

  private async runInterpret(a: { text: string; languageHint: string | null; tapAnswer: boolean; turn: number; t0: number; stt_ms: number | null; confidence: number | null }) {
    this.state = "interpreting";
    this.activity("thinking", a.text, a.languageHint);
    let draft: Draft;
    let llm_ms = 0;
    try {
      const timeout = Bun.sleep(this.d.interpretTimeoutMs ?? 8000).then(() => { throw new Error("interpreter timeout"); });
      const t = performance.now();
      draft = await Promise.race([this.d.interpreter.interpret({ text: a.text, languageHint: a.languageHint, pending: this.pending, tapAnswer: a.tapAnswer }), timeout]);
      llm_ms = draft.meta.llm_ms || Math.round(performance.now() - t);
    } catch (err) {
      console.error(`[interpret ${this.id.slice(0, 8)}] ${(err as Error).message}`);
      this.state = "idle";
      this.d.send({ type: "error", code: "INTERPRET_FAILED", message: (err as Error).message, turn: a.turn });
      const line = fixedLine("failed", a.languageHint ?? this.lastLanguage);
      void this.speak(`turn-${a.turn}`, line.text, line.language);
      this.activity(this.pending ? "reviewing" : "idle", this.pending ? summary(this.pending) : "");
      return;
    }

    // Gateway-owned fields.
    draft.entries = draft.entries.map((e) => this.decorate(e, a.confidence, draft.language));
    const timings: Timings = { stt_ms: a.stt_ms, llm_ms, total_ms: Math.round(performance.now() - a.t0) };
    this.lastLanguage = draft.language;

    switch (draft.intent) {
      case "needs_clarification": {
        this.chain.clarified = true;
        const prev = this.replacePending(draft, timings);
        this.d.send({ type: "draft", turn: a.turn, draft, timings });
        if (prev) this.d.send({ type: "draft.cleared", draft_id: prev, reason: "replaced" });
        void this.speak(draft.draft_id, draft.speak_text, draft.language);
        this.activity("asking", draft.clarification?.question ?? draft.speak_text, draft.language);
        break;
      }
      case "log":
      case "correction": {
        if (draft.intent === "correction") this.chain.corrected = true;
        if (draft.replaced_pending) this.chain = { clarified: false, corrected: false, timings: null };
        const prev = this.replacePending(draft, timings);
        this.d.send({ type: "draft", turn: a.turn, draft, timings });
        if (prev) this.d.send({ type: "draft.cleared", draft_id: prev, reason: "replaced" });
        void this.speak(draft.draft_id, draft.speak_text, draft.language);
        this.activity("reviewing", summary(draft), draft.language);
        break;
      }
      case "cancel": {
        if (this.pending) this.clearPending("cancelled");
        this.d.send({ type: "draft", turn: a.turn, draft, timings });
        void this.speak(draft.draft_id, draft.speak_text, draft.language);
        this.activity("idle", "");
        break;
      }
      case "unclear": {
        this.d.send({ type: "draft", turn: a.turn, draft, timings });
        void this.speak(draft.draft_id, draft.speak_text, draft.language);
        this.activity(this.pending ? "reviewing" : "idle", this.pending ? summary(this.pending) : "");
        break;
      }
    }
    this.state = "idle";
  }

  private decorate(e: Entry, confidence: number | null, language = this.lastLanguage ?? "en-IN"): Entry {
    const warnings = [...e.warnings];
    if (this.d.ledger.exceedsStock(e) && !warnings.includes("exceeds_stock")) warnings.push("exceeds_stock");
    if (confidence != null && confidence < 0.5 && !warnings.includes("low_stt_confidence")) warnings.push("low_stt_confidence");
    const ingredients = this.d.ledger.ingredients(e, language);
    return { ...e, stock_after: this.d.ledger.stockAfter(e), warnings, ...(ingredients ? { ingredients } : {}) };
  }

  /** Makes `draft` the pending one. Returns the previous draft_id so the caller can send
   *  `draft.cleared replaced` AFTER the new `draft` frame (fixture order). */
  private replacePending(draft: Draft, timings: Timings): string | null {
    const prev = this.pending && this.pending.draft_id !== draft.draft_id ? this.pending.draft_id : null;
    this.pending = draft;
    this.chain.timings = timings;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => { if (this.pending) { this.clearPending("expired"); this.activity("idle", ""); } }, this.d.pendingTtlMs);
    return prev;
  }

  private clearPending(reason: "cancelled" | "replaced" | "confirmed" | "expired") {
    if (!this.pending) return;
    const id = this.pending.draft_id;
    this.pending = null;
    this.chain = { clarified: false, corrected: false, timings: null };
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
    this.d.send({ type: "draft.cleared", draft_id: id, reason });
  }

  // ── confirm ────────────────────────────────────────────────────────────────

  private async onConfirm(draft_id: string, edits: { index: number; quantity?: number | null; unit?: Entry["unit"]; item_id?: string }[]) {
    const p = this.pending;
    if (!p || p.draft_id !== draft_id) return this.d.send({ type: "error", code: "DRAFT_NOT_FOUND", message: "That draft is no longer pending" });
    if (p.intent === "needs_clarification") return this.d.send({ type: "error", code: "BAD_MESSAGE", message: "Answer the question first" });

    let entries = edits.length ? this.d.interpreter.applyEdits(p.entries, edits, p.language) : p.entries;
    entries = entries.map((e) => this.decorate(e, null, p.language));
    const record: LogRecord = {
      record_id: randomUUID(),
      draft_id: p.draft_id,
      created_at: new Date().toISOString(),
      session_id: this.id,
      language: p.language,
      transcript: p.transcript,
      entries,
      edited: edits.length > 0,
      clarified: this.chain.clarified,
      photo_url: null,
      timings: this.chain.timings,
      meta: p.meta,
    };
    const corrected = this.chain.corrected;

    await this.d.store.append(record);
    this.d.ledger.apply(record);
    this.d.onRecordSaved?.(record, corrected);
    this.d.send({ type: "record.saved", record });
    this.clearPending("confirmed");
    this.d.broadcastAll({ type: "record.new", record });
    this.d.broadcastAll({ type: "inventory.update", items: this.d.ledger.inventory() });
    void this.speak(record.record_id, this.d.interpreter.readback(record), record.language);
    this.activity("idle", "");
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async speak(ref: string, text: string, language: string) {
    if (!this.d.tts || !text) return;
    try {
      const { audio_b64 } = await this.d.tts.synthesize(text, language);
      this.d.send({ type: "tts", ref, text, language, audio_b64, mime: "audio/wav" });
    } catch (err) {
      console.warn(`[tts ${this.id.slice(0, 8)}] ${(err as Error).message}`);
    }
  }

  private activity(state: Activity["state"], text: string, language: string | null = this.lastLanguage) {
    this.d.broadcastDashboards({ type: "activity", activity: { session_id: this.id, state, text, language } });
  }
}

function summary(d: Draft): string {
  return d.entries.map((e) => `${e.item_label} · ${e.quantity ?? "?"} ${e.unit === "none" ? "" : e.unit} · ${e.action}`).join(" ; ");
}
