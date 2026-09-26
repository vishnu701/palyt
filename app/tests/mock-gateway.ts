// Mock gateway for the Client agent. Replays contracts/fixtures/session.json over a real
// Bun.serve WebSocket, serves app/public statically and fakes the /api/* routes from the
// catalog plus an in-memory ledger. Every frame it sends passes ServerMsg.parse.
//
//   bun run app/tests/mock-gateway.ts            → http://localhost:3001
//   MOCK_PORT=3005 bun run app/tests/mock-gateway.ts
//
// From tests: `const mock = startMock({ port: 0 }); … mock.stop()`.
import { CATALOG, BY_ID, displayName } from "../contracts/catalog";
import {
  ClientMsg, ServerMsg, type Draft, type Entry, type EntryEdit, type InventoryItem,
  type LogRecord, type SpokenUnit, type BaseUnit, type Activity,
} from "../contracts/protocol";
import fixture from "../contracts/fixtures/session.json";
import { join, normalize } from "node:path";

type Step = { send: Record<string, unknown>; expect: Record<string, unknown>[] };
const STEPS: Step[] = (fixture.steps as Step[]).filter((s) => s.send.type !== "hello" && s.send.type !== "ping");

const FAKE_META = { model: "fake", prompt_version: "fake", llm_ms: 0, local_cache_hit: false, prompt_cache_read_tokens: 0 };

// ── Unit conversion (mirrors the interpreter's rules; enough for the fixture) ────────────
const TO_BASE: Record<string, Partial<Record<BaseUnit, number>>> = {
  kg: { kg: 1 }, g: { kg: 0.001 }, l: { l: 1 }, ml: { l: 0.001 }, pcs: { pcs: 1 }, dozen: { pcs: 12 },
  portion: { portion: 1 }, packet: {}, c: { c: 1 }, none: { kg: 1, l: 1, pcs: 1, portion: 1, c: 1 },
};
const round3 = (n: number) => Math.round(n * 1000) / 1000;
function toBase(q: number | null, unit: SpokenUnit, base: BaseUnit): number | null {
  if (q == null) return null;
  const f = TO_BASE[unit]?.[base];
  return f == null ? null : round3(q * f);
}

const UNIT_WORD: Record<string, Record<string, string>> = {
  en: { kg: "kg", l: "L", pcs: "pcs", portion: "portions", c: "°C" },
  hi: { kg: "किलो", l: "लीटर", pcs: "पीस", portion: "प्लेट", c: "°C" },
  kn: { kg: "ಕಿಲೋ", l: "ಲೀಟರ್", pcs: "ಪೀಸ್", portion: "ಪ್ಲೇಟ್", c: "°C" },
  mr: { kg: "किलो", l: "लिटर", pcs: "नग", portion: "प्लेट", c: "°C" },
  ta: { kg: "கிலோ", l: "லிட்டர்", pcs: "எண்ணம்", portion: "தட்டு", c: "°C" },
  te: { kg: "కిలో", l: "లీటర్", pcs: "ముక్కలు", portion: "ప్లేట్", c: "°C" },
};
const SAVED_WORD: Record<string, [string, string]> = {
  en: ["saved.", "Left"], hi: ["दर्ज हो गया।", "बचा"], kn: ["ದಾಖಲಾಗಿದೆ.", "ಉಳಿದಿದೆ"],
  mr: ["नोंद झाली.", "शिल्लक"], ta: ["பதிவானது.", "மீதம்"], te: ["నమోదైంది.", "మిగిలింది"],
};

// ── Ledger ───────────────────────────────────────────────────────────────────
class Ledger {
  current = new Map<string, number>();
  changedAt = new Map<string, string>();
  constructor() { for (const i of CATALOG) this.current.set(i.id, i.opening); }
  delta(e: Entry): { id: string; set: boolean; amount: number } | null {
    if (e.item_id === "unknown" || e.quantity_base == null) return null;
    switch (e.action) {
      case "receiving": case "prep": return { id: e.item_id, set: false, amount: e.quantity_base };
      case "usage": case "wastage": return { id: e.item_id, set: false, amount: -e.quantity_base };
      case "stock_count": return { id: e.item_id, set: true, amount: e.quantity_base };
      default: return null;
    }
  }
  stockAfter(e: Entry): number | null {
    const d = this.delta(e); if (!d) return null;
    return round3(d.set ? d.amount : (this.current.get(d.id) ?? 0) + d.amount);
  }
  apply(r: LogRecord) {
    for (const e of r.entries) {
      const d = this.delta(e); if (!d) continue;
      this.current.set(d.id, round3(d.set ? d.amount : (this.current.get(d.id) ?? 0) + d.amount));
      this.changedAt.set(d.id, r.created_at);
    }
  }
  items(): InventoryItem[] {
    return CATALOG.filter((i) => i.base !== "c").map((i) => {
      const current = this.current.get(i.id) ?? 0;
      return { item_id: i.id, label: i.names.en, base_unit: i.base, opening: i.opening, current,
        value_inr: Math.round(current * i.price), low: current < i.low_threshold, changed_at: this.changedAt.get(i.id) ?? null };
    });
  }
}

// ── Fake WAV (300 ms tone) so the browser really plays something ─────────────
function fakeWav(freq = 660, ms = 300): string {
  const rate = 16000, n = Math.floor(rate * ms / 1000);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 400, (n - i) / 800);
    v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 9000 * env), true);
  }
  return Buffer.from(buf).toString("base64");
}
const WAV_B64 = fakeWav();

// ── Sessions ─────────────────────────────────────────────────────────────────
interface Session {
  id: string; role: "staff" | "dashboard"; cursor: number; turn: number; language: string;
  pending: Draft | null; clarified: boolean; lastText: string; lastSpeak: string; draftSeq: number; queue: Promise<void>;
}
type WS = import("bun").ServerWebSocket<{ session: Session | null }>;

export interface MockOptions { port?: number; publicDir?: string; delayMs?: number; quiet?: boolean }

export function startMock(opts: MockOptions = {}) {
  const port = opts.port ?? Number(process.env.MOCK_PORT ?? 3001);
  const publicDir = opts.publicDir ?? join(import.meta.dir, "..", "public");
  const delayMs = opts.delayMs ?? 70;
  const log = (...a: unknown[]) => { if (!opts.quiet) console.log("[mock]", ...a); };

  const ledger = new Ledger();
  const records: LogRecord[] = [];            // newest first
  const photos = new Map<string, Uint8Array>();
  const latencies: number[] = [];
  const clients = new Set<WS>();
  const started = Date.now();
  let seq = 0;
  /** Every frame received, in order, for tests: {session, data} (data = parsed JSON or byte length). */
  const received: { session: string; data: unknown; binary: boolean }[] = [];
  const connections: WS[] = [];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  function emit(ws: WS, frame: unknown) {
    const parsed = ServerMsg.safeParse(frame);
    if (!parsed.success) { console.error("[mock] INVALID ServerMsg", JSON.stringify(frame).slice(0, 300), parsed.error.issues); return; }
    if (ws.readyState === 1) ws.send(JSON.stringify(parsed.data));
  }
  function broadcast(frame: unknown, except?: WS) { for (const c of clients) if (c !== except) emit(c, frame); }
  function activity(s: Session, state: Activity["state"], text: string) {
    const frame = { type: "activity", activity: { session_id: s.id, state, text, language: s.language || null } };
    for (const c of clients) if (c.data.session?.role === "dashboard") emit(c, frame);
  }

  function completeEntry(raw: Partial<Entry>, language: string): Entry {
    const item = raw.item_id && raw.item_id !== "unknown" ? BY_ID.get(raw.item_id) : undefined;
    const unit = (raw.unit ?? "none") as SpokenUnit;
    const quantity = raw.quantity ?? null;
    const base = item?.base ?? null;
    const qb = raw.quantity_base !== undefined ? raw.quantity_base : (item && base ? toBase(quantity, unit, base) : null);
    const e: Entry = {
      action: raw.action ?? "receiving",
      item_id: raw.item_id ?? "unknown",
      item_label: raw.item_label ?? (item ? displayName(item.id, language) : raw.item_heard ?? "?"),
      item_heard: raw.item_heard ?? raw.item_label ?? item?.names.en ?? "?",
      quantity, unit,
      quantity_base: qb,
      base_unit: raw.base_unit !== undefined ? raw.base_unit : base,
      value_inr: raw.value_inr !== undefined ? raw.value_inr : (item && qb != null && item.price > 0 ? Math.round(qb * item.price) : null),
      reason: raw.reason ?? null,
      temperature_c: raw.temperature_c ?? null,
      stock_after: null,
      warnings: raw.warnings ?? [],
    };
    e.stock_after = ledger.stockAfter(e);
    if ((e.action === "wastage" || e.action === "usage") && e.quantity_base != null && e.item_id !== "unknown"
        && e.quantity_base > (ledger.current.get(e.item_id) ?? 0) && !e.warnings.includes("exceeds_stock")) e.warnings = [...e.warnings, "exceeds_stock"];
    return e;
  }

  function confirmText(entries: Entry[], language: string): string {
    const l = language.slice(0, 2), w = UNIT_WORD[l] ?? UNIT_WORD.en;
    const parts = entries.map((e) => `${e.quantity ?? ""} ${e.base_unit ? w[e.base_unit] ?? e.base_unit : e.unit} ${e.item_label}`.trim());
    return l === "en" ? `${parts.join(", ")} received — correct?` : `${parts.join(", ")} — ${l === "hi" || l === "mr" ? "सही है?" : "ಸರಿಯೇ?"}`;
  }

  function readback(r: LogRecord): string {
    const l = r.language.slice(0, 2), w = UNIT_WORD[l] ?? UNIT_WORD.en, [saved, left] = SAVED_WORD[l] ?? SAVED_WORD.en;
    const e = r.entries[0];
    if (!e) return saved;
    const unit = e.base_unit ? w[e.base_unit] ?? e.base_unit : "";
    const stock = e.stock_after != null ? ` ${left} ${e.stock_after} ${unit}.` : "";
    return `${e.quantity ?? ""} ${unit} ${e.item_label}, ${saved}${stock}`.replace(/\s+/g, " ").trim();
  }

  function materializeDraft(s: Session, tmpl: Record<string, unknown>): Draft {
    const language = (tmpl.language as string) ?? s.language ?? "en-IN";
    s.language = language;
    const entries = ((tmpl.entries as Partial<Entry>[]) ?? []).map((e) => completeEntry(e, language));
    const intent = (tmpl.intent as Draft["intent"]) ?? "log";
    const draft_id = typeof tmpl.draft_id === "string" && tmpl.draft_id !== "*" ? tmpl.draft_id : `dx${++seq}`;
    const clarification = (tmpl.clarification as Draft["clarification"]) ?? null;
    const confirm = typeof tmpl.confirm_text === "string" ? tmpl.confirm_text : (intent === "log" || intent === "correction" ? confirmText(entries, language) : "");
    const draft: Draft = {
      draft_id,
      transcript: typeof tmpl.transcript === "string" ? tmpl.transcript : s.lastText,
      language, intent, entries,
      confirm_text: confirm,
      clarification,
      speak_text: typeof tmpl.speak_text === "string" ? tmpl.speak_text : (clarification?.question ?? confirm),
      replaced_pending: (tmpl.replaced_pending as boolean) ?? false,
      meta: tmpl.meta && tmpl.meta !== "*" ? (tmpl.meta as Draft["meta"]) : { ...FAKE_META, llm_ms: 380 },
    };
    return draft;
  }

  function applyEdits(entries: Entry[], edits: EntryEdit[], language: string): Entry[] {
    const out = entries.map((e) => ({ ...e, warnings: [...e.warnings] }));
    for (const ed of edits) {
      const e = out[ed.index]; if (!e) continue;
      if (ed.quantity !== undefined) e.quantity = ed.quantity;
      if (ed.unit !== undefined) e.unit = ed.unit;
      if (ed.item_id !== undefined) { e.item_id = ed.item_id; e.item_label = displayName(ed.item_id, language); }
      const item = BY_ID.get(e.item_id);
      e.base_unit = item?.base ?? null;
      e.quantity_base = item ? toBase(e.quantity, e.unit, item.base) : null;
      e.value_inr = item && e.quantity_base != null && item.price > 0 ? Math.round(e.quantity_base * item.price) : null;
      e.stock_after = ledger.stockAfter(e);
    }
    return out;
  }

  function saveRecord(s: Session, edits: EntryEdit[], timings: { stt_ms: number | null; llm_ms: number; total_ms: number }): LogRecord {
    const d = s.pending!;
    const entries = applyEdits(d.entries, edits, d.language);
    const rec: LogRecord = {
      record_id: `r${++seq}`, draft_id: d.draft_id, created_at: new Date().toISOString(), session_id: s.id,
      language: d.language, transcript: d.transcript, entries, edited: edits.length > 0, clarified: s.clarified,
      photo_url: null, timings, meta: d.meta,
    };
    ledger.apply(rec);
    records.unshift(rec);
    latencies.push(timings.total_ms);
    s.clarified = false;
    return rec;
  }

  const fill = (v: unknown, dflt: unknown) => (v === "*" || v === undefined ? dflt : v);

  async function replay(ws: WS, s: Session, step: Step, msg: Record<string, unknown> | null) {
    let saved: LogRecord | null = null;
    const timings = { stt_ms: msg?.type === "ptt.stop" ? 230 : null, llm_ms: 380, total_ms: 640 };
    for (const raw of step.expect) {
      await sleep(delayMs);
      const f = { ...raw } as Record<string, unknown>;
      switch (f.type) {
        case "stt.partial":
          f.turn = s.turn; activity(s, "listening", f.text as string); break;
        case "stt.final":
          f.turn = s.turn; s.lastText = f.text as string; activity(s, "thinking", f.text as string); break;
        case "draft": {
          const draft = materializeDraft(s, f.draft as Record<string, unknown>);
          const t = f.timings && f.timings !== "*" ? (f.timings as Record<string, unknown>) : {};
          f.timings = { stt_ms: fill(t.stt_ms, timings.stt_ms), llm_ms: fill(t.llm_ms, timings.llm_ms), total_ms: fill(t.total_ms, timings.total_ms) };
          f.turn = s.turn; f.draft = draft;
          if (draft.intent === "needs_clarification") { s.clarified = true; activity(s, "asking", draft.clarification?.question ?? ""); }
          else if (draft.intent === "log" || draft.intent === "correction") activity(s, "reviewing", draft.confirm_text);
          else activity(s, "idle", "");
          if (draft.intent === "log" || draft.intent === "correction" || draft.intent === "needs_clarification") s.pending = draft; else s.pending = null;
          s.lastSpeak = draft.speak_text;
          break;
        }
        case "draft.cleared":
          f.draft_id = fill(f.draft_id, s.pending?.draft_id ?? "?");
          if (f.reason === "cancelled" || f.reason === "expired") { s.pending = null; s.clarified = false; activity(s, "idle", ""); }
          if (f.reason === "confirmed") s.pending = null;
          if (f.reason === "cancelled") s.lastSpeak = s.language.startsWith("hi") ? "रद्द किया" : "Cancelled";
          break;
        case "record.saved": {
          const edits = ((msg?.edits as EntryEdit[]) ?? []);
          saved = saveRecord(s, edits, timings);
          f.record = saved; s.lastSpeak = readback(saved); activity(s, "idle", "");
          break;
        }
        case "record.new":
          f.record = saved ?? records[0]; broadcast(f, ws); break;
        case "inventory.update":
          f.items = ledger.items(); broadcast(f, ws); break;
        case "tts":
          f.ref = fill(f.ref, saved?.record_id ?? s.pending?.draft_id ?? "x");
          f.text = fill(f.text, s.lastSpeak || "…"); f.language = fill(f.language, s.language || "en-IN"); f.audio_b64 = WAV_B64; break;
        case "error":
          f.message = fill(f.message, "Didn't catch that"); f.turn = s.turn; s.lastSpeak = "Didn't catch that"; activity(s, "idle", ""); break;
      }
      emit(ws, f);
    }
  }

  function advance(ws: WS, s: Session, msg: Record<string, unknown> | null, binary: boolean) {
    let step = STEPS[s.cursor];
    if (binary) {
      if (step && "_binary" in step.send) { s.cursor++; return replay(ws, s, step, null); }
      return; // extra audio frames are fine; the script only reacts to the first ones
    }
    while (step && "_binary" in step.send) { s.cursor++; step = STEPS[s.cursor]; }
    if (!step) { s.cursor = 0; step = STEPS[0]; log(`session ${s.id}: script finished, wrapping around`); }
    if (step.send.type !== msg!.type) {
      emit(ws, { type: "error", code: "BAD_MESSAGE", message: `mock expected "${step.send.type}" next, got "${msg!.type}"` });
      return;
    }
    s.cursor++;
    return replay(ws, s, step, msg);
  }

  function onMessage(ws: WS, data: string | Buffer) {
    const s = ws.data.session;
    if (typeof data !== "string") {
      received.push({ session: s?.id ?? "?", data: data.byteLength, binary: true });
      if (s && s.role === "staff") s.queue = s.queue.then(() => advance(ws, s, null, true));
      return;
    }
    let parsed: ClientMsg;
    try { parsed = ClientMsg.parse(JSON.parse(data)); }
    catch (err) { received.push({ session: s?.id ?? "?", data, binary: false }); emit(ws, { type: "error", code: "BAD_MESSAGE", message: String(err).slice(0, 200) }); return; }
    received.push({ session: s?.id ?? "?", data: parsed, binary: false });
    if (parsed.type === "hello") {
      const session: Session = { id: `s-${parsed.client_id}-${++seq}`, role: parsed.role, cursor: 0, turn: 0, language: "", pending: null,
        clarified: false, lastText: "", lastSpeak: "", draftSeq: 0, queue: Promise.resolve() };
      ws.data.session = session;
      log(`hello from ${parsed.role} ${parsed.client_id}`);
      emit(ws, { type: "ready", session_id: session.id, stt: "ok", tts: "ok", model: "fake" });
      return;
    }
    if (!s) { emit(ws, { type: "error", code: "BAD_MESSAGE", message: "hello first" }); return; }
    if (parsed.type === "ping") { emit(ws, { type: "pong" }); return; }
    if (s.role !== "staff") return;
    if (parsed.type === "ptt.start" || parsed.type === "text") { s.turn = parsed.turn; }
    if (parsed.type === "ptt.start") activity(s, "listening", "");
    if (parsed.type === "text") { s.lastText = parsed.text; activity(s, "thinking", parsed.text); }
    if (parsed.type === "draft.answer") s.lastText = s.pending?.transcript ?? s.lastText;
    s.queue = s.queue.then(() => advance(ws, s, parsed as unknown as Record<string, unknown>, false));
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────
  const PAGES: Record<string, string> = { "/": "index.html", "/dashboard": "dashboard.html", "/present": "present.html" };
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  function stats() {
    const sorted = [...latencies].sort((a, b) => a - b);
    const pct = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
    const by_action: Record<string, number> = {};
    let wastage = 0, receiving = 0;
    for (const r of records) for (const e of r.entries) {
      by_action[e.action] = (by_action[e.action] ?? 0) + 1;
      if (e.action === "wastage") wastage += e.value_inr ?? 0;
      if (e.action === "receiving") receiving += e.value_inr ?? 0;
    }
    return { today: { entries: records.length, wastage_inr: wastage, receiving_inr: receiving, by_action,
      languages: [...new Set(records.map((r) => r.language))], latency_ms: { p50: pct(0.5), p99: pct(0.99) },
      corrected_by_voice: 0, clarified: records.filter((r) => r.clarified).length } };
  }

  const server = Bun.serve<{ session: Session | null }>({
    port, hostname: "0.0.0.0",
    async fetch(req, srv) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/ws") return srv.upgrade(req, { data: { session: null } }) ? undefined : new Response("upgrade failed", { status: 400 });
      if (p === "/healthz") return json({ ok: true, stt: "ok", tts: "ok", model: "fake", uptime_s: Math.round((Date.now() - started) / 1000) });
      if (p === "/api/catalog") return json({ items: CATALOG.map(({ id, base, price, opening, low_threshold, names }) => ({ id, base, price, opening, low_threshold, names })) });
      if (p === "/api/records") { const limit = Number(url.searchParams.get("limit") ?? 50); return json({ records: records.slice(0, limit) }); }
      if (p === "/api/inventory") return json({ items: ledger.items() });
      if (p === "/api/stats") return json(stats());
      if (p === "/api/interpret" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const s: Session = { id: "http", role: "staff", cursor: 0, turn: 0, language: body.language ?? "en-IN", pending: null, clarified: false, lastText: body.text ?? "", lastSpeak: "", draftSeq: 0, queue: Promise.resolve() };
        return json({ draft: materializeDraft(s, { intent: "unclear", entries: [], confirm_text: "", speak_text: "Didn't catch that" }), timings: { stt_ms: null, llm_ms: 0, total_ms: 1 } });
      }
      const photo = p.match(/^\/api\/photo\/([^/]+)$/);
      if (photo && req.method === "POST") {
        const rec = records.find((r) => r.record_id === photo[1]);
        if (!rec) return json({ error: "no such record" }, 404);
        const form = await req.formData();
        const file = form.get("photo");
        if (!(file instanceof Blob)) return json({ error: "field photo missing" }, 400);
        photos.set(rec.record_id, new Uint8Array(await file.arrayBuffer()));
        rec.photo_url = `/photos/${rec.record_id}.jpg`;
        broadcast({ type: "record.updated", record: rec });
        return json({ record_id: rec.record_id, photo_url: rec.photo_url });
      }
      const ph = p.match(/^\/photos\/([^/]+)\.jpg$/);
      if (ph) { const b = photos.get(ph[1]); return b ? new Response(b, { headers: { "content-type": "image/jpeg" } }) : new Response("not found", { status: 404 }); }
      // static
      const rel = PAGES[p] ?? normalize(p).replace(/^\/+/, "");
      const file = Bun.file(join(publicDir, rel));
      if (!rel.includes("..") && (await file.exists())) return new Response(file, { headers: { "cache-control": "no-store" } });
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) { clients.add(ws); connections.push(ws); },
      message(ws, data) { onMessage(ws, data as string | Buffer); },
      close(ws) { clients.delete(ws); log(`closed ${ws.data.session?.id ?? "(no hello)"}`); },
    },
  });

  const actualPort = server.port ?? port;
  log(`mock gateway on http://localhost:${actualPort}  (phone /, /dashboard, /present)`);
  return {
    server, port: actualPort,
    url: `http://localhost:${actualPort}`, wsUrl: `ws://localhost:${actualPort}/ws`,
    state: { ledger, records, latencies, received, connections, clients },
    /** Close every client socket (simulates the gateway dropping). */
    dropAll() { for (const c of clients) c.close(); },
    stop() { server.stop(true); },
  };
}

if (import.meta.main) startMock();
