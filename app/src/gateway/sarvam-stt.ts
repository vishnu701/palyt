// Sarvam realtime speech-to-text over WebSocket (SPEC §3, brief §Sarvam realtime STT).
// Verified 2026-09-26 with a live probe: handshake ~90 ms, final ~60 ms after flush.
//   - keyterms must be a JSON array string and is only accepted by saaras:v4
//   - saaras:v3-realtime returns language_confidence on finals; v4 does not
//   - both return a hallucinated word on pure silence — the session guards short holds
//   - auto language detection sticks per session → rotate after every final (below)
//   - v4 (any mode) translated a Kannada sentence to English on a fresh session; v3-realtime kept
//     the words as Latin transliteration ("20 liter haalu bandide", tagged en-IN) → v3 is default
import { KEYTERMS } from "../../contracts/catalog";
import type { SttCallbacks, SttProvider, SttSession } from "../../contracts/interfaces";

const URL_BASE = "wss://api.sarvam.ai/speech-to-text-realtime/ws";
const PROMPT = "Restaurant kitchen inventory: items received, used, wasted or spoiled; fridge and freezer temperatures; quantities in kilo, gram, litre, pieces, packets, portions.";

export interface SarvamSttOptions {
  apiKey: string;
  model?: string;            // "saaras:v3-realtime" (default: confidence, keeps native words) | "saaras:v4" (keyterms)
  streamType?: "fast" | "balanced";
  keyterms?: string[];
  pingMs?: number;
  connectTimeoutMs?: number;
  rotateAfterFinal?: boolean;   // default true: fresh upstream session per turn
  mode?: "transcribe" | "codemix" | "verbatim";
}

export class SarvamSttProvider implements SttProvider {
  constructor(private readonly opts: SarvamSttOptions) {}
  async open(cb: SttCallbacks): Promise<SttSession> {
    const s = new SarvamSttSession(this.opts, cb);
    await s.connect();
    return s;
  }
}

class SarvamSttSession implements SttSession {
  private ws: WebSocket | null = null;
  private fatal = false;
  private awaitingFinal = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;

  constructor(private readonly opts: SarvamSttOptions, private readonly cb: SttCallbacks) {}

  get alive(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && !this.fatal;
  }

  private url(): string {
    const model = this.opts.model ?? "saaras:v3-realtime";
    const q = new URLSearchParams({
      language_code: "auto",
      model,
      stream_type: this.opts.streamType ?? "fast",
      encoding: "linear16",
      sample_rate: "16000",
      endpointing: "manual",
      mode: this.opts.mode ?? "transcribe",
      prompt: PROMPT,
    });
    if (model === "saaras:v4") {
      const terms = (this.opts.keyterms ?? KEYTERMS).slice(0, 50); // Sarvam rejects > 50
      q.set("keyterms", JSON.stringify(terms));
    }
    return `${URL_BASE}?${q}`;
  }

  /** Connect and wait for the socket to open (session.begin follows within ~100 ms). */
  async connect(): Promise<void> {
    this.closedByUs = false;
    this.fatal = false;
    const ws = new WebSocket(this.url(), { headers: { "api-subscription-key": this.opts.apiKey } } as never);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sarvam stt connect timeout")), this.opts.connectTimeoutMs ?? 4000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = (e) => { clearTimeout(timer); reject(new Error("sarvam stt connect error: " + ((e as ErrorEvent).message ?? "unknown"))); };
    });
    ws.onmessage = (e) => this.onMessage(String(e.data));
    ws.onerror = (e) => this.cb.onError("sarvam stt socket error: " + ((e as ErrorEvent).message ?? "unknown"), false);
    ws.onclose = (e) => {
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      if (e.code >= 4000) { this.fatal = true; this.cb.onError(`sarvam stt closed ${e.code}: ${e.reason}`, true); }
      else if (!this.closedByUs) this.cb.onError(`sarvam stt closed ${e.code}`, false);
      if (this.awaitingFinal) { this.awaitingFinal = false; this.cb.onFinal("", null, null); }
    };
    this.pingTimer = setInterval(() => { if (this.alive) this.send({ event: "ping" }); }, this.opts.pingMs ?? 20_000);
  }

  private onMessage(raw: string) {
    let msg: { event?: string; text?: string; language?: string; language_confidence?: number; code?: string; is_fatal?: boolean; message?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.event) {
      case "transcript.partial":
        this.cb.onPartial(msg.text ?? "", msg.language ?? null);
        break;
      case "transcript.final":
        if (this.awaitingFinal) {
          this.awaitingFinal = false;
          this.cb.onFinal(msg.text ?? "", msg.language ?? null, msg.language_confidence ?? null);
          // Auto language detection sticks to the previous utterance within one upstream session
          // (observed: Hindi transcribed in Kannada script after a Kannada turn). Start every turn
          // on a fresh session; reconnecting takes ~70 ms and happens while the card is showing.
          if (this.opts.rotateAfterFinal !== false) void this.rotate();
        }
        break;
      case "error":
        if (msg.is_fatal) this.fatal = true;
        this.cb.onError(`sarvam stt ${msg.code}: ${msg.message}`, !!msg.is_fatal);
        break;
      default:
        break; // session.begin, pong, config.updated, session.end
    }
  }

  private send(obj: unknown) {
    if (this.alive) this.ws!.send(JSON.stringify(obj));
  }

  private rotating: Promise<void> | null = null;
  private async rotate(): Promise<void> {
    if (this.rotating) return this.rotating;
    this.rotating = (async () => {
      const old = this.ws;
      this.closedByUs = true;
      if (old) { old.onclose = null; old.onmessage = null; try { old.send(JSON.stringify({ event: "end" })); old.close(1000); } catch {} }
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      this.ws = null;
      try { await this.connect(); } catch (err) { this.cb.onError(`sarvam stt reconnect failed: ${(err as Error).message}`, false); }
    })().finally(() => { this.rotating = null; });
    return this.rotating;
  }

  async start(): Promise<void> {
    if (this.rotating) await this.rotating;
    if (!this.alive) await this.connect();
    this.awaitingFinal = false;
    this.send({ event: "speech_start" });
  }

  audio(pcm: Uint8Array): void {
    if (!this.alive) return;
    this.send({ event: "audio_input", audio: Buffer.from(pcm).toString("base64") });
  }

  stop(): void {
    if (!this.alive) { this.cb.onFinal("", null, null); return; }
    this.awaitingFinal = true;
    this.send({ event: "speech_end" });
    this.send({ event: "flush" });
  }

  close(): void {
    this.closedByUs = true;
    this.opts.rotateAfterFinal = false;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.alive) { this.send({ event: "end" }); this.ws!.close(1000); }
    this.ws = null;
  }
}
