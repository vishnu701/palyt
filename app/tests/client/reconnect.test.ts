// The phone app must re-send `hello` (same client_id) after the socket drops, grey the mic while
// offline, and come back to ready.
import { test, expect, afterAll } from "bun:test";
import { loadPage, FakeAudioContext, FakeCapture, fakeStorage, until, text, bootMock, impls } from "./helpers";

const mock = bootMock();
let app: any;
afterAll(() => { app?.conn.close(); mock.stop(); });

test("reconnect re-sends hello with the same client_id", async () => {
  const { win, doc } = loadPage("index.html", mock.url + "/");
  win.AudioContext = function () { return new FakeAudioContext(); };
  const { boot } = await import("../../public/app.js");
  app = boot({ document: doc, window: win, wsUrl: mock.wsUrl, httpBase: mock.url, storage: fakeStorage({ kv_client_id: "c1" }), capture: async () => new FakeCapture(), ...impls() });
  await until(() => app.state.ready, "ready");
  const hellos = () => mock.state.received.filter((f) => !f.binary && (f.data as any).type === "hello");
  expect(hellos().length).toBe(1);

  mock.dropAll();
  await until(() => !app.state.ready, "offline");
  expect(doc.getElementById("mic").classList.contains("off")).toBe(true);
  expect(text(doc.getElementById("status"))).toContain("reconnecting");

  await until(() => hellos().length === 2, "second hello", 6000);
  expect((hellos()[1].data as any).client_id).toBe("c1");
  expect(hellos()[1].data).toEqual({ type: "hello", client_id: "c1", role: "staff" });
  await until(() => app.state.ready, "ready again");
  expect(doc.getElementById("mic").classList.contains("off")).toBe(false);
  expect(app.conn.attempts).toBe(2);
});
