// Dashboard against the mock: a raw staff socket drives the fixture; the dashboard DOM must show
// the activity strip, the new log row, the tiles and the inventory bar moving.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ServerMsg } from "../../contracts/protocol";
import fixture from "../../contracts/fixtures/session.json";
import { loadPage, until, text, bootMock, impls, sleep, matches } from "./helpers";

let mock: ReturnType<typeof bootMock>, dash: any, doc: any, win: any;
let staff: WebSocket, spy: WebSocket;
const activity: any[] = [];

beforeAll(async () => {
  mock = bootMock();
  ({ win, doc } = loadPage("dashboard.html", mock.url + "/dashboard"));
  const { boot } = await import("../../public/dashboard.js");
  dash = boot({ document: doc, window: win, wsUrl: mock.wsUrl, httpBase: mock.url, ...impls() });
  await dash.loaded;
  // a second dashboard connection just records activity frames for the sequence check
  spy = new WebSocket(mock.wsUrl);
  spy.onmessage = (e) => { const m = ServerMsg.parse(JSON.parse(String(e.data))); if (m.type === "activity") activity.push(m.activity); };
  await new Promise((r) => (spy.onopen = r));
  spy.send(JSON.stringify({ type: "hello", client_id: "spy", role: "dashboard" }));
  staff = new WebSocket(mock.wsUrl);
  await new Promise((r) => (staff.onopen = r));
});
afterAll(() => { staff?.close(); spy?.close(); dash?.conn.close(); mock?.stop(); });
const send = (o: unknown) => staff.send(JSON.stringify(o));
const $ = (id: string) => doc.getElementById(id);

describe("dashboard", () => {
  test("initial load: empty log, inventory from the catalog, tiles at zero", async () => {
    await until(() => $("conn").classList.contains("on"), "dashboard ready");
    expect(text($("log"))).toContain("Nothing logged yet");
    expect(text($("tEntries"))).toBe("0");
    const milk = doc.querySelector('#inv li[data-id="milk"]');
    expect(text(milk.querySelector(".q"))).toBe("40 L / 40 L");
    expect(text(milk.querySelector(".v"))).toBe("₹2,400");
  });

  test("activity strip follows the staff turn", async () => {
    send({ type: "hello", client_id: "c1", role: "staff" }); await sleep(30);
    send({ type: "ptt.start", turn: 1 });
    await until(() => $("strip").getAttribute("data-state") === "listening", "listening");
    staff.send(new Uint8Array(1280)); await sleep(20); staff.send(new Uint8Array(1280));
    await until(() => text($("stripText")) === "ಇಪ್ಪತ್ತು ಲೀಟರ್ ಹಾಲು", "live text on the strip");
    expect($("stripDot").hidden).toBe(false);
    send({ type: "ptt.stop", turn: 1 });
    await until(() => $("strip").getAttribute("data-state") === "thinking", "thinking");
    await until(() => $("strip").getAttribute("data-state") === "reviewing", "reviewing");
    expect(text($("stripText"))).toContain("20 ಲೀಟರ್ ಹಾಲು");
  });

  test("record.new adds a flashing row, tiles refetch, inventory bar moves", async () => {
    send({ type: "draft.confirm", draft_id: "d1" });
    await until(() => doc.querySelector("#log li[data-id]"), "log row");
    const row = doc.querySelector("#log li[data-id]");
    expect(row.classList.contains("flash")).toBe(true);
    expect(text(row.querySelector(".tx"))).toContain("ಇಪ್ಪತ್ತು ಲೀಟರ್ ಹಾಲು ಬಂದಿದೆ");
    expect(text(row.querySelector(".tx .tag"))).toBe("kn");
    expect(text(row.querySelector(".sum"))).toBe("20 L Milk");
    expect(text(row.querySelector(".val"))).toBe("₹1,200");
    expect(text(row.querySelector(".chip.action"))).toBe("Received");
    await until(() => text($("tEntries")) === "1", "entries tile");
    expect(text($("tReceived"))).toBe("₹1,200");
    expect(text($("tSpeed"))).toMatch(/\d+ ms/);
    await until(() => text(doc.querySelector('#inv li[data-id="milk"] .q')).startsWith("60 L / 40 L"), "milk inventory");
    const milk = doc.querySelector('#inv li[data-id="milk"]');
    expect(text(milk.querySelector(".v"))).toBe("₹3,600");
    await until(() => $("strip").getAttribute("data-state") === "idle", "idle");
  });

  test("clarified record shows the asked marker", async () => {
    send({ type: "ptt.start", turn: 2 }); send({ type: "ptt.stop", turn: 2 });
    await until(() => $("strip").getAttribute("data-state") === "asking", "asking");
    expect(text($("stripK"))).toBe("Asked");
    expect(text($("stripText"))).toBe("कौन सा चावल — बासमती या साधारण?");
    send({ type: "draft.answer", draft_id: "d2", value: "rice_basmati" }); await sleep(60);
    send({ type: "draft.cancel", draft_id: "d3" }); await sleep(30);
    send({ type: "ptt.start", turn: 3 }); send({ type: "ptt.stop", turn: 3 }); await sleep(60);
    send({ type: "text", turn: 4, text: "twenty eggs received" }); await sleep(60);
    send({ type: "draft.confirm", draft_id: "*", edits: [{ index: 0, quantity: 24 }] });
    await until(() => doc.querySelectorAll("#log li[data-id]").length === 2, "second row");
    const top = doc.querySelector("#log li[data-id]");
    expect(text(top.querySelector(".sum"))).toBe("24 pcs Eggs");
    expect(text(top.querySelector(".asked"))).toBe("edited");
    await until(() => text($("tEntries")) === "2", "two entries");
    // the clarified draft (d3) was cancelled, so no confirmed record is marked clarified
    expect(text($("tEntriesSub"))).toBe("");
  });

  test("photo upload → record.updated → thumbnail in the log row", async () => {
    const rec = mock.state.records[0];
    const fd = new FormData();
    fd.append("photo", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }), "photo.jpg");
    const res = await fetch(`${mock.url}/api/photo/${rec.record_id}`, { method: "POST", body: fd });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.photo_url).toBe(`/photos/${rec.record_id}.jpg`);
    await until(() => doc.querySelector(`#log li[data-id="${rec.record_id}"] img`), "thumbnail");
    expect(doc.querySelector(`#log li[data-id="${rec.record_id}"] img`).getAttribute("src")).toBe(mock.url + j.photo_url);
    const img = await fetch(mock.url + j.photo_url);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
  });

  test("activity sequence for the first turn matches the fixture", () => {
    const exp = (fixture as any).dashboard.expect_activity_sequence as { state: string; text: string }[];
    const got = activity.slice(0, exp.length).map((a) => ({ state: a.state, text: a.text }));
    for (let i = 0; i < exp.length; i++) {
      if (!matches(exp[i], got[i])) throw new Error(`activity ${i}: expected ${JSON.stringify(exp[i])} got ${JSON.stringify(got[i])}`);
    }
  });
});
