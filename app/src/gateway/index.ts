// createGateway: Bun.serve with the WebSocket protocol, HTTP API and static files.
import { join, extname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ServerWebSocket } from "bun";
import { ClientMsg, InterpretReq, LogRecord, type ServerMsg } from "../../contracts/protocol";
import { CATALOG, RECIPES } from "../../contracts/catalog";
import type { Gateway, GatewayOptions } from "../../contracts/interfaces";
import { Ledger } from "./ledger";
import { Session } from "./session";

interface WsData { role: "staff" | "dashboard" | null; session: Session | null; client_id: string | null }

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
};
const PAGES: Record<string, string> = { "/": "index.html", "/dashboard": "dashboard.html", "/present": "present.html" };

export async function createGateway(opts: GatewayOptions): Promise<Gateway> {
  const started = Date.now();
  const store = opts.store;
  const ledger = new Ledger(await store.all());
  const recordsById = new Map<string, LogRecord>();
  for (const r of await store.all()) recordsById.set(r.record_id, r);
  const correctedIds = new Set<string>();
  const photosDir = join(opts.dataDir, "photos");
  await mkdir(photosDir, { recursive: true });

  const sessions = new Set<Session>();
  const warmTimer = setInterval(() => void opts.interpreter.warm(), 4 * 60_000);
  void opts.interpreter.warm();

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  const server = Bun.serve<WsData>({
    port: opts.port,
    hostname: "0.0.0.0",
    idleTimeout: 120,
    async fetch(req, server) {
      const url = new URL(req.url);
      const p = url.pathname;

      if (p === "/ws") {
        const ok = server.upgrade(req, { data: { role: null, session: null, client_id: null } });
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (p === "/healthz") return json({ ok: true, stt: opts.stt ? "ok" : "down", tts: opts.tts ? "ok" : "down", model: modelName(opts), uptime_s: Math.round((Date.now() - started) / 1000) });
      if (p === "/api/catalog") return json({ items: CATALOG.map((i) => ({ id: i.id, base: i.base, price: i.price, opening: i.opening, low_threshold: i.low_threshold, names: i.names, ...(i.menu ? { menu: true } : {}) })), recipes: RECIPES });
      if (p === "/api/menu") return json({ items: ledger.menu() });
      if (p === "/api/records") {
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 50)));
        const all = [...recordsById.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
        return json({ records: all.slice(0, limit) });
      }
      if (p === "/api/inventory") return json({ items: ledger.inventory() });
      if (p === "/api/stats") return json(ledger.stats(new Date(), correctedIds));
      if (p === "/api/interpret" && req.method === "POST") {
        const parsed = InterpretReq.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return json({ error: "bad request" }, 400);
        const t0 = performance.now();
        try {
          const draft = await opts.interpreter.interpret({ text: parsed.data.text, languageHint: parsed.data.language ?? null, pending: null, tapAnswer: false });
          draft.entries = draft.entries.map((e) => { const ing = ledger.ingredients(e, draft.language); return { ...e, stock_after: ledger.stockAfter(e), ...(ing ? { ingredients: ing } : {}) }; });
          return json({ draft, timings: { stt_ms: null, llm_ms: draft.meta.llm_ms, total_ms: Math.round(performance.now() - t0) } });
        } catch (err) { return json({ error: (err as Error).message }, 502); }
      }
      const photoPost = p.match(/^\/api\/photo\/([A-Za-z0-9-]+)$/);
      if (photoPost && req.method === "POST") {
        const rec = recordsById.get(photoPost[1]!);
        if (!rec) return json({ error: "record not found" }, 404);
        const form = await req.formData().catch(() => null);
        const file = form?.get("photo");
        if (!(file instanceof Blob)) return json({ error: "field 'photo' missing" }, 400);
        if (file.size > 2 * 1024 * 1024) return json({ error: "photo larger than 2 MB" }, 413);
        await Bun.write(join(photosDir, `${rec.record_id}.jpg`), file);
        const updated: LogRecord = { ...rec, photo_url: `/photos/${rec.record_id}.jpg` };
        recordsById.set(rec.record_id, updated);
        await store.update(updated);
        publish("all", { type: "record.updated", record: updated });
        return json({ record_id: rec.record_id, photo_url: updated.photo_url });
      }
      const photoGet = p.match(/^\/photos\/([A-Za-z0-9-]+)\.jpg$/);
      if (photoGet) {
        const f = Bun.file(join(photosDir, `${photoGet[1]}.jpg`));
        return (await f.exists()) ? new Response(f, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=3600" } }) : new Response("not found", { status: 404 });
      }

      // Static files.
      const rel = PAGES[p] ?? (p.includes("..") ? null : p.slice(1));
      if (rel) {
        const f = Bun.file(join(opts.publicDir, rel));
        if (await f.exists()) {
          const ext = extname(rel);
          return new Response(f, { headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600" } });
        }
      }
      return new Response("not found", { status: 404 });
    },

    websocket: {
      perMessageDeflate: false,
      async message(ws, raw) {
        const d = ws.data;
        if (typeof raw !== "string") {
          if (d.session) void d.session.onBinary(raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer));
          return;
        }
        let parsed: ReturnType<typeof ClientMsg.safeParse>;
        try { parsed = ClientMsg.safeParse(JSON.parse(raw)); } catch { parsed = { success: false } as never; }
        if (!parsed.success) { send(ws, { type: "error", code: "BAD_MESSAGE", message: "Frame does not match the protocol" }); if (!d.role) ws.close(1008, "hello first"); return; }
        const msg = parsed.data;

        if (!d.role) {
          if (msg.type !== "hello") { send(ws, { type: "error", code: "BAD_MESSAGE", message: "First frame must be hello" }); ws.close(1008, "hello first"); return; }
          d.role = msg.role;
          d.client_id = msg.client_id;
          ws.subscribe("all");
          if (msg.role === "dashboard") {
            ws.subscribe("dashboard");
            send(ws, { type: "ready", session_id: `dash-${msg.client_id}`, stt: opts.stt ? "ok" : "down", tts: opts.tts ? "ok" : "down", model: modelName(opts) });
            return;
          }
          const session = new Session({
            interpreter: opts.interpreter, stt: opts.stt, tts: opts.tts, store, ledger,
            send: (m) => send(ws, m),
            broadcastAll: (m) => publish("all", m),
            broadcastDashboards: (m) => publish("dashboard", m),
            onRecordSaved: (r, corrected) => { recordsById.set(r.record_id, r); if (corrected) correctedIds.add(r.record_id); },
            finalTimeoutMs: opts.finalTimeoutMs ?? 2500,
            pendingTtlMs: opts.pendingTtlMs ?? 90_000,
          });
          d.session = session;
          sessions.add(session);
          const { stt } = await session.init();
          send(ws, { type: "ready", session_id: session.id, stt, tts: opts.tts ? "ok" : "down", model: modelName(opts) });
          return;
        }
        if (msg.type === "hello") return;
        if (msg.type === "ping") { send(ws, { type: "pong" }); return; }
        if (d.session) void d.session.onMessage(msg);
      },
      close(ws) {
        if (ws.data.session) { ws.data.session.close(); sessions.delete(ws.data.session); }
      },
    },
  });

  function publish(topic: "all" | "dashboard", msg: ServerMsg) { server.publish(topic, JSON.stringify(msg)); }
  function send(ws: ServerWebSocket<WsData>, msg: ServerMsg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  return {
    port: server.port!,
    async stop() {
      clearInterval(warmTimer);
      for (const s of sessions) s.close();
      server.stop(true);
    },
  };
}

function modelName(opts: GatewayOptions): string {
  if (process.env.LLM_PROVIDER === "sarvam") return process.env.SARVAM_LLM_MODEL ?? "sarvam-105b-conversations";
  return (opts.interpreter as { model?: string }).model ?? process.env.CLAUDE_MODEL ?? "claude-opus-5";
}
