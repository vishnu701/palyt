// Shared test scaffolding: a happy-dom window loaded with one of the public pages, the mock
// gateway on a random port, fake audio, and small wait/match helpers.
import { Window } from "happy-dom";
import { join } from "node:path";
import { startMock } from "../mock-gateway";

export const PUBLIC = join(import.meta.dir, "..", "..", "public");
const BunWebSocket = globalThis.WebSocket;
const bunFetch = globalThis.fetch;

export function loadPage(file: string, url: string) {
  const html = require("node:fs").readFileSync(join(PUBLIC, file), "utf8") as string;
  const body = html.replace(/<script[\s\S]*?<\/script>/g, "").match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "";
  const bodyClass = html.match(/<body class="([^"]+)"/)?.[1] ?? "";
  const win = new Window({ url, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableComputedStyleRendering: true } });
  const doc = win.document;
  doc.body.innerHTML = body;
  doc.body.className = bodyClass;
  return { win: win as unknown as typeof globalThis & Window, doc };
}

export class FakeSource {
  started = false; stopped = false; buffer: unknown = null; onended: null | (() => void) = null;
  connect() {} start() { this.started = true; } stop() { this.stopped = true; }
}
export class FakeAudioContext {
  state = "running"; destination = {}; sources: FakeSource[] = []; resumed = 0;
  resume() { this.resumed++; return Promise.resolve(); }
  decodeAudioData(_buf: ArrayBuffer, ok?: (b: unknown) => void) { const b = { duration: 0.3 }; if (ok) ok(b); return Promise.resolve(b); }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  get playing() { return this.sources.filter((s) => s.started && !s.stopped); }
}
export class FakeCapture {
  cb: null | ((pcm: ArrayBuffer, level: number) => void) = null; starts = 0; stops = 0;
  start(cb: (pcm: ArrayBuffer, level: number) => void) { this.cb = cb; this.starts++; }
  async stop() { this.cb = null; this.stops++; }
  push(bytes = 1280) { this.cb?.(new Uint8Array(bytes).buffer, 0.3); }
}

export function fakeStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(fn: () => boolean | unknown, what = "condition", timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return; await sleep(10); }
  throw new Error(`timed out waiting for ${what}`);
}

/** Deep match with "*" wildcards, as in session.json. */
export function matches(expected: unknown, actual: unknown): boolean {
  if (expected === "*") return true;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((e, i) => matches(e, actual[i]));
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => matches(v, (actual as Record<string, unknown>)[k]));
  }
  return expected === actual;
}

export function fire(win: Window, el: Element, type: string) {
  el.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }));
}
export const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

export function bootMock() { return startMock({ port: 0, delayMs: 5, quiet: true }); }
export const impls = () => ({ WebSocketImpl: BunWebSocket, fetchImpl: bunFetch, pingMs: 0 });
