// Replays contracts/fixtures/session.json over a real WebSocket against the gateway with fakes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startGateway, TestClient } from "./helpers";
import { ClientMsg, type ServerMsg } from "../../contracts/protocol";

const fixture = JSON.parse(await Bun.file(new URL("../../contracts/fixtures/session.json", import.meta.url)).text());

let env: Awaited<ReturnType<typeof startGateway>>;
let staff: TestClient;
let dash: TestClient;

beforeAll(async () => {
  env = await startGateway();
  dash = await TestClient.connect(env.ws, { type: "hello", client_id: "dash", role: "dashboard" });
  expect((await dash.next()).type).toBe("ready");
});
afterAll(async () => { staff?.close(); dash?.close(); await env.gw.stop(); });

/** Compare an actual frame with an expected one; "*" matches anything; objects compared recursively on expected keys only. */
function matches(actual: unknown, expected: unknown): boolean {
  if (expected === "*") return true;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((e, i) => matches((actual as unknown[])[i], e));
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => matches((actual as Record<string, unknown>)[k], v));
  }
  return actual === expected;
}

describe("session.json replay", () => {
  const ids: Record<string, string> = {};   // fixture draft ids (d1, d2…) → real ids
  const sub = (v: unknown): unknown => {
    if (typeof v === "string") return ids[v] ?? v;
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };

  test("every step produces the expected frames in order", async () => {
    // Script the fake STT with what the fixture's binary/ptt.stop steps expect.
    env.stt.script({ partials: [{ text: "ಇಪ್ಪತ್ತು", language: "kn-IN" }, { text: "ಇಪ್ಪತ್ತು ಲೀಟರ್ ಹಾಲು", language: "kn-IN" }], final: { text: "ಇಪ್ಪತ್ತು ಲೀಟರ್ ಹಾಲು ಬಂದಿದೆ", language: "kn-IN", confidence: 0.9 } });
    env.stt.script({ partials: [], final: { text: "दस किलो चावल आया", language: "hi-IN", confidence: 0.8 } });
    env.stt.script({ partials: [], final: { text: "", language: null, confidence: null } });

    for (const step of fixture.steps as { send: Record<string, unknown>; expect: Record<string, unknown>[] }[]) {
      const send = step.send;
      if (send._binary) {
        // Fixture holds for 2 frames; the gateway's 300 ms minimum hold needs ≥ 8 frames, so pad.
        if (!staff) throw new Error("no staff client");
        for (let i = 0; i < 4; i++) staff.binary(Number(send._binary));
      } else {
        const msg = ClientMsg.parse(sub(send));
        if (msg.type === "hello") {
          staff = await TestClient.connect(env.ws, msg);
        } else if (msg.type === "ptt.stop") {
          // second/third turns in the fixture send no binary; pad so the hold passes the minimum
          for (let i = 0; i < 8; i++) staff.binary();
          staff.send(msg);
        } else if (msg.type === "draft.confirm" && (send.draft_id === "*")) {
          staff.send({ ...msg, draft_id: ids.__last! });
        } else staff.send(msg);
      }
      // Partials from padded frames: the fake emits one partial per frame while scripted; drain extras below.
      const got: ServerMsg[] = [];
      for (const exp of step.expect) {
        let m = await staff.next(3000);
        // Skip extra stt.partial frames the fixture does not list.
        while (m.type === "stt.partial" && (exp as { type: string }).type !== "stt.partial") m = await staff.next(3000);
        got.push(m);
        if (m.type === "draft") { ids[(exp as { draft: { draft_id?: string } }).draft?.draft_id ?? ""] = m.draft.draft_id; ids.__last = m.draft.draft_id; }
        const ok = matches(m, sub(exp));
        if (!ok) console.error("MISMATCH\n expected", JSON.stringify(sub(exp)).slice(0, 400), "\n actual  ", JSON.stringify(m).slice(0, 400));
        expect(ok).toBe(true);
      }
    }
  }, 20_000);

  test("dashboard received record.new, inventory.update and the activity sequence", async () => {
    const frames = await dash.collect(60, 500);
    const types = frames.map((f) => f.type);
    expect(types).toContain("record.new");
    expect(types).toContain("inventory.update");
    expect(types).not.toContain("draft");
    const states = frames.filter((f) => f.type === "activity").map((f) => (f as Extract<ServerMsg, { type: "activity" }>).activity.state);
    for (const s of fixture.dashboard.expect_activity_sequence.map((a: { state: string }) => a.state)) expect(states).toContain(s);
    const inv = frames.find((f) => f.type === "inventory.update") as Extract<ServerMsg, { type: "inventory.update" }>;
    expect(inv.items.find((i) => i.item_id === "milk")!.current).toBe(60);
  });

  test("HTTP: records, inventory, stats, catalog, health, static", async () => {
    const rec = await (await fetch(`${env.url}/api/records?limit=5`)).json();
    expect(rec.records.length).toBeGreaterThanOrEqual(2);
    expect(rec.records[0].created_at >= rec.records[1].created_at).toBe(true);
    const inv = await (await fetch(`${env.url}/api/inventory`)).json();
    expect(inv.items.find((i: { item_id: string }) => i.item_id === "eggs").current).toBe(144);
    const stats = await (await fetch(`${env.url}/api/stats`)).json();
    expect(stats.today.entries).toBe(2);
    expect(stats.today.receiving_inr).toBe(1200 + 168);
    expect(stats.today.latency_ms.p50).toBeGreaterThanOrEqual(0);
    const cat = await (await fetch(`${env.url}/api/catalog`)).json();
    expect(cat.items.length).toBe(24);
    expect(Object.keys(cat.recipes)).toContain("dal_makhani");
    const menu = await (await fetch(`${env.url}/api/menu`)).json();
    expect(menu.items.find((m: { item_id: string }) => m.item_id === "dal_makhani").portions_possible).toBeGreaterThan(0);
    const h = await (await fetch(`${env.url}/healthz`)).json();
    expect(h.ok).toBe(true);
    expect(await (await fetch(`${env.url}/`)).text()).toContain("static ok");
    expect((await fetch(`${env.url}/nope.js`)).status).toBe(404);
  });

  test("photo attach → record.updated broadcast and /photos serves it", async () => {
    const rec = (await (await fetch(`${env.url}/api/records?limit=1`)).json()).records[0];
    const form = new FormData();
    form.set("photo", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }), "p.jpg");
    const res = await fetch(`${env.url}/api/photo/${rec.record_id}`, { method: "POST", body: form });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.photo_url).toBe(`/photos/${rec.record_id}.jpg`);
    const upd = await dash.until("record.updated", 1000);
    expect(upd.record.photo_url).toBe(body.photo_url);
    expect((await fetch(`${env.url}${body.photo_url}`)).status).toBe(200);
    expect((await fetch(`${env.url}/api/photo/nope`, { method: "POST", body: form })).status).toBe(404);
  });

  test("first frame must be hello", async () => {
    const c = new TestClient(env.ws);
    await new Promise<void>((r) => (c.ws.onopen = () => r()));
    const closed = new Promise<number>((r) => (c.ws.onclose = (e) => r(e.code)));
    c.send({ type: "ping" });
    expect(await closed).toBe(1008);
  });
});
