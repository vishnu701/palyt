// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — the code seams between Gateway (agent 2) and Interpreter
// (agent 3). Gateway depends only on these; each side is testable with fakes.
// ─────────────────────────────────────────────────────────────────────────────
import type { Draft, Entry, EntryEdit, LogRecord, SpokenUnit } from "./protocol";

// ── Interpreter (agent 3: app/src/interpreter/index.ts) ───────────────────────

export interface InterpretRequest {
  text: string;
  /** From STT (e.g. "kn-IN"), or null for typed text. A HINT: the interpreter decides `language`. */
  languageHint: string | null;
  /** The draft awaiting confirmation or answer, if any. Includes its `clarification` when asking. */
  pending: Draft | null;
  /** Set when the text is the value of a tapped clarification option (skip the model where possible). */
  tapAnswer: boolean;
}

export interface Interpreter {
  /** Resolves with a Draft that passes `Draft.parse`; `stock_after` is null on every entry. Throws on failure. */
  interpret(req: InterpretRequest): Promise<Draft>;
  /** Warm the Claude prompt cache + HTTPS connection. Safe to call often; never throws. */
  warm(): Promise<void>;
  /** Re-run normalization after edits on the review card. Pure, sync, no model. */
  applyEdits(entries: Entry[], edits: EntryEdit[], language: string): Entry[];
  /** Short spoken confirmation after save, in `language`: e.g. "5 किलो पनीर खराब, दर्ज हो गया। बचा 7 किलो।" Pure, sync. */
  readback(record: LogRecord): string;
}

// export function createInterpreter(opts?: { model?: string }): Interpreter
// export const PROMPT_VERSION: string
// export function normalizeEntry(raw: RawEntry, language: string): Entry     (pure; tested by fixtures)

/** What the model returns per entry, before normalization. */
export interface RawEntry {
  action: Entry["action"];
  candidates: string[];        // catalog ids the item COULD be, best first; [] = unknown
  item_heard: string;
  quantity: number | null;
  unit: SpokenUnit;
  reason: string | null;
  temperature_c: number | null;
}

// ── Speech-to-text (agent 2: Sarvam realtime adapter + fake) ─────────────────

export interface SttCallbacks {
  onPartial(text: string, language: string | null): void;
  /** Exactly one per stop(); text may be "". confidence null when unknown. */
  onFinal(text: string, language: string | null, confidence: number | null): void;
  onError(message: string, fatal: boolean): void;
}

export interface SttSession {
  /** Push-to-talk pressed. Reopens the upstream socket if it died while idle. */
  start(): Promise<void>;
  /** One PCM s16le / 16 kHz / mono frame. */
  audio(pcm: Uint8Array): void;
  /** Push-to-talk released → flush. Provider must emit onFinal within finalTimeoutMs or the gateway uses the last partial. */
  stop(): void;
  close(): void;
  readonly alive: boolean;
}

export interface SttProvider {
  open(cb: SttCallbacks): Promise<SttSession>;
}

// ── Text-to-speech (agent 2: Sarvam bulbul:v3 REST adapter + fake) ───────────

export interface TtsProvider {
  /** One short sentence → WAV (base64). Must resolve within 1500 ms or reject. */
  synthesize(text: string, language: string): Promise<{ audio_b64: string }>;
}

// ── Records (agent 2) ────────────────────────────────────────────────────────

export interface RecordStore {
  append(r: LogRecord): Promise<void>;
  update(r: LogRecord): Promise<void>;
  all(): Promise<LogRecord[]>;   // oldest first; used to replay the ledger on boot
}

// ── Gateway factory (agent 2: app/src/gateway/index.ts) ───────────────────────

export interface GatewayOptions {
  port: number;                 // 0 = random free port (tests)
  interpreter: Interpreter;
  stt: SttProvider | null;      // null → ready.stt "down"; typed text still works
  tts: TtsProvider | null;      // null → ready.tts "down"; no tts frames
  store: RecordStore;
  publicDir: string;            // static files served at "/"
  dataDir: string;              // photos go to <dataDir>/photos
  finalTimeoutMs?: number;      // default 2500
  pendingTtlMs?: number;        // default 90_000; draft.cleared "expired" afterwards
}

export interface Gateway {
  port: number;
  stop(): Promise<void>;
}

// export async function createGateway(opts: GatewayOptions): Promise<Gateway>
