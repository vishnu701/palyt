// Timeouts, reopen, TTL, edits, interpreter failure, latency — against fakes.
import { afterEach, describe, expect, test } from "bun:test";
import { startGateway, TestClient, sleep } from "./helpers";

let env: Awaited<ReturnType<typeof startGateway>> | null = null;
afterEach(async () => { await env?.gw.stop(); env = null; });

async function staffClient(e: NonNullable<typeof env>) {
  const c = await TestClient.connect(e.ws, { type: "hello", client_id: "s", role: "staff" });
  const ready = await c.next();
  expect(ready.type).toBe("ready");
  return c;
}
function hold(c: TestClient, turn: number, frames = 10) {
  c.send({ type: "ptt.start", turn });
  for (let i = 0; i < frames; i++) c.binary();
  c.send({ type: "ptt.stop", turn });
}

describe("session behaviour", () => {
  test("STT final timeout falls back to the last partial", async () => {
    env = await startGateway({ finalTimeoutMs: 150 });
    const c = await staffClient(env);
    env.stt.script({ partials: [{ text: "पाँच किलो", language: "hi-IN" }, { text: "पाँच किलो पनीर खराब हो गया", language: "hi-IN" }], final: null });
    hold(c, 1);
    const fin = await c.until("stt.final", 2000);
    expect(fin.text).toBe("पाँच किलो पनीर खराब हो गया");
    const d = await c.until("draft");
    expect(d.draft.entries[0]!.item_id).toBe("paneer");
    expect(d.timings.stt_ms).toBeGreaterThanOrEqual(150);
  });

  test("dead STT session is reopened on ptt.start", async () => {
    env = await startGateway();
    const c = await staffClient(env);
    const s = env.stt.sessions[0]!;
    s.kill();
    env.stt.script({ partials: [], final: { text: "twenty eggs received", language: "en-IN", confidence: 0.9 } });
    hold(c, 1);
    await c.until("draft");
    expect(s.reopens).toBe(1);
  });

  test("hold shorter than 300 ms → EMPTY_TRANSCRIPT + spoken line, even if STT hallucinates", async () => {
    env = await startGateway();
    const c = await staffClient(env);
    env.stt.script({ partials: [], final: { text: "Hello", language: "en-IN", confidence: 0.2 } });
    hold(c, 1, 2);
    const fin = await c.until("stt.final");
    expect(fin.text).toBe("");
    const err = await c.until("error");
    expect(err.code).toBe("EMPTY_TRANSCRIPT");
    const tts = await c.until("tts");
    expect(tts.text.length).toBeGreaterThan(0);
  });

  test("stock_after, exceeds_stock and low_stt_confidence are filled by the gateway", async () => {
    env = await startGateway();
    const c = await staffClient(env);
    env.stt.script({ partials: [], final: { text: "पाँच किलो पनीर खराब हो गया", language: "hi-IN", confidence: 0.3 } });
    hold(c, 1);
    const d = await c.until("draft");
    const e = d.draft.entries[0]!;
    expect(e.stock_after).toBe(7);           // opening 12 − 5
    expect(e.warnings).toContain("low_stt_confidence");
    expect(e.warnings).not.toContain("exceeds_stock");
    // Confirm, then waste 5 more twice → second one exceeds
    c.send({ type: "draft.confirm", draft_id: d.draft.draft_id });
    await c.until("record.saved");
    env.stt.script({ partials: [], final: { text: "पाँच किलो पनीर खराब हो गया", language: "hi-IN", confidence: 0.9 } });
    hold(c, 2);
    const d2 = await c.until("draft");
    c.send({ type: "draft.confirm", draft_id: d2.draft.draft_id });
    await c.until("record.saved");
    env.stt.script({ partials: [], final: { text: "पाँच किलो पनीर खराब हो गया", language: "hi-IN", confidence: 0.9 } });
    hold(c, 3);
    const d3 = await c.until("draft");
    expect(d3.draft.entries[0]!.warnings).toContain("exceeds_stock");
    expect(d3.draft.entries[0]!.stock_after).toBe(-3);
  });

  test("edits on confirm are applied and recomputed", async () => {
    env = await startGateway();
    const c = await staffClient(env);
    c.send({ type: "text", turn: 1, text: "twenty eggs received" });
    const d = await c.until("draft");
    expect(d.timings.stt_ms).toBeNull();
    c.send({ type: "draft.confirm", draft_id: d.draft.draft_id, edits: [{ index: 0, quantity: 24 }] });
    const saved = await c.until("record.saved");
    expect(saved.record.edited).toBe(true);
    expect(saved.record.entries[0]!.quantity).toBe(24);
    expect(saved.record.entries[0]!.value_inr).toBe(168);
    expect(saved.record.entries[0]!.stock_after).toBe(144);
  });

  test("correction keeps the chain; new log replaces the pending draft", async () => {
    env = await startGateway();
    const c = await staffClient(env);
    c.send({ type: "text", turn: 1, text: "पाँच किलो पनीर खराब हो गया" });
    const d1 = await c.until("draft");
    c.send({ type: "text", turn: 2, text: "नहीं, तीन किलो" });
    const d2 = await c.until("draft");
    expect(d2.draft.intent).toBe("correction");
    const cleared = await c.until("draft.cleared");
    expect(cleared).toEqual({ type: "draft.cleared", draft_id: d1.draft.draft_id, reason: "replaced" });
    expect(d2.draft.entries[0]!.quantity).toBe(3);
    c.send({ type: "draft.confirm", draft_id: d2.draft.draft_id });
    await c.until("record.saved");
    const stats = await (await fetch(`${env.url}/api/stats`)).json();
    expect(stats.today.corrected_by_voice).toBe(1);
  });

  test("clarification: cannot confirm, tap answer resolves, clarified flag on the record", async () => {
    env = await startGateway();
    const c = await staffClient(env);
    c.send({ type: "text", turn: 1, text: "दस किलो चावल आया" });
    const q = await c.until("draft");
    expect(q.draft.intent).toBe("needs_clarification");
    c.send({ type: "draft.confirm", draft_id: q.draft.draft_id });
    expect((await c.until("error")).code).toBe("BAD_MESSAGE");
    c.send({ type: "draft.answer", draft_id: q.draft.draft_id, value: "rice_basmati" });
    const d = await c.until("draft");
    expect(d.draft.entries[0]!.item_id).toBe("rice_basmati");
    expect(d.draft.entries[0]!.stock_after).toBe(30);
    c.send({ type: "draft.confirm", draft_id: d.draft.draft_id });
    const saved = await c.until("record.saved");
    expect(saved.record.clarified).toBe(true);
    c.send({ type: "draft.answer", draft_id: "gone", value: "x" });
    expect((await c.until("error")).code).toBe("NO_PENDING_DRAFT");
  });

  test("pending draft expires", async () => {
    env = await startGateway({ pendingTtlMs: 120 });
    const c = await staffClient(env);
    c.send({ type: "text", turn: 1, text: "twenty eggs received" });
    const d = await c.until("draft");
    const cleared = await c.until("draft.cleared", 1000);
    expect(cleared).toEqual({ type: "draft.cleared", draft_id: d.draft.draft_id, reason: "expired" });
    c.send({ type: "draft.confirm", draft_id: d.draft.draft_id });
    expect((await c.until("error")).code).toBe("DRAFT_NOT_FOUND");
  });

  test("interpreter failure → INTERPRET_FAILED + spoken line; draft arrives before tts", async () => {
    env = await startGateway({ interpreter: Object.assign(new (await import("../../src/gateway/fakes")).FakeInterpreter(), { interpret: async () => { throw new Error("boom"); } }) });
    const c = await staffClient(env);
    c.send({ type: "text", turn: 1, text: "anything" });
    const err = await c.until("error");
    expect(err.code).toBe("INTERPRET_FAILED");
    expect((await c.until("tts")).text.length).toBeGreaterThan(0);
  });

  test("slow TTS never delays the draft", async () => {
    env = await startGateway();
    env.tts.delayMs = 400;
    const c = await staffClient(env);
    const t0 = performance.now();
    c.send({ type: "text", turn: 1, text: "twenty eggs received" });
    await c.until("draft");
    expect(performance.now() - t0).toBeLessThan(200);
  });

  test("no STT provider → ready.stt down, ptt yields STT_UNAVAILABLE, text works", async () => {
    env = await startGateway({ stt: null });
    const c = await TestClient.connect(env.ws, { type: "hello", client_id: "s", role: "staff" });
    const ready = await c.next();
    expect(ready.type === "ready" && ready.stt).toBe("down");
    hold(c, 1);
    expect((await c.until("error")).code).toBe("STT_UNAVAILABLE");
    c.send({ type: "text", turn: 2, text: "twenty eggs received" });
    expect((await c.until("draft")).draft.entries[0]!.item_id).toBe("eggs");
  });

  test("latency with fakes: ptt.stop → draft p99 < 30 ms over 100 turns", async () => {
    env = await startGateway();
    const c = await staffClient(env);
    const totals: number[] = [];
    for (let i = 1; i <= 100; i++) {
      env.stt.script({ partials: [], final: { text: "twenty eggs received", language: "en-IN", confidence: 0.9 } });
      c.send({ type: "ptt.start", turn: i });
      for (let f = 0; f < 10; f++) c.binary();
      const t0 = performance.now();
      c.send({ type: "ptt.stop", turn: i });
      const d = await c.until("draft");
      totals.push(performance.now() - t0);
      c.send({ type: "draft.cancel", draft_id: d.draft.draft_id });
      await c.until("draft.cleared");
    }
    totals.sort((a, b) => a - b);
    const p99 = totals[Math.ceil(0.99 * totals.length) - 1]!;
    console.log(`fake-path latency: p50 ${totals[49]!.toFixed(1)} ms, p99 ${p99.toFixed(1)} ms`);
    expect(p99).toBeLessThan(30);
  }, 20_000);
});

describe("static + reconnect basics", () => {
  test("second hello is ignored; ping/pong works", async () => {
    env = await startGateway();
    const c = await staffClient(env);
    c.send({ type: "hello", client_id: "s", role: "staff" });
    c.send({ type: "ping" });
    expect((await c.next()).type).toBe("pong");
    await sleep(10);
  });
});
