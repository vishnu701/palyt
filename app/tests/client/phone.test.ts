// Replays contracts/fixtures/session.json through the mock gateway with the real phone app
// running in happy-dom. Asserts the DOM reaches each state and that every frame the client
// sends parses with ClientMsg.parse, in the fixture order.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ClientMsg } from "../../contracts/protocol";
import fixture from "../../contracts/fixtures/session.json";
import { loadPage, FakeAudioContext, FakeCapture, fakeStorage, until, matches, fire, text, bootMock, impls, sleep } from "./helpers";

let mock: ReturnType<typeof bootMock>;
let app: any, win: any, doc: any;
const audio = new FakeAudioContext();
const capture = new FakeCapture();

beforeAll(async () => {
  mock = bootMock();
  ({ win, doc } = loadPage("index.html", mock.url + "/"));
  win.AudioContext = function () { return audio; };
  const { boot } = await import("../../public/app.js");
  app = boot({ document: doc, window: win, wsUrl: mock.wsUrl, httpBase: mock.url, storage: fakeStorage({ kv_client_id: "c1" }), capture: async () => capture, ...impls() });
});
afterAll(() => { app?.conn.close(); mock?.stop(); });

const $ = (id: string) => doc.getElementById(id);
const view = () => app.state.view;
const mic = () => $("mic");

describe("phone app replays session.json", () => {
  test("connects, sends hello first, shows the guest banner", async () => {
    await until(() => app.state.ready, "ready");
    expect(view()).toBe("idle");
    expect(text($("status"))).toBe("");            // header goes quiet once live
    expect(mic().classList.contains("off")).toBe(false);
    expect(text(doc.querySelector(".idle-copy h1"))).toContain("Say what happened");
    await until(() => app.state.catalog.length > 0, "catalog loaded");
  });

  test("turn 1: hold → listening with live partials → release → review card (kn)", async () => {
    fire(win, mic(), "pointerdown");
    expect(view()).toBe("listening");
    expect(mic().classList.contains("held")).toBe(true);
    await until(() => capture.cb, "capture started");
    capture.push(); await sleep(30); capture.push();
    await until(() => text(doc.querySelector("section[data-view=listening] .live")) === "ಇಪ್ಪತ್ತು ಲೀಟರ್ ಹಾಲು", "second partial");
    expect(text($("liveStable"))).toBe("ಇಪ್ಪತ್ತು");
    expect(text($("liveTail"))).toBe("ಲೀಟರ್ ಹಾಲು"); // new tail rendered grey
    fire(win, mic(), "pointerup");
    await until(() => view() === "waiting", "waiting");
    await until(() => view() === "review", "review card");
    const card = doc.querySelector("#cards .card");
    expect(text(card.querySelector(".num"))).toBe("20");
    expect(text(card.querySelector(".unit"))).toBe("ಲೀಟರ್");
    expect(text(card.querySelector(".item-btn"))).toBe("ಹಾಲು");
    expect(text(card.querySelector(".value"))).toBe("₹1,200");
    expect(text(card.querySelector(".stock"))).toBe("ಉಳಿದಿದೆ: 40 → 60 ಲೀಟರ್");
    expect(text(card.querySelector(".chip.action"))).toBe("Received");
    expect(text($("confirmText"))).toBe("20 ಲೀಟರ್ ಹಾಲು ಬಂದಿದೆ — ಸರಿಯೇ?");
    expect(text($("timings"))).toMatch(/total \d+ ms/);
  });

  test("tts clip plays after the draft; ptt.start stops a playing clip", async () => {
    await until(() => audio.playing.length === 1, "tts playing");
    const src = audio.playing[0];
    fire(win, mic(), "pointerdown");           // starts turn 2 while the clip plays
    expect(src.stopped).toBe(true);
    expect(audio.playing.length).toBe(0);
    fire(win, mic(), "pointerup");             // abandon this press; the mock ignores the extra turn
    await sleep(40);
  });
});

// The block above spent turn 2 on the stop-clip check, which the mock script does not expect
// (it wants draft.confirm next). Re-run the whole replay from a clean app for the ordered check.
describe("ordered replay: every client frame parses and follows the fixture", () => {
  let mock2: ReturnType<typeof bootMock>, app2: any, win2: any, doc2: any;
  const audio2 = new FakeAudioContext();
  const cap2 = new FakeCapture();
  beforeAll(async () => {
    mock2 = bootMock();
    ({ win: win2, doc: doc2 } = loadPage("index.html", mock2.url + "/"));
    win2.AudioContext = function () { return audio2; };
    const { boot } = await import("../../public/app.js");
    app2 = boot({ document: doc2, window: win2, wsUrl: mock2.wsUrl, httpBase: mock2.url, storage: fakeStorage({ kv_client_id: "c1" }), capture: async () => cap2, ...impls() });
    await until(() => app2.state.ready && app2.state.catalog.length > 0, "ready");
  });
  afterAll(() => { app2?.conn.close(); mock2?.stop(); });
  const $$ = (id: string) => doc2.getElementById(id);
  const v = () => app2.state.view;

  test("full conversation reaches every state", async () => {
    // turn 1 — Kannada receiving, confirm
    fire(win2, $$("mic"), "pointerdown");
    await until(() => cap2.cb, "capture");
    cap2.push(); await sleep(25); cap2.push(); await sleep(25);
    fire(win2, $$("mic"), "pointerup");
    await until(() => v() === "review", "review 1");
    fire(win2, $$("confirmBtn"), "click");
    await until(() => v() === "saved", "saved 1");
    await until(() => text($$("readback")).includes("ದಾಖಲಾಗಿದೆ"), "readback text from the tts frame");
    expect(text($$("todayList"))).toContain("ಹಾಲು");
    expect(text($$("todayList"))).toContain("₹1,200");
    expect($$("photoRow").hidden).toBe(true); // receiving → no photo button

    // turn 2 — Hindi "chawal" → clarification → tap basmati → review → cancel
    fire(win2, $$("mic"), "pointerdown"); await sleep(20); fire(win2, $$("mic"), "pointerup");
    await until(() => v() === "clarify", "clarify");
    expect(text($$("question"))).toBe("कौन सा चावल — बासमती या साधारण?");
    const opts = Array.from(doc2.querySelectorAll("#options .opt")) as any[];
    expect(opts.map((o) => text(o.querySelector("span")))).toEqual(["बासमती चावल", "साधारण चावल"]);
    expect(text(opts[0].querySelector(".stock"))).toBe("20 किलो");
    expect(text($$("somethingElse"))).toBe("कुछ और");
    expect(text($$("roundHint"))).toContain("round 1 of 2");
    fire(win2, opts[0], "click");
    await until(() => v() === "review", "review 2");
    expect(text(doc2.querySelector("#cards .num"))).toBe("10");
    expect(text(doc2.querySelector("#cards .unit"))).toBe("किलो");
    expect(text(doc2.querySelector("#cards .item-btn"))).toBe("बासमती चावल");
    expect(text(doc2.querySelector("#cards .value"))).toBe("₹1,100");
    expect(text(doc2.querySelector("#cards .stock"))).toBe("बचा: 20 → 30 किलो");
    fire(win2, $$("cancelBtn"), "click");
    expect(v()).toBe("idle");

    // turn 3 — empty transcript → error toast → idle
    fire(win2, $$("mic"), "pointerdown"); await sleep(20); fire(win2, $$("mic"), "pointerup");
    await until(() => !$$("toast").hidden && text($$("toast")) === "Didn't catch that", "error toast");
    expect(v()).toBe("idle");

    // turn 4 — typed text → review → +1 ×4 → confirm with edits
    fire(win2, $$("typeToggle"), "click");
    expect($$("typeForm").hidden).toBe(false);
    $$("typeInput").value = "twenty eggs received";
    fire(win2, $$("typeForm"), "submit");
    await until(() => v() === "review", "review 4");
    expect(text(doc2.querySelector("#cards .num"))).toBe("20");
    expect(text(doc2.querySelector("#cards .unit"))).toBe("pcs");
    expect(text(doc2.querySelector("#cards .value"))).toBe("₹140");
    for (let i = 0; i < 4; i++) fire(win2, doc2.querySelector("#cards .plus"), "click");
    expect(text(doc2.querySelector("#cards .num"))).toBe("24");
    expect(text(doc2.querySelector("#cards .value"))).toBe("₹168"); // recomputed locally before ✓
    fire(win2, $$("confirmBtn"), "click");
    await until(() => v() === "saved", "saved 4");
    expect(app2.state.lastSaved.edited).toBe(true);
    expect(app2.state.lastSaved.entries[0].quantity).toBe(24);
    app2.conn.send({ type: "ping" });
    await sleep(60);
  });

  test("every frame sent parses with ClientMsg.parse, in the fixture order", () => {
    const sent = mock2.state.received.filter((f) => f.session !== "?" || true);
    const textFrames = sent.filter((f) => !f.binary).map((f) => f.data);
    for (const f of textFrames) expect(() => ClientMsg.parse(f)).not.toThrow();
    const expected = (fixture.steps as any[]).map((s) => s.send);
    let ti = 0;
    for (const exp of expected) {
      if ("_binary" in exp) continue; // checked below
      const got = textFrames[ti++];
      if (!matches(exp, got)) throw new Error(`frame ${ti} mismatch:\n expected ${JSON.stringify(exp)}\n got ${JSON.stringify(got)}`);
    }
    expect(ti).toBe(textFrames.length);
    // binary frames of 1280 bytes between ptt.start(1) and ptt.stop(1)
    const i1 = sent.findIndex((f) => !f.binary && (f.data as any).type === "ptt.start");
    const i2 = sent.findIndex((f) => !f.binary && (f.data as any).type === "ptt.stop");
    const bin = sent.slice(i1, i2).filter((f) => f.binary);
    expect(bin.length).toBeGreaterThanOrEqual(2);
    expect(bin.every((f) => f.data === 1280)).toBe(true);
  });
});
