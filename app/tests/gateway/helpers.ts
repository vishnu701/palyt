import { createGateway } from "../../src/gateway/index";
import { MemoryStore } from "../../src/gateway/store";
import { FakeInterpreter, FakeSttProvider, FakeTtsProvider } from "../../src/gateway/fakes";
import { ServerMsg, type ClientMsg } from "../../contracts/protocol";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function startGateway(over: Partial<Parameters<typeof createGateway>[0]> = {}) {
  const interpreter = new FakeInterpreter();
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const store = new MemoryStore();
  const dataDir = await mkdtemp(join(tmpdir(), "kv-"));
  const gw = await createGateway({ port: 0, interpreter, stt, tts, store, publicDir: join(import.meta.dir, "public-fixture"), dataDir, finalTimeoutMs: 300, pendingTtlMs: 60_000, ...over });
  return { gw, interpreter, stt, tts, store, dataDir, url: `http://127.0.0.1:${gw.port}`, ws: `ws://127.0.0.1:${gw.port}/ws` };
}

/** A test client that queues every parsed server frame. */
export class TestClient {
  ws: WebSocket;
  frames: ServerMsg[] = [];
  private waiters: ((m: ServerMsg) => void)[] = [];
  constructor(url: string) { this.ws = new WebSocket(url); this.ws.binaryType = "arraybuffer"; }
  static async connect(url: string, hello: Extract<ClientMsg, { type: "hello" }>) {
    const c = new TestClient(url);
    await new Promise<void>((res, rej) => { c.ws.onopen = () => res(); c.ws.onerror = () => rej(new Error("ws error")); });
    c.ws.onmessage = (e) => {
      const m = ServerMsg.parse(JSON.parse(String(e.data)));
      const w = this.shiftWaiter(c);
      if (w) w(m); else c.frames.push(m);
    };
    c.send(hello);
    return c;
  }
  private static shiftWaiter(c: TestClient) { return c.waiters.shift(); }
  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }
  binary(bytes = 1280) { this.ws.send(new Uint8Array(bytes)); }
  /** Next frame (already queued or upcoming). */
  next(timeoutMs = 2000): Promise<ServerMsg> {
    const q = this.frames.shift();
    if (q) return Promise.resolve(q);
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== fn); rej(new Error("timeout waiting for frame")); }, timeoutMs);
      const fn = (m: ServerMsg) => { clearTimeout(t); res(m); };
      this.waiters.push(fn);
    });
  }
  /** Wait for a frame of a given type, discarding others into `skipped`. */
  async until<T extends ServerMsg["type"]>(type: T, timeoutMs = 2000): Promise<Extract<ServerMsg, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const m = await this.next(deadline - Date.now());
      if (m.type === type) return m as Extract<ServerMsg, { type: T }>;
    }
    throw new Error(`timeout waiting for ${type}`);
  }
  /** Collect frames until `n` of them have arrived or timeout. */
  async collect(n: number, timeoutMs = 2000): Promise<ServerMsg[]> {
    const out: ServerMsg[] = [];
    const deadline = Date.now() + timeoutMs;
    while (out.length < n && Date.now() < deadline) {
      try { out.push(await this.next(deadline - Date.now())); } catch { break; }
    }
    return out;
  }
  close() { this.ws.close(); }
}

export const sleep = (ms: number) => Bun.sleep(ms);
